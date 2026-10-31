// =============================================================
// 鉄道と駅：種類・描画
//   国鉄  : 濃いグレーの線に白い破線（地図でよくある国鉄のデザイン）
//   私鉄  : グレーの線に垂直の短い線（枕木）が生えたデザイン
//   都市鉄道: 好きな色の実線
// =============================================================
import { segLevel, centroid } from './roads.js';

export const RAIL_TYPES = {
  jr:      { label: '国鉄',     show: 160 },
  private: { label: '私鉄',     show: 90 },
  metro:   { label: '都市鉄道', show: 45 },
};
export const METRO_COLORS = ['#e8432f', '#f39a1e', '#f2c81d', '#3aa64a', '#1e9cd8', '#2a5cb8', '#8a4fb0', '#d4508f', '#8b6a4f', '#7a8089'];
export const STATION_FILL = '#bcdcf4';        // 国鉄・私鉄の駅は薄い青
export const STATION_EDGE = '#5b9bd0';
const FONT = '"Noto Sans JP", system-ui, sans-serif';

export const railVisible = (rail, mpp) => mpp < (RAIL_TYPES[rail.type]?.show ?? 60);
export const railColor = (rail) => (rail.type === 'metro' ? rail.color || METRO_COLORS[5] : rail.type === 'jr' ? '#5c636b' : '#7b828b');

/** 線路の描画用の太さ（px）。拡大するほど少し太く */
function widthPx(mpp) { return mpp > 30 ? 2.2 : mpp > 8 ? 3 : mpp > 2 ? 4.2 : 5.5; }

