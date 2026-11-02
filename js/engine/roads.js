// =============================================================
// 道路：種類・形状計算・編集操作（自動交差など）
// =============================================================
import { newId } from './features.js';

export const ROAD_TYPES = {
  normal:          { label: '一般道路',             w: 8,  minPx: 1,   show: 16 },
  divided:         { label: '中央分離帯のある道路', w: 16, minPx: 1.2, show: 16, divided: true },
  highway:         { label: '高速道路',             w: 14, minPx: 2,   show: Infinity, highway: true },
  divided_highway: { label: '高速道路（分離帯あり）', w: 24, minPx: 2.4, show: Infinity, highway: true, divided: true },
  oneway:          { label: '一方通行路',           w: 5,  minPx: 1,   show: 6, oneway: true },
  walk:            { label: '歩行者用道路',         w: 3,  minPx: 1,   show: 3, walk: true },
  runway:          { label: '滑走路',               w: 45, minPx: 2,   show: 80, air: 'runway', group: 'air', fill: '#9aa1aa' },
  taxiway:         { label: '誘導路',               w: 23, minPx: 1.2, show: 10, air: 'taxiway', group: 'air', fill: '#c2c7cd' },
};
/** 道路ツールの一覧に出す種類（滑走路・誘導路は空港ツールから） */
export const ROAD_TOOL_TYPES = ['normal', 'divided', 'highway', 'divided_highway', 'oneway', 'walk'];
const groupOf = (r) => ROAD_TYPES[r.type]?.group || 'road';
export const ROAD_COLORS = {
  white:  { label: '一般', fill: '#ffffff' },
  yellow: { label: '主要道路', fill: '#fff1a0' },
  orange: { label: '高速道路', fill: '#ffc98c' },
};
export const LEVELS = { 0: '地上', 1: '高架', '-1': '地下' };
export const defaultColor = (type) => (ROAD_TYPES[type]?.highway ? 'orange' : 'white');

/** 縮小したときに見えるか（1px あたりのメートル mpp で判断） */
export function roadVisible(road, mpp) {
  const t = ROAD_TYPES[road.type] || ROAD_TYPES.normal;
  let lim = t.show;
  if (road.color === 'yellow') lim = Math.max(lim, 70);
  if (road.color === 'orange') lim = Infinity;
  return mpp < lim;
}

// ---------- 形状 ----------
/**
 * 道路を折れ線に変換する。曲線区間は Catmull-Rom 曲線。
 * @returns {segs: [[[x,z],...], ...], bbox:[x0,z0,x1,z1], len}
 */
export function tessellate(road, getNode) {
  // 中間点がまだ届いていないときは、となりの点の位置で代わりにする（座標 0,0 に飛ばないように）
  const P = road.nodes.map((id) => { const n = getNode(id); return n ? [n.x, n.z] : null; });
  for (let i = 0; i < P.length; i++) if (!P[i]) P[i] = P.slice(0, i).reverse().find(Boolean) || P.slice(i + 1).find(Boolean) || [0, 0];
  const segs = [];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, len = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    const s = road.segs[i] || { w: 8 };
    let pts;
    if (s.c) {
      const p0 = P[i - 1] || a, p3 = P[i + 2] || b;
      const c1 = [a[0] + (b[0] - p0[0]) / 6, a[1] + (b[1] - p0[1]) / 6];
      const c2 = [b[0] - (p3[0] - a[0]) / 6, b[1] - (p3[1] - a[1]) / 6];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(4, Math.min(48, Math.ceil(d / 12)));
      pts = [];
      for (let k = 0; k <= n; k++) {
        const t = k / n, u = 1 - t;
        pts.push([
          u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
          u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1],
        ]);
      }
    } else pts = [a, b];
    for (const [x, z] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    segs.push(pts);
  }
  if (!segs.length) { const [x, z] = P[0] || [0, 0]; x0 = x1 = x; z0 = z1 = z; }
  return { segs, bbox: [x0, z0, x1, z1], len };
}

