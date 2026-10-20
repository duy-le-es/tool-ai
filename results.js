const path = require('path');
const fs = require('fs');

// Hook cài vào mọi frame (trang chính flow.google.com + iframe applet):
//  - Ghi lại link tải (thẻ <a download>, blob:, data:, window.open) và CHẶN lượt tải của Chrome:
//    Chrome bị sập khi tự tải file blob video của Flow -> bot tự đọc blob rồi lưu file.
//  - Giữ blob không bị xoá (Flow gọi URL.revokeObjectURL ngay sau khi bấm tải -> fetch lại sẽ "Failed to fetch").
//  - Ghi lại text được COPY (nút COPY caption).
function installCaptureHooks() {
  if (window.__bot) return;
  window.__bot = { downloads: [], copied: [], blobs: {} };
  const record = (href, name) => {
    if (href) window.__bot.downloads.push({ href: String(href), name: name || '', ts: Date.now() });
  };
  const isDownloadLink = (a) => a.hasAttribute('download') || /^(blob|data):/.test(a.href);

  URL.revokeObjectURL = () => {};

  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    if (isDownloadLink(this)) {
      record(this.href, this.download);
      return undefined; // không cho Chrome tự tải
    }
    return origClick.apply(this, args);
  };
  // Trang có thể kích hoạt tải bằng a.dispatchEvent(new MouseEvent('click')) với thẻ <a> không gắn vào trang
  const origDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (ev) {
    if (this instanceof HTMLAnchorElement && ev && ev.type === 'click' && isDownloadLink(this)) {
      record(this.href, this.download);
      return false;
    }
    return origDispatch.call(this, ev);
  };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a');
    if (a && isDownloadLink(a)) {
      record(a.href, a.download);
      e.preventDefault();
    }
  }, true);

  // Một số trang gọi window.close() sau khi bấm tải -> với trang do Playwright mở, lệnh này đóng thật cả tab bot đang dùng
  window.close = () => { window.__bot.closeAttempts = (window.__bot.closeAttempts || 0) + 1; };

  const origOpen = window.open;
  window.open = function (url, ...rest) {
    if (/^(blob|data):/.test(String(url))) {
      record(url, '');
      return null; // mở blob ở tab mới cũng là 1 kiểu tải -> tự xử lý
    }
    record(url, '');
    return origOpen.call(this, url, ...rest);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => {
      window.__bot.copied.push({ text: String(text), ts: Date.now() });
      return origWrite(text).catch(() => {});
    };
  }
  document.addEventListener('copy', (e) => {
    const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || String(window.getSelection() || '');
    if (text) window.__bot.copied.push({ text, ts: Date.now() });
  }, true);
}

async function installHooksAllFrames(page) {
  await Promise.all(page.frames().map((f) => f.evaluate(installCaptureHooks).catch(() => {})));
}

// Gom các mục (downloads / copied) mà hook ghi được SAU thời điểm since, từ tất cả frame
async function collectHooked(page, key, since) {
  const all = [];
  for (const frame of page.frames()) {
    const items = await frame.evaluate(([k, t]) => (window.__bot ? window.__bot[k].filter((x) => x.ts >= t) : []), [key, since]).catch(() => []);
    for (const it of items) all.push({ ...it, frame });
  }
  return all.sort((x, y) => x.ts - y.ts);
}

// blob:https://flow.google.com/... chỉ đọc được từ frame cùng origin (trang chính), không đọc được từ iframe applet
function frameForBlob(page, href, preferred) {
  const m = String(href).match(/^blob:(https?:\/\/[^/]+)/);
  if (!m) return preferred || page.mainFrame();
  const sameOrigin = page.frames().find((f) => {
    try { return new URL(f.url()).origin === m[1]; } catch (_) { return false; }
  });
  return sameOrigin || preferred || page.mainFrame();
}

// Tìm frame chứa phần tử có text khớp regex (ưu tiên iframe applet)
async function findFrameWith(page, regex) {
  const frames = [...page.frames().filter((f) => f !== page.mainFrame()), page.mainFrame()];
  for (const frame of frames) {
    try {
      if (await frame.getByText(regex).first().isVisible()) return frame;
    } catch (_) {}
  }
  return null;
}

// Trình duyệt bị đóng giữa chừng (đóng tay cửa sổ Chrome hoặc Chrome crash) -> dừng ngay, báo rõ
function browserClosedError(page) {
  const reason = page.__closeReason || 'cửa sổ Chrome bị đóng hoặc Chrome bị crash';
  return new Error(`Trình duyệt đã bị đóng giữa chừng (${reason}). Đừng đóng cửa sổ Chrome khi bot đang chạy.`);
}

function assertAlive(page) {
  if (page.isClosed()) throw browserClosedError(page);
}

const EXT_BY_MIME = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

// Nhận loại file từ vài byte đầu (blob của Flow không ghi MIME type -> trước đây bị lưu thành .bin)
function sniffExt(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return '.mp4';
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return '.webm';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return '.png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return '.gif';
  return '';
}

