const $ = (sel) => document.querySelector(sel);

const state = {
  devices: [],
  wifiList: [],
  testUrls: [],
  running: false,
  runningMode: 'none', // none | bulk | single-queue
  testing: false,
  singleQueue: [],
  singleQueueSet: new Set(),
  singleQueueRunning: false,
  singleCurrentSn: '',
  advancedVisible: false,
};

const elBaseUrl = $('#baseUrl');
const elComputerKey = $('#computerKey');
const elBackupName = $('#backupWifiName');
const elBackupPass = $('#backupWifiPassword');
const elWifiReadyDelaySec = $('#wifiReadyDelaySec');
const elWifiListRefreshSec = $('#wifiListRefreshSec');
const elBtnStart = $('#btnStart');
const elBtnStop = $('#btnStop');
const elBtnScan = $('#btnScan');
const elBtnFetch = $('#btnFetchDevices');
const elTaskStatus = $('#taskStatus');
const elDeviceList = $('#deviceList');
const elDeviceCount = $('#deviceCount');
const elWifiList = $('#wifiList');
const elWifiCount = $('#wifiCount');
const elTestUrlSelect = $('#testUrlSelect');
const elTestUrlMB = $('#testUrlMB');
const elBtnTestUrl = $('#btnTestUrl');
const elBtnTestAllUrls = $('#btnTestAllUrls');
const elBtnStopTest = $('#btnStopTest');
const elTestProgress = $('#testProgress');
const elTestProgressFill = $('#testProgressFill');
const elTestProgressText = $('#testProgressText');
const elLogContent = $('#logContent');
const elBtnClearLog = $('#btnClearLog');
const elApiConfigGroup = $('#apiConfigGroup');
const elTestToolsRow = $('#testToolsRow');
const elTrafficMinMB = $('#trafficMinMB');
const elTrafficMaxMB = $('#trafficMaxMB');

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function getStatusLabel(status) {
  const map = { pending: '待处理', processing: '进行中', success: '成功', failed: '失败' };
  return map[status] || status || '待处理';
}

