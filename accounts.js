const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DEFAULT_FLOW_TOOL_URL = 'https://flow.google.com/project/856dd52d-7081-4b09-8a04-b32e7b5b6a0d/tool/0f719f8f-3aa3-4c8a-8b73-edb5ecd9fa7b';

// Mỗi tài khoản Google Flow = 1 hồ sơ Chrome riêng:
//   tài khoản 1: user_data      + FLOW_TOOL_URL
//   tài khoản N: user_data_N    + FLOW_TOOL_URL_N (không đặt thì dùng chung FLOW_TOOL_URL)
// Thêm tài khoản mới: node login.js 2  (tạo user_data_2)
function profileDir(id) {
  return path.join(__dirname, String(id) === '1' ? 'user_data' : `user_data_${id}`);
}

function flowUrlFor(id) {
  const own = String(id) === '1' ? null : process.env[`FLOW_TOOL_URL_${id}`];
  return own || process.env.FLOW_TOOL_URL || DEFAULT_FLOW_TOOL_URL;
}

function listGoogleAccounts() {
  return fs.readdirSync(__dirname)
    .map((name) => name.match(/^user_data(?:_(\d+))?$/))
    .filter((m) => m && fs.statSync(path.join(__dirname, m[0])).isDirectory())
    .map((m) => m[1] || '1')
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => ({ id, dir: profileDir(id), flowUrl: flowUrlFor(id) }));
}

function getGoogleAccount(id) {
  return listGoogleAccounts().find((a) => a.id === String(id)) || null;
}

module.exports = { listGoogleAccounts, getGoogleAccount, profileDir, flowUrlFor, DEFAULT_FLOW_TOOL_URL };
