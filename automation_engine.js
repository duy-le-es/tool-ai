const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { installCaptureHooks, waitAndCollectResults } = require('./results');
require('dotenv').config();

const FLOW_TOOL_URL = process.env.FLOW_TOOL_URL || 'https://flow.google.com/project/856dd52d-7081-4b09-8a04-b32e7b5b6a0d/tool/0f719f8f-3aa3-4c8a-8b73-edb5ecd9fa7b';
const USER_DATA_DIR = path.join(__dirname, 'user_data');
const HEADLESS = process.env.HEADLESS === 'true';
const RENDER_TIMEOUT_MIN = Number(process.env.RENDER_TIMEOUT_MIN) || 10;
const FLOW_LOAD_TIMEOUT_MS = (Number(process.env.FLOW_LOAD_TIMEOUT_SEC) || 120) * 1000;

// Giao diện tool chạy trong iframe sandbox (flow-applet-runner). Trang chính của Flow cũng có 1 bản sao
// các nút nằm BÊN DƯỚI iframe (bấm vào sẽ bị iframe / loading-overlay chặn) -> chỉ nhận phần tử
// thật sự bấm được: điểm giữa của nó không bị phần tử nào khác trong cùng frame che.
async function isClickable(loc) {
  // Cuộn tới phần tử trước: elementFromPoint trả về null với điểm nằm ngoài màn hình
  await loc.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!top && (top === el || el.contains(top) || top.contains(el));
  }).catch(() => false);
}

// Flow hiện lớp "loading-overlay" che applet trong lúc applet đang tải / đang xử lý.
// Lớp này có thể vẫn nằm trong DOM sau khi tải xong (ẩn bằng opacity / pointer-events) -> kiểm tra nó có THẬT SỰ che không.
async function isAppletLoading(page) {
  return page.evaluate(() => [...document.querySelectorAll('.loading-overlay')].some((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05 || cs.pointerEvents === 'none') return false;
    if (r.width === 0 || r.height === 0) return false;
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!top && (top === el || el.contains(top));
  })).catch(() => false);
}

// In ra trạng thái tìm nút ở từng frame (dùng khi không tìm thấy, để biết kẹt ở đâu)
async function describeSearch(page, texts) {
  const lines = [`loading-overlay đang che: ${await isAppletLoading(page)}`];
  for (const frame of page.frames()) {
    const name = frame === page.mainFrame() ? 'main' : frame.url().slice(0, 70);
    for (const text of texts) {
      const loc = frame.getByText(text).first();
      const count = await frame.getByText(text).count().catch(() => 0);
      if (count === 0) continue;
      const visible = await loc.isVisible().catch(() => false);
      const clickable = visible && (await isClickable(loc));
      const tag = await loc.evaluate((e) => e.tagName).catch(() => '?');
      lines.push(`[${name}] "${text}": ${count} phần tử, <${tag}> visible=${visible} clickable=${clickable}`);
    }
  }
  return lines.join('\n');
}

