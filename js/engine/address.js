// =============================================================
// 住所：5階層（県・市町村・区・住所名・番地）
//
//   border : {id, kind:'border', level, nodes, segs:[{}]}   境界線（中間点・直線）
//   addr   : {id, kind:'addr', level, name, seeds:[[x,z],...]}
//            地名。seeds は「塗りつぶし」でクリックした地点（飛び地は複数）
//
// 境界線で囲まれた領域（面）を計算し、seeds が入っている面にその地名を付ける。
// 上の階層の境界（県境など）は、下の階層の境界としても使う。
// マップの外周も境界として扱う。
// =============================================================
import { inPoly } from './roads.js';

export const ADDR_LEVELS = [
  { key: 'pref',  label: '県',     unit: '県',     line: '#8a5bc4', width: 2.4, dash: [10, 4, 2, 4], showLine: Infinity, labelSpan: [25000, Infinity], font: 15 },
  { key: 'city',  label: '市町村', unit: '市町村', line: '#9a6fb8', width: 1.8, dash: [8, 4],        showLine: 150000,  labelSpan: [0, 120000], font: 14 },
  { key: 'ward',  label: '区',     unit: '区',     line: '#a98cc4', width: 1.4, dash: [6, 4],        showLine: 40000,   labelSpan: [0, 30000], font: 13 },
  { key: 'town',  label: '住所名', unit: '町名',   line: '#b8a4cc', width: 1.1, dash: [4, 3],        showLine: 6000,    labelSpan: [0, 2200], font: 12 },
  { key: 'block', label: '番地',   unit: '番地',   line: '#c9bad6', width: 0.9, dash: [2, 3],        showLine: 1800,    labelSpan: [0, 900], font: 11 },
];
export const levelIndex = (key) => ADDR_LEVELS.findIndex((l) => l.key === key);

export class AddressIndex {
  /** F: Features、getBounds: () => マップの範囲 {x0,x1,z0,z1} */
  constructor(F, getBounds) {
    this.F = F; this.getBounds = getBounds;
    this.cache = new Map();     // level -> {key, faces}
    this.named = new Map();     // level -> {key, list:[{face, region}]}
  }
  _bkey() { const b = this.getBounds(); return `${this.F.kindVer.border || 0}|${b.x0},${b.x1},${b.z0},${b.z1}`; }

  /** その階層の面（囲まれた領域）一覧 */
  faces(li) {
    const key = this._bkey();
    const c = this.cache.get(li);
    if (c && c.key === key) return c.faces;
    const faces = buildFaces(this._segments(li), this.getBounds());
    this.cache.set(li, { key, faces });
    return faces;
  }
  _segments(li) {
    const segs = [];
    for (const b of this.F.ofKind('border')) {
      const bl = levelIndex(b.level);
      if (bl < 0 || bl > li) continue;
      for (let i = 0; i < b.nodes.length - 1; i++) {
        const p = this.F.get(b.nodes[i]), q = this.F.get(b.nodes[i + 1]);
        if (p && q) segs.push([p.x, p.z, q.x, q.z]);
      }
    }
    return segs;
  }
  /** 点を含む面（いちばん小さいもの） */
  locate(li, x, z) {
    let best = null;
    for (const f of this.faces(li)) {
      if (x < f.bbox[0] || x > f.bbox[2] || z < f.bbox[1] || z > f.bbox[3]) continue;
      if (inPoly(f.poly, x, z) && (!best || f.area < best.area)) best = f;
    }
    return best;
  }
  /** 地名の付いた面の一覧（ラベル表示・塗り分け用） */
  namedFaces(li) {
    const key = `${this._bkey()}|${this.F.kindVer.addr || 0}`;
    const c = this.named.get(li);
    if (c && c.key === key) return c.list;
    const lv = ADDR_LEVELS[li].key;
    const byFace = new Map();
    for (const r of this.F.ofKind('addr')) {
      if (r.level !== lv) continue;
      for (const s of r.seeds || []) {
        const f = this.locate(li, s[0], s[1]);
        if (f) byFace.set(f.id, { face: f, region: r, seed: s });
      }
    }
    const list = [...byFace.values()].map((e) => ({ ...e, labelAt: labelPoint(e.face, e.seed) }));
    this.named.set(li, { key, list });
    return list;
  }
  /** 地点の地名（その階層） */
  nameAt(li, x, z) {
    const f = this.locate(li, x, z);
    if (!f) return null;
    const hit = this.namedFaces(li).find((e) => e.face.id === f.id);
    return hit ? { name: hit.region.name, region: hit.region, face: f } : null;
  }
  /** 地点の住所：[{level, label, name}]（名前のない階層は飛ばす） */
  addressAt(x, z) {
    const out = [];
    ADDR_LEVELS.forEach((L, li) => { const n = this.nameAt(li, x, z); if (n) out.push({ level: L.key, label: L.label, name: n.name, region: n.region }); });
    return out;
  }
  addressText(x, z) { return this.addressAt(x, z).map((a) => a.name).join(' '); }
}

// ---------- 面の計算 ----------
/**
 * 線分の集まり（＋マップの外周）から、平面を区切る面を作る。
 *   1. 交差している所で線分を分割
 *   2. 端点をまとめて頂点にする
 *   3. 各頂点で角度順に並べ、左回りにたどって面を作る
 */
