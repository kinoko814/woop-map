// =============================================================
// 経路検索
//   car  : 歩行者用道路は通らない。一方通行は向きどおり。高速道路は選択で
//   walk : 高速道路は通らない。一方通行は気にしない
//   bike : 徒歩と同じ道（高速道路不可・一方通行は無視できる）
//   train: 徒歩＋鉄道（駅から駅へ。時刻は考えない）
// =============================================================
import { ROAD_TYPES, tessellate, centroid } from './roads.js';

export const MODES = {
  car:   { label: '車',     speed: 40, hwSpeed: 80 },   // km/h
  walk:  { label: '徒歩',   speed: 4.8 },
  bike:  { label: '自転車', speed: 15 },
  train: { label: '電車',   speed: 4.8, railSpeed: 55 },
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

/**
 * 道路だけの経路（車・徒歩・自転車）
 * @returns {pts, len, time(秒), legs} または {error}
 */
export function routeRoad(F, mode, from, to, opts = {}) {
  const adj = buildGraph(F, mode, opts);
  if (!adj.size) return { error: '使える道路がありません' };
  const a = nearestNode(F, adj, ...from), b = nearestNode(F, adj, ...to);
  if (!a || !b) return { error: '近くに道路がありません' };
  const { dist, prev } = dijkstra(adj, a.id, [b.id]);
  if (!dist.has(b.id)) return { error: mode === 'car' ? '車で行ける道がつながっていません（一方通行や高速道路の設定も確認してください）' : '道がつながっていません' };
  const edges = walkBack(prev, b.id);
  const pts = [from, [a.n.x, a.n.z]];
  for (const e of edges) pts.push(...edgePts(e).slice(1));
  pts.push(to);
  const off = a.d + b.d;   // 道路まで歩く距離
  const len = edges.reduce((s, e) => s + e.len, 0) + off;
  const speed = MODES[mode].speed;
  const time = dist.get(b.id) + off / ((mode === 'car' ? 4.8 : speed) / 3.6);
  // 通る道路名（同じ名前が続くものはまとめる）
  const steps = [];
  for (const e of edges) {
    const name = e.road.name || ROAD_TYPES[e.road.type]?.label || '道路';
    const last = steps[steps.length - 1];
    if (last && last.name === name) last.len += e.len; else steps.push({ name, len: e.len, highway: isHighway(e.road) });
  }
  return { pts, len, time, steps, mode };
}

/**
 * 電車＋徒歩。駅どうしを、同じ路線上の隣の駅とつないだネットワークで探す
 */
export function routeTrain(F, from, to) {
  const walk = buildGraph(F, 'walk');
  const stations = [...F.ofKind('station')].filter((s) => s.poly?.length && s.rails?.length);
  if (stations.length < 2) return { error: '駅が2つ以上ある路線が必要です' };
  // 1. 路線ごとに、線路に沿った位置で駅を並べて隣どうしをつなぐ
  const adj = new Map();
  const add = (a, e) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(e); };
  for (const r of F.ofKind('rail')) {
    const g = tessellate(r, (id) => F.get(id));
    const line = g.segs.flatMap((pts, i) => (i ? pts.slice(1) : pts));
    const on = stations.filter((s) => s.rails.includes(r.id)).map((s) => ({ s, at: alongLine(line, ...centroid(s.poly)) })).sort((p, q) => p.at - q.at);
    for (let k = 0; k < on.length - 1; k++) {
      const len = on[k + 1].at - on[k].at;
      const cost = len / (MODES.train.railSpeed / 3.6) + 40;   // 停車 40 秒
      const e = { len, cost, rail: r, kind: 'rail' };
      add(`st:${on[k].s.id}`, { ...e, to: `st:${on[k + 1].s.id}`, a: on[k].s, b: on[k + 1].s, sub: segmentOf(line, on[k].at, on[k + 1].at) });
      add(`st:${on[k + 1].s.id}`, { ...e, to: `st:${on[k].s.id}`, a: on[k + 1].s, b: on[k].s, sub: segmentOf(line, on[k].at, on[k + 1].at).reverse() });
    }
  }
  // 乗換駅（別の駅として作ったもの）は歩いて3分
  for (const s of stations) for (const t of s.transfers || []) add(`st:${s.id}`, { to: `st:${t}`, len: 0, cost: 180, kind: 'transfer', a: s, b: F.get(t) });
  // 2. 出発地・目的地から各駅まで歩く（道路網で）
  const wa = nearestNode(F, walk, ...from), wb = nearestNode(F, walk, ...to);
  const walkFrom = (wn, pt) => {
    const out = new Map();
    if (wn) {
      const { dist } = dijkstra(walk, wn.id);
      for (const s of stations) {
        const [cx, cz] = centroid(s.poly);
        const sn = nearestNode(F, walk, cx, cz);
        if (sn && dist.has(sn.id)) out.set(s.id, (dist.get(sn.id) * (MODES.walk.speed / 3.6)) + wn.d + sn.d);
      }
    }
    // 道路がなくても、まっすぐ歩ける近い駅（1.5km以内）は使う
    for (const s of stations) { const [cx, cz] = centroid(s.poly); const d = Math.hypot(cx - pt[0], cz - pt[1]) * 1.3; if (d < 1500 && !(out.get(s.id) <= d)) out.set(s.id, d); }
    return out;
  };
  const toSt = walkFrom(wa, from), fromSt = walkFrom(wb, to);
  const v = MODES.walk.speed / 3.6;
  for (const [sid, d] of toSt) add('START', { to: `st:${sid}`, len: d, cost: d / v, kind: 'walk', b: F.get(sid) });
  for (const [sid, d] of fromSt) add(`st:${sid}`, { to: 'GOAL', len: d, cost: d / v, kind: 'walk', a: F.get(sid) });
  const { dist, prev } = dijkstra(adj, 'START', ['GOAL']);
  if (!dist.has('GOAL')) return { error: '電車で行ける経路が見つかりません（駅と路線の設定を確認してください）' };
  const edges = walkBack(prev, 'GOAL');
  // 3. 行程にまとめる（同じ路線が続く区間は1つに）
  const legs = [];
  for (const e of edges) {
    const last = legs[legs.length - 1];
    if (e.kind === 'rail' && last?.kind === 'rail' && last.rail.id === e.rail.id) { last.to = e.b; last.len += e.len; last.stops++; last.pts.push(...e.sub.slice(1)); }
    else legs.push({ kind: e.kind, rail: e.rail, from: e.a, to: e.b, len: e.len, stops: 1, pts: e.sub ? e.sub.slice() : null });
  }
  const pts = [];
  for (const l of legs) {
    if (l.kind === 'rail') pts.push(...l.pts);
    else if (l.kind === 'walk') { pts.push(l.from ? centroid(l.from.poly) : from, l.to ? centroid(l.to.poly) : to); }
  }
  const len = edges.reduce((s, e) => s + e.len, 0);
  return { mode: 'train', legs, pts, len, time: dist.get('GOAL'), walkLen: legs.filter((l) => l.kind === 'walk').reduce((s, l) => s + l.len, 0) };
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
