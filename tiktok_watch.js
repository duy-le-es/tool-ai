const { launchTikTok, isTikTokLoggedIn } = require('./tiktok_browser');
const { killPreviousInstances } = require('./kill_previous');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const TIKTOK_FEED_URL = process.env.TIKTOK_FEED_URL || 'https://www.tiktok.com/';
const TIKTOK_URL_PREFIX = 'https://www.tiktok.com';

// Cấu hình thời gian xem & tương tác
const CONFIG = {
  // Chế độ chạy ngầm (true = ẩn cửa sổ Chrome, chỉ xem log terminal; false = hiện cửa sổ)
  headless: process.env.TIKTOK_WATCH_HEADLESS !== undefined
    ? (process.env.TIKTOK_WATCH_HEADLESS === 'true')
    : (process.env.HEADLESS !== 'false'), // Mặc định true theo HEADLESS=true trong .env
  // Giới hạn số video xem (0 = không giới hạn, xem liên tục đến khi tắt)
  maxVideos: Number(process.env.TIKTOK_WATCH_MAX) || 0,
  // Cứ sau N video thì đóng Chrome và mở lại để giải phóng RAM (0 = không bao giờ).
  // Tab TikTok lướt vô hạn giữ lại DOM/bộ nhớ của mọi video đã xem nên RAM tăng dần.
  recycleEvery: process.env.TIKTOK_WATCH_RECYCLE_EVERY !== undefined
    ? Number(process.env.TIKTOK_WATCH_RECYCLE_EVERY) || 0
    : 30,
  // Thời gian xem tối thiểu mỗi video (giây)
  minWatchSeconds: 3,
  // Thời gian xem tối đa mỗi video (giây) - tránh kẹt ở video dài/livestream
  maxWatchSeconds: 90,
  // Tự động bật âm thanh nếu video đang bị tắt tiếng
  autoUnmute: true,
  // Tự động thả tim khi video gần hết
  autoLike: true,
  // Tự động mở menu Share và bấm "Sao chép liên kết" khi video gần hết
  autoCopyLink: true,
  // Tỷ lệ thời lượng video để bắt đầu tương tác (0.75 = 75% video, còn khoảng 25% là hết)
  interactionThresholdRatio: 0.75,
  // Hoặc số giây còn lại tối đa để kích hoạt (3s trước khi hết)
  interactionRemainingSeconds: 3.5,
};

