// =============================================================
// 経路検索
//   car  : 歩行者用道路は通らない。一方通行は向きどおり。高速道路は選択で
//   walk : 高速道路は通らない。一方通行は気にしない
//   bike : 徒歩と同じ道（高速道路不可・一方通行は無視できる）
//   train: 徒歩＋鉄道＋バス（駅・バス停まで道路を歩く。時刻は考えない）
// =============================================================
import { ROAD_TYPES, tessellate, centroid } from './roads.js';

export const MODES = {
  car:   { label: '車',     speed: 40, hwSpeed: 80 },   // km/h
  walk:  { label: '徒歩',   speed: 4.8 },
  bike:  { label: '自転車', speed: 15 },
  train: { label: '電車・バス', speed: 4.8, railSpeed: 55, busSpeed: 25 },
};
// 高速道路：種類が高速道路のもの、または色を「高速道路（オレンジ）」にした道路。徒歩・自転車は入れない
const isHighway = (r) => !!ROAD_TYPES[r.type]?.highway || r.color === 'orange';
const isAir = (r) => !!ROAD_TYPES[r.type]?.air;

/** 道路網のグラフ。edges: Map(nodeId -> [{to, len, road, seg, fwd}]) */
export function buildGraph(F, mode, { highway = true } = {}) {
  const adj = new Map();
  const add = (a, e) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(e); };
  for (const r of F.ofKind('road')) {
    if (isAir(r)) continue;
    const t = ROAD_TYPES[r.type] || {};
    if (mode === 'car' && t.walk) continue;
    if (mode !== 'car' && isHighway(r)) continue;
    if (mode === 'car' && !highway && isHighway(r)) continue;
    const g = tessellate(r, (id) => F.get(id));
    g.segs.forEach((pts, i) => {
      let len = 0; for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      const a = r.nodes[i], b = r.nodes[i + 1];
      const speed = mode === 'car' ? (isHighway(r) ? MODES.car.hwSpeed : MODES.car.speed) : MODES[mode === 'train' ? 'walk' : mode].speed;
      const e = { len, cost: len / (speed / 3.6), road: r, seg: i, pts };
      add(a, { ...e, to: b, fwd: true });
      if (!(mode === 'car' && t.oneway)) add(b, { ...e, to: a, fwd: false });
    });
  }
  return adj;
}

/** 点に一番近い、グラフの中のノード */
export function nearestNode(F, adj, x, z) {
  let best = null;
  for (const id of adj.keys()) {
    const n = F.get(id); if (!n) continue;
    const d = Math.hypot(n.x - x, n.z - z);
    if (!best || d < best.d) best = { id, d, n };
  }
  return best;
}

/** ダイクストラ法（小さな二分ヒープつき） */
export function dijkstra(adj, start, goals) {
  const dist = new Map([[start, 0]]), prev = new Map();
  const heap = [[0, start]];
  const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top;
  };
  const goalSet = goals ? new Set(goals) : null;
  while (heap.length) {
    const [d, u] = pop();
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (goalSet && goalSet.has(u)) { goalSet.delete(u); if (!goalSet.size) break; }
    for (const e of adj.get(u) || []) {
      const nd = d + e.cost;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { from: u, e }); push([nd, e.to]); }
    }
  }
  return { dist, prev };
}
function walkBack(prev, goal) {
  const edges = [];
  let cur = goal;
  while (prev.has(cur)) { const { from, e } = prev.get(cur); edges.push(e); cur = from; }
  return edges.reverse();
}
const edgePts = (e) => (e.fwd ? e.pts : e.pts.slice().reverse());

