// =============================================================
// 道路の描画
//   高さごと (地下 → 地上 → 高架) に「縁取りを全部 → 塗りを全部」の順で描く。
//   こうすると交差点で縁取りが自然につながり、交差部分の縁が消える。
// =============================================================
import { ROAD_TYPES, ROAD_COLORS, GeomCache, tessellate, roadVisible, segLevel, isJunction } from './roads.js';
import { drawRivers, drawRiverLabels, riverVisible } from './rivers.js';
import { AddressIndex } from './address.js';
import { drawAddrTints, drawBorders, drawAddrLabels, drawAddrHighlight } from './addrlayer.js';
import { drawRails, railVisible, drawStationShapes, drawStationMarks, drawExits } from './rails.js';
import { drawAreaFills, drawBuildings, drawAreaLabels, drawPois, viewSpan, AREA_TYPES } from './shapes.js';
import { drawBusRoutes, drawBusStops, routesAt } from './bus.js';

const CASING = '#a9b1bb';
const CASING_HIGH = '#8b939d';
const PRIORITY = { walk: 0, white: 1, yellow: 2, orange: 3 };
const FONT = '"Noto Sans JP", system-ui, sans-serif';

/** 縮尺バーの表示が 200m になる境目（1px あたり約3.3m）。これより縮小するとアイコン類を隠す */
export const ICON_MPP = 200 / 60;

export class RoadLayer {
  constructor(view, F) {
    this.view = view; this.F = F;
    this.geom = new GeomCache(F);
    this.draft = null;          // 描きかけの道路 {road, getNode}
    this.hide = new Set();      // 描きかけで置き換え中の道路
    this.nodeOverride = null;   // ドラッグ中のノード Map(id -> node)
    this.edit = false;          // 編集モード（IC/JCT の範囲を表示）
    this.selectedArea = null;
    this.addr = new AddressIndex(F, () => view.mb);   // 住所の計算
    this.addrEdit = null;       // 住所ツールで編集中の階層（番号）
    this.addrActive = null;     // 住所ツールで選んでいる地名
  }
  getNode = (id) => (this.nodeOverride && this.nodeOverride.get(id)) || this.F.get(id);

  get selectedArea() { return this.selected; }
  set selectedArea(id) { this.selected = id; }

