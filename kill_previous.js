const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = __dirname;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listProcesses() {
  try {
    return execSync('ps -eo pid=,args=', { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map(([, pid, args]) => ({ pid: Number(pid), args }));
  } catch {
    return [];
  }
}

function processCwd(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

// Tiến trình "node <script>" của chính project này (chạy bằng đường dẫn tuyệt đối hoặc tương đối)
function isOurScript({ pid, args }, scriptFile) {
  const parts = args.split(/\s+/);
  if (!/(^|\/)node(js)?$/.test(parts[0])) return false;
  const script = parts.slice(1).find((a) => !a.startsWith('-'));
  const name = path.basename(scriptFile, '.js');
  if (!script || !new RegExp(`(^|/)${name}(\\.js)?$`).test(script)) return false;
  const base = path.isAbsolute(script) ? '' : processCwd(pid);
  if (base === null) return false;
  const resolved = path.resolve(base, script);
  return resolved === scriptFile || resolved === scriptFile.slice(0, -3);
}

// Chrome do Playwright mở trên các hồ sơ của project (mặc định user_data, user_data_2, ... của Flow)
function isOurChrome({ args }, profilePattern) {
  const m = args.match(/--user-data-dir=(\S+)/);
  return !!m && path.dirname(m[1]) === PROJECT_DIR && profilePattern.test(path.basename(m[1]));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Dừng toàn bộ tiến trình cũ của script + Chrome của chúng để lần chạy mới nhất là bản duy nhất.
// Mặc định dành cho bot.js và các hồ sơ Flow; truyền script/profilePattern/label cho script khác.
function killPreviousInstances({
  script = 'bot.js',
  profilePattern = /^user_data(_\d+)?$/,
  label = 'bot',
} = {}) {
  const scriptFile = path.join(PROJECT_DIR, script);
  const targets = listProcesses()
    .filter((p) => p.pid !== process.pid && p.pid !== process.ppid)
    .filter((p) => isOurScript(p, scriptFile) || isOurChrome(p, profilePattern));
  if (targets.length === 0) return;

  const olds = targets.filter((p) => isOurScript(p, scriptFile));
  if (olds.length) console.log(`🔪 Dừng ${olds.length} ${label} cũ đang chạy: ${olds.map((p) => p.pid).join(', ')}`);
  const chromes = targets.length - olds.length;
  if (chromes) console.log(`🔪 Đóng ${chromes} tiến trình Chrome của hồ sơ ${label} còn mở`);

  for (const { pid } of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  for (let i = 0; i < 30 && targets.some((p) => isAlive(p.pid)); i++) sleepSync(100);
  for (const { pid } of targets) {
    if (isAlive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
  }

  // Xóa khóa hồ sơ Chrome còn sót lại sau khi bị kill, nếu không Chrome mới sẽ báo hồ sơ đang dùng
  for (const name of fs.readdirSync(PROJECT_DIR)) {
    if (!profilePattern.test(name)) continue;
    for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.unlinkSync(path.join(PROJECT_DIR, name, lock)); } catch {}
    }
  }
}

module.exports = { killPreviousInstances };
