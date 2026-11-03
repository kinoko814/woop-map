// =============================================================
// 表示モード (一般ユーザー向け)
//   左上：検索バー（名前で検索）と経路検索、上：カテゴリのショートカット
//   右：距離を測る・場所を共有、右下：拡大縮小
//   クリックで施設・駅・地名などの情報パネル、何もない所なら住所と座標
// =============================================================
import { h, icon, toast, hideToast } from './dom.js';
import { coordsBox, zoomBox } from './chrome.js';
import { boundsOf } from '../bounds.js';
import { Terrain, T } from '../engine/terrain.js';
import { MapView, fmt, fmtDist } from '../engine/view.js';
import { applyRows } from '../session.js';
import { Features } from '../engine/features.js';
import { RoadLayer } from '../engine/roadlayer.js';
import { inPoly, centroid, tessellate, ROAD_TYPES } from '../engine/roads.js';
import { AREA_TYPES, viewSpan } from '../engine/shapes.js';
import { ICONS, iconSvg } from '../engine/icons.js';
import { RAIL_TYPES, railColor } from '../engine/rails.js';
import { ADDR_LEVELS, levelIndex } from '../engine/address.js';
import { routeRoad, routeTrain, fmtTime, MODES } from '../engine/route.js';
import { createPlacePanel } from './place.js';
import { reviewSection } from './reviews.js';
import { describe, stationTitle } from './describe.js';
import { BUS_STOP_COLOR } from '../engine/bus.js';
const hubTitle = (f) => (!f ? '' : f.kind === 'busstop' ? `${f.name || 'バス停'}（バス停）` : stationTitle(f));

const START_SPAN = 5000;   // 表示モードを開いたときの画面の横幅（m）
const CATEGORIES = [['conv', 'コンビニ'], ['food', '食堂'], ['cafe', 'カフェ'], ['restaurant', 'レストラン'], ['super', 'スーパー'], ['hotel', 'ホテル'], ['gas', 'ガソリンスタンド'], ['ev', 'EVスタンド'], ['hospital', '病院'], ['parking', '駐車場'], ['bank', '銀行'], ['pharmacy', '薬局']];