  /** 地図の上の図形をすべて、重なり順どおりに描く */
  draw(ctx, v) {
    const mpp = v.mpp, vb = v.bounds(), span = viewSpan(v);
    const F = this.F;
    const lists = { area: [], building: [], station: [], poi: [], busstop: [] };
    for (const f of F.items.values()) if (lists[f.kind]) lists[f.kind].push(this.shapeOverride?.get(f.id) || f);
    if (this.shapeDraft) (lists[this.shapeDraft.kind] ||= []).push(this.shapeDraft);
    const sel = this.selected;

    drawAreaFills(ctx, v, lists.area, sel);
    if (this.addrEdit !== null) drawAddrTints(ctx, v, this.addr, this.addrEdit, this.addrActive);
    const selF = sel ? F.get(sel) : null;
    if (selF?.kind === 'addr') drawAddrHighlight(ctx, v, this.addr, selF);
    drawBuildings(ctx, v, lists.building, sel);
    if (this.edit || sel) this._drawAreas(ctx, v, !this.edit);

    // 道路と線路
    const items = [], railItems = [], riverItems = [], borderItems = [];
    const overridden = new Set();
    if (this.nodeOverride) for (const id of this.nodeOverride.keys()) for (const r of F.linesOf(id)) overridden.add(r);
    const m = 40;
    const near = (g) => !(g.bbox[0] > vb.x1 + m || g.bbox[2] < vb.x0 - m || g.bbox[1] > vb.z1 + m || g.bbox[3] < vb.z0 - m);
    for (const f of F.items.values()) {
      if (f.kind !== 'road' && f.kind !== 'rail' && f.kind !== 'river' && f.kind !== 'border') continue;
      if (this.hide.has(f.id)) continue;
      if (f.kind === 'border') { const g = overridden.has(f.id) ? tessellate(f, this.getNode) : this.geom.get(f); if (near(g)) borderItems.push({ border: f, g }); continue; }
      if (f.kind === 'road' ? !roadVisible(f, mpp) : f.kind === 'rail' ? !railVisible(f, mpp) : !riverVisible(f, mpp)) continue;
      const g = overridden.has(f.id) ? tessellate(f, this.getNode) : this.geom.get(f);
      if (!near(g)) continue;
      if (f.kind === 'road') items.push({ road: f, g, getNode: this.getNode });
      else if (f.kind === 'rail') railItems.push({ rail: f, g, getNode: this.getNode });
      else riverItems.push({ river: f, g });
    }
    if (this.draft) {
      const g = tessellate(this.draft.road, this.draft.getNode);
      if (this.draft.road.kind === 'rail') railItems.push({ rail: this.draft.road, g, getNode: this.draft.getNode });
      else if (this.draft.road.kind === 'river') riverItems.push({ river: this.draft.road, g });
      else if (this.draft.road.kind === 'border') borderItems.push({ border: this.draft.road, g });
      else items.push({ road: this.draft.road, g, getNode: this.draft.getNode });
    }
    // 川は「地下の道路」と「地上の道路」のあいだに描く → 道路が必ず上になる
    drawBorders(ctx, v, borderItems, this.addrEdit, !this.edit);
    const labelData = drawRoadItems(ctx, v, items, F, this.getNode, { deferLabels: true, beforeGround: () => drawRivers(ctx, v, riverItems) });
    drawRails(ctx, v, railItems, this.getNode);

    // 駅の形（画面の幅が 3km より狭いとき）と出口
    if (span < 3000) drawStationShapes(ctx, v, lists.station, F, sel);
    drawExits(ctx, v, lists.station);

    // バス路線：表示モードではバス停を選んでいるときだけ、その停留所を通る路線を出す
    //   編集モードのバスツール中は全部（選んでいる路線以外は薄く）
    let busShown = [];
    if (this.busAll) busShown = [...F.ofKind('busroute')];
    else if (selF?.kind === 'busstop') busShown = routesAt(F, sel);
    if (busShown.length) {
      const act = this.busActive;
      if (act && this.busAll) {
        drawBusRoutes(ctx, v, F, busShown.filter((r) => r.id !== act), { dim: true });
        drawBusRoutes(ctx, v, F, busShown.filter((r) => r.id === act));
      } else drawBusRoutes(ctx, v, F, busShown);
    }
    const busHl = new Set();
    if (!this.busAll || this.busActive) for (const r of busShown) if (!this.busActive || r.id === this.busActive) for (const id of r.stops || []) busHl.add(id);

    // 文字とアイコン（重ならないように場所を取り合う）
    // 縮尺バーが 200m を表示するくらいまで拡大したときだけ、アイコン類を出す（それより広いと道路と線路だけ）
    const taken = [];
    this.hits = { stations: [], pois: [], areas: [] };
    const icons = mpp < ICON_MPP;
    if (icons) this.hits.stations = drawStationMarks(ctx, v, lists.station, F, { onImage: () => v.requestDraw(), selectedId: sel, taken });
    // バス停（路線を表示中なら、その停留所は少し縮小していても出す）
    const stopsToDraw = icons || this.busAll ? lists.busstop : lists.busstop.filter((b) => busHl.has(b.id) || b.id === sel);
    if (stopsToDraw.length && (icons || this.busAll || busHl.size)) this.hits.busstops = drawBusStops(ctx, v, stopsToDraw, sel, taken, { hl: busHl });
    // カテゴリ検索中（poiFilter）は、縮小していてもその施設だけ表示
    if (icons || this.poiFilter) this.hits.pois = drawPois(ctx, v, lists.poi, sel, taken, { only: this.poiFilter });
    drawRoadLabels(ctx, v, labelData, taken);
    drawRiverLabels(ctx, v, riverItems, taken);
    if (icons) drawAreaLabels(ctx, v, lists.area, taken);
    if (icons) this._drawAreaLabels(ctx, v);
    this.hits.addr = drawAddrLabels(ctx, v, this.addr, taken, !this.edit);
  }