// Đợi ngẫu nhiên trong khoảng [minMs, maxMs] để giống người thật
function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tắt các popup quảng cáo / đăng nhập / thông báo nếu có
async function dismissPopups(page) {
  try {
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
 * Thả tim video đang xem (nếu chưa được thả tim)
 */
async function likeActiveVideo(page) {
  if (!CONFIG.autoLike) return false;

  try {
    const result = await page.evaluate(() => {
      // 1. Tìm video đang ở giữa khung nhìn
      const videos = Array.from(document.querySelectorAll('video'));
      let activeVideo = null;
      for (const v of videos) {
        const rect = v.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (midY >= 0 && midY <= window.innerHeight && rect.height > 100) {
          activeVideo = v;
          break;
        }
      }
      if (!activeVideo && videos.length > 0) activeVideo = videos[0];
      if (!activeVideo) return { success: false, reason: 'no_video' };

      const vRect = activeVideo.getBoundingClientRect();
      const vMidY = vRect.top + vRect.height / 2;

      // 2. Tìm tất cả nút Tim (Like button) trên trang
      const likeSelectors = [
        '[data-e2e="like-icon"]',
        '[data-e2e="feed-like-icon"]',
        '[data-e2e="browse-like-icon"]',
        'button[aria-label*="Like" i]',
        'button[aria-label*="Thích" i]'
      ];

      const candidates = [];
      for (const sel of likeSelectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const btn = el.closest('button') || el;
          if (!candidates.includes(btn)) candidates.push(btn);
        });
      }

      // Chọn nút like có vị trí trục Y gần nhất với video đang phát
      let bestBtn = null;
      let minDiff = Infinity;
      for (const btn of candidates) {
        const bRect = btn.getBoundingClientRect();
        if (bRect.height === 0 || bRect.width === 0) continue;
        if (bRect.bottom < 0 || bRect.top > window.innerHeight) continue;
        const diff = Math.abs((bRect.top + bRect.height / 2) - vMidY);
        if (diff < minDiff) {
          minDiff = diff;
          bestBtn = btn;
        }
      }

      if (!bestBtn) {
        // Fallback: double click vào giữa video để thả tim
        const evt = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
        activeVideo.dispatchEvent(evt);
        return { success: true, method: 'double_click' };
      }

      // Kiểm tra xem đã thả tim chưa (tránh ấn lại thành hủy tim)
      const isAlreadyLiked = () => {
        if (bestBtn.getAttribute('aria-pressed') === 'true') return true;
        const svg = bestBtn.querySelector('svg');
        if (svg) {
          const fill = svg.getAttribute('fill') || '';
          const style = window.getComputedStyle(svg);
          const color = style.color || style.fill || '';
          // Màu đỏ của TikTok: #fe2c55 / rgb(254, 44, 85)
          if (fill.includes('fe2c55') || color.includes('254, 44, 85')) return true;
        }
        if (bestBtn.className && (bestBtn.className.includes('active') || bestBtn.className.includes('liked'))) return true;
        return false;
      };

      if (isAlreadyLiked()) {
        return { success: true, alreadyLiked: true };
      }

      bestBtn.click();
      return { success: true, method: 'click_button' };
    });

    if (result.success) {
      if (result.alreadyLiked) {
        console.log('\n   ❤️ Video này đã được thả tim từ trước.');
      } else {
        console.log('\n   ❤️ Đã bấm THẢ TIM (Like) cho video thành công!');
      }
      return true;
    }
  } catch (err) {
    console.log(`\n   ⚠️ Lỗi thả tim: ${err.message}`);
  }
  return false;
}

/**
 * Mở nút Share và bấm nút "Sao chép liên kết" (Copy link)
 */
