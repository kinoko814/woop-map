// =============================================================
// 範囲（IC/JCT・公園・森・山・空港）・建物・施設の種類と描画
//   area     : {id, kind:'area', type, name, desc, poly}
//   building : {id, kind:'building', type, name?, poly}
//   poi      : {id, kind:'poi', icon, name, desc, info, address, phone, photo, x, z}
// =============================================================
import { centroid } from './roads.js';
import { drawIcon, poiVisible, poiLabelVisible, ICONS } from './icons.js';

export const AREA_TYPES = {
  ic:       { label: 'IC（インターチェンジ）', short: 'IC', outlineOnly: true },
  jct:      { label: 'JCT（ジャンクション）', short: 'JCT', outlineOnly: true },
  park:     { label: '公園', short: '公園', fill: '#cdeabf', edge: '#a8d395', text: '#2f6e35', show: 40000 },
  forest:   { label: '森',   short: '森',   fill: '#bfe0aa', edge: '#a3cf8c', text: '#2f6e35', show: 120000 },
  mountain: { label: '山',   short: '山',   fill: '#dfe6c6', edge: '#c3cfa2', text: '#6b5a3a', show: 120000 },
  airport:  { label: '空港', short: '空港', fill: '#e9e6f3', edge: '#c9c2de', text: '#4b4378', show: 200000 },
};
export const BUILDING_TYPES = {
  house:      { label: '住宅',     fill: '#efe9df', edge: '#d3c9b9' },
  commercial: { label: '商業建物', fill: '#f5e0d6', edge: '#dfbdab' },
  industrial: { label: '産業建物', fill: '#e5e1eb', edge: '#c6bfd2' },
  office:     { label: 'オフィス', fill: '#dfe5ef', edge: '#bcc6d8' },
  public:     { label: '公共施設', fill: '#e1edd8', edge: '#bdd3ac' },
};
const FONT = '"Noto Sans JP", system-ui, sans-serif';
/** 画面に見えている範囲の幅 (m) */
export const viewSpan = (v) => Math.max(v.w, v.h) * v.mpp;

function polyPath(ctx, v, poly) {
  ctx.beginPath();
  poly.forEach(([x, z], i) => { const [sx, sy] = v.toScreen(x, z); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
  ctx.closePath();
}
const bboxOf = (poly) => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of poly) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return [x0, z0, x1, z1];
};
const onScreen = (v, poly, m = 0) => {
  const b = bboxOf(poly), vb = v.bounds();
  return !(b[0] > vb.x1 + m || b[2] < vb.x0 - m || b[1] > vb.z1 + m || b[3] < vb.z0 - m);
};

/** 公園・森・山・空港の塗り（道路より下） */
export function drawAreaFills(ctx, v, areas, selectedId) {
  const span = viewSpan(v);
  ctx.save();
  for (const a of areas) {
    const t = AREA_TYPES[a.type];
    if (!t || t.outlineOnly || a.poly.length < 3 || span > t.show || !onScreen(v, a.poly)) continue;
    polyPath(ctx, v, a.poly);
    ctx.fillStyle = t.fill; ctx.fill();
    ctx.strokeStyle = a.id === selectedId ? '#1f7c6f' : t.edge; ctx.lineWidth = a.id === selectedId ? 2.5 : 1; ctx.stroke();
  }
  ctx.restore();
}
/** 建物（画面の幅が 2.2km より広いときは描かない） */
export function drawBuildings(ctx, v, buildings, selectedId) {
  if (viewSpan(v) > 2200) return;
  ctx.save();
  for (const b of buildings) {
    if (b.poly.length < 3 || !onScreen(v, b.poly)) continue;
    const t = BUILDING_TYPES[b.type] || BUILDING_TYPES.house;
    polyPath(ctx, v, b.poly);
    ctx.fillStyle = t.fill; ctx.fill();
    ctx.strokeStyle = b.id === selectedId ? '#1f7c6f' : t.edge; ctx.lineWidth = b.id === selectedId ? 2.5 : 1; ctx.stroke();
  }
  // 建物の名前（かなり拡大したとき）
  if (v.mpp < 0.8) {
    ctx.font = `500 11px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#6b6457';
    for (const b of buildings) if (b.name && b.poly.length >= 3) { const [x, y] = v.toScreen(...centroid(b.poly)); ctx.fillText(b.name, x, y); }
  }
  ctx.restore();
}
/** 公園・山・空港などの名前 */
export function drawAreaLabels(ctx, v, areas, taken) {
  const span = viewSpan(v);
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const a of areas) {
    const t = AREA_TYPES[a.type];
    if (!t || t.outlineOnly || !a.name || a.poly.length < 3 || span > t.show * 0.35) continue;
    const [x, y] = v.toScreen(...centroid(a.poly));
    if (x < -80 || y < -20 || x > v.w + 80 || y > v.h + 20) continue;
    ctx.font = `${a.type === 'airport' ? 700 : 600} ${a.type === 'airport' ? 13 : 12}px ${FONT}`;
    const tw = ctx.measureText(a.name).width;
    const box = [x - tw / 2 - 4, y - 9, x + tw / 2 + 4, y + 9];
    if (taken.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
    taken.push(box);
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.strokeText(a.name, x, y);
    ctx.fillStyle = t.text; ctx.fillText(a.name, x, y);
  }
  ctx.restore();
}
/** 施設のアイコンと名前。クリック判定用の位置を返す */
export function drawPois(ctx, v, pois, selectedId, taken, opts = {}) {
  const span = viewSpan(v);
  const hits = [];
  const r = v.mpp < 1 ? 12 : 10.5;
  // 密集している所では、重なるアイコンを隠す（拡大すると出てくる）
  //   優先：選択中 → 大事な施設（役所・病院・名所など）→ その他 → 住宅
  const force = opts.only ? new Set(opts.only) : null;
  const tierOf = (p) => (p.id === selectedId ? 0 : force?.has(p.id) ? 0.5 : ICONS[p.icon]?.tier || 2);
  const vis = pois.filter((p) => (force ? force.has(p.id) : poiVisible(p, span)) || p.id === selectedId)
    .map((p) => { const [x, y] = v.toScreen(p.x, p.z); return { p, x, y }; })
    .filter(({ x, y }) => x > -20 && y > -20 && x < v.w + 20 && y < v.h + 20)
    .sort((a, b) => tierOf(a.p) - tierOf(b.p) || (a.p.id < b.p.id ? -1 : 1));
  const placed = [];
  const pad = 2;
  for (const it of vis) {
    const box = [it.x - r - pad, it.y - r - pad, it.x + r + pad, it.y + r + pad];
    if (it.p.id !== selectedId && taken.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
    taken.push(box);
    placed.push(it);
    drawIcon(ctx, it.p.icon, it.x, it.y, r, { selected: it.p.id === selectedId });
    hits.push({ id: it.p.id, x: it.x, y: it.y, r: r + 3 });
  }
  ctx.save();
  ctx.font = `600 12px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (const { p, x, y } of placed) {
    if (!p.name || !(force || poiLabelVisible(p, span))) continue;
    const tw = ctx.measureText(p.name).width;
    const box = [x + r + 2, y - 9, x + r + 8 + tw, y + 9];
    if (taken.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
    taken.push(box);
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.strokeText(p.name, x + r + 5, y);
    ctx.fillStyle = '#2b3138'; ctx.fillText(p.name, x + r + 5, y);
  }
  ctx.restore();
  return hits;
}
