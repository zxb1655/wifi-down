const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

function formatTs(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return { date: `${y}-${m}-${d}`, time: `${h}-${mi}-${s}`, full: `${y}-${m}-${d} ${h}:${mi}:${s}` };
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}小时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

function bytesToMB(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((n / (1024 * 1024)) * 100) / 100;
}

function deviceStatusLabel(status) {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'pending') return '待跑量';
  if (status === 'processing') return '跑量中';
  return status || '未知';
}

function failureCategoryLabel(d) {
  if (!d || d._status !== 'failed') return '';
  if ((d._flow || 0) > 0) return '有部分跑量';
  const r = String(d._failRemark || '');
  if (/未扫描到|连接失败|盲连|未配置测速/.test(r)) return '无跑量(扫描/连接)';
  return '无跑量';
}

/**
 * 生成跑量结果 Excel 报表
 * @param {Object} opts
 * @param {string} opts.outDir 输出目录（一般为 logs 目录）
 * @param {Array<Object>} opts.devices 设备列表（含 _status / _flow / _failRemark）
 * @param {Date} opts.startedAt 任务开始时间
 * @param {Date} opts.endedAt 任务结束时间
 * @param {string} [opts.title] 报表标题（如 "跑量任务报表"）
 * @returns {Promise<string>} 生成的 xlsx 完整路径
 */
async function generateRunReport({ outDir, devices, startedAt, endedAt, title }) {
  if (!outDir) throw new Error('未指定输出目录');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const list = Array.isArray(devices) ? devices : [];
  const start = startedAt instanceof Date ? startedAt : new Date();
  const end = endedAt instanceof Date ? endedAt : new Date();

  const total = list.length;
  const successList = list.filter((d) => d && d._status === 'success');
  const failedList = list.filter((d) => d && d._status === 'failed');
  const partialFailList = failedList.filter((d) => (d._flow || 0) > 0);
  const partialFailMB = partialFailList.reduce((s, d) => s + bytesToMB(d._flow || 0), 0);
  const zeroFlowFailCount = failedList.length - partialFailList.length;
  const otherList = list.filter(
    (d) => d && d._status !== 'success' && d._status !== 'failed',
  );
  const totalSuccessMB = successList.reduce((s, d) => s + bytesToMB(d._flow || 0), 0);
  const successRate = total > 0 ? ((successList.length / total) * 100).toFixed(2) + '%' : '-';

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WiFi 跑流量工具';
  workbook.created = new Date();

  // ===== Sheet 1: 统计汇总 =====
  const summary = workbook.addWorksheet('统计汇总');
  summary.columns = [
    { header: '项目', key: 'k', width: 22 },
    { header: '内容', key: 'v', width: 40 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9E1F2' },
  };

  const summaryRows = [
    ['报表标题', title || '跑量任务报表'],
    ['任务开始时间', formatTs(start).full],
    ['任务结束时间', formatTs(end).full],
    ['任务总耗时', formatDurationMs(end.getTime() - start.getTime())],
    ['设备总数', total],
    ['成功数', successList.length],
    ['失败数', failedList.length],
    ['失败但有部分跑量（台数）', partialFailList.length],
    ['失败但有部分跑量合计 (MB)', Math.round(partialFailMB * 100) / 100],
    ['纯失败无跑量（台数）', zeroFlowFailCount],
    ['其他状态数', otherList.length],
    ['成功率', successRate],
    ['成功设备累计跑量 (MB)', Math.round(totalSuccessMB * 100) / 100],
  ];
  for (const [k, v] of summaryRows) summary.addRow({ k, v });
  summary.getColumn('k').font = { bold: true };

  // ===== Sheet 2: 设备明细 =====
  const detail = workbook.addWorksheet('设备明细');
  detail.columns = [
    { header: '序号', key: 'idx', width: 6 },
    { header: '设备号 SN', key: 'sn', width: 24 },
    { header: 'WiFi 名称', key: 'wifiName', width: 24 },
    { header: 'WiFi 密码', key: 'wifiPassword', width: 18 },
    { header: '状态', key: 'status', width: 8 },
    { header: '失败分类', key: 'failCategory', width: 16 },
    { header: '跑量 (MB)', key: 'flowMB', width: 12 },
    { header: '失败原因 / 备注', key: 'remark', width: 60 },
  ];
  const headerRow = detail.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9E1F2' },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  const sorted = [...list].sort((a, b) => {
    const order = { success: 0, failed: 1 };
    const oa = order[a?._status] ?? 2;
    const ob = order[b?._status] ?? 2;
    if (oa !== ob) return oa - ob;
    return String(a?.sn || '').localeCompare(String(b?.sn || ''));
  });

  sorted.forEach((d, i) => {
    const status = d?._status;
    const row = detail.addRow({
      idx: i + 1,
      sn: d?.sn || '',
      wifiName: d?.wifiName || '',
      wifiPassword: d?.wifiPassword || '',
      status: deviceStatusLabel(status),
      failCategory: failureCategoryLabel(d),
      flowMB: status === 'success' ? bytesToMB(d?._flow || 0) : (d?._flow ? bytesToMB(d._flow) : 0),
      remark: status === 'success' ? '' : (d?._failRemark || ''),
    });
    if (status === 'success') {
      row.getCell('status').fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFC6EFCE' },
      };
      row.getCell('status').font = { color: { argb: 'FF006100' }, bold: true };
    } else if (status === 'failed') {
      row.getCell('status').fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFC7CE' },
      };
      row.getCell('status').font = { color: { argb: 'FF9C0006' }, bold: true };
      if ((d?._flow || 0) > 0) {
        const flowCell = row.getCell('flowMB');
        flowCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFF2CC' },
        };
        const catCell = row.getCell('failCategory');
        catCell.font = { color: { argb: 'FF7F6000' }, bold: true };
      }
    }
    row.alignment = { vertical: 'middle', wrapText: true };
  });

  detail.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: detail.columns.length },
  };
  detail.views = [{ state: 'frozen', ySplit: 1 }];

  // ===== Sheet 3: 失败明细（按原因聚合） =====
  if (failedList.length > 0) {
    const failSheet = workbook.addWorksheet('失败原因汇总');
    failSheet.columns = [
      { header: '失败原因', key: 'reason', width: 60 },
      { header: '设备数', key: 'count', width: 10 },
      { header: '涉及设备 SN', key: 'sns', width: 80 },
    ];
    failSheet.getRow(1).font = { bold: true };
    failSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    const groupMap = new Map();
    for (const d of failedList) {
      const reason = (d._failRemark || '(无备注)').trim() || '(无备注)';
      if (!groupMap.has(reason)) groupMap.set(reason, []);
      groupMap.get(reason).push(d.sn || '');
    }
    const groups = Array.from(groupMap.entries()).sort((a, b) => b[1].length - a[1].length);
    for (const [reason, sns] of groups) {
      const row = failSheet.addRow({ reason, count: sns.length, sns: sns.join(', ') });
      row.alignment = { vertical: 'middle', wrapText: true };
    }
    failSheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const ts = formatTs(end);
  const filename = `跑量报表-${ts.date}_${ts.time}.xlsx`;
  const fullPath = path.join(outDir, filename);
  await workbook.xlsx.writeFile(fullPath);
  return fullPath;
}

module.exports = { generateRunReport };
