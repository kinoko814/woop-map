// =============================================================
// 縮小したときの「街区の色」
//   建物が見えなくなる縮尺（画面の幅 2.2km 超）では、建物がある一帯をまとめて
//   その種類の色（住宅・商業・産業・オフィス・公共）でうっすら塗る。森の色のような感じ。
//   画面の幅が 30km を超えたら何も塗らない。
//
//   作り方：地図を升目に分けて、建物がある升目に種類を記録 →
//           すき間を埋めて（膨らませてから縮める）「一帯」にする →
//           輪郭を作って、種類ごとに1色でくっきり塗る
//   結果は建物が変わるまで覚えておく
// =============================================================
import { inPoly } from './roads.js';

export const DISTRICT_SPAN = [2200, 30000];   // この画面の幅（m）のあいだだけ表示
const TYPES = ['house', 'commercial', 'industrial', 'office', 'public'];
const COLORS = {
  house:      [236, 223, 199],
  commercial: [247, 206, 202],
  industrial: [218, 210, 232],
  office:     [204, 218, 240],
  public:     [208, 233, 190],
};
const GAP = 64;   // このくらい（m）の建物どうしのすき間は同じ一帯とみなす

const CACHE = new WeakMap();

export function drawDistricts(ctx, v, F, span) {
  if (span <= DISTRICT_SPAN[0] || span > DISTRICT_SPAN[1]) return;
  const d = build(F);
  if (!d) return;
  const [sx, sy] = v.toScreen(d.x0, d.z0);
  const w = d.cols * d.C * v.scale, h = d.rows * d.C * v.scale;
  if (sx > v.w || sy > v.h || sx + w < 0 || sy + h < 0) return;
  // 種類ごとに1色でくっきり塗る（ぼかさない）
  ctx.save();
  ctx.translate(sx, sy); ctx.scale(v.scale, v.scale);
  ctx.lineJoin = 'round'; ctx.lineWidth = 1 / v.scale;   // 升目どうしのつなぎ目のすき間を隠す
  for (const { color, path } of d.paths) {
    ctx.fillStyle = color; ctx.strokeStyle = color;
    ctx.fill(path); ctx.stroke(path);
  }
  ctx.restore();
}

function build(F) {
  const ver = F.kindVer.building || 0;
  const c = CACHE.get(F);
  if (c && c.ver === ver) return c.d;
  const d = compute(F);
  CACHE.set(F, { ver, d });
  return d;
}

