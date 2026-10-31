// =============================================================
// 編集モード
// =============================================================
import { h, icon, logo, toast, hideToast, colorFor, ask } from './dom.js';
import { coordsBox, zoomBox } from './chrome.js';
import { boundsOf, inside, sizeLabel } from '../bounds.js';
import { Terrain, T, T_NAMES, T_COLORS } from '../engine/terrain.js';
import { MapView, fmt, fmtDist } from '../engine/view.js';
import { OverlayLayer } from '../engine/overlays.js';
import { MapSession } from '../session.js';
import { Features } from '../engine/features.js';
import { RoadLayer } from '../engine/roadlayer.js';
import { createRoadTools } from './roadtool.js';
import { createShapeTools } from './shapetool.js';
import { createAddressTool } from './addrtool.js';

const MAX_W = 5000;   // ペン最大 5km
const wFromSlider = (s) => Math.max(1, Math.round(Math.pow(MAX_W, s / 1000)));
const sliderFromW = (w) => Math.round((Math.log(Math.max(1, w)) / Math.log(MAX_W)) * 1000);

export async function startEditor(root, store, nav) {
  const map = store.map;
  const mb = boundsOf(map);
  const terrain = new Terrain({ bounds: mb });
  const features = new Features();
  const session = new MapSession(store, terrain, features);

  // ---------- 骨組み ----------
  const status = h('span', { class: 'status' }, '読み込み中…');
  const people = h('div', { class: 'people' });
  const undoBtn = h('button', { class: 'icon-btn', title: '元に戻す (Ctrl+Z)', disabled: true, onclick: () => session.undo() }, icon('undo'));
  const redoBtn = h('button', { class: 'icon-btn', title: 'やり直す (Ctrl+Shift+Z)', disabled: true, onclick: () => session.redo() }, icon('redo'));
  const saveBtn = h('button', { class: 'btn save-btn', title: '保存 (Ctrl+S)', onclick: () => saveNow() }, icon('save'), '保存');
  const top = h('div', { class: 'ed-top' },
    logo(), h('span', { class: 'mapname' }, map.name), h('span', { class: 'badge' }, '編集モード'),
    undoBtn, redoBtn, saveBtn, status,
    h('div', { class: 'spacer' }), people,
    h('button', { class: 'btn', onclick: () => nav('view') }, icon('view'), '表示'),
    store.role === 'admin' ? h('button', { class: 'btn', onclick: () => nav('admin') }, icon('settings'), '管理') : null,
    store.kind === 'remote' ? h('button', { class: 'icon-btn', title: 'ログアウト', onclick: async () => { await store.signOut(); location.reload(); } }, icon('logout')) : null,
  );
  const canvas = h('canvas');
  const wrap = h('div', { class: 'map-wrap' }, canvas);
  const body = h('div', { class: 'ed-body' }, wrap);
  root.replaceChildren(top, body);

  const view = new MapView(canvas, terrain);
  const overlays = new OverlayLayer(view);
  view.layers.push(overlays);
  const roadLayer = new RoadLayer(view, features);
  roadLayer.edit = true;
  view.layers.push(roadLayer);
  view.fitAll();
  const rt = createRoadTools({ view, F: features, session, layer: roadLayer, refreshPanel: () => renderOpts() });
  const railT = createRoadTools({ view, F: features, session, layer: roadLayer, refreshPanel: () => renderOpts(), kind: 'rail' });
  const riverT = createRoadTools({ view, F: features, session, layer: roadLayer, refreshPanel: () => renderOpts(), kind: 'river' });
  const borderT = createRoadTools({ view, F: features, session, layer: roadLayer, refreshPanel: () => renderOpts(), kind: 'border' });
  const lineInsts = [rt, railT, riverT, borderT];
  const addrT = createAddressTool({ view, F: features, session, layer: roadLayer, refreshPanel: () => renderOpts(), borderT });
  const shapes = createShapeTools({ view, F: features, session, layer: roadLayer, refreshPanel: () => renderOpts(), store, roadTools: rt });
  view.layers.push({ draw: (c, v) => {
    if (st.tool === 'road' || st.tool === 'airport') rt.overlay.draw(c, v);
    if (st.tool === 'rail') railT.overlay.draw(c, v);
    if (st.tool === 'river') riverT.overlay.draw(c, v);
    if (st.tool === 'addr') addrT.overlay.draw(c, v);
    if (st.tool === 'select') { for (const i of lineInsts) i.overlay.draw(c, v); shapes.overlay.draw(c, v); }
    if (['building', 'area', 'station', 'poi', 'airport'].includes(st.tool)) shapes.overlay.draw(c, v);
  } });
  const validateAll = () => [rt.validate(), railT.validate(), riverT.validate(), borderT.validate(), addrT.validate(), shapes.validate()].some(Boolean);
  const busy = () => lineInsts.some((i) => i.isBusy()) || shapes.isBusy();

  // ---------- 選択ツール：道路・鉄道・川・交差点・駅・建物・範囲・施設を選んで編集 ----------
  const selectTool = (() => {
    let active = null, press = null;
    const busyLine = () => lineInsts.find((i) => i.isBusy());
    const clearAll = (except) => { for (const i of lineInsts) if (i !== except) i.deselect(); if (except !== shapes) shapes.clear(); };
    const lineSel = () => lineInsts.find((i) => i.hasSelection());
    function pick(w, p) {
      const sh = shapes.hitAt(w, p);
      if (sh?.strong) { clearAll(shapes); shapes.selectShape(sh.f.id); return; }
      let best = null;
      for (const i of lineInsts) { const hit = i.hitAt(p); if (hit && (!best || hit.d < best.hit.d)) best = { i, hit }; }
      if (best) { clearAll(best.i); best.i.selectHit(best.hit); return; }
      if (sh) { clearAll(shapes); shapes.selectShape(sh.f.id); return; }
      clearAll(); renderOpts(); view.requestDraw();
    }
    return {
      cursor: 'default',
      down(w, e, p) {
        const b = busyLine();
        if (b) { active = b.editTool; return active.down(w, e, p); }
        const ls = lineSel();
        if (ls && ls.handleAt(p)) { active = ls.editTool; return active.down(w, e, p); }
        const k = shapes.selectedKind();
        if (k && shapes.handleAt(p, w)) { active = shapes.tools[k]; return active.down(w, e, p); }
        active = null; press = { p, x: view.x, z: view.z, moved: false };
      },
      move(w, e, p) {
        if (active) return active.move?.(w, e, p);
        if (!press) return;
        if (!press.moved && Math.hypot(p[0] - press.p[0], p[1] - press.p[1]) > 4) press.moved = true;
        if (press.moved) view.setView(press.x - (p[0] - press.p[0]) / view.scale, press.z - (p[1] - press.p[1]) / view.scale);
      },
      up(w, e, p) {
        if (active) { const a = active; active = null; a.up?.(w, e, p); renderOpts(); return; }
        const pr = press; press = null;
        if (pr && !pr.moved) pick(w, p);
      },
      hover(w, e, p) {
        const b = busyLine();
        if (b) return b.editTool.hover(w, e, p);
        const k = shapes.selectedKind();
        if (k) return shapes.tools[k].hover(w, e, p);
        const ls = lineSel();
        canvas.style.cursor = ls && ls.handleAt(p) ? 'grab' : 'default';
      },
      key(e) {
        const b = busyLine() || lineSel();
        if (b) return b.editTool.key(e);
        const k = shapes.selectedKind();
        if (k) return shapes.tools[k].key(e);
        return false;
      },
      deactivate() { const b = busyLine(); if (b) b.editTool.deactivate(); clearAll(); },
      renderPanel(box) {
        const b = busyLine() || lineSel();
        if (b) return b.renderPanel(box);
        const k = shapes.selectedKind();
        if (k) return shapes.renderPanel(box, k === 'area' || k === 'building' || k === 'station' || k === 'poi' ? k : 'building');
        box.replaceChildren(h('h3', {}, '選択'), h('div', { class: 'hint' },
          h('div', {}, '道路・鉄道・川・交差点・駅・建物・範囲・施設をクリックすると、選んで編集できます。'),
          h('div', {}, '選んだ道路は中間点をドラッグ、線の上の「＋」で中間点を追加、端の中間点から延ばすこともできます。'),
          h('div', {}, '何もない所をドラッグすると地図を動かせます。')));
      },
    };
  })();
  features.onChange = () => { view.requestDraw(); if (validateAll()) renderOpts(); };

  // ---------- 状態 ----------
  const st = { tool: 'hand', v: T.LAND, width: 20 };
  const others = new Map();     // 他の編集者のカーソル

  session.onStatus = (s, msg) => {
    status.className = `status ${s}`;
    status.textContent = msg || { saved: '保存済み', unsaved: '未保存の変更あり', saving: '保存中…', busy: '処理中…', error: 'エラー' }[s];
    if (s === 'busy') toast(msg || '処理中…', 0); else hideToast();
  };
  session.onHistory = () => { undoBtn.disabled = !session.undoStack.length; redoBtn.disabled = !session.redoStack.length; };
  const undo = () => { if (busy()) return; session.undo().then(() => { validateAll(); renderOpts(); }); };
  const redo = () => { if (busy()) return; session.redo().then(() => { validateAll(); renderOpts(); }); };
  undoBtn.onclick = undo; redoBtn.onclick = redo;
  async function saveNow() {
    saveBtn.disabled = true;
    try {
      const ok = await session.saveNow();
      toast(ok ? '保存しました' : '保存に失敗しました。通信状態を確認してもう一度押してください', ok ? 1600 : 5000);
    } finally { saveBtn.disabled = false; }
  }
  window.addEventListener('beforeunload', (e) => { if (session.hasUnsaved) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- ツール ----------
  let penPts = null, hoverW = null;
  const tools = {
    hand: { pan: true, cursor: 'grab' },
    pen: {
      cursor: 'crosshair',
      down(w) { penPts = [round(w)]; view.requestDraw(); },
      move(w) {
        const last = penPts[penPts.length - 1];
        const minD = Math.max(st.width * 0.15, view.mpp * 2, 0.5);
        if (Math.hypot(w[0] - last[0], w[1] - last[1]) >= minD) { penPts.push(round(w)); view.requestDraw(); }
        hoverW = w;
      },
      up(w) {
        const last = penPts[penPts.length - 1];
        if (w[0] !== last[0] || w[1] !== last[1]) penPts.push(round(w));
        const op = { t: 'stroke', pts: penPts, w: st.width, v: st.v };
        session.doOp(op).finally(() => { penPts = null; view.requestDraw(); });
      },
      cancel() { penPts = null; view.requestDraw(); },
      hover(w) { hoverW = w; view.requestDraw(); },
      deactivate() { hoverW = null; },
    },
    fill: {
      cursor: 'cell',
      down(w) {
        const x = Math.floor(w[0]), z = Math.floor(w[1]);
        if (!inside(mb, x, z)) return toast('マップの範囲外です');
        session.doOp({ t: 'fill', x, z, v: st.v });
      },
    },
    image: imageTool(),
    road: rt.roadTool,
    rail: railT.roadTool,
    river: riverT.roadTool,
    addr: addrT.tool,
    select: selectTool,
    station: shapes.tools.station,
    airport: shapes.tools.airport,
    building: shapes.tools.building,
    area: shapes.tools.area,
    poi: shapes.tools.poi,
  };
  function imageTool() {
    let drag = null;
    return {
      cursor: 'default',
      down(w, e, p) {
        const sel = overlays.selected;
        if (sel) {
          const hs = overlays.handles(sel);
          const i = hs.findIndex(([x, y]) => Math.abs(x - p[0]) < 10 && Math.abs(y - p[1]) < 10);
          if (i >= 0) {
            const opp = [[sel.x + sel.w, sel.z + sel.w * sel.ar], [sel.x, sel.z + sel.w * sel.ar], [sel.x, sel.z], [sel.x + sel.w, sel.z]][i];
            drag = { kind: 'resize', it: sel, corner: i, anchor: opp };
            return;
          }
        }
        const hit = overlays.hit(...w);
        overlays.selectedId = hit ? hit.id : null;
        renderOpts();
        if (hit) drag = { kind: 'move', it: hit, ox: w[0] - hit.x, oz: w[1] - hit.z };
        view.requestDraw();
      },
      move(w) {
        if (!drag) return;
        const it = drag.it;
        if (drag.kind === 'move') { it.x = Math.round(w[0] - drag.ox); it.z = Math.round(w[1] - drag.oz); }
        else {
          const [ax, az] = drag.anchor;
          const nw = Math.max(4, Math.max(Math.abs(w[0] - ax), Math.abs(w[1] - az) / it.ar));
          it.w = Math.round(nw * 100) / 100;
          const c = drag.corner;
          it.x = c === 0 || c === 3 ? ax - it.w : ax;
          it.z = c === 0 || c === 1 ? az - it.w * it.ar : az;
        }
        view.requestDraw(); syncFields();
      },
      up() {
        if (!drag) return;
        const { it } = drag; drag = null;
        saveOverlay(it, { x: it.x, z: it.z, w: it.w });
      },
      hover(w, e, p) {
        const sel = overlays.selected;
        let cur = 'default';
        if (sel) {
          const hs = overlays.handles(sel);
          const i = hs.findIndex(([x, y]) => Math.abs(x - p[0]) < 10 && Math.abs(y - p[1]) < 10);
          if (i >= 0) cur = i % 2 === 0 ? 'nwse-resize' : 'nesw-resize';
          else if (overlays.hit(...w) === sel) cur = 'move';
        }
        canvas.style.cursor = cur;
      },
    };
  }

  // ペンのプレビューとカーソル円、他の人のカーソル
  view.layers.push({
    draw(ctx, v) {
      ctx.save();
      if (penPts) {
        ctx.strokeStyle = T_COLORS[st.v]; ctx.globalAlpha = 0.85;
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(1, st.width * v.scale);
        ctx.beginPath();
        penPts.forEach((p, i) => { const [x, y] = v.toScreen(...p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        if (penPts.length === 1) { const [x, y] = v.toScreen(...penPts[0]); ctx.lineTo(x + 0.01, y); }
        ctx.stroke();
        ctx.globalAlpha = 1; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1; ctx.stroke();
      }
      if (st.tool === 'pen' && hoverW) {
        const [x, y] = v.toScreen(...hoverW);
        const r = Math.max(2, (st.width / 2) * v.scale);
        ctx.strokeStyle = 'rgba(30,35,41,.7)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.font = '11px system-ui'; ctx.fillStyle = 'rgba(30,35,41,.8)';
        ctx.fillText(fmtDist(st.width), x + Math.min(r, 40) + 6, y - 6);
      }
      for (const o of others.values()) {
        if (performance.now() - o.t > 15000) continue;
        const [x, y] = v.toScreen(o.x, o.z);
        const col = colorFor(o.email);
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 4, y + 14); ctx.lineTo(x + 8, y + 9); ctx.lineTo(x + 14, y + 8); ctx.closePath(); ctx.fill();
        ctx.font = '11px system-ui';
        const label = (o.email || '').split('@')[0];
        const tw = ctx.measureText(label).width;
        ctx.fillRect(x + 12, y + 14, tw + 10, 18);
        ctx.fillStyle = '#fff'; ctx.fillText(label, x + 17, y + 27);
      }
      ctx.restore();
    },
  });

  // ---------- 左ツールバー ----------
  const toolDefs = [
    ['hand', 'hand', '移動 (H / Space+ドラッグ)'],
    ['select', 'cursor', '選択して編集 (V)'],
    ['pen', 'pen', 'ペン：水・陸・森 (B)'],
    ['fill', 'fill', '塗りつぶし (G)'],
    ['image', 'image', '画像レイヤー (I)'],
    ['road', 'road', '道路・交差点 (R)'],
    ['river', 'river', '川 (W)'],
    ['rail', 'train', '鉄道 (T)'],
    ['station', 'station', '駅 (S)'],
    ['airport', 'plane', '空港 (A)'],
    ['building', 'building', '建物 (K)'],
    ['area', 'lasso', '範囲：IC・JCT・公園・森・山 (J)'],
    ['poi', 'pin', '施設・名所 (P)'],
    ['addr', 'addr', '住所：境界線と地名 (L)'],
  ];
  const toolBtns = {};
  const toolbar = h('div', { class: 'toolbar' },
    ...toolDefs.map(([id, ic, tip]) => (toolBtns[id] = h('button', { class: 'icon-btn', title: tip, 'aria-label': tip, onclick: () => setTool(id) }, icon(ic)))),
  );
  const opts = h('div', { class: 'opts' });
  body.append(toolbar, opts, coordsBox(view), zoomBox(view));

  function setTool(id) {
    st.tool = id;
    Object.entries(toolBtns).forEach(([k, b]) => b.classList.toggle('on', k === id));
    view.setTool(tools[id]);
    overlays.enabled = true;
    if (id !== 'image') { overlays.selectedId = null; view.requestDraw(); }
    renderOpts();
  }

  // ---------- オプションパネル ----------
  let syncFields = () => {};
  function renderOpts() {
    syncFields = () => {};
    opts.style.display = '';
    if (st.tool === 'hand') {
      opts.replaceChildren(
        h('h3', {}, 'WOOP MAP 編集'),
        h('div', { class: 'muted', html:
          'ドラッグで移動、ホイール/ピンチで拡大縮小。<br>どのツールでも <b>Space+ドラッグ</b> または右ドラッグで移動できます。<br><br>' +
          '<b>選択（V）</b>で、描いたものをクリックして直せます。<br><br>① <b>画像レイヤー</b>でマイクラのマップ画像を読み込み<br>② <b>塗りつぶし</b>で全体を水や陸に<br>③ <b>ペン</b>で海岸線や森をなぞる<br>④ <b>道路・鉄道</b>で中間点を置きながら線を描く<br>⑤ <b>駅・空港・建物・範囲・施設</b>を置いていく<br>⑥ <b>住所</b>で境界線を引いて地名を付ける<br><br>' +
          `マップの範囲：${sizeLabel(mb)}（X ${mb.x0.toLocaleString()}〜${mb.x1.toLocaleString()} / Z ${mb.z0.toLocaleString()}〜${mb.z1.toLocaleString()}、1マス=1m）。範囲は管理画面で変更できます` }),
      );
      return;
    }
    if (st.tool === 'pen' || st.tool === 'fill') {
      const kinds = [T.LAND, T.WATER, T.FOREST, T.NONE];
      const chips = h('div', { class: 'chips' }, ...kinds.map((v) =>
        h('button', { class: `chip ${st.v === v ? 'on' : ''}`, onclick: () => { st.v = v; renderOpts(); } },
          h('span', { class: 'sw', style: { background: v === T.NONE ? 'repeating-linear-gradient(45deg,#e9ebee 0 4px,#fff 4px 8px)' : T_COLORS[v] } }),
          v === T.NONE ? '消しゴム' : T_NAMES[v])));
      const parts = [h('h3', {}, st.tool === 'pen' ? 'ペン' : '塗りつぶし'), h('label', { class: 'lbl' }, '種類'), chips];
      if (st.tool === 'pen') {
        const num = h('input', { type: 'number', min: 1, max: MAX_W, value: st.width });
        const rng = h('input', { type: 'range', min: 0, max: 1000, value: sliderFromW(st.width) });
        const setW = (w) => { st.width = Math.max(1, Math.min(MAX_W, Math.round(w))); num.value = st.width; rng.value = sliderFromW(st.width); view.requestDraw(); };
        rng.oninput = () => setW(wFromSlider(+rng.value));
        num.onchange = () => setW(+num.value || 1);
        parts.push(h('div', { class: 'row' }, h('label', { class: 'lbl' }, '太さ（メートル・最大 5km）'),
          h('div', { class: 'width-row' }, rng, num),
          h('div', { class: 'presets' }, ...[1, 5, 20, 100, 500, 1000, 5000].map((w) => h('button', { onclick: () => setW(w) }, fmtDist(w)))),
          h('div', { class: 'muted', style: { marginTop: '8px' } }, '[ と ] キーでも太さを変えられます。')));
        syncFields = () => setW(st.width);
      } else {
        parts.push(h('div', { class: 'muted', style: { marginTop: '12px' } },
          'クリックした場所とつながっている同じ種類の範囲を塗ります。マップ全体（最大100km四方）でも一瞬で塗れます。'));
      }
      opts.replaceChildren(...parts);
      return;
    }
    if (st.tool === 'image') renderImageOpts();
    if (st.tool === 'road') rt.renderPanel(opts);
    if (st.tool === 'rail') railT.renderPanel(opts);
    if (st.tool === 'river') riverT.renderPanel(opts);
    if (st.tool === 'addr') addrT.renderPanel(opts);
    if (st.tool === 'select') selectTool.renderPanel(opts);
    if (['building', 'area', 'station', 'poi', 'airport'].includes(st.tool)) shapes.renderPanel(opts, st.tool);
  }

  function renderImageOpts() {
    const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onchange: () => { if (file.files[0]) uploadImage(file.files[0]); file.value = ''; } });
    const list = h('div', { class: 'layer-list' });
    const items = [...overlays.items].reverse();
    if (!items.length) list.append(h('div', { class: 'muted' }, 'まだ画像がありません。マイクラのマップMODで書き出した画像をアップロードしてください。'));
    for (const it of items) {
      list.append(h('div', { class: `layer ${overlays.selectedId === it.id ? 'on' : ''}`, onclick: () => { overlays.selectedId = it.id; renderOpts(); view.requestDraw(); } },
        h('img', { src: it.url, alt: '' }),
        h('span', { class: 'nm' }, it.name || '画像'),
        h('button', { class: 'icon-btn', title: it.visible ? '非表示にする' : '表示する', onclick: (e) => { e.stopPropagation(); it.visible = !it.visible; saveOverlay(it, { visible: it.visible }); renderOpts(); view.requestDraw(); } }, icon(it.visible ? 'eye' : 'eyeoff')),
      ));
    }
    const parts = [h('h3', {}, '画像レイヤー'),
      h('button', { class: 'btn primary', style: { width: '100%', justifyContent: 'center' }, onclick: () => file.click() }, icon('upload'), '画像をアップロード'), file,
      h('div', { class: 'muted', style: { marginTop: '6px' } }, '画像は編集モードでだけ表示され、表示モードには出ません。縦横比は固定です。'),
      list];
    const s = overlays.selected;
    if (s) {
      const fx = h('input', { type: 'number', step: 1 }), fz = h('input', { type: 'number', step: 1 }), fw = h('input', { type: 'number', step: 1, min: 1 });
      const op = h('input', { type: 'range', min: 5, max: 100, value: Math.round(s.opacity * 100) });
      const opl = h('span', { class: 'muted' });
      syncFields = () => {
        fx.value = Math.round(s.x); fz.value = Math.round(s.z); fw.value = Math.round(s.w * 100) / 100;
        opl.textContent = `${Math.round(s.opacity * 100)}%`;
      };
      syncFields();
      const commit = () => { s.x = +fx.value; s.z = +fz.value; s.w = Math.max(1, +fw.value); view.requestDraw(); saveOverlay(s, { x: s.x, z: s.z, w: s.w }); };
      fx.onchange = fz.onchange = fw.onchange = commit;
      op.oninput = () => { s.opacity = +op.value / 100; opl.textContent = `${op.value}%`; view.requestDraw(); };
      op.onchange = () => saveOverlay(s, { opacity: s.opacity });
      const idx = overlays.items.indexOf(s);
      parts.push(h('div', { class: 'row', style: { borderTop: '1px solid var(--line)', paddingTop: '12px' } },
        h('label', { class: 'lbl' }, `選択中：${s.name || '画像'}`),
        h('div', { class: 'grid2' },
          h('div', {}, h('label', {}, '左上 X'), fx), h('div', {}, h('label', {}, '左上 Z'), fz),
          h('div', {}, h('label', {}, '幅 (m)'), fw), h('div', {}, h('label', {}, '高さ (m)'), h('input', { type: 'text', disabled: true, value: fmt(s.w * s.ar) }))),
        h('div', { class: 'row' }, h('label', { class: 'lbl' }, '透明度 ', opl), op),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', title: '画像の1ピクセルを1ブロック(1m)にする', onclick: () => { s.w = s.img.naturalWidth; syncFields(); view.requestDraw(); saveOverlay(s, { w: s.w }); } }, '1px = 1ブロック'),
          h('button', { class: 'btn', onclick: () => { view.setView(s.x + s.w / 2, s.z + (s.w * s.ar) / 2, Math.min(view.w / s.w, view.h / (s.w * s.ar)) * 0.9); } }, 'ここへ移動'),
          h('button', { class: 'btn', disabled: idx >= overlays.items.length - 1, onclick: () => reorder(s, 1) }, icon('up'), '前面'),
          h('button', { class: 'btn', disabled: idx <= 0, onclick: () => reorder(s, -1) }, icon('down'), '背面'),
          h('button', { class: 'btn danger', onclick: () => removeOverlay(s) }, icon('trash'), '削除')),
        h('div', { class: 'muted', style: { marginTop: '8px' } }, '地図上で画像をドラッグすると移動、四隅をドラッグすると拡大縮小できます。'),
      ));
    }
    opts.replaceChildren(...parts);
  }

  async function uploadImage(f) {
    toast('画像を読み込み中…', 0);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(f); });
      const w = img.naturalWidth, ar = img.naturalHeight / img.naturalWidth;
      const meta = {
        name: f.name, x: Math.round(view.x - w / 2), z: Math.round(view.z - (w * ar) / 2), w, ar,
        opacity: 0.5, visible: true, ord: (overlays.items.at(-1)?.ord ?? 0) + 1,
      };
      const row = await store.addOverlay(f, meta);
      overlays.set([...overlays.items, row]);
      overlays.selectedId = row.id;
      renderOpts();
      view.setView(meta.x + w / 2, meta.z + (w * ar) / 2, Math.min(view.w / w, view.h / (w * ar)) * 0.85);
      hideToast();
      toast('配置しました（1px = 1ブロック）。位置は数値かドラッグで合わせてください');
    } catch (e) { console.error(e); toast('画像のアップロードに失敗しました'); }
  }
  async function saveOverlay(it, patch) { try { await store.updateOverlay(it.id, patch); } catch (e) { console.error(e); toast('画像の保存に失敗しました'); } }
  async function reorder(s, dir) {
    const arr = overlays.items; const i = arr.indexOf(s); const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    const a = arr[i], b = arr[j];
    [a.ord, b.ord] = [b.ord, a.ord];
    if (a.ord === b.ord) a.ord += dir;
    overlays.set([...arr]);
    renderOpts();
    await Promise.all([saveOverlay(a, { ord: a.ord }), saveOverlay(b, { ord: b.ord })]);
  }
  async function removeOverlay(s) {
    if (!(await ask(`「${s.name || '画像'}」を削除しますか？`, '削除'))) return;
    await store.deleteOverlay(s.id);
    overlays.selectedId = null;
    overlays.set(overlays.items.filter((i) => i !== s));
    renderOpts();
  }
  overlays.onChange = () => { if (st.tool === 'image') renderOpts(); };

  // ---------- キーボード ----------
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); return; }
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    if (tools[st.tool]?.key?.(e)) { e.preventDefault(); return; }
    const k = e.key.toLowerCase();
    if (k === 'h') setTool('hand');
    else if (k === 'b') setTool('pen');
    else if (k === 'g') setTool('fill');
    else if (k === 'i') setTool('image');
    else if (k === 'r') setTool('road');
    else if (k === 'j') setTool('area');
    else if (k === 't') setTool('rail');
    else if (k === 'v') setTool('select');
    else if (k === 'w') setTool('river');
    else if (k === 'l') setTool('addr');
    else if (k === 's') setTool('station');
    else if (k === 'a') setTool('airport');
    else if (k === 'k') setTool('building');
    else if (k === 'p') setTool('poi');
    else if (e.key === '[' || e.key === ']') { st.width = Math.max(1, Math.min(MAX_W, Math.round(st.width * (e.key === ']' ? 1.25 : 0.8)) + (e.key === ']' ? 1 : 0))); syncFields(); view.requestDraw(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && st.tool === 'image' && overlays.selected) removeOverlay(overlays.selected);
  });

  // ---------- 読み込みと同期 ----------
  setTool('hand');
  session.onStatus('busy', '地形を読み込み中…');
  try {
    await session.load((n) => session.onStatus('busy', `地形を読み込み中… ${n.toLocaleString()} チャンク`));
    overlays.set(await store.listOverlays());
    session.onStatus('saved');
  } catch (e) {
    console.error(e); session.onStatus('error', '読み込みに失敗しました');
  }
  view.resetCache();

  const renderPeople = (list) => {
    people.replaceChildren(...list.filter(Boolean).slice(0, 6).map((p) =>
      h('span', { title: p.email, style: { background: colorFor(p.email) } }, (p.email || '?')[0].toUpperCase())));
  };
  store.subscribe({
    onOp: (op) => session.applyRemote(op),
    onReload: (list) => session.reload(list),
    onOverlays: async () => overlays.set(await store.listOverlays()),
    onPresence: (from, s) => {
      others.set(from, { ...s, t: performance.now() });
      view.requestDraw();
    },
    onPeople: (list) => renderPeople(list),
  });
  let lastSend = 0;
  const prevPW = view.onPointerWorld;
  view.onPointerWorld = (w) => {
    prevPW(w);
    const now = performance.now();
    if (now - lastSend > 120) { lastSend = now; store.trackPresence({ email: store.user?.email, x: w[0], z: w[1] }); }
  };
  // 古いカーソルを消す
  setInterval(() => view.requestDraw(), 5000);
}

function round(w) { return [Math.round(w[0] * 4) / 4, Math.round(w[1] * 4) / 4]; }
