const { app, BrowserWindow, ipcMain } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const WifiManager = require('./src/wifi-manager');
const TrafficGenerator = require('./src/traffic-generator');
const ApiClient = require('./src/api-client');
const ConfigManager = require('./src/config-manager');

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
let testingAborted = false;
let testAbortEmitter = null;

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

function formatTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${mi}:${s}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
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
  const { baseUrl, backupWifiName, backupWifiPassword } = config;
  if (!baseUrl) throw new Error('未配置 API 地址');
  apiClient.setBaseUrl(baseUrl);
  try {
    return await apiClient.fetchDevices();
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
    return await apiClient.fetchDevices();
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
    log(`扫描完成，发现 ${networks.length} 个 WiFi 网络`);
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

async function processOneDevice(device, networks, config) {
  const { baseUrl, backupWifiName, backupWifiPassword, testUrls } = config;
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

  let matched = false;
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const found = networks.find(n => n.ssid === wifiName);
    if (found) {
      matched = true;
      log(`WiFi "${wifiName}" 已匹配，信号: ${found.signal || '未知'}`);
      break;
    }
    log(`未找到 WiFi "${wifiName}"，重试扫描 (${attempt + 1}/${MAX_RETRIES})...`);
    await new Promise(r => setTimeout(r, 2000));
    networks = await wifiManager.scan(true);
    sendWifiList(networks);
  }

  if (!matched) {
    const remark = `未扫描到 WiFi「${wifiName}」`;
    log(`WiFi "${wifiName}" 未发现，标记为失败`);
    device._status = 'failed';
    device._failRemark = remark;
    sendDeviceUpdate(device);
    await reportResult(device, 0, false, config, undefined, undefined, remark);
    return;
  }

  log(`正在连接 WiFi "${wifiName}"...`);
  try {
    await wifiManager.disconnect();
    await new Promise(r => setTimeout(r, 1000));
    await wifiManager.connect(wifiName, wifiPassword);
    await ensureWifiConnectedTo(wifiName);
  } catch (e) {
    const remark = `连接失败: ${e.message}`;
    log(remark);
    device._status = 'failed';
    device._failRemark = remark;
    sendDeviceUpdate(device);
    await reportResult(device, 0, false, config, undefined, undefined, remark);
    return;
  }

  const speedStartTime = formatTime(new Date());
  const targetMB = (100 + Math.random() * 100).toFixed(0);
  log(`开始跑流量，目标约 ${targetMB} MB...`);
  trafficGenerator = new TrafficGenerator(testUrls);
  let downloadedBytes = 0;
  let lastProgressUpdate = 0;
  let trafficFailRemark = '';
  try {
    downloadedBytes = await trafficGenerator.generate({
      onDownloadUrl: (u) => log(`[下载] 当前链接: ${u}`),
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
    device._status = 'success';
    device._failRemark = '';
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

ipcMain.handle('start-single', async (_e, config, device) => {
  if (running) {
    log('任务已在执行中');
    return;
  }
  running = true;

  const { baseUrl, backupWifiName, backupWifiPassword } = config;
  apiClient.setBaseUrl(baseUrl);

  try {
    log(`===== 单设备跑量: ${device.sn} =====`);

    log('正在扫描 WiFi 网络...');
    let networks = await wifiManager.scan(true);
    sendWifiList(networks);
    log(`扫描到 ${networks.length} 个网络`);

    await processOneDevice(device, networks, config);

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
  running = true;

  const { baseUrl, backupWifiName, backupWifiPassword } = config;
  apiClient.setBaseUrl(baseUrl);

  try {
    log('===== 开始跑量任务 =====');

    log('正在获取设备列表...');
    let devices;
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

    for (const dev of devices) {
      dev._status = 'pending';
      dev._flow = 0;
      sendDeviceUpdate(dev);
    }

    log('正在扫描 WiFi 网络...');
    let networks = await wifiManager.scan(true);
    sendWifiList(networks);
    log(`扫描到 ${networks.length} 个网络`);

    for (const device of devices) {
      if (!running) break;
      await processOneDevice(device, networks, config);
    }

    log('===== 跑量任务完成 =====');
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
}

// ---- App lifecycle ----

app.whenReady().then(() => {
  configManager = new ConfigManager();
  logDir = path.join(configManager.getBaseDir(), 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
  wifiManager = new WifiManager();
  apiClient = new ApiClient();
  apiClient.setLogger((msg) => log(msg));
  log(`配置文件: ${configManager.getPath()}`);
  log(`日志目录: ${logDir}`);
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