async function shareAndCopyLink(page) {
  if (!CONFIG.autoCopyLink) return false;

  try {
    // 1. Tìm và click nút Share của video đang phát
    const shareClicked = await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('video'));
      let activeVideo = null;
      for (const v of videos) {
        const rect = v.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (midY >= 0 && midY <= window.innerHeight && rect.height > 100) {
          activeVideo = v;
          break;
        }
      }
      if (!activeVideo && videos.length > 0) activeVideo = videos[0];
      if (!activeVideo) return false;

      const vMidY = activeVideo.getBoundingClientRect().top + activeVideo.getBoundingClientRect().height / 2;

      const shareSelectors = [
        '[data-e2e="share-icon"]',
        '[data-e2e="feed-share-icon"]',
        '[data-e2e="browse-share-icon"]',
        '[data-e2e*="share" i]',
        '[data-e2e="video-share-container"] button',
        'button[aria-label*="Share" i]',
        'button[aria-label*="Chia sẻ" i]',
        'button[title*="Share" i]',
        'button[title*="Chia sẻ" i]'
      ];

      const candidates = [];
      for (const sel of shareSelectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const btn = el.closest('button') || el;
          if (!candidates.includes(btn)) candidates.push(btn);
        });
      }

      // Quét thêm các button lân cận trong cột action bar gần video
      const allButtons = Array.from(document.querySelectorAll('button'));
      const nearButtons = allButtons.filter((b) => {
        const r = b.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > window.innerHeight) return false;
        return Math.abs((r.top + r.height / 2) - vMidY) < 400;
      });
      for (const b of nearButtons) {
        const text = (b.innerText || '').toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const e2e = (b.getAttribute('data-e2e') || '').toLowerCase();
        if (text.includes('chia sẻ') || text.includes('share') ||
            aria.includes('chia sẻ') || aria.includes('share') ||
            e2e.includes('share')) {
          if (!candidates.includes(b)) candidates.push(b);
        }
      }

      let bestBtn = null;
      let minDiff = Infinity;
      for (const btn of candidates) {
        const bRect = btn.getBoundingClientRect();
        if (bRect.height === 0 || bRect.width === 0) continue;
        if (bRect.bottom < 0 || bRect.top > window.innerHeight) continue;
        const diff = Math.abs((bRect.top + bRect.height / 2) - vMidY);
        if (diff < minDiff) {
          minDiff = diff;
          bestBtn = btn;
        }
      }

      if (bestBtn) {
        // Hover hoặc click để kích hoạt menu Share
        bestBtn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        bestBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        bestBtn.click();
        return true;
      }
      return false;
    });

    if (!shareClicked) {
      console.log('\n   ⚠️ Không tìm thấy nút Share gần video.');
      // Chụp ảnh lại màn hình để bạn kiểm tra nguyên nhân
      const screenshotsDir = path.join(__dirname, 'screenshots');
      if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
      const shotPath = path.join(screenshotsDir, `tiktok_no_share_${Date.now()}.png`);
      await page.screenshot({ path: shotPath }).catch(() => {});
      console.log(`   📸 Đã chụp màn hình lưu tại: ${shotPath}`);

      // In thông tin các nút đang có gần video để chẩn đoán
      const debugButtons = await page.evaluate(() => {
        const v = document.querySelector('video');
        const vMidY = v ? (v.getBoundingClientRect().top + v.getBoundingClientRect().height / 2) : (window.innerHeight / 2);
        return Array.from(document.querySelectorAll('button'))
          .map((b) => {
            const r = b.getBoundingClientRect();
            return {
              text: (b.innerText || '').trim().slice(0, 25),
              aria: b.getAttribute('aria-label') || '',
              dataE2e: b.getAttribute('data-e2e') || '',
              yDiff: Math.round(Math.abs((r.top + r.height / 2) - vMidY)),
              visible: r.width > 0 && r.height > 0
            };
          })
          .filter((b) => b.visible && b.yDiff < 450)
          .slice(0, 8);
      }).catch(() => []);
      if (debugButtons.length > 0) {
        console.log('   🔍 Các nút gần video:', JSON.stringify(debugButtons));
      }
      return false;
    }

    console.log('\n   📤 Đã mở hộp thoại "Chia sẻ đến", đang tìm nút "Copy"...');

    // Cài hook bắt link trực tiếp khi TikTok thực hiện sao chép
    await page.evaluate(() => {
      window.__capturedTikTokLink = '';
      if (!window.__tiktokClipboardHooked) {
        window.__tiktokClipboardHooked = true;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
          navigator.clipboard.writeText = async (text) => {
            if (text) window.__capturedTikTokLink = text;
            return origWrite(text).catch(() => {});
          };
        }
        if (document.execCommand) {
          const origExec = document.execCommand.bind(document);
          document.execCommand = function(cmd, ...args) {
            if (cmd === 'copy') {
              const sel = window.getSelection()?.toString();
              if (sel && sel.includes('tiktok.com')) window.__capturedTikTokLink = sel;
              const el = document.activeElement;
              if (el && (el.value || el.innerText)) {
                const val = el.value || el.innerText;
                if (val && val.includes('tiktok.com')) window.__capturedTikTokLink = val;
              }
            }
            return origExec(cmd, ...args);
          };
        }
        document.addEventListener('copy', (e) => {
          try {
            if (e.clipboardData && e.clipboardData.setData) {
              const origSet = e.clipboardData.setData.bind(e.clipboardData);
              e.clipboardData.setData = function(type, val) {
                if (val && typeof val === 'string' && val.includes('tiktok.com')) {
                  window.__capturedTikTokLink = val;
                }
                return origSet(type, val);
              };
            }
            const data = window.getSelection()?.toString();
            if (data && data.includes('tiktok.com')) window.__capturedTikTokLink = data;
          } catch (_) {}
        }, true);
      }
    });
    await page.waitForTimeout(700);

    // 2. Tìm và click nút "Copy" / "Sao chép liên kết"
    const copyResult = await page.evaluate(() => {
      // Tìm các phần tử chứa chữ "Copy" hoặc "Sao chép liên kết"
      const allElements = Array.from(document.querySelectorAll('button, div, span, li, a, [role="button"], [role="menuitem"], p'));
      const copyBtn = allElements.find((el) => {
        const text = (el.innerText || el.textContent || '').trim();
        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const isMatch = (text.length <= 40 && /(Copy|Sao chép liên kết|Sao chép|Copy link)/i.test(text)) ||
                        /(Copy|Sao chép liên kết|Copy link)/i.test(aria) ||
                        /(Copy|Sao chép liên kết|Copy link)/i.test(title);
        if (!isMatch) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      if (copyBtn) {
        // Bấm vào nút hoặc khối bao ngoài của icon Copy
        const clickTarget = copyBtn.closest('button, [role="button"], div[class*="item"], div[class*="action"]') || copyBtn;
        clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        clickTarget.click();
        return { success: true, text: copyBtn.innerText || 'Copy' };
      }

      // Fallback: tìm theo thuộc tính data-e2e
      const byDataE2e = document.querySelector('[data-e2e="share-copy-link"], [data-e2e*="copy" i]');
      if (byDataE2e) {
        byDataE2e.click();
        return { success: true, text: 'data-e2e' };
      }

      return { success: false };
    });

    let copyButtonFound = copyResult.success;
    if (copyResult.success) {
      console.log(`   🔗 Đã bấm "${copyResult.text || 'Copy'}" thành công!`);
    } else {
      console.log('   ℹ️ Đang thử bộ chọn Playwright cho nút "Copy"...');
      const copyLocator = page.locator('button, [role="button"], div, span')
        .filter({ hasText: /^(Copy|Sao chép liên kết|Sao chép|Copy link)$/i })
        .last();
      if (await copyLocator.isVisible().catch(() => false)) {
        await copyLocator.click({ force: true }).catch(() => {});
        copyButtonFound = true;
        console.log('   🔗 Đã bấm nút "Copy" qua Playwright!');
      } else {
        console.log('   ❌ Không tìm thấy nút "Copy" / "Sao chép liên kết".');
      }
    }

    // Không đoán một mục bất kỳ trong menu là Copy. Video không có nút Copy
    // phải được xử lý bằng cách khởi động lại toàn bộ script.
    if (!copyButtonFound) {
      const screenshotsDir = path.join(__dirname, 'screenshots');
      if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
      const shotPath = path.join(screenshotsDir, `tiktok_no_copy_button_${Date.now()}.png`);
      await page.screenshot({ path: shotPath }).catch(() => {});
      console.log(`   📸 Đã chụp màn hình lưu tại: ${shotPath}`);
      return false;
    }

    // 3. Đọc link vừa copy và in log ra màn hình
    await page.waitForTimeout(600);

    // Cách 1: Đọc từ biến hook đã bắt được khi TikTok gọi copy/clipboard
    let copiedLink = await page.evaluate(() => window.__capturedTikTokLink || '').catch(() => '');

    // Cách 2: Đọc qua navigator.clipboard.readText (sau khi focus trang)
    if (!copiedLink) {
      await page.bringToFront().catch(() => {});
      await page.evaluate(() => window.focus()).catch(() => {});
      copiedLink = await page.evaluate(async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text && text.includes('tiktok.com')) return text.trim();
        } catch (_) {}
        return '';
      }).catch(() => '');
    }

    // Cách 3: Quét trong dialog hoặc input của TikTok
    if (!copiedLink) {
      copiedLink = await page.evaluate(() => {
        const dialogEls = Array.from(document.querySelectorAll('[role="dialog"] input, [role="dialog"] a, [role="dialog"] p, [role="dialog"] span'));
        for (const el of dialogEls) {
          const val = el.value || el.href || el.innerText || '';
          if (val && val.includes('tiktok.com/@') && val.includes('/video/')) return val.trim();
        }
        for (const el of dialogEls) {
          const val = el.value || el.href || el.innerText || '';
          if (val && val.includes('tiktok.com')) return val.trim();
        }
        return '';
      }).catch(() => '');
    }

    // Cách 4: Quét tìm tất cả các thẻ link chứa /video/ trên trang và chọn thẻ gần video đang xem nhất
    if (!copiedLink) {
      copiedLink = await page.evaluate(() => {
        const videos = Array.from(document.querySelectorAll('video'));
        let activeVideo = null;
        for (const v of videos) {
          const rect = v.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          if (midY >= 0 && midY <= window.innerHeight && rect.height > 100) {
            activeVideo = v;
            break;
          }
        }
        if (!activeVideo && videos.length > 0) activeVideo = videos[0];
        if (!activeVideo) return '';

        const vMidY = activeVideo.getBoundingClientRect().top + activeVideo.getBoundingClientRect().height / 2;

        const allLinks = Array.from(document.querySelectorAll('a[href*="/video/"]'));
        let best = '';
        let minDiff = Infinity;
        for (const a of allLinks) {
          const r = a.getBoundingClientRect();
          const diff = Math.abs((r.top + r.height / 2) - vMidY);
          if (diff < minDiff) {
            minDiff = diff;
            best = a.href;
          }
        }
        if (best) return best;

        const inputs = Array.from(document.querySelectorAll('input'));
        for (const inp of inputs) {
          if (inp.value && inp.value.includes('tiktok.com')) return inp.value;
        }

        return '';
      }).catch(() => '');
    }

    // Cách 5: Kiểm tra URL hiện tại nếu đang ở trang chi tiết video
    if (!copiedLink && page.url().includes('/video/')) {
      copiedLink = page.url();
    }

    // Đóng hộp thoại "Chia sẻ đến" để không che màn hình
    await page.waitForTimeout(400);
    const closeDialogBtn = page.locator('[role="dialog"], [class*="modal" i]')
      .locator('[aria-label*="close" i], [aria-label*="đóng" i], button:has-text("X"), svg')
      .first();
    if (await closeDialogBtn.isVisible().catch(() => false)) {
      await closeDialogBtn.click({ force: true }).catch(() => {});
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);

    if (copiedLink && copiedLink.startsWith(TIKTOK_URL_PREFIX)) {
      console.log(`   📋 [LINK ĐÃ COPY]: \x1b[32m\x1b[1m${copiedLink}\x1b[0m`);
      return true;
    } else {
      console.log(`   ❌ Link copy không hợp lệ: ${copiedLink || '(trống)'}. Link phải bắt đầu bằng ${TIKTOK_URL_PREFIX}`);
      const screenshotsDir = path.join(__dirname, 'screenshots');
      if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
      const shotPath = path.join(screenshotsDir, `tiktok_no_copy_${Date.now()}.png`);
      await page.screenshot({ path: shotPath }).catch(() => {});
      console.log(`   📸 Đã chụp màn hình lưu tại: ${shotPath}`);
      return false;
    }
  } catch (err) {
    console.log(`\n   ⚠️ Lỗi copy link: ${err.message}`);
  }
  return false;
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
    targetWatchTime = Math.min(duration, CONFIG.maxWatchSeconds);
    console.log(`⏱️ Thời lượng video: ${Math.round(duration)}s (Mục tiêu xem: ${Math.round(targetWatchTime)}s)`);
  } else {
    targetWatchTime = 15;
    console.log(`⏱️ Video không có thời lượng cố định (hoặc Live) -> Xem ${targetWatchTime}s`);
  }

  // Vòng lặp theo dõi tiến độ phát
  const startTime = Date.now();
  let prevCurrentTime = -1;
  let hasLooped = false;
  let hasInteracted = false; // Đã thả tim và copy link chưa

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

    // =========================================================================
    // ĐIỀU KIỆN: KHI VIDEO GẦN HẾT -> THẢ TIM VÀ COPY LINK
    // =========================================================================
    const currentProg = isFiniteDuration ? (status.currentTime / duration) : (elapsedSeconds / targetWatchTime);
    const remainingSec = isFiniteDuration ? (duration - status.currentTime) : (targetWatchTime - elapsedSeconds);

    const isNearEnd = (currentProg >= CONFIG.interactionThresholdRatio) || (remainingSec <= CONFIG.interactionRemainingSeconds);

    if (!hasInteracted && isNearEnd && elapsedSeconds >= CONFIG.minWatchSeconds) {
      hasInteracted = true;
      console.log(`\n🎯 Video đã phát gần hết (${Math.round(currentProg * 100)}%) -> Thực hiện tương tác:`);
      
      // 1. Thả tim
      await likeActiveVideo(page);
      await randomDelay(600, 1000);

      // 2. Mở Share và bấm Copy link
      const copySuccess = await shareAndCopyLink(page);
      if (!copySuccess && CONFIG.autoCopyLink) {
        return { success: false, restartRequired: true };
      }
      await randomDelay(500, 800);
    }

    // Điều kiện kết thúc video:
    // 1. Thuộc tính ended = true
    // 2. Video phát gần hết (còn < 0.6s)
    // 3. Video đã tự lặp lại (loop về 0)
    // 4. Đã xem đủ thời gian mục tiêu hoặc chạm ngưỡng tối đa
    if (status.ended) {
      console.log(`\n✅ Video đã kết thúc!`);
      break;
    }
    if (isFiniteDuration && status.currentTime >= duration - 0.6) {
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

  // Đảm bảo nếu vì lý do gì video kết thúc quá nhanh mà chưa kịp tương tác thì tương tác ngay
  if (!hasInteracted) {
    hasInteracted = true;
    console.log(`\n🎯 Video kết thúc -> Bổ sung tương tác:`);
    await likeActiveVideo(page);
    await randomDelay(500, 800);
    const copySuccess = await shareAndCopyLink(page);
    if (!copySuccess && CONFIG.autoCopyLink) {
      return { success: false, restartRequired: true };
    }
  }

  // Nghỉ tự nhiên ngẫu nhiên 0.8s - 2s trước khi lướt tiếp
  const delayMs = Math.floor(Math.random() * 1200) + 800;
  console.log(`😴 Dừng lại ${Math.round(delayMs / 100) / 10}s rồi lướt tiếp...`);
  await page.waitForTimeout(delayMs);
  return { success: true, restartRequired: false };
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
  await page.evaluate(() => {
    window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
  }).catch(() => {});

  await page.waitForTimeout(1500);
}

