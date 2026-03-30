const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const PER_ROUND_TIMEOUT_MS = 120000;

/** 未传 --url 时从项目根目录 config.json 读取 testUrls */
function loadEntriesFromConfig() {
  const configPath = path.join(__dirname, 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const j = JSON.parse(raw);
    if (!Array.isArray(j.testUrls)) return [];
    return j.testUrls.map(normalizeEntry).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function normalizeEntry(raw) {
  if (typeof raw === 'string') {
    return { url: raw, referer: null, name: null };
  }
  if (typeof raw !== 'object' || typeof raw.url !== 'string') return null;
  const referer =
    raw.referer != null && String(raw.referer).trim() !== '' ? String(raw.referer).trim() : null;
  const name =
    raw.name != null && String(raw.name).trim() !== '' ? String(raw.name).trim() : null;
  return {
    url: raw.url.trim(),
    referer,
    name,
  };
}

/**
 * @param {string} _url 保留参数，便于以后按 URL 扩展请求头
 * @param {string|null} [referer] 仅在有值时设置 Referer
 */
function buildRequestOptions(_url, referer) {
  const headers = { ...DEFAULT_HEADERS };
  if (referer) {
    headers.Referer = referer;
  }
  return {
    timeout: PER_ROUND_TIMEOUT_MS,
    headers,
  };
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(2) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function pickRandomEntry(entries) {
  if (!entries.length) return null;
  return entries[Math.floor(Math.random() * entries.length)];
}

function parseSizeBytes(str) {
  if (str == null || String(str).trim() === '') {
    return 100 * 1024;
  }
  const s = String(str).trim();
  if (/^--?h(elp)?$/i.test(s)) {
    return null;
  }
  const m = s.match(/^([\d.]+)\s*(B|KB|K|MB|M|GB|G|TB|T)?$/i);
  if (!m) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`无法解析大小: ${str}`);
    }
    return Math.floor(n);
  }
  const num = parseFloat(m[1]);
  const u = (m[2] || '').toUpperCase();
  if (!m[2]) {
    if (num <= 1024) return Math.floor(num * 1024 * 1024);
    return Math.floor(num);
  }
  const mult =
    u === 'B' ? 1
      : u === 'K' || u === 'KB' ? 1024
        : u === 'M' || u === 'MB' ? 1024 ** 2
          : u === 'G' || u === 'GB' ? 1024 ** 3
            : u === 'T' || u === 'TB' ? 1024 ** 4
              : 1024 ** 2;
  return Math.floor(num * mult);
}

/**
 * 解析命令行：
 *   node test-urls.js [大小] [--url URL [--referer REF]] ...
 * 「大小」为唯一位置参数，可与 --url 任意顺序（如: test-urls.js 10M -u ... 或 test-urls.js -u ... 10M）
 */
function parseCli(argv) {
  const entries = [];
  const positional = [];
  let i = 0;

  while (i < argv.length) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      return { help: true };
    }
    if (a === '--url' || a === '-u') {
      const u = argv[++i];
      if (!u) throw new Error('--url 需要 URL');
      entries.push({ url: u, referer: null });
      i++;
      continue;
    }
    if (a === '--referer' || a === '-r') {
      const r = argv[++i];
      if (!r) throw new Error('--referer 需要 URL');
      if (entries.length === 0) {
        throw new Error('--referer 必须写在某个 --url 之后');
      }
      entries[entries.length - 1].referer = r;
      i++;
      continue;
    }
    if (a.startsWith('-')) {
      throw new Error(`未知参数: ${a}`);
    }
    positional.push(a);
    i++;
  }

  if (positional.length > 1) {
    throw new Error(`只能有一个「大小」位置参数，多余: ${positional.slice(1).join(', ')}`);
  }

  return { size: positional[0], entries };
}

function printHelp() {
  console.log(`用法:
  node test-urls.js [大小] [选项]

大小（可选，默认约 100KB）:
  30M / 30MB / 100KB / 1G 等

选项:
  --url, -u <url>       下载地址，可重复写多个
  --referer, -r <url>   紧跟在前一个 --url 之后，作为该地址的 Referer

示例:
  node test-urls.js 10M \\
    --url "https://dl.hdslb.com/.../bili_win-install.exe" \\
    --referer "https://www.bilibili.com/"

  node test-urls.js 5M -u "https://a.com/f.exe" -r "https://a.com/" -u "https://b.com/g.bin"

未传 --url 时使用项目 config.json 中的 testUrls；每轮随机选一条，未下满则继续。
`);
}