  _drawAreas(ctx, v, onlySelected = false) {
    ctx.save();
    for (const a of this.F.ofKind('area')) {
      if (a.poly.length < 3 || !AREA_TYPES[a.type]?.outlineOnly) continue;
      if (onlySelected && a.id !== this.selectedArea) continue;
      const sel = this.selectedArea === a.id;
      ctx.beginPath();
      a.poly.forEach(([x, z], i) => { const [sx, sz] = v.toScreen(x, z); i ? ctx.lineTo(sx, sz) : ctx.moveTo(sx, sz); });
      ctx.closePath();
      ctx.fillStyle = a.type === 'jct' ? 'rgba(255,150,60,.10)' : 'rgba(60,170,150,.10)';
      ctx.fill();
      ctx.setLineDash([6, 4]); ctx.lineWidth = sel ? 2.5 : 1.5;
      ctx.strokeStyle = a.type === 'jct' ? '#e08a3c' : '#2fa392';
      ctx.stroke();
    }
    ctx.restore();
  }
  /** IC / JCT：マーク（緑の IC・オレンジの JCT）の横に名前 */
  _drawAreaLabels(ctx, v) {
    this.hits.areas = [];
    if (v.mpp > 45) return;
    ctx.save();
    ctx.textBaseline = 'middle';
    for (const a of this.F.ofKind('area')) {
      if (a.poly.length < 3 || !AREA_TYPES[a.type]?.outlineOnly) continue;
      let cx = 0, cz = 0;
      for (const [x, z] of a.poly) { cx += x; cz += z; }
      const [sx, sy] = v.toScreen(cx / a.poly.length, cz / a.poly.length);
      if (sx < -150 || sy < -40 || sx > v.w + 150 || sy > v.h + 40) continue;
      const tag = a.type === 'jct' ? 'JCT' : 'IC';
      const name = (a.name || '').replace(new RegExp(`\\s*${tag}$`), '');
      // マーク
      ctx.font = `800 11px ${FONT}`;
      const mw = ctx.measureText(tag).width + 10, mh = 18;
      const mx = sx - mw / 2 - (name ? 0 : 0), my = sy - mh / 2;
      ctx.fillStyle = a.type === 'jct' ? '#e07b28' : '#1f8a7a';
      roundRect(ctx, mx, my, mw, mh, 4); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
      ctx.fillText(tag, mx + mw / 2, sy + 0.5);
      let right = mx + mw;
      // 名前（マークの右）
      if (name && v.mpp < 30) {
        ctx.font = `700 12px ${FONT}`; ctx.textAlign = 'left';
        const tw = ctx.measureText(name).width;
        ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.strokeText(name, right + 5, sy + 0.5);
        ctx.fillStyle = a.type === 'jct' ? '#a8521a' : '#16665b'; ctx.fillText(name, right + 5, sy + 0.5);
        right += tw + 7;
      }
      this.hits.areas.push({ id: a.id, box: [mx - 2, my - 2, right + 2, my + mh + 2] });
    }
    ctx.restore();
  }
}