async function main() {
  // Chỉ để 1 bản tiktok_watch chạy: dừng các bản cũ (kể cả bản chạy ngầm) và Chrome của hồ sơ TikTok
  killPreviousInstances({ script: 'tiktok_watch.js', profilePattern: /^user_data_tiktok$/, label: 'tiktok_watch' });

  console.log('====================================================');
  console.log('🚀 TỰ ĐỘNG XEM, THẢ TIM, COPY LINK & LƯỚT TIKTOK');
  console.log('====================================================');

  console.log(`🌐 Khởi chạy trình duyệt (${CONFIG.headless ? 'Ẩn cửa sổ / Chạy ngầm' : 'Hiện cửa sổ'})...`);
  if (CONFIG.headless) {
    console.log('💡 Đang chạy ở chế độ ẩn cửa sổ: Tiến trình sẽ in trực tiếp tại đây. Bấm Ctrl + C để dừng.');
  }

  // Dừng hẳn khi bấm Ctrl + C. Restart tự động chạy lại trong cùng tiến trình này
  // (không spawn tiến trình mới) nên Ctrl + C luôn dừng được script.
  let context = null;
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n👋 Đang đóng trình duyệt chạy ngầm và dừng chương trình...');
    if (context) await context.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  let count = 0;
  while (!stopping) {
    const session = await launchTikTok({ headless: CONFIG.headless });
    context = session.context;
    const page = session.page;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});

    // Cài hook bắt link ngay từ khi trang bắt đầu tải
    await page.addInitScript(() => {
      window.__capturedTikTokLink = '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async (text) => {
          if (text) window.__capturedTikTokLink = text;
          return origWrite(text).catch(() => {});
        };
      }
      if (document.execCommand) {
        const origExec = document.execCommand.bind(document);
        document.execCommand = function(cmd, ...args) {
          if (cmd === 'copy') {
            const sel = window.getSelection()?.toString();
            if (sel && sel.includes('tiktok.com')) window.__capturedTikTokLink = sel;
            const el = document.activeElement;
            if (el && (el.value || el.innerText)) {
              const val = el.value || el.innerText;
              if (val && val.includes('tiktok.com')) window.__capturedTikTokLink = val;
            }
          }
          return origExec(cmd, ...args);
        };
      }
      document.addEventListener('copy', (e) => {
        try {
          if (e.clipboardData && e.clipboardData.setData) {
            const origSet = e.clipboardData.setData.bind(e.clipboardData);
            e.clipboardData.setData = function(type, val) {
              if (val && typeof val === 'string' && val.includes('tiktok.com')) {
                window.__capturedTikTokLink = val;
              }
              return origSet(type, val);
            };
          }
          const text = e.clipboardData?.getData('text/plain') || window.getSelection()?.toString();
          if (text && text.includes('tiktok.com')) window.__capturedTikTokLink = text;
        } catch (_) {}
      }, true);
    }).catch(() => {});

    let browserClosed = false;
    let restartReason = '';
    context.on('close', () => {
      browserClosed = true;
      if (!stopping && !restartReason) console.log('\n👋 Trình duyệt đã được đóng. Dừng chương trình.');
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
      while (!stopping && !browserClosed) {
        count++;
        if (CONFIG.maxVideos > 0 && count > CONFIG.maxVideos) {
          console.log(`\n🎉 Đã hoàn thành xem ${CONFIG.maxVideos} video theo cấu hình!`);
          break;
        }

        const result = await watchCurrentVideo(page, count);

        if (stopping || browserClosed) break;

        if (result && result.restartRequired) {
          restartReason = 'Không có nút Copy hoặc link không đúng định dạng.';
          break;
        }

        if (CONFIG.recycleEvery > 0 && count % CONFIG.recycleEvery === 0) {
          restartReason = `Đã xem ${count} video, mở lại Chrome để giải phóng RAM.`;
          break;
        }

        await scrollToNextVideo(page);
      }
    } catch (error) {
      if (!stopping && !browserClosed) {
        console.error('❌ Lỗi:', error.message);
      }
    }

    if (stopping) return;
    await context.close().catch(() => {});
    if (!restartReason) break;

    // Đóng hẳn Chrome rồi mở lại. Không dùng page.reload() để tránh giữ
    // trạng thái lỗi của video/menu Share hiện tại, và để trả lại toàn bộ RAM của Chrome.
    console.log(`\n🔄 [TỰ ĐỘNG RESTART] ${restartReason}`);
    console.log('🔄 Đang đóng Chrome và khởi động lại...');
  }
}

main();
