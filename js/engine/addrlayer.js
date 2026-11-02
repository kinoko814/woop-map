// =============================================================
// 住所の描画：境界線・地名・（編集中の）塗り分け
// =============================================================
import { ADDR_LEVELS, levelIndex } from './address.js';
import { viewSpan } from './shapes.js';
import { inPoly } from './roads.js';

const FONT = '"Noto Sans JP", system-ui, sans-serif';
export const nameColor = (name, a = 0.22) => {
  let n = 0; for (const c of name || '') n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return `hsla(${n % 360}, 65%, 55%, ${a})`;
};

/** 編集中の階層：地名ごとに色分けして塗る */
export function drawAddrTints(ctx, v, A, li, activeId) {
  ctx.save();
  for (const e of A.namedFaces(li)) {
    ctx.beginPath();
    e.face.poly.forEach(([x, z], i) => { const [sx, sy] = v.toScreen(x, z); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
    ctx.fillStyle = nameColor(e.region.name, e.region.id === activeId ? 0.42 : 0.2); ctx.fill();
  }
  ctx.restore();
}

/** 境界線（階層ごとに線の太さ・破線を変える。縮小すると細かい階層から消える） */
export function drawBorders(ctx, v, items, editLi = null, gray = false, isWater = null) {
  const span = viewSpan(v);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // 細かい階層から先に描き、上の階層を上に重ねる
  const sorted = items.slice().sort((a, b) => levelIndex(b.border.level) - levelIndex(a.border.level));
  for (const it of sorted) {
    const li = levelIndex(it.border.level), L = ADDR_LEVELS[li];
    if (!L) continue;
    const editing = editLi !== null;
    if (!editing && span > L.showLine) continue;
    const strong = editing && li <= editLi;
    ctx.strokeStyle = gray ? (li <= 1 ? '#7d858e' : '#9aa1a9') : L.line;
    ctx.globalAlpha = editing && li > editLi ? 0.35 : 0.9;
    ctx.lineWidth = L.width + (strong && li === editLi ? 1.4 : 0);
    ctx.setLineDash(L.dash);
    for (const pts of it.g.segs) {
      ctx.beginPath();
      if (isWater) landPath(ctx, v, pts, isWater);   // 表示モード：海・湖の上には引かない
      else pts.forEach(([x, z], k) => { const [sx, sy] = v.toScreen(x, z); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** 線のうち、陸の上の部分だけを道筋にする（画面に見えている所だけ細かく調べる） */
function landPath(ctx, v, pts, isWater) {
  const b = v.bounds(), m = 20 * v.mpp;
  const X0 = b.x0 - m, X1 = b.x1 + m, Z0 = b.z0 - m, Z1 = b.z1 + m;
  const step = Math.max(1, v.mpp * 2);
  for (let k = 0; k < pts.length - 1; k++) {
    const c = clip(pts[k], pts[k + 1], X0, Z0, X1, Z1);
    if (!c) continue;
    const [[ax, az], [bx, bz]] = c;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    let drawing = false;
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const dry = !isWater(x, z);
      if (dry) {
        const [sx, sy] = v.toScreen(x, z);
        if (drawing) ctx.lineTo(sx, sy); else { ctx.moveTo(sx, sy); drawing = true; }
      } else drawing = false;
    }
  }
}
/** 線分を長方形の中に切り取る（Liang–Barsky） */
function clip(p, q, x0, z0, x1, z1) {
  let t0 = 0, t1 = 1;
  const dx = q[0] - p[0], dz = q[1] - p[1];
  for (const [pp, qq] of [[-dx, p[0] - x0], [dx, x1 - p[0]], [-dz, p[1] - z0], [dz, z1 - p[1]]]) {
    if (pp === 0) { if (qq < 0) return null; continue; }
    const r = qq / pp;
    if (pp < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [[p[0] + dx * t0, p[1] + dz * t0], [p[0] + dx * t1, p[1] + dz * t1]];
}

/** 地名（県・市町村・区・住所名・番地）。クリック判定用の箱を返す */
export function drawAddrLabels(ctx, v, A, taken, gray = false) {
  const span = viewSpan(v), hits = [];
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ADDR_LEVELS.forEach((L, li) => {
    if (span < L.labelSpan[0] || span > L.labelSpan[1]) return;
    ctx.font = `${li <= 1 ? 700 : 600} ${L.font}px ${FONT}`;
    // 同じ地名は画面上で1回だけ（いちばん大きな面に）
    const shown = new Map();
    for (const e of A.namedFaces(li)) {
      const prev = shown.get(e.region.id);
      if (!prev || e.face.area > prev.face.area) shown.set(e.region.id, e);
    }
    for (const e of shown.values()) {
      const [x, y] = v.toScreen(...e.labelAt);
      if (x < -100 || y < -30 || x > v.w + 100 || y > v.h + 30) continue;   // 書いてある場所が画面の外なら出さない
      const t = e.region.name; if (!t) continue;
      const tw = ctx.measureText(t).width;
      const box = [x - tw / 2 - 4, y - L.font / 2 - 3, x + tw / 2 + 4, y + L.font / 2 + 3];
      if (taken.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
      taken.push(box);
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.strokeText(t, x, y);
      ctx.fillStyle = gray ? (li <= 1 ? '#3f464e' : li === 2 ? '#525a63' : '#67707a') : li <= 1 ? '#5b3d86' : li === 2 ? '#6f569a' : '#7c6c93'; ctx.fillText(t, x, y);
      hits.push({ id: e.region.id, level: li, box });
    }
  });
  ctx.restore();
  return hits;
}

/** 表示モードで地名をクリックしたとき：その地域を赤い半透明で */
export function drawAddrHighlight(ctx, v, A, region) {
  const li = levelIndex(region.level);
  ctx.save();
  for (const e of A.namedFaces(li)) {
    if (e.region.id !== region.id) continue;
    ctx.beginPath();
    e.face.poly.forEach(([x, z], i) => { const [sx, sy] = v.toScreen(x, z); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
    ctx.fillStyle = 'rgba(229, 57, 53, 0.16)'; ctx.fill();
    ctx.strokeStyle = 'rgba(214, 40, 40, 0.85)'; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.stroke();
  }
  ctx.restore();
}
