const { launchTikTok, isTikTokLoggedIn } = require('./tiktok_browser');
const path = require('path');
require('dotenv').config();

const TIKTOK_FEED_URL = process.env.TIKTOK_FEED_URL || 'https://www.tiktok.com/';

// Cấu hình thời gian xem
const CONFIG = {
  // Giới hạn số video xem (0 = không giới hạn, xem đến khi bạn tắt)
  maxVideos: Number(process.env.TIKTOK_WATCH_MAX) || 0,
  // Thời gian xem tối thiểu mỗi video (giây) - tránh lướt quá nhanh
  minWatchSeconds: 3,
  // Thời gian xem tối đa mỗi video (giây) - tránh bị kẹt ở video quá dài hoặc livestream
  maxWatchSeconds: 90,
  // Tự động bật âm thanh nếu video đang bị tắt tiếng
  autoUnmute: true,
};

// Đợi ngẫu nhiên trong khoảng [minMs, maxMs] để giống người thật
function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tắt các popup quảng cáo / đăng nhập / thông báo nếu có
async function dismissPopups(page) {
  try {
    // 1. Popup "Nhận ứng dụng" hoặc "Đăng nhập"
    const closeBtns = page.locator('[data-e2e="modal-close-icon"], [aria-label="Close"], button:has-text("Không phải bây giờ"), button:has-text("Để sau"), button:has-text("Bỏ qua")');
    const count = await closeBtns.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const btn = closeBtns.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(500);
      }
    }
  } catch (_) {}
}

// Bật âm thanh nếu video bị mute
async function ensureUnmuted(page) {
  if (!CONFIG.autoUnmute) return;
  try {
    await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('video'));
      for (const v of videos) {
        if (v.muted) v.muted = false;
      }
    });
  } catch (_) {}
}

/**
 * Tìm video đang hiển thị ở giữa màn hình và theo dõi tiến trình phát
 */
async function watchCurrentVideo(page, videoIndex) {
  console.log(`\n▶️ [Video #${videoIndex}] Đang tìm video trên màn hình...`);

  // Đợi trang tải video
  await page.waitForSelector('video', { timeout: 15000 }).catch(() => {});
  await dismissPopups(page);
  await ensureUnmuted(page);

  // Đọc thông tin video hiện tại
  let videoInfo = await page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video'));
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      // Nằm trong khung nhìn của màn hình
      if (midY >= 0 && midY <= window.innerHeight && rect.height > 100) {
        return {
          duration: v.duration || 0,
          currentTime: v.currentTime || 0,
          paused: v.paused,
          src: v.currentSrc || v.src || '',
          loop: v.loop
        };
      }
    }
    // Fallback: lấy video đầu tiên nếu có
    if (videos.length > 0) {
      const v = videos[0];
      return {
        duration: v.duration || 0,
        currentTime: v.currentTime || 0,
        paused: v.paused,
        src: v.currentSrc || v.src || '',
        loop: v.loop
      };
    }
    return null;
  });

  if (!videoInfo) {
    console.log('⚠️ Chưa thấy thẻ video nào trong khung nhìn, đợi 3s...');
    await page.waitForTimeout(3000);
    return;
  }

  // Nếu video đang pause thì click để phát
  if (videoInfo.paused) {
    console.log('⏸️ Video đang tạm dừng -> Bấm phát...');
    await page.keyboard.press('Space').catch(() => {});
    await page.waitForTimeout(800);
  }

  const duration = videoInfo.duration;
  const isFiniteDuration = Number.isFinite(duration) && duration > 0;
  
  // Xác định thời gian cần xem
  let targetWatchTime;
  if (isFiniteDuration) {
    // Xem hết video (giới hạn tối đa maxWatchSeconds nếu video quá dài)
    targetWatchTime = Math.min(duration, CONFIG.maxWatchSeconds);
    console.log(`⏱️ Thời lượng video: ${Math.round(duration)}s (Mục tiêu xem: ${Math.round(targetWatchTime)}s)`);
  } else {
    // Có thể là Livestream hoặc video chưa load được metadata duration
    targetWatchTime = 15;
    console.log(`⏱️ Video không có thời lượng cố định (hoặc Live) -> Xem ${targetWatchTime}s`);
  }

  // Vòng lặp theo dõi tiến độ phát
  const startTime = Date.now();
  let prevCurrentTime = -1;
  let hasLooped = false;

  while (true) {
    await page.waitForTimeout(1000);

    const status = await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('video'));
      for (const v of videos) {
        const rect = v.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (midY >= 0 && midY <= window.innerHeight && rect.height > 100) {
          return {
            currentTime: v.currentTime || 0,
            duration: v.duration || 0,
            ended: v.ended,
            paused: v.paused
          };
        }
      }
      return null;
    });

    const elapsedSeconds = (Date.now() - startTime) / 1000;

    if (!status) {
      // Mất dấu video hoặc trang đang load
      if (elapsedSeconds >= targetWatchTime) break;
      continue;
    }

    // Nếu video bị lặp (loop reset về đầu: trước đó > 2s mà giờ < 1s)
    if (prevCurrentTime > 2 && status.currentTime < 1) {
      hasLooped = true;
    }
    prevCurrentTime = status.currentTime;

    // Hiển thị tiến trình trên 1 dòng
    process.stdout.write(`   ⏳ Đang xem: ${Math.floor(elapsedSeconds)}s / ${Math.round(targetWatchTime)}s (Tiến độ video: ${Math.floor(status.currentTime)}s)\r`);

    // Điều kiện kết thúc video:
    // 1. Thuộc tính ended = true
    // 2. Video phát gần hết (còn < 0.8s)
    // 3. Video đã tự lặp lại (loop về 0)
    // 4. Đã xem đủ thời gian mục tiêu hoặc chạm ngưỡng tối đa
    if (status.ended) {
      console.log(`\n✅ Video đã kết thúc!`);
      break;
    }
    if (isFiniteDuration && status.currentTime >= duration - 0.8) {
      console.log(`\n✅ Đã xem hết video (${Math.round(duration)}s)!`);
      break;
    }
    if (hasLooped && elapsedSeconds >= CONFIG.minWatchSeconds) {
      console.log(`\n✅ Video đã phát hết 1 lượt (bắt đầu loop lại)!`);
      break;
    }
    if (elapsedSeconds >= targetWatchTime) {
      console.log(`\n⏰ Đã xem đủ thời gian mục tiêu (${Math.round(targetWatchTime)}s)!`);
      break;
    }
  }

  // Nghỉ tự nhiên ngẫu nhiên 0.8s - 2s trước khi lướt tiếp
  const delayMs = Math.floor(Math.random() * 1200) + 800;
  console.log(`😴 Dừng lại ${Math.round(delayMs / 100) / 10}s rồi lướt tiếp...`);
  await page.waitForTimeout(delayMs);
}