/** 形状キャッシュ（Features.stamp が変わったら作り直す） */
export class GeomCache {
  constructor(F) { this.F = F; this.m = new Map(); }
  get(road) {
    const st = this.F.stamp.get(road.id) || 0;
    const c = this.m.get(road.id);
    if (c && c.st === st && c.road === road) return c.g;
    const g = tessellate(road, (id) => this.F.get(id));
    this.m.set(road.id, { st, road, g });
    return g;
  }
}

export function segLevel(road, i, getNode) {
  const a = getNode(road.nodes[i])?.lv || 0, b = getNode(road.nodes[i + 1])?.lv || 0;
  return a === b ? a : a || b;
}

/** 点と折れ線の最短距離 */
export function nearestOnPolyline(pts, x, z) {
  let best = { d: Infinity, x: 0, z: 0, k: 0, t: 0 };
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    let t = L2 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, pz = az + dz * t;
    const d = Math.hypot(px - x, pz - z);
    if (d < best.d) best = { d, x: px, z: pz, k, t };
  }
  return best;
}

/** 線分どうしの交点 */
function segIntersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + r[0] * t, a[1] + r[1] * t];
}

// ---------- 編集操作（すべて Tx の上で行う） ----------
export function makeNode(tx, x, z, lv = 0) {
  return tx.put({ id: newId(), kind: 'node', x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, lv });
}

/** 道路の区間 seg に既存ノード nodeId を差し込む（区間の設定は両側に引き継ぐ） */
export function insertNodeInRoad(tx, roadId, seg, nodeId) {
  const r = tx.edit(roadId);
  r.nodes.splice(seg + 1, 0, nodeId);
  const s = r.segs[seg];
  r.segs.splice(seg, 1, { ...s }, { ...s });
}

/** 点 (x,z) に最も近い区間を探して、そこへノードを差し込む */
export function insertNodeNearest(tx, roadId, nodeId) {
  const r = tx.get(roadId); const n = tx.get(nodeId);
  if (!r || !n) return;
  const g = tessellate(r, (id) => tx.get(id));
  let best = { d: Infinity, seg: 0 };
  g.segs.forEach((pts, i) => { const h = nearestOnPolyline(pts, n.x, n.z); if (h.d < best.d) best = { d: h.d, seg: i }; });
  insertNodeInRoad(tx, roadId, best.seg, nodeId);
}

/** 道路からノードを1つ外す（端なら短く、途中なら前後の区間をつなぐ） */
export function removeNodeFromRoad(tx, roadId, index) {
  const r = tx.edit(roadId);
  const nid = r.nodes[index];
  r.nodes.splice(index, 1);
  if (index === 0) r.segs.splice(0, 1);
  else if (index >= r.segs.length) r.segs.splice(r.segs.length - 1, 1);
  else r.segs.splice(index, 1);
  if (r.nodes.length < 2) deleteRoad(tx, roadId);
  gcNode(tx, nid);
}
export function deleteRoad(tx, roadId) {
  const r = tx.get(roadId);
  if (!r) return;
  tx.del(roadId);
  for (const n of new Set(r.nodes)) gcNode(tx, n);
}
/** どの道路からも使われていないノードを消す */
export function gcNode(tx, nodeId) {
  if (tx.get(nodeId) && !tx.linesOf(nodeId).size) tx.del(nodeId);
}
/** ノード from を to に統合する（ドラッグで重ねたとき） */
export function mergeNodes(tx, from, to) {
  if (from === to) return;
  for (const rid of tx.linesOf(from)) {
    const r = tx.edit(rid);
    r.nodes = r.nodes.map((n) => (n === from ? to : n));
    // 隣り合う同じノードは1つに
    for (let i = r.nodes.length - 1; i > 0; i--) {
      if (r.nodes[i] === r.nodes[i - 1]) { r.nodes.splice(i, 1); r.segs.splice(i - 1, 1); }
    }
    if (r.nodes.length < 2) tx.del(rid);
  }
  tx.del(from);
  gcNode(tx, to);
}

/**
 * 同じ高さの道路が交わっている所に、自動で交差点ノードを作る。
 * roadIds: 調べる道路（新しく描いた・動かした道路）
 */