// ---------- 点を道路の途中につなぐ ----------
// 中間点（ノード）の間隔が長い道路でも、点に一番近い「道路の途中」から出入りできるように、
// グラフに仮のノードを足したコピーを作る。同じ区間に複数の点が乗るときは順に数珠つなぎにする。
const IDX = new WeakMap();
function edgeIndex(adj) {
  let ix = IDX.get(adj);
  if (ix) return ix;
  const C = 128, grid = new Map(), list = [];
  for (const [u, es] of adj) for (const e of es) {
    if (!e.fwd || !e.pts) continue;
    const i = list.length; list.push({ u, e });
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of e.pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    for (let gx = Math.floor(x0 / C); gx <= Math.floor(x1 / C); gx++) for (let gz = Math.floor(z0 / C); gz <= Math.floor(z1 / C); gz++) {
      const k = gx * 100003 + gz; let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i);
    }
  }
  ix = { C, grid, list };
  IDX.set(adj, ix);
  return ix;
}
function nearestEdge(adj, x, z, maxD = 3000) {
  const { C, grid, list } = edgeIndex(adj);
  if (!list.length) return null;
  const gx = Math.floor(x / C), gz = Math.floor(z / C);
  let best = null;
  const seen = new Set();
  for (let r = 0; r <= Math.ceil(maxD / C); r++) {
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
      for (const k of grid.get((gx + i) * 100003 + (gz + j)) || []) {
        if (seen.has(k)) continue; seen.add(k);
        const { u, e } = list[k];
        let acc = 0;
        for (let s = 0; s < e.pts.length - 1; s++) {
          const [ax, az] = e.pts[s], [bx, bz] = e.pts[s + 1];
          const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
          let t = L ? ((x - ax) * dx + (z - az) * dz) / (L * L) : 0; t = Math.max(0, Math.min(1, t));
          const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z);
          if (!best || d < best.d) best = { d, u, e, s, P: [px, pz], along: acc + L * t };
          acc += L;
        }
      }
    }
    if (best && best.d <= r * C) break;   // これより外の升目にもっと近い道路はない
  }
  return best && best.d <= maxD ? best : null;
}
/** 折れ線を、始点からの距離 a〜b で切り出す */
function slicePts(pts, a, b) {
  const out = []; let acc = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const p = pts[s], q = pts[s + 1], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const t0 = (a - acc) / (L || 1), t1 = (b - acc) / (L || 1);
    if (acc + L >= a && acc <= b) {
      if (!out.length) { const t = Math.max(0, Math.min(1, t0)); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
      if (acc + L <= b) out.push(q); else { const t = Math.max(0, Math.min(1, t1)); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); break; }
    }
    acc += L;
  }
  if (out.length === 1) out.push(out[0]);
  return out;
}
const polyLen = (pts) => { let L = 0; for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); return L; };

/**
 * 点（{id, x, z}）をグラフの道路の途中につなぐ。元の adj は変えずにコピーを返す
 * @returns {adj, at: Map(id -> {d, P})}  d = 点から道路までの距離
 */
export function attachPoints(adj, points, maxD = 3000) {
  const A = new Map(adj);
  const at = new Map();
  const groups = new Map();   // 同じ区間に乗る点をまとめる
  for (const pt of points) {
    const hit = nearestEdge(adj, pt.x, pt.z, maxD);
    if (!hit) continue;
    at.set(pt.id, { d: hit.d, P: hit.P });
    let g = groups.get(hit.e); if (!g) groups.set(hit.e, (g = { u: hit.u, e: hit.e, list: [] }));
    g.list.push({ id: pt.id, along: hit.along });
  }
  const push = (k, e) => A.set(k, [...(A.get(k) || []), e]);
  for (const { u, e, list } of groups.values()) {
    list.sort((p, q) => p.along - q.along);
    const L = polyLen(e.pts) || 1;
    const rev = (adj.get(e.to) || []).some((r) => r.to === u && r.road === e.road && r.seg === e.seg && !r.fwd);
    const chain = [{ id: u, along: 0 }, ...list, { id: e.to, along: L }];
    for (let k = 0; k < chain.length - 1; k++) {
      const a = chain[k], b = chain[k + 1];
      const pts = slicePts(e.pts, a.along, b.along), len = Math.max(0, b.along - a.along);
      const part = { len, cost: e.cost * (len / L), road: e.road, seg: e.seg, pts };
      push(a.id, { ...part, to: b.id, fwd: true });
      if (rev) push(b.id, { ...part, to: a.id, fwd: false });
    }
  }
  return { adj: A, at };
}

/**
 * 道路だけの経路（車・徒歩・自転車）
 * @returns {pts, len, time(秒), legs} または {error}
 */