/**
 * @param {{ url: string, referer: string|null }} entry
 */
function downloadOneRound(entry, maxBytes) {
  const { url, referer } = normalizeEntry(entry);

  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    let settled = false;

    const finish = (n) => {
      if (settled) return;
      settled = true;
      resolve(n);
    };

    const req = client.get(url, buildRequestOptions(url, referer), (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const loc = res.headers.location.trim();
        const nextUrl = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).href;
        downloadOneRound({ url: nextUrl, referer }, maxBytes).then(finish).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        finish(0);
        return;
      }

      let received = 0;

      const complete = () => {
        finish(Math.min(received, maxBytes));
      };

      res.on('data', (chunk) => {
        received += chunk.length;
        if (received >= maxBytes) {
          res.destroy();
        }
      });

      res.on('end', complete);
      res.on('close', () => {
        if (!settled) complete();
      });
      res.on('error', () => finish(Math.min(received, maxBytes)));
    });

    req.on('error', () => finish(0));
    req.on('timeout', () => {
      req.destroy();
      finish(0);
    });
  });
}

async function downloadToTarget(entries, targetBytes) {
  const list = entries.map(normalizeEntry);
  if (!list.length) {
    return {
      success: false,
      error: '没有可用的下载链接',
      targetBytes,
      downloadedBytes: 0,
      rounds: 0,
    };
  }

  const startTime = Date.now();
  let total = 0;
  let rounds = 0;
  const usedUrls = [];

  while (total < targetBytes) {
    const need = targetBytes - total;
    const entry = pickRandomEntry(list);
    const got = await downloadOneRound(entry, need);
    rounds += 1;
    usedUrls.push({
      url: entry.url,
      referer: entry.referer,
      got,
    });

    if (got <= 0) {
      return {
        success: total > 0,
        targetBytes,
        downloadedBytes: total,
        downloaded: formatBytes(total),
        rounds,
        usedUrls,
        seconds: ((Date.now() - startTime) / 1000).toFixed(2),
        error:
          total === 0
            ? '无数据或连接失败'
            : `仅下载 ${formatBytes(total)}，后续轮次无数据`,
      };
    }
    total += got;
  }

  const elapsedSec = (Date.now() - startTime) / 1000;
  const speedKBs = total > 0 && elapsedSec > 0 ? total / 1024 / elapsedSec : 0;

  return {
    success: true,
    targetBytes,
    downloadedBytes: total,
    downloaded: formatBytes(total),
    rounds,
    usedUrls,
    speed:
      speedKBs > 1024
        ? (speedKBs / 1024).toFixed(2) + ' MB/s'
        : speedKBs.toFixed(1) + ' KB/s',
    seconds: elapsedSec.toFixed(2),
    error: null,
  };
}

async function main() {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    printHelp();
    return;
  }

  let targetBytes;
  try {
    targetBytes = parseSizeBytes(parsed.size);
  } catch (e) {
    console.error(e.message);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (targetBytes === null) {
    printHelp();
    return;
  }

  const cliEntries = parsed.entries.map(normalizeEntry);
  const entries =
    cliEntries.length > 0
      ? cliEntries
      : loadEntriesFromConfig();

  if (entries.length === 0) {
    console.error('没有可用链接：请在项目 config.json 中配置 testUrls，或使用 --url / -u');
    printHelp();
    process.exitCode = 1;
    return;
  }

  console.log(
    `开始测试下载，目标: ${formatBytes(targetBytes)} (${targetBytes} 字节)，候选 ${entries.length} 条（每轮随机）\n`,
  );
  entries.forEach((e, idx) => {
    const title = e.name ? `${e.name} - ${e.url}` : e.url;
    const ref = e.referer ? `Referer: ${e.referer}` : 'Referer: (无)';
    console.log(`  [${idx + 1}] ${title}`);
    console.log(`       ${ref}`);
  });
  console.log('');

  const result = await downloadToTarget(entries, targetBytes);
  console.log(result);

  if (result.success) {
    console.log(
      `  结果: ✓ 完成 - 实际 ${result.downloaded}, ${result.rounds} 轮, 耗时 ${result.seconds}s, 约 ${result.speed}`,
    );
  } else {
    console.log(`  结果: ✗ 失败 - ${result.error}`);
  }
}

main().catch(console.error);