// Tải nội dung 1 link bị bắt được: blob:/data: thì đọc trong frame cùng origin, http(s) thì dùng request của context (có cookie).
// Blob đọc theo từng phần 4MB để video lớn không làm nghẽn kết nối tới trình duyệt.
const CHUNK = 4 * 1024 * 1024;
async function saveHref(page, frame, href, destNoExt, suggestedName = '') {
  let buffer;
  let mime = '';
  if (/^(blob|data):/.test(href)) {
    const f = frameForBlob(page, href, frame);
    const key = `k${Date.now()}`;
    const info = await f.evaluate(async ([u, k]) => {
      const blob = await (await fetch(u)).blob();
      window.__bot = window.__bot || { downloads: [], copied: [], blobs: {} };
      window.__bot.blobs[k] = blob;
      return { size: blob.size, type: blob.type };
    }, [href, key]);
    const parts = [];
    for (let off = 0; off < info.size; off += CHUNK) {
      const b64 = await f.evaluate(async ([k, start, end]) => {
        const part = window.__bot.blobs[k].slice(start, end);
        return new Promise((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1] || '');
          r.readAsDataURL(part);
        });
      }, [key, off, off + CHUNK]);
      parts.push(Buffer.from(b64, 'base64'));
    }
    await f.evaluate((k) => { delete window.__bot.blobs[k]; }, key).catch(() => {});
    buffer = Buffer.concat(parts);
    mime = info.type;
  } else {
    const resp = await page.context().request.get(href);
    if (!resp.ok()) throw new Error(`Tải ${href.slice(0, 80)} lỗi HTTP ${resp.status()}`);
    buffer = await resp.body();
    mime = (resp.headers()['content-type'] || '').split(';')[0];
  }
  if (!buffer || buffer.length === 0) throw new Error('File tải về rỗng');
  const extFromUrl = /^https?:/.test(href) ? path.extname(new URL(href).pathname) : '';
  // Ưu tiên: byte đầu file -> MIME -> đuôi tên file gợi ý (vd tiktok-pro-xxx.mp4) -> đuôi trong URL
  const ext = sniffExt(buffer) || EXT_BY_MIME[mime] || path.extname(suggestedName).toLowerCase() || extFromUrl || '.bin';
  const dest = destNoExt + ext;
  fs.writeFileSync(dest, buffer);
  console.error(`💾 Đã lưu ${path.basename(dest)} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
  return dest;
}

// Bấm 1 nút tải và bắt file bằng mọi đường: sự kiện download của Playwright, popup, hoặc link bị hook bắt được
async function clickAndCaptureFile(page, frame, button, destNoExt, waitMs = 20000) {
  await installHooksAllFrames(page);
  const since = Date.now();

  let download = null;
  let popup = null;
  const onDownload = (d) => { download = d; };
  const onPage = (p) => { popup = p; };
  page.on('download', onDownload);
  page.context().on('page', onPage);

  try {
    await button.scrollIntoViewIfNeeded();
    await button.click();

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      // Ưu tiên link bắt được bằng hook (blob:/data:/http) -> tự tải, không phụ thuộc trình tải xuống của Chrome
      const hooked = await collectHooked(page, 'downloads', since);
      if (hooked.length > 0) {
        const last = hooked[hooked.length - 1];
        console.error(`⬇️ Bắt được link tải: ${last.name || ''} (${last.href.slice(0, 80)})`);
        return await saveHref(page, last.frame, last.href, destNoExt, last.name);
      }
      if (download) {
        const url = download.url();
        console.error(`⬇️ Chrome bắt đầu tải: ${download.suggestedFilename()} (${url.slice(0, 80)})`);
        const dest = destNoExt + (path.extname(download.suggestedFilename()) || '.bin');
        // Huỷ NGAY lượt tải của Chrome (Chrome từng bị sập khi tải blob video), rồi tự tải thẳng từ link
        if (/^(https?|blob|data):/.test(url)) {
          await download.cancel().catch(() => {});
          try {
            return await saveHref(page, frame, url, destNoExt, download.suggestedFilename());
          } catch (e) {
            if (page.isClosed()) throw browserClosedError(page);
            console.error('⚠️ Tự tải từ link lỗi:', e.message.split('\n')[0]);
            throw e;
          }
        }
        try {
          await download.saveAs(dest);
          return dest;
        } catch (e) {
          if (page.isClosed()) throw browserClosedError(page);
          throw e;
        }
      }
      if (popup) {
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        const url = popup.url();
        console.error(`🪟 Nút tải mở tab mới: ${url.slice(0, 80)}`);
        if (url && url !== 'about:blank') {
          await popup.close().catch(() => {});
          return await saveHref(page, frame, url, destNoExt);
        }
      }
      assertAlive(page);
      await page.waitForTimeout(500);
    }
    return null;
  } finally {
    page.off('download', onDownload);
    page.context().off('page', onPage);
  }
}

async function clickAndCaptureCopy(page, frame, button) {
  await installHooksAllFrames(page);
  const since = Date.now();
  await button.scrollIntoViewIfNeeded();
  await button.click();
  for (let i = 0; i < 20; i++) {
    const copied = await collectHooked(page, 'copied', since);
    if (copied.length > 0) return copied[copied.length - 1].text;
    await page.waitForTimeout(250);
  }
  // Phương án cuối: đọc clipboard hệ thống (đã cấp quyền clipboard-read khi mở trình duyệt)
  return page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
}

// Tool UI mới không nhất thiết còn dòng "Checklist đăng TikTok Shop". Dò trực
// tiếp nút tải video, còn marker cũ chỉ giữ làm tín hiệu bổ sung.
const RESULT_MARKER = /checklist đăng tiktok shop/i;
const BTN_VIDEO = /^\s*(tải ngay|tải video|download video|download)\s*$/i;
const BTN_CAPTION = /^\s*copy\s*$/i;
const BTN_THUMB = /^\s*lưu ảnh\s*$/i;

async function findResultFrame(page) {
  const byLegacyMarker = await findFrameWith(page, RESULT_MARKER);
  if (byLegacyMarker) return byLegacyMarker;

  // Sau khi render, UI cũ và mới đều có CTA tải video. Không phụ thuộc vào
  // một đoạn chữ mô tả cố định vốn rất dễ đổi theo phiên bản Flow.
  for (const frame of [...page.frames().filter((f) => f !== page.mainFrame()), page.mainFrame()]) {
    const button = frame.getByText(BTN_VIDEO).first();
    if (await button.isVisible().catch(() => false)) return frame;
  }
  return null;
}

// Đợi trang kết quả, rồi tải video + thumbnail + caption về outDir.
// Nút "TẢI NGAY" có thể hiện sẵn trước khi video render xong, nên cứ thử tải lại định kỳ tới khi được file.
async function waitAndCollectResults(page, outDir, { timeoutMs, onProgress = () => {}, checkError = async () => {} }) {
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const minutes = () => Math.round((Date.now() - startedAt) / 60000);
  let lastReport = 0;

  const files = { video: null, thumbnail: null, caption: null, captionText: null };
  let frame = null;

  while (Date.now() < deadline && !files.video) {
    assertAlive(page);
    frame = await findResultFrame(page);
    // Lỗi render (khung đỏ trên applet) -> dừng ngay, không chờ hết timeout.
    // Đã có trang kết quả thì bỏ qua: chữ trên checklist dễ bị bắt nhầm là lỗi.
    if (!frame) await checkError();
    if (frame) {
      const btn = frame.getByText(BTN_VIDEO).first();
      if (await btn.isVisible().catch(() => false)) {
        console.error('📥 Đã thấy nút tải video, đang tải...');
        files.video = await clickAndCaptureFile(page, frame, btn, path.join(outDir, 'video')).catch((e) => {
          if (page.isClosed()) throw browserClosedError(page);
          console.error('⚠️ Tải video chưa được:', e.message.split('\n')[0]);
          return null;
        });
        if (files.video) break;
      }
    }
    if (Date.now() - lastReport > 60000) {
      lastReport = Date.now();
      console.error(`⏳ Đang đợi video render... (${minutes()} phút)`);
      if (minutes() > 0) onProgress(`⏳ Đang đợi video render... (${minutes()} phút)`);
    }
    assertAlive(page);
    await page.waitForTimeout(15000).catch(() => assertAlive(page));
  }

  if (!files.video) {
    const screenshotPath = path.join(outDir, 'render_timeout.png');
    await page.screenshot({ path: screenshotPath }).catch(() => {});
    throw new Error(`Hết ${Math.round(timeoutMs / 60000)} phút mà chưa tải được video (đã lưu trạng thái tại ${screenshotPath})`);
  }
  console.error(`🎞️ Đã tải video: ${files.video}`);

  const captionBtn = frame.getByText(BTN_CAPTION).first();
  if (await captionBtn.isVisible().catch(() => false)) {
    files.captionText = await clickAndCaptureCopy(page, frame, captionBtn);
    if (files.captionText) {
      files.caption = path.join(outDir, 'caption.txt');
      fs.writeFileSync(files.caption, files.captionText, 'utf8');
      console.error('📝 Đã lưu caption & hashtags');
    }
  }

  const thumbBtn = frame.getByText(BTN_THUMB).first();
  if (await thumbBtn.isVisible().catch(() => false)) {
    files.thumbnail = await clickAndCaptureFile(page, frame, thumbBtn, path.join(outDir, 'thumbnail')).catch((e) => {
      console.error('⚠️ Tải thumbnail lỗi:', e.message);
      return null;
    });
    if (files.thumbnail) console.error(`🖼️ Đã tải thumbnail: ${files.thumbnail}`);
  }

  return files;
}

module.exports = { installCaptureHooks, waitAndCollectResults };