export function routeRoad(F, mode, from, to, opts = {}) {
  const base = buildGraph(F, mode, opts);
  if (!base.size) return { error: '使える道路がありません' };
  const { adj, at } = attachPoints(base, [{ id: 'A', x: from[0], z: from[1] }, { id: 'B', x: to[0], z: to[1] }]);
  const a = at.get('A'), b = at.get('B');
  if (!a || !b) return { error: '近くに道路がありません' };
  const { dist, prev } = dijkstra(adj, 'A', ['B']);
  if (!dist.has('B')) return { error: mode === 'car' ? '車で行ける道がつながっていません（一方通行や高速道路の設定も確認してください）' : '道がつながっていません' };
  const edges = walkBack(prev, 'B');
  const pts = [from, a.P];
  for (const e of edges) pts.push(...edgePts(e).slice(1));
  pts.push(to);
  const off = a.d + b.d;   // 道路まで歩く距離
  const len = edges.reduce((s, e) => s + e.len, 0) + off;
  const speed = MODES[mode].speed;
  const time = dist.get('B') + off / ((mode === 'car' ? 4.8 : speed) / 3.6);
  // 通る道路名（同じ名前が続くものはまとめる）
  const steps = [];
  for (const e of edges) {
    if (e.len < 0.01) continue;
    const name = e.road.name || ROAD_TYPES[e.road.type]?.label || '道路';
    const last = steps[steps.length - 1];
    if (last && last.name === name) last.len += e.len; else steps.push({ name, len: e.len, highway: isHighway(e.road) });
  }
  return { pts, len, time, steps, mode };
}

// ---------- バス路線の道筋（道路に沿って） ----------
// バスは車と同じ道（一方通行は向きどおり、高速道路も可）を通る。結果は道路・バス停が変わるまで覚えておく
const BUS = new WeakMap();
function busCache(F) {
  const kv = F.kindVer;
  const ver = `${kv.road || 0}|${kv.node || 0}|${kv.busstop || 0}`;
  let c = BUS.get(F);
  if (!c || c.ver !== ver) { c = { ver, graph: null, paths: new Map() }; BUS.set(F, c); }
  return c;
}
/** 路線の停留所の並び（往路。rev=true で復路） */
export const busStops = (F, r, rev) => {
  const ids = (r.stops || []).filter((id) => F.get(id)?.kind === 'busstop');
  return rev ? ids.slice().reverse() : ids;
};
/**
 * バス路線の、停留所から次の停留所までの道筋
 * @returns [{a, b, pts, len, ok}]  ok=false は道路でつながっていない（直線で代用）
 */
export function busPath(F, r, rev = false) {
  const c = busCache(F);
  const ids = busStops(F, r, rev);
  const key = `${r.id}|${rev ? 1 : 0}|${ids.join(',')}`;
  if (c.paths.has(key)) return c.paths.get(key);
  if (!c.graph) c.graph = buildGraph(F, 'car');
  const pts = ids.map((id, i) => { const s = F.get(id); return { id: `S${i}`, x: s.x, z: s.z }; });
  const { adj, at } = attachPoints(c.graph, pts, 300);
  const out = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const A = F.get(ids[i]), B = F.get(ids[i + 1]);
    let hop = null;
    if (at.has(`S${i}`) && at.has(`S${i + 1}`)) {
      const { dist, prev } = dijkstra(adj, `S${i}`, [`S${i + 1}`]);
      if (dist.has(`S${i + 1}`)) {
        const edges = walkBack(prev, `S${i + 1}`);
        const line = [[A.x, A.z], at.get(`S${i}`).P];
        for (const e of edges) line.push(...edgePts(e).slice(1));
        line.push([B.x, B.z]);
        hop = { a: A, b: B, pts: line, len: polyLen(line), ok: true };
      }
    }
    out.push(hop || { a: A, b: B, pts: [[A.x, A.z], [B.x, B.z]], len: Math.hypot(B.x - A.x, B.z - A.z), ok: false });
  }
  c.paths.set(key, out);
  return out;
}

/**
 * 電車・バス＋徒歩
 *   駅・バス停までは道路を歩く。路線ごとに「乗っている状態」のノードを作り、乗るときに待ち時間を足す
 */
