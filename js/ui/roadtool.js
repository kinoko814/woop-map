// =============================================================
// 編集モード：道路ツール・交差点・IC/JCT ツール
// =============================================================
import { h, icon, toast, ask } from './dom.js';
import { Tx, newId } from '../engine/features.js';
import {
  ROAD_TYPES, ROAD_TOOL_TYPES, ROAD_COLORS, LEVELS, defaultColor, roadVisible, tessellate, nearestOnPolyline,
  makeNode, insertNodeNearest, insertNodeInRoad, removeNodeFromRoad, deleteRoad, mergeNodes, autoIntersect, isJunction,
} from '../engine/roads.js';
import { fmtDist } from '../engine/view.js';
import { RAIL_TYPES, METRO_COLORS, railVisible, railColor } from '../engine/rails.js';
import { riverVisible } from '../engine/rivers.js';
import { ADDR_LEVELS, levelIndex } from '../engine/address.js';
import { imageToDataURL } from './dom.js';

const SNAP_PX = 11;

export function createRoadTools({ view, F, session, layer, refreshPanel, kind = 'road' }) {
  const isRail = kind === 'rail';
  const isRiver = kind === 'river';
  const isBorder = kind === 'border';
  const bdst = { level: 'pref' };   // 住所の境界線ツールの階層
  const rvst = { w: 20 };   // 川ツールの設定
  const st = { type: 'normal', color: 'white', w: ROAD_TYPES.normal.w, curve: false, lv: 0 };
  const rst = { type: 'jr', color: METRO_COLORS[5] };   // 鉄道ツールの設定
  const visibleLine = (f) => f && f.kind === kind && (isBorder ? true : isRail ? railVisible(f, view.mpp) : isRiver ? riverVisible(f, view.mpp) : roadVisible(f, view.mpp));
  // 自動の交差点づくりは道路だけ
  const ai = (tx, ids) => { if (!isRail) autoIntersect(tx, ids.filter((id) => tx.get(id)?.kind === 'road')); };
  let draw = null;      // 描画中 {road, nodes:Map, inserts:[], baseId, atEnd, cursor, snap, lastClick}
  let sel = null;       // {roadId?, seg?, nodeId?}
  let drag = null;      // ノードのドラッグ {id, start, moved, target}
  let press = null;     // クリックかドラッグ(パン)かの判定
  let hoverSnap = null;
  let fromEdit = false;   // 選択ツールの「延ばす・分岐」から描いているか

  // ---------- 当たり判定 ----------
  function nodeAt(p, { exclude = null, onlyRoad = null } = {}) {
    let best = null, bd = SNAP_PX;
    const consider = (n) => {
      if (!n || n.id === exclude) return;
      const [x, y] = view.toScreen(n.x, n.z);
      const d = Math.hypot(x - p[0], y - p[1]);
      if (d < bd) { bd = d; best = n; }
    };
    if (onlyRoad) { for (const id of F.get(onlyRoad)?.nodes || []) consider(F.get(id)); return best; }
    const b = view.bounds();
    for (const n of F.ofKind('node')) {
      if (n.x < b.x0 - 50 || n.x > b.x1 + 50 || n.z < b.z0 - 50 || n.z > b.z1 + 50) continue;
      if (![...F.linesOf(n.id)].some((rid) => visibleLine(F.get(rid)))) continue;
      consider(n);
    }
    if (draw) for (const n of draw.nodes.values()) consider(n);
    return best;
  }
  function roadAt(p) {
    const [wx, wz] = view.toWorld(...p);
    let best = null;
    const b = view.bounds();
    for (const r of F.ofKind(kind)) {
      if (!visibleLine(r) || layer.hide.has(r.id)) continue;
      const g = layer.geom.get(r);
      if (g.bbox[0] > b.x1 || g.bbox[2] < b.x0 || g.bbox[1] > b.z1 || g.bbox[3] < b.z0) continue;
      g.segs.forEach((pts, i) => {
        const hit = nearestOnPolyline(pts, wx, wz);
        const w = r.segs[i]?.w || 8;
        const tol = Math.max(w / 2 + 3 * view.mpp, 8 * view.mpp);
        if (hit.d <= tol && (!best || hit.d < best.d)) best = { road: r, seg: i, x: hit.x, z: hit.z, d: hit.d };
      });
    }
    return best;
  }
  function snapAt(p, exclude) {
    const n = nodeAt(p, { exclude });
    if (n) return { node: n };
    const r = roadAt(p);
    if (r) return { road: r.road, seg: r.seg, x: r.x, z: r.z };
    return null;
  }
  function midHandles(road) {
    const g = tessellate(road, layer.getNode);
    return g.segs.map((pts, i) => {
      let L = 0; for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      let d = L / 2;
      for (let k = 1; k < pts.length; k++) {
        const s = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        if (d <= s) { const t = s ? d / s : 0; return { seg: i, x: pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, z: pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t, len: L }; }
        d -= s;
      }
      return { seg: i, x: pts[0][0], z: pts[0][1], len: L };
    });
  }

  // ---------- 描画（下書き） ----------
  const CURSOR = '__cursor__';
  function startDraw(firstSnap, wpt, base = null) {
    const nodes = new Map();
    const inserts = [];
    let road;
    if (base) {
      road = structuredClone(F.get(base.roadId));
      layer.hide.add(road.id);
    } else {
      road = isBorder
        ? { id: newId(), kind: 'border', level: bdst.level, nodes: [], segs: [] }
        : isRiver
        ? { id: newId(), kind: 'river', name: '', nodes: [], segs: [] }
        : isRail
        ? { id: newId(), kind: 'rail', type: rst.type, color: rst.color, name: '', symbol: '', nodes: [], segs: [] }
        : { id: newId(), kind: 'road', type: st.type, color: st.color, name: '', nodes: [], segs: [] };
      const id = placeNode(firstSnap, wpt, nodes, inserts);
      road.nodes.push(id);
    }
    draw = { road, nodes, inserts, baseId: base?.roadId || null, atEnd: base ? base.atEnd : true, cursor: wpt, snap: null, lastClick: 0 };
    sel = null;
    syncDraft();
    refreshPanel();
  }
  function placeNode(snap, w, nodes, inserts) {
    if (snap?.node) return snap.node.id;
    const x = snap?.road ? snap.x : w[0], z = snap?.road ? snap.z : w[1];
    const lv = isRiver || isBorder ? 0 : snap?.road ? (F.get(snap.road.nodes[snap.seg])?.lv || 0) : st.lv;
    const n = { id: newId(), kind: 'node', x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, lv };
    nodes.set(n.id, n);
    if (snap?.road) inserts.push({ roadId: snap.road.id, nodeId: n.id });
    return n.id;
  }
  function addPoint(snap, w) {
    const id = placeNode(snap, w, draw.nodes, draw.inserts);
    const r = draw.road;
    const seg = isBorder ? {} : isRail ? { c: st.curve } : { w: isRiver ? rvst.w : st.w, c: st.curve };
    if (draw.atEnd) { if (r.nodes[r.nodes.length - 1] === id) return; r.nodes.push(id); r.segs.push(seg); }
    else { if (r.nodes[0] === id) return; r.nodes.unshift(id); r.segs.unshift(seg); }
    syncDraft();
  }
  function popPoint() {
    const r = draw.road;
    const min = draw.baseId ? F.get(draw.baseId).nodes.length : 1;
    if (r.nodes.length <= min) { cancelDraw(); return; }
    const id = draw.atEnd ? r.nodes.pop() : r.nodes.shift();
    draw.atEnd ? r.segs.pop() : r.segs.shift();
    if (draw.nodes.has(id) && !r.nodes.includes(id)) { draw.nodes.delete(id); draw.inserts = draw.inserts.filter((i) => i.nodeId !== id); }
    syncDraft();
  }
  function syncDraft() {
    if (!draw) { layer.draft = null; view.requestDraw(); return; }
    const r = draw.road;
    const prev = { ...r, nodes: r.nodes.slice(), segs: r.segs.slice() };
    if (draw.cursor) {
      const seg = isBorder ? {} : { w: isRiver ? rvst.w : st.w, c: st.curve };
      if (draw.atEnd) { prev.nodes.push(CURSOR); prev.segs.push(seg); } else { prev.nodes.unshift(CURSOR); prev.segs.unshift(seg); }
    }
    const cur = draw.snap?.node || (draw.snap?.road ? { x: draw.snap.x, z: draw.snap.z, lv: 0 } : { x: draw.cursor?.[0] ?? 0, z: draw.cursor?.[1] ?? 0, lv: st.lv });
    layer.draft = { road: prev, getNode: (id) => (id === CURSOR ? cur : draw.nodes.get(id) || layer.getNode(id)) };
    view.requestDraw();
  }
  function finishDraw() {
    if (!draw) return;
    const d = draw; draw = null;
    layer.hide.delete(d.road.id); layer.draft = null;
    if (d.road.nodes.length < 2) { refreshPanel(); view.requestDraw(); return; }
    const tx = new Tx(F);
    for (const n of d.nodes.values()) if (d.road.nodes.includes(n.id)) tx.put(n);
    tx.put(d.road);
    for (const ins of d.inserts) if (d.road.nodes.includes(ins.nodeId) && tx.get(ins.roadId)) {
      if (ins.roadId === d.road.id) continue;
      insertNodeNearest(tx, ins.roadId, ins.nodeId);
    }
    ai(tx, [d.road.id]);
    session.commitFeatures(tx.changes());
    sel = fromEdit ? { roadId: d.road.id, seg: null, nodeId: null } : null;
    refreshPanel();
  }
  function cancelDraw() {
    if (!draw) return;
    layer.hide.delete(draw.road.id);
    draw = null; layer.draft = null;
    refreshPanel(); view.requestDraw();
  }

  // ---------- 変更の確定 ----------
  function commit(fn) {
    const tx = new Tx(F);
    fn(tx);
    session.commitFeatures(tx.changes());
    if (sel?.roadId && !F.get(sel.roadId)) sel = null;
    if (sel?.nodeId && !F.get(sel.nodeId)) sel = sel.roadId ? { roadId: sel.roadId } : null;
    refreshPanel(); view.requestDraw();
  }

  // ---------- ツール本体 ----------
  /** editing=false: 描くツール（どこをクリックしても描き始める）/ true: 選択ツールからの編集 */
  const makeLineTool = (editing) => ({
    cursor: editing ? 'default' : 'crosshair',
    down(w, e, p) {
      press = { p, w, x: view.x, z: view.z, moved: false };
      if (draw || !editing) return;
      // 選択中の道路の中間点、または交差点をつかむ
      const roadNodes = sel?.roadId ? nodeAt(p, { onlyRoad: sel.roadId }) : null;
      const n = roadNodes || (sel?.nodeId ? nodeAt(p, { onlyRoad: null }) : null);
      if (n && (roadNodes || n.id === sel?.nodeId)) drag = { id: n.id, start: p, moved: false, target: null };
    },
    move(w, e, p) {
      if (drag) {
        if (!drag.moved && Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]) < 4) return;
        drag.moved = true;
        const tgt = nodeAt(p, { exclude: drag.id });
        drag.target = tgt;
        const n = F.get(drag.id);
        layer.nodeOverride = new Map([[drag.id, { ...n, x: tgt ? tgt.x : w[0], z: tgt ? tgt.z : w[1] }]]);
        hoverSnap = tgt ? { node: tgt } : null;
        view.requestDraw();
        return;
      }
      if (press && !press.moved && Math.hypot(p[0] - press.p[0], p[1] - press.p[1]) > 4) press.moved = true;
      if (press?.moved) view.setView(press.x - (p[0] - press.p[0]) / view.scale, press.z - (p[1] - press.p[1]) / view.scale);
    },
    up(w, e, p) {
      if (drag) {
        const d = drag; drag = null;
        layer.nodeOverride = null; hoverSnap = null;
        if (d.moved) {
          commit((tx) => {
            if (d.target) {
              mergeNodes(tx, d.id, d.target.id);
              ai(tx, [...tx.roadsOf(d.target.id)]);
            } else {
              const n = tx.edit(d.id); n.x = Math.round(w[0] * 10) / 10; n.z = Math.round(w[1] * 10) / 10;
              ai(tx, [...tx.roadsOf(d.id)]);
            }
          });
          press = null;
          return;
        }
      }
      const pr = press; press = null;
      if (pr?.moved) return;
      click(w, p, editing);
    },
    hover(w, e, p) {
      if (draw) {
        draw.cursor = w;
        const last = draw.atEnd ? draw.road.nodes[draw.road.nodes.length - 1] : draw.road.nodes[0];
        draw.snap = snapAt(p, last);
        hoverSnap = draw.snap;
        syncDraft();
      } else if (!editing) {
        // 描き始めたらつながる場所を表示
        hoverSnap = snapAt(p);
        view.requestDraw();
      }
    },
    deactivate() { cancelDraw(); sel = null; hoverSnap = null; view.requestDraw(); },
    key(e) {
      if (draw) {
        if (e.key === 'Enter' || e.key === 'Escape') { finishDraw(); return true; }
        if (e.key === 'Backspace') { popPoint(); return true; }
      }
      if (e.key === 'Escape' && sel) { sel = null; refreshPanel(); view.requestDraw(); return true; }
      if (e.key.toLowerCase() === 'c') { st.curve = !st.curve; syncDraft(); refreshPanel(); return true; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        if (sel.nodeId && sel.roadId) { const i = F.get(sel.roadId).nodes.indexOf(sel.nodeId); commit((tx) => removeNodeFromRoad(tx, sel.roadId, i)); }
        else if (sel.roadId) commit((tx) => deleteRoad(tx, sel.roadId));
        return true;
      }
      if (e.key.toLowerCase() === 'e' && sel?.roadId && sel.nodeId) { extendFrom(sel.roadId, sel.nodeId); return true; }
      return false;
    },
  });
  const roadTool = makeLineTool(false);
  const editTool = makeLineTool(true);

  function click(w, p, editing) {
    const now = performance.now();
    if (draw) {
      const r = draw.road;
      const last = draw.atEnd ? r.nodes[r.nodes.length - 1] : r.nodes[0];
      const ln = draw.nodes.get(last) || F.get(last);
      const [lx, ly] = view.toScreen(ln.x, ln.z);
      // 最後の点をもう一度クリック（ダブルクリック）で完了
      if (Math.hypot(lx - p[0], ly - p[1]) < SNAP_PX) { finishDraw(); return; }
      addPoint(snapAt(p, last), w);
      draw.lastClick = now;
      return;
    }
    // 描くツール：既存の道路や交差点の上でも、クリックした所から描き始める（つながる）
    if (!editing) { sel = null; fromEdit = false; startDraw(snapAt(p), w); return; }
    // 選択中の道路の「＋」で中間点を追加
    if (sel?.roadId) {
      const road = F.get(sel.roadId);
      for (const m of midHandles(road)) {
        const [x, y] = view.toScreen(m.x, m.z);
        if (m.len * view.scale > 34 && Math.hypot(x - p[0], y - p[1]) < 9) {
          let nid;
          commit((tx) => { const n = makeNode(tx, m.x, m.z, tx.get(road.nodes[m.seg])?.lv || 0); nid = n.id; insertNodeInRoad(tx, road.id, m.seg, n.id); });
          sel = { roadId: road.id, nodeId: nid, seg: null };
          refreshPanel(); return;
        }
      }
      const n = nodeAt(p, { onlyRoad: sel.roadId });
      if (n) { sel = { roadId: sel.roadId, nodeId: n.id, seg: null }; refreshPanel(); view.requestDraw(); return; }
    }
    const jn = nodeAt(p);
    if (jn && !isRail && isJunction(F, jn.id)) { sel = { nodeId: jn.id }; refreshPanel(); view.requestDraw(); return; }
    const hit = roadAt(p);
    if (hit) { sel = { roadId: hit.road.id, seg: hit.seg, nodeId: null }; refreshPanel(); view.requestDraw(); return; }
    if (sel) { sel = null; refreshPanel(); view.requestDraw(); }
  }
  // ---------- 選択ツールから使う ----------
  /** 選択中の線の中間点・「＋」・選択中の交差点の上か */
  function handleAt(p) {
    if (draw) return true;
    if (sel?.roadId && F.get(sel.roadId)) {
      if (nodeAt(p, { onlyRoad: sel.roadId })) return true;
      for (const m of midHandles(F.get(sel.roadId))) { const [x, y] = view.toScreen(m.x, m.z); if (m.len * view.scale > 34 && Math.hypot(x - p[0], y - p[1]) < 9) return true; }
    }
    if (sel?.nodeId && !sel.roadId) { const n = F.get(sel.nodeId); if (n) { const [x, y] = view.toScreen(n.x, n.z); if (Math.hypot(x - p[0], y - p[1]) < SNAP_PX) return true; } }
    return false;
  }
  function hitAt(p) {
    if (!isRail && kind === 'road') { const jn = nodeAt(p); if (jn && isJunction(F, jn.id)) return { node: jn, d: 0 }; }
    const r = roadAt(p);
    return r ? { line: r.road, seg: r.seg, d: r.d } : null;
  }
  function selectHit(hit) {
    if (!hit) sel = null;
    else if (hit.node) sel = { nodeId: hit.node.id };
    else sel = { roadId: hit.line.id, seg: hit.seg, nodeId: null };
    refreshPanel(); view.requestDraw();
  }
  function extendFrom(roadId, nodeId) {
    fromEdit = true;
    const r = F.get(roadId);
    const i = r.nodes.indexOf(nodeId);
    if (i === r.nodes.length - 1) startDraw(null, null, { roadId, atEnd: true });
    else if (i === 0) startDraw(null, null, { roadId, atEnd: false });
    else branchFrom(nodeId);
  }
  function branchFrom(nodeId) {
    fromEdit = true;
    const n = F.get(nodeId);
    startDraw({ node: n }, [n.x, n.z]);
  }
  /** 交差点の接続を切る（立体交差にするときなど） */
  function detach(nodeId) {
    commit((tx) => {
      const rs = [...tx.roadsOf(nodeId)];
      const n = tx.get(nodeId);
      rs.slice(1).forEach((rid) => {
        const copy = makeNode(tx, n.x, n.z, n.lv || 0);
        const r = tx.edit(rid);
        r.nodes = r.nodes.map((id) => (id === nodeId ? copy.id : id));
      });
    });
    sel = null; refreshPanel();
  }

  // ---------- ハンドル類の表示 ----------
  const overlay = {
    draw(ctx, v) {
      ctx.save();
      const dot = (x, y, r, fill, stroke, lw = 2) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.stroke(); };
      if (sel?.roadId && F.get(sel.roadId)) {
        const road = F.get(sel.roadId);
        // 選択中の道路を縁取り
        const g = tessellate(road, layer.getNode);
        ctx.strokeStyle = 'rgba(47,163,146,.55)'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        g.segs.forEach((pts, i) => {
          ctx.lineWidth = Math.max((road.segs[i]?.w || 8) * v.scale, 2) + (sel.seg === i ? 10 : 6);
          ctx.beginPath(); pts.forEach(([x, z], k) => { const [sx, sy] = v.toScreen(x, z); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); ctx.stroke();
        });
        for (const m of midHandles(road)) {
          if (m.len * v.scale <= 34) continue;
          const [x, y] = v.toScreen(m.x, m.z);
          dot(x, y, 6, '#fff', '#2fa392', 1.5);
          ctx.strokeStyle = '#2fa392'; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3); ctx.stroke();
        }
        for (const id of road.nodes) {
          const n = layer.getNode(id); if (!n) continue;
          const [x, y] = v.toScreen(n.x, n.z);
          dot(x, y, id === sel.nodeId ? 7 : 5.5, id === sel.nodeId ? '#2fa392' : '#fff', '#1f7c6f');
          if (n.lv) { ctx.fillStyle = '#1f7c6f'; ctx.font = '700 10px system-ui'; ctx.fillText(n.lv > 0 ? '高' : '地', x + 8, y - 7); }
        }
      }
      if (sel?.nodeId && !sel.roadId) {
        const n = layer.getNode(sel.nodeId);
        if (n) { const [x, y] = v.toScreen(n.x, n.z); dot(x, y, 8, 'rgba(47,163,146,.25)', '#1f7c6f'); dot(x, y, 4, '#1f7c6f', '#fff', 1.5); }
      }
      if (draw) {
        for (const id of draw.road.nodes) {
          const n = draw.nodes.get(id) || F.get(id); if (!n) continue;
          const [x, y] = v.toScreen(n.x, n.z);
          dot(x, y, 4.5, '#fff', '#1f7c6f');
        }
        if (draw.cursor) {
          const last = draw.atEnd ? draw.road.nodes[draw.road.nodes.length - 1] : draw.road.nodes[0];
          const ln = draw.nodes.get(last) || F.get(last);
          if (ln) {
            const tgt = draw.snap?.node || (draw.snap?.road ? draw.snap : { x: draw.cursor[0], z: draw.cursor[1] });
            const d = Math.hypot(tgt.x - ln.x, tgt.z - ln.z);
            const [x, y] = v.toScreen(tgt.x, tgt.z);
            ctx.font = '600 11px system-ui'; ctx.fillStyle = '#1e2329';
            ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
            const t = `${fmtDist(d)}・太さ${st.w}m${st.curve ? '・曲線' : ''}${st.lv ? (st.lv > 0 ? '・高架' : '・地下') : ''}`;
            ctx.strokeText(t, x + 12, y + 18); ctx.fillText(t, x + 12, y + 18);
          }
        }
      }
      if (hoverSnap) {
        const s = hoverSnap.node || hoverSnap;
        const [x, y] = v.toScreen(s.x, s.z);
        ctx.setLineDash([]);
        dot(x, y, 9, 'rgba(117,210,195,.25)', '#2fa392', 2);
      }
      ctx.restore();
    },
  };

  // ---------- パネル ----------
  function settingsBlock(applyToDraft) {
    const typeChips = h('div', { class: 'type-list' }, ...ROAD_TOOL_TYPES.map((k) => [k, ROAD_TYPES[k]]).map(([k, t]) =>
      h('button', { class: `type-item ${st.type === k ? 'on' : ''}`, onclick: () => {
        st.type = k; st.color = defaultColor(k); st.w = t.w;
        if (draw && applyToDraft) { draw.road.type = k; draw.road.color = st.color; syncDraft(); }
        refreshPanel();
      } }, roadSwatch(k, defaultColor(k)), t.label)));
    return [
      h('label', { class: 'lbl' }, '種類'), typeChips,
      colorRow(st.color, (c) => { st.color = c; if (draw && applyToDraft) { draw.road.color = c; syncDraft(); } refreshPanel(); }),
      widthRow(st.w, (wv) => { st.w = wv; syncDraft(); }),
      h('div', { class: 'row' }, h('label', { class: 'lbl' }, '線の引き方（C キーで切り替え）'),
        seg2([['直線', false], ['曲線', true]], st.curve, (c) => { st.curve = c; syncDraft(); refreshPanel(); })),
      h('div', { class: 'row' }, h('label', { class: 'lbl' }, '高さ（これから置く中間点）'),
        seg2([['地上', 0], ['高架', 1], ['地下', -1]], st.lv, (lv) => { st.lv = lv; syncDraft(); refreshPanel(); })),
    ];
  }

  function renderPanel(box) {
    if (isRail) return renderRailPanel(box);
    if (isRiver) return renderRiverPanel(box);
    if (isBorder) return renderBorderPanel(box);
    const parts = [h('h3', {}, '道路')];
    if (draw) {
      parts.push(h('div', { class: 'hint' },
        h('b', {}, draw.baseId ? '道路を延ばしています' : '道路を描いています'),
        h('div', {}, 'クリックで中間点を追加。既存の道路や交差点の上に置くとつながります。'),
        h('div', {}, '完了：Enter・最後の点をもう一度クリック　1つ戻す：Backspace')),
      ...settingsBlock(true),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: finishDraw }, icon('check'), '完了'), h('button', { class: 'btn', onclick: cancelDraw }, icon('x'), 'やめる')));
      box.replaceChildren(...parts); return;
    }
    const road = sel?.roadId ? F.get(sel.roadId) : null;
    const node = sel?.nodeId ? F.get(sel.nodeId) : null;
    if (!road && !node) {
      parts.push(h('div', { class: 'hint' },
        h('div', {}, '地図をクリックして描き始めます。既存の道路や交差点の上から描き始めると、そこにつながります。'), h('div', {}, '描いた道路を直すときは「選択」ツール（V）でクリックします。'),
        h('div', {}, 'ドラッグで地図を移動できます。')),
      ...settingsBlock(false));
      box.replaceChildren(...parts); return;
    }
    if (road) {
      const name = h('input', { type: 'text', id: 'road-name', value: road.name || '', placeholder: '例：国道1号', onchange: () => commit((tx) => { tx.edit(road.id).name = name.value.trim(); }) });
      const typeSel = h('select', { id: 'road-type', onchange: () => commit((tx) => {
        const r = tx.edit(road.id); r.type = typeSel.value;
        if (ROAD_TYPES[r.type].highway && r.color === 'white') r.color = 'orange';
      }) }, ...(ROAD_TYPES[road.type]?.air ? ['runway', 'taxiway'] : ROAD_TOOL_TYPES).map((k) => h('option', { value: k, selected: road.type === k }, ROAD_TYPES[k].label)));
      parts.push(
        h('div', { class: 'row' }, h('label', { class: 'lbl', for: 'road-name' }, '道路の名前'), name),
        h('div', { class: 'row' }, h('label', { class: 'lbl', for: 'road-type' }, '種類'), typeSel),
        colorRow(road.color, (c) => commit((tx) => { tx.edit(road.id).color = c; })),
        h('div', { class: 'row' }, h('label', { class: 'lbl' }, '道路全体の高さ（交差点以外の中間点）'),
          seg2([['地上', 0], ['高架', 1], ['地下', -1]], null, (lv) => commit((tx) => {
            for (const id of road.nodes) if (!isJunction(F, id)) tx.edit(id).lv = lv;
            if (lv === 0) ai(tx, [road.id]);
          }))),
      );
      const si = sel.seg;
      if (si !== null && si !== undefined && road.segs[si]) {
        const s = road.segs[si];
        parts.push(h('div', { class: 'sub' },
          h('div', { class: 'sub-h' }, `選択した区間（${si + 1} / ${road.segs.length}）`),
          widthRow(s.w, (wv) => commit((tx) => { tx.edit(road.id).segs[si].w = wv; }), true),
          h('div', { class: 'row' }, seg2([['直線', false], ['曲線', true]], !!s.c, (c) => commit((tx) => { tx.edit(road.id).segs[si].c = c; }))),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => commit((tx) => { const r = tx.edit(road.id); r.segs.forEach((x) => (x.w = s.w)); }) }, '道路全体をこの太さに'),
            h('button', { class: 'btn', onclick: () => commit((tx) => { const r = tx.edit(road.id); r.segs.forEach((x) => (x.c = !!s.c)); }) }, `全区間を${s.c ? '曲線' : '直線'}に`))));
      }
      if (node) parts.push(nodeBlock(road, node));
      parts.push(h('div', { class: 'btn-row' },
        h('button', { class: 'btn danger', onclick: async () => { if (await ask(`「${road.name || ROAD_TYPES[road.type].label}」を削除しますか？`, '削除')) commit((tx) => deleteRoad(tx, road.id)); } }, icon('trash'), '道路を削除')),
      h('div', { class: 'muted', style: { marginTop: '8px' } }, '中間点はドラッグで移動、別の中間点に重ねるとつながります。線の上の「＋」で中間点を追加。'));
    } else if (node) parts.push(junctionBlock(node));
    box.replaceChildren(...parts);
  }

  function nodeBlock(road, node) {
    const i = road.nodes.indexOf(node.id);
    const end = i === 0 || i === road.nodes.length - 1;
    const block = h('div', { class: 'sub' },
      h('div', { class: 'sub-h' }, `選択した中間点（X ${Math.round(node.x)} / Z ${Math.round(node.z)}）`),
      isRiver || isBorder ? null : h('div', { class: 'row' }, h('label', { class: 'lbl' }, '高さ'),
        seg2([['地上', 0], ['高架', 1], ['地下', -1]], node.lv || 0, (lv) => commit((tx) => { tx.edit(node.id).lv = lv; if (lv === 0) ai(tx, [...tx.roadsOf(node.id)]); }))),
      h('div', { class: 'btn-row' },
        end ? h('button', { class: 'btn', onclick: () => extendFrom(road.id, node.id) }, 'ここから延ばす (E)') : null,
        h('button', { class: 'btn', onclick: () => branchFrom(node.id) }, 'ここから分岐'),
        h('button', { class: 'btn danger', onclick: () => commit((tx) => removeNodeFromRoad(tx, road.id, i)) }, '中間点を削除')));
    if (!isRail && isJunction(F, node.id)) block.append(junctionBlock(node, true));
    return block;
  }

  function junctionBlock(node, nested = false) {
    const roads = [...F.roadsOf(node.id)].map((id) => F.get(id)).filter(Boolean);
    const hasDivided = roads.some((r) => ROAD_TYPES[r.type]?.divided);
    const name = h('input', { type: 'text', id: 'jn-name', value: node.name || '', placeholder: '例：駅前', onchange: () => commit((tx) => { tx.edit(node.id).name = name.value.trim(); }) });
    const size = h('input', { type: 'range', id: 'jn-size', min: 0, max: 80, value: node.r || 0 });
    const sizeL = h('span', { class: 'muted' }, node.r ? `半径 ${node.r}m` : 'なし（直角）');
    size.oninput = () => { sizeL.textContent = +size.value ? `半径 ${size.value}m` : 'なし（直角）'; };
    size.onchange = () => commit((tx) => { tx.edit(node.id).r = +size.value || 0; });
    return h('div', { class: nested ? '' : 'sub' },
      h('div', { class: 'sub-h' }, `交差点（${roads.map((r) => r.name || ROAD_TYPES[r.type].label).join('・')}）`),
      h('div', { class: 'row' }, h('label', { class: 'lbl', for: 'jn-name' }, '交差点の名前'), name),
      h('div', { class: 'row' }, h('label', { class: 'lbl' }, '信号'),
        seg2([['なし', false], ['あり', true]], !!node.signal, (v) => commit((tx) => { tx.edit(node.id).signal = v; }))),
      h('div', { class: 'row' }, h('label', { class: 'lbl', for: 'jn-size' }, '交差点の角の丸み ', sizeL), size),
      hasDivided ? h('div', { class: 'row' }, h('label', { class: 'lbl' }, '中央分離帯'),
        seg2([['交差点で切る', 'open'], ['切らない', 'closed']], node.median === 'closed' ? 'closed' : 'open', (v) => commit((tx) => { tx.edit(node.id).median = v; }))) : null,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => branchFrom(node.id) }, 'ここから道路を延ばす'),
        h('button', { class: 'btn', title: 'つながりを外して立体交差などにする', onclick: () => detach(node.id) }, '接続を切る')));
  }

  // ---------- IC / JCT ----------
  const icSt = { type: 'ic' };
  let lasso = null, selArea = null;
  const inPoly = (poly, x, z) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i], [xj, zj] = poly[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const icTool = {
    cursor: 'crosshair',
    down(w, e, p) { lasso = { pts: [w], sp: [p] }; },
    move(w, e, p) {
      if (!lasso) return;
      const last = lasso.sp[lasso.sp.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 5) { lasso.pts.push(w); lasso.sp.push(p); view.requestDraw(); }
    },
    up(w) {
      const l = lasso; lasso = null;
      if (l && l.pts.length >= 6) {
        const id = newId();
        session.commitFeatures([{ id, after: { id, kind: 'area', type: icSt.type, name: '', poly: l.pts.map(([x, z]) => [Math.round(x), Math.round(z)]) } }]);
        selArea = id; layer.selectedArea = id;
        refreshPanel(); view.requestDraw();
        setTimeout(() => document.getElementById('area-name')?.focus(), 30);
        return;
      }
      const hit = [...F.ofKind('area')].reverse().find((a) => inPoly(a.poly, w[0], w[1]));
      selArea = hit?.id || null; layer.selectedArea = selArea;
      refreshPanel(); view.requestDraw();
    },
    deactivate() { lasso = null; selArea = null; layer.selectedArea = null; view.requestDraw(); },
    key(e) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selArea) { session.commitFeatures([{ id: selArea, after: null }]); selArea = null; refreshPanel(); return true; }
      return false;
    },
  };
  const icOverlay = {
    draw(ctx, v) {
      if (!lasso) return;
      ctx.save(); ctx.strokeStyle = '#1f7c6f'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.fillStyle = 'rgba(117,210,195,.18)';
      ctx.beginPath(); lasso.sp.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    },
  };
  function renderIcPanel(box) {
    const parts = [h('h3', {}, 'インターチェンジ・ジャンクション'),
      h('div', { class: 'hint' }, h('div', {}, 'ドラッグして投げ縄のように範囲を囲みます。囲んだ範囲をクリックすると名前を付けたり削除したりできます。'), h('div', {}, '地図の移動は Space+ドラッグ か右ドラッグ。')),
      h('label', { class: 'lbl' }, '次に作る種類'),
      seg2([['IC（インターチェンジ）', 'ic'], ['JCT（ジャンクション）', 'jct']], icSt.type, (t) => { icSt.type = t; refreshPanel(); })];
    const a = selArea ? F.get(selArea) : null;
    if (a) {
      const name = h('input', { type: 'text', id: 'area-name', value: a.name || '', placeholder: a.type === 'jct' ? '例：港北' : '例：横浜青葉', onchange: () => session.commitFeatures([{ id: a.id, after: { ...F.get(a.id), name: name.value.trim() } }]) });
      parts.push(h('div', { class: 'sub' },
        h('div', { class: 'sub-h' }, '選択中の範囲'),
        h('div', { class: 'row' }, h('label', { class: 'lbl', for: 'area-name' }, '名前（IC / JCT は自動で付きます）'), name),
        h('div', { class: 'row' }, seg2([['IC', 'ic'], ['JCT', 'jct']], a.type, (t) => { session.commitFeatures([{ id: a.id, after: { ...F.get(a.id), type: t } }]); refreshPanel(); })),
        h('div', { class: 'row' }, h('label', { class: 'lbl', for: 'area-desc' }, '概要（表示モードでクリックすると出ます）'),
          h('textarea', { id: 'area-desc', rows: 4, placeholder: '例：国道1号と港湾道路に接続。大型車は南側の出口へ。', onchange: (e) => session.commitFeatures([{ id: a.id, after: { ...F.get(a.id), desc: e.target.value.trim() } }]) }, a.desc || '')),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onclick: () => { session.commitFeatures([{ id: a.id, after: null }]); selArea = null; layer.selectedArea = null; refreshPanel(); } }, icon('trash'), '範囲を削除'))));
    }
    box.replaceChildren(...parts);
  }

  // ---------- 鉄道のパネル ----------
  function railTypeChips(value, onPick) {
    return h('div', { class: 'type-list three' }, ...Object.entries(RAIL_TYPES).map(([k, t]) =>
      h('button', { class: `type-item ${value === k ? 'on' : ''}`, onclick: () => onPick(k) }, h('span', { class: `rail-sw ${k}`, style: { '--c': rst.color } }), t.label)));
  }
  function metroColorRow(value, onPick) {
    const custom = h('input', { type: 'color', value, title: '好きな色', oninput: (e) => onPick(e.target.value, true), onchange: (e) => onPick(e.target.value) });
    return h('div', { class: 'row' }, h('label', { class: 'lbl' }, '路線の色'),
      h('div', { class: 'swatches' }, ...METRO_COLORS.map((c) => h('button', { class: `swatch ${value === c ? 'on' : ''}`, style: { background: c }, title: c, onclick: () => onPick(c) })), custom));
  }
  function renderRailPanel(box) {
    const parts = [h('h3', {}, '鉄道')];
    const settings = () => [
      h('label', { class: 'lbl' }, '種類'),
      railTypeChips(rst.type, (k) => { rst.type = k; if (draw) { draw.road.type = k; syncDraft(); } refreshPanel(); }),
      rst.type === 'metro' ? metroColorRow(rst.color, (c, live) => { rst.color = c; if (draw) { draw.road.color = c; syncDraft(); } if (!live) refreshPanel(); }) : null,
      h('div', { class: 'row' }, h('label', { class: 'lbl' }, '線の引き方（C キーで切り替え）'),
        seg2([['直線', false], ['曲線', true]], st.curve, (c) => { st.curve = c; syncDraft(); refreshPanel(); })),
      h('div', { class: 'row' }, h('label', { class: 'lbl' }, '高さ（これから置く中間点）'),
        seg2([['地上', 0], ['高架', 1], ['地下', -1]], st.lv, (lv) => { st.lv = lv; syncDraft(); refreshPanel(); })),
    ];
    if (draw) {
      parts.push(h('div', { class: 'hint' },
        h('b', {}, draw.baseId ? '線路を延ばしています' : '線路を描いています'),
        h('div', {}, 'クリックで中間点を追加。既存の線路の上に置くとつながります（道路とはつながりません）。'),
        h('div', {}, '完了：Enter・最後の点をもう一度クリック　1つ戻す：Backspace')),
      ...settings(),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: finishDraw }, icon('check'), '完了'), h('button', { class: 'btn', onclick: cancelDraw }, icon('x'), 'やめる')));
      box.replaceChildren(...parts); return;
    }
    const rail = sel?.roadId ? F.get(sel.roadId) : null;
    const node = sel?.nodeId ? F.get(sel.nodeId) : null;
    if (!rail) {
      parts.push(h('div', { class: 'hint' }, h('div', {}, '地図をクリックして線路を描き始めます。描いた線路を直すときは「選択」ツール（V）でクリックします。'), h('div', {}, '駅は「駅」ツールで線路の上に作ります。')), ...settings());
      box.replaceChildren(...parts); return;
    }
    const upd = (fn) => commit((tx) => fn(tx.edit(rail.id)));
    const name = h('input', { type: 'text', id: 'rail-name', value: rail.name || '', placeholder: rail.type === 'metro' ? '例：港北線' : '例：東海道本線', onchange: () => upd((r) => { r.name = name.value.trim(); }) });
    parts.push(
      h('div', { class: 'row' }, h('label', { class: 'lbl', for: 'rail-name' }, '路線名'), name),
      h('div', { class: 'row' }, h('label', { class: 'lbl' }, '種類'), railTypeChips(rail.type, (k) => upd((r) => { r.type = k; }))),
    );
    if (rail.type === 'metro') {
      const sym = h('input', { type: 'text', id: 'rail-sym', maxlength: 3, value: rail.symbol || '', placeholder: '例：G', onchange: () => upd((r) => { r.symbol = sym.value.trim(); }) });
      parts.push(metroColorRow(rail.color || METRO_COLORS[5], (c, live) => { if (!live) upd((r) => { r.color = c; }); }),
        h('div', { class: 'row' }, h('label', { class: 'lbl', for: 'rail-sym' }, '路線記号（駅のマークに表示。空なら路線名の頭文字）'), sym));
    } else {
      const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onchange: async () => {
        const f = file.files[0]; if (!f) return;
        try { const url = await imageToDataURL(f, 96, 'image/png'); upd((r) => { r.logo = url; }); } catch (e) { toast('画像を読み込めませんでした'); }
      } });
      parts.push(h('div', { class: 'row' }, h('label', { class: 'lbl' }, '路線のアイコン（駅のマークに使われます）'),
        h('div', { class: 'logo-row' },
          rail.logo ? h('img', { src: rail.logo, alt: '', class: 'logo-prev' }) : h('span', { class: 'logo-prev empty' }, '電車'),
          h('button', { class: 'btn', onclick: () => file.click() }, icon('upload'), rail.logo ? '変更' : 'アップロード'),
          rail.logo ? h('button', { class: 'btn', onclick: () => upd((r) => { delete r.logo; }) }, '外す') : null, file)));
    }
    parts.push(h('div', { class: 'row' }, h('label', { class: 'lbl' }, '線路全体の高さ'),
      seg2([['地上', 0], ['高架', 1], ['地下', -1]], null, (lv) => commit((tx) => { for (const id of rail.nodes) if (tx.linesOf(id).size < 2) tx.edit(id).lv = lv; }))));
    const si = sel.seg;
    if (si !== null && si !== undefined && rail.segs[si]) {
      parts.push(h('div', { class: 'sub' }, h('div', { class: 'sub-h' }, `選択した区間（${si + 1} / ${rail.segs.length}）`),
        seg2([['直線', false], ['曲線', true]], !!rail.segs[si].c, (c) => upd((r) => { r.segs[si].c = c; }))));
    }
    if (node) parts.push(nodeBlock(rail, node));
    parts.push(h('div', { class: 'btn-row' },
      h('button', { class: 'btn danger', onclick: async () => { if (await ask(`「${rail.name || RAIL_TYPES[rail.type].label}」の線路を削除しますか？`, '削除')) commit((tx) => deleteRoad(tx, rail.id)); } }, icon('trash'), '線路を削除')),
    h('div', { class: 'muted', style: { marginTop: '8px' } }, '中間点はドラッグで移動、別の中間点に重ねるとつながります。線の上の「＋」で中間点を追加。'));
    box.replaceChildren(...parts);
  }
  // ---------- 川のパネル ----------
  function renderRiverPanel(box) {
    const parts = [h('h3', {}, '川')];
    const settings = () => [
      widthRow(rvst.w, (wv) => { rvst.w = wv; syncDraft(); }, false, 500),
      h('div', { class: 'row' }, h('label', { class: 'lbl' }, '線の引き方（C キーで切り替え）'),
        seg2([['直線', false], ['曲線', true]], st.curve, (c) => { st.curve = c; syncDraft(); refreshPanel(); })),
    ];
    if (draw) {
      parts.push(h('div', { class: 'hint' }, h('b', {}, '川を描いています'), h('div', {}, 'クリックで中間点を追加。太さは途中で変えられます（河口に向かって太くするなど）。'), h('div', {}, '完了：Enter・最後の点をもう一度クリック　1つ戻す：Backspace')),
        ...settings(),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: finishDraw }, icon('check'), '完了'), h('button', { class: 'btn', onclick: cancelDraw }, icon('x'), 'やめる')));
      box.replaceChildren(...parts); return;
    }
    const river = sel?.roadId ? F.get(sel.roadId) : null;
    if (!river) {
      parts.push(h('div', { class: 'hint' }, h('div', {}, '地図をクリックして川を描き始めます。道路と交わる所は、道路が橋のように上に描かれます。'), h('div', {}, '描いた川を直すときは「選択」ツールでクリックします。')), ...settings());
      box.replaceChildren(...parts); return;
    }
    const name = h('input', { type: 'text', id: 'river-name', value: river.name || '', placeholder: '例：ウープ川', onchange: () => commit((tx) => { tx.edit(river.id).name = name.value.trim(); }) });
    parts.push(h('div', { class: 'row' }, h('label', { class: 'lbl', for: 'river-name' }, '川の名前'), name));
    const si = sel.seg;
    if (si !== null && si !== undefined && river.segs[si]) {
      const sg = river.segs[si];
      parts.push(h('div', { class: 'sub' }, h('div', { class: 'sub-h' }, `選択した区間（${si + 1} / ${river.segs.length}）`),
        widthRow(sg.w || 20, (wv) => commit((tx) => { tx.edit(river.id).segs[si].w = wv; }), true, 500),
        h('div', { class: 'row' }, seg2([['直線', false], ['曲線', true]], !!sg.c, (c) => commit((tx) => { tx.edit(river.id).segs[si].c = c; }))),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn', onclick: () => commit((tx) => { tx.edit(river.id).segs.forEach((x) => (x.w = sg.w)); }) }, '川全体をこの太さに'))));
    }
    if (sel.nodeId) parts.push(nodeBlock(river, F.get(sel.nodeId)));
    parts.push(h('div', { class: 'btn-row' },
      h('button', { class: 'btn danger', onclick: async () => { if (await ask(`「${river.name || '川'}」を削除しますか？`, '削除')) commit((tx) => deleteRoad(tx, river.id)); } }, icon('trash'), '川を削除')));
    box.replaceChildren(...parts);
  }
  // ---------- 住所の境界線のパネル ----------
  function renderBorderPanel(box) {
    const parts = [h('h3', {}, '住所の境界線')];
    if (draw) {
      parts.push(h('div', { class: 'hint' }, h('b', {}, `${ADDR_LEVELS[levelIndex(draw.road.level)]?.label}の境界線を引いています`),
        h('div', {}, 'クリックで角を追加（直線）。ほかの境界線の上に置くとつながります。'), h('div', {}, '完了：Enter・最後の点をもう一度クリック　1つ戻す：Backspace')),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: finishDraw }, icon('check'), '完了'), h('button', { class: 'btn', onclick: cancelDraw }, icon('x'), 'やめる')));
      box.replaceChildren(...parts); return;
    }
    const b = sel?.roadId ? F.get(sel.roadId) : null;
    if (!b) { box.replaceChildren(...parts, h('div', { class: 'muted' }, '境界線は「住所」ツールで引きます。')); return; }
    parts.push(h('div', { class: 'row' }, h('label', { class: 'lbl' }, 'この線の階層'),
      seg2(ADDR_LEVELS.map((L) => [L.label, L.key]), b.level, (lv) => commit((tx) => { tx.edit(b.id).level = lv; }))),
      h('div', { class: 'muted', style: { marginTop: '8px' } }, '上の階層の境界線は、下の階層の境界にもなります（県境は市町村・区・住所名・番地の境界にも）。'));
    if (sel.nodeId) parts.push(nodeBlock(b, F.get(sel.nodeId)));
    parts.push(h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onclick: () => commit((tx) => deleteRoad(tx, b.id)) }, icon('trash'), '境界線を削除')));
    box.replaceChildren(...parts);
  }
  /** 空港ツールなどから種類を指定して使う */
  function setBorderLevel(lv) { bdst.level = lv; if (draw && isBorder) draw.road.level = lv; }
  function preset(type) {
    st.type = type; st.w = ROAD_TYPES[type].w; st.color = defaultColor(type);
  }

  /** 他の人の変更などで選択中のものが消えたら選択を外す */
  function validate() {
    let changed = false;
    if (sel?.roadId && !F.get(sel.roadId)) { sel = null; changed = true; }
    if (sel?.nodeId && !F.get(sel.nodeId)) { sel = sel?.roadId ? { roadId: sel.roadId } : null; changed = true; }
    if (selArea && !F.get(selArea)) { selArea = null; layer.selectedArea = null; changed = true; }
    return changed;
  }

  return { roadTool, editTool, icTool, overlay, icOverlay, renderPanel, renderIcPanel, validate, preset, handleAt, hitAt, selectHit, setBorderLevel, finishDraw: () => finishDraw(), hasSelection: () => !!sel, isBusy: () => !!draw, deselect: () => { sel = null; hoverSnap = null; } };
}

