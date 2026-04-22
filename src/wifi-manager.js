const { execSync, exec, execFileSync } = require('child_process');
const iconv = require('iconv-lite');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCAN_SCRIPT = path.join(__dirname, 'wlan-scan.ps1').replace('app.asar', 'app.asar.unpacked');

/** 与连接校验、扫描匹配共用的 SSID 规范化（主进程排序/查表请用此类） */
function normalizeSsid(ssid) {
  if (ssid == null) return null;
  let s = String(ssid).trim();
  if (!s) return null;
  s = s.replace(/^["']+|["']+$/g, '');
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  return s.normalize('NFKC');
}

class WifiManager {
  /**
   * @param {{ debugLog?: (msg: string) => void }} [opts] debugLog 会收到带上下文的多行说明，便于排查连接失败
   */
  constructor(opts = {}) {
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = 30000;
    this._debugLog = typeof opts.debugLog === 'function' ? opts.debugLog : null;
  }

  /** 限长，避免异常信息过长撑爆日志文件 */
  _wifiDebug(msg, maxLen = 2000) {
    if (!this._debugLog) return;
    let s = String(msg == null ? '' : msg).replace(/\r\n/g, '\n').trim();
    if (s.length > maxLen) s = `${s.slice(0, maxLen)}…(已截断, 共 ${String(msg).length} 字符)`;
    this._debugLog(`[WiFi] ${s}`);
  }

  /** 全部尝试仍失败时输出，便于对照网卡能力 */
  _getWlanDriversSummary() {
    try {
      const out = this._execNetsh('wlan show drivers');
      return out.trim();
    } catch (e) {
      return `（无法执行 netsh wlan show drivers: ${e.message || e}）`;
    }
  }

  _getRecentWlanEventSummary(ssid, since = null, maxEvents = 4) {
    try {
      const target = String(ssid || '').trim();
      if (!target) return '';
      const buf = execFileSync('wevtutil', ['qe', 'Microsoft-Windows-WLAN-AutoConfig/Operational', '/c:40', '/rd:true', '/f:text'], {
        encoding: 'buffer',
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 1024 * 1024,
      });
      const text = this._decodeBuffer(buf);
      const blocks = text
        .split(/\r?\n(?=Event\[\d+\])/)
        .map((b) => b.trim())
        .filter(Boolean);
      const rows = [];
      for (const block of blocks) {
        if (!block.includes(target)) continue;
        const dateMatch = block.match(/^\s*Date:\s*(.+)$/m);
        const idMatch = block.match(/^\s*Event ID:\s*(\d+)/m);
        const descMatch = block.match(/Description:\s*([\s\S]*)$/m);
        if (!dateMatch || !idMatch || !descMatch) continue;
        const date = new Date(dateMatch[1].trim());
        if (since instanceof Date && !Number.isNaN(since.getTime()) && date < since) continue;
        const desc = descMatch[1]
          .replace(/\u0000/g, '')
          .replace(/\r?\n+/g, ' | ')
          .replace(/\s+\|\s+/g, ' | ')
          .trim();
        rows.push(`[${date.toLocaleTimeString()}][Event ${idMatch[1]}] ${desc}`);
        if (rows.length >= Math.max(1, Math.min(8, maxEvents))) break;
      }
      return rows.join('\n');
    } catch (_) {
      return '';
    }
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
    try {
      const buf = execSync(cmd, { encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      return this._decodeBuffer(buf);
    } catch (err) {
      const dec = (b) => {
        if (!b) return '';
        const buf = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
        return this._decodeBuffer(buf).trim();
      };
      const stderr = dec(err.stderr);
      const stdout = dec(err.stdout);
      const tail = stderr || stdout || (err.message && String(err.message).replace(/^Command failed:\s*/i, '').trim());
      throw new Error(tail ? `${cmd}\n${tail}` : `${cmd} 失败`);
    }
  }

  async _execNetshAsync(args) {
    const cmd = `netsh ${args}`;
    return new Promise((resolve, reject) => {
      exec(cmd, { encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const output = this._decodeBuffer(stdout || Buffer.alloc(0)).trim();
          const errOutput = this._decodeBuffer(stderr || Buffer.alloc(0)).trim();
          const tail = errOutput || output;
          reject(new Error(tail ? `${cmd}\n${tail}` : `${cmd} failed`));
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

      if (/加密|Encryption/i.test(line)) {
        current.encryption = line.split(':').slice(1).join(':').trim();
        continue;
      }

      if (/信号|Signal/i.test(line)) {
        current.signal = line.split(':').slice(1).join(':').trim();
        continue;
      }

      if (/无线电类型|Radio type/i.test(line)) {
        current.radio = line.split(':').slice(1).join(':').trim();
        continue;
      }

      if (/频段|Band/i.test(line)) {
        current.band = line.split(':').slice(1).join(':').trim();
        continue;
      }

      if (/信道|Channel/i.test(line)) {
        current.channel = line.split(':').slice(1).join(':').trim();
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

  /**
   * netsh 非 0 退出会抛错；删除不存在的配置等场景需忽略。
   */
  _tryExecNetsh(args) {
    try {
      return this._execNetsh(args);
    } catch (_) {
      return null;
    }
  }

  /**
   * 从 `netsh wlan show interfaces` 取第一个无线接口名（多网卡时用于 connect/delete）。
   */
  _getPrimaryWlanInterfaceName() {
    try {
      const output = this._execNetsh('wlan show interfaces');
      const m =
        output.match(/^\s*Name\s*:\s*(.+)\s*$/im) ||
        output.match(/^\s*名称\s*:\s*(.+)\s*$/im) ||
        output.match(/Interface name\s*:\s*(.+)/i);
      return m ? m[1].trim() : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * 删除同名配置文件，避免旧加密方式（如仅 WPA2）与新路由器（WPA3）冲突导致
   * 「配置文件指定的网络无法用于连接」。
   */
  _deleteWlanProfile(ssid) {
    const iface = this._getPrimaryWlanInterfaceName();
    this._tryExecNetsh(`wlan delete profile name="${ssid}"`);
    if (iface) {
      this._tryExecNetsh(`wlan delete profile name="${ssid}" interface="${iface}"`);
    }
  }

  _normalizeScanAuthentication(auth) {
    const s = String(auth || '').trim().toLowerCase();
    if (!s) return null;
    if (s.includes('owe')) return 'OWE';
    if (
      s.includes('wpa3') &&
      (s.includes('personal') || s.includes('个人') || s.includes('sae'))
    ) {
      return 'WPA3SAE';
    }
    if (
      s.includes('wpa2') &&
      (s.includes('personal') || s.includes('个人') || s.includes('psk'))
    ) {
      return 'WPA2PSK';
    }
    if (
      !s.includes('wpa2') &&
      !s.includes('wpa3') &&
      s.includes('wpa') &&
      (s.includes('personal') || s.includes('个人') || s.includes('psk'))
    ) {
      return 'WPAPSK';
    }
    if (s.includes('enterprise') || s.includes('企业') || s.includes('802.1x')) {
      return 'ENTERPRISE';
    }
    if (s.includes('open') || s.includes('开放')) {
      return 'open';
    }
    return null;
  }

  _normalizeScanEncryption(encryption) {
    const s = String(encryption || '').trim().toLowerCase();
    if (!s) return null;
    if (s.includes('gcmp-256') || s.includes('gcmp256')) return 'GCMP256';
    if (s.includes('ccmp') || s.includes('aes')) return 'AES';
    if (s.includes('tkip')) return 'TKIP';
    if (s.includes('wep')) return 'WEP';
    if (s.includes('none') || s === '无') return 'none';
    return null;
  }

  _describeNetworkInfo(networkInfo) {
    if (!networkInfo) return '';
    const parts = [];
    if (networkInfo.auth) parts.push(`认证=${networkInfo.auth}`);
    if (networkInfo.encryption) parts.push(`加密=${networkInfo.encryption}`);
    if (networkInfo.band) parts.push(`频段=${networkInfo.band}`);
    if (networkInfo.channel) parts.push(`信道=${networkInfo.channel}`);
    if (networkInfo.radio) parts.push(`无线电=${networkInfo.radio}`);
    return parts.join(' | ');
  }

  _getCachedNetworkInfo(ssid) {
    const key = this._normalizeSsid(ssid);
    if (!key || !Array.isArray(this._cache)) return null;
    return this._cache.find((n) => this._isSameSsid(n.ssid, key)) || null;
  }

  _ssidToHex(ssid) {
    return Buffer.from(String(ssid || ''), 'utf8').toString('hex').toUpperCase();
  }

  _buildAuthAttempts(ssid, password, networkInfo) {
    const pwd = password != null ? String(password) : '';
    const authHint = this._normalizeScanAuthentication(networkInfo?.auth);
    const encryptionHint = this._normalizeScanEncryption(networkInfo?.encryption);
    const exactEncryption =
      encryptionHint === 'AES' || encryptionHint === 'TKIP' || encryptionHint === 'none'
        ? encryptionHint
        : null;
    const attempts = [];
    const seen = new Set();
    const add = (attempt) => {
      const full = {
        profileNs: 'v1',
        connectionMode: 'auto',
        transitionMode: null,
        useSharedKey: true,
        profileUser: 'all',
        ...attempt,
      };
      const key = [
        full.authentication,
        full.encryption,
        full.connectionMode,
        full.transitionMode == null ? '' : String(full.transitionMode),
        full.useSharedKey ? 'key' : 'nokey',
        full.profileUser,
      ].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      attempts.push(full);
    };
    const addCommonScopeFallback = (base) => {
      add({ ...base, profileUser: 'all' });
      add({ ...base, profileUser: 'current' });
    };

    if (authHint === 'ENTERPRISE') {
      const authText = networkInfo?.auth || '企业认证';
      throw new Error(
        `目标网络 "${ssid}" 扫描结果为 ${authText}，当前工具仅支持个人热点、开放网络和 OWE，不支持企业认证。`
      );
    }

    if (authHint === 'open') {
      addCommonScopeFallback({
        authentication: 'open',
        encryption: 'none',
        profileVersion: 'open',
        label: '开放网络',
        useSharedKey: false,
      });
      return { attempts, authHint, encryptionHint };
    }

    if (authHint === 'OWE') {
      addCommonScopeFallback({
        authentication: 'OWE',
        encryption: exactEncryption || 'AES',
        profileVersion: 'owe',
        label: 'OWE',
        useSharedKey: false,
      });
      addCommonScopeFallback({
        authentication: 'open',
        encryption: 'none',
        profileVersion: 'open-fallback',
        label: '开放网络(兼容回退)',
        useSharedKey: false,
      });
      return { attempts, authHint, encryptionHint };
    }

    if (!pwd) {
      if (authHint === 'WPA3SAE' || authHint === 'WPA2PSK' || authHint === 'WPAPSK') {
        throw new Error(
          `目标网络 "${ssid}" 扫描结果为 ${networkInfo?.auth || authHint}，但当前未提供密码。请先检查后台返回的 WiFi 密码是否为空。`
        );
      }
      addCommonScopeFallback({
        authentication: 'open',
        encryption: 'none',
        profileVersion: 'open',
        label: '开放网络',
        useSharedKey: false,
      });
      addCommonScopeFallback({
        authentication: 'OWE',
        encryption: 'AES',
        profileVersion: 'owe',
        label: 'OWE',
        useSharedKey: false,
      });
      return { attempts, authHint, encryptionHint };
    }

    if (authHint === 'WPA3SAE') {
      addCommonScopeFallback({
        authentication: 'WPA3SAE',
        encryption: exactEncryption || 'AES',
        profileVersion: 'wpa3-pure',
        label: 'WPA3-SAE/AES',
        transitionMode: false,
      });
      addCommonScopeFallback({
        authentication: 'WPA3SAE',
        encryption: exactEncryption || 'AES',
        profileVersion: 'wpa3-transition',
        label: 'WPA3-SAE/AES(过渡)',
        transitionMode: true,
      });
      addCommonScopeFallback({
        authentication: 'WPA2PSK',
        encryption: 'AES',
        profileVersion: 'wpa2-fallback',
        label: 'WPA2-PSK/AES(兼容回退)',
      });
      return { attempts, authHint, encryptionHint };
    }

    if (authHint === 'WPA2PSK') {
      const order = exactEncryption === 'TKIP' ? ['TKIP', 'AES'] : ['AES', 'TKIP'];
      for (const encryption of order) {
        addCommonScopeFallback({
          authentication: 'WPA2PSK',
          encryption,
          profileVersion: `wpa2-${encryption.toLowerCase()}`,
          label: `WPA2-PSK/${encryption}`,
        });
      }
      addCommonScopeFallback({
        authentication: 'WPA2PSK',
        encryption: order[0],
        profileVersion: `wpa2-${order[0].toLowerCase()}-manual`,
        label: `WPA2-PSK/${order[0]}(手动连接)`,
        connectionMode: 'manual',
      });
      addCommonScopeFallback({
        authentication: 'WPA3SAE',
        encryption: 'AES',
        profileVersion: 'wpa3-transition-fallback',
        label: 'WPA3-SAE/AES(兼容回退)',
        transitionMode: true,
      });
      return { attempts, authHint, encryptionHint };
    }

    if (authHint === 'WPAPSK') {
      const order = exactEncryption === 'AES' ? ['AES', 'TKIP'] : ['TKIP', 'AES'];
      for (const encryption of order) {
        addCommonScopeFallback({
          authentication: 'WPAPSK',
          encryption,
          profileVersion: `wpa-${encryption.toLowerCase()}`,
          label: `WPA-PSK/${encryption}`,
        });
      }
      addCommonScopeFallback({
        authentication: 'WPA2PSK',
        encryption: 'AES',
        profileVersion: 'wpa2-fallback',
        label: 'WPA2-PSK/AES(兼容回退)',
      });
      return { attempts, authHint, encryptionHint };
    }

    addCommonScopeFallback({
      authentication: 'WPA2PSK',
      encryption: 'AES',
      profileVersion: 'wpa2-aes',
      label: 'WPA2-PSK/AES',
    });
    addCommonScopeFallback({
      authentication: 'WPA2PSK',
      encryption: 'AES',
      profileVersion: 'wpa2-aes-manual',
      label: 'WPA2-PSK/AES(手动连接)',
      connectionMode: 'manual',
    });
    addCommonScopeFallback({
      authentication: 'WPA3SAE',
      encryption: 'AES',
      profileVersion: 'wpa3-pure',
      label: 'WPA3-SAE/AES',
      transitionMode: false,
    });
    addCommonScopeFallback({
      authentication: 'WPA3SAE',
      encryption: 'AES',
      profileVersion: 'wpa3-transition',
      label: 'WPA3-SAE/AES(过渡)',
      transitionMode: true,
    });
    addCommonScopeFallback({
      authentication: 'WPA2PSK',
      encryption: 'TKIP',
      profileVersion: 'wpa2-tkip',
      label: 'WPA2-PSK/TKIP',
    });
    addCommonScopeFallback({
      authentication: 'WPAPSK',
      encryption: 'AES',
      profileVersion: 'wpa-aes',
      label: 'WPA-PSK/AES',
    });
    addCommonScopeFallback({
      authentication: 'WPAPSK',
      encryption: 'TKIP',
      profileVersion: 'wpa-tkip',
      label: 'WPA-PSK/TKIP',
    });
    return { attempts, authHint, encryptionHint };
  }

  /**
   * WPA3-SAE：按微软示例根节点使用 profile v1，并在 authEncryption 内嵌 v4 的 transitionMode；
   * 整份 profile 使用 v4 根命名空间时，部分系统上 netsh add profile 会直接失败。
   * @param {'WPA2PSK'|'WPA3SAE'|'WPAPSK'} authentication
   * @param {'AES'|'TKIP'} encryption
   * @param {'v1'|'wpa3-ms'} profileVersion 仍为调用方版本标记（wpa3-ms = 微软 WPA3 过渡用 XML）
   * @param {'v1'|'v2'} profileNs WLANProfile 根命名空间；部分旧网卡/驱动仅 v2 配置文件可正常匹配身份验证
   * @param {'auto'|'manual'} connectionMode 少数环境 manual 可避免「功能匹配失败(未找到身份验证)」
   * @param {string|null} iface 连接阶段使用；add profile 优先不按接口安装（避免接口名与 add 子命令不匹配）
   */
  _addWlanProfile(
    ssid,
    password,
    authentication,
    encryption,
    profileVersion,
    iface,
    profileNs = 'v1',
    connectionMode = 'auto',
    opts = {},
  ) {
    const {
      transitionMode = null,
      useSharedKey = true,
      useOneX = false,
      profileUser = 'all',
    } = opts;
    const wlanProfileNs =
      profileNs === 'v2'
        ? 'http://www.microsoft.com/networking/WLAN/profile/v2'
        : 'http://www.microsoft.com/networking/WLAN/profile/v1';
    if (useSharedKey && !String(password || '')) {
      throw new Error(`连接 WiFi "${ssid}" 失败: 当前认证方式 ${authentication}/${encryption} 需要密码，但未提供密码。`);
    }
    let authEncryptionInner =
      `        <authentication>${authentication}</authentication>\n` +
      `        <encryption>${encryption}</encryption>\n` +
      `        <useOneX>${useOneX ? 'true' : 'false'}</useOneX>`;
    if (transitionMode != null) {
      authEncryptionInner +=
        `\n        <transitionMode xmlns="http://www.microsoft.com/networking/WLAN/profile/v4">` +
        `${transitionMode ? 'true' : 'false'}</transitionMode>`;
    }
    const sharedKeyXml = useSharedKey
      ? `\n      <sharedKey>
        <keyType>passPhrase</keyType>
        <protected>false</protected>
        <keyMaterial>${this._escapeXml(password)}</keyMaterial>
      </sharedKey>`
      : '';
    const profileXml = `<?xml version="1.0"?>
<WLANProfile xmlns="${wlanProfileNs}">
  <name>${this._escapeXml(ssid)}</name>
  <SSIDConfig>
    <SSID>
      <hex>${this._ssidToHex(ssid)}</hex>
      <name>${this._escapeXml(ssid)}</name>
    </SSID>
  </SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>${connectionMode}</connectionMode>
  <MSM>
    <security>
      <authEncryption>
${authEncryptionInner}
      </authEncryption>
${sharedKeyXml}
    </security>
  </MSM>
</WLANProfile>`;

    const tmpFile = path.join(
      os.tmpdir(),
      `wifi_profile_${Date.now()}_${authentication}_${encryption}_${profileNs}_${connectionMode}_${profileVersion}.xml`
    );
    // 带 BOM 的 UTF-8，避免部分中文系统下 netsh 读入后密钥异常
    fs.writeFileSync(tmpFile, '\uFEFF' + profileXml, 'utf-8');
    let pathForNetsh = tmpFile;
    try {
      pathForNetsh = fs.realpathSync.native ? fs.realpathSync.native(tmpFile) : fs.realpathSync(tmpFile);
    } catch (_) {}

    const tryAdd = (args) => {
      this._execNetsh(args);
    };

    const addCommands = [
      `wlan add profile filename="${pathForNetsh}" user=${profileUser}`,
      iface ? `wlan add profile filename="${pathForNetsh}" user=${profileUser} interface="${iface}"` : null,
    ].filter(Boolean);

    try {
      let lastErr = null;
      for (const args of addCommands) {
        try {
          tryAdd(args);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (lastErr) {
        throw lastErr;
      }
    } catch (e1) {
      const otherUser = profileUser === 'all' ? 'current' : 'all';
      try {
        tryAdd(`wlan add profile filename="${pathForNetsh}" user=${otherUser}`);
      } catch (e2) {
        if (!iface) {
          throw new Error(`${e1.message}\n（切换到 user=${otherUser} 后）${e2.message}`);
        }
        try {
          tryAdd(`wlan add profile filename="${pathForNetsh}" user=${otherUser} interface="${iface}"`);
        } catch (e3) {
          throw new Error(`${e1.message}\n（切换到 user=${otherUser} 后）${e2.message}\n（重试指定接口后）${e3.message}`);
        }
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }

  async connect(ssid, password, opts = {}) {
    const pwd = password != null ? String(password) : '';
    const networkInfo = opts.networkInfo || this._getCachedNetworkInfo(ssid);
    const networkInfoText = this._describeNetworkInfo(networkInfo);
    const passwordHints = [];
    if (pwd && pwd !== pwd.trim()) {
      passwordHints.push('密码首尾含空格');
    }
    if (/[^\x20-\x7E]/.test(pwd)) {
      passwordHints.push('密码含非 ASCII 字符');
    }
    const iface = this._getPrimaryWlanInterfaceName();
    const { attempts: authAttempts, authHint, encryptionHint } = this._buildAuthAttempts(ssid, pwd, networkInfo);
    this._wifiDebug(
      `开始连接 SSID「${ssid}」\n` +
        `  主无线接口: ${iface ?? '（未解析到，connect 将不带 interface 参数）'}\n` +
        `  密码长度: ${pwd.length}（内容不记录）\n` +
        `  扫描结果: ${networkInfoText || '当前未提供认证/加密信息，将进入兼容模式'}\n` +
        `  推断认证: ${authHint || '未知'} | 推断加密: ${encryptionHint || '未知'}\n` +
        `${passwordHints.length ? `  密码提示: ${passwordHints.join('；')}\n` : ''}` +
        '  已清理同名无线配置文件（若存在），随后按多种认证组合依次尝试。',
    );
    this._deleteWlanProfile(ssid);

    let lastErr = null;
    const total = authAttempts.length;
    for (let i = 0; i < authAttempts.length; i++) {
      const {
        authentication,
        encryption,
        profileVersion,
        label,
        profileNs = 'v1',
        connectionMode = 'auto',
        transitionMode = null,
        useSharedKey = true,
        profileUser = 'all',
      } = authAttempts[i];
      const attemptStartedAt = new Date();
      try {
        if (i > 0) {
          this._deleteWlanProfile(ssid);
        }
        this._wifiDebug(
          `连接尝试 ${i + 1}/${total}: ${label}\n` +
            `  XML: profileNs=${profileNs} | connectionMode=${connectionMode} | authentication=${authentication} | encryption=${encryption} | transitionMode=${transitionMode == null ? 'auto' : transitionMode} | sharedKey=${useSharedKey ? 'yes' : 'no'} | user=${profileUser} | mark=${profileVersion}`,
        );
        this._addWlanProfile(
          ssid,
          pwd,
          authentication,
          encryption,
          profileVersion,
          iface,
          profileNs,
          connectionMode,
          { transitionMode, useSharedKey, profileUser },
        );
        this._wifiDebug(`已添加配置文件「${ssid}」（本步 netsh 返回成功；user=${profileUser}）`);
        const connectArgs = iface
          ? `wlan connect name="${ssid}" ssid="${ssid}" interface="${iface}"`
          : `wlan connect name="${ssid}" ssid="${ssid}"`;
        this._wifiDebug(`执行: netsh ${connectArgs}`);
        await this._execNetshAsync(connectArgs);
        this._wifiDebug('netsh connect 已返回，正在等待系统关联 SSID（最多约 30s）…');
        await this._waitForConnection(ssid, 30000);
        this._wifiDebug(`关联成功（第 ${i + 1}/${total} 次方案: ${label}）`);
        return;
      } catch (e) {
        lastErr = e;
        const wlanEventSummary = this._getRecentWlanEventSummary(ssid, attemptStartedAt, 3);
        this._wifiDebug(
          `尝试 ${i + 1}/${total} 失败（${label}）:\n${e && e.message ? e.message : String(e)}` +
          `${wlanEventSummary ? `\n最近 WLAN 事件:\n${wlanEventSummary}` : ''}`
        );
        try {
          await this.disconnect();
          await new Promise(r => setTimeout(r, 800));
        } catch (_) {}
      }
    }

    const driverBlob = this._getWlanDriversSummary();
    this._wifiDebug(
      '全部认证组合均未成功。以下为 `netsh wlan show drivers` 输出（用于核对网卡支持的无线电类型/认证）：\n' +
        driverBlob,
      8000,
    );
    this._wifiDebug(
      '可自行在管理员 CMD 补充执行: netsh wlan show interfaces | netsh wlan show networks mode=bssid\n' +
        '（查看当前接口状态、以及目标 SSID 的「身份验证/加密」是否与尝试方案一致。）',
    );
    const attemptSummary = [...new Set(authAttempts.map((a) => a.label))].join('、');

    throw new Error(
      `连接 WiFi "${ssid}" 失败（已尝试 ${attemptSummary}）: ${lastErr ? lastErr.message : '未知错误'}`
    );
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
    const cur = this.getCurrentSSID();
    throw new Error(
      `连接 WiFi "${ssid}" 超时（${timeoutMs}ms 内未关联；当前系统 SSID=${cur ?? '无'}）`,
    );
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
    return normalizeSsid(ssid);
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
WifiManager.normalizeSsid = normalizeSsid;
