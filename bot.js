const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { runAutomation } = require('./automation');
const { uploadToTikTok } = require('./tiktok_upload');
const { findTikTokUrl, parseProductLink, shortProductName } = require('./product_link');
const { getFlowCredits, waitCreditsIdle } = require('./google_credits');
const { listGoogleAccounts, getGoogleAccount } = require('./accounts');
require('dotenv').config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN || BOT_TOKEN === 'your_telegram_bot_token_here') {
  console.error('❌ Lỗi: Bạn chưa cung cấp TELEGRAM_BOT_TOKEN trong file .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

const userDrafts = new Map();

let isProcessing = false;
const queue = [];

// Tin tiến trình ("Đang đợi video render...", "Đang tải video lên TikTok...") chỉ ghi ra console.
// Chỉ gửi Telegram các tin cảnh báo / lỗi / cần bạn làm gì đó, để không bị spam tin nhắn.
const IMPORTANT_MSG = /^\s*(⚠️|⚠|⛔|❌|⏸️|⏸)/u;
function progressNotifier(ctx) {
  return (msg) => {
    console.log(msg);
    if (IMPORTANT_MSG.test(String(msg))) ctx.reply(msg).catch(() => {});
  };
}

async function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;

  const item = queue.shift();
  const { ctx, imagePaths, product, scheduleAt } = item;
  const account = item.account || listGoogleAccounts()[0];

  try {
    if (!account) throw new Error('Chưa có tài khoản Google Flow nào. Chạy: node login.js');
    // Đánh dấu hồ sơ đang dùng (không kiểm tra credit trên hồ sơ này nữa), rồi đợi lần kiểm tra credit
    // đang chạy (nếu có) đóng Chrome xong mới mở Google Flow trên cùng hồ sơ
    activeProfileDir = account.dir;
    await waitCreditsIdle();
    console.log(`⏳ [BẮT ĐẦU] Tài khoản ${account.id}: mở Google Flow, tải ảnh sản phẩm lên và tạo kịch bản video...`);

    const result = await runAutomation(imagePaths, {
      onProgress: progressNotifier(ctx),
      userDataDir: account.dir,
      flowUrl: account.flowUrl
    });
    activeProfileDir = null;

    // Thành công thì chỉ gửi video/thumbnail/caption bên dưới, không gửi thêm tin "Đã tạo xong..."
    if (result.success) console.log(`🎉 ${result.message}`);
    else await ctx.reply(`⚠️ ${String(result.message).slice(0, 3500)}`);

    const files = result.files || {};
    let videoSent = false;
    if (files.video) {
      // Bot Telegram chỉ gửi được file <= 50MB
      const sizeMB = fs.statSync(files.video).size / 1024 / 1024;
      if (sizeMB <= 50) {
        videoSent = await ctx.replyWithVideo({ source: files.video }, { caption: '🎞️ Video TikTok' })
          .catch(() => ctx.replyWithDocument({ source: files.video }, { caption: '🎞️ Video TikTok' }))
          .then(() => true, () => false);
      } else {
        await ctx.reply(`🎞️ Video nặng ${sizeMB.toFixed(1)}MB, vượt giới hạn 50MB của Telegram. File ở: ${files.video}`);
      }
    }
    if (files.thumbnail) {
      await ctx.replyWithPhoto({ source: files.thumbnail }, { caption: '🖼️ Thumbnail' })
        .catch(() => ctx.replyWithDocument({ source: files.thumbnail }, { caption: '🖼️ Thumbnail' }));
    }
    if (files.captionText) {
      // Không dùng parse_mode để hashtag / ký tự đặc biệt không làm lỗi tin nhắn
      await ctx.reply(`📝 Caption & Hashtags:\n\n${files.captionText}`.slice(0, 4000));
    }

    // Có video rồi thì chỉ gửi ảnh chụp màn hình khi lỗi
    if (!result.success && result.screenshotPath && fs.existsSync(result.screenshotPath)) {
      await ctx.replyWithPhoto({ source: result.screenshotPath }, { caption: '📸 Ảnh chụp màn hình trạng thái' });
    }

    // Bước 5: đăng lên TikTok Studio
    if (result.success && files.video) {
      console.log(scheduleAt
        ? `📱 Bắt đầu tải video lên TikTok Studio và hẹn giờ đăng lúc ${formatTime(scheduleAt)}...`
        : '📱 Bắt đầu đăng video lên TikTok Studio...');
      const tt = await uploadToTikTok({
        videoPath: files.video,
        product,
        scheduleAt,
        thumbnailPath: files.thumbnail,
        caption: files.captionText || '',
        onProgress: progressNotifier(ctx)
      });
      // 1 tin kết quả cuối cùng (kèm cảnh báo nếu có); ảnh chụp TikTok Studio chỉ gửi khi lỗi
      await ctx.reply(`${tt.success ? '✅' : '⚠️'} ${tt.message}`);
      if (!tt.success && tt.screenshotPath && fs.existsSync(tt.screenshotPath)) {
        await ctx.replyWithPhoto({ source: tt.screenshotPath }, { caption: '📸 TikTok Studio' }).catch(() => {});
      }

      // Đã gửi video lên Telegram + đăng/lên lịch TikTok thành công -> dọn dữ liệu cho nhẹ project.
      // Lỗi thì giữ lại để kiểm tra / chạy lại.
      if (videoSent && tt.success) {
        const freedMB = cleanupData(imagePaths);
        console.log(`🧹 Đã dọn screenshots, results, downloads (giải phóng ${freedMB.toFixed(1)}MB)`);
      }
    }

  } catch (error) {
    console.error('Lỗi khi xử lý tác vụ:', error);
    await ctx.reply(`❌ Có lỗi xảy ra: ${String(error.message).slice(0, 1000)}`).catch(() => {});
  } finally {
    activeProfileDir = null;
    isProcessing = false;
    processQueue();
  }
}

// Xóa file/thư mục, trả về số byte đã xóa
function removeAndMeasure(p) {
  let bytes = 0;
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) bytes += removeAndMeasure(path.join(p, f));
    else bytes = st.size;
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) { /* đã bị xóa / không truy cập được */ }
  return bytes;
}