function compute(F) {
  const list = [...F.ofKind('building')].filter((b) => b.poly?.length >= 3);
  if (!list.length) return null;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of list) for (const [x, z] of b.poly) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  const pad = GAP * 2;
  x0 -= pad; z0 -= pad; x1 += pad; z1 += pad;
  // 升目の大きさ：細かすぎて重くならないよう、画像が最大 1600 マス四方に収まるように
  const C = Math.max(8, Math.ceil(Math.max(x1 - x0, z1 - z0) / 1600));
  const cols = Math.ceil((x1 - x0) / C), rows = Math.ceil((z1 - z0) / C);
  // 1. 升目ごとに、どの種類の建物がどれだけあるか
  const score = TYPES.map(() => new Float32Array(cols * rows));
  for (const b of list) {
    const ti = Math.max(0, TYPES.indexOf(b.type));
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const [x, z] of b.poly) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z; }
    const c0 = Math.max(0, Math.floor((bx0 - x0) / C)), c1 = Math.min(cols - 1, Math.floor((bx1 - x0) / C));
    const r0 = Math.max(0, Math.floor((bz0 - z0) / C)), r1 = Math.min(rows - 1, Math.floor((bz1 - z0) / C));
    let hit = false;
    for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
      if (inPoly(b.poly, x0 + (cc + 0.5) * C, z0 + (r + 0.5) * C)) { score[ti][r * cols + cc] += 1; hit = true; }
    }
    // 升目より小さい建物は、まん中の升目に入れる
    if (!hit) {
      const cc = Math.min(cols - 1, Math.max(0, Math.floor(((bx0 + bx1) / 2 - x0) / C)));
      const r = Math.min(rows - 1, Math.max(0, Math.floor(((bz0 + bz1) / 2 - z0) / C)));
      score[ti][r * cols + cc] += 0.5;
    }
  }
  // 2. 升目の種類（一番多いもの）
  const N = cols * rows;
  const type = new Int8Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    let best = -1, bs = 0;
    for (let t = 0; t < TYPES.length; t++) if (score[t][i] > bs) { bs = score[t][i]; best = t; }
    type[i] = best;
  }
  // 3. すき間を埋める：建物のある所を膨らませてから縮める（クロージング）
  const R = Math.max(1, Math.round(GAP / 2 / C));
  const has = new Uint8Array(N);
  for (let i = 0; i < N; i++) has[i] = type[i] >= 0 ? 1 : 0;
  const closed = erode(dilate(has, cols, rows, R), cols, rows, R);
  // 4. 埋めた所には、一番近い建物の種類を入れる（幅優先で広げる）
  const fillType = Int8Array.from(type);
  let frontier = [];
  for (let i = 0; i < N; i++) if (type[i] >= 0) frontier.push(i);
  while (frontier.length) {
    const next = [];
    for (const i of frontier) {
      const r = (i / cols) | 0, cc = i - r * cols;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, c2 = cc + dc;
        if (rr < 0 || rr >= rows || c2 < 0 || c2 >= cols) continue;
        const j = rr * cols + c2;
        if (!closed[j] || fillType[j] >= 0) continue;
        fillType[j] = fillType[i]; next.push(j);
      }
    }
    frontier = next;
  }
  // 5. 種類ごとに輪郭を作る（マーチングスクエア法：角を斜めに切ったなめらかな形）
  const paths = [];
  for (let t = 0; t < TYPES.length; t++) {
    const on = (c2, r) => c2 >= 0 && r >= 0 && c2 < cols && r < rows && closed[r * cols + c2] && fillType[r * cols + c2] === t;
    const path = new Path2D();
    let any = false;
    // 升目の中心どうしを結んだ格子で、4すみの状態から形を決める
    for (let r = -1; r < rows; r++) {
      let run = -1;   // 4すみ全部が中の升目は、横に続く分をまとめて長方形にする
      for (let c2 = -1; c2 <= cols; c2++) {
        const a = on(c2, r), b = on(c2 + 1, r), cc = on(c2 + 1, r + 1), d = on(c2, r + 1);
        const full = a && b && cc && d && c2 < cols;
        if (full) { if (run < 0) run = c2; continue; }
        if (run >= 0) { path.rect((run + 0.5) * C, (r + 0.5) * C, (c2 - run) * C, C); run = -1; any = true; }
        if (c2 >= cols) continue;
        const idx = (a ? 8 : 0) | (b ? 4 : 0) | (cc ? 2 : 0) | (d ? 1 : 0);
        if (!idx) continue;
        const poly = MS[idx];
        const ox = (c2 + 0.5) * C, oz = (r + 0.5) * C;
        poly.forEach(([px, pz], k) => (k ? path.lineTo(ox + px * C, oz + pz * C) : path.moveTo(ox + px * C, oz + pz * C)));
        path.closePath(); any = true;
      }
    }
    if (any) { const [R2, G, B] = COLORS[TYPES[t]]; paths.push({ color: `rgb(${R2},${G},${B})`, path }); }
  }
  return { paths, x0, z0, C, cols, rows };
}

// マーチングスクエア法の形（4すみ a=左上 b=右上 c=右下 d=左下、辺の中点 T R B L）
const a_ = [0, 0], b_ = [1, 0], c_ = [1, 1], d_ = [0, 1], T_ = [0.5, 0], R_ = [1, 0.5], B_ = [0.5, 1], L_ = [0, 0.5];
const MS = {
  1: [L_, B_, d_], 2: [B_, R_, c_], 3: [L_, R_, c_, d_], 4: [T_, b_, R_], 5: [L_, T_, b_, R_, B_, d_], 6: [T_, b_, c_, B_], 7: [L_, T_, b_, c_, d_],
  8: [a_, T_, L_], 9: [a_, T_, B_, d_], 10: [a_, T_, R_, c_, B_, L_], 11: [a_, T_, R_, c_, d_], 12: [a_, b_, R_, L_], 13: [a_, b_, R_, B_, d_], 14: [a_, b_, c_, B_, L_], 15: [a_, b_, c_, d_],
};

/** 正方形の範囲での最大値（膨張）。行→列の順に分けて速く */
function dilate(a, cols, rows, R) { return boxOp(a, cols, rows, R, 1); }
function erode(a, cols, rows, R) { return boxOp(a, cols, rows, R, 0); }
function boxOp(a, cols, rows, R, isMax) {
  const tmp = new Uint8Array(a.length), out = new Uint8Array(a.length);
  const pass = (src, dst, len, count, idx) => {
    for (let k = 0; k < count; k++) {
      // 窓の中の 1 の個数を数えながらずらす
      let sum = 0;
      for (let i = 0; i < Math.min(R, len); i++) sum += src[idx(k, i)];
      for (let i = 0; i < len; i++) {
        if (i + R < len) sum += src[idx(k, i + R)];
        if (i - R - 1 >= 0) sum -= src[idx(k, i - R - 1)];
        const win = Math.min(len - 1, i + R) - Math.max(0, i - R) + 1;
        dst[idx(k, i)] = isMax ? (sum > 0 ? 1 : 0) : (sum === win ? 1 : 0);
      }
    }
  };
  pass(a, tmp, cols, rows, (r, c) => r * cols + c);
  pass(tmp, out, rows, cols, (c, r) => r * cols + c);
  return out;
}