/**
 * Cuộn xuống video tiếp theo
 */
async function scrollToNextVideo(page) {
  console.log('⬇️ Đang lướt xuống video tiếp theo...');

  // Cách 1: Phím mũi tên xuống (phím tắt chuẩn nhất của TikTok trên máy tính)
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(1000);

  // Cách 2: Kiểm tra nếu vẫn chưa chuyển video thì cuộn chuột
  const scrollSuccess = await page.evaluate(() => {
    // Cuộn nhẹ nếu phím mũi tên chưa kích hoạt chuyển slide
    window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
    return true;
  }).catch(() => false);

  await page.waitForTimeout(1500);
}

async function main() {
  console.log('====================================================');
  console.log('🚀 TỰ ĐỘNG XEM & LƯỚT TIKTOK (AUTO SCROLL TIKTOK)');
  console.log('====================================================');

  console.log('🌐 Mở trình duyệt Chrome với tài khoản TikTok đã lưu...');
  const { context, page } = await launchTikTok({ headless: false });

  let isClosed = false;
  context.on('close', () => {
    isClosed = true;
    console.log('\n👋 Trình duyệt đã được đóng. Dừng chương trình.');
  });

  try {
    console.log(`🌍 Đang truy cập: ${TIKTOK_FEED_URL}...`);
    await page.goto(TIKTOK_FEED_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    const loggedIn = await isTikTokLoggedIn(context, page);
    if (loggedIn) {
      console.log('✅ Đã nhận diện phiên đăng nhập TikTok!');
    } else {
      console.log('ℹ️ Đang chạy với tài khoản hiện tại (nếu chưa đăng nhập, bạn có thể tự đăng nhập trên cửa sổ này).');
    }

    // Tắt các popup mở đầu
    await dismissPopups(page);

    // Bắt đầu vòng lặp lướt video
    let count = 0;
    while (!isClosed) {
      count++;
      if (CONFIG.maxVideos > 0 && count > CONFIG.maxVideos) {
        console.log(`\n🎉 Đã hoàn thành xem ${CONFIG.maxVideos} video theo cấu hình!`);
        break;
      }

      await watchCurrentVideo(page, count);

      if (isClosed) break;

      await scrollToNextVideo(page);
    }
  } catch (error) {
    if (!isClosed) {
      console.error('❌ Lỗi:', error.message);
    }
  } finally {
    if (!isClosed) {
      await context.close().catch(() => {});
    }
  }
}

main();