export function buildFaces(segsIn, b) {
  const segs = [...segsIn,
    [b.x0, b.z0, b.x1, b.z0], [b.x1, b.z0, b.x1, b.z1], [b.x1, b.z1, b.x0, b.z1], [b.x0, b.z1, b.x0, b.z0]];
  // 1. 交差で分割（格子で近いものだけ調べる）
  const G = 1024, grid = new Map();
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s[0], s[2]) / G), x1 = Math.floor(Math.max(s[0], s[2]) / G);
    const z0 = Math.floor(Math.min(s[1], s[3]) / G), z1 = Math.floor(Math.max(s[1], s[3]) / G);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
      const k = `${gx},${gz}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    }
  });
  // 分割点：同じ交点は両方の線分で同じ座標を使う（丸め誤差で頂点が2つに分かれないように）
  const cuts = segs.map((s) => [{ t: 0, x: s[0], z: s[1] }, { t: 1, x: s[2], z: s[3] }]);
  const seen = new Set();
  for (const ids of grid.values()) {
    for (let a = 0; a < ids.length; a++) for (let c = a + 1; c < ids.length; c++) {
      const i = ids[a], j = ids[c];
      const pk = i < j ? `${i}|${j}` : `${j}|${i}`;
      if (seen.has(pk)) continue; seen.add(pk);
      const hit = intersect(segs[i], segs[j]);
      if (hit) {
        const [a, b] = hit, si = segs[i], sj = segs[j], e = 1e-6;
        const pt = a < e ? [si[0], si[1]] : a > 1 - e ? [si[2], si[3]] : b < e ? [sj[0], sj[1]] : b > 1 - e ? [sj[2], sj[3]]
          : [si[0] + (si[2] - si[0]) * a, si[1] + (si[3] - si[1]) * a];
        cuts[i].push({ t: a, x: pt[0], z: pt[1] }); cuts[j].push({ t: b, x: pt[0], z: pt[1] });
      }
    }
  }
  // 2. 頂点（0.05m 単位でまとめる）
  const vid = new Map(), V = [];
  const vertex = (x, z) => {
    const k = `${Math.round(x * 20)},${Math.round(z * 20)}`;
    if (!vid.has(k)) { vid.set(k, V.length); V.push([x, z]); }
    return vid.get(k);
  };
  const edges = new Set(), E = [];
  segs.forEach((s, i) => {
    const ts = cuts[i].sort((p, q) => p.t - q.t);
    for (let k = 0; k < ts.length - 1; k++) {
      const u = vertex(ts[k].x, ts[k].z);
      const v = vertex(ts[k + 1].x, ts[k + 1].z);
      if (u === v) continue;
      const ek = u < v ? `${u}-${v}` : `${v}-${u}`;
      if (edges.has(ek)) continue;
      edges.add(ek); E.push([u, v]);
    }
  });
  // 3. 半辺構造で面をたどる
  const out = V.map(() => []);   // 頂点ごとの出ていく半辺
  const H = [];                  // 半辺 {from, to, ang}
  for (const [u, v] of E) {
    const a = H.length;
    H.push({ from: u, to: v, ang: Math.atan2(V[v][1] - V[u][1], V[v][0] - V[u][0]), twin: a + 1 });
    H.push({ from: v, to: u, ang: Math.atan2(V[u][1] - V[v][1], V[u][0] - V[v][0]), twin: a });
    out[u].push(a); out[v].push(a + 1);
  }
  for (const list of out) list.sort((p, q) => H[p].ang - H[q].ang);
  const pos = new Map();
  out.forEach((list) => list.forEach((h, i) => pos.set(h, i)));
  const used = new Uint8Array(H.length);
  const faces = [];
  for (let s = 0; s < H.length; s++) {
    if (used[s]) continue;
    const poly = [];
    let h = s, guard = 0;
    while (!used[h] && guard++ < 200000) {
      used[h] = 1;
      poly.push(V[H[h].from]);
      // 次の半辺：到着点で、戻る向きの1つ手前（時計回り側）
      const t = H[h].twin, list = out[H[h].to];
      h = list[(pos.get(t) - 1 + list.length) % list.length];
    }
    if (poly.length < 3) continue;
    let ar = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) ar += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
    faces.push({ poly, signed: ar / 2 });
  }
  // 内側の面の向き（多数派）だけを残す
  const pos_ = faces.filter((f) => f.signed > 0).length, neg = faces.length - pos_;
  const sign = pos_ >= neg ? 1 : -1;
  return faces.filter((f) => f.signed * sign > 1e-6).map((f, i) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of f.poly) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    return { id: i, poly: f.poly, area: Math.abs(f.signed), bbox: [x0, z0, x1, z1] };
  });
}
function intersect(s, t) {
  const rx = s[2] - s[0], rz = s[3] - s[1], qx = t[2] - t[0], qz = t[3] - t[1];
  const den = rx * qz - rz * qx;
  if (Math.abs(den) < 1e-9) return null;
  const ux = t[0] - s[0], uz = t[1] - s[1];
  const a = (ux * qz - uz * qx) / den, b = (ux * rz - uz * rx) / den;
  const e = 1e-7;
  if (a < -e || a > 1 + e || b < -e || b > 1 + e) return null;
  return [Math.max(0, Math.min(1, a)), Math.max(0, Math.min(1, b))];
}
/** 地名を書く位置：面の重心が面の中ならそこ、外ならクリックした地点 */
function labelPoint(face, seed) {
  let x = 0, z = 0;
  for (const p of face.poly) { x += p[0]; z += p[1]; }
  x /= face.poly.length; z /= face.poly.length;
  return inPoly(face.poly, x, z) ? [x, z] : seed;
}