export function drawRails(ctx, v, items, getNode) {
  const mpp = v.mpp, W = widthPx(mpp);
  ctx.save();
  ctx.lineJoin = 'round';
  for (const lv of [-1, 0, 1]) {
    for (const it of items) {
      const r = it.rail, gn = it.getNode || getNode;
      // 同じ高さの区間をつなげて描く
      const runs = [];
      let cur = null;
      it.g.segs.forEach((pts, i) => {
        const l = segLevel(r, i, gn);
        if (cur && cur.lv === l) { for (let k = 1; k < pts.length; k++) cur.pts.push(pts[k]); }
        else { cur = { lv: l, pts: pts.slice() }; runs.push(cur); }
      });
      for (const run of runs) {
        if (run.lv !== lv) continue;
        ctx.globalAlpha = lv === -1 ? 0.55 : 1;
        if (lv === 1 && W > 3) { ctx.strokeStyle = 'rgba(25,35,45,.14)'; ctx.lineWidth = W + 5; ctx.lineCap = 'round'; linePath(ctx, v, run.pts); ctx.stroke(); }
        if (r.type === 'jr') {
          ctx.lineCap = 'butt';
          ctx.strokeStyle = '#5c636b'; ctx.lineWidth = W + 1; linePath(ctx, v, run.pts); ctx.stroke();
          if (W >= 3) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = W - 1.6; ctx.setLineDash([W * 2.6, W * 2.6]); linePath(ctx, v, run.pts); ctx.stroke(); ctx.setLineDash([]); }
        } else if (r.type === 'private') {
          ctx.lineCap = 'butt';
          ctx.strokeStyle = '#7b828b'; ctx.lineWidth = Math.max(1.4, W * 0.45); linePath(ctx, v, run.pts); ctx.stroke();
          if (mpp < 12) ties(ctx, v, run.pts, W * 1.1, Math.max(6, W * 2));
        } else {
          ctx.lineCap = 'round';
          if (lv === -1) ctx.setLineDash([W * 2, W * 1.2]);
          ctx.strokeStyle = railColor(r); ctx.lineWidth = W; linePath(ctx, v, run.pts); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** 私鉄の枕木（線に垂直な短い線） */
function ties(ctx, v, pts, len, gap) {
  const S = pts.map(([x, z]) => v.toScreen(x, z));
  ctx.lineWidth = 1.2; ctx.beginPath();
  let acc = gap / 2;
  for (let k = 0; k < S.length - 1; k++) {
    const [x0, y0] = S[k], [x1, y1] = S[k + 1];
    const L = Math.hypot(x1 - x0, y1 - y0); if (!L) continue;
    const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    let d = gap - acc;
    while (d <= L) {
      const px = x0 + ux * d, py = y0 + uy * d;
      if (px > -10 && py > -10 && px < v.w + 10 && py < v.h + 10) {
        ctx.moveTo(px - uy * len / 2, py + ux * len / 2); ctx.lineTo(px + uy * len / 2, py - ux * len / 2);
      }
      d += gap;
    }
    acc = (acc + L) % gap;
  }
  ctx.stroke();
}
export function linePath(ctx, v, pts) {
  ctx.beginPath();
  let lx = 0, ly = 0;
  pts.forEach(([x, z], k) => {
    const [sx, sy] = v.toScreen(x, z);
    if (k === 0) { ctx.moveTo(sx, sy); lx = sx; ly = sy; }
    else if (k === pts.length - 1 || Math.abs(sx - lx) + Math.abs(sy - ly) > 1.2) { ctx.lineTo(sx, sy); lx = sx; ly = sy; }
  });
}

// ---------- 駅 ----------
/** 駅の色（最初の路線で決まる。国鉄・私鉄は薄い青） */
export function stationColors(F, st) {
  const r = st.rails?.map((id) => F.get(id)).find(Boolean);
  if (r?.type === 'metro') return { fill: hexA(railColor(r), 0.45), edge: railColor(r) };
  return { fill: STATION_FILL, edge: STATION_EDGE };
}
export function drawStationShapes(ctx, v, stations, F, selectedId) {
  ctx.save();
  for (const st of stations) {
    if (!st.poly || st.poly.length < 3) continue;
    const c = stationColors(F, st);
    ctx.beginPath();
    st.poly.forEach(([x, z], i) => { const [sx, sy] = v.toScreen(x, z); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
    ctx.fillStyle = c.fill; ctx.fill();
    ctx.strokeStyle = c.edge; ctx.lineWidth = st.id === selectedId ? 2.5 : 1.2; ctx.stroke();
  }
  ctx.restore();
}

const logoCache = new Map();
function logoImg(src, onload) {
  if (!src) return null;
  let im = logoCache.get(src);
  if (!im) { im = new Image(); im.onload = onload; im.src = src; logoCache.set(src, im); }
  return im.complete && im.naturalWidth ? im : null;
}

/** 駅のマーク（路線ごとに並べる）と駅名。表示した矩形を返す（クリック判定用） */
export function drawStationMarks(ctx, v, stations, F, { onImage, selectedId, taken = [] } = {}) {
  const mpp = v.mpp;
  const hits = [];
  ctx.save();
  ctx.textBaseline = 'middle';
  for (const st of stations) {
    const [cx, cz] = st.poly?.length ? centroid(st.poly) : [st.x, st.z];
    const [x, y] = v.toScreen(cx, cz);
    if (x < -60 || y < -30 || x > v.w + 60 || y > v.h + 30) continue;
    const rails = (st.rails || []).map((id) => F.get(id)).filter(Boolean);
    const marks = rails.length ? rails : [{ type: 'jr' }];
    const S = mpp < 3 ? 20 : 16;
    const totalW = marks.length * (S + 3) - 3;
    let mx = x - totalW / 2;
    for (const r of marks) {
      const im = r.type !== 'metro' ? logoImg(r.logo, onImage) : null;
      if (im) {
        ctx.fillStyle = '#fff'; roundRect(ctx, mx - 1, y - S / 2 - 1, S + 2, S + 2, 4); ctx.fill();
        ctx.drawImage(im, mx, y - S / 2, S, S);
      } else if (r.type === 'metro') {
        ctx.fillStyle = railColor(r); ctx.beginPath(); ctx.arc(mx + S / 2, y, S / 2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        const sym = (r.symbol || r.name || 'M').slice(0, 2);
        ctx.fillStyle = '#fff'; ctx.font = `800 ${sym.length > 1 ? S * 0.45 : S * 0.6}px ${FONT}`; ctx.textAlign = 'center';
        ctx.fillText(sym, mx + S / 2, y + 0.5);
      } else {
        ctx.fillStyle = r.type === 'private' ? '#5a6370' : '#2f6fcf';
        roundRect(ctx, mx, y - S / 2, S, S, 4); ctx.fill();
        trainGlyph(ctx, mx + S / 2, y, S * 0.62);
      }
      mx += S + 3;
    }
    const box = [x - totalW / 2 - 2, y - S / 2 - 2, x + totalW / 2 + 2, y + S / 2 + 2];
    hits.push({ id: st.id, box });
    taken.push(box);
    if (st.id === selectedId) { ctx.strokeStyle = '#1f7c6f'; ctx.lineWidth = 2; roundRect(ctx, box[0] - 2, box[1] - 2, box[2] - box[0] + 4, box[3] - box[1] + 4, 6); ctx.stroke(); }
    // 駅名
    if (mpp < 14 && st.name) {
      const name = st.name;
      ctx.font = `700 12px ${FONT}`; ctx.textAlign = 'left';
      const tw = ctx.measureText(name).width;
      const lb = [box[2] + 3, y - 9, box[2] + 7 + tw, y + 9];
      if (!taken.some((t) => lb[0] < t[2] && lb[2] > t[0] && lb[1] < t[3] && lb[3] > t[1])) {
        taken.push(lb);
        ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.strokeText(name, box[2] + 5, y + 0.5);
        ctx.fillStyle = '#1d3d66'; ctx.fillText(name, box[2] + 5, y + 0.5);
      }
    }
  }
  ctx.restore();
  return hits;
}
/** 出口番号（かなり拡大したときだけ） */
export function drawExits(ctx, v, stations) {
  if (v.mpp > 1.6) return;
  ctx.save();
  ctx.font = `800 11px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const st of stations) for (const ex of st.exits || []) {
    const [x, y] = v.toScreen(ex.x, ex.z);
    if (x < -20 || y < -20 || x > v.w + 20 || y > v.h + 20) continue;
    const t = String(ex.label || '');
    const w = Math.max(16, ctx.measureText(t).width + 8);
    ctx.fillStyle = '#ffd43b'; roundRect(ctx, x - w / 2, y - 8, w, 16, 3); ctx.fill();
    ctx.strokeStyle = '#3a3a3a'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#222'; ctx.fillText(t, x, y + 0.5);
  }
  ctx.restore();
}
function trainGlyph(ctx, x, y, s) {
  ctx.save(); ctx.translate(x - s / 2, y - s / 2); ctx.scale(s / 24, s / 24);
  ctx.fillStyle = '#fff';
  roundRect(ctx, 5, 2, 14, 16, 4); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(7.5, 5, 9, 5);
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(8.5, 14, 1.4, 0, 7); ctx.arc(15.5, 14, 1.4, 0, 7); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(8, 18); ctx.lineTo(5, 22); ctx.moveTo(16, 18); ctx.lineTo(19, 22); ctx.stroke();
  ctx.restore();
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
