const { TIKTOK_STUDIO_URL, TIKTOK_USER_DATA_DIR, launchTikTok, isTikTokLoggedIn } = require('./tiktok_browser');

// Chạy:  node login_tiktok.js          -> mở Chrome để đăng nhập, tự lưu phiên khi đăng nhập xong
//        node login_tiktok.js --check  -> chỉ kiểm tra phiên đã lưu còn hiệu lực không (chạy ẩn)
const CHECK_ONLY = process.argv.includes('--check');

async function loginTikTok() {
  console.log('--------------------------------------------------');
  console.log(CHECK_ONLY ? '🔎 Kiểm tra phiên đăng nhập TikTok...' : '🚀 Mở Chrome để bạn đăng nhập TikTok Studio...');
  console.log('📁 Dữ liệu phiên lưu tại:', TIKTOK_USER_DATA_DIR);
  console.log('--------------------------------------------------');

  const { context, page } = await launchTikTok({ headless: CHECK_ONLY });
  await page.goto(TIKTOK_STUDIO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  if (await isTikTokLoggedIn(context, page)) {
    console.log('✅ Đã đăng nhập TikTok, phiên đang được lưu. Bot có thể dùng để đăng video.');
    await context.close();
    return;
  }

  if (CHECK_ONLY) {
    console.log('❌ Chưa đăng nhập hoặc phiên đã hết hạn. Chạy: node login_tiktok.js');
    await context.close();
    process.exitCode = 1;
    return;
  }

  console.log('\n👉 ĐĂNG NHẬP TIKTOK trên cửa sổ Chrome vừa mở (QR code / số điện thoại / email).');
  console.log('👉 Đăng nhập xong, script tự nhận biết, lưu phiên rồi đóng trình duyệt.');
  console.log('👉 Có thể đóng trình duyệt thủ công bất kỳ lúc nào để thoát.\n');

  let closed = false;
  context.on('close', () => { closed = true; });

  // Đợi tối đa 10 phút cho bạn đăng nhập
  const deadline = Date.now() + 10 * 60 * 1000;
  while (!closed && Date.now() < deadline) {
    const activePage = context.pages().at(-1) || page;
    if (await isTikTokLoggedIn(context, activePage).catch(() => false)) {
      console.log('✅ Đăng nhập thành công! Đang mở lại TikTok Studio để xác nhận...');
      await activePage.goto(TIKTOK_STUDIO_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await activePage.waitForTimeout(5000);
      await context.close();
      console.log('💾 Đã lưu phiên đăng nhập TikTok. Lần sau bot tự dùng, không cần đăng nhập lại.');
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!closed) await context.close();
  console.log(closed ? '⚠️ Trình duyệt đã đóng trước khi đăng nhập xong.' : '⏰ Hết 10 phút mà chưa đăng nhập.');
  process.exitCode = 1;
}

loginTikTok().catch((err) => {
  console.error('❌ Lỗi:', err.message);
  process.exit(1);
});