/** 道路の一覧を描く（描きかけの道路のプレビューにも使う） */
export function drawRoadItems(ctx, v, items, F, getNode, opts = {}) {
  const sc = v.scale, mpp = v.mpp;
  // 区間を「同じ高さ・同じ太さ」ごとのひと続きにまとめる
  const runs = [];
  const joints = [];   // 同じ道路で高さが切り替わる所（地上⇔高架・地下）
  const gByRoad = new Map();
  for (const it of items) {
    const r = it.road, gn = it.getNode || getNode;
    const t = ROAD_TYPES[r.type] || ROAD_TYPES.normal;
    gByRoad.set(r.id, it.g);
    let cur = null;
    it.g.segs.forEach((pts, i) => {
      const lv = segLevel(r, i, gn);
      const w = r.segs[i]?.w || t.w;
      if (cur && cur.lv !== lv) joints.push({ road: r, t, prev: it.g.segs[i - 1], next: pts, w: Math.max(w, r.segs[i - 1]?.w || w) });
      if (cur && cur.lv === lv && cur.w === w) { for (let k = 1; k < pts.length; k++) cur.pts.push(pts[k]); }
      else { cur = { road: r, t, lv, w, pts: pts.slice(), wpx: Math.max(w * sc, t.minPx) }; runs.push(cur); }
    });
  }
  // 交差点になっているノード
  const junctions = [];
  if (F) {
    const seen = new Set();
    for (const it of items) for (const id of it.road.nodes) {
      if (seen.has(id)) continue; seen.add(id);
      if (isJunction(F, id)) { const n = getNode(id); if (n) junctions.push(n); }
    }
  }
  const prio = (run) => (run.t.air ? -1 : run.t.walk ? PRIORITY.walk : PRIORITY[run.road.color] ?? 1);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const lv of [-1, 0, 1]) {
    if (lv === 0 && opts.beforeGround) { ctx.globalAlpha = 1; opts.beforeGround(); }
    const L = runs.filter((r) => r.lv === lv).sort((a, b) => prio(a) - prio(b));
    if (!L.length) continue;
    const J = junctions.filter((n) => (n.lv || 0) === lv);
    ctx.globalAlpha = lv === -1 ? 0.5 : 1;
    const casing = lv === 1 ? CASING_HIGH : CASING;
    const cwOf = (wpx) => Math.max(0.8, Math.min(2.2, wpx * 0.12));
    // 高架の影
    if (lv === 1) {
      ctx.strokeStyle = 'rgba(25,35,45,.16)';
      for (const r of L) { if (r.wpx < 3) continue; ctx.lineWidth = r.wpx + cwOf(r.wpx) * 2 + 4; path(ctx, v, r.pts); ctx.stroke(); }
    }
    // 縁取り
    for (const r of L) {
      if (r.wpx < 2.2) continue;
      ctx.strokeStyle = casing;
      ctx.lineWidth = r.wpx + cwOf(r.wpx) * 2;
      if (r.t.walk || lv === -1) ctx.setLineDash([Math.max(3, r.wpx), Math.max(2, r.wpx * 0.7)]);
      path(ctx, v, r.pts); ctx.stroke();
      ctx.setLineDash([]);
    }
    // 交差点の角の丸み（縁取り）
    const fil = J.filter((n) => n.r > 0 && n.r * sc >= 1.5).map((n) => ({ n, arms: armsOf(n, F, gByRoad) }));
    for (const { n, arms } of fil) {
      ctx.fillStyle = casing;
      drawJunctionShape(ctx, v, fillets(n, arms, 1.6 / sc));
    }
    // 塗り
    for (const r of L) {
      ctx.strokeStyle = r.wpx < 2.2 && !r.t.walk && r.road.color === 'white' ? '#c3c9d0' : r.t.walk ? '#ffffff' : ROAD_COLORS[r.road.color]?.fill || '#fff';
      if (r.wpx < 2.2 && r.road.color !== 'white') ctx.strokeStyle = darken(ROAD_COLORS[r.road.color]?.fill);
      if (r.t.fill) ctx.strokeStyle = r.t.fill;
      ctx.lineWidth = r.wpx;
      path(ctx, v, r.pts); ctx.stroke();
    }
    for (const { n, arms } of fil) {
      ctx.fillStyle = junctionColor(F, n.id, getNode);
      // 交差点の中を1色で塗る（白い道路と黄色い道路が混ざらないよう、優先度の高い色に）
      drawJunctionShape(ctx, v, fillets(n, arms, -0.6 / sc));
    }
    // 中央分離帯
    for (const r of L) {
      if (!r.t.divided || r.wpx < 6) continue;
      ctx.strokeStyle = casing; ctx.lineWidth = Math.max(1, r.wpx * 0.07);
      path(ctx, v, r.pts); ctx.stroke();
    }
    // 交差点で分離帯を切る（「切らない」に設定した交差点はそのまま）
    for (const n of J) {
      if (n.median === 'closed') continue;
      let wmax = 0, color = null;
      for (const rid of F.roadsOf(n.id)) {
        const rd = F.get(rid); if (!rd || !ROAD_TYPES[rd.type]?.divided) continue;
        rd.nodes.forEach((id, i) => { if (id === n.id) { const s = rd.segs[i] || rd.segs[i - 1]; if (s && s.w > wmax) { wmax = s.w; color = ROAD_COLORS[rd.color]?.fill; } } });
      }
      if (!wmax || wmax * sc < 6) continue;
      const [x, y] = v.toScreen(n.x, n.z);
      ctx.fillStyle = color || '#fff';
      ctx.beginPath(); ctx.arc(x, y, wmax * 0.55 * sc, 0, Math.PI * 2); ctx.fill();
    }
    // 滑走路の中心の白い破線・誘導路の黄色い中心線
    for (const r of L) {
      if (r.t.air === 'runway' && r.wpx >= 8) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, r.wpx * 0.04); ctx.setLineDash([r.wpx * 0.9, r.wpx * 0.7]); path(ctx, v, r.pts); ctx.stroke(); ctx.setLineDash([]); }
      if (r.t.air === 'taxiway' && r.wpx >= 5) { ctx.strokeStyle = '#e8c33a'; ctx.lineWidth = Math.max(1, r.wpx * 0.06); path(ctx, v, r.pts); ctx.stroke(); }
    }
    // 一方通行の矢印
    for (const r of L) if (r.t.oneway && r.wpx >= 7) arrows(ctx, v, r.pts, r.wpx, casing);
  }
  ctx.globalAlpha = 1;
  // 高さの切り替わりを上から短く塗り直して、道路がつながって見えるようにする
  ctx.lineCap = 'butt';
  for (const j of joints) {
    const wpx = Math.max(j.w * sc, j.t.minPx);
    if (wpx < 2.2) continue;
    const half = Math.max(wpx * 1.3, 10) / sc;
    const pts = [...tail(j.prev, half), ...head(j.next, half).slice(1)];
    const inner = [...tail(j.prev, half - 1.5 / sc), ...head(j.next, half - 1.5 / sc).slice(1)];
    ctx.strokeStyle = CASING; ctx.lineWidth = wpx + Math.max(0.8, Math.min(2.2, wpx * 0.12)) * 2;
    path(ctx, v, inner); ctx.stroke();
    ctx.strokeStyle = j.t.walk ? '#ffffff' : ROAD_COLORS[j.road.color]?.fill || '#fff'; ctx.lineWidth = wpx;
    path(ctx, v, pts); ctx.stroke();
  }
  ctx.lineCap = 'round';
  // 信号
  if (mpp < Math.min(2.5, ICON_MPP)) for (const n of junctions) if (n.signal) signal(ctx, ...v.toScreen(n.x, n.z));
  // 名前
  const segItems = [];
  for (const it of items) if (it.road.name) it.g.segs.forEach((pts) => segItems.push({ road: it.road, pts }));
  ctx.restore();
  if (opts.deferLabels) return { segItems, junctions };
  labels(ctx, v, segItems, junctions, []);
  return null;
}
/** 道路名・交差点名（drawRoadItems の deferLabels の結果を渡す） */
export function drawRoadLabels(ctx, v, data, taken) {
  if (!data) return;
  ctx.save(); labels(ctx, v, data.segItems, data.junctions, taken); ctx.restore();
}

