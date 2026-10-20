const path = require('path');
const fs = require('fs');
const { launchTikTok, isTikTokLoggedIn } = require('./tiktok_browser');
const { shortProductName } = require('./product_link');
require('dotenv').config();

const TIKTOK_UPLOAD_URL = process.env.TIKTOK_UPLOAD_URL || 'https://www.tiktok.com/tiktokstudio/upload?from=creator_center';
// Mặc định: tự bấm Đăng khi đủ thông tin (gắn được sản phẩm nếu có yêu cầu).
// TIKTOK_AUTO_POST=false -> mặc định điền sẵn rồi để bạn tự kiểm tra và bấm Đăng.
// Khi chọn duyệt tay trên Telegram, bot tự mở cửa sổ Chrome kể cả khi TIKTOK_HEADLESS=true.
const AUTO_POST = process.env.TIKTOK_AUTO_POST !== 'false';
// Mặc định chạy Chrome ẩn (không mở cửa sổ), xem tiến trình qua log. TIKTOK_HEADLESS=false để mở cửa sổ xem trực tiếp.
const HEADLESS = process.env.TIKTOK_HEADLESS !== 'false';
const PROCESS_TIMEOUT_MS = (Number(process.env.TIKTOK_PROCESS_TIMEOUT_MIN) || 10) * 60000;
const REVIEW_TIMEOUT_MS = 30 * 60000;

const TXT = {
  editCover: /^(Edit cover|Chỉnh sửa ảnh bìa|Sửa ảnh bìa|Chọn ảnh bìa|Select cover)$/i,
  uploadCoverTab: /^(Upload cover|Tải lên ảnh bìa|Tải ảnh bìa lên|Tải lên)$/i,
  confirm: /^(Confirm|Xác nhận|Done|Xong|Save|Lưu)$/i,
  post: /^(Post|Đăng|Schedule|Lên lịch)$/i,
  postNow: /^(Post now|Đăng ngay|Continue|Tiếp tục)$/i,
  dismiss: /^(Got it|Đã hiểu|Not now|Để sau|Bỏ qua|Skip|OK)$/i,
  addLinkSection: /^(Thêm liên kết|Add link)$/i,
  addLinkBtn: /^(\+\s*)?(Thêm|Add)$/i,
  productType: /^(Sản phẩm|Products?)$/i,
  productModal: /(Thêm liên kết sản phẩm|Add product link)/i,
  productTabs: [/^Cửa hàng của tôi$|^My shop$/i, /^Trưng bày sản phẩm$|^Showcase$/i],
  next: /^(Tiếp|Tiếp theo|Next)$/i,
  linkTypeLabel: /(Loại liên kết|Link type)/i,
  addProduct: /^(Thêm|Add)$/i,
  posted: /(Your video (has been|is being) (uploaded|posted|scheduled)|Video (của bạn )?(đã|đang) được (đăng|tải lên|lên lịch)|Manage (your )?posts|Quản lý bài đăng|Upload another video|Tải lên video khác|View post|Xem bài đăng)/i
};

async function shot(page, dir, name) {
  const p = path.join(dir, `tiktok_${name}_${Date.now()}.png`);
  await page.screenshot({ path: p }).catch(() => {});
  return p;
}

// Tắt các popup hướng dẫn / thông báo của TikTok Studio nếu có
async function dismissPopups(page) {
  await page.evaluate(() => {
    document.getElementById('react-joyride-portal')?.remove();
    document.querySelectorAll('.react-joyride__overlay, .react-joyride__portal, [data-test-id="overlay"]').forEach((el) => el.remove());
  }).catch(() => {});
  const btns = page.getByRole('button', { name: TXT.dismiss });
  const n = await btns.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const b = btns.nth(i);
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
  }
}

function postButton(page) {
  return page.locator('button[data-e2e="post_video_button"]')
    .or(page.getByRole('button', { name: TXT.post }))
    .first();
}

async function isEnabled(btn) {
  if (!(await btn.isVisible().catch(() => false))) return false;
  if (!(await btn.isEnabled().catch(() => false))) return false;
  const attrs = await btn.evaluate((el) => [el.getAttribute('aria-disabled'), el.getAttribute('data-disabled')]).catch(() => []);
  return !attrs.includes('true');
}