// ---------- パネル部品 ----------
function seg2(options, value, onPick) {
  return h('div', { class: 'seg' }, ...options.map(([label, v]) =>
    h('button', { class: value === v ? 'on' : '', onclick: () => onPick(v) }, label)));
}
function colorRow(value, onPick) {
  return h('div', { class: 'row' }, h('label', { class: 'lbl' }, '色'),
    h('div', { class: 'seg' }, ...Object.entries(ROAD_COLORS).map(([k, c]) =>
      h('button', { class: value === k ? 'on' : '', onclick: () => onPick(k) }, h('span', { class: 'cdot', style: { background: c.fill } }), c.label))));
}
function widthRow(value, onSet, commitOnChange = false, max = 200) {
  const rmax = max > 200 ? 300 : 60;
  const num = h('input', { type: 'number', min: 1, max, step: 0.5, value, style: { width: '84px' } });
  const rng = h('input', { type: 'range', min: 1, max: rmax, step: 0.5, value: Math.min(rmax, value) });
  rng.oninput = () => { num.value = rng.value; if (!commitOnChange) onSet(+rng.value); };
  rng.onchange = () => { if (commitOnChange) onSet(+rng.value); };
  num.onchange = () => { const v = Math.max(1, Math.min(max, +num.value || 1)); rng.value = Math.min(rmax, v); onSet(v); };
  return h('div', { class: 'row' }, h('label', { class: 'lbl' }, '太さ（メートル）'), h('div', { class: 'width-row' }, rng, num));
}
function roadSwatch(type, color) {
  const t = ROAD_TYPES[type];
  const fill = t.walk ? '#fff' : ROAD_COLORS[color].fill;
  return h('span', { class: `rsw ${t.walk ? 'walk' : ''} ${t.divided ? 'div' : ''} ${t.oneway ? 'one' : ''}`, style: { '--f': fill } });
}
