const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const TIKTOK_STUDIO_URL = process.env.TIKTOK_STUDIO_URL || 'https://www.tiktok.com/tiktokstudio/content';
// Profile riêng cho TikTok, tách khỏi profile Google Flow (user_data)
const TIKTOK_USER_DATA_DIR = path.join(__dirname, 'user_data_tiktok');
// TikTok có thể cache rất nhiều segment video. 150 MB là đủ để trang hoạt động
// bình thường mà không để profile lớn dần sau mỗi lần chạy.
const DISK_CACHE_SIZE_BYTES = Number(process.env.TIKTOK_DISK_CACHE_SIZE_BYTES) || 150 * 1024 * 1024;
const MEDIA_CACHE_SIZE_BYTES = Number(process.env.TIKTOK_MEDIA_CACHE_SIZE_BYTES) || 32 * 1024 * 1024;

function cleanStaleLocks(dir) {
  const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const name of lockNames) {
    const fullPath = path.join(dir, name);
    try {
      fs.lstatSync(fullPath);
      fs.unlinkSync(fullPath);
      console.error(`🧹 Đã dọn dẹp file lock cũ: ${name}`);
    } catch (_) {}
  }
}

// Dùng Google Chrome thật (channel "chrome") — TikTok dễ chặn Chromium của Playwright
// và Chromium không phát được MP4 khi xem trước video lúc upload.
async function launchTikTok({ headless = false } = {}) {
  cleanStaleLocks(TIKTOK_USER_DATA_DIR);

  const context = await chromium.launchPersistentContext(TIKTOK_USER_DATA_DIR, {
    channel: process.env.TIKTOK_BROWSER_CHANNEL || 'chrome',
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-restore-session-state',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      `--disk-cache-size=${DISK_CACHE_SIZE_BYTES}`,
      `--media-cache-size=${MEDIA_CACHE_SIZE_BYTES}`,
      // Chỉ cần các cờ này nếu phải chạy khi cửa sổ bị che/tắt màn hình.
      // Bật mặc định khiến Chrome không hạ tài nguyên khi chạy nền.
      ...(process.env.TIKTOK_KEEP_ACTIVE === 'true' ? [
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling'
      ] : [])
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1440, height: 900 },
    locale: 'vi-VN'
  });

  // Đóng các tab thừa do Chrome khôi phục từ phiên trước, chỉ giữ lại đúng 1 tab
  const pages = context.pages();
  while (pages.length > 1) {
    const extra = pages.pop();
    await extra.close().catch(() => {});
  }
  const page = pages[0] || (await context.newPage());
  return { context, page };
}

// Đã đăng nhập khi có cookie sessionid của tiktok.com và trang Studio không bị đẩy sang trang login
async function isTikTokLoggedIn(context, page) {
  const cookies = await context.cookies('https://www.tiktok.com');
  const hasSession = cookies.some((c) => c.name === 'sessionid' && c.value);
  const onLoginPage = /\/login/.test(page.url());
  return hasSession && !onLoginPage;
}

module.exports = { TIKTOK_STUDIO_URL, TIKTOK_USER_DATA_DIR, launchTikTok, isTikTokLoggedIn };
