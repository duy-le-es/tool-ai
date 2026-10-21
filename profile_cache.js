const fs = require('fs');
const path = require('path');

// Thư mục cache trong hồ sơ Chrome: xóa thoải mái, không mất đăng nhập (cookie nằm ở Default/Cookies).
// Chrome tự tạo lại khi cần, chỉ tải trang lần đầu chậm hơn một chút.
const CACHE_DIRS = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnWebGPUCache',
  'Default/DawnGraphiteCache',
  'GPUPersistentCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'BrowserMetrics',
];

const DEFAULT_LIMIT_MB = Number(process.env.PROFILE_CACHE_LIMIT_MB) || 300;

function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else try { total += fs.lstatSync(full).size; } catch {}
  }
  return total;
}

// SingletonLock là symlink "<hostname>-<pid>" của Chrome đang mở hồ sơ này
function profileInUse(profileDir) {
  try {
    const pid = Number(fs.readlinkSync(path.join(profileDir, 'SingletonLock')).split('-').pop());
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Gọi trước khi mở Chrome: nếu cache của hồ sơ vượt giới hạn thì xóa đi để thư mục không phình mãi
function trimProfileCache(profileDir, { extraDirs = [], limitMb = DEFAULT_LIMIT_MB } = {}) {
  if (!fs.existsSync(profileDir) || profileInUse(profileDir)) return;
  const dirs = [...CACHE_DIRS, ...extraDirs].map((d) => path.join(profileDir, d));
  const total = dirs.reduce((sum, d) => sum + dirSize(d), 0);
  if (total < limitMb * 1024 * 1024) return;

  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.error(`🧹 Đã dọn ${Math.round(total / 1024 / 1024)} MB cache của hồ sơ ${path.basename(profileDir)}`);
}

module.exports = { trimProfileCache };