// ---------- 高さの切り替わり用：折れ線の端から長さ len 分を取り出す ----------
function tail(pts, len) {
  const out = [pts[pts.length - 1]];
  for (let k = pts.length - 1; k > 0 && len > 0; k--) {
    const [ax, az] = pts[k], [bx, bz] = pts[k - 1];
    const d = Math.hypot(bx - ax, bz - az);
    if (d >= len) { out.push([ax + ((bx - ax) * len) / d, az + ((bz - az) * len) / d]); len = 0; }
    else { out.push(pts[k - 1]); len -= d; }
  }
  return out.reverse();
}
function head(pts, len) { return tail(pts.slice().reverse(), len).reverse(); }

// ---------- 交差点の角の丸み（隅切り） ----------
/** 交差点から伸びる道路の向きと幅（メートル） */
function armsOf(n, F, gByRoad) {
  const arms = [];
  for (const rid of F.roadsOf(n.id)) {
    const r = F.get(rid), g = gByRoad.get(rid);
    if (!r || !g) continue;
    r.nodes.forEach((id, i) => {
      if (id !== n.id) return;
      if (i > 0) arms.push(arm(n, g.segs[i - 1].slice().reverse(), (r.segs[i - 1]?.w || 8) / 2));
      if (i < r.nodes.length - 1) arms.push(arm(n, g.segs[i], (r.segs[i]?.w || 8) / 2));
    });
  }
  return arms.filter(Boolean).sort((a, b) => a.ang - b.ang);
}
function arm(n, pts, h) {
  for (const [x, z] of pts) {
    const dx = x - n.x, dz = z - n.z, d = Math.hypot(dx, dz);
    if (d > 0.5) return { dx: dx / d, dz: dz / d, h, ang: Math.atan2(dz, dx) };
  }
  return null;
}
/**
 * 隣り合う道路のあいだの角を、半径 r の弧で丸める図形を作る。
 * off > 0 にすると外側（縁取り用）に広げた図形になる。
 */