// Ô caption là editor contenteditable (DraftJS). TikTok tự điền tên file vào -> xóa rồi gõ caption.
async function fillCaption(page, caption) {
  const editor = page.locator('.public-DraftEditor-content, [contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 60000 });
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');

  const lines = caption.replace(/\r/g, '').split('\n');
  for (const [i, line] of lines.entries()) {
    if (line) await page.keyboard.insertText(line);
    if (i < lines.length - 1) await page.keyboard.press('Enter');
  }
  // Kết thúc bằng hashtag thì TikTok mở gợi ý hashtag -> gõ thêm dấu cách để đóng gợi ý
  if (/#\S+$/.test(caption.trim())) await page.keyboard.insertText(' ');
  await page.waitForTimeout(1000);
}

// Gắn link sản phẩm TikTok Shop:
// "Thêm liên kết" -> (chọn loại Sản phẩm -> Tiếp) -> hộp "Thêm liên kết sản phẩm"
// -> thử lần lượt tab "Cửa hàng của tôi" / "Trưng bày sản phẩm": tìm theo ID -> tick dòng có ID
// -> Tiếp -> (sửa tên hiển thị, tối đa 30 ký tự) -> Thêm
async function addProductLink(page, product, screenshotsDir) {
  await dismissPopups(page);

  // Chỉ xét phần tử đang hiển thị: hộp "Thêm liên kết" (ẩn) cũng có tiêu đề + nút giống vậy
  const section = page.getByText(TXT.addLinkSection).filter({ visible: true }).first();
  await section.waitFor({ state: 'visible', timeout: 20000 });
  await section.scrollIntoViewIfNeeded();

  // Nút "+ Thêm" = nút đầu tiên nằm ngay sau nhãn "Thêm liên kết" trên form upload
  const openBtn = section.locator('xpath=following::button[1]');
  const btnHtml = await openBtn.evaluate((el) => el.outerHTML.slice(0, 200)).catch(() => '(không thấy nút)');
  console.error(`🔘 Nút mở "Thêm liên kết": ${btnHtml}`);

  // Hộp 1 "Thêm liên kết": Loại liên kết = [Sản phẩm ▾] -> Tiếp.
  // Quan trọng: dùng [role="dialog"] để bắt đúng toàn bộ hộp thoại (không bị bắt nhầm vào common-modal-header)
  const modal = page.locator('[role="dialog"]').filter({ has: page.getByText(TXT.productModal) }).last();
  const typeModal = page.locator('[role="dialog"]').filter({ has: page.getByText(TXT.linkTypeLabel) }).last();
  // Bất kỳ hộp thoại nào đang hiện (kể cả khi tiêu đề khác dự kiến)
  const anyDialog = page.locator('[role="dialog"], [aria-modal="true"], [class*="Modal" i][class*="content" i]')
    .filter({ visible: true }).last();
  const dialogOpen = async () => (await modal.isVisible().catch(() => false))
    || (await typeModal.isVisible().catch(() => false))
    || (await anyDialog.isVisible().catch(() => false));

  // Gợi ý hashtag/@ của ô caption có thể còn mở -> đóng 1 lần trước khi bấm (KHÔNG bấm Escape sau khi đã bấm nút,
  // vì Escape sẽ đóng luôn hộp thoại vừa mở)
  await page.keyboard.press('Escape').catch(() => {});
  await page.getByText(/^(Chi tiết|Details)$/i).filter({ visible: true }).first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(800);

  const clickWays = [
    ['click thường', () => openBtn.click({ timeout: 5000 })],
    ['click chuột theo tọa độ', async () => {
      await openBtn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      const box = await openBtn.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }],
    ['click DOM', () => openBtn.evaluate((el) => el.click())],
    ['click force', () => openBtn.click({ force: true, timeout: 5000 })]
  ];
  for (const [way, doClick] of clickWays) {
    if (await dialogOpen()) break;
    await doClick().catch((e) => console.error(`   (lỗi khi ${way}: ${e.message.split('\n')[0]})`));
    console.error(`🖱️ Bấm "+ Thêm" (${way})`);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !(await dialogOpen())) await page.waitForTimeout(300);
  }
  if (!(await dialogOpen())) {
    await shot(page, screenshotsDir, 'add_link_not_open');
    throw new Error('Bấm "+ Thêm" ở mục "Thêm liên kết" nhưng hộp thoại không mở');
  }
  if (!(await modal.isVisible().catch(() => false)) && !(await typeModal.isVisible().catch(() => false))) {
    const txt = await anyDialog.innerText().catch(() => '');
    console.error(`ℹ️ Hộp thoại đã mở nhưng tiêu đề lạ: "${txt.slice(0, 150).replace(/\n/g, ' | ')}"`);
    await shot(page, screenshotsDir, 'add_link_dialog');
  }
  if (await typeModal.isVisible().catch(() => false)) {
    console.error('🔗 Hộp "Thêm liên kết": chọn loại Sản phẩm -> Tiếp');
    // Ô dropdown đang hiển thị "Sản phẩm" (có thể kèm icon / mũi tên) -> đã đúng loại
    if (!(await typeModal.getByText(/(Sản phẩm|Products?)/i).first().isVisible().catch(() => false))) {
      // Đang chọn loại khác -> mở dropdown, chọn "Sản phẩm"
      await typeModal.locator('[role="combobox"], [class*="select" i], [class*="dropdown" i]').first().click().catch(() => {});
      await page.waitForTimeout(800);
      await page.getByRole('option', { name: TXT.productType }).or(page.getByText(TXT.productType)).last().click();
      await page.waitForTimeout(800);
    }
    await typeModal.getByRole('button', { name: TXT.next }).last().click();
  }
  await modal.waitFor({ state: 'visible', timeout: 20000 });
  console.error('🔗 Đã mở hộp "Thêm liên kết sản phẩm"');

  const productTabs = [
    { name: 'Trưng bày sản phẩm', re: /Trưng bày sản phẩm|Showcase/i },
    { name: 'Cửa hàng của tôi', re: /Cửa hàng của tôi|My shop/i }
  ];

  let selected = false;
  let unavailable = false;
  for (const tabInfo of productTabs) {
    console.error(`🔍 Đang kiểm tra tab: "${tabInfo.name}"...`);
    // Tìm phần tử NHỎ NHẤT có text đúng bằng tên tab (không lấy div cha bọc cả thanh tab),
    // lấy tọa độ thật rồi bấm chuột vào đó; sau đó kiểm tra tab đã active chưa.
    const findTab = () => page.evaluate((pattern) => {
      const re = new RegExp(pattern.normalize('NFC'), 'i');
      const visible = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      // Tìm trong các hộp thoại đang hiện (hộp thoại có thể render qua portal, không nằm trong `modal`)
      const roots = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
      const nodes = (roots.length ? roots : [document.body])
        .flatMap((root) => [...root.querySelectorAll('*')])
        .filter((n) => visible(n) && re.test((n.textContent || '').normalize('NFC')));
      // Bỏ các phần tử có con cũng khớp -> còn lại phần tử sâu nhất (chính là chữ trên tab)
      const leaf = nodes.find((n) => !nodes.some((m) => m !== n && n.contains(m)));
      if (!leaf) return null;
      const tabEl = leaf.closest('[role="tab"], .TUXTabBar-item, [class*="TabBar-item" i], [class*="tab-item" i]') || leaf;
      const r = leaf.getBoundingClientRect();
      const active = tabEl.getAttribute('aria-selected') === 'true'
        || /active|selected/i.test(`${tabEl.className} ${leaf.className}`);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, active, html: tabEl.outerHTML.slice(0, 150) };
    }, tabInfo.re.source).catch(() => null);

    let tabPos = null;
    for (let i = 0; i < 10 && !tabPos; i++) {
      tabPos = await findTab();
      if (!tabPos) await page.waitForTimeout(500);
    }
    if (!tabPos) {
      console.error(`⚠️ Không thấy tab: ${tabInfo.name}`);
      continue;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.mouse.click(tabPos.x, tabPos.y);
      await page.waitForTimeout(1500);
      tabPos = (await findTab()) || tabPos;
      if (tabPos.active) break;
    }
    console.error(`👉 Đã bấm chuyển sang tab: ${tabInfo.name}${tabPos.active ? '' : ' (chưa xác nhận active)'} — ${tabPos.html}`);
    await shot(page, screenshotsDir, `tab_${tabInfo.name.replace(/\s+/g, '_')}`);

    const search = modal.locator('input[placeholder*="Tìm kiếm" i], input[placeholder*="Search" i], input[type="text"]').first();
    await search.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (await search.isVisible().catch(() => false)) {
      await search.click();
      await search.fill('');
      await search.fill(product.id);
      await search.press('Enter');
      console.error(`🔎 Đã gõ tìm ID: ${product.id}`);
      await page.waitForTimeout(3000);
    } else {
      console.error(`⚠️ Không tìm thấy ô nhập tìm kiếm sản phẩm trong tab ${tabInfo.name}`);
      continue;
    }

    // Dòng có đúng ID sản phẩm (ô ID hiển thị đầy đủ dãy số)
    const idCell = modal.getByText(product.id).first();
    if (!(await idCell.isVisible().catch(() => false))) {
      console.error(`❌ Không thấy ID ${product.id} trong tab ${tabInfo.name}`);
      continue;
    }
    console.error(`🎯 Đã tìm thấy sản phẩm ${product.id} trong tab ${tabInfo.name}!`);

    const row = modal.locator('tr, [role="row"], [class*="row" i], [class*="item" i]')
      .filter({ has: idCell })
      .last();
    const rowText = await row.innerText().catch(() => '');
    if (/Không khả dụng|Unavailable|Hết hàng|Out of stock/i.test(rowText)) {
      console.error(`⚠️ Sản phẩm ID ${product.id} đang ở trạng thái: Không khả dụng (kho = 0)`);
      unavailable = true;
    }

    const RADIO = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]';
    const radio = row.locator(RADIO).first();
    if (await radio.isVisible().catch(() => false)) {
      await radio.check({ force: true }).catch(() => radio.click({ force: true }));
    } else {
      // Radio vẽ bằng CSS, không có input -> bấm vào vòng tròn ở đầu dòng (bên trái, cùng hàng với ô ID)
      const pos = await idCell.evaluate((el) => {
        let r = el;
        const modalWidth = (el.closest('[role="dialog"]') || document.body).getBoundingClientRect().width;
        while (r.parentElement && r.getBoundingClientRect().width < modalWidth * 0.8) r = r.parentElement;
        const rect = r.getBoundingClientRect();
        const cell = el.getBoundingClientRect();
        return { x: rect.left + 20, y: cell.top + cell.height / 2 };
      });
      await page.mouse.click(pos.x, pos.y);
    }
    await page.waitForTimeout(1000);

    // Không có tên từ link (chỉ gửi ID) -> lấy tên đầy đủ ở dòng sản phẩm (ô tên dài nhất, không phải số)
    if (!product.title) {
      product.title = await idCell.evaluate((el) => {
        let r = el;
        const modalWidth = (el.closest('[role="dialog"]') || document.body).getBoundingClientRect().width;
        while (r.parentElement && r.getBoundingClientRect().width < modalWidth * 0.8) r = r.parentElement;
        const texts = [...r.querySelectorAll('*')]
          .map((n) => n.getAttribute('title') || (n.children.length === 0 ? n.textContent : ''))
          .map((t) => (t || '').trim())
          .filter((t) => t && !/^[\d.,\sđ₫%]+$/.test(t) && !/^(Đang hoạt động|Active)$/i.test(t));
        return texts.sort((a, b) => b.length - a.length)[0] || '';
      }).catch(() => '');
      if (product.title) console.error(`📦 Tên sản phẩm trong danh sách: ${product.title}`);
    }
    selected = true;
    console.error(`✅ Đã tick chọn sản phẩm ${product.id}`);
    break;
  }
  if (!selected) {
    await shot(page, screenshotsDir, 'product_not_found');
    // Đóng hộp thoại sản phẩm lại bằng nút Hủy để không che màn hình
    const cancelBtn = modal.getByRole('button', { name: /^(Hủy|Cancel)$/i }).first()
      .or(modal.locator('button').filter({ hasText: /^(Hủy|Cancel)$/i }).first());
    if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click({ force: true }).catch(() => {});
    else {
      await modal.evaluate((el) => {
        const btn = [...el.querySelectorAll('button')].find((b) => /Hủy|Cancel/i.test(b.textContent || ''));
        if (btn) btn.click();
      }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
    }
    await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    throw new Error(`Không tìm thấy sản phẩm ID ${product.id} trong "Trưng bày sản phẩm" và "Cửa hàng của tôi"`);
  }

  // Nút "Tiếp" mờ (disabled) cho tới khi tick -> đợi bật rồi mới bấm
  const nextBtn = modal.getByRole('button', { name: TXT.next }).last();
  const deadlineNext = Date.now() + 10000;
  while (Date.now() < deadlineNext && !(await isEnabled(nextBtn))) await page.waitForTimeout(300);
  if (!(await isEnabled(nextBtn))) {
    await shot(page, screenshotsDir, 'product_not_ticked');
    // Đóng modal lại bằng nút Hủy để không che màn hình
    const cancelBtn = modal.getByRole('button', { name: /^(Hủy|Cancel)$/i }).first()
      .or(modal.locator('button').filter({ hasText: /^(Hủy|Cancel)$/i }).first());
    if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click({ force: true }).catch(() => {});
    else {
      await modal.evaluate((el) => {
        const btn = [...el.querySelectorAll('button')].find((b) => /Hủy|Cancel/i.test(b.textContent || ''));
        if (btn) btn.click();
      }).catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
    }
    await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});

    if (unavailable) {
      throw new Error(`Sản phẩm ID ${product.id} đang ở trạng thái "Không khả dụng" (kho: 0) trên TikTok Shop nên TikTok không cho phép gắn liên kết vào video.`);
    }
    throw new Error('Đã tìm thấy sản phẩm nhưng tick không ăn (nút "Tiếp" vẫn mờ)');
  }
  await nextBtn.click();
  await page.waitForTimeout(2000);

  // Màn sửa tên hiển thị: luôn điền tên ngắn gọn (<= 30 ký tự, không cắt giữa chữ),
  // thay cho tên TikTok tự điền sẵn (thường bị cắt ngang chữ)
  const nameInput = page.locator('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])').last();
  // Chỉ lấy nút "Thêm" TRONG hộp thoại (không lấy nhầm nút "+ Thêm" trên form phía sau)
  const addBtn = modal.getByRole('button', { name: TXT.addProduct }).last();
  await addBtn.waitFor({ state: 'visible', timeout: 15000 });
  // TikTok báo lỗi đỏ dưới ô tên, vd "Tên sản phẩm không được chứa các từ bị cấm"
  const nameError = modal.getByText(/(từ bị cấm|không được chứa|không hợp lệ|prohibited|not allowed|banned|invalid)/i).first();

  // Danh sách tên thử lần lượt: tên rút gọn -> bỏ dần từ cuối (từ bị cấm thường ở cuối, vd "Nhà Làm", "Đặc")
  const candidates = [];
  if (await nameInput.isVisible().catch(() => false)) {
    let current = (await nameInput.inputValue().catch(() => '')).trim();
    // Tên TikTok điền sẵn bị cắt ở 30 ký tự (thường giữa chữ) -> coi như bị hụt chữ cuối
    if (current.length >= 30) current += '…';
    const name = shortProductName(product.title || current);
    if (name) {
      const words = name.split(/\s+/);
      for (let n = words.length; n >= 2; n--) candidates.push(words.slice(0, n).join(' '));
    }
  }
  if (!candidates.length) candidates.push(null); // không có ô tên -> bấm Thêm luôn

  let added = false;
  for (const name of candidates) {
    if (name !== null) {
      await nameInput.fill(name);
      console.error(`🏷️ Tên hiển thị sản phẩm: "${name}"`);
      await page.waitForTimeout(800);
      if (await nameError.isVisible().catch(() => false)) {
        console.error(`   ⛔ TikTok không nhận tên này: ${(await nameError.innerText().catch(() => '')).trim()}`);
        continue;
      }
    }
    await addBtn.click();
    if (await modal.waitFor({ state: 'hidden', timeout: 6000 }).then(() => true).catch(() => false)) {
      added = true;
      break;
    }
    const err = await nameError.innerText().catch(() => '');
    console.error(`   ⛔ Bấm Thêm nhưng hộp thoại chưa đóng${err ? `: ${err.trim()}` : ''}`);
    if (name === null) break;
  }
  if (!added) {
    await shot(page, screenshotsDir, 'product_name_rejected');
    throw new Error(`TikTok không nhận tên hiển thị sản phẩm (đã thử: ${candidates.filter(Boolean).map((c) => `"${c}"`).join(', ')})`);
  }
  await page.waitForTimeout(1500);
  console.error('🔗 Đã gắn link sản phẩm vào video');
}

