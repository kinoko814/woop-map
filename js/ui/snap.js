// =============================================================
// スナップの設定（道路・鉄道・川・駅・建物ツールで共通）
//   オン/オフはブラウザに保存。Alt キーを押している間は一時的に逆になる
// =============================================================
export const SNAP = { on: true, alt: false };
try { SNAP.on = localStorage.getItem('woop-snap') !== '0'; } catch (e) { /* 保存できない環境 */ }
export function setSnap(on) { SNAP.on = on; try { localStorage.setItem('woop-snap', on ? '1' : '0'); } catch (e) { /* 無視 */ } }
export const snapActive = () => SNAP.on !== SNAP.alt;
window.addEventListener('keydown', (e) => { if (e.key === 'Alt') SNAP.alt = true; });
window.addEventListener('keyup', (e) => { if (e.key === 'Alt') SNAP.alt = false; });
window.addEventListener('blur', () => { SNAP.alt = false; });
/** 1マス（1m）に吸着 */
export const gridPt = (w) => [Math.round(w[0]), Math.round(w[1])];

/**
 * 角度のスナップ：点 O から w への向きを、候補の向き dirs（[{d:[dx,dz], label}]）にそろえる
 * @returns {w, guide} そろわなければ null
 */
export function angleSnap(O, w, dirs, scale, tolPx = 10) {
  const vx = w[0] - O[0], vz = w[1] - O[1];
  let best = null;
  for (const { d, label } of dirs) {
    const t = vx * d[0] + vz * d[1];
    const off = Math.abs(vx * d[1] - vz * d[0]) * scale;
    if (Math.abs(t) * scale < 12) continue;
    if (off < tolPx && (!best || off < best.off - 0.5)) best = { d, t, off, label };
  }
  if (!best) return null;
  const t = Math.round(best.t);
  return { w: [O[0] + best.d[0] * t, O[1] + best.d[1] * t], guide: { o: O, d: best.d, label: best.label } };
}
/** 向き d と、それに直角な向きを候補にする */
export function withPerp(d, label) {
  if (!d) return [];
  return [{ d, label }, { d: [-d[1], d[0]], label: label === '縦横' ? '縦横' : '90°' }];
}
/** 補助線とラベルを描く */
export function drawGuide(ctx, v, guide, at) {
  if (!guide) return;
  const [ox, oy] = v.toScreen(...guide.o);
  const L = Math.hypot(v.w, v.h);
  ctx.save();
  ctx.strokeStyle = 'rgba(31,124,111,.75)'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 5]);
  ctx.beginPath(); ctx.moveTo(ox - guide.d[0] * L, oy - guide.d[1] * L); ctx.lineTo(ox + guide.d[0] * L, oy + guide.d[1] * L); ctx.stroke();
  ctx.setLineDash([]);
  if (at) {
    const [cx, cy] = v.toScreen(...at);
    ctx.font = '700 11px system-ui'; const tw = ctx.measureText(guide.label).width;
    ctx.fillStyle = '#1f7c6f';
    const x = cx + 10, y = cy - 26, w = tw + 10, h = 17, r = 4;
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(guide.label, cx + 15, cy - 17.5);
  }
  ctx.restore();
}
