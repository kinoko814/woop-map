// =============================================================
// 陸の上だけに描く（海・湖の上は消す）
//   別の紙（キャンバス）に描いてから、地形の「水」の所を消して重ねる。
//   水かどうかは、画面のうち描いた範囲だけを 3px おきに調べる。
//   使う所：表示モードで選んだ市などの範囲、砂浜
// =============================================================
const BUF = { off: null, mask: null };
const S = 3;

/**
 * @param bbox  描く物の画面上の範囲 [x0, y0, x1, y1]
 * @param paint (g) => void  g に描く関数（画面の座標で）
 */
export function drawOnLand(ctx, v, isWater, bbox, paint) {
  if (!isWater) { ctx.save(); paint(ctx); ctx.restore(); return; }
  const W = Math.ceil(v.w), H = Math.ceil(v.h);
  if (!BUF.off || BUF.off.width !== W || BUF.off.height !== H) { BUF.off = document.createElement('canvas'); BUF.off.width = W; BUF.off.height = H; }
  const g = BUF.off.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  const c0 = Math.max(0, Math.floor((bbox[0] - 4) / S)), r0 = Math.max(0, Math.floor((bbox[1] - 4) / S));
  const c1 = Math.min(Math.ceil(W / S), Math.ceil((bbox[2] + 4) / S)), r1 = Math.min(Math.ceil(H / S), Math.ceil((bbox[3] + 4) / S));
  const mw = c1 - c0, mh = r1 - r0;
  if (mw <= 0 || mh <= 0) return;
  g.clearRect(c0 * S, r0 * S, mw * S, mh * S);
  g.save(); paint(g); g.restore();
  // 水の型紙
  if (!BUF.mask || BUF.mask.width < mw || BUF.mask.height < mh) {
    const m = document.createElement('canvas');
    m.width = Math.max(mw, BUF.mask?.width || 0); m.height = Math.max(mh, BUF.mask?.height || 0);
    BUF.mask = m;
  }
  const mg = BUF.mask.getContext('2d');
  const img = mg.createImageData(mw, mh);
  let wet = false;
  for (let r = 0; r < mh; r++) for (let c = 0; c < mw; c++) {
    const [wx, wz] = v.toWorld((c0 + c + 0.5) * S, (r0 + r + 0.5) * S);
    if (isWater(wx, wz)) { img.data[(r * mw + c) * 4 + 3] = 255; wet = true; }
  }
  if (wet) {
    mg.clearRect(0, 0, BUF.mask.width, BUF.mask.height);
    mg.putImageData(img, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    g.imageSmoothingEnabled = true;
    g.drawImage(BUF.mask, 0, 0, mw, mh, c0 * S, r0 * S, mw * S, mh * S);
    g.globalCompositeOperation = 'source-over';
  }
  ctx.save();
  ctx.drawImage(BUF.off, c0 * S, r0 * S, mw * S, mh * S, c0 * S, r0 * S, mw * S, mh * S);
  ctx.restore();
}

/** 多角形（ワールド座標の配列）の画面上の範囲 */
export function screenBBox(v, polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys) for (const [x, z] of poly) { const [sx, sy] = v.toScreen(x, z); x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy); }
  return [x0, y0, x1, y1];
}
