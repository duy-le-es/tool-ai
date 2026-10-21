const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { installCaptureHooks, waitAndCollectResults } = require('./results');
const { trimProfileCache } = require('./profile_cache');
require('dotenv').config();

const FLOW_TOOL_URL = process.env.FLOW_TOOL_URL || 'https://flow.google.com/project/856dd52d-7081-4b09-8a04-b32e7b5b6a0d/tool/0f719f8f-3aa3-4c8a-8b73-edb5ecd9fa7b';
const USER_DATA_DIR = path.join(__dirname, 'user_data');
const HEADLESS = process.env.HEADLESS === 'true';
// Video Flow có thể cần lâu hơn 10 phút; vẫn cho phép ghi đè trong .env khi cần.
const RENDER_TIMEOUT_MIN = Number(process.env.RENDER_TIMEOUT_MIN) || 20;
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

// getByText() thường trả về <span> bên trong CTA. Lấy phần tử điều khiển gần
// nhất để click đúng button thay vì chỉ coi việc click vào text không lỗi là đã
// khởi tạo tác vụ. (Một số phiên bản Flow có handler ở div[role=button].)
async function actionControl(textLocator) {
  const handle = await textLocator.evaluateHandle((el) => el.closest(
    'button, [role="button"], input[type="button"], input[type="submit"]'
  ) || el);
  return handle.asElement() || textLocator;
}

async function productionUiState(page, control) {
  const controlState = await control.evaluate((el) => ({
    connected: el.isConnected,
    visible: (() => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    })(),
    disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
    text: (el.innerText || el.textContent || '').trim(),
    className: String(el.className || '')
  })).catch(() => ({ connected: false, visible: false, disabled: false, text: '', className: '' }));

  // Những nhãn này chỉ xuất hiện sau khi CTA đã được Flow nhận và bắt đầu đổi
  // sang màn hình/trạng thái sản xuất. Dò ở mọi frame vì Flow có thể thay iframe.
  // Không dùng "Kịch bản / Phân cảnh / Kết quả": đó là nhãn của thanh bước luôn
  // hiển thị trên đầu applet, dùng chúng sẽ xác nhận sai ngay cả khi click bị bỏ qua.
  const startedLabels = /^(đang sản xuất|đang tạo video|đang render|đang xử lý|xem kết quả|tải ngay|download video)$/i;
  let startedLabel = '';
  for (const frame of page.frames()) {
    const label = frame.getByText(startedLabels).first();
    if (await label.isVisible().catch(() => false)) {
      startedLabel = (await label.textContent().catch(() => '')).trim();
      break;
    }
  }
  return { ...controlState, startedLabel };
}

// Khi bấm "SẢN XUẤT VIDEO" thất bại, applet hiện một khung viền đỏ bên dưới
// nút (thường nằm ngoài màn hình) thay vì đổi trạng thái. So sánh chữ trong
// mọi frame trước/sau khi bấm để đọc được thông báo lỗi đó và dừng sớm, thay
// vì ngồi chờ render tới hết RENDER_TIMEOUT_MIN.
const PRODUCTION_ERROR_RE = /(lỗi|error|thất bại|failed|không thể|không đủ|hết (lượt|credit|hạn mức|quota)|quota|rate limit|vi phạm|policy|unsafe|bị chặn|blocked|thử lại|try again)/i;
// Trang kết quả có các mục cam kết như "KHÔNG VI PHẠM NHÃN HIỆU ✓" hay
// "...bảo vệ tài khoản khỏi quét vi phạm..." -> không phải lỗi.
const PRODUCTION_SAFE_RE = /(✓|✔|không vi phạm|an toàn|bảo vệ|không in logo|không dính)/i;
// Icon Material của applet là chữ "error_outline", "warning", "sync"... hiển thị bằng font,
// innerText vẫn đọc ra tên icon -> không phải thông báo lỗi (thông báo thật luôn có dấu cách/chữ hoa/dấu).
const ICON_NAME_RE = /^[a-z][a-z0-9_]*$/;