function fillets(n, arms, off) {
  const out = [];
  const m = arms.length;
  if (m < 2) return out;
  for (let k = 0; k < m; k++) {
    const A = arms[k], B = arms[(k + 1) % m];
    let th = B.ang - A.ang; if (th <= 0) th += Math.PI * 2;
    if (th < 0.1 || th > Math.PI * 0.97) continue;
    // A の B 側の端の線、B の A 側の端の線
    const ax = n.x - A.dz * (A.h + off), az = n.z + A.dx * (A.h + off);
    const bx = n.x + B.dz * (B.h + off), bz = n.z - B.dx * (B.h + off);
    const den = A.dx * B.dz - A.dz * B.dx;
    if (Math.abs(den) < 1e-6) continue;
    const s = ((bx - ax) * B.dz - (bz - az) * B.dx) / den;
    const cx = ax + A.dx * s, cz = az + A.dz * s;
    // 鋭い角では丸みが道路に沿って長く伸びすぎないよう、長さを半径の1.2倍までにする
    const rEff = Math.min(n.r, n.r * 1.2 * Math.tan(th / 2));
    const r = Math.max(0.1, rEff - off);    // 縁取りは同じ中心で少し小さい弧にする
    const t = r / Math.tan(th / 2);
    out.push({ c: [cx, cz], a: [cx + A.dx * t, cz + A.dz * t], b: [cx + B.dx * t, cz + B.dz * t], r });
  }
  return out;
}
/** 角を丸めた交差点の形（隅切りの弧をつないだ多角形）を塗る */
function drawJunctionShape(ctx, v, shapes) {
  if (!shapes.length) return;
  ctx.beginPath();
  shapes.forEach((sh, i) => {
    const [cx, cy] = v.toScreen(...sh.c), [ax, ay] = v.toScreen(...sh.a), [bx, by] = v.toScreen(...sh.b);
    i ? ctx.lineTo(ax, ay) : ctx.moveTo(ax, ay);
    ctx.arcTo(cx, cy, bx, by, sh.r * v.scale);
    ctx.lineTo(bx, by);
  });
  ctx.closePath(); ctx.fill();
  if (shapes.length === 1) drawFillet(ctx, v, shapes[0]);
}
function drawFillet(ctx, v, sh) {
  const [cx, cy] = v.toScreen(...sh.c), [ax, ay] = v.toScreen(...sh.a), [bx, by] = v.toScreen(...sh.b);
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.arcTo(cx, cy, bx, by, sh.r * v.scale); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
}

