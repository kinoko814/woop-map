// =============================================================
// 編集モード：建物・範囲（IC/JCT・公園・森・山・空港）・駅・施設・空港
// =============================================================
import { h, icon, toast, ask } from './dom.js';
import { newId } from '../engine/features.js';
import { inPoly, centroid } from '../engine/roads.js';
import { AREA_TYPES, BUILDING_TYPES, viewSpan } from '../engine/shapes.js';
import { ICONS, ICON_KEYS, iconSvg } from '../engine/icons.js';
import { RAIL_TYPES, railColor } from '../engine/rails.js';
import { fmtDist } from '../engine/view.js';
import { DAY_NAMES, defaultHours } from '../hours.js';
import { reviewSection } from './reviews.js';
import { SNAP, setSnap, snapActive, gridPt, angleSnap, withPerp, drawGuide } from './snap.js';

const HANDLE = 9;
const round1 = (v) => Math.round(v * 10) / 10;

export function createShapeTools({ view, F, session, layer, refreshPanel, store, roadTools }) {
  let selId = null;
  let tool = null;              // いま使っているツール名
  let drag = null;              // 頂点・全体の移動
  let make = null;              // 新しく作っている図形
  let exitMode = false;         // 駅の出口を置くモード
  const bst = { mode: 'rect', type: 'house' };
  const ast = { mode: 'lasso', type: 'park' };
  const sst = { width: 24 };
  const pst = { icon: 'conv' };
  const apst = { sub: 'area' };

  let shiftKey = false;
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftKey = true; });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftKey = false; });
  /** 図形を中心 c のまわりに deg 度回す（出口も一緒に） */
  function rotateShape(f, c, deg) {
    const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const rot = ([x, z]) => [round1(c[0] + (x - c[0]) * cos - (z - c[1]) * sin), round1(c[1] + (x - c[0]) * sin + (z - c[1]) * cos)];
    f.poly = f.poly.map(rot);
    if (f.exits) f.exits = f.exits.map((e) => { const [x, z] = rot([e.x, e.z]); return { ...e, x, z }; });
  }
  const rotateBy = (id, deg) => patch(id, (g) => rotateShape(g, centroid(g.poly), deg));
  const select = (id) => { selId = id; layer.selected = id; exitMode = false; refreshPanel(); view.requestDraw(); };
  const commit = (changes) => { session.commitFeatures(changes); refreshPanel(); view.requestDraw(); };
  const save = (f) => commit([{ id: f.id, after: f }]);
  const patch = (id, fn) => { const f = structuredClone(F.get(id)); if (!f) return; fn(f); save(f); };
  const sel = () => (selId ? F.get(selId) : null);
  const scr = (x, z) => view.toScreen(x, z);

  // ---------- スナップ ----------
  let sguide = null, sguideAt = null;
  /** 近くの道路・線路の向き（建物を道路に平行にそろえるため） */
  function nearLineDir(w, px = 60) {
    let best = null;
    for (const r of F.items.values()) {
      if (r.kind !== 'road' && r.kind !== 'rail' && r.kind !== 'river') continue;
      const g = layer.geom.get(r);
      if (g.bbox[0] > w[0] + px * view.mpp || g.bbox[2] < w[0] - px * view.mpp || g.bbox[1] > w[1] + px * view.mpp || g.bbox[3] < w[1] - px * view.mpp) continue;
      for (const pts of g.segs) for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz; if (!L2) continue;
        let t = ((w[0] - ax) * dx + (w[1] - az) * dz) / L2; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(ax + dx * t - w[0], az + dz * t - w[1]);
        if (d * view.scale <= px && (!best || d < best.d)) { const L = Math.sqrt(L2); best = { d, dir: [dx / L, dz / L] }; }
      }
    }
    return best?.dir || null;
  }
  /**
   * 点の位置を決める。pts = それまでに置いた点（多角形の作成中）
   * 縦横・直前の辺に直角/まっすぐ・近くの道路に平行 にそろえ、そろわなければ1マスに吸着
   */
  function snapPt(w, pts = []) {
    sguide = null; sguideAt = null;
    if (!snapActive()) return w;
    const O = pts[pts.length - 1];
    if (O) {
      const dirs = [...withPerp([1, 0], '縦横')];
      const P = pts[pts.length - 2];
      if (P) { const dx = O[0] - P[0], dz = O[1] - P[1], L = Math.hypot(dx, dz); if (L) dirs.push(...withPerp([dx / L, dz / L], '直進')); }
      const nd = nearLineDir(w); if (nd) dirs.push(...withPerp(nd, '平行'));
      const a = angleSnap(O, w, dirs, view.scale);
      if (a) { sguide = a.guide; sguideAt = a.w; return alignTo(a.w, pts); }
    }
    return alignTo(gridPt(w), pts);
  }
  /** ほかの頂点（最初の点など）と縦か横の位置がほぼ同じなら、ぴったりそろえる（長方形を閉じやすく） */
  function alignTo(q, pts) {
    const tol = 8 / view.scale;
    let [x, z] = q;
    for (const pt of pts.slice(0, -1)) {
      if (!pt) continue;
      if (Math.abs(pt[0] - x) < tol) x = pt[0];
      if (Math.abs(pt[1] - z) < tol) z = pt[1];
    }
    return [x, z];
  }
  const snapMove = (dx, dz) => (snapActive() ? [Math.round(dx), Math.round(dz)] : [dx, dz]);

  // ---------- 図形の頂点編集（建物・範囲・駅で共通） ----------
  /** 回転ハンドルの画面位置（図形の上側） */
  function rotateHandle(f) {
    const [cx, cz] = centroid(f.poly);
    const [sx] = scr(cx, cz);
    let top = Infinity; for (const pt of f.poly) top = Math.min(top, scr(...pt)[1]);
    return [sx, top - 26];
  }
  function polyHandleAt(f, p) {
    if (!f?.poly) return null;
    const [rx, ry] = rotateHandle(f);
    if (Math.hypot(rx - p[0], ry - p[1]) < 10) return { rotate: true };
    for (let i = 0; i < f.poly.length; i++) {
      const [x, y] = scr(...f.poly[i]);
      if (Math.hypot(x - p[0], y - p[1]) < HANDLE) return { vertex: i };
    }
    for (let i = 0; i < f.poly.length; i++) {
      const a = f.poly[i], b = f.poly[(i + 1) % f.poly.length];
      const [x, y] = scr((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      const [ax, ay] = scr(...a), [bx, by] = scr(...b);
      if (Math.hypot(bx - ax, by - ay) > 30 && Math.hypot(x - p[0], y - p[1]) < HANDLE) return { insert: i };
    }
    return null;
  }
  function startPolyDrag(f, p, w) {
    const hnd = polyHandleAt(f, p);
    if (hnd?.rotate) { const c = centroid(f.poly); drag = { id: f.id, rotate: true, c, a0: Math.atan2(w[1] - c[1], w[0] - c[0]), w0: w, orig: structuredClone(f) }; return true; }
    if (hnd?.vertex !== undefined) { drag = { id: f.id, vertex: hnd.vertex, w0: w, orig: structuredClone(f) }; return true; }
    if (hnd?.insert !== undefined) {
      const c = structuredClone(f); const a = c.poly[hnd.insert], b = c.poly[(hnd.insert + 1) % c.poly.length];
      c.poly.splice(hnd.insert + 1, 0, [round1((a[0] + b[0]) / 2), round1((a[1] + b[1]) / 2)]);
      drag = { id: f.id, vertex: hnd.insert + 1, w0: w, orig: c, inserted: true };
      layer.shapeOverride = new Map([[f.id, c]]);
      return true;
    }
    if (f.poly && inPoly(f.poly, w[0], w[1])) { drag = { id: f.id, whole: true, w0: w, orig: structuredClone(f) }; return true; }
    return false;
  }
  function moveDrag(w) {
    const c = structuredClone(drag.orig);
    const dx = w[0] - drag.w0[0], dz = w[1] - drag.w0[1];
    if (drag.rotate) {
      let deg = ((Math.atan2(w[1] - drag.c[1], w[0] - drag.c[0]) - drag.a0) * 180) / Math.PI;
      if (shiftKey) deg = Math.round(deg / 15) * 15;   // Shift で 15° ずつ
      rotateShape(c, drag.c, deg);
      drag.deg = deg; drag.moved = true;
      layer.shapeOverride = new Map([[drag.id, c]]); drag.cur = c; view.requestDraw();
      return;
    }
    if (drag.vertex !== undefined) {
      // 隣の頂点に対して縦横・直角にそろえる
      const n = c.poly.length, prev = c.poly[(drag.vertex - 1 + n) % n], prev2 = c.poly[(drag.vertex - 2 + n) % n];
      const q = snapPt(w, [prev2, prev]);
      c.poly[drag.vertex] = [round1(q[0]), round1(q[1])];
    } else if (drag.whole) {
      // 全体の移動は1マス単位（形はそのまま）
      const [mx, mz] = snapMove(dx, dz);
      if (c.poly) c.poly = c.poly.map(([x, z]) => [round1(x + mx), round1(z + mz)]);
      if (c.exits) c.exits = c.exits.map((e) => ({ ...e, x: round1(e.x + mx), z: round1(e.z + mz) }));
      if (c.x !== undefined) { const q = snapActive() ? gridPt([c.x + dx, c.z + dz]) : [c.x + dx, c.z + dz]; c.x = round1(q[0]); c.z = round1(q[1]); }
    }
    drag.moved = drag.moved || Math.hypot(dx, dz) * view.scale > 3;
    layer.shapeOverride = new Map([[drag.id, c]]);
    drag.cur = c;
    view.requestDraw();
  }
  function endDrag() {
    const d = drag; drag = null; layer.shapeOverride = null; sguide = null;
    if (d.moved || d.inserted) save(d.cur || d.orig);
    else view.requestDraw();
  }
  function deleteVertex(f, i) {
    if (f.poly.length <= 3) return toast('頂点は3つ以上必要です');
    const c = structuredClone(f); c.poly.splice(i, 1); save(c);
  }

  // ---------- 下書き（作成中の図形）の描画 ----------
  function rectPoly(a, b) { return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]].map(([x, z]) => [round1(x), round1(z)]); }
  function circlePoly(c, r) { const n = Math.max(16, Math.min(48, Math.round(r / 2))); return Array.from({ length: n }, (_, i) => [round1(c[0] + Math.cos((i / n) * Math.PI * 2) * r), round1(c[1] + Math.sin((i / n) * Math.PI * 2) * r)]); }
  /** 線路に沿った長方形（A→B の向き、幅 W） */
  function stripPoly(a, b, W) {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
    const nx = (-dz / L) * (W / 2), nz = (dx / L) * (W / 2);
    return [[a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz]].map(([x, z]) => [round1(x), round1(z)]);
  }
  function nearestRailPoint(w, maxPx = 30) {
    let best = null;
    for (const r of F.ofKind('rail')) {
      const g = layer.geom.get(r);
      for (const pts of g.segs) for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
        let t = L2 ? ((w[0] - ax) * dx + (w[1] - az) * dz) / L2 : 0; t = Math.max(0, Math.min(1, t));
        const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - w[0], pz - w[1]);
        if (!best || d < best.d) best = { d, x: px, z: pz, rail: r };
      }
    }
    return best && best.d * view.scale <= maxPx ? best : null;
  }
  /** 線路までの距離 (m) */
  function distToLine(r, x, z) {
    let best = Infinity;
    for (const pts of layer.geom.get(r).segs) for (let k = 0; k < pts.length - 1; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
      let t = L2 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0; t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
    }
    return best;
  }
  /** 駅の範囲を通る線路 */
  function railsThrough(poly) {
    const out = [];
    for (const r of F.ofKind('rail')) {
      const g = layer.geom.get(r);
      const hit = g.segs.some((pts) => pts.some((p, k) => {
        if (inPoly(poly, p[0], p[1])) return true;
        const q = pts[k + 1]; if (!q) return false;
        const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 4);
        for (let i = 1; i < n; i++) if (inPoly(poly, p[0] + ((q[0] - p[0]) * i) / n, p[1] + ((q[1] - p[1]) * i) / n)) return true;
        return false;
      }));
      if (hit) out.push(r.id);
    }
    return out;
  }

  // ---------- ツール共通の骨組み ----------
  function hitShape(kind, w) {
    const list = [...F.ofKind(kind)].filter((f) => f.poly && inPoly(f.poly, w[0], w[1]));
    if (!list.length) return null;
    // 小さいものを優先（大きな範囲の中の小さな建物などを選びやすく）
    list.sort((a, b) => polyArea(a.poly) - polyArea(b.poly));
    return list[0];
  }
  function makeTool(kind, { onDown, onMove, onUp, onKey, cursor = 'crosshair' }) {
    return {
      cursor,
      down(w, e, p) {
        const f = sel();
        if (f && f.kind === kind && f.poly && !exitMode && startPolyDrag(f, p, w)) return;
        if (f && f.kind === kind && f.x !== undefined && !exitMode) {
          const [x, y] = scr(f.x, f.z);
          if (Math.hypot(x - p[0], y - p[1]) < 14) { drag = { id: f.id, whole: true, w0: w, orig: structuredClone(f) }; return; }
        }
        onDown(w, e, p);
      },
      move(w, e, p) { if (drag) return moveDrag(w); onMove?.(w, e, p); },
      up(w, e, p) { if (drag) return endDrag(); onUp?.(w, e, p); },
      hover(w, e, p) {
        const f = sel();
        let cur = cursor;
        if (f?.poly) { const hnd = polyHandleAt(f, p); if (hnd) cur = hnd.vertex !== undefined ? 'grab' : 'copy'; else if (inPoly(f.poly, w[0], w[1])) cur = 'move'; }
        view.canvas.style.cursor = exitMode ? 'crosshair' : cur;
        if (make?.hover) { make.cursor = snapPt(w, make.pts); syncDraft(); }
      },
      activate() { tool = kind; },
      deactivate() { make = null; layer.shapeDraft = null; drag = null; layer.shapeOverride = null; exitMode = false; select(null); },
      key(e) {
        if (onKey?.(e)) return true;
        if (e.key === 'Escape') { if (make) { make = null; layer.shapeDraft = null; view.requestDraw(); refreshPanel(); return true; } if (selId) { select(null); return true; } }
        if ((e.key === 'Delete' || e.key === 'Backspace') && selId && !make) { removeSelected(); return true; }
        return false;
      },
    };
  }
  async function removeSelected() {
    const f = sel(); if (!f) return;
    const changes = [{ id: f.id, after: null }];
    // 乗換の相手からも外す
    if (f.kind === 'station') for (const t of f.transfers || []) { const o = F.get(t); if (o) changes.push({ id: t, after: { ...o, transfers: (o.transfers || []).filter((x) => x !== f.id) } }); }
    commit(changes); select(null);
  }
  function syncDraft() {
    if (!make) { layer.shapeDraft = null; view.requestDraw(); return; }
    let poly = null;
    if (make.type === 'rect' && make.b) poly = rectPoly(make.a, make.b);
    else if (make.type === 'circle' && make.b) poly = circlePoly(make.a, Math.hypot(make.b[0] - make.a[0], make.b[1] - make.a[1]));
    else if (make.type === 'strip' && make.b) poly = stripPoly(make.a, make.b, sst.width);
    else if (make.type === 'lasso') poly = make.pts;
    else if (make.type === 'poly') poly = make.cursor ? [...make.pts, make.cursor] : make.pts;
    layer.shapeDraft = poly && poly.length >= 2 ? { id: '__draft__', kind: make.kind, type: make.ftype, poly, rails: make.rails || [] } : null;
    view.requestDraw();
  }

  // 多角形（クリックで頂点を置く）作成
  function polyClick(kind, ftype, w, p, finish) {
    if (!make) { const q = snapPt(w); make = { type: 'poly', kind, ftype, pts: [[round1(q[0]), round1(q[1])]], hover: true, cursor: q, finish }; refreshPanel(); syncDraft(); return; }
    const [fx, fy] = scr(...make.pts[0]);
    if (make.pts.length >= 3 && Math.hypot(fx - p[0], fy - p[1]) < 12) return finishPoly();
    const last = make.pts[make.pts.length - 1]; const [lx, ly] = scr(...last);
    if (Math.hypot(lx - p[0], ly - p[1]) < 6) return finishPoly();
    const q = snapPt(w, make.pts);
    make.pts.push([round1(q[0]), round1(q[1])]); sguide = null; syncDraft();
  }
  function finishPoly() {
    if (!make || make.type !== 'poly') return;
    const m = make; make = null; layer.shapeDraft = null;
    if (m.pts.length < 3) { refreshPanel(); view.requestDraw(); return; }
    m.finish(m.pts);
  }
  const polyKey = (e) => {
    if (make?.type !== 'poly') return false;
    if (e.key === 'Enter') { finishPoly(); return true; }
    if (e.key === 'Backspace') { make.pts.pop(); if (!make.pts.length) { make = null; refreshPanel(); } syncDraft(); return true; }
    return false;
  };
  // ドラッグ・クリックの見分け（何もない所をドラッグしたら地図を動かす）
  function panOrClick(p, onClick) {
    return { p, x: view.x, z: view.z, moved: false, onClick };
  }
  let press = null;
  const pressMove = (p) => {
    if (!press) return;
    if (!press.moved && Math.hypot(p[0] - press.p[0], p[1] - press.p[1]) > 4) press.moved = true;
    if (press.moved) view.setView(press.x - (p[0] - press.p[0]) / view.scale, press.z - (p[1] - press.p[1]) / view.scale);
  };
  const pressUp = (w, p) => { const pr = press; press = null; if (pr && !pr.moved) pr.onClick(w, p); };

  // ---------- 建物 ----------
  const building = makeTool('building', {
    onDown(w, e, p) {
      if (make?.type === 'poly') { press = panOrClick(p, (w2, p2) => polyClick('building', bst.type, w2, p2, createBuilding)); return; }
      const hit = hitShape('building', w);
      if (hit) { select(hit.id); return; }
      if (selId) { select(null); return; }
      if (bst.mode === 'poly') { press = panOrClick(p, (w2, p2) => polyClick('building', bst.type, w2, p2, createBuilding)); return; }
      make = { type: bst.mode, kind: 'building', ftype: bst.type, a: snapPt(w), b: null };
    },
    onMove(w, e, p) { if (press) return pressMove(p); if (make && make.type !== 'poly') { make.b = snapPt(w); syncDraft(); } },
    onUp(w, e, p) {
      if (press) return pressUp(w, p);
      if (!make || make.type === 'poly') return;
      const m = make; make = null; layer.shapeDraft = null;
      if (!m.b) { view.requestDraw(); return; }
      const poly = m.type === 'rect' ? rectPoly(m.a, m.b) : circlePoly(m.a, Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]));
      if (polyArea(poly) < 4) { view.requestDraw(); return; }
      createBuilding(poly);
    },
    onKey: polyKey,
  });
  function createBuilding(poly) {
    const f = { id: newId(), kind: 'building', type: bst.type, name: '', poly };
    commit([{ id: f.id, after: f }]); select(f.id);
  }

  // ---------- 範囲（IC/JCT・公園・森・山・空港） ----------
  function areaToolFor(getType, getMode) {
    return makeTool('area', {
      onDown(w, e, p) {
        if (make?.type === 'poly') { press = panOrClick(p, (w2, p2) => polyClick('area', getType(), w2, p2, (pts) => createArea(pts, getType()))); return; }
        const hit = hitShape('area', w);
        if (hit && (!selId || hit.id !== selId)) { press = panOrClick(p, () => select(hit.id)); if (getMode() === 'poly') return; }
        if (selId && !hit) { select(null); return; }
        if (getMode() === 'poly') { press = panOrClick(p, (w2, p2) => polyClick('area', getType(), w2, p2, (pts) => createArea(pts, getType()))); return; }
        // 投げ縄：ドラッグで囲む（クリックだけなら選択）
        make = { type: 'lasso', kind: 'area', ftype: getType(), pts: [[round1(w[0]), round1(w[1])]], sp: [p], hit };
      },
      onMove(w, e, p) {
        if (press && getMode() === 'poly') return pressMove(p);
        if (make?.type === 'lasso') {
          const last = make.sp[make.sp.length - 1];
          if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 5) { make.pts.push([round1(w[0]), round1(w[1])]); make.sp.push(p); press = null; syncDraft(); }
        }
      },
      onUp(w, e, p) {
        if (press) return pressUp(w, p);
        if (make?.type !== 'lasso') return;
        const m = make; make = null; layer.shapeDraft = null;
        if (m.pts.length >= 6) createArea(m.pts, getType());
        else if (m.hit) select(m.hit.id);
        else view.requestDraw();
      },
      onKey: polyKey,
    });
  }
  const area = areaToolFor(() => ast.type, () => ast.mode);
  function createArea(pts, type) {
    const f = { id: newId(), kind: 'area', type, name: '', desc: '', poly: pts };
    commit([{ id: f.id, after: f }]); select(f.id);
    setTimeout(() => document.getElementById('area-name')?.focus(), 30);
  }

  // ---------- 駅 ----------
  const station = makeTool('station', {
    onDown(w, e, p) {
      if (exitMode && selId) {
        const st = sel();
        const nums = (st.exits || []).map((x) => parseInt(x.label, 10)).filter(Number.isFinite);
        const label = String(nums.length ? Math.max(...nums) + 1 : 1);
        patch(st.id, (f) => { (f.exits ||= []).push({ id: newId().slice(0, 8), x: round1(w[0]), z: round1(w[1]), label }); });
        return;
      }
      const mark = (layer.hits?.stations || []).find((s) => p[0] >= s.box[0] && p[0] <= s.box[2] && p[1] >= s.box[1] && p[1] <= s.box[3]);
      const hit = mark ? F.get(mark.id) : hitShape('station', w);
      if (hit) { select(hit.id); return; }
      if (selId) { select(null); return; }
      const snap = nearestRailPoint(w);
      make = { type: 'strip', kind: 'station', a: snap ? [snap.x, snap.z] : snapPt(w), b: null, rails: snap ? [snap.rail.id] : [] };
    },
    onMove(w) {
      if (make?.type !== 'strip') return;
      const snap = nearestRailPoint(w);
      make.b = snap ? [snap.x, snap.z] : snapPt(w, [make.a]); syncDraft();
    },
    onUp() {
      if (make?.type !== 'strip') return;
      const m = make; make = null; layer.shapeDraft = null; sguide = null;
      if (!m.b || Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]) < 8) { view.requestDraw(); if (!m.b) toast('線路に沿ってドラッグすると駅ができます'); return; }
      const poly = stripPoly(m.a, m.b, sst.width);
      // 線路が重なっていても自動で乗換駅にはしない：ドラッグを始めた線路（なければ通っている線路のうち一番近いもの）だけ
      const through = railsThrough(poly);
      const [pcx, pcz] = centroid(poly);
      const rails = m.rails.length ? [m.rails[0]] : through.length ? [through.map((id) => ({ id, d: distToLine(F.get(id), pcx, pcz) })).sort((p2, q2) => p2.d - q2.d)[0].id] : [];
      const f = { id: newId(), kind: 'station', name: '', rails, poly, desc: '', address: '', phone: '', exits: [], transfers: [] };
      commit([{ id: f.id, after: f }]); select(f.id);
      setTimeout(() => document.getElementById('st-name')?.focus(), 30);
    },
    onKey(e) { if (e.key === 'Escape' && exitMode) { exitMode = false; refreshPanel(); return true; } return false; },
  });

  // ---------- 施設 ----------
  const poi = makeTool('poi', {
    cursor: 'copy',
    onDown(w, e, p) {
      const hit = (layer.hits?.pois || []).find((q) => Math.hypot(q.x - p[0], q.y - p[1]) <= q.r);
      if (hit) { select(hit.id); drag = { id: hit.id, whole: true, w0: w, orig: structuredClone(F.get(hit.id)) }; return; }
      press = panOrClick(p, (w2) => {
        if (selId) { select(null); return; }
        const q = snapActive() ? gridPt(w2) : w2;
        const f = { id: newId(), kind: 'poi', icon: pst.icon, name: '', desc: '', info: '', address: '', phone: '', x: round1(q[0]), z: round1(q[1]) };
        commit([{ id: f.id, after: f }]); select(f.id);
        setTimeout(() => document.getElementById('poi-name')?.focus(), 30);
      });
    },
    onMove(w, e, p) { pressMove(p); },
    onUp(w, e, p) { pressUp(w, p); },
  });

  // ---------- 空港（範囲・滑走路・誘導路・建物・道路を切り替え） ----------
  const airportArea = areaToolFor(() => 'airport', () => 'poly');
  const subTools = () => ({ area: airportArea, runway: roadTools.roadTool, taxiway: roadTools.roadTool, road: roadTools.roadTool, building });
  const airport = {
    get cursor() { return subTools()[apst.sub].cursor; },
    down: (...a) => subTools()[apst.sub].down?.(...a),
    move: (...a) => subTools()[apst.sub].move?.(...a),
    up: (...a) => subTools()[apst.sub].up?.(...a),
    hover: (...a) => subTools()[apst.sub].hover?.(...a),
    key: (e) => subTools()[apst.sub].key?.(e),
    activate() { tool = 'airport'; setAirportSub(apst.sub, true); },
    deactivate() { subTools()[apst.sub].deactivate?.(); },
  };
  function setAirportSub(sub, initial = false) {
    if (!initial) subTools()[apst.sub].deactivate?.();
    apst.sub = sub;
    if (sub === 'runway' || sub === 'taxiway') roadTools.preset(sub);
    if (sub === 'road') roadTools.preset('normal');
    if (sub === 'building') { bst.type = 'public'; bst.mode = 'poly'; }
    tool = 'airport';
    refreshPanel(); view.requestDraw();
  }

  // ---------- 表示用（頂点ハンドル・出口モード） ----------
  const overlay = {
    draw(ctx, v) {
      const f = layer.shapeOverride?.get(selId) || sel();
      ctx.save();
      if (f?.poly && ['building', 'area', 'station'].includes(f.kind)) {
        ctx.strokeStyle = '#1f7c6f'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
        ctx.beginPath(); f.poly.forEach(([x, z], i) => { const [sx, sy] = v.toScreen(x, z); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); ctx.closePath(); ctx.stroke();
        ctx.setLineDash([]);
        f.poly.forEach((pt, i) => {
          const a = pt, b = f.poly[(i + 1) % f.poly.length];
          const [ax, ay] = v.toScreen(...a), [bx, by] = v.toScreen(...b);
          if (Math.hypot(bx - ax, by - ay) > 30) {
            const mx = (ax + bx) / 2, my = (ay + by) / 2;
            ctx.beginPath(); ctx.arc(mx, my, 5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#2fa392'; ctx.lineWidth = 1.4; ctx.stroke();
            ctx.beginPath(); ctx.moveTo(mx - 2.5, my); ctx.lineTo(mx + 2.5, my); ctx.moveTo(mx, my - 2.5); ctx.lineTo(mx, my + 2.5); ctx.stroke();
          }
          ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1f7c6f'; ctx.lineWidth = 2;
          ctx.fillRect(ax - 4.5, ay - 4.5, 9, 9); ctx.strokeRect(ax - 4.5, ay - 4.5, 9, 9);
        });
        // 回転ハンドル
        const [rx, ry] = rotateHandle(f);
        const [cx0, cy0] = v.toScreen(...centroid(f.poly));
        ctx.strokeStyle = '#1f7c6f'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(rx, ry + 8); ctx.lineTo(rx, Math.min(cy0, ry + 26)); ctx.stroke();
        ctx.beginPath(); ctx.arc(rx, ry, 8, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(rx, ry, 4, -Math.PI * 0.9, Math.PI * 0.55); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(rx - 1, ry + 4.8); ctx.lineTo(rx - 4.5, ry + 2.6); ctx.lineTo(rx - 1.2, ry + 1); ctx.stroke();
        if (drag?.rotate && drag.deg !== undefined) {
          const t = `${Math.round(drag.deg)}°`;
          ctx.font = '700 12px system-ui'; ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.strokeText(t, rx + 14, ry + 4); ctx.fillStyle = '#1f7c6f'; ctx.fillText(t, rx + 14, ry + 4);
        }
      }
      if (sguide && (make || drag)) drawGuide(ctx, v, sguide, sguideAt);
      if (make?.type === 'poly' && make.pts.length) {
        const [x, y] = v.toScreen(...make.pts[0]);
        ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.strokeStyle = '#1f7c6f'; ctx.lineWidth = 2; ctx.stroke();
      }
      if (make?.type === 'strip' && make.b) {
        const [x, y] = v.toScreen(...make.b);
        const t = `長さ ${fmtDist(Math.hypot(make.b[0] - make.a[0], make.b[1] - make.a[1]))}`;
        ctx.font = '600 11px system-ui'; ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.strokeText(t, x + 12, y + 16); ctx.fillStyle = '#1e2329'; ctx.fillText(t, x + 12, y + 16);
      }
      ctx.restore();
    },
  };

  // ---------- パネル ----------
  function seg(options, value, onPick) {
    return h('div', { class: 'seg' }, ...options.map(([label, v]) => h('button', { class: value === v ? 'on' : '', onclick: () => onPick(v) }, label)));
  }
  const field = (id, label, input) => h('div', { class: 'row' }, h('label', { class: 'lbl', for: id }, label), input);
  const text = (id, value, ph, onSet, rows) => rows
    ? h('textarea', { id, rows, placeholder: ph, onchange: (e) => onSet(e.target.value.trim()) }, value || '')
    : h('input', { type: 'text', id, value: value || '', placeholder: ph, onchange: (e) => onSet(e.target.value.trim()) });
  function photoField(f) {
    const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onchange: async () => {
      const x = file.files[0]; if (!x) return;
      toast('写真をアップロード中…', 0);
      try { const url = await store.uploadPhoto(x); patch(f.id, (g) => { g.photo = url; }); toast('写真を追加しました'); } catch (e) { console.error(e); toast('写真をアップロードできませんでした'); }
    } });
    return h('div', { class: 'row' }, h('label', { class: 'lbl' }, '写真（任意）'),
      f.photo ? h('img', { src: f.photo, alt: '', class: 'photo-prev' }) : null,
      h('div', { class: 'btn-row', style: { marginTop: f.photo ? '6px' : 0 } },
        h('button', { class: 'btn', onclick: () => file.click() }, icon('upload'), f.photo ? '写真を変更' : '写真を追加'),
        f.photo ? h('button', { class: 'btn', onclick: () => patch(f.id, (g) => { delete g.photo; }) }, '外す') : null, file));
  }
  // 営業時間
  function hoursField(f) {
    const hrs = f.hours || { mode: 'none' };
    const set = (fn) => patch(f.id, (g) => { g.hours = structuredClone(g.hours || defaultHours()); fn(g.hours); });
    const parts = [seg([['設定しない', 'none'], ['24時間', '24h'], ['曜日ごと', 'week']], hrs.mode || 'none', (m) => patch(f.id, (g) => {
      g.hours = m === 'week' ? { ...defaultHours(), ...(g.hours?.days ? { days: g.hours.days } : {}), note: g.hours?.note || '', mode: 'week' } : { ...(g.hours || {}), mode: m };
    }))];
    if (hrs.mode === 'week') {
      parts.push(h('div', { class: 'hours' }, ...DAY_NAMES.map((n, i) => {
        const d = hrs.days?.[i];
        return h('div', { class: 'hours-row' },
          h('label', { class: 'check', style: { padding: 0 } }, h('input', { type: 'checkbox', checked: !!d, onchange: (e) => set((H) => { H.days[i] = e.target.checked ? (H.days.find(Boolean) || ['09:00', '18:00']).slice() : null; }) }), n),
          d ? h('input', { type: 'time', value: d[0], 'aria-label': `${n}曜 開店`, onchange: (e) => set((H) => { H.days[i][0] = e.target.value || '09:00'; }) }) : h('span', { class: 'muted' }, '定休日'),
          d ? h('span', { class: 'muted' }, '〜') : null,
          d ? h('input', { type: 'time', value: d[1], 'aria-label': `${n}曜 閉店`, onchange: (e) => set((H) => { H.days[i][1] = e.target.value || '18:00'; }) }) : null);
      })),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => set((H) => { const m = H.days[0]; H.days = H.days.map((d) => (d ? (m || d).slice() : null)); }) }, '月曜の時間を営業日すべてに')),
      h('div', { class: 'muted' }, '閉店が開店より早い時刻なら、日をまたぐ営業（例 18:00〜02:00）になります。'));
    }
    if (hrs.mode && hrs.mode !== 'none') parts.push(text('poi-hnote', hrs.note, '補足（例：祝日は休み・ラストオーダー 21:30）', (v) => set((H) => { H.note = v; })));
    return h('div', { class: 'row' }, h('label', { class: 'lbl' }, '営業時間'), ...parts);
  }
  // リンク（任意・複数）
  function linksField(f) {
    const links = f.links || [];
    const norm = (u) => { u = u.trim(); if (!u) return ''; return /^https?:\/\//i.test(u) ? u : `https://${u}`; };
    return h('div', { class: 'row' }, h('label', { class: 'lbl' }, 'リンク（任意）'),
      h('div', { class: 'link-list' }, ...links.map((l, i) => h('div', { class: 'link-item' },
        h('input', { type: 'text', value: l.label || '', placeholder: '表示名（例：公式サイト）', 'aria-label': 'リンクの表示名', onchange: (e) => patch(f.id, (g) => { g.links[i].label = e.target.value.trim(); }) }),
        h('input', { type: 'url', value: l.url || '', placeholder: 'https://…', 'aria-label': 'URL', onchange: (e) => patch(f.id, (g) => { g.links[i].url = norm(e.target.value); }) }),
        h('button', { class: 'icon-btn', title: 'このリンクを削除', onclick: () => patch(f.id, (g) => { g.links.splice(i, 1); }) }, icon('trash'))))),
      h('button', { class: 'btn', style: { marginTop: '6px' }, onclick: () => patch(f.id, (g) => { (g.links ||= []).push({ label: '', url: '' }); }) }, '＋ リンクを追加'));
  }
  const delBtn = (label) => h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onclick: async () => { if (await ask(`この${label}を削除しますか？`, '削除')) removeSelected(); } }, icon('trash'), `${label}を削除`));
  const vertexHint = h('div', { class: 'muted', style: { marginTop: '8px' } }, '角の□をドラッグで形を変更、辺の「＋」で角を追加、上の○で回転、中をドラッグで移動。');
  const creatingPoly = () => (make?.type === 'poly' ? h('div', { class: 'hint' }, h('b', {}, `角を置いています（${make.pts.length}個）`), h('div', {}, '最初の角をクリック・Enter で完成。Backspace で1つ戻す。')) : null);

  function buildingPanel(box, { title = '建物', lockType = null } = {}) {
    const f = sel()?.kind === 'building' ? sel() : null;
    const typeRow = (value, onPick) => h('div', { class: 'type-list' }, ...Object.entries(BUILDING_TYPES).map(([k, t]) =>
      h('button', { class: `type-item ${value === k ? 'on' : ''}`, onclick: () => onPick(k) }, h('span', { class: 'bsw', style: { background: t.fill, borderColor: t.edge } }), t.label)));
    const parts = [h('h3', {}, title)];
    if (!f) {
      parts.push(creatingPoly() || h('div', { class: 'hint' }, h('div', {}, bst.mode === 'poly' ? 'クリックで角を置いて囲みます。' : bst.mode === 'circle' ? '中心からドラッグして丸い建物を作ります。' : 'ドラッグして四角い建物を作ります。'), h('div', {}, '建物は画面の幅が約2kmより広いと表示されません。')),
        h('label', { class: 'lbl' }, '形'), seg([['四角', 'rect'], ['丸', 'circle'], ['多角形', 'poly']], bst.mode, (m) => { bst.mode = m; refreshPanel(); }),
        lockType ? null : h('div', { class: 'row' }, h('label', { class: 'lbl' }, '種類'), typeRow(bst.type, (k) => { bst.type = k; refreshPanel(); })));
    } else {
      parts.push(
        field('b-name', '名前（任意）', text('b-name', f.name, '例：市役所本庁舎', (v) => patch(f.id, (g) => { g.name = v; }))),
        h('div', { class: 'row' }, h('label', { class: 'lbl' }, '種類'), typeRow(f.type, (k) => patch(f.id, (g) => { g.type = k; }))),
        h('div', { class: 'row' }, h('label', { class: 'lbl' }, '向き（上の○をドラッグでも回せます。Shift で15°ずつ）'),
          h('div', { class: 'btn-row', style: { marginTop: 0 } },
            h('button', { class: 'btn', onclick: () => rotateBy(f.id, -15) }, '↺ 15°'),
            h('button', { class: 'btn', onclick: () => rotateBy(f.id, 15) }, '↻ 15°'),
            h('button', { class: 'btn', onclick: () => rotateBy(f.id, 90) }, '↻ 90°'))),
        vertexHint, delBtn('建物'));
    }
    box.replaceChildren(...parts);
  }
  function areaPanel(box, { title = '範囲', fixedType = null } = {}) {
    const f = sel()?.kind === 'area' ? sel() : null;
    const types = fixedType ? [fixedType] : Object.keys(AREA_TYPES);
    const typeRow = (value, onPick) => h('div', { class: 'type-list' }, ...types.map((k) => h('button', { class: `type-item ${value === k ? 'on' : ''}`, onclick: () => onPick(k) },
      h('span', { class: 'bsw', style: AREA_TYPES[k].outlineOnly ? { border: `2px dashed ${k === 'jct' ? '#e08a3c' : '#2fa392'}`, background: 'transparent' } : { background: AREA_TYPES[k].fill, borderColor: AREA_TYPES[k].edge } }), AREA_TYPES[k].label)));
    const parts = [h('h3', {}, title)];
    if (!f) {
      parts.push(creatingPoly() || h('div', { class: 'hint' }, h('div', {}, (fixedType ? 'poly' : ast.mode) === 'poly' ? 'クリックで角を置いて範囲を囲みます。' : 'ドラッグして投げ縄のように範囲を囲みます。'), h('div', {}, '地図の移動は Space+ドラッグ か右ドラッグ。')));
      if (!fixedType) parts.push(h('label', { class: 'lbl' }, '囲み方'), seg([['投げ縄', 'lasso'], ['直線でクリック', 'poly']], ast.mode, (m) => { ast.mode = m; refreshPanel(); }),
        h('div', { class: 'row' }, h('label', { class: 'lbl' }, '種類'), typeRow(ast.type, (k) => { ast.type = k; refreshPanel(); })));
    } else {
      const t = AREA_TYPES[f.type];
      parts.push(
        field('area-name', t.outlineOnly ? '名前（IC / JCT は自動で付きます）' : '名前', text('area-name', f.name, f.type === 'airport' ? '例：港南空港' : f.type === 'park' ? '例：中央公園' : '', (v) => patch(f.id, (g) => { g.name = v; }))),
        fixedType ? null : h('div', { class: 'row' }, h('label', { class: 'lbl' }, '種類'), typeRow(f.type, (k) => patch(f.id, (g) => { g.type = k; }))),
        field('area-desc', '概要（表示モードでクリックすると出ます）', text('area-desc', f.desc, '例：湾岸高速と中央大通を結ぶ', (v) => patch(f.id, (g) => { g.desc = v; }), 4)),
        vertexHint, delBtn('範囲'));
    }
    box.replaceChildren(...parts);
  }
  function stationPanel(box) {
    const f = sel()?.kind === 'station' ? sel() : null;
    const parts = [h('h3', {}, '駅')];
    if (!f) {
      const wIn = h('input', { type: 'number', min: 6, max: 200, value: sst.width, style: { width: '90px' }, onchange: (e) => { sst.width = Math.max(6, Math.min(200, +e.target.value || 24)); } });
      parts.push(h('div', { class: 'hint' }, h('div', {}, '線路の上をドラッグすると、線路に沿った四角い駅ができます。'), h('div', {}, 'できた駅は角をドラッグして好きな形にできます。')),
        field('st-w', '駅の幅（メートル）', wIn));
      box.replaceChildren(...parts); return;
    }
    // 路線（近くの線路から選ぶ）
    const [cx, cz] = centroid(f.poly);
    const near = [...F.ofKind('rail')].map((r) => ({ r, d: distToLine(r, cx, cz) })).sort((a, b) => a.d - b.d).filter((x, i) => i < 8 || f.rails?.includes(x.r.id));
    const railList = h('div', { class: 'check-list' }, ...near.map(({ r, d }) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: f.rails?.includes(r.id), onchange: (e) => patch(f.id, (g) => { g.rails = e.target.checked ? [...new Set([...(g.rails || []), r.id])] : (g.rails || []).filter((x) => x !== r.id); }) }),
      h('span', { class: 'rdot', style: { background: railColor(r) } }), `${r.name || RAIL_TYPES[r.type].label}`, h('span', { class: 'muted' }, ` ${fmtDist(d)}`))));
    // 乗換駅（1.5km 以内の駅）
    const others = [...F.ofKind('station')].filter((o) => o.id !== f.id).map((o) => ({ o, d: Math.hypot(...sub(centroid(o.poly), [cx, cz])) })).filter((x) => x.d < 1500 || f.transfers?.includes(x.o.id)).sort((a, b) => a.d - b.d);
    const transfer = (o, on) => {
      const a = structuredClone(f), b = structuredClone(o);
      a.transfers = on ? [...new Set([...(a.transfers || []), o.id])] : (a.transfers || []).filter((x) => x !== o.id);
      b.transfers = on ? [...new Set([...(b.transfers || []), f.id])] : (b.transfers || []).filter((x) => x !== f.id);
      commit([{ id: a.id, after: a }, { id: b.id, after: b }]);
    };
    const tList = others.length ? h('div', { class: 'check-list' }, ...others.map(({ o, d }) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: f.transfers?.includes(o.id), onchange: (e) => transfer(o, e.target.checked) }), o.name || '名前なしの駅', h('span', { class: 'muted' }, ` ${fmtDist(d)}`))))
      : h('div', { class: 'muted' }, '1.5km 以内にほかの駅がありません。');
    const exits = h('div', { class: 'exit-list' }, ...(f.exits || []).map((ex, i) => h('div', { class: 'exit-item' },
      h('span', { class: 'exit-badge' }, ex.label),
      h('input', { type: 'text', value: ex.label, 'aria-label': '出口番号', onchange: (e) => patch(f.id, (g) => { g.exits[i].label = e.target.value.trim() || ex.label; }) }),
      h('button', { class: 'icon-btn', title: 'この出口を削除', onclick: () => patch(f.id, (g) => { g.exits.splice(i, 1); }) }, icon('trash')))));
    parts.push(
      field('st-name', '駅名', text('st-name', f.name, '例：中央', (v) => patch(f.id, (g) => { g.name = v; }))),
      h('div', { class: 'row' }, h('label', { class: 'lbl' }, '路線（近い順・ほかの路線も止まる駅ならチェック）'), near.length ? railList : h('div', { class: 'muted' }, '線路がまだありません。')),
      field('st-numbering', '駅ナンバリング', text('st-numbering', f.numbering, '例：JR-Y01、T01', (v) => patch(f.id, (g) => { g.numbering = v.trim(); }))),
      field('st-desc', '駅の概要', text('st-desc', f.desc, '例：1日の乗降客数は約5万人。北口にバスターミナル。', (v) => patch(f.id, (g) => { g.desc = v; }), 3)),
      field('st-addr', '住所（空欄なら境界から自動）', text('st-addr', f.address, layer.addr.addressText(...centroid(f.poly)) || '住所ツールで地名を付けると自動で入ります', (v) => patch(f.id, (g) => { g.address = v; }))),
      linksField(f),
      photoField(f),
      h('div', { class: 'sub' }, h('div', { class: 'sub-h' }, `出口（${(f.exits || []).length}）`), exits,
        h('button', { class: `btn ${exitMode ? 'primary' : ''}`, style: { marginTop: '6px' }, onclick: () => { exitMode = !exitMode; refreshPanel(); } }, exitMode ? '地図をクリックして出口を置く（Esc で終了）' : '＋ 出口を追加')),
      h('div', { class: 'sub' }, h('div', { class: 'sub-h' }, '乗換駅'), tList),
      vertexHint, delBtn('駅'));
    box.replaceChildren(...parts);
  }
  function poiPanel(box) {
    const f = sel()?.kind === 'poi' ? sel() : null;
    const grid = (value, onPick) => h('div', { class: 'icon-grid' }, ...ICON_KEYS.map((k) => h('button', { class: `icon-cell ${value === k ? 'on' : ''}`, title: ICONS[k].label, onclick: () => onPick(k) }, iconSvg(k, 26), h('span', {}, ICONS[k].label))));
    const parts = [h('h3', {}, '施設・名所')];
    if (!f) {
      parts.push(h('div', { class: 'hint' }, h('div', {}, 'アイコンを選んで地図をクリックすると置けます。置いた施設はドラッグで動かせます。')),
        h('label', { class: 'lbl' }, 'アイコン'), grid(pst.icon, (k) => { pst.icon = k; refreshPanel(); }));
      box.replaceChildren(...parts); return;
    }
    parts.push(
      field('poi-name', '名前（必須）', text('poi-name', f.name, '例：ウープマート 駅前店', (v) => patch(f.id, (g) => { g.name = v; }))),
      field('poi-desc', '説明', text('poi-desc', f.desc, '例：駅から徒歩2分のコンビニ', (v) => patch(f.id, (g) => { g.desc = v; }), 3)),
      field('poi-info', '必要な情報（営業時間など）', text('poi-info', f.info, '例：24時間営業・ATMあり', (v) => patch(f.id, (g) => { g.info = v; }), 2)),
      field('poi-addr', '住所（空欄なら境界から自動）', text('poi-addr', f.address, layer.addr.addressText(f.x, f.z) || '住所ツールで地名を付けると自動で入ります', (v) => patch(f.id, (g) => { g.address = v; }))),
      field('poi-tel', '電話番号', text('poi-tel', f.phone, '例：012-345-6789', (v) => patch(f.id, (g) => { g.phone = v; }))),
      hoursField(f),
      linksField(f),
      photoField(f),
      h('div', { class: 'row' }, h('label', { class: 'lbl' }, 'アイコン'), grid(f.icon, (k) => patch(f.id, (g) => { g.icon = k; }))),
      delBtn('施設'));
    box.replaceChildren(...parts);
  }
  function airportPanel(box) {
    const head = [h('h3', {}, '空港'),
      h('div', { class: 'seg air-seg' }, ...[['area', '空港の範囲'], ['runway', '滑走路'], ['taxiway', '誘導路'], ['building', '建物'], ['road', '空港内の道路']].map(([k, l]) =>
        h('button', { class: apst.sub === k ? 'on' : '', onclick: () => setAirportSub(k) }, l)))];
    const inner = h('div');
    if (apst.sub === 'area') areaPanel(inner, { title: '空港の範囲', fixedType: 'airport' });
    else if (apst.sub === 'building') buildingPanel(inner, { title: '空港の建物', lockType: 'public' });
    else roadTools.renderPanel(inner);
    // サブパネルの見出しは重複するので外す
    inner.querySelector('h3')?.remove();
    box.replaceChildren(...head, inner);
  }
  function renderPanel(box, which) {
    ({ building: buildingPanel, area: areaPanel, station: stationPanel, poi: poiPanel, airport: airportPanel })[which](box);
    if (which === 'building' || which === 'station' || which === 'poi' || (which === 'area' && ast.mode === 'poly')) box.append(snapRow());
    // 選んでいる駅・施設の口コミ（編集モードでは消せる）
    const f = sel();
    if (f && (f.kind === 'station' || f.kind === 'poi') && (which === 'station' || which === 'poi')) box.append(reviewSection(store, f.id, { canDelete: true, compose: false }));
  }
  function snapRow() {
    return h('div', { class: 'row', style: { marginTop: '12px' } },
      h('label', { class: 'check', style: { margin: 0 } }, h('input', { type: 'checkbox', checked: SNAP.on, onchange: (e) => { setSnap(e.target.checked); view.requestDraw(); } }), 'スナップ'),
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } }, '角を縦横・直角・近くの道路と平行にそろえ、1マス（1m）に吸着します。移動も1マス単位。Alt キーを押している間は一時的に切り替わります。'));
  }
  function validate() {
    if (selId && !F.get(selId)) { selId = null; layer.selected = null; return true; }
    return false;
  }
  // ---------- 選択ツールから使う ----------
  /** クリックした所にある図形。strong=アイコンや駅のマークなど、線より優先するもの */
  function hitAt(w, p) {
    const poiHit = (layer.hits?.pois || []).find((q) => Math.hypot(q.x - p[0], q.y - p[1]) <= q.r);
    if (poiHit) return { f: F.get(poiHit.id), strong: true };
    const mark = (layer.hits?.stations || []).find((q) => p[0] >= q.box[0] && p[0] <= q.box[2] && p[1] >= q.box[1] && p[1] <= q.box[3]);
    if (mark) return { f: F.get(mark.id), strong: true };
    const lab = (layer.hits?.areas || []).find((q) => p[0] >= q.box[0] && p[0] <= q.box[2] && p[1] >= q.box[1] && p[1] <= q.box[3]);
    if (lab) return { f: F.get(lab.id), strong: true };
    const span = viewSpan(view);
    const cands = [];
    for (const f of F.items.values()) {
      if (!f.poly || !['station', 'building', 'area'].includes(f.kind)) continue;
      if (f.kind === 'station' && span > 3000) continue;
      if (f.kind === 'building' && span > 2200) continue;
      if (f.kind === 'area' && !AREA_TYPES[f.type]?.outlineOnly && span > AREA_TYPES[f.type].show) continue;
      if (inPoly(f.poly, w[0], w[1])) cands.push(f);
    }
    cands.sort((a, b) => polyArea(a.poly) - polyArea(b.poly));
    return cands[0] ? { f: cands[0], strong: false } : null;
  }
  /** 選択中の図形のハンドル（角・回転・中・施設アイコン）の上か */
  function handleAt(p, w) {
    if (exitMode || make) return true;
    const f = sel(); if (!f) return false;
    if (f.poly) return !!polyHandleAt(f, p) || inPoly(f.poly, w[0], w[1]);
    if (f.x !== undefined) { const [x, y] = scr(f.x, f.z); return Math.hypot(x - p[0], y - p[1]) < 14; }
    return false;
  }
  // ---------- コピー・貼り付け（建物・範囲・施設） ----------
  let clip = null;
  function copySel() {
    const f = sel();
    if (!f || !['building', 'area', 'poi'].includes(f.kind)) return false;
    clip = structuredClone(f);
    return true;
  }
  /** カーソルの位置 w に貼り付ける（形の中心がカーソルに来る） */
  function paste(w) {
    if (!clip) return null;
    const f = structuredClone(clip);
    f.id = newId();
    const c = f.poly ? centroid(f.poly) : [f.x, f.z];
    let d = w ? [w[0] - c[0], w[1] - c[1]] : [10, 10];
    if (snapActive()) d = [Math.round(d[0]), Math.round(d[1])];
    if (f.poly) f.poly = f.poly.map(([x, z]) => [round1(x + d[0]), round1(z + d[1])]);
    if (f.x !== undefined) { f.x = round1(f.x + d[0]); f.z = round1(f.z + d[1]); }
    commit([{ id: f.id, after: f }]);
    select(f.id);
    return f.kind;
  }

  return {
    copy: copySel, paste, clipKind: () => clip?.kind || null,
    tools: { building, area, station, poi, airport }, overlay, renderPanel, validate,
    isBusy: () => !!make || roadTools.isBusy(),
    hitAt, handleAt, selectShape: (id) => select(id), clear: () => { if (selId) select(null); }, selectedKind: () => sel()?.kind || null,
  };
}

function polyArea(poly) { let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]); return Math.abs(a / 2); }
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