// buttonsOnly: chỉ nhận <button>/[role=button] chứa chữ. Dùng cho CTA có chữ trùng với
// tiêu đề khác trong applet (vd phụ đề "SẢN XUẤT VIDEO 16S HOÀN CHỈNH • ..." ở đầu trang).
async function findInFrames(page, texts, { timeout = 30000, buttonsOnly = false } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await isAppletLoading(page))) {
      const frames = [...page.frames().filter((f) => f !== page.mainFrame()), page.mainFrame()];
      for (const frame of frames) {
        for (const text of texts) {
          const loc = buttonsOnly
            ? frame.locator('button, [role="button"]').filter({ hasText: text }).first()
            : frame.getByText(text).first();
          try {
            if (await loc.isVisible() && await isClickable(loc)) return loc;
          } catch (_) {}
        }
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

const FLOW_DURATION_LABELS = {
  '16s': ['16s (Mặc định - Chuẩn TikTok Viral)', '16s (Mặc định', '16s'],
  '10s': ['10s (Bản rút gọn)', '10s'],
  '20s': ['20s (2 phân đoạn 10s)', '20s (2 phân đoạn)', '20s'],
  '26s': ['26s (Video dài chi tiết)', '26s']
};

async function selectFlowDuration(page, durationKey = '20s') {
  if (!FLOW_DURATION_LABELS[durationKey]) durationKey = '20s';
  const targetLabels = FLOW_DURATION_LABELS[durationKey];

  const durationTrigger = await findInFrames(page, [
    /^(10s|16s|20s|26s)\b/i,
    '20s (2 phân đoạn',
    '16s (Mặc định'
  ], { timeout: 4000 });

  if (!durationTrigger) return;
  const currentText = (await durationTrigger.textContent().catch(() => '')).trim();
  if (currentText.toLowerCase().startsWith(durationKey.toLowerCase())) return;

  await durationTrigger.click();
  await page.waitForTimeout(600);
  const optionBtn = await findInFrames(page, targetLabels, { timeout: 4000 });
  if (optionBtn) {
    await optionBtn.click();
    await page.waitForTimeout(600);
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
}

// Bấm "Thêm ảnh" trong applet -> Flow mở hộp chọn asset -> "Upload media" -> chọn ảnh vừa tải -> hộp đóng.
async function uploadViaAssetPicker(page, imagePath, screenshotsDir) {
  const addPhotoBtn = await findInFrames(page, ['THÊM ẢNH', 'Thêm ảnh']);
  if (!addPhotoBtn) throw new Error('Không tìm thấy nút "THÊM ẢNH" trong applet');
  await addPhotoBtn.click();

  const picker = page
    .locator('.cdk-overlay-pane, [role="dialog"], mat-dialog-container')
    .filter({
      has: page.locator('input[placeholder*="Search" i], input[placeholder*="Tìm" i], button:has-text("Add media"), button:has-text("Thêm")')
    })
    .first();
  await picker.waitFor({ state: 'visible', timeout: 15000 });
  console.error('🗂️ Đã mở hộp chọn asset của Flow');

  // Ảnh upload nằm ở tab Uploads -> chuyển sang trước, rồi đếm số asset đang có (mỗi dòng có nhãn "Image")
  // để làm phương án dự phòng khi không khớp được tên file
  await page.waitForTimeout(1000);
  await picker.getByText(/^(Uploads|Tải lên)$/).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  const rowLabels = picker.getByText(/^(Image|Hình ảnh)$/);

  const uploadBtn = picker.getByRole('button', { name: /Upload media|Tải phương tiện lên|Tải lên/i })
    .or(picker.locator('.sidebar-upload-btn'))
    .first();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    uploadBtn.click()
  ]);
  await chooser.setFiles(imagePath);
  console.error('⏫ Đã chọn file, đợi Flow upload...');

  const asset = await waitForUploadedAsset(page, picker, imagePath, rowLabels);
  await asset.scrollIntoViewIfNeeded().catch(() => {});
  await asset.click({ force: true }).catch(() => asset.click());
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(screenshotsDir, `picker_selected_${Date.now()}.png`) });
  console.error('🖱️ Đã chọn ảnh vừa upload (xem screenshots/picker_selected_*.png)');

  // Bấm "Add media" để gắn ảnh vào applet
  const confirmBtn = picker.getByRole('button', { name: /^(Add media|Thêm nội dung nghe nhìn|Thêm phương tiện|Select|Insert|Use|Done|Add|Chọn|Thêm|Xong)$/i }).first();
  await confirmBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click();
    console.error('➕ Đã bấm "Add media"');
  }

  try {
    await picker.waitFor({ state: 'hidden', timeout: 15000 });
  } catch (_) {
    await page.screenshot({ path: path.join(screenshotsDir, `picker_stuck_${Date.now()}.png`) });
    throw new Error('Hộp chọn asset không đóng sau khi chọn ảnh (xem screenshots/picker_stuck_*.png)');
  }
  console.error('✅ Đã gắn ảnh sản phẩm vào applet!');
  await page.waitForTimeout(2000);
}

