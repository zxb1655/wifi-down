const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_NAME = 'config.json';

/** 测速链接以项目目录下 config.json 的 testUrls 为准；项可为 { url, referer?, name? } */
const DEFAULTS = {
  baseUrl: '',
  backupWifiName: '',
  backupWifiPassword: '',
  timerInterval: 0,
  timerUnit: 'min',
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
    const data = {
      baseUrl: config.baseUrl ?? DEFAULTS.baseUrl,
      backupWifiName: config.backupWifiName ?? DEFAULTS.backupWifiName,
      backupWifiPassword: config.backupWifiPassword ?? DEFAULTS.backupWifiPassword,
      timerInterval: config.timerInterval ?? DEFAULTS.timerInterval,
      timerUnit: config.timerUnit ?? DEFAULTS.timerUnit,
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
