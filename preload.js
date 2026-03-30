const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  scanWifi: () => ipcRenderer.invoke('scan-wifi'),
  fetchDevices: (config) => ipcRenderer.invoke('fetch-devices', config),
  startTask: (config) => ipcRenderer.invoke('start-task', config),
  startSingle: (config, device) => ipcRenderer.invoke('start-single', config, device),
  stopTask: () => ipcRenderer.invoke('stop-task'),
  testUrl: (url) => ipcRenderer.invoke('test-url', url),
  testAllUrls: (urls) => ipcRenderer.invoke('test-all-urls', urls),
  testDownload: (url, targetMB) => ipcRenderer.invoke('test-download', url, targetMB),
  stopTest: () => ipcRenderer.invoke('stop-test'),

  onLog: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('log', listener);
    return () => ipcRenderer.removeListener('log', listener);
  },
  onDeviceUpdate: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('device-update', listener);
    return () => ipcRenderer.removeListener('device-update', listener);
  },
  onWifiList: (cb) => {
    const listener = (_e, list) => cb(list);
    ipcRenderer.on('wifi-list', listener);
    return () => ipcRenderer.removeListener('wifi-list', listener);
  },
  onTaskDone: (cb) => {
    const listener = (_e) => cb();
    ipcRenderer.on('task-done', listener);
    return () => ipcRenderer.removeListener('task-done', listener);
  },
  onProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  },
  onTestProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('test-progress', listener);
    return () => ipcRenderer.removeListener('test-progress', listener);
  },
});
