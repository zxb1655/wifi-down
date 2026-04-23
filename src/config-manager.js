const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_NAME = 'config.json';

/** 测速链接以项目目录下 config.json 的 testUrls 为准；项可为 { url, referer?, name? } */
const DEFAULTS = {
  baseUrl: '',
  /** 当前电脑标识（获取设备列表时作为 key 参数传给后端） */
  computerKey: '',
  backupWifiName: '',
  backupWifiPassword: '',
  /** 连接上目标 WiFi 并校验通过后，等待多少秒再开始跑流量（部分机器需等 DHCP/路由就绪） */
  wifiReadyDelaySec: 0,
  /** 批量跑量时自动重新扫描 WiFi 的间隔（秒）；0 表示仅在任务开始时扫一次 */
  wifiListRefreshSec: 45,
  /** 每台设备跑流量时，随机目标区间（MB，含端点整数） */
  trafficMinMB: 100,
  trafficMaxMB: 200,
  testUrls: [],
};

class ConfigManager {
  constructor() {
    /** 可写路径：开发时为项目根；打包后为 exe 同目录（用户可覆盖默认） */
    this._writablePath = this._resolveWritableConfigPath();
    /** 打包后内置默认，位于 app.asar 内，只读 */
    this._bundledPath = app.isPackaged
      ? path.join(app.getAppPath(), CONFIG_NAME)
      : null;
    /** 最近一次实际读取的配置文件路径（用于日志展示） */
    this._loadedFromPath = null;
  }

  _resolveWritableConfigPath() {
    if (app.isPackaged) {
      return path.join(path.dirname(app.getPath('exe')), CONFIG_NAME);
    }
    return path.join(app.getAppPath(), CONFIG_NAME);
  }

  load() {
    const tryRead = (p) => {
      if (!fs.existsSync(p)) return null;
      const raw = fs.readFileSync(p, 'utf-8');
      const data = JSON.parse(raw);
      this._loadedFromPath = p;
      return { ...DEFAULTS, ...data };
    };
    try {
      const fromUser = tryRead(this._writablePath);
      if (fromUser) return fromUser;
      if (this._bundledPath) {
        const fromBundled = tryRead(this._bundledPath);
        if (fromBundled) return fromBundled;
      }
    } catch (_) {}
    this._loadedFromPath = null;
    return { ...DEFAULTS };
  }

  save(config) {
    const rawReady = Number(config.wifiReadyDelaySec);
    const wifiReady = Number.isFinite(rawReady) ? Math.max(0, Math.min(86400, Math.floor(rawReady))) : 0;
    const rawListRefresh = Number(config.wifiListRefreshSec);
    const wifiListRefreshSec = Number.isFinite(rawListRefresh)
      ? Math.max(0, Math.min(3600, Math.floor(rawListRefresh)))
      : DEFAULTS.wifiListRefreshSec;
    let tMin = Math.floor(Number(config.trafficMinMB));
    let tMax = Math.floor(Number(config.trafficMaxMB));
    if (!Number.isFinite(tMin)) tMin = DEFAULTS.trafficMinMB;
    if (!Number.isFinite(tMax)) tMax = DEFAULTS.trafficMaxMB;
    tMin = Math.max(1, Math.min(50000, tMin));
    tMax = Math.max(1, Math.min(50000, tMax));
    if (tMin > tMax) {
      const x = tMin;
      tMin = tMax;
      tMax = x;
    }
    const data = {
      baseUrl: config.baseUrl ?? DEFAULTS.baseUrl,
      computerKey: config.computerKey ?? DEFAULTS.computerKey,
      backupWifiName: config.backupWifiName ?? DEFAULTS.backupWifiName,
      backupWifiPassword: config.backupWifiPassword ?? DEFAULTS.backupWifiPassword,
      wifiReadyDelaySec: wifiReady,
      wifiListRefreshSec,
      trafficMinMB: tMin,
      trafficMaxMB: tMax,
      testUrls: Array.isArray(config.testUrls) ? config.testUrls : DEFAULTS.testUrls,
    };
    fs.writeFileSync(this._writablePath, JSON.stringify(data, null, 2), 'utf-8');
    this._loadedFromPath = this._writablePath;
    return data;
  }

  getPath() {
    if (this._loadedFromPath) return this._loadedFromPath;
    return this._writablePath;
  }

  getBaseDir() {
    if (app.isPackaged) {
      return path.dirname(app.getPath('exe'));
    }
    return path.dirname(this._writablePath);
  }
}

module.exports = ConfigManager;
