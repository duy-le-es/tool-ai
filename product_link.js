const axios = require('axios');

const TIKTOK_URL_RE = /https?:\/\/[^\s]*tiktok\.com[^\s]*/i;
const SHORT_LINK_RE = /^https?:\/\/(vt|vm)\.tiktok\.com\//i;

// Lấy link TikTok đầu tiên trong 1 đoạn text (caption ảnh / tin nhắn)
function findTikTokUrl(text) {
  const m = String(text || '').match(TIKTOK_URL_RE);
  return m ? m[0] : null;
}

// Link rút gọn vt.tiktok.com / vm.tiktok.com -> đi theo redirect để lấy link đầy đủ có ID
async function resolveShortLink(url) {
  let current = url;
  for (let i = 0; i < 5 && SHORT_LINK_RE.test(current); i++) {
    const res = await axios.get(current, {
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
      timeout: 15000
    });
    if (!res.headers.location) break;
    current = new URL(res.headers.location, current).href;
  }
  return current;
}

function parseJsonParam(u, name) {
  try {
    return JSON.parse(u.searchParams.get(name) || 'null');
  } catch (_) {
    return null;
  }
}

/**
 * Tách ID + tên sản phẩm từ link chia sẻ TikTok Shop. Hỗ trợ:
 *  - https://shop.tiktok.com/vn/pdp/1734647997281633643?...
 *  - https://www.tiktok.com/view/product/1734647997281633643?...
 *  - link rút gọn https://vt.tiktok.com/ZSxxxx/
 *  - chỉ gửi mỗi dãy ID
 * @returns {Promise<{id: string, title: string, url: string} | null>}
 */
async function parseProductLink(input) {
  const text = String(input || '').trim();
  if (/^\d{15,22}$/.test(text)) return { id: text, title: '', url: '' };

  let url = findTikTokUrl(text);
  if (!url) return null;
  if (SHORT_LINK_RE.test(url)) url = await resolveShortLink(url);

  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return null;
  }

  const fromPath = u.pathname.match(/\/(?:pdp|product)\/(?:[^/]+\/)?(\d{15,22})/);
  const shareParams = parseJsonParam(u, 'ec_search_share_params');
  const id = (fromPath && fromPath[1]) || (shareParams && shareParams.product_id) || u.searchParams.get('product_id');
  if (!id) return null;

  const og = parseJsonParam(u, 'og_info');
  return { id: String(id), title: (og && og.title) || '', url };
}

// Từ nối không nên đứng cuối tên (vd "... tiết kiệm cho")
const DANGLING = /\s+(cho|và|của|với|dành|loại|kèm|tặng|các|những|từ|tại|bằng|siêu|cực|rất|&|\+|-)$/i;

// Cắt text <= max ký tự tại ranh giới từ (không cắt giữa chữ), bỏ từ nối lửng lơ ở cuối
function cutAtWord(text, max) {
  const words = text.split(/\s+/).filter(Boolean);
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  while (DANGLING.test(out)) out = out.replace(DANGLING, '');
  return out;
}

/**
 * Tên hiển thị sản phẩm trên video TikTok (tối đa 30 ký tự), không để chữ bị hụt.
 * "[Giá Sốc_ 89K 1 Thùng]_Nước chấm Đầu Bếp Tôm_Tôm thật pha sẵn_6 chai nhựa 800ml" -> "Nước chấm Đầu Bếp Tôm"
 */
function shortProductName(title, max = 30) {
  let src = String(title || '').trim();
  // Tên nguồn đã bị cắt sẵn ("…", "...") -> chữ cuối có thể bị hụt, bỏ đi
  if (/(…|\.\.\.)$/.test(src)) src = src.replace(/(…|\.\.\.)$/, '').replace(/\s*\S*$/, '');
  const clean = src
    .replace(/[\[【(（][^\]】)）]*[\]】)）]/g, ' ') // bỏ phần trong ngoặc: [Giá Sốc...], (Freeship)...
    .replace(/\s+/g, ' ')
    .trim();
  // Tên sản phẩm hay nối các ý bằng _ | - , -> ý đầu tiên thường là tên chính
  const parts = clean.split(/\s*[_|,]\s*|\s+-\s+/).map((x) => x.trim()).filter(Boolean);
  let name = cutAtWord(parts[0] || '', max);
  // Ý đầu quá ngắn (vd "Áo thun") thì ghép thêm ý sau nếu còn vừa
  if (name && name.length < 12 && parts[1] && `${name} ${parts[1]}`.length <= max) name = `${name} ${parts[1]}`;
  // Không còn gì (vd tên toàn trong ngoặc) -> dùng tên gốc cắt theo từ
  if (!name) name = cutAtWord(String(title || '').replace(/[_\[\]【】()（）]/g, ' '), max);
  return name;
}

module.exports = { findTikTokUrl, parseProductLink, shortProductName };
