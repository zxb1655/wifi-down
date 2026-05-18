const { app, BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const WifiManager = require('./src/wifi-manager');
const TrafficGenerator = require('./src/traffic-generator');
const ApiClient = require('./src/api-client');
const ConfigManager = require('./src/config-manager');
const { generateRunReport } = require('./src/excel-report');

// 仅允许一个进程：副本在未注册 IPC 前即退出；主实例在再次启动时聚焦窗口
if (!app.requestSingleInstanceLock()) {
  process.exit(0);
}
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

let mainWindow;
let wifiManager;
let trafficGenerator;
let testGenerator;
let apiClient;
let configManager;
let logDir = null;
let running = false;
/** 批量跑量时用户是否点击过停止（用于与「正常跑完」区分日志） */
let batchStopRequested = false;
let testingAborted = false;
let testAbortEmitter = null;
/**
 * 跑量失败的设备等待重启队列：跑量失败时该设备所处的客户 WiFi 多半已无网络，
 * 无法立即调用 BOSS 的重启接口；先入队，等到下一次有设备跑量成功（此刻我们
 * 处于一个有网络的 WiFi）时再顺带把队列里的设备逐个下发重启命令。
 */
const pendingRebootDevices = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'WiFi 跑流量工具',
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
}

function getLogFilePath() {
  if (!logDir) return null;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return path.join(logDir, `${y}-${m}-${d}.log`);
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', line);
  }
  const logFile = getLogFilePath();
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n', 'utf-8');
    } catch (_) {}
  }
}

function sendDeviceUpdate(device) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('device-update', device);
  }
}

function sendWifiList(list) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('wifi-list', list);
  }
}

function sendProgress(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('progress', data);
  }
}

/** 每台设备在 [min,max] MB 间随机取整，非法配置时回退 100~200 */
function randomTargetMB(config) {
  let min = Math.floor(Number(config?.trafficMinMB));
  let max = Math.floor(Number(config?.trafficMaxMB));
  if (!Number.isFinite(min)) min = 100;
  if (!Number.isFinite(max)) max = 200;
  min = Math.max(1, Math.min(50000, min));
  max = Math.max(1, Math.min(50000, max));
  if (min > max) {
    const x = min;
    min = max;
    max = x;
  }
  return min + Math.floor(Math.random() * (max - min + 1));
}

function formatTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${mi}:${s}`;
}

function parseSignalPercentFromString(signal) {
  if (signal == null || signal === '') return -1;
  const m = String(signal).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

function describeScannedNetwork(net) {
  if (!net) return '';
  const parts = [];
  if (net.signal) parts.push(`信号: ${net.signal}`);
  if (net.auth) parts.push(`认证: ${net.auth}`);
  if (net.encryption) parts.push(`加密: ${net.encryption}`);
  if (net.band) parts.push(`频段: ${net.band}`);
  if (net.channel) parts.push(`信道: ${net.channel}`);
  if (net.radio) parts.push(`无线电: ${net.radio}`);
  return parts.join('，');
}

/** 将扫描到的 SSID 列表格式化为日志用字符串（按信号强度降序） */
function formatScannedSsidList(networks) {
  if (!Array.isArray(networks) || networks.length === 0) return '';
  const sorted = [...networks].sort(
    (a, b) => parseSignalPercentFromString(b.signal) - parseSignalPercentFromString(a.signal)
  );
  return sorted
    .map((n) => {
      const ssid = n.ssid ? n.ssid : '(隐藏)';
      const pct = parseSignalPercentFromString(n.signal);
      return pct >= 0 ? `${ssid}(${pct}%)` : ssid;
    })
    .join('、');
}

function getNewScannedNetworks(existingLookup, networks) {
  if (!Array.isArray(networks) || networks.length === 0) return [];
  const seen = new Set();
  const added = [];
  for (const n of networks) {
    const key = WifiManager.normalizeSsid(n.ssid);
    if (!key || seen.has(key) || existingLookup.has(key)) continue;
    seen.add(key);
    added.push(n);
  }
  return added;
}

/** 每个 SSID（规范化）保留信号最强的一条扫描记录 */
function buildScanLookup(networks) {
  const map = new Map();
  for (const n of networks) {
    const key = WifiManager.normalizeSsid(n.ssid);
    if (!key) continue;
    const pct = parseSignalPercentFromString(n.signal);
    const prev = map.get(key);
    if (!prev || pct > parseSignalPercentFromString(prev.signal)) {
      map.set(key, n);
    }
  }
  return map;
}

function applyScanFlagsToDevices(devices, lookup) {
  for (const d of devices) {
    const key = WifiManager.normalizeSsid(d.wifiName);
    const hit = key && lookup.has(key);
    const net = hit ? lookup.get(key) : null;
    d._scanVisible = !!hit;
    d._scanSignal = hit ? (net.signal || '') : '';
  }
}

/** 待处理设备排序：当前列表中可见的优先，其次按信号强度 */
function comparePendingDevices(a, b, lookup) {
  const ka = WifiManager.normalizeSsid(a.wifiName);
  const kb = WifiManager.normalizeSsid(b.wifiName);
  const aIn = !!(ka && lookup.has(ka));
  const bIn = !!(kb && lookup.has(kb));
  if (aIn !== bIn) return (bIn ? 1 : 0) - (aIn ? 1 : 0);
  const sa = aIn ? parseSignalPercentFromString(lookup.get(ka).signal) : -1;
  const sb = bIn ? parseSignalPercentFromString(lookup.get(kb).signal) : -1;
  if (sb !== sa) return sb - sa;
  return String(a.sn || '').localeCompare(String(b.sn || ''));
}

/**
 * 累积式扫描状态：lookup 中的 SSID 只增不删；UI 展示仍用最近一次扫描结果。
 * 设计动机：几百台热点并发时单次 WlanScan 不一定能覆盖所有 SSID，某设备只要
 * 曾被扫到过，就视为"该设备 WiFi 是开启的"，后续无需再命中本次扫描也允许加入队列。
 */
function createScanState(initialNetworks) {
  const state = {
    networks: initialNetworks,
    lookup: buildScanLookup(initialNetworks),
    merge(nets) {
      state.networks = nets;
      for (const n of nets) {
        const key = WifiManager.normalizeSsid(n.ssid);
        if (!key) continue;
        const prev = state.lookup.get(key);
        const pct = parseSignalPercentFromString(n.signal);
        const prevPct = prev ? parseSignalPercentFromString(prev.signal) : -1;
        if (!prev || pct >= prevPct) state.lookup.set(key, n);
      }
    },
  };
  return state;
}

function resolveWifiListRefreshSec(config) {
  const raw = config && config.wifiListRefreshSec;
  if (Number.isFinite(Number(raw))) {
    return Math.max(0, Math.min(3600, Math.floor(Number(raw))));
  }
  return 45;
}

function resolveTrafficNoProgressTimeoutSec(config) {
  const raw = config && config.trafficNoProgressTimeoutSec;
  if (Number.isFinite(Number(raw))) {
    return Math.max(10, Math.min(86400, Math.floor(Number(raw))));
  }
  return 120;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatTrafficDownloadEvent(evt, prefix = '') {
  const entry = evt.entry || {};
  const url = entry.url || evt.url || '';
  const name = entry.name ? `（${entry.name}）` : '';
  const progress = `${formatBytes(evt.totalDownloaded || 0)} / ${formatBytes(evt.targetBytes || 0)}`;
  if (evt.type === 'redirect') {
    return `${prefix}[下载] 换源: 原因=${evt.reason || '重定向'}，累计已下载=${progress}，当前链接${name}: ${url}`;
  }
  return `${prefix}[下载] 换源: 原因=${evt.reason || '未知'}，累计已下载=${progress}，当前链接${name}: ${url}`;
}

/** netsh connect 成功后再次读取系统当前 SSID，避免日志显示已连上但实际未关联到目标网络 */
async function ensureWifiConnectedTo(expectedSsid, logPrefix = '') {
  const prefix = logPrefix ? `${logPrefix} ` : '';
  const verify = await wifiManager.verifyConnectedTo(expectedSsid, { timeoutMs: 15000, intervalMs: 500 });
  if (!verify.ok) {
    log(`${prefix}WiFi 校验失败: 期望「${expectedSsid}」，系统当前关联为「${verify.actual ?? '无'}」`);
    throw new Error(`${prefix}未连接到指定 WiFi（期望 ${expectedSsid}，实际 ${verify.actual || '无'}）`);
  }
  log(`${prefix}已确认当前 WiFi 为「${verify.actual}」`);
}

/** 先直连 API 拉取设备；失败且配置了备用 WiFi 时，连备用后再试一次（避免当前无网） */
async function fetchDevicesWithNetworkFallback(config) {
  const { baseUrl, backupWifiName, backupWifiPassword, computerKey } = config;
  if (!baseUrl) throw new Error('未配置 API 地址');
  apiClient.setBaseUrl(baseUrl);
  try {
    return await apiClient.fetchDevices(computerKey);
  } catch (firstErr) {
    if (!backupWifiName) throw firstErr;
    log(`获取设备列表失败（${firstErr.message}），尝试连接备用 WiFi「${backupWifiName}」后重试...`);
    try {
      await wifiManager.disconnect();
      await new Promise(r => setTimeout(r, 1000));
      await wifiManager.connect(backupWifiName, backupWifiPassword || '');
      await ensureWifiConnectedTo(backupWifiName, '[备用]');
    } catch (wifiErr) {
      log(`连接备用 WiFi 失败: ${wifiErr.message}`);
      throw firstErr;
    }
    return await apiClient.fetchDevices(computerKey);
  }
}

/** 跑量流程结束后连回备用 WiFi，避免长时间停留在断开状态 */
async function reconnectBackupWifiAfterTask(config) {
  const { backupWifiName, backupWifiPassword } = config || {};
  if (!backupWifiName) return;
  try {
    const current = wifiManager.getCurrentSSID();
    if (current === backupWifiName) {
      log(`[备用] 当前已连接「${backupWifiName}」，无需切换`);
      return;
    }
    log(`[备用] 任务结束，正在连接备用 WiFi「${backupWifiName}」...`);
    await wifiManager.disconnect();
    await new Promise(r => setTimeout(r, 1000));
    await wifiManager.connect(backupWifiName, backupWifiPassword || '');
    await ensureWifiConnectedTo(backupWifiName, '[备用]');
    log('[备用] 已切回备用 WiFi，可正常使用网络');
  } catch (e) {
    log(`[备用] 任务结束后连接备用 WiFi 失败: ${e.message}`);
  }
}

function queueDeviceReboot(device, reason) {
  if (!device || !device.sn) return;
  const sn = String(device.sn);
  if (pendingRebootDevices.has(sn)) return;
  pendingRebootDevices.set(sn, {
    sn,
    wifiName: device.wifiName || '',
    reason: reason || '',
  });
  log(
    `[重启队列] 加入待重启设备 ${sn}（${device.wifiName || '未知 WiFi'}）` +
      (reason ? `，原因: ${reason}` : '') +
      `，当前队列 ${pendingRebootDevices.size} 台`,
  );
}

async function flushPendingDeviceReboots(triggerSn) {
  if (pendingRebootDevices.size === 0) return;
  const items = Array.from(pendingRebootDevices.values());
  log(
    `[重启队列] 借助设备 ${triggerSn || '?'} 的在线网络，开始下发 ${items.length} 台失败设备的重启命令...`,
  );
  for (const item of items) {
    try {
      await apiClient.rebootDevice(item.sn);
      log(`[重启队列] 已下发重启: ${item.sn}（${item.wifiName || '未知 WiFi'}）`);
      pendingRebootDevices.delete(item.sn);
    } catch (e) {
      log(
        `[重启队列] 重启失败: ${item.sn}（${item.wifiName || '未知 WiFi'}）- ${e.message}，保留待下次再试`,
      );
    }
  }
  if (pendingRebootDevices.size > 0) {
    log(`[重启队列] 仍有 ${pendingRebootDevices.size} 台设备未成功下发重启，等待下一次机会`);
  } else {
    log('[重启队列] 全部待重启设备已成功下发');
  }
}

// ---- IPC Handlers ----

ipcMain.handle('load-config', () => {
  return configManager.load();
});

ipcMain.handle('save-config', (_e, config) => {
  return configManager.save(config);
});

ipcMain.handle('scan-wifi', async () => {
  try {
    wifiManager.invalidateCache();
    log('正在触发 WiFi 扫描，请等待...');
    const networks = await wifiManager.scan(true);
    sendWifiList(networks);
    const ssidList = formatScannedSsidList(networks);
    log(
      `扫描完成，发现 ${networks.length} 个 WiFi 网络` +
        (ssidList ? `\n  SSID 列表: ${ssidList}` : '')
    );
    return networks;
  } catch (e) {
    log(`扫描 WiFi 失败: ${e.message}`);
    return [];
  }
});

ipcMain.handle('fetch-devices', async (_e, config) => {
  try {
    const devices = await fetchDevicesWithNetworkFallback(config);
    log(`获取到 ${devices.length} 个待测速设备`);
    return devices;
  } catch (e) {
    log(`获取设备列表失败: ${e.message}`);
    return [];
  }
});

ipcMain.handle('stop-task', async () => {
  running = false;
  batchStopRequested = true;
  if (trafficGenerator) trafficGenerator.abort();
  log('任务已停止');
});

ipcMain.handle('test-url', async (_e, payload) => {
  try {
    const entry = typeof payload === 'string' ? { url: payload, referer: null } : payload;
    const url = entry?.url || '';
    log(`[测速] 请求 URL: ${url}${entry?.referer ? ` Referer: ${entry.referer}` : ''}`);
    const result = await TrafficGenerator.testUrl(entry);
    log(`[测速] 响应: ${JSON.stringify({
      success: result.success,
      downloaded: result.downloaded,
      speed: result.speed,
      error: result.error,
      http: result.http,
    })}`);
    if (result.success) {
      log(`测试成功: ${result.downloaded}, 速度: ${result.speed}`);
    } else {
      log(`测试失败: ${result.error}`);
    }
    return result;
  } catch (e) {
    log(`测试异常: ${e.message}`);
    return { success: false, error: e.message, url };
  }
});

ipcMain.handle('stop-test', async () => {
  testingAborted = true;
  if (testGenerator) {
    testGenerator.abort();
    testGenerator = null;
  }
  if (testAbortEmitter) {
    testAbortEmitter.emit('abort');
    testAbortEmitter = null;
  }
  log('测试已停止');
});

ipcMain.handle('test-all-urls', async (_e, entries) => {
  testingAborted = false;
  testAbortEmitter = new EventEmitter();
  const signal = testAbortEmitter;
  const results = [];
  const list = Array.isArray(entries) ? entries : [];
  for (const raw of list) {
    const entry = typeof raw === 'string' ? { url: raw, referer: null } : raw;
    const url = entry?.url || '';
    if (testingAborted) {
      results.push({ success: false, error: '已停止', url });
      continue;
    }
    log(`[测速] 请求 URL: ${url}${entry?.referer ? ` Referer: ${entry.referer}` : ''}`);
    const result = await TrafficGenerator.testUrl(entry, signal);
    results.push(result);
    log(`[测速] 响应: ${JSON.stringify({
      success: result.success,
      downloaded: result.downloaded,
      speed: result.speed,
      error: result.error,
    })}`);
    if (result.success) {
      log(`  ✓ 成功 - ${result.downloaded}, ${result.speed}`);
    } else {
      log(`  ✗ 失败 - ${result.error}`);
    }
  }
  testAbortEmitter = null;
  return results;
});

ipcMain.handle('test-download', async (_e, payload, targetMB) => {
  testingAborted = false;
  const entry = typeof payload === 'string' ? { url: payload, referer: null } : payload;
  testGenerator = new TrafficGenerator([entry]);

  try {
    const total = await testGenerator.generate({
      targetMB,
      onDownloadUrl: (u) => log(`[下载] 当前链接: ${u}`),
      onProgress: (d, t) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('test-progress', { downloaded: d, target: t });
        }
      },
    });
    if (testingAborted) return { success: false, downloaded: total, aborted: true };
    return { success: true, downloaded: total };
  } catch (e) {
    if (testingAborted) return { success: false, downloaded: 0, aborted: true };
    throw e;
  } finally {
    testGenerator = null;
  }
});

async function processOneDevice(device, scanState, config) {
  const { baseUrl, backupWifiName, backupWifiPassword, testUrls, wifiReadyDelaySec } = config;
  const { sn, wifiName, wifiPassword } = device;

  if (!TrafficGenerator.normalizeTestUrls(testUrls).length) {
    const remark = '未配置测速链接（config.json 中 testUrls 为空或无效）';
    log(`${remark}，无法跑量`);
    device._status = 'failed';
    device._failRemark = remark;
    sendDeviceUpdate(device);
    await reportResult(device, 0, false, config, undefined, undefined, remark);
    return;
  }

  log(`--- 处理设备: ${sn} (${wifiName}) ---`);
  device._status = 'processing';
  device._failRemark = '';
  sendDeviceUpdate(device);

  const key = WifiManager.normalizeSsid(wifiName);
  const found = key && scanState.lookup.has(key) ? scanState.lookup.get(key) : null;
  if (!found) {
    const remark = `未扫描到 WiFi「${wifiName}」（当前列表无此 SSID；若热点刚开启可等待下次 WiFi 定时刷新后再跑）`;
    log(`WiFi "${wifiName}" 未发现，标记为失败`);
    device._status = 'failed';
    device._failRemark = remark;
    sendDeviceUpdate(device);
    queueDeviceReboot(device, remark);
    await reportResult(device, 0, false, config, undefined, undefined, remark);
    return;
  }
  log(`WiFi "${wifiName}" 已匹配（当前列表），${describeScannedNetwork(found) || '扫描信息不足'}`);

  log(`正在连接 WiFi "${wifiName}"...`);
  try {
    await wifiManager.disconnect();
    await new Promise(r => setTimeout(r, 1000));
    await wifiManager.connect(wifiName, wifiPassword, { networkInfo: found });
    await ensureWifiConnectedTo(wifiName);
    const readySec = Math.max(
      0,
      Math.min(86400, Math.floor(Number(wifiReadyDelaySec) || 0)),
    );
    if (readySec > 0) {
      log(`已连接 WiFi，等待 ${readySec} 秒后再开始跑流量（联网就绪）...`);
      await new Promise((r) => setTimeout(r, readySec * 1000));
    }
  } catch (e) {
    const remark = `连接失败: ${e.message}`;
    log(remark);
    device._status = 'failed';
    device._failRemark = remark;
    sendDeviceUpdate(device);
    queueDeviceReboot(device, remark);
    await reportResult(device, 0, false, config, undefined, undefined, remark);
    return;
  }

  const speedStartTime = formatTime(new Date());
  const targetMB = randomTargetMB(config);
  const noProgressTimeoutSec = resolveTrafficNoProgressTimeoutSec(config);
  log(`开始跑流量，目标约 ${targetMB} MB...`);
  trafficGenerator = new TrafficGenerator(testUrls);
  let downloadedBytes = 0;
  let lastProgressUpdate = 0;
  let trafficFailRemark = '';
  try {
    downloadedBytes = await trafficGenerator.generate({
      targetMB,
      noProgressTimeoutMs: noProgressTimeoutSec * 1000,
      onDownloadEvent: (evt) => log(formatTrafficDownloadEvent(evt)),
      onProgress: (downloaded, target) => {
        device._flow = downloaded;
        const now = Date.now();
        if (now - lastProgressUpdate > 500) {
          lastProgressUpdate = now;
          sendProgress({ sn, downloaded, target });
          sendDeviceUpdate(device);
        }
      },
    });
    log(`跑量完成: ${formatBytes(downloadedBytes)}`);
    if (downloadedBytes > 0) {
      device._status = 'success';
      device._failRemark = '';
    } else {
      trafficFailRemark = running ? '未下载到有效流量' : '任务已停止';
      device._status = 'failed';
      device._failRemark = trafficFailRemark;
      log(`跑量失败: ${trafficFailRemark}`);
    }
  } catch (e) {
    trafficFailRemark = e.message || '跑量异常';
    log(`跑量异常: ${trafficFailRemark}`);
    device._status = 'failed';
    device._failRemark = trafficFailRemark;
  }
  device._flow = downloadedBytes;
  sendDeviceUpdate(device);

  const speedEndTime = formatTime(new Date());
  const success = device._status === 'success';

  // 用户主动停止时设备并非真的"跑量失败"，不入队避免下次任务平白重启
  if (!success && !batchStopRequested) {
    queueDeviceReboot(device, trafficFailRemark);
  }

  await reportResult(
    device,
    downloadedBytes,
    success,
    config,
    speedStartTime,
    speedEndTime,
    success ? '' : trafficFailRemark,
  );

  log(`断开 WiFi "${wifiName}"...`);
  await wifiManager.disconnect();
  await new Promise(r => setTimeout(r, 1000));

  log(`--- 设备 ${sn} 处理完毕 ---`);
}

/**
 * 盲连兜底：不依赖扫描结果，直接尝试 netsh wlan connect。
 * 用于批量任务主循环结束后，仍从未被扫描命中过的设备（可能是热点 beacon 一直被干扰）。
 * 连接成功则照常跑量上报；连接失败则以「未扫描到...盲连兜底失败」的 remark 上报。
 */
async function processOneDeviceBlind(device, config) {
  const { testUrls, wifiReadyDelaySec } = config;
  const { sn, wifiName, wifiPassword } = device;

  if (!TrafficGenerator.normalizeTestUrls(testUrls).length) {
    const remark = '未配置测速链接（config.json 中 testUrls 为空或无效）';
    log(`[兜底] ${remark}，无法跑量`);
    device._status = 'failed';
    device._failRemark = remark;
    sendDeviceUpdate(device);
    await reportResult(device, 0, false, config, undefined, undefined, remark);
    return;
  }

  log(`[兜底] --- 处理设备: ${sn} (${wifiName}) ---`);
  device._status = 'processing';
  device._failRemark = '';
  sendDeviceUpdate(device);

  log(`[兜底] 未扫描到 WiFi "${wifiName}"，尝试直接连接...`);
  try {
    await wifiManager.disconnect();
    await new Promise((r) => setTimeout(r, 1000));
    await wifiManager.connect(wifiName, wifiPassword, { networkInfo: null });
    await ensureWifiConnectedTo(wifiName, '[兜底]');
    const readySec = Math.max(
      0,
      Math.min(86400, Math.floor(Number(wifiReadyDelaySec) || 0)),
    );
    if (readySec > 0) {
      log(`[兜底] 已连接 WiFi，等待 ${readySec} 秒后再开始跑流量（联网就绪）...`);
      await new Promise((r) => setTimeout(r, readySec * 1000));
    }
  } catch (e) {
    const remark = `未扫描到 WiFi「${wifiName}」，盲连兜底失败: ${e.message}`;
    log(`[兜底] ${remark}`);
    device._status = 'failed';
    device._failRemark = remark;
    sendDeviceUpdate(device);
    queueDeviceReboot(device, remark);
    await reportResult(device, 0, false, config, undefined, undefined, remark);
    return;
  }

  const speedStartTime = formatTime(new Date());
  const targetMB = randomTargetMB(config);
  const noProgressTimeoutSec = resolveTrafficNoProgressTimeoutSec(config);
  log(`[兜底] 开始跑流量，目标约 ${targetMB} MB...`);
  trafficGenerator = new TrafficGenerator(testUrls);
  let downloadedBytes = 0;
  let lastProgressUpdate = 0;
  let trafficFailRemark = '';
  try {
    downloadedBytes = await trafficGenerator.generate({
      targetMB,
      noProgressTimeoutMs: noProgressTimeoutSec * 1000,
      onDownloadEvent: (evt) => log(formatTrafficDownloadEvent(evt, '[兜底]')),
      onProgress: (downloaded, target) => {
        device._flow = downloaded;
        const now = Date.now();
        if (now - lastProgressUpdate > 500) {
          lastProgressUpdate = now;
          sendProgress({ sn, downloaded, target });
          sendDeviceUpdate(device);
        }
      },
    });
    log(`[兜底] 跑量完成: ${formatBytes(downloadedBytes)}`);
    if (downloadedBytes > 0) {
      device._status = 'success';
      device._failRemark = '';
    } else {
      trafficFailRemark = running ? '未下载到有效流量' : '任务已停止';
      device._status = 'failed';
      device._failRemark = trafficFailRemark;
      log(`[兜底] 跑量失败: ${trafficFailRemark}`);
    }
  } catch (e) {
    trafficFailRemark = e.message || '跑量异常';
    log(`[兜底] 跑量异常: ${trafficFailRemark}`);
    device._status = 'failed';
    device._failRemark = trafficFailRemark;
  }
  device._flow = downloadedBytes;
  sendDeviceUpdate(device);

  const speedEndTime = formatTime(new Date());
  const success = device._status === 'success';

  if (!success && !batchStopRequested) {
    queueDeviceReboot(device, trafficFailRemark);
  }

  await reportResult(
    device,
    downloadedBytes,
    success,
    config,
    speedStartTime,
    speedEndTime,
    success ? '' : trafficFailRemark,
  );

  log(`[兜底] 断开 WiFi "${wifiName}"...`);
  await wifiManager.disconnect();
  await new Promise((r) => setTimeout(r, 1000));

  log(`[兜底] --- 设备 ${sn} 处理完毕 ---`);
}

ipcMain.handle('start-single', async (_e, config, device) => {
  if (running) {
    log('任务已在执行中');
    return;
  }
  batchStopRequested = false;
  running = true;

  const { baseUrl, backupWifiName, backupWifiPassword } = config;
  apiClient.setBaseUrl(baseUrl);

  try {
    log(`===== 单设备跑量: ${device.sn} =====`);

    log('正在扫描 WiFi 网络...');
    let networks = await wifiManager.scan(true);
    sendWifiList(networks);
    {
      const ssidList = formatScannedSsidList(networks);
      log(
        `扫描到 ${networks.length} 个网络` +
          (ssidList ? `\n  SSID 列表: ${ssidList}` : '')
      );
    }

    const scanState = createScanState(networks);
    applyScanFlagsToDevices([device], scanState.lookup);
    sendDeviceUpdate(device);
    await processOneDevice(device, scanState, config);

    log(`===== 单设备跑量完成 =====`);
  } catch (e) {
    log(`任务异常: ${e.message}`);
  } finally {
    await reconnectBackupWifiAfterTask(config);
    running = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task-done');
    }
  }
});

ipcMain.handle('start-task', async (_e, config) => {
  if (running) {
    log('任务已在执行中');
    return;
  }
  batchStopRequested = false;
  running = true;

  const { baseUrl, backupWifiName, backupWifiPassword } = config;
  apiClient.setBaseUrl(baseUrl);

  const taskStartedAt = new Date();
  let devices = [];

  try {
    log('===== 开始跑量任务 =====');

    log('正在获取设备列表...');
    try {
      devices = await fetchDevicesWithNetworkFallback(config);
    } catch (e) {
      log(`获取设备列表失败: ${e.message}`);
      running = false;
      mainWindow.webContents.send('task-done');
      return;
    }
    log(`获取到 ${devices.length} 个设备`);

    if (devices.length === 0) {
      log('没有待测速设备');
      running = false;
      mainWindow.webContents.send('task-done');
      return;
    }

    if (!TrafficGenerator.normalizeTestUrls(config.testUrls).length) {
      log('未配置测速链接（config.json 中 testUrls 为空或无效），任务中止');
      running = false;
      mainWindow.webContents.send('task-done');
      return;
    }

    log('正在扫描 WiFi 网络...');
    let networks = await wifiManager.scan(true);
    const scanState = createScanState(networks);
    applyScanFlagsToDevices(devices, scanState.lookup);

    for (const dev of devices) {
      dev._status = 'pending';
      dev._flow = 0;
      sendDeviceUpdate(dev);
    }

    sendWifiList(networks);
    {
      const ssidList = formatScannedSsidList(networks);
      log(
        `扫描到 ${networks.length} 个网络` +
          (ssidList ? `\n  SSID 列表: ${ssidList}` : '')
      );
    }

    const refreshSec = resolveWifiListRefreshSec(config);
    if (refreshSec > 0) {
      log(`批量任务：优先处理当前扫描到的热点；WiFi 列表每 ${refreshSec} 秒自动刷新一次`);
    } else {
      log('批量任务：优先处理当前扫描到的热点；已关闭运行中 WiFi 定时刷新（配置 wifiListRefreshSec=0）');
    }

    let wifiRefreshTimer = null;
    let wifiRefreshInFlight = false;
    if (refreshSec > 0) {
      wifiRefreshTimer = setInterval(async () => {
        if (!running || wifiRefreshInFlight) return;
        wifiRefreshInFlight = true;
        try {
          const nets = await wifiManager.scan(true);
          const newNets = getNewScannedNetworks(scanState.lookup, nets);
          scanState.merge(nets);
          applyScanFlagsToDevices(devices, scanState.lookup);
          sendWifiList(nets);
          const newSsidList = formatScannedSsidList(newNets);
          log(
            `[WiFi] 定时刷新：${nets.length} 个网络，新增 ${newNets.length} 个` +
              (newSsidList ? `\n  新增 SSID: ${newSsidList}` : '')
          );
        } catch (e) {
          log(`[WiFi] 定时刷新失败: ${e.message}`);
        } finally {
          wifiRefreshInFlight = false;
        }
      }, refreshSec * 1000);
    }

    let processedCount = 0;
    try {
      // 第一阶段：只处理"曾扫到过"的设备（累积 lookup 命中的）
      // 剩下从未扫到的留给下面的盲连兜底阶段，避免走 processOneDevice 入口直接判失败
      while (running) {
        const pending = devices.filter((d) => d._status === 'pending');
        if (pending.length === 0) break;
        const visible = pending.filter((d) =>
          scanState.lookup.has(WifiManager.normalizeSsid(d.wifiName)),
        );
        if (visible.length === 0) break;
        visible.sort((a, b) => comparePendingDevices(a, b, scanState.lookup));
        await processOneDevice(visible[0], scanState, config);
        processedCount += 1;
      }

      // 第二阶段：盲连兜底——对整个任务期间从未被扫到过的 SSID，直接尝试连接
      // 仅在 config.enableBlindFallback 开启时执行；否则这些设备直接标记失败
      if (running) {
        const invisible = devices.filter((d) => d._status === 'pending');
        if (invisible.length > 0) {
          if (!config.enableBlindFallback) {
            log(`===== 剩余 ${invisible.length} 台从未扫到的设备（盲连兜底未开启，直接标记失败）=====`);
            invisible.sort((a, b) =>
              String(a.sn || '').localeCompare(String(b.sn || '')),
            );
            for (const dev of invisible) {
              if (!running) break;
              if (dev._status !== 'pending') continue;
              const remark = `未扫描到 WiFi「${dev.wifiName}」（本轮扫描未命中；如需仍然尝试连接请开启「盲连兜底」）`;
              log(remark);
              dev._status = 'failed';
              dev._failRemark = remark;
              sendDeviceUpdate(dev);
              queueDeviceReboot(dev, remark);
              await reportResult(dev, 0, false, config, undefined, undefined, remark);
              processedCount += 1;
            }
          } else {
            log(`===== 进入盲连兜底阶段：剩余 ${invisible.length} 台从未扫到的设备 =====`);
            try {
              const finalNets = await wifiManager.scan(true);
              scanState.merge(finalNets);
              applyScanFlagsToDevices(devices, scanState.lookup);
              sendWifiList(finalNets);
              const ssidList = formatScannedSsidList(finalNets);
              log(
                `[兜底] 最终扫描：${finalNets.length} 个网络` +
                  (ssidList ? `\n  SSID 列表: ${ssidList}` : ''),
              );
            } catch (e) {
              log(`[兜底] 最终扫描失败: ${e.message}`);
            }

            invisible.sort((a, b) =>
              String(a.sn || '').localeCompare(String(b.sn || '')),
            );
            for (const dev of invisible) {
              if (!running) break;
              if (dev._status !== 'pending') continue;
              const key = WifiManager.normalizeSsid(dev.wifiName);
              if (key && scanState.lookup.has(key)) {
                await processOneDevice(dev, scanState, config);
              } else {
                await processOneDeviceBlind(dev, config);
              }
              processedCount += 1;
            }
          }
        }
      }

      // 第三阶段：失败设备重试 —— 所有设备走完后，再扫描一次 WiFi 列表，
      // 把"当前仍能扫到 SSID 的失败设备"重置为 pending 再跑一遍；
      // 经过前面的成功上报，刚才入队的失败设备此时多数应已被下发重启命令，
      // 再扫一次更能反映真实在线状态
      if (running) {
        const failedDevices = devices.filter((d) => d._status === 'failed');
        if (failedDevices.length > 0) {
          log(`===== 失败设备重试阶段：共 ${failedDevices.length} 台失败设备，检查是否仍可扫描到 =====`);
          let retryScan = [];
          try {
            retryScan = await wifiManager.scan(true);
            scanState.merge(retryScan);
            applyScanFlagsToDevices(devices, scanState.lookup);
            sendWifiList(retryScan);
            const ssidList = formatScannedSsidList(retryScan);
            log(
              `[重试] 重试前扫描：${retryScan.length} 个网络` +
                (ssidList ? `\n  SSID 列表: ${ssidList}` : ''),
            );
          } catch (e) {
            log(`[重试] 扫描失败: ${e.message}`);
          }
          const retryLookup = buildScanLookup(retryScan);
          const retryTargets = failedDevices.filter((d) => {
            const k = WifiManager.normalizeSsid(d.wifiName);
            return k && retryLookup.has(k);
          });
          if (retryTargets.length === 0) {
            log('[重试] 暂无失败设备的 WiFi 在本次扫描中出现，跳过重试');
          } else {
            log(`[重试] ${retryTargets.length} 台失败设备的 WiFi 已重新扫到，开始重试`);
            retryTargets.sort((a, b) => comparePendingDevices(a, b, retryLookup));
            let retrySuccess = 0;
            for (const dev of retryTargets) {
              if (!running) break;
              log(`[重试] 重置设备 ${dev.sn}（${dev.wifiName}）为待跑量并重试`);
              dev._status = 'pending';
              dev._flow = 0;
              dev._failRemark = '';
              sendDeviceUpdate(dev);
              await processOneDevice(dev, scanState, config);
              if (dev._status === 'success') retrySuccess += 1;
            }
            log(
              `[重试] 重试阶段完成：${retryTargets.length} 台中 ${retrySuccess} 台成功，` +
                `${retryTargets.length - retrySuccess} 台仍失败`,
            );
          }
        }
      }
    } finally {
      if (wifiRefreshTimer) clearInterval(wifiRefreshTimer);
    }

    const total = devices.length;
    if (batchStopRequested && processedCount < total) {
      log(
        `===== 跑量任务已中止（用户停止；本轮已处理 ${processedCount}/${total} 台，剩余未跑）=====`,
      );
    } else {
      log(`===== 跑量任务完成（本轮已处理 ${processedCount}/${total} 台）=====`);
    }
  } catch (e) {
    log(`任务异常: ${e.message}`);
  } finally {
    await reconnectBackupWifiAfterTask(config);
    try {
      await writeRunReport({
        devices,
        startedAt: taskStartedAt,
        endedAt: new Date(),
        title: batchStopRequested ? '跑量任务报表（用户中止）' : '跑量任务报表',
      });
    } catch (e) {
      log(`[报表] 生成 Excel 报表失败: ${e.message}`);
    }
    running = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task-done');
    }
  }
});

async function writeRunReport({ devices, startedAt, endedAt, title }) {
  if (!Array.isArray(devices) || devices.length === 0) {
    log('[报表] 本次任务没有设备数据，跳过生成 Excel 报表');
    return;
  }
  if (!logDir) {
    log('[报表] 日志目录未初始化，无法生成 Excel 报表');
    return;
  }
  const filePath = await generateRunReport({
    outDir: logDir,
    devices,
    startedAt,
    endedAt,
    title,
  });
  const successCount = devices.filter((d) => d?._status === 'success').length;
  const failedCount = devices.filter((d) => d?._status === 'failed').length;
  log(
    `[报表] 已生成 Excel: ${filePath}（共 ${devices.length} 台，成功 ${successCount}，失败 ${failedCount}）`,
  );
}

async function reportResult(device, downloadedBytes, success, config, startTime, endTime, remark) {
  const { baseUrl, backupWifiName, backupWifiPassword } = config;
  const failRemark = success ? '' : (remark != null && String(remark).trim() ? String(remark).trim() : '');
  const record = {
    sn: device.sn,
    wifiName: device.wifiName,
    wifiPassword: device.wifiPassword,
    useFlow: Math.round(downloadedBytes / (1024 * 1024)),
    status: success ? 1 : 0,
    speedStartTime: startTime || formatTime(new Date()),
    speedEndTime: endTime || formatTime(new Date()),
    remark: failRemark,
  };

  log(`上报结果: ${device.sn}, 流量=${record.useFlow}MB, 状态=${success ? '成功' : '失败'}${failRemark ? `, remark=${failRemark}` : ''}`);

  const tryUpload = async () => {
    try {
      await apiClient.uploadRecord(record);
      log(`上报成功: ${device.sn}`);
      return true;
    } catch (e) {
      log(`上报失败: ${e.message}`);
      return false;
    }
  };

  let uploaded = await tryUpload();

  if (!uploaded && backupWifiName) {
    log(`尝试连接备用 WiFi "${backupWifiName}" 进行上报...`);
    try {
      await wifiManager.disconnect();
      await new Promise(r => setTimeout(r, 1000));
      await wifiManager.connect(backupWifiName, backupWifiPassword || '');
      await ensureWifiConnectedTo(backupWifiName, '[备用]');
      await new Promise(r => setTimeout(r, 2000));
      uploaded = await tryUpload();
      await wifiManager.disconnect();
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      log(`连接备用 WiFi 失败: ${e.message}`);
    }
  }

  if (!uploaded) {
    log(`警告: 设备 ${device.sn} 的结果未能成功上报`);
  }

  // 仅在"设备本次跑量成功 + 已成功上报"时才尝试下发重启：此刻我们确信
  // 当前所处的 WiFi 是带网络的，能调通 BOSS 的 sendCmd703 接口
  if (uploaded && success) {
    try {
      await flushPendingDeviceReboots(device.sn);
    } catch (e) {
      log(`[重启队列] 处理异常: ${e.message}`);
    }
  }
}

// ---- App lifecycle ----

app.whenReady().then(() => {
  configManager = new ConfigManager();
  logDir = path.join(configManager.getBaseDir(), 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
  wifiManager = new WifiManager({ debugLog: (msg) => log(msg) });
  apiClient = new ApiClient();
  apiClient.setLogger((msg) => log(msg));
  log(`配置文件: ${configManager.getPath()}`);
  log(`日志目录: ${logDir}`);
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
