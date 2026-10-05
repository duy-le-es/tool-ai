const { chromium } = require('playwright');
const { listGoogleAccounts } = require('./accounts');
require('dotenv').config();

// Trang Google One hiển thị số credit Google Flow còn lại của tài khoản
const CREDITS_URL = process.env.GOOGLE_CREDITS_URL
  || 'https://one.google.com/ai/activity?utm_source=flow&utm_medium=web&utm_campaign=flow_ai_credits_page&pli=1&g1_landing_page=0';
const CACHE_MS = 60 * 1000;

const cache = new Map(); // dir -> { at, value }
const running = new Map(); // dir -> Promise đang lấy credit (tránh mở 2 Chrome cùng lúc trên cùng hồ sơ)

const toNumber = (s) => (s == null ? null : Number(String(s).replace(/[.,\s]/g, '')));

/**
 * Lấy số credit Google Flow còn lại + email của tài khoản trong hồ sơ Chrome `dir`.
 * @returns {Promise<{flow: number|null, daily: number|null, ai: number|null, email: string|null, at: Date}>}
 */
async function fetchFlowCredits(dir) {
  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 900 }
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(CREDITS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (/accounts\.google\.com/.test(page.url())) throw new Error('Google chưa đăng nhập');
    await page.getByText(/Flow credits/i).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => document.body.innerText);
    // Vd: "Google Flow credits\n625\n0 daily Flow credits remaining. ... AI credits\n0"
    const flow = text.match(/Google Flow credits\s*\n\s*([\d.,]+)/i);
    const daily = text.match(/([\d.,]+)\s+daily Flow credits remaining/i);
    const ai = text.match(/(?:^|\n)\s*AI credits\s*\n\s*([\d.,]+)/i);
    if (!flow) throw new Error('Không đọc được số credit trên trang Google One');
    // Ảnh đại diện góc phải: aria-label "Google Account: Tên (email@gmail.com)"
    const label = await page.locator('[aria-label*="@"]').first().getAttribute('aria-label', { timeout: 3000 }).catch(() => '');
    const email = (label || '').match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0] || null;
    return { flow: toNumber(flow[1]), daily: toNumber(daily?.[1]), ai: toNumber(ai?.[1]), email, at: new Date() };
  } finally {
    await context.close().catch(() => {});
  }
}

// Có cache 1 phút + gộp các lần gọi trùng nhau (theo từng hồ sơ)
async function getFlowCredits(dir, { force = false } = {}) {
  const hit = cache.get(dir);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  if (!running.has(dir)) {
    running.set(dir, fetchFlowCredits(dir)
      .then((value) => { cache.set(dir, { at: Date.now(), value }); return value; })
      .finally(() => running.delete(dir)));
  }
  return running.get(dir);
}

// Lấy credit của tất cả tài khoản (song song, mỗi tài khoản 1 hồ sơ riêng). Lỗi của từng tài khoản nằm trong `error`.
async function getAllAccountCredits({ force = false } = {}) {
  return Promise.all(listGoogleAccounts().map(async (acc) => {
    try {
      return { ...acc, credits: await getFlowCredits(acc.dir, { force }) };
    } catch (e) {
      return { ...acc, error: e.message.split('\n')[0].slice(0, 120) };
    }
  }));
}

// Đợi các lần lấy credit đang chạy xong, để automation.js mở được hồ sơ Chrome
function waitCreditsIdle() {
  return Promise.all([...running.values()].map((p) => p.then(() => {}, () => {}))).then(() => {});
}

function formatCredits(c) {
  if (!c) return '';
  const parts = [`${c.flow} Flow credits`];
  if (c.daily != null) parts.push(`${c.daily} credit ngày`);
  if (c.ai != null) parts.push(`${c.ai} AI credits`);
  return parts.join(' · ');
}

module.exports = { getFlowCredits, getAllAccountCredits, formatCredits, waitCreditsIdle };

// Chạy riêng: node google_credits.js  -> in credit của tất cả tài khoản
if (require.main === module) {
  getAllAccountCredits().then((list) => {
    for (const a of list) {
      console.log(`👤 Tài khoản ${a.id} (${a.credits?.email || a.dir}): ${a.error ? `❌ ${a.error}` : `💳 ${formatCredits(a.credits)}`}`);
    }
  });
}