export async function startViewer(root, store, { backToEdit, toLogin, loggedIn } = {}) {
  const map = store.map;
  const mb = boundsOf(map);
  const terrain = new Terrain({ bounds: mb });
  const features = new Features();
  const canvas = h('canvas');
  const wrap = h('div', { class: 'map-wrap' }, canvas);
  document.title = `${map.name} - WOOP MAP`;

  const view = new MapView(canvas, terrain);
  view.showGrid = false;
  const layer = new RoadLayer(view, features);
  layer.isWater = (x, z) => terrain.cell(x, z) === T.WATER;   // 川を海につなげて見せる
  view.layers.push(layer);
  const A = layer.addr;

  // ---------- 骨組み ----------
  const qInput = h('input', { type: 'text', placeholder: '場所・座標（例 100,-200）を検索', 'aria-label': '場所を検索', autocomplete: 'off' });
  const suggest = h('div', { class: 'suggest', hidden: true });
  const search = h('div', { class: 'v-top' },
    h('div', { class: 'v-search' },
      h('span', { class: 'logo', title: map.name }, h('i', {}, 'W')), qInput,
      h('button', { class: 'icon-btn', title: '検索', onclick: () => runSearch(true) }, icon('search')),
      h('span', { class: 'v-sep' }),
      h('button', { class: 'icon-btn route-btn', title: '経路検索', onclick: () => openRoute() }, icon('route'))),
    suggest);
  const chips = h('div', { class: 'v-chips' }, ...CATEGORIES.map(([k, l]) => h('button', { class: 'v-chip', 'data-k': k, onclick: () => toggleCategory(k) }, iconSvg(k, 18), l)));
  const popup = h('div', { class: 'v-popup', hidden: true });
  const tools = h('div', { class: 'v-tools' },
    h('button', { class: 'icon-btn', id: 'measure-btn', title: '距離を測る', onclick: () => toggleMeasure() }, icon('ruler')),
    h('button', { class: 'icon-btn', title: 'この場所を共有', onclick: () => share() }, icon('share')));
  root.replaceChildren(wrap, popup);
  const place = createPlacePanel(root, { onClose: () => { layer.selected = null; route.active = false; layer.poiFilter = null; markChips(); view.requestDraw(); } });
  root.append(search, chips, tools, coordsBox(view), zoomBox(view, { grid: false }));
  if (backToEdit) root.append(h('button', { class: 'btn v-back', onclick: backToEdit }, icon('edit'), '編集に戻る'));
  else if (toLogin) root.append(h('button', { class: 'btn v-back', onclick: toLogin }, icon('edit'), loggedIn ? '編集する' : 'ログインして編集'));
  // 最初は、管理画面で指定した地点を、画面の横幅いっぱいで 5km が入るくらいに拡大して表示
  {
    const hx = Number.isFinite(map.home_x) ? map.home_x : Math.max(mb.x0, Math.min(mb.x1, 0));
    const hz = Number.isFinite(map.home_z) ? map.home_z : Math.max(mb.z0, Math.min(mb.z1, 0));
    view._resize();   // 画面に置いた直後の大きさで計算
    view.setView(hx, hz, (view.w || window.innerWidth) / START_SPAN);
  }

  // ---------- 経路・距離の描画 ----------
  const route = { active: false, from: null, to: null, vias: [], mode: 'car', highway: true, main: true, picking: null, result: null };   // main: 主要道路を優先（最初からオン）
  const measure = { on: false, pts: [] };
  view.layers.push({ draw(ctx, v) {
    const line = (pts, color, w, dash) => {
      ctx.beginPath(); pts.forEach(([x, z], i) => { const [sx, sy] = v.toScreen(x, z); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash(dash || []);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = w + 4; ctx.stroke(); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke(); ctx.setLineDash([]);
    };
    ctx.save();
    const res = route.active ? route.result : null;
    if (res && !res.error) {
      if (res.mode === 'train') for (const l of res.legs) {
        if (l.kind === 'rail') line(l.pts, railColor(l.rail), 6);
        else if (l.kind === 'bus') line(l.pts, l.bus.color || BUS_STOP_COLOR, 5.5);
        else if (l.kind === 'walk' && l.pts.length > 1) line(l.pts, '#2f6fcf', 3.5, [2, 7]);
      }
      else line(res.pts, res.mode === 'car' ? '#2f6fcf' : '#25a06b', res.mode === 'car' ? 6 : 4.5, res.mode === 'walk' ? [2, 8] : null);
    }
    if (route.active) {
      route.vias.forEach((p, i) => { if (p) pinMark(ctx, ...v.toScreen(...p.pt), '#e08a14', route.vias.filter(Boolean).length > 1 ? String(i + 1) : '経'); });
      for (const [p, c, t] of [[route.from, '#1f9d55', '出'], [route.to, '#e5484d', '着']]) if (p) pinMark(ctx, ...v.toScreen(...p.pt), c, t);
    }
    if (measure.pts.length) {
      line(measure.pts, '#e5484d', 2.5, [6, 4]);
      let tot = 0;
      measure.pts.forEach((p, i) => {
        const [x, y] = v.toScreen(...p);
        if (i) tot += Math.hypot(p[0] - measure.pts[i - 1][0], p[1] - measure.pts[i - 1][1]);
        ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#e5484d'; ctx.stroke();
        if (i) {
          const t = i === measure.pts.length - 1 ? `合計 ${fmtDist(tot)}` : fmtDist(tot);
          ctx.font = `${i === measure.pts.length - 1 ? 700 : 500} 12px "Noto Sans JP", system-ui`;
          const tw = ctx.measureText(t).width;
          ctx.fillStyle = '#fff'; ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 1;
          roundRect(ctx, x + 8, y - 22, tw + 12, 20, 4); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#c62828'; ctx.textBaseline = 'middle'; ctx.fillText(t, x + 14, y - 12);
        }
      });
    }
    ctx.restore();
  } });

  // ---------- クリック ----------
  let pin = null;
  view.setTool({ pan: true, cursor: 'grab' });
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w = view.toWorld(sx, sy);
    if (measure.on) { measure.pts.push(w); view.requestDraw(); return; }
    if (route.picking) { setEnd(route.picking, { pt: w, label: pointLabel(w) }); return; }
    const f = hitFeature(sx, sy, w);
    if (f) return open(f);
    place.open && !route.active && place.hide(); layer.selected = null; view.requestDraw();
    pin = [Math.floor(w[0]), Math.floor(w[1])];
    placePopup();
  });
  function hitFeature(sx, sy, w) {
    const inBox = (q) => sx >= q.box[0] && sx <= q.box[2] && sy >= q.box[1] && sy <= q.box[3];
    const bus = (layer.hits?.busstops || []).find((q) => Math.hypot(q.x - sx, q.y - sy) <= q.r);
    if (bus) return features.get(bus.id);
    const poi = (layer.hits?.pois || []).find((q) => Math.hypot(q.x - sx, q.y - sy) <= q.r);
    if (poi) return features.get(poi.id);
    for (const k of ['stations', 'areas', 'addr']) { const q = (layer.hits?.[k] || []).find(inBox); if (q) return features.get(q.id); }
    if (viewSpan(view) < 3000) { const st = [...features.ofKind('station')].find((f) => inPoly(f.poly, w[0], w[1])); if (st) return st; }
    if (view.mpp <= 45) { const ic = [...features.ofKind('area')].reverse().find((a) => AREA_TYPES[a.type]?.outlineOnly && inPoly(a.poly, w[0], w[1])); if (ic) return ic; }
    return [...features.ofKind('area')].filter((a) => !AREA_TYPES[a.type]?.outlineOnly && a.name && inPoly(a.poly, w[0], w[1]) && viewSpan(view) < AREA_TYPES[a.type].show)
      .sort((p, q) => polyArea(p.poly) - polyArea(q.poly))[0] || null;
  }
  const featPoint = (f) => (f.x !== undefined ? [f.x, f.z] : f.poly ? centroid(f.poly) : f.seeds?.[0] || [0, 0]);
  const featLabel = (f) => (f.kind === 'station' || f.kind === 'busstop' ? hubTitle(f) : f.name || '名前なし');
  function open(f) {
    pin = null; placePopup();
    route.active = false;
    layer.selected = f.id; view.requestDraw();
    const info = describe(features, f, { addr: A });
    if (f.kind === 'poi' || f.kind === 'station' || f.kind === 'area' || f.kind === 'busstop') {
      const pt = featPoint(f), label = featLabel(f);
      info.extra = h('div', {}, h('div', { class: 'place-actions' },
        h('button', { class: 'btn', onclick: () => { setEnd('from', { pt, label }, false); openRoute(); } }, '出発地にする'),
        h('button', { class: 'btn', onclick: () => { addVia({ pt, label }); openRoute(); } }, '経由地にする'),
        h('button', { class: 'btn primary', onclick: () => { setEnd('to', { pt, label }, false); openRoute(); } }, 'ここへ行く')),
        // 駅・施設は口コミと星
        f.kind === 'poi' || f.kind === 'station' ? reviewSection(store, f.id) : null);
    }
    place.show(info);
  }
  const pointLabel = (w) => {
    const onLand = terrain.cell(w[0], w[1]) !== T.WATER;
    return (onLand && A.addressText(w[0], w[1])) || `X ${fmt(w[0])} Z ${fmt(w[1])}`;
  };
  function placePopup() {
    if (!pin) { popup.hidden = true; return; }
    const [x, y] = view.toScreen(pin[0] + 0.5, pin[1] + 0.5);
    popup.hidden = false;
    popup.style.left = `${x}px`; popup.style.top = `${y}px`;
    const onLand = terrain.cell(pin[0], pin[1]) !== T.WATER;
    const addr = onLand ? A.addressText(pin[0] + 0.5, pin[1] + 0.5) : '';
    const w = [pin[0] + 0.5, pin[1] + 0.5];
    popup.replaceChildren(
      addr ? h('div', { class: 'addr' }, addr) : h('div', { class: 'muted' }, onLand ? '住所は未設定です' : '水の上'),
      h('div', { class: 'muted' }, `X: ${fmt(pin[0])}　Z: ${fmt(pin[1])}`),
      h('div', { class: 'pop-actions' },
        h('button', { onclick: () => { setEnd('from', { pt: w, label: pointLabel(w) }, false); openRoute(); } }, '出発'),
        h('button', { onclick: () => { addVia({ pt: w, label: pointLabel(w) }); openRoute(); } }, '経由'),
        h('button', { onclick: () => { setEnd('to', { pt: w, label: pointLabel(w) }, false); openRoute(); } }, '到着')));
  }
  const prevVC = view.onViewChange;
  view.onViewChange = () => { prevVC(); placePopup(); };

  // ---------- 検索 ----------
  function searchAll(q, limit = 8) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    const seenRoad = new Set();
    for (const f of features.items.values()) {
      let name = null, kind = '', iconEl = null;
      if (f.kind === 'poi') { name = f.name; kind = ICONS[f.icon]?.label; iconEl = iconSvg(f.icon, 22); }
      else if (f.kind === 'station') { name = stationTitle(f); kind = '駅'; }
      else if (f.kind === 'busstop' && f.name) { name = f.name; kind = 'バス停'; }
      else if (f.kind === 'addr') { name = f.name; kind = ADDR_LEVELS[levelIndex(f.level)]?.label; }
      else if (f.kind === 'area' && f.name) { name = AREA_TYPES[f.type]?.outlineOnly ? `${f.name} ${f.type === 'jct' ? 'JCT' : 'IC'}` : f.name; kind = AREA_TYPES[f.type]?.label; }
      else if ((f.kind === 'road' || f.kind === 'rail' || f.kind === 'river') && f.name && !seenRoad.has(f.kind + f.name)) { seenRoad.add(f.kind + f.name); name = f.name; kind = f.kind === 'road' ? '道路' : f.kind === 'rail' ? RAIL_TYPES[f.type]?.label : '川'; }
      else if (f.kind === 'building' && f.name) { name = f.name; kind = '建物'; }
      if (!name) continue;
      const n = name.toLowerCase(), i = n.indexOf(q);
      if (i < 0) continue;
      out.push({ f, name, kind, iconEl, score: (i === 0 ? 0 : 1) + n.length / 100 + (f.kind === 'poi' || f.kind === 'station' || f.kind === 'busstop' ? 0 : 0.3) });
    }
    return out.sort((a, b) => a.score - b.score).slice(0, limit);
  }
  function resultRow(r, onPick) {
    const pt = r.f.kind === 'road' || r.f.kind === 'rail' || r.f.kind === 'river' ? null : featPoint(r.f);
    return h('button', { class: 'sug-item', onclick: () => onPick(r) },
      r.iconEl || h('span', { class: 'sug-ic' }, r.f.kind === 'station' ? '駅' : r.f.kind === 'busstop' ? 'バ' : r.f.kind === 'addr' ? '地' : r.f.kind === 'road' ? '道' : r.f.kind === 'rail' ? '線' : '・'),
      h('span', { class: 'sug-txt' }, h('b', {}, r.name), h('span', { class: 'muted' }, [r.kind, pt ? A.addressText(...pt) : ''].filter(Boolean).join('・'))));
  }
  function flyTo(f) {
    if (f.kind === 'road' || f.kind === 'rail' || f.kind === 'river') {
      const g = tessellate(f, (id) => features.get(id));
      const [x0, z0, x1, z1] = g.bbox;
      view.setView((x0 + x1) / 2, (z0 + z1) / 2, Math.min(view.w / Math.max(50, x1 - x0), view.h / Math.max(50, z1 - z0)) * 0.8);
      return;
    }
    const [x, z] = featPoint(f);
    let s = 2;
    if (f.kind === 'addr') { const faces = A.namedFaces(levelIndex(f.level)).filter((e) => e.region.id === f.id); const b = faces[0]?.face.bbox; if (b) s = Math.min(view.w / (b[2] - b[0]), view.h / (b[3] - b[1])) * 0.8; }
    if (f.kind === 'area' && f.poly) { const xs = f.poly.map((p) => p[0]), zs = f.poly.map((p) => p[1]); s = Math.min(view.w / (Math.max(...xs) - Math.min(...xs) || 1), view.h / (Math.max(...zs) - Math.min(...zs) || 1)) * 0.6; }
    view.setView(x, z, Math.min(s, 3));
  }
  /** 「X,Z」と入力されたら座標とみなす（全角のカンマ・読点、空白も可） */
  function parseCoord(q) {
    const m = String(q).replace(/[－−]/g, '-').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .match(/^\s*[xX]?\s*(-?\d+(?:\.\d+)?)\s*[,，、]\s*[zZ]?\s*(-?\d+(?:\.\d+)?)\s*$/);
    return m ? [+m[1], +m[2]] : null;
  }
  function goCoord([x, z]) {
    suggest.hidden = true;
    view.setView(x, z, Math.max(view.scale, view.w / 1000));   // 画面の幅 1km くらいまで寄る
    layer.selected = null; place.open && !route.active && place.hide();
    pin = [Math.floor(x), Math.floor(z)];
    placePopup(); view.requestDraw();
  }
  function runSearch(enter) {
    const xz = parseCoord(qInput.value);
    if (xz) {
      if (enter) return goCoord(xz);
      suggest.replaceChildren(h('button', { class: 'sug-item', onclick: () => goCoord(xz) },
        h('span', { class: 'sug-ic' }, '座'), h('span', { class: 'sug-txt' }, h('b', {}, `X ${fmt(xz[0])}　Z ${fmt(xz[1])}`), h('span', { class: 'muted' }, 'この座標を表示'))));
      suggest.hidden = false;
      return;
    }
    const res = searchAll(qInput.value);
    if (enter && res[0]) { pickResult(res[0]); return; }
    suggest.replaceChildren(...res.map((r) => resultRow(r, pickResult)));
    suggest.hidden = !res.length;
    if (enter && !res.length) toast('見つかりませんでした');
  }
  function pickResult(r) {
    suggest.hidden = true; qInput.value = r.name;
    flyTo(r.f);
    if (r.f.kind === 'road' || r.f.kind === 'rail' || r.f.kind === 'river') return;
    open(r.f);
  }
  qInput.addEventListener('input', () => runSearch(false));
  qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(true); if (e.key === 'Escape') suggest.hidden = true; });
  qInput.addEventListener('focus', () => runSearch(false));

  // ---------- カテゴリのショートカット ----------
  let category = null;
  function markChips() { chips.querySelectorAll('.v-chip').forEach((c) => c.classList.toggle('on', c.dataset.k === category && !!layer.poiFilter)); }
  function toggleCategory(k) {
    if (category === k && layer.poiFilter) { category = null; layer.poiFilter = null; place.hide(); markChips(); view.requestDraw(); return; }
    category = k;
    const b = view.bounds();
    const c = [view.x, view.z];
    const list = [...features.ofKind('poi')].filter((p) => p.icon === k && p.x >= b.x0 && p.x <= b.x1 && p.z >= b.z0 && p.z <= b.z1)
      .map((p) => ({ p, d: Math.hypot(p.x - c[0], p.z - c[1]) })).sort((a, b2) => a.d - b2.d);
    layer.poiFilter = list.map((x) => x.p.id);
    layer.selected = null; route.active = false;
    markChips(); view.requestDraw();
    const label = CATEGORIES.find((x) => x[0] === k)[1];
    place.show({
      title: `${label}（${list.length}件）`, kind: '表示している範囲',
      extra: list.length ? h('div', { class: 'result-list' }, ...list.slice(0, 100).map(({ p, d }) => h('button', { class: 'sug-item', onclick: () => { view.setView(p.x, p.z, Math.max(view.scale, 1)); open(p); } },
        iconSvg(p.icon, 22), h('span', { class: 'sug-txt' }, h('b', {}, p.name || '名前なし'), h('span', { class: 'muted' }, [`中心から ${fmtDist(d)}`, p.address || A.addressText(p.x, p.z)].filter(Boolean).join('・'))))))
        : h('p', { class: 'place-desc' }, `いま見えている範囲に${label}はありません。地図を動かすか縮小してから、もう一度押してください。`),
    });
  }

  // ---------- 距離を測る ----------
  function toggleMeasure() {
    measure.on = !measure.on; measure.pts = [];
    document.getElementById('measure-btn').classList.toggle('on', measure.on);
    canvas.style.cursor = measure.on ? 'crosshair' : 'grab';
    toast(measure.on ? '地図をクリックして測りたい点を順に置いてください（もう一度ボタンで終了）' : '距離の計測を終えました');
    view.requestDraw();
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && measure.on) toggleMeasure(); if (e.key === 'Backspace' && measure.on && e.target === document.body) { measure.pts.pop(); view.requestDraw(); } });

  // ---------- 共有 ----------
  function shareUrl() {
    const u = new URL(location.href);
    u.searchParams.set('at', `${Math.round(view.x)},${Math.round(view.z)},${+view.scale.toFixed(4)}`);
    if (layer.selected) u.searchParams.set('sel', layer.selected); else u.searchParams.delete('sel');
    return u.toString();
  }
  async function share() {
    const url = shareUrl();
    const sel = layer.selected ? features.get(layer.selected) : null;
    const field = h('input', { type: 'text', readonly: true, value: url, onclick: (e) => e.target.select() });
    place.show({ title: sel ? featLabel(sel) : 'この場所', kind: '共有', desc: '下のリンクを送ると、同じ場所・同じ縮尺で地図が開きます。',
      extra: h('div', { style: { padding: '0 20px' } }, field, h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: async () => {
        try { await navigator.clipboard.writeText(url); toast('リンクをコピーしました'); } catch { field.select(); toast('リンクを選択しました。コピーしてください'); }
      } }, icon('copy'), 'リンクをコピー'))) });
  }

  // ---------- 経路検索 ----------
  const getEnd = (which) => (which.startsWith('via') ? route.vias[+which.slice(3)] : route[which]);
  function setEnd(which, val, recalc = true) {
    if (which.startsWith('via')) route.vias[+which.slice(3)] = val; else route[which] = val;
    route.picking = null;
    canvas.style.cursor = 'grab';
    if (recalc !== false || route.active) calc();
    renderRoute();
  }
  /** 経由地を追加（空いている欄があればそこに） */
  function addVia(val) {
    const i = route.vias.findIndex((x) => !x);
    if (i >= 0) route.vias[i] = val; else route.vias.push(val);
    if (route.active) { calc(); renderRoute(); }
  }
  /** 出発地 → 経由地 → … → 目的地 を、区間ごとに探してつなげる */
  function calc() {
    route.result = null;
    if (route.from && route.to) {
      const t0 = performance.now();
      const stops = [route.from, ...route.vias.filter(Boolean), route.to];
      const parts = [];
      for (let i = 0; i < stops.length - 1; i++) {
        const r = route.mode === 'train' ? routeTrain(features, stops[i].pt, stops[i + 1].pt) : routeRoad(features, route.mode, stops[i].pt, stops[i + 1].pt, { highway: route.highway, main: route.main });
        if (r.error) { route.result = { error: stops.length > 2 ? `${i === 0 ? '出発地' : `経由地${i}`} → ${i === stops.length - 2 ? '目的地' : `経由地${i + 1}`}：${r.error}` : r.error }; break; }
        parts.push(r);
      }
      if (!route.result) route.result = joinRoutes(parts, stops.slice(1, -1));
      route.ms = performance.now() - t0;
    }
    view.requestDraw();
  }
  function joinRoutes(parts, vias) {
    if (parts.length === 1) return parts[0];
    const out = { mode: parts[0].mode, pts: [], len: 0, time: 0, steps: [], legs: [], walkLen: 0 };
    parts.forEach((r, i) => {
      out.pts.push(...r.pts); out.len += r.len; out.time += r.time; out.walkLen += r.walkLen || 0;
      if (r.steps) out.steps.push(...r.steps);
      if (r.legs) out.legs.push(...r.legs);
      if (i < vias.length) {
        if (r.steps) out.steps.push({ via: true, name: vias[i].label, n: i + 1 });
        if (r.legs) out.legs.push({ kind: 'via', label: vias[i].label, n: i + 1, pts: [] });
      }
    });
    return out;
  }
  function openRoute() {
    route.active = true; layer.selected = null; layer.poiFilter = null; category = null; markChips();
    pin = null; placePopup();
    calc(); renderRoute();
  }
  function endField(which) {
    const v = getEnd(which);
    const isVia = which.startsWith('via'), vi = isVia ? +which.slice(3) : -1;
    const name = which === 'from' ? '出発地' : which === 'to' ? '目的地' : `経由地${route.vias.length > 1 ? vi + 1 : ''}`;
    const inp = h('input', { type: 'text', value: v?.label || '', placeholder: `${name}を検索`, 'aria-label': name });
    const sug = h('div', { class: 'suggest inline', hidden: true });
    inp.addEventListener('input', () => {
      const res = searchAll(inp.value, 6).filter((r) => !['road', 'rail', 'river'].includes(r.f.kind));
      sug.replaceChildren(...res.map((r) => resultRow(r, () => setEnd(which, { pt: featPoint(r.f), label: r.name }))));
      sug.hidden = !res.length;
    });
    return h('div', { class: 'route-end' },
      h('span', { class: `route-dot ${isVia ? 'via' : which}` }, which === 'from' ? '出' : which === 'to' ? '着' : route.vias.length > 1 ? String(vi + 1) : '経'),
      h('div', { class: 'route-in' }, inp, sug),
      h('button', { class: `btn ${route.picking === which ? 'primary' : ''}`, title: '地図をクリックして選ぶ', onclick: () => { route.picking = route.picking === which ? null : which; canvas.style.cursor = route.picking ? 'crosshair' : 'grab'; renderRoute(); } }, icon('pin')),
      isVia ? h('button', { class: 'icon-btn', title: 'この経由地を外す', onclick: () => { route.vias.splice(vi, 1); if (route.picking?.startsWith('via')) route.picking = null; calc(); renderRoute(); } }, icon('x')) : null);
  }
  function renderRoute() {
    if (!route.active) return;
    const res = route.result;
    const body = [
      h('div', { class: 'route-ends' }, endField('from'), ...route.vias.map((_, i) => endField(`via${i}`)), endField('to'),
        h('button', { class: 'icon-btn swap', title: '出発地と目的地を入れ替える', onclick: () => { [route.from, route.to] = [route.to, route.from]; route.vias.reverse(); calc(); renderRoute(); } }, icon('swap'))),
      route.vias.length < 8 ? h('button', { class: 'linklike add-via', onclick: () => { route.vias.push(null); route.picking = `via${route.vias.length - 1}`; canvas.style.cursor = 'crosshair'; renderRoute(); } }, '＋ 経由地を追加') : null,
      h('div', { class: 'seg route-modes' }, ...Object.entries(MODES).map(([k, m]) => h('button', { class: route.mode === k ? 'on' : '', onclick: () => { route.mode = k; calc(); renderRoute(); } }, m.label))),
      route.mode === 'car' ? h('div', { class: 'route-opts' },
        h('label', { class: 'check', style: { margin: '8px 0 0' } }, h('input', { type: 'checkbox', checked: route.main, onchange: (e) => { route.main = e.target.checked; calc(); renderRoute(); } }), '主要道路を優先する'),
        h('label', { class: 'check', style: { margin: '4px 0 0' } }, h('input', { type: 'checkbox', checked: route.highway, onchange: (e) => { route.highway = e.target.checked; calc(); renderRoute(); } }), '高速道路を使う')) : null,
      route.picking ? h('div', { class: 'hint', style: { marginTop: '10px' } }, `地図をクリックして${route.picking === 'from' ? '出発地' : route.picking === 'to' ? '目的地' : '経由地'}を選ぶか、上の欄で検索してください`) : null,
    ];
    if (!route.from || !route.to) body.push(h('p', { class: 'muted', style: { marginTop: '14px' } }, '出発地と目的地を、検索するか地図で選んでください。施設や駅の情報パネルの「ここへ行く」からも使えます。'));
    else if (res?.error) body.push(h('div', { class: 'route-err' }, res.error));
    else if (res) {
      body.push(h('div', { class: 'route-sum' }, h('b', {}, fmtTime(res.time)), h('span', {}, fmtDist(res.len)), res.mode === 'train' ? h('span', { class: 'muted' }, `うち徒歩 ${fmtDist(res.walkLen)}`) : null));
      if (res.mode === 'train') body.push(h('ol', { class: 'legs' }, ...res.legs.map((l) => l.kind === 'via'
        ? h('li', { class: 'leg leg-via' }, h('span', { class: 'route-dot via sm' }, res.legs.filter((x) => x.kind === 'via').length > 1 ? String(l.n) : '経'), h('div', {}, h('b', {}, `経由地：${l.label}`)))
        : l.kind === 'rail'
        ? h('li', { class: 'leg rail' }, h('span', { class: 'leg-line', style: { background: railColor(l.rail) } }), h('div', {}, h('b', {}, l.rail.name || RAIL_TYPES[l.rail.type].label), h('div', { class: 'muted' }, `${stationTitle(l.from)} → ${stationTitle(l.to)}（${l.stops}駅・${fmtDist(l.len)}）`)))
        : l.kind === 'bus' ? h('li', { class: 'leg rail' }, h('span', { class: 'leg-line', style: { background: l.bus.color || BUS_STOP_COLOR } }), h('div', {}, h('b', {}, `バス ${l.bus.name || ''}`), h('div', { class: 'muted' }, `${l.from?.name || 'バス停'} → ${l.to?.name || 'バス停'}（${l.stops}つ先・${fmtDist(l.len)}）`)))
        : l.kind === 'transfer' ? h('li', { class: 'leg' }, h('span', { class: 'leg-walk' }), h('div', { class: 'muted' }, `${stationTitle(l.from)}で乗り換え`))
        : h('li', { class: 'leg' }, h('span', { class: 'leg-walk' }), h('div', { class: 'muted' }, `徒歩 ${fmtDist(l.len)}（約${fmtTime(l.len / (MODES.walk.speed / 3.6))}）${l.to ? ` → ${hubTitle(l.to)}` : ' → 目的地'}`)))));
      else body.push(h('ol', { class: 'legs' }, ...res.steps.slice(0, 60).map((s2) => s2.via
        ? h('li', { class: 'leg leg-via' }, h('span', { class: 'route-dot via sm' }, res.steps.filter((x) => x.via).length > 1 ? String(s2.n) : '経'), h('div', {}, h('b', {}, `経由地：${s2.name}`)))
        : h('li', { class: 'leg' }, h('span', { class: s2.highway ? 'leg-hw' : 'leg-road' }), h('div', {}, h('b', {}, s2.name), h('span', { class: 'muted' }, ` ${fmtDist(s2.len)}`))))));
      body.push(h('p', { class: 'muted', style: { marginTop: '8px' } }, route.mode === 'train' ? '電車・バスの時間は目安です（時刻表は考えていません。乗るときの待ち時間を電車2分・バス3分として計算）。' : `時間は平均の速さ（${route.mode === 'car' ? '一般道 時速40km・高速 時速80km' : route.mode === 'walk' ? '時速4.8km' : '時速15km'}）で計算した目安です。${route.mode === 'walk' ? '' : 'カーブの多い道は速度を落として計算しています。'}${route.mode === 'car' && route.main ? '主要道路（黄色）と高速道路を優先して通ります。' : ''}`));
    }
    place.show({ title: '経路', kind: 'ルート検索', extra: h('div', { class: 'route-panel' }, ...body) });
  }

  // ---------- 読み込み ----------
  toast('マップを読み込み中…', 0);
  try {
    const rows = await store.loadTerrainMeta();
    applyRows(terrain, new Map(), rows);
    terrain.loader = (keys) => store.loadTerrainData(keys);
    features.load(await store.listFeatures());
    hideToast();
    view.resetCache();
    // 共有リンクの位置と選択
    const q = new URLSearchParams(location.search);
    const at = q.get('at')?.split(',').map(Number);
    if (at?.length === 3 && at.every(Number.isFinite)) view.setView(at[0], at[1], at[2]);
    const sel = q.get('sel') && features.get(q.get('sel'));
    if (sel) open(sel);
  } catch (e) { console.error(e); toast('読み込みに失敗しました'); }
  view.requestDraw();
}

function pinMark(ctx, x, y, color, t) {
  ctx.save();
  ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x - 4, y - 8, x - 12, y - 14, x - 12, y - 22); ctx.arc(x, y - 22, 12, Math.PI, 0); ctx.bezierCurveTo(x + 12, y - 14, x + 4, y - 8, x, y);
  ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = '800 12px "Noto Sans JP", system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, x, y - 22);
  ctx.restore();
}
function roundRect(ctx, x, y, w, h2, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h2, r); ctx.arcTo(x + w, y + h2, x, y + h2, r); ctx.arcTo(x, y + h2, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function polyArea(poly) { let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]); return Math.abs(a / 2); }