export function routeTrain(F, from, to) {
  const v = MODES.walk.speed / 3.6;
  const stations = [...F.ofKind('station')].filter((s) => s.poly?.length && s.rails?.length);
  const stops = [...F.ofKind('busstop')];
  const routes = [...F.ofKind('busroute')].filter((r) => busStops(F, r).length >= 2);
  if (stations.length < 2 && !routes.length) return { error: '駅が2つ以上ある路線か、バス路線が必要です' };
  const hubPt = new Map();   // ハブ（駅・バス停）の位置
  for (const s of stations) hubPt.set(`st:${s.id}`, centroid(s.poly));
  for (const s of stops) hubPt.set(`bs:${s.id}`, [s.x, s.z]);

  const adj = new Map();
  const add = (a, e) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(e); };
  const BOARD_RAIL = 120, BOARD_BUS = 180;

  // 1. 鉄道：線路に沿って駅を並べ、隣どうしをつなぐ
  for (const r of F.ofKind('rail')) {
    const g = tessellate(r, (id) => F.get(id));
    const line = g.segs.flatMap((pts, i) => (i ? pts.slice(1) : pts));
    const on = stations.filter((s) => s.rails.includes(r.id)).map((s) => ({ s, at: alongLine(line, ...centroid(s.poly)) })).sort((p, q) => p.at - q.at);
    if (on.length < 2) continue;
    const ride = (s) => `r:${r.id}:${s.id}`;
    for (const { s } of on) {
      add(`st:${s.id}`, { to: ride(s), len: 0, cost: BOARD_RAIL, kind: 'board' });
      add(ride(s), { to: `st:${s.id}`, len: 0, cost: 0, kind: 'alight' });
    }
    for (let k = 0; k < on.length - 1; k++) {
      const len = on[k + 1].at - on[k].at;
      const cost = len / (MODES.train.railSpeed / 3.6) + 40;   // 停車 40 秒
      const sub = segmentOf(line, on[k].at, on[k + 1].at);
      add(ride(on[k].s), { to: ride(on[k + 1].s), len, cost, kind: 'rail', rail: r, a: on[k].s, b: on[k + 1].s, sub });
      add(ride(on[k + 1].s), { to: ride(on[k].s), len, cost, kind: 'rail', rail: r, a: on[k + 1].s, b: on[k].s, sub: sub.slice().reverse() });
    }
  }
  // 2. バス：路線の停留所を順につなぐ（片方向の指定がなければ往復）
  for (const r of routes) {
    for (const rev of r.oneway ? [false] : [false, true]) {
      const ids = busStops(F, r, rev);
      const hops = busPath(F, r, rev);
      const ride = (i) => `b:${r.id}:${rev ? 1 : 0}:${i}`;
      ids.forEach((id, i) => {
        if (i < ids.length - 1) add(`bs:${id}`, { to: ride(i), len: 0, cost: BOARD_BUS, kind: 'board' });
        if (i > 0) add(ride(i), { to: `bs:${id}`, len: 0, cost: 0, kind: 'alight' });
      });
      hops.forEach((hp, i) => add(ride(i), { to: ride(i + 1), len: hp.len, cost: hp.len / (MODES.train.busSpeed / 3.6) + 30, kind: 'bus', bus: r, a: hp.a, b: hp.b, sub: hp.pts }));
    }
  }
  // 3. 乗り換え：別の駅として作った乗換駅は3分、近くの駅とバス停・バス停どうし（道の反対側など）は歩いて
  for (const s of stations) for (const t of s.transfers || []) if (F.get(t)) add(`st:${s.id}`, { to: `st:${t}`, len: 0, cost: 180, kind: 'transfer', a: s, b: F.get(t) });
  const hubs = [...hubPt.keys()];
  for (let i = 0; i < hubs.length; i++) for (let j = i + 1; j < hubs.length; j++) {
    const a = hubs[i], b = hubs[j];
    if (a.startsWith('st:') && b.startsWith('st:')) continue;
    const [ax, az] = hubPt.get(a), [bx, bz] = hubPt.get(b);
    const d = Math.hypot(ax - bx, az - bz) * 1.25;
    if (d > 350) continue;
    const pts = [[ax, az], [bx, bz]];
    add(a, { to: b, len: d, cost: d / v + 30, kind: 'walk', pts, a: F.get(a.slice(3)), b: F.get(b.slice(3)) });
    add(b, { to: a, len: d, cost: d / v + 30, kind: 'walk', pts: pts.slice().reverse(), a: F.get(b.slice(3)), b: F.get(a.slice(3)) });
  }

  // 4. 出発地・目的地から、駅・バス停まで道路を歩く
  const walkBase = buildGraph(F, 'walk');
  const pts = [{ id: 'START', x: from[0], z: from[1] }, { id: 'GOAL', x: to[0], z: to[1] }, ...hubs.map((k) => ({ id: k, x: hubPt.get(k)[0], z: hubPt.get(k)[1] }))];
  const W = walkBase.size ? attachPoints(walkBase, pts, 1500) : { adj: new Map(), at: new Map() };
  const walkTree = (id, pt) => {
    const out = new Map();   // hub -> {len, pts}
    const me = W.at.get(id);
    if (me) {
      const { dist, prev } = dijkstra(W.adj, id);
      for (const k of [...hubs, id === 'START' ? 'GOAL' : 'START']) {
        const there = W.at.get(k);
        if (!there || !dist.has(k)) continue;
        const edges = walkBack(prev, k);
        const line = [pt, me.P];
        for (const e of edges) line.push(...edgePts(e).slice(1));
        const end = k === 'GOAL' ? to : k === 'START' ? from : hubPt.get(k);
        line.push(end);
        out.set(k, { len: dist.get(k) * v + me.d + there.d, pts: line });
      }
    }
    // 道路でつながっていない所だけ、まっすぐ歩ける近い所（1.5km以内）を使う
    for (const k of [...hubs, id === 'START' ? 'GOAL' : 'START']) {
      if (out.has(k)) continue;
      const end = k === 'GOAL' ? to : k === 'START' ? from : hubPt.get(k);
      const d = Math.hypot(end[0] - pt[0], end[1] - pt[1]) * 1.3;
      if (d < 1500) out.set(k, { len: d, pts: [pt, end] });
    }
    return out;
  };
  const fromStart = walkTree('START', from), fromGoal = walkTree('GOAL', to);
  for (const [k, w] of fromStart) {
    if (k === 'START') continue;
    add('START', { to: k, len: w.len, cost: w.len / v, kind: 'walk', pts: w.pts, b: k === 'GOAL' ? null : F.get(k.slice(3)) });
  }
  for (const [k, w] of fromGoal) {
    if (k === 'GOAL' || k === 'START') continue;
    add(k, { to: 'GOAL', len: w.len, cost: w.len / v, kind: 'walk', pts: w.pts.slice().reverse(), a: F.get(k.slice(3)) });
  }

  const { dist, prev } = dijkstra(adj, 'START', ['GOAL']);
  if (!dist.has('GOAL')) return { error: '電車・バスで行ける経路が見つかりません（駅・バス停と路線の設定を確認してください）' };
  const edges = walkBack(prev, 'GOAL').filter((e) => e.kind !== 'board' && e.kind !== 'alight');
  // 5. 行程にまとめる（同じ路線が続く区間は1つに）
  const legs = [];
  for (const e of edges) {
    const last = legs[legs.length - 1];
    const line = e.kind === 'rail' ? e.rail : e.kind === 'bus' ? e.bus : null;
    if (line && last?.kind === e.kind && last.line.id === line.id && last.to === e.a) { last.to = e.b; last.len += e.len; last.stops++; last.pts.push(...e.sub.slice(1)); continue; }
    if (e.kind === 'walk' && last?.kind === 'walk') { last.to = e.b; last.len += e.len; last.pts.push(...e.pts.slice(1)); continue; }
    legs.push({ kind: e.kind, line, rail: e.rail, bus: e.bus, from: e.a || null, to: e.b || null, len: e.len, stops: 1, pts: (e.sub || e.pts || []).slice() });
  }
  const allPts = legs.flatMap((l) => l.pts);
  const len = edges.reduce((s, e) => s + e.len, 0);
  return { mode: 'train', legs, pts: allPts, len, time: dist.get('GOAL'), walkLen: legs.filter((l) => l.kind === 'walk').reduce((s, l) => s + l.len, 0) };
}
/** 折れ線の上で、点に一番近い位置（始点からの距離） */
function alongLine(line, x, z) {
  let best = { d: Infinity, at: 0 }, acc = 0;
  for (let k = 0; k < line.length - 1; k++) {
    const [ax, az] = line[k], [bx, bz] = line[k + 1];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    let t = L ? ((x - ax) * dx + (z - az) * dz) / (L * L) : 0; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < best.d) best = { d, at: acc + L * t };
    acc += L;
  }
  return best.at;
}
/** 折れ線の s0〜s1（始点からの距離）の部分 */
function segmentOf(line, s0, s1) {
  const out = []; let acc = 0;
  const at = (s) => {
    let a = 0;
    for (let k = 0; k < line.length - 1; k++) {
      const L = Math.hypot(line[k + 1][0] - line[k][0], line[k + 1][1] - line[k][1]);
      if (a + L >= s) { const t = L ? (s - a) / L : 0; return [line[k][0] + (line[k + 1][0] - line[k][0]) * t, line[k][1] + (line[k + 1][1] - line[k][1]) * t]; }
      a += L;
    }
    return line[line.length - 1];
  };
  out.push(at(s0));
  for (let k = 0; k < line.length - 1; k++) {
    acc += Math.hypot(line[k + 1][0] - line[k][0], line[k + 1][1] - line[k][1]);
    if (acc > s0 && acc < s1) out.push(line[k + 1]);
  }
  out.push(at(s1));
  return out;
}
export function fmtTime(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}` : `${m}分`;
}