// Đổi ảnh bìa: Edit cover -> tab Upload cover -> chọn file -> Confirm. Lỗi thì bỏ qua (dùng ảnh bìa mặc định).
async function setCover(page, thumbnailPath) {
  const editBtn = page.getByText(TXT.editCover).first();
  await editBtn.waitFor({ state: 'visible', timeout: 20000 });
  await editBtn.click();
  await page.waitForTimeout(2000);

  const tab = page.getByText(TXT.uploadCoverTab).last();
  if (await tab.isVisible().catch(() => false)) await tab.click();
  await page.waitForTimeout(1000);

  const imageInput = page.locator('input[type="file"][accept*="image"]').last();
  if (await imageInput.count() > 0) {
    await imageInput.setInputFiles(thumbnailPath);
  } else {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10000 }),
      page.getByText(/(Upload|Tải lên|Chọn tệp|Select file)/i).last().click()
    ]);
    await chooser.setFiles(thumbnailPath);
  }
  await page.waitForTimeout(3000);

  const confirmBtn = page.getByRole('button', { name: TXT.confirm }).last();
  await confirmBtn.waitFor({ state: 'visible', timeout: 15000 });
  await confirmBtn.click();
  await page.waitForTimeout(2000);
}

const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fmtTime = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtVN = (d) => `${fmtTime(d)} ngày ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;

// TikTok chỉ cho lên lịch từ 15 phút tới 10 ngày sau, phút theo bước 5.
// Làm tròn lên bước 5 phút; sớm hơn mức tối thiểu thì dời tới giờ sớm nhất hợp lệ.
function normalizeSchedule(when) {
  const roundUp5 = (ms) => { const d = new Date(ms); d.setSeconds(0, 0); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5); return d; };
  const earliest = roundUp5(Date.now() + 20 * 60000); // chừa 5 phút cho các bước còn lại trước khi bấm Lên lịch
  const latest = new Date(Date.now() + 10 * 24 * 3600000 - 5 * 60000);
  let target = roundUp5(new Date(when).getTime());
  let note = null;
  if (target < earliest) {
    note = `Giờ hẹn ${fmtVN(new Date(when))} quá gần/đã qua (TikTok cần ít nhất 15 phút) -> dời sang ${fmtVN(earliest)}`;
    target = earliest;
  }
  if (target > latest) throw new Error(`TikTok chỉ cho hẹn giờ tối đa 10 ngày, giờ hẹn ${fmtVN(target)} quá xa`);
  return { target, note };
}

// "Thời điểm đăng" -> Lên lịch -> chọn ngày trong lịch -> chọn giờ/phút trong 2 cột cuộn. Kiểm tra lại giá trị ô.
async function setSchedule(page, target) {
  const container = page.locator('[data-e2e="schedule_container"]');
  await container.scrollIntoViewIfNeeded();
  await container.locator('input[type="radio"][value="schedule"]').check({ force: true })
    .catch(() => container.getByText(/^(Lên lịch|Schedule)$/i).first().click());
  const inputs = container.locator('.scheduled-picker input');
  await inputs.nth(1).waitFor({ state: 'visible', timeout: 10000 });
  const timeInput = inputs.nth(0);
  const dateInput = inputs.nth(1);
  const closePicker = () => container.getByText(/^(Thời điểm đăng|When to post)$/i).first().click().catch(() => {});

  // Ngày: chuyển tháng bằng mũi tên (so với ngày đang chọn), rồi bấm ô ngày "valid"
  const wantDate = fmtDate(target);
  if ((await dateInput.inputValue()) !== wantDate) {
    await dateInput.click();
    const cal = container.locator('.calendar-wrapper');
    await cal.waitFor({ state: 'visible', timeout: 5000 });
    const [cy, cm] = (await dateInput.inputValue()).split('-').map(Number);
    const diff = (target.getFullYear() * 12 + target.getMonth() + 1) - (cy * 12 + cm);
    for (let i = 0; i < Math.abs(diff); i++) {
      const arrows = cal.locator('.month-header-wrapper .arrow');
      await (diff > 0 ? arrows.last() : arrows.first()).click();
      await page.waitForTimeout(400);
    }
    await cal.locator('span.day.valid').filter({ hasText: new RegExp(`^${target.getDate()}$`) }).first().click();
    await page.waitForTimeout(800);
    if (await cal.isVisible().catch(() => false)) await closePicker();
  }
  const gotDate = await dateInput.inputValue();
  if (gotDate !== wantDate) throw new Error(`Chọn ngày hẹn giờ không được (muốn ${wantDate}, ô đang là ${gotDate})`);

  // Giờ: cột trái = giờ (00-23), cột phải = phút (00, 05, ..., 55)
  const wantTime = fmtTime(target);
  if ((await timeInput.inputValue()) !== wantTime) {
    await timeInput.click();
    const picker = container.locator('.tiktok-timepicker-time-picker-container');
    await picker.waitFor({ state: 'visible', timeout: 5000 });
    const pick = async (side, value) => {
      const opt = picker.locator(`.tiktok-timepicker-option-text.tiktok-timepicker-${side}`).filter({ hasText: new RegExp(`^${value}$`) }).first();
      await opt.scrollIntoViewIfNeeded();
      await opt.click();
      await page.waitForTimeout(500);
    };
    await pick('left', pad2(target.getHours()));
    await pick('right', pad2(target.getMinutes()));
    if (await picker.isVisible().catch(() => false)) await closePicker();
    await page.waitForTimeout(500);
  }
  const gotTime = await timeInput.inputValue();
  if (gotTime !== wantTime) throw new Error(`Chọn giờ hẹn không được (muốn ${wantTime}, ô đang là ${gotTime})`);
  console.error(`⏰ Đã đặt lịch đăng: ${gotTime} ${gotDate}`);
}

/**
 * Đăng video lên TikTok Studio.
 * scheduleAt: Date -> dùng "Lên lịch" của TikTok để hẹn giờ đăng; bỏ trống -> đăng ngay.
 * @param {{videoPath: string, thumbnailPath?: string, caption?: string, product?: {id: string, title?: string}, scheduleAt?: Date|null, autoPost?: boolean, onProgress?: (msg: string) => void}} opts
 */
async function uploadToTikTok({ videoPath, thumbnailPath, caption = '', product = null, scheduleAt = null, autoPost = AUTO_POST, onProgress = () => {} }) {
  if (!videoPath || !fs.existsSync(videoPath)) throw new Error(`Không tìm thấy video: ${videoPath}`);
  if (!/\.(mp4|mov|webm)$/i.test(videoPath)) throw new Error(`File video phải là .mp4/.mov/.webm, đang là: ${path.basename(videoPath)}`);
  const screenshotsDir = path.join(__dirname, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  // Duyệt tay phải hiện cửa sổ để người dùng có thể bấm Đăng, dù cấu hình mặc định chạy ẩn.
  const headless = autoPost ? HEADLESS : false;
  console.error(`🚀 Mở Chrome TikTok (${headless ? 'chạy ẩn' : 'hiện cửa sổ'}, ${autoPost ? 'tự đăng' : 'chờ duyệt tay'})...`);
  const { context, page } = await launchTikTok({ headless });
  let closedByUser = false;
  context.on('close', () => { closedByUser = true; });

  const warnings = [];
  try {
    await page.goto(TIKTOK_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    if (!(await isTikTokLoggedIn(context, page))) {
      const screenshotPath = await shot(page, screenshotsDir, 'login_required');
      await context.close();
      return { success: false, message: 'TikTok chưa đăng nhập hoặc phiên hết hạn. Chạy: node login_tiktok.js', screenshotPath };
    }
    await dismissPopups(page);

    // 1. Chọn video
    console.error(`📤 Tải video lên TikTok: ${videoPath}`);
    const videoInput = page.locator('input[type="file"][accept*="video"]').or(page.locator('input[type="file"]')).first();
    await videoInput.waitFor({ state: 'attached', timeout: 30000 });
    await videoInput.setInputFiles(videoPath);
    onProgress('📤 Đang tải video lên TikTok...');

    // 2. Đợi TikTok tải lên + xử lý xong (nút Đăng bật lên)
    const deadline = Date.now() + PROCESS_TIMEOUT_MS;
    const postBtn = postButton(page);
    while (Date.now() < deadline) {
      await dismissPopups(page);
      if (await isEnabled(postBtn)) break;
      await page.waitForTimeout(3000);
    }
    if (!(await isEnabled(postBtn))) throw new Error('TikTok xử lý video quá lâu, nút Đăng chưa bật');
    console.error('✅ TikTok đã nhận video');

    // 3. Caption
    if (caption.trim()) {
      console.error('📝 Điền caption...');
      await fillCaption(page, caption.trim());
    }

    // 3b. Gắn link sản phẩm TikTok Shop. Lỗi thì KHÔNG tự đăng (video bán hàng mà thiếu link là mất đơn)
    let productError = null;
    if (product && product.id) {
      console.error(`🔗 Gắn sản phẩm ${product.id}...`);
      try {
        await addProductLink(page, product, screenshotsDir);
      } catch (e) {
        console.error('⚠️ Không gắn được sản phẩm:', e.message);
        productError = e.message.split('\n')[0];
        warnings.push(`Không gắn được link sản phẩm: ${productError}`);
        // Đóng hết hộp thoại còn mở (có thể có nhiều lớp), nếu không lớp phủ sẽ chặn bước đổi ảnh bìa
        for (let i = 0; i < 4; i++) {
          const openCancel = page.locator('[role="dialog"] button').filter({ visible: true })
            .filter({ hasText: /^(Hủy|Cancel)$/i }).last();
          if (!(await openCancel.isVisible().catch(() => false))) break;
          await openCancel.click({ force: true }).catch(() => {});
          await page.waitForTimeout(800);
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(1000);
        await shot(page, screenshotsDir, 'product_failed');
      }
    }

    // 4. Ảnh bìa
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      console.error('🖼️ Đổi ảnh bìa...');
      try {
        await setCover(page, thumbnailPath);
      } catch (e) {
        console.error('⚠️ Không đổi được ảnh bìa:', e.message);
        warnings.push('Không đổi được ảnh bìa (dùng ảnh bìa mặc định)');
        await page.keyboard.press('Escape').catch(() => {});
        await shot(page, screenshotsDir, 'cover_failed');
      }
    }

    // 4b. Hẹn giờ đăng bằng "Lên lịch" của TikTok. Lỗi thì KHÔNG đăng (tránh đăng sai giờ)
    let scheduledFor = null;
    let scheduleError = null;
    if (scheduleAt) {
      try {
        const { target, note } = normalizeSchedule(scheduleAt);
        if (note) {
          console.error(`⚠️ ${note}`);
          warnings.push(note);
        }
        console.error(`⏰ Hẹn giờ đăng TikTok: ${fmtVN(target)}...`);
        await setSchedule(page, target);
        scheduledFor = target;
      } catch (e) {
        console.error('⚠️ Không hẹn giờ được:', e.message);
        scheduleError = e.message.split('\n')[0];
        await shot(page, screenshotsDir, 'schedule_failed');
      }
    }

    const filledShot = await shot(page, screenshotsDir, 'filled');
    const blockReason = productError
      ? `Không gắn được sản phẩm nên bot KHÔNG đăng. ${productError}`
      : scheduleError ? `Không hẹn giờ đăng được nên bot KHÔNG đăng. ${scheduleError}` : null;

    // 5a. Chạy ẩn mà không đủ điều kiện tự đăng -> không có cửa sổ để duyệt tay, đóng luôn và báo qua log.
    // (Chế độ duyệt tay luôn mở cửa sổ ở trên, nên chỉ còn trường hợp lỗi bắt buộc.)
    if (headless && (!autoPost || blockReason)) {
      const reason = blockReason || 'đang ở chế độ duyệt tay nên bot không bấm Đăng';
      // Không gửi onProgress: lý do đã nằm trong message trả về (tránh gửi trùng 2 tin)
      console.error(`⛔ ${reason}. Xem ảnh: ${filledShot}`);
      await context.close();
      return {
        success: false,
        posted: false,
        message: `Chưa đăng TikTok: ${reason}` + (warnings.length ? `\n⚠️ ${warnings.join('\n⚠️ ')}` : ''),
        screenshotPath: filledShot
      };
    }

    // 5b. Có cửa sổ trình duyệt + chế độ duyệt hoặc gắn sản phẩm lỗi:
    // để bạn tự kiểm tra, bấm Đăng rồi đóng trình duyệt
    if (!autoPost || blockReason) {
      if (blockReason) onProgress(`⚠️ ${blockReason}`);
      console.error('⏸️ Chế độ duyệt tay -> đợi bạn kiểm tra và tự bấm Đăng, rồi đóng trình duyệt');
      onProgress('⏸️ Đã điền sẵn video + caption + ảnh bìa trên TikTok. Vào máy kiểm tra, tự bấm ĐĂNG/LÊN LỊCH rồi đóng trình duyệt (tối đa 30 phút).');
      const reviewDeadline = Date.now() + REVIEW_TIMEOUT_MS;
      while (!closedByUser && Date.now() < reviewDeadline) await new Promise((r) => setTimeout(r, 2000));
      if (!closedByUser) await context.close();
      return {
        success: true,
        message: 'Đã điền sẵn bài đăng TikTok cho bạn duyệt' + (warnings.length ? `\n⚠️ ${warnings.join('\n⚠️ ')}` : ''),
        screenshotPath: filledShot,
        posted: false
      };
    }

    // 5c. Tự đăng (hoặc tự bấm "Lên lịch" nếu có hẹn giờ)
    console.error(scheduledFor ? `🚀 Bấm Lên lịch (đăng lúc ${fmtVN(scheduledFor)})...` : '🚀 Bấm Đăng...');
    await postBtn.click();
    let posted = false;
    const postDeadline = Date.now() + 4 * 60000;
    let lastLogTime = 0;
    while (Date.now() < postDeadline) {
      const postNow = page.getByRole('button', { name: TXT.postNow }).first();
      if (await postNow.isVisible().catch(() => false)) await postNow.click().catch(() => {});

      const isContentUrl = /\/tiktokstudio\/content/.test(page.url());
      const hasPostedText = await page.getByText(TXT.posted).first().isVisible().catch(() => false);
      const hasSuccessBtn = await page.getByRole('button', {
        name: /^(Quản lý bài đăng|Manage posts|Tải lên video khác|Upload another video|Xem bài đăng|View post)$/i
      }).first().isVisible().catch(() => false);

      if (isContentUrl || hasPostedText || hasSuccessBtn) {
        posted = true;
        break;
      }

      if (Date.now() - lastLogTime > 15000) {
        lastLogTime = Date.now();
        console.error('⏳ Đang chờ TikTok hoàn tất đăng (máy chủ đang xử lý video)...');
      }

      await page.waitForTimeout(2000);
    }

    const doneMsg = scheduledFor
      ? `Đã lên lịch đăng video TikTok lúc ${fmtVN(scheduledFor)}!`
      : 'Đã đăng video lên TikTok!';
    const unknownMsg = `Đã bấm ${scheduledFor ? 'Lên lịch' : 'Đăng'} nhưng chưa xác nhận được là thành công, kiểm tra lại TikTok Studio`;
    console.error(posted ? `🎉 ${doneMsg}` : `❓ ${unknownMsg}`);
    const screenshotPath = await shot(page, screenshotsDir, posted ? 'posted' : 'post_unknown');
    await context.close();
    return {
      success: posted,
      posted,
      scheduledFor,
      message: (posted ? doneMsg : unknownMsg)
        + (warnings.length ? `\n⚠️ ${warnings.join('\n⚠️ ')}` : ''),
      screenshotPath
    };
  } catch (error) {
    console.error('❌ Lỗi đăng TikTok:', error.message);
    const screenshotPath = await shot(page, screenshotsDir, 'error');
    if (!closedByUser) await context.close().catch(() => {});
    return { success: false, posted: false, message: `Lỗi đăng TikTok: ${String(error.message).split('\n')[0].slice(0, 300)}`, screenshotPath };
  }
}

// Tìm video / thumbnail / caption trong 1 thư mục kết quả (results/result_xxx)
function loadResultDir(dir) {
  const files = fs.readdirSync(dir);
  const find = (re) => files.find((f) => re.test(f));
  const video = find(/^video\./);
  const thumb = find(/^thumbnail\./);
  const caption = find(/^caption\.txt$/);
  return {
    videoPath: video && path.join(dir, video),
    thumbnailPath: thumb && path.join(dir, thumb),
    caption: caption ? fs.readFileSync(path.join(dir, caption), 'utf8') : ''
  };
}

module.exports = { uploadToTikTok, loadResultDir, addProductLink, setSchedule, normalizeSchedule };

// Giờ hẹn dạng "HH:mm" (hôm nay, qua rồi thì ngày mai) hoặc "YYYY-MM-DD HH:mm"
function parseScheduleArg(text) {
  let m = String(text).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  m = String(text).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date();
  d.setHours(+m[1], +m[2], 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

// Chạy riêng:  node tiktok_upload.js [results/result_xxx] ["link hoặc ID sản phẩm"] ["HH:mm" | "YYYY-MM-DD HH:mm"]
//              (không truyền thư mục thì lấy kết quả mới nhất; có giờ thì hẹn giờ đăng trên TikTok)
if (require.main === module) {
  const args = process.argv.slice(2);
  const isProduct = (a) => /tiktok\.com/i.test(a) || /^\d{15,22}$/.test(a);
  const scheduleArg = args.find((a) => parseScheduleArg(a));
  const scheduleAt = scheduleArg ? parseScheduleArg(scheduleArg) : null;
  let dir = args.find((a) => !isProduct(a) && a !== scheduleArg);
  const productArg = args.find(isProduct);
  if (scheduleAt) console.error(`⏰ Hẹn giờ đăng: ${fmtVN(scheduleAt)}`);
  if (!dir) {
    const root = path.join(__dirname, 'results');
    const latest = fs.existsSync(root) && fs.readdirSync(root).filter((d) => d.startsWith('result_')).sort().pop();
    if (!latest) {
      console.log('Không có thư mục kết quả nào trong results/');
      process.exit(1);
    }
    dir = path.join(root, latest);
  }
  console.error(`📁 Dùng kết quả: ${dir}`);
  const { parseProductLink } = require('./product_link');
  (productArg ? parseProductLink(productArg) : Promise.resolve(null)).then((product) => {
    if (productArg && !product) console.error('⚠️ Không đọc được ID sản phẩm, đăng không gắn sản phẩm');
    return uploadToTikTok({ ...loadResultDir(dir), product, scheduleAt, onProgress: (m) => console.error(m) });
  }).then((res) => {
    console.log(JSON.stringify(res));
    process.exit(res.success ? 0 : 1);
  });
}