export function autoIntersect(tx, roadIds, snap = 2) {
  const getNode = (id) => tx.get(id);
  // 調べる相手は、範囲が重なる道路だけに絞る（大きなマップでも速く）
  let ub = [Infinity, Infinity, -Infinity, -Infinity];
  for (const rid of roadIds) {
    const r = tx.get(rid); if (!r) continue;
    const b = tessellate(r, getNode).bbox;
    ub = [Math.min(ub[0], b[0]), Math.min(ub[1], b[1]), Math.max(ub[2], b[2]), Math.max(ub[3], b[3])];
  }
  const cand = [];
  for (const o of tx.ofKind('road')) {
    const b = tessellate(o, getNode).bbox;
    if (b[0] <= ub[2] && b[2] >= ub[0] && b[1] <= ub[3] && b[3] >= ub[1]) cand.push(o.id);
  }
  for (let guard = 0; guard < 200; guard++) {
    let found = null;
    outer: for (const rid of roadIds) {
      const r = tx.get(rid); if (!r) continue;
      const g = tessellate(r, getNode);
      for (const oid of cand) {
        const o = tx.get(oid); if (!o) continue;
        const og = oid === rid ? g : tessellate(o, getNode);
        if (og.bbox[0] > g.bbox[2] || og.bbox[2] < g.bbox[0] || og.bbox[1] > g.bbox[3] || og.bbox[3] < g.bbox[1]) continue;
        for (let i = 0; i < g.segs.length; i++) {
          const lv = levelOf(r, i, getNode);
          if (lv === null) continue;
          for (let j = 0; j < og.segs.length; j++) {
            if (o.id === r.id && Math.abs(i - j) <= 1) continue;
            if (levelOf(o, j, getNode) !== lv || groupOf(o) !== groupOf(r)) continue;
            const A = g.segs[i], B = og.segs[j];
            for (let a = 0; a < A.length - 1; a++) for (let b = 0; b < B.length - 1; b++) {
              const p = segIntersect(A[a], A[a + 1], B[b], B[b + 1]);
              if (!p) continue;
              // 既存ノードのすぐ近くなら無視（すでにつながっている）
              const near = (road, k) => [road.nodes[k], road.nodes[k + 1]].some((id) => { const n = getNode(id); return Math.hypot(n.x - p[0], n.z - p[1]) < snap; });
              if (near(r, i) || near(o, j)) continue;
              found = { r: r.id, i, o: o.id, j, p, lv };
              break outer;
            }
          }
        }
      }
    }
    if (!found) return;
    const n = makeNode(tx, found.p[0], found.p[1], found.lv);
    if (found.r === found.o) {
      // 自分自身との交差：後ろの区間から先に差し込む
      const [hi, lo] = found.i > found.j ? [found.i, found.j] : [found.j, found.i];
      insertNodeInRoad(tx, found.r, hi, n.id);
      insertNodeInRoad(tx, found.r, lo, n.id);
    } else {
      insertNodeInRoad(tx, found.r, found.i, n.id);
      insertNodeInRoad(tx, found.o, found.j, n.id);
    }
  }
}
/** 区間の高さ。地上どうし・高架どうしなど両端が同じときだけ値を返す（坂の区間は null） */
function levelOf(road, i, getNode) {
  const a = getNode(road.nodes[i])?.lv || 0, b = getNode(road.nodes[i + 1])?.lv || 0;
  return a === b ? a : null;
}

/** ノードが交差点か（2本以上の道路が通る、または同じ道路が2回通る） */
export function isJunction(F, nodeId) {
  const rs = F.roadsOf(nodeId);
  if (rs.size >= 2) return true;
  for (const rid of rs) {
    const r = F.get(rid);
    if (r && r.nodes.filter((n) => n === nodeId).length >= 2) return true;
  }
  return false;
}

/** 点が多角形の中にあるか */
export function inPoly(poly, x, z) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
export function centroid(poly) {
  let x = 0, z = 0;
  for (const p of poly) { x += p[0]; z += p[1]; }
  return [x / poly.length, z / poly.length];
}