async function appletTextLines(page) {
  const lines = new Set();
  for (const frame of page.frames()) {
    const text = await frame.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    for (const line of String(text).split('\n')) {
      const t = line.trim();
      if (t) lines.add(t);
    }
  }
  return lines;
}

async function newAppletLines(page, baseline) {
  return [...await appletTextLines(page)].filter((line) => !baseline.has(line));
}

// Trả về thông báo lỗi mới xuất hiện (nếu có) và chụp lại khung lỗi.
async function detectProductionError(page, baseline, screenshotsDir) {
  const errors = (await newAppletLines(page, baseline)).filter((line) => PRODUCTION_ERROR_RE.test(line) && !PRODUCTION_SAFE_RE.test(line) && !ICON_NAME_RE.test(line));
  if (errors.length === 0) return null;
  for (const frame of page.frames()) {
    const loc = frame.getByText(errors[0], { exact: true }).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      break;
    }
  }
  const screenshotPath = path.join(screenshotsDir, `produce_error_${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath }).catch(() => {});
  return { message: errors.join(' | ').slice(0, 500), screenshotPath };
}

// Magic Fill điền mô tả bất đồng bộ. CTA đã có trên màn hình từ trước nhưng vẫn
// bị disabled trong lúc đó, nên tuyệt đối không click chỉ vì đã tìm thấy text.
async function waitForEnabledProduction(page, produceBtn, screenshotsDir, timeout = 120000) {
  const control = await actionControl(produceBtn);
  const deadline = Date.now() + timeout;
  let state = await productionUiState(page, control);
  while (Date.now() < deadline) {
    state = await productionUiState(page, control);
    const enabled = state.connected && state.visible && !state.disabled && await isClickable(control);
    if (enabled) {
      console.error('✅ Nút "SẢN XUẤT VIDEO" đã sáng và sẵn sàng để bấm');
      return control;
    }
    await page.waitForTimeout(500);
  }

  const screenshotPath = path.join(screenshotsDir, `produce_still_disabled_${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath }).catch(() => {});
  throw new Error(
    `Nút "SẢN XUẤT VIDEO" vẫn chưa sẵn sàng sau ${Math.round(timeout / 1000)} giây ` +
    `(visible=${state.visible}, disabled=${state.disabled}; xem ${screenshotPath}).`
  );
}

