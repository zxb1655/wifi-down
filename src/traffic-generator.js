const https = require('https');
const http = require('http');
const { URL } = require('url');

const REQUEST_OPTIONS = {
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
};

function normalizeTestEntry(raw) {
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

function normalizeTestUrls(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeTestEntry).filter(Boolean);
}

/** 仅当 referer 有值时设置 Referer 头 */
function requestOptionsForUrl(url, referer, overrides = {}) {
  const headers = { ...REQUEST_OPTIONS.headers };
  if (referer) {
    headers.Referer = referer;
  }
  return { ...REQUEST_OPTIONS, ...overrides, headers };
}

// 提至 30s：主进程在几百个 AP 场景下偶尔会被 wifiManager.scan 的 execSync 阻塞十几秒，
// 若 stall 阈值过小，会把仅仅是"事件循环被扫描调用短暂卡住"误判成下载停滞。
const STALL_TIMEOUT = 30000;
const DOWNLOAD_TIMEOUT = 60000;
// 连续 N 毫秒没下载到任何字节，判定当前 WiFi 无可用网络，放弃本设备
const NO_NETWORK_TIMEOUT = 2 * 60 * 1000;

class TrafficGenerator {
  constructor(testUrls = null) {
    this._aborted = false;
    this._activeReq = null;
    this._activeRes = null;
    this._entries = normalizeTestUrls(testUrls);
  }

  abort() {
    this._aborted = true;
    if (this._activeRes) { try { this._activeRes.destroy(); } catch (_) {} }
    if (this._activeReq) { try { this._activeReq.destroy(); } catch (_) {} }
    this._activeReq = null;
    this._activeRes = null;
  }

  async generate(opts = {}) {
    this._aborted = false;
    let targetMB = opts.targetMB;
    if (targetMB == null || !Number.isFinite(Number(targetMB))) {
      targetMB = 100 + Math.random() * 100;
    }
    targetMB = Number(targetMB);
    const targetBytes = Math.floor(targetMB * 1024 * 1024);
    const onProgress = opts.onProgress || (() => {});

    let totalDownloaded = 0;

    const onDownloadUrl = typeof opts.onDownloadUrl === 'function' ? opts.onDownloadUrl : null;

    if (!this._entries.length) {
      throw new Error('未配置测速链接（config.json 中 testUrls 为空或无效）');
    }

    const noNetworkTimeoutMs = Number.isFinite(Number(opts.noNetworkTimeoutMs))
      ? Number(opts.noNetworkTimeoutMs)
      : NO_NETWORK_TIMEOUT;
    const startTime = Date.now();

    while (totalDownloaded < targetBytes && !this._aborted) {
      if (totalDownloaded === 0 && Date.now() - startTime >= noNetworkTimeoutMs) {
        throw new Error(`网络不可用（${Math.round(noNetworkTimeoutMs / 1000)} 秒内未下载到任何数据）`);
      }
      const entry = this._entries[Math.floor(Math.random() * this._entries.length)];
      try {
        await this._downloadOne(entry, targetBytes - totalDownloaded, (chunkBytes) => {
          totalDownloaded += chunkBytes;
          onProgress(totalDownloaded, targetBytes);
        }, onDownloadUrl);
      } catch (e) {
        if (this._aborted) break;
        if (totalDownloaded === 0 && Date.now() - startTime >= noNetworkTimeoutMs) {
          throw new Error(`网络不可用（${Math.round(noNetworkTimeoutMs / 1000)} 秒内未下载到任何数据）`);
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    return totalDownloaded;
  }

  _downloadOne(entry, remainingBytes, onChunk, onDownloadUrl) {
    const { url, referer } = normalizeTestEntry(entry);

    return new Promise((resolve, reject) => {
      if (this._aborted) { resolve(0); return; }

      if (onDownloadUrl) {
        try {
          onDownloadUrl(url);
        } catch (_) {}
      }

      let settled = false;
      const finish = (val) => { if (!settled) { settled = true; cleanup(); resolve(val); } };
      const fail = (err) => { if (!settled) { settled = true; cleanup(); reject(err); } };

      let stallTimer = null;
      let overallTimer = null;
      let downloaded = 0;

      const cleanup = () => {
        clearTimeout(stallTimer);
        clearTimeout(overallTimer);
        this._activeReq = null;
        this._activeRes = null;
      };

      const resetStallTimer = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (this._activeRes) this._activeRes.destroy();
          if (this._activeReq) this._activeReq.destroy();
          fail(new Error('数据传输停滞超时'));
        }, STALL_TIMEOUT);
      };

      overallTimer = setTimeout(() => {
        if (this._activeRes) this._activeRes.destroy();
        if (this._activeReq) this._activeReq.destroy();
        fail(new Error('单次下载总超时'));
      }, DOWNLOAD_TIMEOUT);

      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, requestOptionsForUrl(url, referer), (res) => {
        this._activeRes = res;

        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          cleanup();
          const loc = res.headers.location.trim();
          const nextUrl = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).href;
          this._downloadOne({ url: nextUrl, referer }, remainingBytes, onChunk, onDownloadUrl)
            .then(resolve).catch(reject);
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        resetStallTimer();

        res.on('data', (chunk) => {
          if (this._aborted) {
            res.destroy();
            return;
          }
          downloaded += chunk.length;
          onChunk(chunk.length);
          resetStallTimer();
          if (downloaded >= remainingBytes) {
            res.destroy();
          }
        });
        res.on('end', () => finish(downloaded));
        res.on('error', () => finish(downloaded));
        res.on('close', () => finish(downloaded));
      });

      this._activeReq = req;

      req.on('error', fail);
      req.on('timeout', () => {
        req.destroy();
        fail(new Error('连接超时'));
      });
    });
  }
}