// Dọn dữ liệu sau khi tác vụ thành công. Hàng đợi chạy lần lượt nên lúc này không tác vụ nào khác đang ghi
// vào screenshots/results. Riêng downloads: giữ ảnh của các tác vụ đang chờ trong hàng đợi / đang soạn.
function cleanupData(jobImagePaths) {
  let bytes = 0;
  for (const dir of ['screenshots', 'results']) {
    const full = path.join(__dirname, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) bytes += removeAndMeasure(path.join(full, f));
  }
  const keep = new Set([
    ...queue.flatMap((q) => q.imagePaths || []),
    ...[...userDrafts.values()].flatMap((d) => d.images.map((i) => i.path))
  ].map((p) => path.resolve(p)));
  for (const p of jobImagePaths) keep.delete(path.resolve(p));
  for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
    const full = path.resolve(DOWNLOAD_DIR, f);
    if (!keep.has(full)) bytes += removeAndMeasure(full);
  }
  return bytes / 1024 / 1024;
}

function newDraft() {
  return { images: [], pendingDownloads: 0, menuTimer: null, scheduledTime: null, awaitingCustomTime: false, product: null };
}

// Escape ký tự Markdown (tên sản phẩm hay có _ [ ] làm lỗi parse_mode Markdown)
function escapeMd(text) {
  return String(text).replace(/([_*`\[\]])/g, '\\$1');
}

function productLine(product) {
  if (!product) return '🔗 Sản phẩm TikTok Shop: chưa gắn (gửi link sản phẩm để gắn)';
  const name = product.title ? `\n🏷️ Tên trên video: ${escapeMd(shortProductName(product.title))}` : '';
  return `🔗 Sản phẩm TikTok Shop: ${product.id}${name}`;
}

function formatTime(date) {
  return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

// ===== Nhiều tài khoản Google Flow (mỗi tài khoản 1 hồ sơ Chrome: user_data, user_data_2, ...) =====
let activeProfileDir = null; // hồ sơ Chrome mà Google Flow đang dùng để tạo video
const lastCredits = new Map(); // dir -> credit lấy được lần gần nhất

function accountName(acc) {
  return acc.credits?.email || lastCredits.get(acc.dir)?.email || `Tài khoản ${acc.id}`;
}

// Lấy credit của mọi tài khoản. Hồ sơ đang tạo video thì không mở thêm Chrome, dùng số lần trước.
async function loadAccounts({ force = false } = {}) {
  return Promise.all(listGoogleAccounts().map(async (acc) => {
    if (acc.dir === activeProfileDir) return { ...acc, busy: true, credits: lastCredits.get(acc.dir) };
    try {
      const credits = await getFlowCredits(acc.dir, { force });
      lastCredits.set(acc.dir, credits);
      return { ...acc, credits };
    } catch (e) {
      console.error(`Lỗi lấy credit tài khoản ${acc.id}:`, e.message);
      return { ...acc, error: e.message.split('\n')[0].slice(0, 100) };
    }
  }));
}

function accountLine(acc) {
  const name = escapeMd(accountName(acc));
  if (acc.error) return `👤 ${name}: ⚠️ không lấy được credit (${escapeMd(acc.error)})`;
  const c = acc.credits;
  if (acc.busy) return `👤 ${name}: ⏳ đang tạo video${c ? ` (lần trước: ${c.flow} credits)` : ''}`;
  const total = (c.flow || 0) + (c.daily || 0) + (c.ai || 0);
  return `👤 ${name}: 💳 **${c.flow}** credits${total === 0 ? ' ⚠️ hết credit' : ''}`;
}

function creditLine(draft) {
  const a = draft.accounts;
  if (!a || a.status === 'loading') return '💳 Google Flow credits: ⏳ đang kiểm tra...';
  if (!a.list.length) return '⚠️ Chưa có tài khoản Google Flow nào. Chạy: node login.js';
  return `💳 Google Flow credits:\n${a.list.map(accountLine).join('\n')}`;
}

// Hiện lại đúng màn hình đang mở (menu chính hoặc màn chọn tài khoản)
function renderView(draft) {
  return draft.view === 'chooser' ? buildAccountChooser(draft) : buildControlKeyboard(draft);
}

// Lấy credit rồi sửa lại tin nhắn đang hiện (không bắt người dùng chờ trước khi thấy menu)
async function refreshCredits(telegram, chatId, messageId, draft, { force = false } = {}) {
  draft.accounts = { status: 'ok', list: await loadAccounts({ force }) };
  if (userDrafts.get(chatId) !== draft || !messageId) return;
  const view = renderView(draft);
  await telegram.editMessageText(chatId, messageId, undefined, view.caption, { parse_mode: 'Markdown', ...view.keyboard })
    .catch(() => {}); // "message is not modified" / tin nhắn đã bị thay
}

// Gửi menu THÔNG TIN TÁC VỤ, rồi cập nhật dòng credit khi lấy xong
async function sendMenu(ctx, draft) {
  draft.accounts = { status: 'loading' };
  const menu = buildControlKeyboard(draft);
  const msg = await ctx.reply(menu.caption, { parse_mode: 'Markdown', ...menu.keyboard });
  refreshCredits(ctx.telegram, ctx.chat.id, msg.message_id, draft).catch(() => {});
}

// Màn chọn tài khoản Google Flow khi bấm START
function buildAccountChooser(draft) {
  draft.view = 'chooser';
  const a = draft.accounts;
  const list = a?.status === 'ok' ? a.list : listGoogleAccounts();
  const buttons = list.map((acc) => {
    const c = acc.credits;
    const info = acc.error ? '⚠️ lỗi credit' : c ? `${c.flow} credits` : '⏳';
    return [Markup.button.callback(`👤 ${accountName(acc)} — ${info}`, `start_acc:${acc.id}`)];
  });
  return {
    caption: `👤 **CHỌN TÀI KHOẢN GOOGLE FLOW ĐỂ TẠO VIDEO:**\n\n${creditLine(draft)}`,
    keyboard: Markup.inlineKeyboard([
      ...buttons,
      [Markup.button.callback('🔄 Cập nhật credit', 'refresh_credits'), Markup.button.callback('🔙 Quay lại', 'sched_back')]
    ])
  };
}

function buildControlKeyboard(draft) {
  draft.view = 'menu';
  const timeText = draft.scheduledTime
    ? `⏰ Hẹn giờ đăng TikTok: ${formatTime(draft.scheduledTime)} (video vẫn được tạo ngay khi bấm Start)`
    : '⚡ Đăng TikTok ngay khi tạo xong video';

  return {
    caption: `📦 **THÔNG TIN TÁC VỤ:**\n` +
             `🖼️ Ảnh sản phẩm: ${draft.images.length} ảnh (cùng 1 sản phẩm)\n` +
             `${productLine(draft.product)}\n` +
             `${creditLine(draft)}\n` +
             `➕ Gửi thêm ảnh để bổ sung cho sản phẩm này, bấm Hủy để làm sản phẩm mới\n` +
             `⏱️ ${timeText}\n\n` +
             `👉 Chọn cài đặt thời gian bên dưới hoặc bấm **START** để tiến hành:`,
    keyboard: Markup.inlineKeyboard([
      [
        Markup.button.callback('⚡ Đăng ngay', 'set_run_now'),
        Markup.button.callback('⏰ Hẹn giờ đăng TikTok', 'menu_schedule')
      ],
      [
        Markup.button.callback('🔄 Cập nhật credit', 'refresh_credits')
      ],
      [
        Markup.button.callback('🚀 BẮT ĐẦU CHẠY (START)', 'action_start')
      ],
      [
        Markup.button.callback('❌ Hủy tác vụ', 'action_cancel')
      ]
    ])
  };
}

bot.start((ctx) => {
  ctx.reply(
    `👋 Chào mừng bạn đến với Bot tự động hóa Google Flow!\n\n` +
    `👉 **Quy trình sử dụng:**\n` +
    `1. Gửi ảnh sản phẩm vào đây (có thể dán link sản phẩm TikTok Shop vào chú thích ảnh, hoặc gửi link riêng).\n` +
    `2. Chọn thời điểm đăng TikTok (Đăng ngay hoặc Hẹn giờ đăng). Video luôn được tạo ngay khi bấm Start.\n` +
    `3. Bấm nút **[🚀 BẮT ĐẦU CHẠY (START)]** để kích hoạt!`
  );
});

bot.on('photo', async (ctx) => {
  const chatId = ctx.chat.id;

  // Telegram gửi album (nhiều ảnh cùng lúc) thành nhiều tin nhắn photo riêng lẻ.
  // Gộp tất cả ảnh gửi liên tiếp vào CÙNG MỘT draft = 1 sản phẩm, chỉ hiện 1 menu sau khi nhận xong.
  // Draft phải được tạo đồng bộ (trước mọi await) để các tin nhắn đến song song không tạo ra nhiều draft.
  let draft = userDrafts.get(chatId);
  if (!draft) {
    draft = newDraft();
    userDrafts.set(chatId, draft);
  }
  const isFirstPhoto = draft.images.length === 0 && draft.pendingDownloads === 0;
  draft.pendingDownloads++;
  clearTimeout(draft.menuTimer);

  try {
    if (isFirstPhoto) await ctx.reply('📥 Đang nhận ảnh sản phẩm...');

    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
    const fileName = `product_${chatId}_${Date.now()}_${ctx.message.message_id}.jpg`;
    const destPath = path.join(DOWNLOAD_DIR, fileName);

    const response = await axios({ method: 'GET', url: fileLink.href, responseType: 'stream' });
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(destPath);
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    draft.images.push({ messageId: ctx.message.message_id, path: destPath });

    // Link sản phẩm dán trong chú thích ảnh
    if (findTikTokUrl(ctx.message.caption)) {
      const product = await parseProductLink(ctx.message.caption).catch(() => null);
      if (product) draft.product = product;
      else ctx.reply('⚠️ Không đọc được ID sản phẩm từ link trong chú thích ảnh.');
    }
  } catch (err) {
    console.error('Lỗi nhận ảnh:', err);
    ctx.reply(`❌ Không thể tải ảnh từ Telegram: ${err.message}`);
  } finally {
    draft.pendingDownloads--;
  }

  // Đợi 1.5s không có ảnh mới và mọi ảnh đã tải xong mới hiện menu (1 menu cho cả album)
  if (userDrafts.get(chatId) !== draft) return;
  clearTimeout(draft.menuTimer);
  draft.menuTimer = setTimeout(async () => {
    if (draft.pendingDownloads > 0 || draft.images.length === 0 || userDrafts.get(chatId) !== draft) return;
    draft.images.sort((x, y) => x.messageId - y.messageId);
    await sendMenu(ctx, draft);
  }, 1500);
});

function draftImagePaths(draft) {
  return draft.images.sort((x, y) => x.messageId - y.messageId).map((i) => i.path);
}

bot.action('set_run_now', async (ctx) => {
  const chatId = ctx.chat.id;
  const draft = userDrafts.get(chatId);
  if (!draft) return ctx.answerCbQuery('Không tìm thấy ảnh. Vui lòng gửi ảnh mới!');

  draft.scheduledTime = null;
  draft.awaitingCustomTime = false;

  await ctx.answerCbQuery('Đã chuyển sang chế độ: Đăng TikTok ngay khi tạo xong video');
  const menu = buildControlKeyboard(draft);
  await ctx.editMessageText(menu.caption, { parse_mode: 'Markdown', ...menu.keyboard });
});

bot.action('refresh_credits', async (ctx) => {
  const chatId = ctx.chat.id;
  const draft = userDrafts.get(chatId);
  if (!draft) return ctx.answerCbQuery('Không tìm thấy ảnh. Vui lòng gửi ảnh mới!');
  await ctx.answerCbQuery('Đang kiểm tra credit...');
  const messageId = ctx.callbackQuery.message?.message_id;
  draft.accounts = { status: 'loading' };
  const view = renderView(draft);
  await ctx.editMessageText(view.caption, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => {});
  await refreshCredits(ctx.telegram, chatId, messageId, draft, { force: true });
});

bot.action('menu_schedule', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '⏰ **CHỌN GIỜ ĐĂNG TIKTOK:**\n\n' +
    'Bot sẽ tạo video ngay, rồi dùng chức năng "Lên lịch" của TikTok để video tự đăng vào giờ bạn chọn.\n' +
    '(TikTok yêu cầu giờ đăng cách lúc tải lên ít nhất 15 phút, tối đa 10 ngày; phút làm tròn lên bước 5.)',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('⏱️ Sau 15 phút', 'sched_15m'),
          Markup.button.callback('⏱️ Sau 30 phút', 'sched_30m')
        ],
        [
          Markup.button.callback('⏱️ Sau 1 giờ', 'sched_1h'),
          Markup.button.callback('⏱️ Sau 2 giờ', 'sched_2h')
        ],
        [
          Markup.button.callback('✏️ Tự gõ giờ (VD: 15:30)', 'sched_custom')
        ],
        [
          Markup.button.callback('🔙 Quay lại', 'sched_back')
        ]
      ])
    }
  );
});

function setDelayMinutes(ctx, minutes) {
  const chatId = ctx.chat.id;
  const draft = userDrafts.get(chatId);
  if (!draft) return ctx.answerCbQuery('Không tìm thấy ảnh. Vui lòng gửi ảnh mới!');

  draft.scheduledTime = new Date(Date.now() + minutes * 60 * 1000);
  draft.awaitingCustomTime = false;

  ctx.answerCbQuery(`Đã hẹn giờ đăng TikTok sau ${minutes} phút`);
  const menu = buildControlKeyboard(draft);
  ctx.editMessageText(menu.caption, { parse_mode: 'Markdown', ...menu.keyboard });
}

bot.action('sched_15m', (ctx) => setDelayMinutes(ctx, 15));
bot.action('sched_30m', (ctx) => setDelayMinutes(ctx, 30));
bot.action('sched_1h', (ctx) => setDelayMinutes(ctx, 60));
bot.action('sched_2h', (ctx) => setDelayMinutes(ctx, 120));

bot.action('sched_custom', async (ctx) => {
  const chatId = ctx.chat.id;
  const draft = userDrafts.get(chatId);
  if (!draft) return ctx.answerCbQuery('Không tìm thấy ảnh.');

  draft.awaitingCustomTime = true;
  await ctx.answerCbQuery();
  await ctx.reply(
    '✍️ Hãy nhập giờ bạn muốn video ĐĂNG lên TikTok theo định dạng **HH:mm** (ví dụ: `14:30` hoặc `20:00`):',
    { parse_mode: 'Markdown' }
  );
});

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  let draft = userDrafts.get(chatId);

  // Gửi link sản phẩm TikTok Shop (hoặc chỉ dãy ID) -> gắn vào sản phẩm đang chuẩn bị
  const text = ctx.message.text.trim();
  if (findTikTokUrl(text) || /^\d{15,22}$/.test(text)) {
    const product = await parseProductLink(text).catch(() => null);
    if (!product) {
      return ctx.reply('⚠️ Không tìm thấy ID sản phẩm trong link này. Hãy vào sản phẩm trên app TikTok → Chia sẻ → Sao chép liên kết rồi gửi lại.');
    }
    if (!draft) {
      draft = newDraft();
      userDrafts.set(chatId, draft);
    }
    draft.product = product;
    await ctx.reply(`✅ Đã gắn sản phẩm: ${product.id}` +
      (product.title ? `\n📦 ${product.title}\n🏷️ Tên trên video: ${shortProductName(product.title)}` : ''));
    if (draft.images.length === 0) return ctx.reply('📷 Giờ gửi ảnh sản phẩm để bắt đầu.');
    return sendMenu(ctx, draft);
  }

  if (draft && draft.awaitingCustomTime) {
    const text = ctx.message.text.trim();
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
    const match = text.match(timeRegex);

    if (match) {
      const hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);

      const target = new Date();
      target.setHours(hours, minutes, 0, 0);

      if (target.getTime() <= Date.now()) {
        target.setDate(target.getDate() + 1);
      }

      draft.scheduledTime = target;
      draft.awaitingCustomTime = false;

      await ctx.reply(`✅ Đã hẹn giờ đăng TikTok lúc: ${formatTime(target)}`);
      const menu = buildControlKeyboard(draft);
      await ctx.reply(menu.caption, { parse_mode: 'Markdown', ...menu.keyboard });
    } else {
      await ctx.reply('⚠️ Định dạng không đúng. Vui lòng nhập theo dạng **HH:mm** (VD: `14:30`):');
    }
  }
});

bot.action('sched_back', async (ctx) => {
  const chatId = ctx.chat.id;
  const draft = userDrafts.get(chatId);
  if (!draft) return ctx.answerCbQuery();

  await ctx.answerCbQuery();
  const menu = buildControlKeyboard(draft);
  await ctx.editMessageText(menu.caption, { parse_mode: 'Markdown', ...menu.keyboard });
});

bot.action('action_start', async (ctx) => {
  const chatId = ctx.chat.id;
  const draft = userDrafts.get(chatId);

  if (!draft) {
    return ctx.answerCbQuery('Không có tác vụ nào đang chờ. Hãy gửi ảnh mới!');
  }

  if (draft.pendingDownloads > 0 || draft.images.length === 0) {
    return ctx.answerCbQuery('Ảnh vẫn đang tải, đợi vài giây rồi bấm lại!');
  }

  const accounts = listGoogleAccounts();
  if (accounts.length === 0) return ctx.answerCbQuery('Chưa có tài khoản Google nào. Chạy: node login.js', { show_alert: true });
  // Chỉ 1 tài khoản -> chạy luôn; nhiều tài khoản -> hiện danh sách kèm credit để chọn
  if (accounts.length === 1) return startJob(ctx, draft, accounts[0]);

  await ctx.answerCbQuery();
  const view = buildAccountChooser(draft);
  await ctx.editMessageText(view.caption, { parse_mode: 'Markdown', ...view.keyboard }).catch(() => {});
  const fresh = draft.accounts?.status === 'ok' && draft.accounts.list.length === accounts.length;
  if (!fresh) {
    draft.accounts = { status: 'loading' };
    refreshCredits(ctx.telegram, chatId, ctx.callbackQuery.message?.message_id, draft).catch(() => {});
  }
});

bot.action(/^start_acc:(\d+)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  const draft = userDrafts.get(chatId);
  if (!draft) return ctx.answerCbQuery('Không có tác vụ nào đang chờ. Hãy gửi ảnh mới!');
  if (draft.pendingDownloads > 0 || draft.images.length === 0) {
    return ctx.answerCbQuery('Ảnh vẫn đang tải, đợi vài giây rồi bấm lại!');
  }
  const account = getGoogleAccount(ctx.match[1]);
  if (!account) return ctx.answerCbQuery('Không tìm thấy tài khoản này nữa, bấm 🔄 Cập nhật credit');
  // Giữ email đã biết để hiện trong tin nhắn
  account.credits = draft.accounts?.list?.find((a) => a.id === account.id)?.credits || lastCredits.get(account.dir);
  return startJob(ctx, draft, account);
});

async function startJob(ctx, draft, account) {
  const chatId = ctx.chat.id;
  await ctx.answerCbQuery('Đã kích hoạt!').catch(() => {});
  clearTimeout(draft.menuTimer);
  userDrafts.delete(chatId);

  // Luôn tạo video ngay. Có hẹn giờ thì hẹn giờ ĐĂNG bằng "Lên lịch" của TikTok (lịch lưu trên TikTok, tắt bot không mất)
  const scheduleAt = draft.scheduledTime && draft.scheduledTime.getTime() > Date.now() ? draft.scheduledTime : null;
  const accText = `👤 Tài khoản Google Flow: ${escapeMd(accountName(account))}`;
  const queued = isProcessing ? '\n⏳ Bot đang tạo video khác, tác vụ này sẽ chạy sau khi xong.' : '';
  await ctx.reply(scheduleAt
    ? `🚀 **BẮT ĐẦU TẠO VIDEO!**\n${accText}\n📅 Video sẽ được hẹn giờ đăng TikTok lúc: **${formatTime(scheduleAt)}**.${queued}`
    : `🚀 **BẮT ĐẦU TẠO VIDEO!** (tạo xong sẽ đăng TikTok luôn)\n${accText}${queued}`, { parse_mode: 'Markdown' });
  queue.push({ ctx, imagePaths: draftImagePaths(draft), product: draft.product, scheduleAt, account });
  processQueue();
}

bot.action('action_cancel', async (ctx) => {
  const chatId = ctx.chat.id;
  clearTimeout(userDrafts.get(chatId)?.menuTimer);
  userDrafts.delete(chatId);
  await ctx.answerCbQuery('Đã hủy tác vụ.');
  await ctx.editMessageText('❌ Tác vụ đã được hủy. Bạn có thể gửi ảnh mới bất kỳ lúc nào.');
});

bot.launch().then(() => {
  console.log('--------------------------------------------------');
  console.log('🤖 Telegram Bot (Interactive & Scheduler) đã sẵn sàng!');
  console.log('--------------------------------------------------');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
