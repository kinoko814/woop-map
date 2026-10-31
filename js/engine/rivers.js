// =============================================================
// 川：道路と同じく中間点でつくる線。描く順番は
//   地下の道路 → 川 → 地上の道路 → 高架
// なので、道路と交わると必ず道路が上になる（地下道路だけは川の下）。
//   river : {id, kind:'river', name, nodes, segs:[{w, c}]}
// =============================================================
export const RIVER_FILL = '#a9d3f2';   // 地形の「水」と同じ色
const RIVER_EDGE = '#8cc0e8';
const FONT = '"Noto Sans JP", system-ui, sans-serif';

export function riverVisible(r, mpp) {
  const w = Math.max(...r.segs.map((s) => s.w || 10), 10);
  return mpp < Math.max(25, w * 2.5);
}

export function drawRivers(ctx, v, items, isWater) {
  const sc = v.scale;
  const runs = [];
  for (const it of items) {
    let cur = null;
    it.g.segs.forEach((pts, i) => {
      const w = it.river.segs[i]?.w || 10;
      if (cur && cur.w === w) for (let k = 1; k < pts.length; k++) cur.pts.push(pts[k]);
      else { cur = { w, pts: pts.slice(), wpx: Math.max(1.5, w * sc) }; runs.push(cur); }
    });
  }
  if (!runs.length) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // 岸の線：海・湖（地形の「水」）の上には引かない → 川がそのまま海につながって見える
  for (const r of runs) {
    if (r.wpx < 3) continue;
    const lw = r.wpx + 1.6;
    ctx.strokeStyle = RIVER_EDGE; ctx.fillStyle = RIVER_EDGE; ctx.lineWidth = lw;
    if (!isWater) { path(ctx, v, r.pts); ctx.stroke(); continue; }
    for (const part of landParts(r.pts, r.w, isWater)) {
      ctx.lineCap = 'butt'; path(ctx, v, part.pts); ctx.stroke();
      // 陸の上で終わる端は丸く（水に入る端は切りっぱなし）
      for (const [end, open] of [[part.pts[0], part.startOpen], [part.pts[part.pts.length - 1], part.endOpen]]) {
        if (open) continue;
        const [x, y] = v.toScreen(end[0], end[1]);
        ctx.beginPath(); ctx.arc(x, y, lw / 2, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.lineCap = 'round';
  }
  for (const r of runs) { ctx.strokeStyle = r.wpx < 3 ? RIVER_EDGE : RIVER_FILL; ctx.lineWidth = r.wpx; path(ctx, v, r.pts); ctx.stroke(); }
  ctx.restore();
}

/** 川の中心線を細かく調べて、陸の上を通る部分だけを取り出す。水に入る端は open=true */
function landParts(pts, w, isWater) {
  const step = Math.max(1, Math.min(16, w * 0.5));
  const S = [];   // [x, z, water]
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let i = 0; i < n; i++) { const t = i / n; const x = ax + (bx - ax) * t, z = az + (bz - az) * t; S.push([x, z, isWater(x, z)]); }
  }
  const last = pts[pts.length - 1];
  S.push([last[0], last[1], isWater(last[0], last[1])]);
  const parts = [];
  let cur = null;
  for (let i = 0; i < S.length; i++) {
    const [x, z, wet] = S[i];
    if (!wet) {
      if (!cur) {
        cur = { pts: [], startOpen: false, endOpen: false };
        if (i > 0) { const p = S[i - 1]; cur.pts.push([(p[0] + x) / 2, (p[1] + z) / 2]); cur.startOpen = true; }
        parts.push(cur);
      }
      cur.pts.push([x, z]);
    } else if (cur) {
      const p = S[i - 1]; cur.pts.push([(p[0] + x) / 2, (p[1] + z) / 2]); cur.endOpen = true; cur = null;
    }
  }
  return parts.filter((p) => p.pts.length >= 2);
}

/** 川の名前（青い斜体、川の向きに沿って） */
export function drawRiverLabels(ctx, v, items, taken) {
  if (v.mpp > 20) return;
  ctx.save();
  ctx.font = `italic 600 12px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const it of items) {
    if (!it.river.name) continue;
    // 画面上でいちばん長い区間の真ん中
    let best = null;
    for (const pts of it.g.segs) {
      const S = pts.map(([x, z]) => v.toScreen(x, z));
      let L = 0; for (let k = 1; k < S.length; k++) L += Math.hypot(S[k][0] - S[k - 1][0], S[k][1] - S[k - 1][1]);
      if (!best || L > best.L) best = { S, L };
    }
    const tw = ctx.measureText(it.river.name).width;
    if (!best || best.L < tw + 30) continue;
    let d = best.L / 2, m = null;
    for (let k = 1; k < best.S.length; k++) {
      const [x0, y0] = best.S[k - 1], [x1, y1] = best.S[k];
      const s = Math.hypot(x1 - x0, y1 - y0);
      if (d <= s && s > 0) { m = { x: x0 + ((x1 - x0) * d) / s, y: y0 + ((y1 - y0) * d) / s, a: Math.atan2(y1 - y0, x1 - x0) }; break; }
      d -= s;
    }
    if (!m || m.x < 0 || m.y < 0 || m.x > v.w || m.y > v.h) continue;
    const box = [m.x - tw / 2 - 4, m.y - 9, m.x + tw / 2 + 4, m.y + 9];
    if (taken.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
    taken.push(box);
    let a = m.a; if (a > Math.PI / 2) a -= Math.PI; if (a < -Math.PI / 2) a += Math.PI;
    ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(a);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.strokeText(it.river.name, 0, 0);
    ctx.fillStyle = '#2f72b3'; ctx.fillText(it.river.name, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function path(ctx, v, pts) {
  ctx.beginPath();
  let lx = 0, ly = 0;
  pts.forEach(([x, z], k) => {
    const [sx, sy] = v.toScreen(x, z);
    if (k === 0) { ctx.moveTo(sx, sy); lx = sx; ly = sy; }
    else if (k === pts.length - 1 || Math.abs(sx - lx) + Math.abs(sy - ly) > 1.2) { ctx.lineTo(sx, sy); lx = sx; ly = sy; }
  });
}
