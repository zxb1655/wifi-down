/**
 * 一次性/工具：将 logs/*-统计.md 中的「汇总」「明细」「WiFi 重试」表导出为 .xlsx
 * 用法: node scripts/export-md-stats-xlsx.js [统计.md路径] [输出.xlsx路径]
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function parsePipeTableFrom(md, anchorLine) {
  const idx = md.indexOf(anchorLine);
  if (idx < 0) return [];
  const sub = md.slice(idx).split('\n');
  const rows = [];
  for (const line of sub) {
    const t = line.trim();
    if (t.startsWith('##')) break;
    if (!t) continue;
    if (!line.trimStart().startsWith('|')) break;
    if (/^\|\s*-{3,}/.test(line.trim())) continue;
    const parts = line.split('|');
    const cells = parts.slice(1, -1).map((s) => s.trim());
    rows.push(cells);
  }
  return rows;
}

function main() {
  const root = path.join(__dirname, '..');
  const defaultMd = path.join(root, 'logs', '2026-04-21-统计.md');
  const defaultOut = path.join(root, 'logs', '2026-04-21-明细.xlsx');
  const mdPath = path.resolve(process.argv[2] || defaultMd);
  const outPath = path.resolve(process.argv[3] || defaultOut);

  if (!fs.existsSync(mdPath)) {
    console.error('找不到文件:', mdPath);
    process.exit(1);
  }

  const md = fs.readFileSync(mdPath, 'utf8');

  const summary = parsePipeTableFrom(md, '| 项目 | 数量 |');
  const detail = parsePipeTableFrom(md, '| 设备名（SN） | WiFi 名 | 跑量(MB) | 状态 | 失败原因 |');
  const retries = parsePipeTableFrom(md, '| 设备名（SN） | WiFi 名 | 简要原因（摘自日志） |');

  const wb = XLSX.utils.book_new();

  if (summary.length) {
    const ws = XLSX.utils.aoa_to_sheet(summary);
    XLSX.utils.book_append_sheet(wb, ws, '汇总');
  }
  if (detail.length) {
    const ws = XLSX.utils.aoa_to_sheet(detail);
    XLSX.utils.book_append_sheet(wb, ws, '明细');
  }
  if (retries.length) {
    const ws = XLSX.utils.aoa_to_sheet(retries);
    XLSX.utils.book_append_sheet(wb, ws, 'WiFi重试');
  }

  XLSX.writeFile(wb, outPath);
  console.log('已写入:', outPath);
}

main();
