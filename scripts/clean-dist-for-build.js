/**
 * 打包前清理 dist，避免 Windows 下因旧进程占用 app.asar 导致 electron-builder 无法删除。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const dist = path.join(root, 'dist');
const productName = (pkg.build && pkg.build.productName) || pkg.name;

function killWinIfExists(exeName) {
  if (process.platform !== 'win32') return;
  try {
    execSync(`taskkill /F /IM "${exeName}" /T`, {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (_) {
    /* 未运行或已结束 */
  }
}

/** Windows 结束进程后稍等，便于释放对 app.asar 的占用 */
function winSleepMs(ms) {
  if (process.platform !== 'win32') return;
  const pings = Math.max(2, Math.ceil(ms / 1000) + 1);
  try {
    execSync(`ping -n ${pings} 127.0.0.1 > nul`, { stdio: 'ignore', windowsHide: true });
  } catch (_) {}
}

if (process.platform === 'win32') {
  killWinIfExists(`${productName}.exe`);
  winSleepMs(1200);
}

if (!fs.existsSync(dist)) {
  process.exit(0);
}

try {
  fs.rmSync(dist, { recursive: true, force: true, maxRetries: 15, retryDelay: 150 });
} catch (e) {
  console.error(
    '\n仍无法删除 dist 目录（通常有进程占用 app.asar）。请：\n' +
      '1) 关闭已打开的「' +
      productName +
      '」及任务管理器里的同名进程；\n' +
      '2) 若正在运行 npm start / electron .，请先结束；\n' +
      '3) 关闭资源管理器中打开的 dist\\win-unpacked 文件夹后重试。\n'
  );
  console.error(e.message);
  process.exit(1);
}