/**
 * @param {string|{url:string, referer?:string|null}} entry
 */
TrafficGenerator.testUrl = function(entry, abortSignal) {
  const { url, referer } = normalizeTestEntry(entry) || { url: '', referer: null };

  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const startTime = Date.now();
    let settled = false;
    let req = null;

    const done = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(overallTimer);
        clearTimeout(stallTimer);
        if (abortSignal) abortSignal.removeListener('abort', onAbort);
        resolve(result);
      }
    };

    const onAbort = () => {
      if (req) req.destroy();
      done({ success: false, error: '已停止', url });
    };

    if (abortSignal) abortSignal.on('abort', onAbort);

    const overallTimer = setTimeout(() => {
      if (req) req.destroy();
      done({ success: false, error: '总超时 (20s)', url });
    }, 20000);

    let stallTimer = null;
    const resetStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (req) req.destroy();
        done({ success: false, error: '数据停滞超时', url });
      }, 10000);
    };

    req = client.get(url, requestOptionsForUrl(url, referer, { timeout: 10000 }), (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        clearTimeout(overallTimer);
        clearTimeout(stallTimer);
        if (abortSignal) abortSignal.removeListener('abort', onAbort);
        settled = true;
        const loc = res.headers.location.trim();
        const nextUrl = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).href;
        TrafficGenerator.testUrl({ url: nextUrl, referer }, abortSignal).then(resolve);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        done({ success: false, error: `HTTP ${res.statusCode}`, url });
        return;
      }

      let downloaded = 0;
      resetStall();

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        resetStall();
        if (downloaded >= 100 * 1024) {
          res.destroy();
        }
      });

      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        const speed = downloaded > 0 ? (downloaded / 1024 / (elapsed / 1000)).toFixed(1) : 0;
        done({
          success: downloaded > 0,
          downloaded: (downloaded / 1024).toFixed(1) + ' KB',
          speed: speed + ' KB/s',
          time: elapsed,
          url,
          error: downloaded === 0 ? 'No data received' : null
        });
      });

      res.on('error', (e) => done({ success: false, error: e.message, url }));
      res.on('close', () => {
        if (!settled) {
          const elapsed = Date.now() - startTime;
          const speed = downloaded > 0 ? (downloaded / 1024 / (elapsed / 1000)).toFixed(1) : 0;
          done({
            success: downloaded > 0,
            downloaded: (downloaded / 1024).toFixed(1) + ' KB',
            speed: speed + ' KB/s',
            time: elapsed,
            url,
            error: downloaded === 0 ? 'No data received' : null
          });
        }
      });
    });

    req.on('error', (e) => done({ success: false, error: e.message, url }));
    req.on('timeout', () => {
      req.destroy();
      done({ success: false, error: '连接超时', url });
    });
  });
};

TrafficGenerator.normalizeTestUrls = normalizeTestUrls;
TrafficGenerator.normalizeTestEntry = normalizeTestEntry;

module.exports = TrafficGenerator;