function getStatusIcon(status) {
  const map = {
    pending: '⏳',
    processing: '⚡',
    success: '✓',
    failed: '✗',
  };
  return map[status] || '⏳';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function parseSignalPercent(signal) {
  if (!signal) return 0;
  const m = signal.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** 与主进程 WifiManager.normalizeSsid 一致，用于列表与扫描结果对齐 */
function normalizeSsidMatch(ssid) {
  if (ssid == null) return null;
  let s = String(ssid).trim();
  if (!s) return null;
  s = s.replace(/^["']+|["']+$/g, '');
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  return s.normalize('NFKC');
}

/** 根据当前 WiFi 扫描结果为设备打上「是否在本轮列表中」标记 */
function syncDeviceScanFlagsFromWifiList() {
  const best = new Map();
  for (const w of state.wifiList) {
    const k = normalizeSsidMatch(w.ssid);
    if (!k) continue;
    const pct = parseSignalPercent(w.signal);
    const prev = best.get(k);
    if (!prev || pct > prev.pct) best.set(k, { signal: w.signal, pct });
  }
  state.devices.forEach((d) => {
    const k = normalizeSsidMatch(d.wifiName);
    const hit = k && best.has(k);
    d._scanVisible = !!hit;
    d._scanSignal = hit ? best.get(k).signal : '';
  });
}

/** 展示顺序：已扫描到的在上，其次信号强度，再按 SN */
function sortDevicesForDisplay(list) {
  return [...list].sort((a, b) => {
    const av = !!a._scanVisible;
    const bv = !!b._scanVisible;
    if (av !== bv) return (bv ? 1 : 0) - (av ? 1 : 0);
    const ap = parseSignalPercent(a._scanSignal || '');
    const bp = parseSignalPercent(b._scanSignal || '');
    if (bp !== ap) return bp - ap;
    return String(a.sn || '').localeCompare(String(b.sn || ''));
  });
}

function buildSignalBars(signal) {
  const pct = parseSignalPercent(signal);
  const level = pct >= 70 ? 4 : pct >= 50 ? 3 : pct >= 30 ? 2 : pct > 0 ? 1 : 0;
  const cls = pct >= 50 ? '' : pct >= 30 ? ' medium' : ' weak';
  const bars = [1, 2, 3, 4].map(i =>
    `<div class="bar${i <= level ? ' active' : ''}"></div>`
  ).join('');
  return `<div class="wifi-signal-bars${cls}">${bars}</div>`;
}

function renderDevices() {
  if (state.devices.length === 0) {
    elDeviceList.innerHTML = '<div class="empty-hint">点击"获取设备"加载列表</div>';
    elDeviceCount.textContent = '0';
    return;
  }
  elDeviceCount.textContent = state.devices.length;
  const sorted = sortDevicesForDisplay(state.devices);
  elDeviceList.innerHTML = sorted.map(d => {
    const status = d._status || 'pending';
    const queued = !!d._queued;
    const runningSingle = !!d.sn && d.sn === state.singleCurrentSn;
    const flow = d._flow || 0;
    const progress = d._progress || 0;
    const snDisplay = d.sn
      ? escapeHtml(d.sn)
      : '<span class="placeholder">未知设备号</span>';
    const wifiDisplay = d.wifiName
      ? escapeHtml(d.wifiName)
      : '<span class="placeholder">未配置WiFi</span>';
    const passDisplay =
      d.wifiPassword != null && String(d.wifiPassword).length > 0
        ? escapeHtml(String(d.wifiPassword))
        : '<span class="placeholder">无</span>';

    const canRun = status !== 'success' && status !== 'processing' && !queued && !runningSingle && state.runningMode !== 'bulk';
    const scanOk = !!d._scanVisible;
    const scanLabel = scanOk
      ? `<span class="device-scan-tag in-range">已扫描到${d._scanSignal ? ` ${escapeHtml(parseSignalPercent(d._scanSignal) + '%')}` : ''}</span>`
      : '<span class="device-scan-tag out-range">未扫描到</span>';
    return `
      <div class="device-item status-${status}" data-sn="${escapeHtml(d.sn || '')}">
        <div class="device-icon ${status}">${getStatusIcon(status)}</div>
        <div class="device-info">
          <div class="device-sn-row"><span class="device-sn">${snDisplay}</span>${scanLabel}</div>
          <div class="device-wifi">
            <svg class="device-wifi-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/></svg>
            ${wifiDisplay}
          </div>
          <div class="device-wifi-pass"><span class="device-wifi-pass-label">密码</span>${passDisplay}</div>
          ${status === 'failed' && d._failRemark ? `<div class="device-fail-remark">${escapeHtml(d._failRemark)}</div>` : ''}
          ${status === 'processing' ? `<div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${progress}%"></div></div>` : ''}
        </div>
        <span class="device-flow">${flow > 0 ? formatBytes(flow) : '-'}</span>
        <button class="btn btn-run-single ${canRun ? '' : 'disabled'}" data-sn="${escapeHtml(d.sn || '')}" ${canRun ? '' : 'disabled'}>${runningSingle ? '运行中' : (queued ? '排队中' : '跑量')}</button>
        <span class="device-status ${status}">${getStatusLabel(status)}</span>
      </div>
    `;
  }).join('');

  elDeviceList.querySelectorAll('.btn-run-single').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sn = btn.dataset.sn;
      const device = state.devices.find(d => d.sn === sn);
      if (!device) return;
      if (device._status === 'success') {
        appendLog(`[UI] 设备 ${device.sn} 已跑量成功，不允许重复跑量`);
        return;
      }
      const config = getFullConfig();
      if (!config.baseUrl) {
        appendLog('[UI] 请先配置 API 地址');
        return;
      }
      if (getTestUrlEntries().length === 0) {
        appendLog('[UI] 未配置有效测速链接（请在 config.json 中配置 testUrls）');
        return;
      }
      enqueueSingleDevice(device);
    });
  });
}

function renderWifiList() {
  if (state.wifiList.length === 0) {
    elWifiList.innerHTML = '<div class="empty-hint">点击"扫描 WiFi"加载列表</div>';
    elWifiCount.textContent = '0';
    return;
  }
  elWifiCount.textContent = state.wifiList.length;

  const deviceNames = new Set(state.devices.map(d => d.wifiName));

  elWifiList.innerHTML = state.wifiList.map(w => {
    const matched = deviceNames.has(w.ssid);
    const pct = parseSignalPercent(w.signal);
    return `
      <div class="wifi-item ${matched ? 'matched' : ''}">
        ${buildSignalBars(w.signal)}
        <span class="wifi-ssid">${escapeHtml(w.ssid)}</span>
        ${matched ? '<span class="wifi-match-tag">匹配</span>' : ''}
        <span class="wifi-signal-pct">${pct > 0 ? pct + '%' : ''}</span>
      </div>
    `;
  }).join('');
}

/** @returns {{ url: string, referer: string|null, name: string|null } | null} */
function normalizeTestUrlItem(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const u = raw.trim();
    return u ? { url: u, referer: null, name: null } : null;
  }
  if (typeof raw === 'object' && typeof raw.url === 'string') {
    const u = raw.url.trim();
    if (!u) return null;
    const r = raw.referer;
    const referer = r != null && String(r).trim() !== '' ? String(r).trim() : null;
    const name = raw.name != null && String(raw.name).trim() !== '' ? String(raw.name).trim() : null;
    return { url: u, referer, name };
  }
  return null;
}

function getTestUrlEntries() {
  return state.testUrls.map(normalizeTestUrlItem).filter(Boolean);
}

function formatTestUrlOptionLabel(e) {
  const urlShort = e.url.length > 56 ? e.url.substring(0, 56) + '...' : e.url;
  let s = e.name ? `${e.name} - ${urlShort}` : urlShort;
  if (e.referer) s += ' [Referer]';
  return s;
}

function renderTestUrlSelect() {
  const entries = getTestUrlEntries();
  elTestUrlSelect.innerHTML = '<option value="">-- 选择链接 --</option>' +
    entries.map((e, i) => {
      return `<option value="${i}">${escapeHtml(formatTestUrlOptionLabel(e))}</option>`;
    }).join('');
}

function showTestProgress(show) {
  elTestProgress.style.display = show ? 'flex' : 'none';
}

function updateTestProgress(downloaded, target) {
  const pct = target > 0 ? Math.min(100, (downloaded / target) * 100) : 0;
  elTestProgressFill.style.width = pct + '%';
  elTestProgressText.textContent = `${formatBytes(downloaded)} / ${formatBytes(target)}`;
}

function appendLog(msg) {
  const line = document.createElement('div');
  line.className = 'log-line';
  if (msg.includes('失败') || msg.includes('异常') || msg.includes('错误')) {
    line.classList.add('error');
  }
  line.textContent = msg;
  elLogContent.appendChild(line);
  elLogContent.scrollTop = elLogContent.scrollHeight;
}

function setRunning(val, mode = 'bulk') {
  state.running = val;
  state.runningMode = val ? mode : 'none';
  elBtnStart.disabled = val;
  elBtnStop.disabled = !val;
  elBtnScan.disabled = val;
  elBtnFetch.disabled = val;
  elTaskStatus.textContent = val ? '运行中' : '就绪';
  elTaskStatus.className = 'status-badge' + (val ? ' running' : '');
}

function clearSingleQueue(logMessage) {
  state.singleQueue = [];
  state.singleQueueSet.clear();
  state.singleCurrentSn = '';
  state.devices.forEach(d => { d._queued = false; });
  if (logMessage) appendLog(logMessage);
}

function resetProcessingDevicesAfterStop() {
  state.devices.forEach(d => {
    if (d._status === 'processing') {
      d._status = 'pending';
      d._progress = 0;
      d._failRemark = '';
    }
  });
}

function renderAdvancedArea() {
  if (elApiConfigGroup) {
    elApiConfigGroup.style.display = state.advancedVisible ? '' : 'none';
  }
  if (elTestToolsRow) {
    elTestToolsRow.style.display = state.advancedVisible ? 'flex' : 'none';
  }
}

function enqueueSingleDevice(device) {
  const sn = device.sn;
  if (!sn) {
    appendLog('[UI] 设备缺少 SN，无法加入队列');
    return;
  }
  if (state.singleQueueSet.has(sn)) {
    appendLog(`[UI] 设备 ${sn} 已在单设备队列中`);
    return;
  }
  if (state.singleCurrentSn === sn) {
    appendLog(`[UI] 设备 ${sn} 正在执行中`);
    return;
  }
  state.singleQueue.push({
    sn: device.sn,
    wifiName: device.wifiName,
    wifiPassword: device.wifiPassword,
  });
  state.singleQueueSet.add(sn);
  device._queued = true;
  appendLog(`[UI] 设备 ${sn} 已加入队列（当前排队 ${state.singleQueue.length}）`);
  renderDevices();
  processSingleQueue();
}

async function processSingleQueue() {
  if (state.singleQueueRunning) return;
  if (state.runningMode === 'bulk') return;

  state.singleQueueRunning = true;
  setRunning(true, 'single-queue');
  renderDevices();

  try {
    while (state.singleQueue.length > 0) {
      const item = state.singleQueue.shift();
      if (!item || !item.sn) continue;
      state.singleQueueSet.delete(item.sn);

      const device = state.devices.find(d => d.sn === item.sn);
      if (!device) continue;

      state.singleCurrentSn = item.sn;
      device._queued = false;
      device._status = 'pending';
      device._flow = 0;
      device._progress = 0;
      device._failRemark = '';
      renderDevices();

      const config = getFullConfig();
      if (!config.baseUrl) {
        clearSingleQueue('[UI] 请先配置 API 地址，队列已停止');
        break;
      }
      if (getTestUrlEntries().length === 0) {
        clearSingleQueue('[UI] 未配置有效测速链接，队列已停止');
        break;
      }

      appendLog(`[UI] 开始执行队列设备: ${item.sn}`);
      try {
        await window.api.startSingle(config, item);
      } catch (e) {
        appendLog(`[UI] 单设备任务异常: ${e.message}`);
      } finally {
        state.singleCurrentSn = '';
        renderDevices();
      }
    }
  } finally {
    state.singleQueueRunning = false;
    state.singleCurrentSn = '';
    if (state.runningMode === 'single-queue') {
      setRunning(false);
    }
    renderDevices();
  }
}

function setTesting(val) {
  state.testing = val;
  elBtnTestUrl.style.display = val ? 'none' : '';
  elBtnTestAllUrls.style.display = val ? 'none' : '';
  elBtnStopTest.style.display = val ? '' : 'none';
  if (val) {
    showTestProgress(true);
  } else {
    showTestProgress(false);
  }
}

function getConfig() {
  return {
    baseUrl: elBaseUrl.value.trim(),
    computerKey: elComputerKey.value.trim(),
    backupWifiName: elBackupName.value.trim(),
    backupWifiPassword: elBackupPass.value.trim(),
  };
}

function getFullConfig() {
  const readySec = parseInt(elWifiReadyDelaySec.value, 10);
  const listRefresh = parseInt(elWifiListRefreshSec.value, 10);
  return {
    baseUrl: elBaseUrl.value.trim(),
    computerKey: elComputerKey.value.trim(),
    backupWifiName: elBackupName.value.trim(),
    backupWifiPassword: elBackupPass.value.trim(),
    wifiReadyDelaySec: Number.isFinite(readySec) ? Math.max(0, Math.min(86400, readySec)) : 0,
    wifiListRefreshSec: Number.isFinite(listRefresh)
      ? Math.max(0, Math.min(3600, listRefresh))
      : 45,
    trafficMinMB: parseInt(elTrafficMinMB?.value, 10),
    trafficMaxMB: parseInt(elTrafficMaxMB?.value, 10),
    testUrls: state.testUrls,
  };
}

let _saveTimer = null;
function scheduleSaveConfig() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    window.api.saveConfig(getFullConfig());
  }, 500);
}

function applyConfig(cfg) {
  if (cfg.baseUrl) elBaseUrl.value = cfg.baseUrl;
  if (cfg.computerKey) elComputerKey.value = cfg.computerKey;
  if (cfg.backupWifiName) elBackupName.value = cfg.backupWifiName;
  if (cfg.backupWifiPassword) elBackupPass.value = cfg.backupWifiPassword;
  if (cfg.wifiReadyDelaySec != null && cfg.wifiReadyDelaySec !== '') {
    elWifiReadyDelaySec.value = cfg.wifiReadyDelaySec;
  } else {
    elWifiReadyDelaySec.value = 0;
  }
  if (elWifiListRefreshSec) {
    if (cfg.wifiListRefreshSec != null && cfg.wifiListRefreshSec !== '') {
      elWifiListRefreshSec.value = cfg.wifiListRefreshSec;
    } else {
      elWifiListRefreshSec.value = 45;
    }
  }
  if (cfg.testUrls && Array.isArray(cfg.testUrls)) {
    state.testUrls = cfg.testUrls;
    renderTestUrlSelect();
  }
  if (elTrafficMinMB && elTrafficMaxMB) {
    if (cfg.trafficMinMB != null && cfg.trafficMinMB !== '') {
      elTrafficMinMB.value = cfg.trafficMinMB;
    }
    if (cfg.trafficMaxMB != null && cfg.trafficMaxMB !== '') {
      elTrafficMaxMB.value = cfg.trafficMaxMB;
    }
  }
}

window.api.onLog((msg) => appendLog(msg));

window.api.onWifiList((list) => {
  state.wifiList = list;
  syncDeviceScanFlagsFromWifiList();
  renderWifiList();
  renderDevices();
});

window.api.onDeviceUpdate((device) => {
  const idx = state.devices.findIndex(d => d.sn === device.sn);
  if (idx >= 0) {
    state.devices[idx] = { ...state.devices[idx], ...device };
  } else {
    // 开始跑量时主进程会拉取列表并推送，若未先点「获取设备」则此处需加入列表
    state.devices.push({
      ...device,
      _status: device._status || 'pending',
      _flow: device._flow ?? 0,
      _progress: device._progress ?? 0,
      _failRemark: device._failRemark ?? '',
    });
  }
  renderDevices();
});

window.api.onProgress(({ sn, downloaded, target }) => {
  const dev = state.devices.find(d => d.sn === sn);
  if (dev) {
    dev._flow = downloaded;
    dev._progress = target > 0 ? Math.min(100, (downloaded / target) * 100) : 0;
    renderDevices();
  }
});

window.api.onTaskDone(() => {
  if (state.runningMode === 'single-queue') return;
  setRunning(false);
});

window.api.onTestProgress(({ downloaded, target }) => {
  updateTestProgress(downloaded, target);
});

elBtnScan.addEventListener('click', async () => {
  elBtnScan.disabled = true;
  appendLog('[UI] 正在扫描 WiFi...');
  try {
    const list = await window.api.scanWifi();
    state.wifiList = list;
    syncDeviceScanFlagsFromWifiList();
    renderWifiList();
    renderDevices();
  } catch (e) {
    appendLog('[UI] 扫描失败: ' + e.message);
  }
  elBtnScan.disabled = state.running;
});

elBtnFetch.addEventListener('click', async () => {
  const baseUrl = elBaseUrl.value.trim();
  if (!baseUrl) {
    appendLog('[UI] 请先配置 API 地址');
    return;
  }
  elBtnFetch.disabled = true;
  appendLog('[UI] 正在获取设备列表...');
  try {
    const devices = await window.api.fetchDevices(getFullConfig());
    state.devices = devices.map(d => ({
      ...d,
      _status: 'pending',
      _flow: 0,
      _progress: 0,
      _failRemark: '',
      _scanVisible: false,
      _scanSignal: '',
    }));
    syncDeviceScanFlagsFromWifiList();
    renderDevices();
    renderWifiList();
  } catch (e) {
    appendLog('[UI] 获取设备失败: ' + e.message);
  }
  elBtnFetch.disabled = state.running;
});

elBtnStart.addEventListener('click', async () => {
  const config = getFullConfig();
  if (!config.baseUrl) {
    appendLog('[UI] 请先配置 API 地址');
    return;
  }
  setRunning(true, 'bulk');
  if (state.singleQueue.length > 0 || state.singleQueueSet.size > 0) {
    clearSingleQueue('[UI] 检测到批量任务启动，已清空单设备队列');
  }
  state.devices.forEach(d => { d._status = 'pending'; d._flow = 0; d._progress = 0; d._failRemark = ''; });
  renderDevices();
  await window.api.startTask(config);
});

elBtnStop.addEventListener('click', async () => {
  await window.api.stopTask();
  if (state.runningMode === 'single-queue') {
    clearSingleQueue('[UI] 已停止当前任务并清空单设备队列');
  } else if (state.runningMode === 'bulk') {
    resetProcessingDevicesAfterStop();
    appendLog('[UI] 已停止批量任务，运行中设备已重置为待处理');
  }
  setRunning(false);
  renderDevices();
});

elBtnClearLog.addEventListener('click', () => {
  elLogContent.innerHTML = '';
});

elBtnTestUrl.addEventListener('click', async () => {
  const idx = elTestUrlSelect.value;
  if (idx === '' || idx === undefined) {
    appendLog('[UI] 请选择一个测速链接');
    return;
  }

  const entry = getTestUrlEntries()[parseInt(idx, 10)];
  if (!entry) {
    appendLog('[UI] 无效的链接');
    return;
  }

  const targetMB = parseFloat(elTestUrlMB.value) || 10;
  const targetBytes = targetMB * 1024 * 1024;

  setTesting(true);
  updateTestProgress(0, targetBytes);

  appendLog(`[测速] 开始测试: ${entry.url.substring(0, 50)}...`);
  if (entry.referer) appendLog(`[测速] Referer: ${entry.referer}`);
  appendLog(`[测速] 目标下载: ${targetMB} MB`);

  const startTime = Date.now();

  try {
    const result = await window.api.testDownload(entry, targetMB);
    const elapsed = (Date.now() - startTime) / 1000;

    if (result.aborted) {
      appendLog(`[测速] 已停止，已下载: ${formatBytes(result.downloaded || 0)}`);
    } else {
      const speed = result.downloaded > 0 ? (result.downloaded / 1024 / 1024 / elapsed).toFixed(2) : 0;
      appendLog(`[测速] 完成: ${formatBytes(result.downloaded)}, 耗时 ${elapsed.toFixed(1)}s, 平均速度 ${speed} MB/s`);
    }
  } catch (e) {
    appendLog(`[测速] 失败: ${e.message}`);
  }

  setTesting(false);
});

elBtnTestAllUrls.addEventListener('click', async () => {
  const entries = getTestUrlEntries();
  if (entries.length === 0) {
    appendLog('[UI] 没有可测试的链接');
    return;
  }

  setTesting(true);
  appendLog('[UI] 开始测试所有链接...');

  const results = await window.api.testAllUrls(entries);

  let successCount = 0;
  results.forEach((result, i) => {
    const label = formatTestUrlOptionLabel(entries[i]);
    if (result.success) {
      successCount++;
      appendLog(`[测试] ✓ ${label} - ${result.speed}`);
    } else {
      appendLog(`[测试] ✗ ${label} - ${result.error}`);
    }
  });

  setTesting(false);
  appendLog(`[UI] 测试完成: ${successCount}/${results.length} 个链接可用`);
});

elBtnStopTest.addEventListener('click', async () => {
  appendLog('[UI] 正在停止测试...');
  setTesting(false);
  showTestProgress(false);
  await window.api.stopTest();
});

[elBaseUrl, elComputerKey, elBackupName, elBackupPass, elWifiReadyDelaySec, elWifiListRefreshSec, elTrafficMinMB, elTrafficMaxMB].forEach(el => {
  if (el) el.addEventListener('input', scheduleSaveConfig);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'F1') return;
  e.preventDefault();
  state.advancedVisible = !state.advancedVisible;
  renderAdvancedArea();
  appendLog(`[UI] 高级配置区域已${state.advancedVisible ? '显示' : '隐藏'}`);
});

(async () => {
  try {
    const cfg = await window.api.loadConfig();
    applyConfig(cfg);
    appendLog('[UI] 已加载配置文件');
  } catch (_) {}
  renderAdvancedArea();
  appendLog('[UI] 工具已就绪，请配置 API 地址后开始使用');
})();
