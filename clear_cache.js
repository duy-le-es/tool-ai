#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const confirm = process.argv.includes('--yes');
const targets = fs.readdirSync(ROOT_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => (
    name === 'downloads'
    || name === 'results'
    || name === 'user_data'
    || /^user_data_\d+$/.test(name)
    || name === 'user_data_tiktok'
  ))
  .sort();

if (targets.length === 0) {
  console.log('Khong tim thay thu muc cache can don.');
  process.exit(0);
}

console.log('Cac thu muc se bi xoa:');
for (const target of targets) console.log(`- ${target}`);

if (!confirm) {
  console.log('\nDay la che do xem truoc. Chay lai voi --yes de xoa that:');
  console.log('node clear_cache.js --yes');
  process.exit(0);
}

for (const target of targets) {
  fs.rmSync(path.join(ROOT_DIR, target), { recursive: true, force: true });
  console.log(`Da xoa: ${target}`);
}

console.log('Da don xong cache. Cac tai khoan Google/TikTok se can dang nhap lai.');