// click() resolve thành công chỉ chứng minh Playwright đã gửi chuột, không chứng
// minh React/Flow nhận request. Không chuyển sang vòng chờ render cho đến khi CTA
// biến mất/bị khóa hoặc UI hiện tín hiệu sản xuất/kết quả.
async function clickAndConfirmProduction(page, produceBtn, screenshotsDir, timeout = 20000) {
  const control = await waitForEnabledProduction(page, produceBtn, screenshotsDir);
  await control.scrollIntoViewIfNeeded();
  if (!await isClickable(control)) throw new Error('Nút "SẢN XUẤT VIDEO" đang bị phần tử khác che');

  const before = await productionUiState(page, control);
  const baseline = await appletTextLines(page);
  await page.screenshot({ path: path.join(screenshotsDir, `produce_before_click_${Date.now()}.png`) }).catch(() => {});
  await control.click();

  const failIfError = async () => {
    const err = await detectProductionError(page, baseline, screenshotsDir);
    if (err) throw new Error(`Flow báo lỗi sau khi bấm "SẢN XUẤT VIDEO": ${err.message} (xem ${err.screenshotPath})`);
  };

  // Chữ tiến trình mới xuất hiện sau khi bấm (vd "Đang soạn kịch bản...") cũng là tín hiệu Flow đã nhận lệnh.
  const progressLine = /^đang\s|đang (soạn|tạo|sản xuất|xử lý|render|phân tích|dựng)/i;
  const deadline = Date.now() + timeout;
  const fallbackClickAt = Date.now() + 8000;
  let fallbackClicked = false;
  let current = before;
  let confirmed = false;
  while (Date.now() < deadline) {
    await failIfError();
    current = await productionUiState(page, control);
    // Nhãn đã có sẵn trước khi bấm không chứng minh được gì.
    const newLabel = current.startedLabel && !baseline.has(current.startedLabel) ? current.startedLabel : '';
    const progress = newLabel ? '' : (await newAppletLines(page, baseline)).find((line) => progressLine.test(line)) || '';
    if (!current.connected || !current.visible || current.disabled || newLabel || progress) {
      const signal = newLabel || progress;
      console.error(`✅ Flow đã nhận lệnh sản xuất${signal ? ` (${signal})` : ''}`);
      confirmed = true;
      break;
    }
    // Click chuột thật đôi khi bị applet bỏ qua (vd đang re-render) -> thử click DOM một lần.
    if (!fallbackClicked && Date.now() > fallbackClickAt) {
      fallbackClicked = true;
      console.warn('⚠️ Flow chưa phản hồi sau 8 giây, bấm lại nút "SẢN XUẤT VIDEO" bằng DOM click...');
      await control.evaluate((el) => el.click()).catch(() => {});
    }
    await page.waitForTimeout(250);
  }

  if (!confirmed) {
    const screenshotPath = path.join(screenshotsDir, `produce_not_confirmed_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath }).catch(() => {});
    const added = (await newAppletLines(page, baseline)).slice(0, 10).join(' | ');
    throw new Error(
      'Đã gửi click tới nút "SẢN XUẤT VIDEO" nhưng Flow không đổi sang trạng thái sản xuất sau 20 giây ' +
      `(CTA vẫn hiển thị=${current.visible}, disabled=${current.disabled}; chữ mới trên UI: ${added || 'không có'}; xem ${screenshotPath}).`
    );
  }

  // CTA có thể bị React render lại (connected=false) hoặc khóa thoáng qua rồi
  // mới hiện khung lỗi -> tiếp tục canh lỗi thêm một lúc trước khi chờ render.
  const settleDeadline = Date.now() + 10000;
  while (Date.now() < settleDeadline) {
    await failIfError();
    await page.waitForTimeout(500);
  }
  const added = await newAppletLines(page, baseline);
  if (added.length) console.error(`ℹ️ Chữ mới trên UI sau khi bấm: ${added.slice(0, 10).join(' | ')}`);
  return { checkError: failIfError };
}

// "GỢI Ý KỊCH BẢN" ghi kịch bản vào ô mô tả theo kiểu stream. Bấm "SẢN XUẤT VIDEO"
// khi chữ vẫn đang chạy có thể bị applet bỏ qua -> đợi tới khi nội dung đứng yên.
async function waitForScriptStable(page, { timeout = 90000, quietMs = 3000 } = {}) {
  const readScript = async () => {
    for (const frame of [...page.frames().filter((f) => f !== page.mainFrame()), page.mainFrame()]) {
      const value = await frame.evaluate(() => [...document.querySelectorAll('textarea')]
        .filter((el) => el.getBoundingClientRect().height > 0)
        .map((el) => el.value)
        .join('\n')).catch(() => '');
      if (value) return value;
    }
    return '';
  };
  const deadline = Date.now() + timeout;
  let last = await readScript();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const value = await readScript();
    if (value !== last) {
      last = value;
      stableSince = Date.now();
    } else if (value && Date.now() - stableSince >= quietMs) {
      console.error(`📝 Kịch bản đã điền xong (${value.length} ký tự)`);
      return;
    }
  }
  console.warn('⚠️ Ô mô tả vẫn đang thay đổi / trống sau khi bấm gợi ý kịch bản; vẫn tiếp tục.');
}

// UI mới hiển thị "BỘ SƯU TẬP SẢN PHẨM (n/3)". Đây là nguồn xác nhận duy nhất
// rằng ảnh đã được gắn vào tool, thay vì chỉ dựa vào việc hộp chọn asset đã đóng.
async function productCollectionCount(page) {
  const counter = /bộ\s+sưu\s+tập\s+sản\s+phẩm\s*\(\s*(\d+)\s*\/\s*\d+\s*\)/i;
  for (const frame of [...page.frames().filter((f) => f !== page.mainFrame()), page.mainFrame()]) {
    const label = frame.getByText(counter).first();
    if (!await label.isVisible().catch(() => false)) continue;
    const text = await label.textContent().catch(() => '');
    const match = String(text).match(counter);
    if (match) return Number(match[1]);
  }
  return null;
}

async function waitForEnabledConfirmButton(page, picker, screenshotsDir, timeout = 60000) {
  const confirmBtn = picker.getByRole('button', {
    name: /^(Add media|Thêm nội dung nghe nhìn|Thêm phương tiện|Select|Insert|Use|Done|Add|Chọn|Thêm|Xong)$/i
  }).first();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await confirmBtn.isVisible().catch(() => false) &&
      await confirmBtn.isEnabled().catch(() => false) &&
      await isClickable(confirmBtn);
    if (ready) return confirmBtn;
    await page.waitForTimeout(500);
  }
  const screenshotPath = path.join(screenshotsDir, `picker_not_ready_${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath }).catch(() => {});
  throw new Error(`Ảnh upload chưa sẵn sàng để thêm sau ${timeout / 1000}s (xem ${screenshotPath})`);
}

async function waitForCollectionIncrease(page, previousCount, screenshotsDir, timeout = 30000) {
  // Một số bản Flow không render bộ đếm bằng text. Không đoán thành công trong
  // trường hợp đó: trả về null để log cảnh báo, còn trường hợp có bộ đếm phải tăng.
  if (previousCount === null) return null;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const currentCount = await productCollectionCount(page);
    if (currentCount !== null && currentCount > previousCount) return currentCount;
    await page.waitForTimeout(500);
  }
  const screenshotPath = path.join(screenshotsDir, `collection_not_updated_${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath }).catch(() => {});
  throw new Error(`Ảnh chưa xuất hiện trong Bộ sưu tập sản phẩm (vẫn ${previousCount}/3; xem ${screenshotPath})`);
}

// Bấm "Thêm ảnh" trong applet -> Flow mở hộp chọn asset -> "Upload media" -> chọn ảnh vừa tải -> hộp đóng.
async function uploadViaAssetPicker(page, imagePath, screenshotsDir) {
  const collectionBefore = await productCollectionCount(page);
  if (collectionBefore === null) {
    console.warn('⚠️ Không đọc được bộ đếm Bộ sưu tập sản phẩm; sẽ chỉ xác minh nút Add media khả dụng.');
  } else {
    console.error(`🖼️ Bộ sưu tập hiện có: ${collectionBefore}/3 ảnh`);
  }
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
  console.error('🖱️ Đã chọn ảnh vừa upload; đợi Flow xử lý thumbnail và mở nút Add media...');

  // Ảnh chụp lỗi trước đây cho thấy nút còn mờ (disabled) và thumbnail vẫn xoay.
  // Chỉ bấm khi nút thực sự enabled, không dùng việc hộp dialog đóng làm dấu hiệu thành công.
  const confirmBtn = await waitForEnabledConfirmButton(page, picker, screenshotsDir);
  await page.screenshot({ path: path.join(screenshotsDir, `picker_ready_${Date.now()}.png`) });
  await confirmBtn.click();
  console.error('➕ Đã bấm "Add media" khi nút đã sẵn sàng');

  try {
    await picker.waitFor({ state: 'hidden', timeout: 15000 });
  } catch (_) {
    await page.screenshot({ path: path.join(screenshotsDir, `picker_stuck_${Date.now()}.png`) });
    throw new Error('Hộp chọn asset không đóng sau khi chọn ảnh (xem screenshots/picker_stuck_*.png)');
  }
  const collectionAfter = await waitForCollectionIncrease(page, collectionBefore, screenshotsDir);
  if (collectionAfter === null) {
    console.warn('⚠️ Hộp asset đã đóng, nhưng không có bộ đếm để xác nhận số ảnh.');
  } else {
    console.error(`✅ Đã gắn ảnh sản phẩm vào applet (${collectionAfter}/3 ảnh)!`);
  }
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

function flowPageClosedError(page) {
  const reason = page.__closeReason || 'tab Flow tự đóng khi đang tải applet';
  return new Error(`Tab Google Flow đã bị đóng giữa chừng (${reason}). Bot sẽ thử mở lại một phiên mới.`);
}

const FLOW_STYLE_LABELS = {
  cinematic: ['ĐIỆN ẢNH / SANG TRỌNG', 'Điện ảnh / Sang trọng', 'ĐIỆN ẢNH / SẢN PHẨM', 'Điện ảnh / Sản phẩm', 'ĐIỆN ẢNH'],
  viral: ['VIRAL / SÔI ĐỘNG', 'Viral / Sôi động', 'VIRAL / SỐNG ĐỘNG', 'Viral / Sống động', 'VIRAL'],
  chill: ['CHILL / NHẸ NHÀNG', 'Chill / Nhẹ nhàng', 'CHILL'],
  funny: ['HÀI HƯỚC / TRẺ TRUNG', 'Hài hước / Trẻ trung', 'HÀI HƯỚC']
};

const FLOW_DURATION_LABELS = {
  '16s': ['16s (Mặc định - Chuẩn TikTok Viral)', '16s (Mặc định', '16s'],
  '10s': ['10s (Bản rút gọn)', '10s'],
  '20s': ['20s (2 phân đoạn 10s)', '20s (2 phân đoạn)', '20s'],
  '26s': ['26s (Video dài chi tiết)', '26s']
};

async function selectFlowDuration(page, durationKey = '20s') {
  if (!FLOW_DURATION_LABELS[durationKey]) durationKey = '20s';
  const targetLabels = FLOW_DURATION_LABELS[durationKey];

  // Tìm nút dropdown thời lượng hiện tại (nằm trong applet, có chữ 10s, 16s, 20s hoặc 26s)
  const durationTrigger = await findInFrames(page, [
    /^(10s|16s|20s|26s)\b/i,
    '20s (2 phân đoạn',
    '16s (Mặc định'
  ], { timeout: 4000 });

  if (!durationTrigger) {
    console.warn('⚠️ Không tìm thấy nút dropdown "THỜI LƯỢNG" trên Flow; bỏ qua bước chọn thời lượng.');
    return;
  }

  const currentText = (await durationTrigger.textContent().catch(() => '')).trim();
  if (currentText.toLowerCase().startsWith(durationKey.toLowerCase())) {
    console.error(`⏱️ Thời lượng Flow đã ở mức: ${durationKey} ("${currentText}")`);
    return;
  }

  console.error(`⏱️ Đang đổi thời lượng từ "${currentText}" sang ${durationKey}...`);
  await durationTrigger.click();
  await page.waitForTimeout(600);

  // Tìm option trong menu popup vừa mở
  const optionBtn = await findInFrames(page, targetLabels, { timeout: 4000 });
  if (optionBtn) {
    await optionBtn.click();
    await page.waitForTimeout(600);
    console.error(`✅ Đã chọn thời lượng: ${durationKey}`);
  } else {
    console.warn(`⚠️ Không thấy lựa chọn thời lượng "${durationKey}" trong dropdown; đóng menu.`);
    await page.keyboard.press('Escape').catch(() => {});
  }
}

// imagePaths: 1 đường dẫn hoặc mảng nhiều ảnh — tất cả thuộc CÙNG MỘT sản phẩm, chạy trong 1 flow duy nhất
// userDataDir / flowUrl: hồ sơ Chrome + link tool Flow của tài khoản Google được chọn (xem accounts.js)
async function runAutomationAttempt(imagePaths, { onProgress = () => {}, userDataDir = USER_DATA_DIR, flowUrl = FLOW_TOOL_URL, videoStyle = 'cinematic', videoDuration = '20s' } = {}) {
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
  console.error(`👤 Hồ sơ Chrome: ${userDataDir}`);
  trimProfileCache(userDataDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      // Gập máy / tắt màn hình: hệ điều hành coi cửa sổ bị che -> Chrome giảm tốc trang (timer, render)
      // làm Flow chạy chậm / treo. Tắt các cơ chế giảm tốc này để bot chạy 24/7 ổn định.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      // Giới hạn cache (150 MB / 32 MB media): mặc định Chrome để cache lớn theo dung lượng ổ trống,
      // video Flow tạo ra bị cache lại làm hồ sơ user_data phình rất nhanh.
      '--disk-cache-size=157286400',
      '--media-cache-size=33554432'
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

  // Chỉ thử lại tự động khi tab mất lúc khởi tạo. Sau khi applet đã sẵn sàng,
  // việc chạy lại có thể upload/gửi yêu cầu sản xuất trùng.
  let safeToRetryPageClose = true;
  try {
    console.error(`🌐 Truy cập Google Flow: ${flowUrl}`);
    // Không dùng 'networkidle': Flow luôn giữ kết nối nền nên có lúc không bao giờ "idle" -> timeout.
    // Chỉ đợi HTML tải xong, rồi đợi tới khi thấy nút THÊM ẢNH trong applet (hoặc trang đăng nhập).
    await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

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
    safeToRetryPageClose = false;

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

    // Chọn thời lượng video đã được chọn trên Telegram (mặc định 20s).
    await selectFlowDuration(page, videoDuration);

    // Chọn mood đã được người dùng chọn trên Telegram. Bỏ qua khi Flow chưa
    // hiện nhóm nút này để vẫn tương thích với giao diện cũ.
    const styleLabels = FLOW_STYLE_LABELS[videoStyle] || FLOW_STYLE_LABELS.cinematic;
    const styleBtn = await findInFrames(page, styleLabels, { timeout: 5000 });
    if (styleBtn) {
      console.error(`🎵 Đang chọn phong cách video: ${videoStyle}`);
      await styleBtn.click();
      await page.waitForTimeout(500);
    } else {
      console.warn(`⚠️ Không thấy nút phong cách "${videoStyle}" trên Flow; dùng lựa chọn mặc định của giao diện.`);
    }

    // UI mới dùng "GỢI Ý KỊCH BẢN" (hoặc kèm số giây 20S/16S/10S/26S) hoặc "TỰ ĐỘNG ĐIỀN TỪ ẢNH";
    // các nhãn Magic Fill cũ được giữ để tương thích với các phiên bản giao diện khác.
    const magicFillBtn = await findInFrames(page, [
      /GỢI Ý KỊCH BẢN/i,
      'GỢI Ý KỊCH BẢN 20S', 'Gợi ý kịch bản 20s',
      'GỢI Ý KỊCH BẢN 16S', 'Gợi ý kịch bản 16s',
      'GỢI Ý KỊCH BẢN 10S', 'Gợi ý kịch bản 10s',
      'GỢI Ý KỊCH BẢN 26S', 'Gợi ý kịch bản 26s',
      'GỢI Ý KỊCH BẢN', 'Gợi ý kịch bản',
      'TỰ ĐỘNG ĐIỀN TỪ ẢNH', 'Tự động điền từ ảnh', 'MAGIC FILL AI', 'MAGIC FILL'
    ], { timeout: 5000 });
    if (magicFillBtn) {
      console.error('✨ Đang bấm nút gợi ý kịch bản / điền từ ảnh...');
      await magicFillBtn.click();
      await page.waitForTimeout(2000);
      await waitForScriptStable(page);
    }

    // UI hiện tại dùng "SẢN XUẤT VIDEO" (hoặc kèm số giây 20S/16S/10S/26S).
    // Các nhãn cũ chỉ là dự phòng cho tool Flow chưa được cập nhật, không phải CTA ưu tiên.
    const produceButtonLabels = [
      /SẢN XUẤT VIDEO/i,
      'SẢN XUẤT VIDEO 20S (CÙNG MAI ANH)',
      'Sản xuất video 20s (cùng Mai Anh)',
      'SẢN XUẤT VIDEO 16S (CÙNG MAI ANH)',
      'SẢN XUẤT VIDEO 10S (CÙNG MAI ANH)',
      'SẢN XUẤT VIDEO 26S (CÙNG MAI ANH)',
      'SẢN XUẤT VIDEO 20S',
      'Sản xuất video 20s',
      'SẢN XUẤT VIDEO 16S',
      'SẢN XUẤT VIDEO 10S',
      'SẢN XUẤT VIDEO 26S',
      'SẢN XUẤT VIDEO',
      'Sản xuất video',
      'SO SÁNH MẪU & SẢN XUẤT AN TOÀN',
      'So sánh mẫu & sản xuất an toàn',
      'SẢN XUẤT TỰ ĐỘNG',
      'Sản xuất tự động'
    ];
    console.error('🎬 Đang tìm nút "SẢN XUẤT VIDEO"...');
    const produceBtn = await findInFrames(page, produceButtonLabels, { buttonsOnly: true });
    if (!produceBtn) {
      throw new Error('Không tìm thấy nút "SẢN XUẤT VIDEO" trong applet');
    }
    const { checkError } = await clickAndConfirmProduction(page, produceBtn, screenshotsDir);
    console.error('🚀 ĐÃ XÁC NHẬN FLOW BẮT ĐẦU SẢN XUẤT!');
    onProgress(`🎬 Đã bấm nút Sản xuất, đang đợi video render (tối đa ${RENDER_TIMEOUT_MIN} phút)...`);

    const outDir = path.join(__dirname, 'results', `result_${Date.now()}`);
    const files = await waitAndCollectResults(page, outDir, {
      timeoutMs: RENDER_TIMEOUT_MIN * 60000,
      onProgress,
      checkError
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
    // Playwright thường chỉ báo "Target page ... has been closed" tại lệnh kế tiếp.
    // Chuẩn hoá lỗi này để hàng đợi có thể nhận ra một lần đóng tab tạm thời và thử lại.
    const pageClosedBeforeCleanup = page.isClosed();
    const actualError = pageClosedBeforeCleanup ? flowPageClosedError(page) : error;
    console.error('❌ Lỗi tự động hóa:', actualError);
    const screenshotPath = path.join(screenshotsDir, `error_${Date.now()}.png`);
    try {
      await page.screenshot({ path: screenshotPath });
    } catch (_) {}
    await context.close();
    return {
      success: false,
      message: `Lỗi: ${cleanErrorMessage(actualError.message)}`,
      screenshotPath,
      // Chỉ retry khi tab/context đã thật sự mất, không retry lỗi UI/upload vì có thể tạo thao tác trùng.
      retryablePageClose: pageClosedBeforeCleanup && safeToRetryPageClose
    };
  }
}

// Flow đôi khi đóng tab vừa mở trong lúc applet khởi tạo (đặc biệt sau một lượt tải file
// hoặc khi Chrome khôi phục phiên cũ). Một lượt thử lại với context/profile mới thường đủ;
// không lặp vô hạn để tránh chạy trùng một yêu cầu thật sự lỗi.
async function runAutomation(imagePaths, options = {}) {
  const first = await runAutomationAttempt(imagePaths, options);
  if (first.success || !first.retryablePageClose) return first;

  console.warn('🔄 Tab Flow đóng khi khởi tạo; tự mở lại một phiên mới (lần 2/2)...');
  options.onProgress?.('⚠️ Tab Google Flow vừa tự đóng khi tải. Bot đang tự mở lại một phiên mới...');
  const second = await runAutomationAttempt(imagePaths, options);
  if (!second.success && second.retryablePageClose) {
    const detail = cleanErrorMessage(second.message).replace(/^Lỗi:\s*/i, '');
    second.message = 'Lỗi: Google Flow đã tự đóng tab ở cả hai lần mở. Hãy kiểm tra Chrome không bị đóng, hồ sơ Google không bị dùng bởi tiến trình khác, rồi thử lại.\n' + detail;
  }
  return second;
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