function path(ctx, v, pts) {
  ctx.beginPath();
  let lx = null, ly = null;
  for (let k = 0; k < pts.length; k++) {
    const [x, y] = v.toScreen(pts[k][0], pts[k][1]);
    if (k === 0) ctx.moveTo(x, y);
    else if (k === pts.length - 1 || Math.abs(x - lx) + Math.abs(y - ly) > 1.2) ctx.lineTo(x, y);
    else continue;
    lx = x; ly = y;
  }
  if (pts.length === 1) ctx.lineTo(lx + 0.01, ly);
}
function arrows(ctx, v, pts, wpx, color) {
  const S = pts.map(([x, z]) => v.toScreen(x, z));
  let acc = 60;
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.2, wpx * 0.12);
  const a = Math.min(wpx * 0.32, 7);
  for (let k = 0; k < S.length - 1; k++) {
    const [x0, y0] = S[k], [x1, y1] = S[k + 1];
    const L = Math.hypot(x1 - x0, y1 - y0); if (!L) continue;
    const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    let d = 120 - acc;
    while (d < L) {
      const px = x0 + ux * d, py = y0 + uy * d;
      if (px > -20 && py > -20 && px < v.w + 20 && py < v.h + 20) {
        ctx.beginPath();
        ctx.moveTo(px - ux * a - uy * a, py - uy * a + ux * a);
        ctx.lineTo(px, py);
        ctx.lineTo(px - ux * a + uy * a, py - uy * a - ux * a);
        ctx.stroke();
      }
      d += 120;
    }
    acc = (acc + L) % 120;
  }
  ctx.restore();
}
function signal(ctx, x, y) {
  ctx.save();
  ctx.translate(x + 10, y - 16);
  ctx.fillStyle = '#2b3138'; roundRect(ctx, -10, -5, 20, 10, 3); ctx.fill();
  [['#4ccf7a', -5.5], ['#f3c53f', 0], ['#ef5350', 5.5]].forEach(([c, dx]) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(dx, 0, 2.4, 0, Math.PI * 2); ctx.fill(); });
  ctx.restore();
}
function labels(ctx, v, runs, junctions, taken) {   // runs = [{road, pts}]（区間ごと）
  const mpp = v.mpp;
  const free = (r) => { for (const t of taken) if (r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1]) return false; taken.push(r); return true; };
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // 交差点名
  if (mpp < ICON_MPP) {
    ctx.font = `600 11px ${FONT}`;
    for (const n of junctions) {
      if (!n.name) continue;
      const [x, y] = v.toScreen(n.x, n.z);
      const w = ctx.measureText(n.name).width + 12;
      const box = [x - w / 2, y + 10, x + w / 2, y + 30];
      if (!free(box)) continue;
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#8a929c'; ctx.lineWidth = 1;
      roundRect(ctx, box[0], box[1], w, 20, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#2b3138'; ctx.fillText(n.name, x, y + 20.5);
    }
  }
  // 道路名（道路の向きに沿って）
  ctx.font = `500 12px ${FONT}`;
  const byRoad = new Map();
  // 道路ごとに、画面上でいちばん長い区間の真ん中に名前を置く（交差点の上を避ける）
  for (const r of runs) {
    if (!r.road.name) continue;
    const lim = r.road.color === 'orange' ? 40 : r.road.color === 'yellow' ? 12 : 3;
    if (mpp > lim) continue;
    const prev = byRoad.get(r.road.id);
    const len = screenLen(v, r.pts);
    if (!prev || len > prev.len) byRoad.set(r.road.id, { r, len });
  }
  for (const { r, len } of byRoad.values()) {
    const tw = ctx.measureText(r.road.name).width;
    if (len < tw + 30) continue;
    const m = midpoint(v, r.pts);
    if (!m || m.x < 0 || m.y < 0 || m.x > v.w || m.y > v.h) continue;
    let ang = m.ang; if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
    const box = [m.x - tw / 2 - 4, m.y - 9, m.x + tw / 2 + 4, m.y + 9];
    if (!free(box)) continue;
    ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(ang);
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.strokeText(r.road.name, 0, 0);
    ctx.fillStyle = '#3a424b'; ctx.fillText(r.road.name, 0, 0);
    ctx.restore();
  }
}
function screenLen(v, pts) { let L = 0; for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); return L * v.scale; }
function midpoint(v, pts) {
  const S = pts.map(([x, z]) => v.toScreen(x, z));
  let L = 0; for (let k = 1; k < S.length; k++) L += Math.hypot(S[k][0] - S[k - 1][0], S[k][1] - S[k - 1][1]);
  let d = L / 2;
  for (let k = 1; k < S.length; k++) {
    const s = Math.hypot(S[k][0] - S[k - 1][0], S[k][1] - S[k - 1][1]);
    if (d <= s && s > 0) { const t = d / s; return { x: S[k - 1][0] + (S[k][0] - S[k - 1][0]) * t, y: S[k - 1][1] + (S[k][1] - S[k - 1][1]) * t, ang: Math.atan2(S[k][1] - S[k - 1][1], S[k][0] - S[k - 1][0]) }; }
    d -= s;
  }
  return null;
}
function junctionColor(F, id, getNode) {
  let best = 'white', p = -1;
  for (const rid of F.roadsOf(id)) { const r = F.get(rid); const q = PRIORITY[r?.color] ?? 1; if (q > p) { p = q; best = r.color; } }
  return ROAD_COLORS[best]?.fill || '#fff';
}
function darken(hex = '#ffffff') {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.round(c * 0.86);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