// Tìm asset vừa upload theo TÊN FILE. Tên file được đặt ngắn (vd "sp_k3j9x2", xem makeShortUploadCopy)
// để Flow hiển thị đủ, không bị rút gọn "…". Không cần đợi thumbnail (icon xám vẫn chọn được).
// Không so "dòng đầu tiên có đổi không" nữa: thumbnail ảnh cũ tải dần làm dòng đầu "đổi" sớm -> chọn nhầm dòng 2.
// Dự phòng cuối: sau 20s (ảnh mới chắc chắn đã chèn lên đầu, sắp xếp Recent) mới chọn dòng đầu tiên.
const FIRST_ROW_FALLBACK_MS = 20000;

async function waitForUploadedAsset(page, picker, imagePath, rowLabels, timeout = 90000) {
  const fullName = path.basename(imagePath);
  const baseName = path.basename(imagePath, path.extname(imagePath));
  const byName = picker
    .getByText(fullName)
    .or(picker.getByText(baseName))
    .or(picker.locator(`[title*="${baseName}"], [aria-label*="${baseName}"]`))
    .first();
  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  while (Date.now() < deadline) {
    if (await byName.isVisible().catch(() => false)) {
      console.error(`🆕 Tìm thấy ảnh vừa upload theo tên: ${baseName}`);
      return byName;
    }
    if (Date.now() - startedAt > FIRST_ROW_FALLBACK_MS && await rowLabels.first().isVisible().catch(() => false)) {
      console.error(`🆕 Không thấy tên "${baseName}" sau ${FIRST_ROW_FALLBACK_MS / 1000}s, chọn dòng đầu tiên`);
      return rowLabels.first();
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`Upload xong nhưng không thấy ảnh "${baseName}" trong hộp chọn asset`);
}

// Tạo bản sao ảnh với tên ngắn + duy nhất (vd "sp_k3j9x2.jpg") để tên hiện đủ trong hộp chọn asset của Flow
const UPLOAD_TMP_DIR = path.join(__dirname, 'downloads', 'upload_tmp');
function makeShortUploadCopy(imagePath) {
  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
  const shortName = `sp_${crypto.randomBytes(4).toString('hex').slice(0, 6)}${path.extname(imagePath).toLowerCase() || '.jpg'}`;
  const dest = path.join(UPLOAD_TMP_DIR, shortName);
  fs.copyFileSync(imagePath, dest);
  return dest;
}

function cleanErrorMessage(msg) {
  const text = String(msg || '').replace(/\x1B\[[0-9;]*m/g, '').split('\nCall log:')[0];
  return text.length > 500 ? text.slice(0, 500) + '…' : text;
}

// imagePaths: 1 đường dẫn hoặc mảng nhiều ảnh — tất cả thuộc CÙNG MỘT sản phẩm, chạy trong 1 flow duy nhất
async function runAutomation(imagePaths, { onProgress = () => {}, videoDuration = '20s' } = {}) {
  imagePaths = Array.isArray(imagePaths) ? imagePaths : [imagePaths];
  if (imagePaths.length === 0) throw new Error('Không có ảnh sản phẩm nào');
  for (const imagePath of imagePaths) {
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Không tìm thấy file ảnh tại: ${imagePath}`);
    }
  }

  const screenshotsDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  console.error('🚀 Khởi động trình duyệt...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    viewport: { width: 1440, height: 900 }
  });

  // Không tái sử dụng tab Flow từ phiên trước: popup, iframe hoặc trạng thái lỗi cũ
  // có thể còn giữ lại trong tab Chrome persistent. Cookie đăng nhập vẫn được giữ nguyên.
  // Mở tab mới TRƯỚC rồi mới đóng tab cũ: đóng hết tab sẽ đóng luôn cửa sổ Chrome cuối cùng,
  // newPage() chạy đúng lúc cửa sổ đang đóng sẽ lỗi "Target.createTarget: Failed to open a new tab".
  const stalePages = context.pages();
  const page = await context.newPage();
  if (stalePages.length) {
    console.error(`🧹 Đang đóng ${stalePages.length} tab cũ của Google Flow...`);
    await Promise.all(stalePages.map((stalePage) => stalePage.close().catch(() => {})));
  }
  // Ghi lại lý do nếu trình duyệt / trang bị đóng giữa chừng để báo lỗi rõ ràng
  let closingByBot = false;
  page.on('crash', () => {
    page.__closeReason = 'trang Flow bị crash, có thể do thiếu bộ nhớ';
    console.error('💥 Trang Flow bị crash!');
  });
  context.on('close', () => {
    if (closingByBot) return;
    page.__closeReason = page.__closeReason || 'cửa sổ Chrome bị đóng hoặc Chrome thoát bất thường';
    console.error(`🛑 Trình duyệt đã đóng khi bot đang chạy: ${page.__closeReason}`);
  });
  page.on('close', () => {
    if (closingByBot) return;
    page.__closeReason = page.__closeReason || 'tab Flow bị đóng (trang tự đóng hoặc do lượt tải file)';
    console.error(`🛑 Tab Flow bị đóng: ${page.__closeReason}`);
  });
  context.on('page', (p) => console.error(`🪟 Mở tab mới: ${p.url() || '(đang tải)'}`));
  context.browser()?.on('disconnected', () => {
    if (!closingByBot) console.error('🛑 Chrome bị ngắt kết nối (thoát bất thường)');
  });
  const origClose = context.close.bind(context);
  context.close = (...a) => { closingByBot = true; return origClose(...a); };
  // Hook bắt link tải / text copy trong mọi frame (iframe applet bị sandbox chặn download)
  await context.addInitScript(installCaptureHooks);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});

  try {
    console.error(`🌐 Truy cập Google Flow: ${FLOW_TOOL_URL}`);
    // Không dùng 'networkidle': Flow luôn giữ kết nối nền nên có lúc không bao giờ "idle" -> timeout.
    // Chỉ đợi HTML tải xong, rồi đợi tới khi thấy nút THÊM ẢNH trong applet (hoặc trang đăng nhập).
    await page.goto(FLOW_TOOL_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

    console.error('⏳ Đợi giao diện applet tải...');
    const loginLocator = page.getByText(/^(Sign in|Đăng nhập)$/).first();
    const loadDeadline = Date.now() + FLOW_LOAD_TIMEOUT_MS;
    let appletReady = false;
    let loginNeeded = false;
    while (Date.now() < loadDeadline) {
      if (/accounts\.google\.com/.test(page.url()) || await loginLocator.isVisible().catch(() => false)) {
        loginNeeded = true;
        break;
      }
      if (await findInFrames(page, ['THÊM ẢNH', 'Thêm ảnh'], { timeout: 1000 })) {
        appletReady = true;
        break;
      }
      await page.waitForTimeout(1000);
    }

    if (loginNeeded) {
      const screenshotPath = path.join(screenshotsDir, `login_required_${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });
      await context.close();
      return {
        success: false,
        message: 'Tài khoản chưa được đăng nhập. Vui lòng chạy "node login.js" để đăng nhập Google trước!',
        screenshotPath
      };
    }
    if (!appletReady) {
      console.error('🔍 Chẩn đoán:\n' + await describeSearch(page, ['THÊM ẢNH', 'Thêm ảnh']));
      throw new Error(`Sau ${FLOW_LOAD_TIMEOUT_MS / 1000}s vẫn chưa thấy nút "THÊM ẢNH" — applet chưa tải xong hoặc mạng chậm`);
    }
    console.error('✅ Applet đã sẵn sàng');

    for (const [i, imagePath] of imagePaths.entries()) {
      console.error(`📤 Đang tải ảnh sản phẩm ${i + 1}/${imagePaths.length}: ${imagePath}`);
      const shortCopy = makeShortUploadCopy(imagePath);
      console.error(`🏷️ Upload với tên ngắn: ${path.basename(shortCopy)}`);
      try {
        await uploadViaAssetPicker(page, shortCopy, screenshotsDir);
      } finally {
        fs.rmSync(shortCopy, { force: true });
      }
    }

    await selectFlowDuration(page, videoDuration);

    const magicFillBtn = await findInFrames(page, [
      /GỢI Ý KỊCH BẢN/i,
      'GỢI Ý KỊCH BẢN 20S', 'Gợi ý kịch bản 20s', 'GỢI Ý KỊCH BẢN', 'Gợi ý kịch bản',
      'TỰ ĐỘNG ĐIỀN TỪ ẢNH', 'Tự động điền từ ảnh', 'MAGIC FILL AI', 'MAGIC FILL'
    ], { timeout: 5000 });
    if (magicFillBtn) {
      console.error('✨ Đang bấm nút gợi ý kịch bản...');
      await magicFillBtn.click();
      await page.waitForTimeout(4000);
    }

    const produceButtonLabels = [
      'SẢN XUẤT VIDEO 20S (CÙNG MAI ANH)',
      'Sản xuất video 20s (cùng Mai Anh)',
      'SẢN XUẤT VIDEO 20S',
      'Sản xuất video 20s',
      'SẢN XUẤT VIDEO',
      'Sản xuất video',
      'SO SÁNH MẪU & SẢN XUẤT AN TOÀN',
      'So sánh mẫu & sản xuất an toàn',
      'SẢN XUẤT TỰ ĐỘNG',
      'Sản xuất tự động'
    ];
    console.error('🎬 Đang tìm nút sản xuất video...');
    const produceBtn = await findInFrames(page, produceButtonLabels, { buttonsOnly: true });
    if (!produceBtn) {
      throw new Error('Không tìm thấy nút "SO SÁNH MẪU & SẢN XUẤT AN TOÀN" (hoặc "SẢN XUẤT TỰ ĐỘNG") trong applet');
    }
    await produceBtn.scrollIntoViewIfNeeded();
    await produceBtn.click();
    console.error('🚀 ĐÃ BẤM NÚT SẢN XUẤT THÀNH CÔNG!');
    onProgress(`🎬 Đã bấm nút Sản xuất, đang đợi video render (tối đa ${RENDER_TIMEOUT_MIN} phút)...`);

    const outDir = path.join(__dirname, 'results', `result_${Date.now()}`);
    const files = await waitAndCollectResults(page, outDir, {
      timeoutMs: RENDER_TIMEOUT_MIN * 60000,
      onProgress
    });

    const screenshotPath = path.join(screenshotsDir, `result_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath });
    console.error(`📸 Đã lưu ảnh chụp màn hình tại: ${screenshotPath}`);

    await context.close();
    return {
      success: true,
      message: 'Đã tạo xong video trên Google Flow!\n' +
        `🎞️ Video: ${files.video ? '✅' : '❌'}\n` +
        `🖼️ Thumbnail: ${files.thumbnail ? '✅' : '❌'}\n` +
        `📝 Caption & Hashtags: ${files.caption ? '✅' : '❌'}\n` +
        `📁 Thư mục: ${outDir}`,
      screenshotPath,
      files
    };

  } catch (error) {
    console.error('❌ Lỗi tự động hóa:', error);
    const screenshotPath = path.join(screenshotsDir, `error_${Date.now()}.png`);
    try {
      await page.screenshot({ path: screenshotPath });
    } catch (_) {}
    await context.close();
    return {
      success: false,
      message: `Lỗi: ${cleanErrorMessage(error.message)}`,
      screenshotPath
    };
  }
}

module.exports = { runAutomation };

if (require.main === module) {
  const args = process.argv.slice(2);
  const imageArgs = args;

  if (imageArgs.length === 0) {
    console.log(JSON.stringify({ success: false, message: 'Thiếu đường dẫn ảnh' }));
    process.exit(1);
  }

  runAutomation(imageArgs).then((res) => {
    console.log(JSON.stringify(res));
    process.exit(res.success ? 0 : 1);
  }).catch((err) => {
    console.log(JSON.stringify({ success: false, message: err.message }));
    process.exit(1);
  });
}
