// =============================================================
// 施設のアイコン（デフォルト25種＋その他）
//   tier: 縮小したときの消えにくさ
//     1 = 画面の幅が 12km くらいまで（役所・病院・名所など）
//     2 = 5km くらいまで（お店・ホテルなど）
//     3 = 2km くらいまで（住宅）
// =============================================================
export const ICONS = {
  gov:        { label: '政府施設',     color: '#4f5bd5', tier: 1, d: 'M4 20h16M6 20V11h12v9M9.5 20v-5h5v5M12 11V4l5 2-5 2' },
  admin:      { label: '行政施設',     color: '#6a55c9', tier: 1, d: 'M3 20h18M5 20V9.5l7-4.5 7 4.5V20M9 13h2M13 13h2M9 16.5h2M13 16.5h2' },
  school:     { label: '学校',         color: '#e0861b', tier: 1, d: 'M2.5 9 12 4l9.5 5L12 14 2.5 9ZM6.5 11.2V16c0 1.4 2.5 3 5.5 3s5.5-1.6 5.5-3v-4.8' },
  hospital:   { label: '病院',         color: '#e5484d', tier: 1, d: 'M12 5.5v13M5.5 12h13' },
  police:     { label: '警察署',       color: '#2d5cc7', tier: 1, d: 'M12 3.5 18.5 6v5c0 4.2-2.8 7.4-6.5 9-3.7-1.6-6.5-4.8-6.5-9V6L12 3.5ZM12 8.5l1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.2-2.4 1.2.5-2.6-1.9-1.8 2.6-.4L12 8.5Z' },
  fire:       { label: '消防署',       color: '#e8502c', tier: 1, d: 'M12 3.5c.8 3 5 4.8 5 9.8a5 5 0 0 1-10 0c0-2.7 1.6-3.8 2-5.6 1 1 1.6 1.8 1.8 2.8 1-1.8 1.4-4.3 1.2-7Z' },
  bank:       { label: '銀行',         color: '#2e8c68', tier: 2, d: 'M3 9.5 12 4.5l9 5M5.5 10.5v7M9.8 10.5v7M14.2 10.5v7M18.5 10.5v7M3 20h18' },
  conv:       { label: 'コンビニ',     color: '#17a398', tier: 2, d: 'M4.5 9h15l-1.2 11H5.7L4.5 9ZM8.5 9V7a3.5 3.5 0 0 1 7 0v2' },
  super:      { label: 'スーパー',     color: '#ef8a2a', tier: 2, d: 'M3 4.5h2.2l2.3 10.5h10.2L20 8H6.8M9.5 19.2h.01M16.5 19.2h.01' },
  food:       { label: '食堂',         color: '#f06e43', tier: 2, d: 'M7.5 3.5v17M5 3.5v4.2a2.5 2.5 0 0 0 5 0V3.5M16.5 20.5v-17c-2 0-3.5 2.8-3.5 6.5 0 2.4 1.2 3.5 3.5 3.5' },
  hotel:      { label: 'ホテル',       color: '#c2509a', tier: 2, d: 'M3 18.5V6.5M3 14h18v4.5M21 14v-1.8A3.2 3.2 0 0 0 17.8 9H11v5M7.2 11.5h.01' },
  motel:      { label: 'モーテル',     color: '#9a57c4', tier: 2, d: 'M4.5 19V7l7.5 7 7.5-7v12' },
  barber:     { label: '散髪屋',       color: '#7a62c8', tier: 2, d: 'M6.5 7.5h.01M6.5 16.5h.01M8.4 8.6 19 17.5M8.4 15.4 19 6.5M4.2 7.5a2.3 2.3 0 1 0 4.6 0 2.3 2.3 0 0 0-4.6 0ZM4.2 16.5a2.3 2.3 0 1 0 4.6 0 2.3 2.3 0 0 0-4.6 0Z' },
  parking:    { label: '駐車場',       color: '#2c72cf', tier: 2, d: 'M8.5 20V4.5h4.8a4 4 0 0 1 0 8H8.5' },
  pharmacy:   { label: '薬局',         color: '#2aae63', tier: 2, d: 'M9.8 4.5h4.4v5.3h5.3v4.4h-5.3v5.3H9.8v-5.3H4.5V9.8h5.3V4.5Z' },
  gas:        { label: 'ガソリンスタンド', color: '#de5f45', tier: 2, d: 'M5 20V5.5A1.5 1.5 0 0 1 6.5 4h6A1.5 1.5 0 0 1 14 5.5V20M3.5 20h12M7 8.5h5M14 9.5h2l2.8 2.8V18a1.4 1.4 0 0 1-2.8 0v-3H14' },
  ev:         { label: 'EVステーション', color: '#1fa4c6', tier: 2, d: 'M13.5 3 6 13.2h5.2L10.5 21 18 10.8h-5.2l.7-7.8Z' },
  camp:       { label: 'キャンプ場',   color: '#5f9636', tier: 1, d: 'M3 20 12 5l9 15M3 20h18M9.2 20 12 15l2.8 5' },
  mountain:   { label: '山',           color: '#8a6a42', tier: 1, d: 'M2.5 19.5 9 8.5l4 6.2 2.2-3 6.3 7.8h-19ZM7.3 11.5l1.7 1.6 1.4-1.4' },
  landmark:   { label: '名所',         color: '#e2588c', tier: 1, d: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8L12 3.5Z' },
  house:      { label: '住宅',         color: '#8a8f97', tier: 3, d: 'M4 11 12 4.5l8 6.5M6.2 9.5V20h11.6V9.5M10 20v-5h4v5' },
  commercial: { label: '商業施設',     color: '#d6623a', tier: 2, d: 'M4 20V9.5l2-5h12l2 5V20H4ZM4 9.5h16M9 20v-5h6v5M8 9.5v.8a2 2 0 0 1-4 0M12 9.5v.8a2 2 0 0 1-4 0M16 9.5v.8a2 2 0 0 1-4 0M20 9.5v.8a2 2 0 0 1-4 0' },
  industrial: { label: '産業建物',     color: '#7a768c', tier: 2, d: 'M3 20V10.5l5 3v-3l5 3v-3l5 3V4.5h3V20H3Z' },
  office:     { label: 'オフィス',     color: '#466b9c', tier: 2, d: 'M4 8h16v11.5H4V8ZM9 8V6a1.2 1.2 0 0 1 1.2-1.2h3.6A1.2 1.2 0 0 1 15 6v2M4 13h16' },
  park:       { label: '公園',         color: '#3a9a4e', tier: 1, d: 'M12 21v-5.5M12 3.5a4.8 4.8 0 0 0-4.4 6.8A3.8 3.8 0 0 0 9 17.5h6a3.8 3.8 0 0 0 1.4-7.2A4.8 4.8 0 0 0 12 3.5Z' },
  other:      { label: 'その他',       color: '#6b7380', tier: 2, d: 'M6.5 12h.01M12 12h.01M17.5 12h.01M5.2 12a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 0 0-2.6 0ZM10.7 12a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 0 0-2.6 0ZM16.2 12a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 0 0-2.6 0Z' },
};
export const ICON_KEYS = Object.keys(ICONS);
const TIER_SPAN = { 1: 12000, 2: 5000, 3: 2000 };
/** 画面に見えている幅 span(m) のときに表示するか */
export const poiVisible = (p, span) => span < (TIER_SPAN[ICONS[p.icon]?.tier || 2]);
export const poiLabelVisible = (p, span) => span < (TIER_SPAN[ICONS[p.icon]?.tier || 2]) * 0.55;

const paths = new Map();
function path2d(key) {
  if (!paths.has(key)) paths.set(key, new Path2D(ICONS[key]?.d || ICONS.landmark.d));
  return paths.get(key);
}
/** 地図上にアイコンを描く（中心 x,y・半径 r） */
export function drawIcon(ctx, key, x, y, r = 11, { selected = false } = {}) {
  const ic = ICONS[key] || ICONS.landmark;
  ctx.save();
  if (selected) { ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(117,210,195,.45)'; ctx.fill(); }
  ctx.beginPath(); ctx.arc(x, y + 1, r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = ic.color; ctx.fill();
  ctx.lineWidth = 1.6; ctx.strokeStyle = '#fff'; ctx.stroke();
  const s = (r * 1.25) / 24;
  ctx.translate(x - 12 * s, y - 12 * s); ctx.scale(s, s);
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#fff';
  ctx.stroke(path2d(key));
  ctx.restore();
}
/** パネル用の SVG アイコン */
export function iconSvg(key, size = 28) {
  const ic = ICONS[key] || ICONS.landmark;
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '-3 -3 30 30'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.innerHTML = `<circle cx="12" cy="12" r="14.5" fill="${ic.color}"/><path d="${ic.d}" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
  return s;
}
