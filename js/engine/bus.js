// =============================================================
// バス停とバス路線
//   busstop : {id, kind:'busstop', x, z, name, desc, road}   道路沿いに置く
//   busroute: {id, kind:'busroute', name, color, desc, stops:[busstopId...], oneway?}
//   路線の道筋は、停留所から次の停留所まで道路に沿って自動で引く（route.js の busPath）
//   表示モードでは、路線はふだん出さず、バス停を選んでいるときだけその停留所を通る路線を出す
// =============================================================
import { tessellate } from './roads.js';
import { busPath } from './route.js';

export const BUS_COLORS = ['#e5484d', '#2f6fcf', '#1f9d55', '#e8890c', '#8e4ec6', '#0f9fb5', '#d6409f', '#7a5c3e'];
export const BUS_STOP_COLOR = '#1d6fd6';
const FONT = '"Noto Sans JP", system-ui, sans-serif';

/** バス停を置く位置：一番近い道路の、クリックした側の路肩 */
export function snapToRoad(F, x, z, maxD = 60) {
  let best = null;
  for (const r of F.ofKind('road')) {
    const g = tessellate(r, (id) => F.get(id));
    if (g.bbox[0] > x + maxD || g.bbox[2] < x - maxD || g.bbox[1] > z + maxD || g.bbox[3] < z - maxD) continue;
    g.segs.forEach((pts, si) => {
      for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
        if (!L) continue;
        let t = ((x - ax) * dx + (z - az) * dz) / (L * L); t = Math.max(0, Math.min(1, t));
        const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z);
        if (!best || d < best.d) best = { d, r, px, pz, nx: -dz / L, nz: dx / L, w: r.segs?.[si]?.w || 8 };
      }
    });
  }
  if (!best || best.d > maxD + best.w / 2) return null;
  const side = (x - best.px) * best.nx + (z - best.pz) * best.nz >= 0 ? 1 : -1;
  const off = best.w / 2 + 2.5;
  return { x: Math.round((best.px + best.nx * off * side) * 10) / 10, z: Math.round((best.pz + best.nz * off * side) * 10) / 10, road: best.r.id };
}

/** そのバス停を通る路線 */
export const routesAt = (F, stopId) => [...F.ofKind('busroute')].filter((r) => (r.stops || []).includes(stopId));

/** 路線を道路に沿って描く。routes: 描く路線、opts.dim: 薄く描く */
export function drawBusRoutes(ctx, v, F, routes, opts = {}) {
  if (!routes.length) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const w = Math.max(3, Math.min(7, 5 / Math.sqrt(Math.max(v.mpp, 0.3))));
  routes.forEach((r, ri) => {
    const hops = busPath(F, r);
    // 同じ道を通る路線が重ならないよう少しずらす
    const shift = (ri - (routes.length - 1) / 2) * (w + 1);
    ctx.globalAlpha = opts.dim ? 0.45 : 1;
    for (const hp of hops) {
      const s = offsetLine(hp.pts.map(([x, z]) => v.toScreen(x, z)), shift);
      ctx.beginPath(); s.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.setLineDash(hp.ok ? [] : [6, 6]);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = w + 3; ctx.stroke();
      ctx.strokeStyle = r.color || BUS_COLORS[0]; ctx.lineWidth = w; ctx.stroke();
    }
  });
  ctx.restore();
}
function offsetLine(s, d) {
  if (!d || s.length < 2) return s;
  return s.map((p, i) => {
    const a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / L) * d, p[1] + (dx / L) * d];
  });
}

/** バスのマーク */
export function drawBusMark(ctx, x, y, r, { selected = false, color = BUS_STOP_COLOR } = {}) {
  ctx.save();
  if (selected) { ctx.beginPath(); ctx.arc(x, y, r + 5, 0, 7); ctx.fillStyle = 'rgba(29,111,214,.22)'; ctx.fill(); }
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7);
  ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
  // バスの絵
  const s = r / 10;
  ctx.fillStyle = '#fff';
  rr(ctx, x - 5.2 * s, y - 5.5 * s, 10.4 * s, 9.6 * s, 2 * s); ctx.fill();
  ctx.fillStyle = color;
  rr(ctx, x - 3.8 * s, y - 4 * s, 7.6 * s, 3.6 * s, 0.8 * s); ctx.fill();
  ctx.beginPath(); ctx.arc(x - 2.9 * s, y + 1.8 * s, 1 * s, 0, 7); ctx.arc(x + 2.9 * s, y + 1.8 * s, 1 * s, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - 4.2 * s, y + 4 * s, 2 * s, 1.8 * s); ctx.fillRect(x + 2.2 * s, y + 4 * s, 2 * s, 1.8 * s);
  ctx.restore();
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

/** バス停を描く（重なるものは隠す）。返り値はクリック判定用 */
export function drawBusStops(ctx, v, stops, selectedId, taken, opts = {}) {
  const hits = [];
  const r = v.mpp < 1 ? 10 : 8.5;
  const vis = stops.map((p) => { const [x, y] = v.toScreen(p.x, p.z); return { p, x, y }; })
    .filter(({ x, y }) => x > -20 && y > -20 && x < v.w + 20 && y < v.h + 20)
    .sort((a, b) => (a.p.id === selectedId ? -1 : b.p.id === selectedId ? 1 : (opts.hl?.has(b.p.id) ? 1 : 0) - (opts.hl?.has(a.p.id) ? 1 : 0)));
  const placed = [];
  for (const it of vis) {
    const box = [it.x - r - 2, it.y - r - 2, it.x + r + 2, it.y + r + 2];
    if (it.p.id !== selectedId && taken.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
    taken.push(box); placed.push(it);
    drawBusMark(ctx, it.x, it.y, r, { selected: it.p.id === selectedId || opts.hl?.has(it.p.id) });
    hits.push({ id: it.p.id, x: it.x, y: it.y, r: r + 3 });
  }
  ctx.save();
  ctx.font = `600 12px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (const { p, x, y } of placed) {
    if (!p.name || !(v.mpp < 1.6 || p.id === selectedId || opts.hl?.has(p.id))) continue;
    const t = p.name;
    const tw = ctx.measureText(t).width;
    const box = [x + r + 2, y - 9, x + r + 8 + tw, y + 9];
    if (p.id !== selectedId && taken.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
    taken.push(box);
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.strokeText(t, x + r + 5, y);
    ctx.fillStyle = '#1b4f99'; ctx.fillText(t, x + r + 5, y);
  }
  ctx.restore();
  return hits;
}
