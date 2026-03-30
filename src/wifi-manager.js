const { execSync, exec } = require('child_process');
const iconv = require('iconv-lite');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCAN_SCRIPT = path.join(__dirname, 'wlan-scan.ps1').replace('app.asar', 'app.asar.unpacked');

class WifiManager {
  constructor() {
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = 30000;
  }

  _decodeBuffer(buf) {
    const utf8 = buf.toString('utf8');
    const cp936 = iconv.decode(buf, 'cp936');
    const score = (text) => {
      const keywords = [
        'SSID', 'BSSID', 'State', 'Interface', 'Name',
        '状态', '接口', '名称', '已连接', '信号',
      ];
      let s = 0;
      for (const k of keywords) {
        if (text.includes(k)) s += 2;
      }
      // utf8 解码错误时通常会出现大量替换符，降低其得分
      const replacement = (text.match(/\uFFFD/g) || []).length;
      s -= replacement;
      return s;
    };
    return score(cp936) > score(utf8) ? cp936 : utf8;
  }

  _execNetsh(args) {
    const cmd = `netsh ${args}`;
    const buf = execSync(cmd, { encoding: 'buffer', windowsHide: true });
    return this._decodeBuffer(buf);
  }

  async _execNetshAsync(args) {
    const cmd = `netsh ${args}`;
    return new Promise((resolve, reject) => {
      exec(cmd, { encoding: 'buffer', windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const output = this._decodeBuffer(stdout || Buffer.alloc(0));
          const errOutput = this._decodeBuffer(stderr || Buffer.alloc(0));
          reject(new Error(`${cmd} failed: ${errOutput || output}`));
          return;
        }
        resolve(this._decodeBuffer(stdout));
      });
    });
  }

  triggerScan() {
    try {
      execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${SCAN_SCRIPT}"`,
        { windowsHide: true, timeout: 10000 }
      );
    } catch (_) {
      // fallback: even if WlanScan fails, netsh show networks will still return cached results
    }
  }

  async scan(forceRefresh = false) {
    if (!forceRefresh && this._cache && (Date.now() - this._cacheTime < this._cacheTTL)) {
      return this._cache;
    }

    this.triggerScan();
    await new Promise(r => setTimeout(r, 4000));

    const output = this._execNetsh('wlan show networks mode=bssid');
    const networks = this._parseNetworks(output);
    this._cache = networks;
    this._cacheTime = Date.now();
    return networks;
  }

  _parseNetworks(output) {
    const networks = [];
    const lines = output.split('\n');
    let current = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();

      const ssidMatch = line.match(/^SSID\s*\d*\s*:\s*(.+)$/i);
      if (ssidMatch) {
        if (current && current.ssid) {
          networks.push(current);
        }
        current = { ssid: ssidMatch[1].trim(), signal: '', auth: '', bssid: '' };
        continue;
      }

      if (!current) continue;

      if (/验证|认证|Authentication/i.test(line)) {
        current.auth = line.split(':').slice(1).join(':').trim();
        continue;
      }

      if (/信号|Signal/i.test(line)) {
        current.signal = line.split(':').slice(1).join(':').trim();
        continue;
      }

      const bssidMatch = line.match(/BSSID\s*\d*\s*:\s*(.+)/i);
      if (bssidMatch) {
        current.bssid = bssidMatch[1].trim();
        continue;
      }
    }

    if (current && current.ssid) {
      networks.push(current);
    }

    const seen = new Set();
    return networks.filter(n => {
      if (seen.has(n.ssid)) return false;
      seen.add(n.ssid);
      return true;
    });
  }

  async connect(ssid, password) {
    this._createProfile(ssid, password);
    try {
      await this._execNetshAsync(`wlan connect name="${ssid}" ssid="${ssid}"`);
    } catch (e) {
      throw new Error(`连接 WiFi "${ssid}" 失败: ${e.message}`);
    }
    // 部分机器无线网卡关联较慢，适当放宽等待时间
    await this._waitForConnection(ssid, 30000);
  }

  _createProfile(ssid, password) {
    const profileXml = `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${this._escapeXml(ssid)}</name>
  <SSIDConfig>
    <SSID>
      <name>${this._escapeXml(ssid)}</name>
    </SSID>
  </SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>auto</connectionMode>
  <MSM>
    <security>
      <authEncryption>
        <authentication>WPA2PSK</authentication>
        <encryption>AES</encryption>
        <useOneX>false</useOneX>
      </authEncryption>
      <sharedKey>
        <keyType>passPhrase</keyType>
        <protected>false</protected>
        <keyMaterial>${this._escapeXml(password)}</keyMaterial>
      </sharedKey>
    </security>
  </MSM>
</WLANProfile>`;

    const tmpFile = path.join(os.tmpdir(), `wifi_profile_${Date.now()}.xml`);
    fs.writeFileSync(tmpFile, profileXml, 'utf-8');

    try {
      this._execNetsh(`wlan add profile filename="${tmpFile}"`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }

  _escapeXml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  async _waitForConnection(ssid, timeoutMs) {
    const start = Date.now();
    const expected = this._normalizeSsid(ssid);
    while (Date.now() - start < timeoutMs) {
      const connected = this.getCurrentSSID();
      if (this._isSameSsid(connected, expected)) return;
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`连接 WiFi "${ssid}" 超时`);
  }

  /**
   * 将 netsh wlan show interfaces 按无线网卡接口分段（多网卡时不能只取第一个 SSID 行）。
   */
  _splitWlanInterfaceBlocks(output) {
    const lines = output.split(/\r?\n/);
    const blocks = [];
    let cur = [];
    const isIfaceHeader = (line) =>
      /^\s*Name\s*:/i.test(line) ||
      /^\s*名称\s*:/.test(line) ||
      /^\s*Interface name\s*:/i.test(line);

    for (const line of lines) {
      if (isIfaceHeader(line)) {
        if (cur.length) blocks.push(cur);
        cur = [line];
      } else {
        cur.push(line);
      }
    }
    if (cur.length) blocks.push(cur);
    return blocks;
  }

  _isWlanConnectedBlock(blockLines) {
    let hasBssid = false;
    for (const line of blockLines) {
      const t = line.trim();
      const m = t.match(/^(?:State|状态|接口状态)\s*:\s*(.+)$/i);
      if (m) {
        const v = m[1].trim().toLowerCase();
        if (
          v.includes('connected') ||
          v.includes('已连接') ||
          v.includes('已連線') ||
          v.includes('已連接')
        ) {
          return true;
        }
      }
      const bssid = t.match(/^BSSID\s*:\s*(.+)$/i);
      if (bssid && bssid[1].trim()) hasBssid = true;
    }
    // 某些系统语言/编码下 State 解析可能失效，BSSID 存在时也可认为已关联
    return hasBssid;
  }

  _readSsidFromBlock(blockLines) {
    for (const line of blockLines) {
      const t = line.trim();
      // 必须匹配行首的 SSID，避免误匹配 BSSID / AP BSSID 行中的子串
      const m = t.match(/^SSID(?:\s+\d+)?\s*:\s*(.*)$/i);
      if (!m) continue;
      const val = m[1].trim();
      return this._normalizeSsid(val) || null;
    }
    return null;
  }

  _normalizeSsid(ssid) {
    if (ssid == null) return null;
    let s = String(ssid).trim();
    if (!s) return null;
    // 去掉常见包裹引号、零宽字符，减少“看起来相同但比较失败”的情况
    s = s.replace(/^["']+|["']+$/g, '');
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
    return s.normalize('NFKC');
  }

  _isSameSsid(actual, expected) {
    const a = this._normalizeSsid(actual);
    const e = this._normalizeSsid(expected);
    if (!a || !e) return false;
    return a === e;
  }

  getCurrentSSID() {
    try {
      const output = this._execNetsh('wlan show interfaces');
      const blocks = this._splitWlanInterfaceBlocks(output);
      for (const blockLines of blocks) {
        if (!this._isWlanConnectedBlock(blockLines)) continue;
        const ssid = this._readSsidFromBlock(blockLines);
        if (ssid) return ssid;
      }
    } catch (_) {}
    return null;
  }

  /**
   * 连接命令返回后再次确认系统当前关联的 SSID（多网卡/漫游时更可靠）。
   */
  async verifyConnectedTo(expectedSsid, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 12000;
    const intervalMs = opts.intervalMs ?? 400;
    const start = Date.now();
    const expected = this._normalizeSsid(expectedSsid);
    let lastActual = null;
    while (Date.now() - start < timeoutMs) {
      lastActual = this.getCurrentSSID();
      if (this._isSameSsid(lastActual, expected)) {
        return { ok: true, actual: this._normalizeSsid(lastActual) };
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return { ok: false, actual: this._normalizeSsid(lastActual) };
  }

  async disconnect() {
    try {
      await this._execNetshAsync('wlan disconnect');
    } catch (_) {}
  }

  invalidateCache() {
    this._cache = null;
    this._cacheTime = 0;
  }

  async isConnected() {
    try {
      const output = this._execNetsh('wlan show interfaces');
      return output.includes('已连接') || output.toLowerCase().includes('connected');
    } catch (_) {
      return false;
    }
  }
}

module.exports = WifiManager;
