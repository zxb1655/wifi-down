const fetch = require('node-fetch');
const FormData = require('form-data');

function truncateForLog(str, max = 6000) {
  const s = typeof str === 'string' ? str : JSON.stringify(str);
  if (s.length <= max) return s;
  return s.slice(0, max) + '…(已截断)';
}

class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl?.replace(/\/+$/, '') || '';
    this._log = null;
  }

  setLogger(fn) {
    this._log = typeof fn === 'function' ? fn : null;
  }

  _line(msg) {
    if (this._log) this._log(msg);
  }

  setBaseUrl(url) {
    this.baseUrl = url?.replace(/\/+$/, '') || '';
  }

  async fetchDevices(key) {
    if (!this.baseUrl) throw new Error('未配置 API 地址');
    const k = key != null ? String(key).trim() : '';
    const qs = k ? `?key=${encodeURIComponent(k)}` : '';
    const url = `${this.baseUrl}/bms-sim/check/device/findSpeedDevice${qs}`;
    this._line(`[API] GET findSpeedDevice 请求 URL: ${url}`);
    const res = await fetch(url, { timeout: 15000 });
    const text = await res.text();
    this._line(`[API] findSpeedDevice 响应 HTTP ${res.status} body: ${truncateForLog(text)}`);
    if (!res.ok) throw new Error(`获取设备列表失败: HTTP ${res.status}`);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('获取设备列表失败: 响应不是合法 JSON');
    }
    return Array.isArray(data) ? data : (data.data || data.result || []);
  }

  async uploadRecord(record) {
    if (!this.baseUrl) throw new Error('未配置 API 地址');
    const url = `${this.baseUrl}/bms-sim/check/device/speed/record/uploadSpeedRecord`;

    const form = new FormData();
    form.append('sn', record.sn || '');
    form.append('wifiName', record.wifiName || '');
    form.append('wifiPassword', record.wifiPassword || '');
    form.append('useFlow', String(record.useFlow || 0));
    form.append('status', String(record.status));
    form.append('speedStartTime', record.speedStartTime || '');
    form.append('speedEndTime', record.speedEndTime || '');
    form.append('remark', record.remark != null ? String(record.remark) : '');

    const safeParams = {
      sn: record.sn,
      wifiName: record.wifiName,
      wifiPassword: record.wifiPassword ? '***' : '',
      useFlow: record.useFlow,
      status: record.status,
      speedStartTime: record.speedStartTime,
      speedEndTime: record.speedEndTime,
      remark: record.remark || '',
    };
    this._line(`[API] POST uploadSpeedRecord 请求 URL: ${url}`);
    this._line(`[API] POST uploadSpeedRecord 表单参数: ${JSON.stringify(safeParams)}`);

    const res = await fetch(url, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      timeout: 15000,
    });

    const text = await res.text();
    this._line(`[API] uploadSpeedRecord 响应 HTTP ${res.status} body: ${truncateForLog(text || '(空)')}`);
    if (!res.ok) throw new Error(`上报失败: HTTP ${res.status}`);
    if (!text || !text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
}

module.exports = ApiClient;
