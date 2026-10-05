const { chromium } = require('playwright');
const path = require('path');
require('dotenv').config();

const { profileDir, flowUrlFor } = require('./accounts');

// node login.js     -> tài khoản 1 (user_data)
// node login.js 2   -> tài khoản 2 (user_data_2), ...
const ACCOUNT_ID = /^\d+$/.test(process.argv[2] || '') ? process.argv[2] : '1';
const FLOW_TOOL_URL = flowUrlFor(ACCOUNT_ID);
const USER_DATA_DIR = profileDir(ACCOUNT_ID);

async function login() {
  console.log('--------------------------------------------------');
  console.log(`🚀 Đang mở trình duyệt để bạn đăng nhập Google Flow (tài khoản ${ACCOUNT_ID})...`);
  console.log('📁 Dữ liệu phiên sẽ được lưu tại:', USER_DATA_DIR);
  console.log('--------------------------------------------------');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    viewport: { width: 1280, height: 800 }
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  console.log(`🌐 Đang mở trang: ${FLOW_TOOL_URL}`);
  await page.goto(FLOW_TOOL_URL, { waitUntil: 'domcontentloaded' });

  console.log('\n👉 VUI LÒNG ĐĂNG NHẬP GOOGLE TRÊN CỬA SỔ TRÌNH DUYỆT ĐANG MỞ.');
  console.log('👉 Sau khi đăng nhập xong và nhìn thấy giao diện tool "TikTok Director Pro AI", bạn hãy ĐÓNG TRÌNH DUYỆT.');
  console.log('👉 Lần sau bot sẽ tự động nhận diện mà không cần đăng nhập lại!\n');

  context.on('close', () => {
    console.log('✅ Đã lưu phiên đăng nhập thành công!');
    process.exit(0);
  });
}

login().catch(err => {
  console.error('❌ Lỗi khi mở trình duyệt:', err);
  process.exit(1);
});
