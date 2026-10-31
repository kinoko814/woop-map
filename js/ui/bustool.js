// =============================================================
// 編集モード：バスツール
//   ① バス停を置く：道路の近くをクリックすると、その側の路肩にバス停ができる
//      バス停をクリックで選択（名前・説明を編集）、ドラッグで移動、Delete で削除
//   ② 路線を作る：路線を選んで（または新しく作って）、地図のバス停を順にクリック
//      停留所から次の停留所までは道路に沿って自動で道筋を引く
// =============================================================
import { h, icon, toast, ask } from './dom.js';
import { newId } from '../engine/features.js';
import { snapToRoad, routesAt, BUS_COLORS, drawBusMark } from '../engine/bus.js';

export function createBusTool({ view, F, session, layer, refreshPanel }) {
  const st = { mode: 'stop', stop: null, route: null };
  let press = null, ghost = null;

  const stopHit = (p) => (layer.hits?.busstops || []).find((q) => Math.hypot(q.x - p[0], q.y - p[1]) <= q.r)?.id || null;
  const routes = () => [...F.ofKind('busroute')].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
  const commit = (changes) => { session.commitFeatures(changes); view.requestDraw(); };
  const sync = () => { layer.selected = st.stop; layer.busActive = st.route; view.requestDraw(); };

  function selectStop(id) { st.stop = id; if (id) st.mode = st.mode === 'route' ? 'route' : 'stop'; sync(); refreshPanel(); }
  function selectRoute(id) { st.route = id; sync(); refreshPanel(); }
  function setMode(m) { st.mode = m; if (m === 'route') st.stop = null; sync(); refreshPanel(); view.canvas.style.cursor = tool.cursor; }

  function addStop(w) {
    const at = snapToRoad(F, w[0], w[1]);
    if (!at) return toast('バス停は道路の近くをクリックして置いてください');
    const n = [...F.ofKind('busstop')].length + 1;
    const s = { id: newId(), kind: 'busstop', x: at.x, z: at.z, road: at.road, name: `バス停${n}`, desc: '' };
    commit([{ id: s.id, after: s }]);
    selectStop(s.id);
  }
  function removeStop(id) {
    const s = F.get(id); if (!s) return;
    const changes = [{ id, after: null }];
    for (const r of routesAt(F, id)) changes.push({ id: r.id, after: { ...r, stops: r.stops.filter((x) => x !== id) } });
    commit(changes);
    if (st.stop === id) st.stop = null;
    sync(); refreshPanel();
  }
  function appendToRoute(stopId) {
    const r = st.route && F.get(st.route);
    if (!r) return toast('先に右のパネルで路線を選ぶか、新しい路線を作ってください');
    const stops = r.stops || [];
    if (stops[stops.length - 1] === stopId) return;
    commit([{ id: r.id, after: { ...r, stops: [...stops, stopId] } }]);
    refreshPanel();
  }
  function updateRoute(patch) { const r = F.get(st.route); if (r) { commit([{ id: r.id, after: { ...r, ...patch } }]); refreshPanel(); } }

  const tool = {
    get cursor() { return st.mode === 'stop' ? 'crosshair' : 'pointer'; },
    down(w, e, p) {
      const hit = stopHit(p);
      press = { p, x: view.x, z: view.z, moved: false, hit, drag: st.mode === 'stop' && hit && hit === st.stop };
    },
    move(w, e, p) {
      if (!press) return;
      if (!press.moved && Math.hypot(p[0] - press.p[0], p[1] - press.p[1]) > 4) press.moved = true;
      if (!press.moved) return;
      if (press.drag) { ghost = snapToRoad(F, w[0], w[1]) || { x: w[0], z: w[1], bad: true }; view.requestDraw(); return; }
      view.setView(press.x - (p[0] - press.p[0]) / view.scale, press.z - (p[1] - press.p[1]) / view.scale);
    },
    up(w, e, p) {
      const pr = press; press = null;
      if (!pr) return;
      if (pr.drag && pr.moved) {
        const g = ghost; ghost = null;
        if (g && !g.bad) { const s = F.get(st.stop); commit([{ id: s.id, after: { ...s, x: g.x, z: g.z, road: g.road } }]); }
        else { toast('バス停は道路の近くに置いてください'); view.requestDraw(); }
        return;
      }
      if (pr.moved) return;
      if (st.mode === 'stop') { if (pr.hit) selectStop(pr.hit); else addStop(w); }
      else if (pr.hit) appendToRoute(pr.hit);
    },
    hover(w, e, p) { view.canvas.style.cursor = stopHit(p) ? 'pointer' : tool.cursor; },
    key(e) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.mode === 'stop' && st.stop) { removeStop(st.stop); return true; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.mode === 'route' && st.route) {
        const r = F.get(st.route); if (r?.stops?.length) updateRoute({ stops: r.stops.slice(0, -1) }); return true;
      }
      if (e.key === 'Escape' && (st.stop || st.route)) { st.stop = null; if (st.mode === 'route') st.route = null; sync(); refreshPanel(); return true; }
      return false;
    },
    activate() { layer.busAll = true; sync(); },
    deactivate() { layer.busAll = false; layer.busActive = null; if (layer.selected === st.stop) layer.selected = null; ghost = null; view.requestDraw(); },
  };

  const overlay = {
    draw(ctx, v) {
      if (!ghost) return;
      const [x, y] = v.toScreen(ghost.x, ghost.z);
      ctx.save(); ctx.globalAlpha = ghost.bad ? 0.35 : 0.8; drawBusMark(ctx, x, y, 10, { selected: true }); ctx.restore();
    },
  };

  function renderPanel(box) {
    const seg = (opts, value, on) => h('div', { class: 'seg' }, ...opts.map(([l, v]) => h('button', { class: value === v ? 'on' : '', onclick: () => on(v) }, l)));
    const parts = [h('h3', {}, 'バス'), seg([['① バス停を置く', 'stop'], ['② 路線を作る', 'route']], st.mode, setMode)];
    if (st.mode === 'stop') {
      const s = st.stop && F.get(st.stop);
      if (!s) {
        parts.push(h('div', { class: 'hint' },
          h('div', {}, '道路の近くをクリックすると、クリックした側の路肩にバス停を置きます。'),
          h('div', {}, '置いたバス停をクリックすると、名前や説明を編集できます。選んだバス停はドラッグで動かせます。')));
      } else {
        const rs = routesAt(F, s.id);
        parts.push(
          h('label', { class: 'lbl', for: 'bus-name' }, '名前'),
          h('input', { type: 'text', id: 'bus-name', value: s.name || '', placeholder: '例：駅前', onchange: (e) => commit([{ id: s.id, after: { ...F.get(s.id), name: e.target.value.trim() } }]) }),
          h('label', { class: 'lbl', for: 'bus-desc' }, '説明'),
          h('textarea', { id: 'bus-desc', rows: 3, placeholder: '例：屋根・ベンチあり。駅の北口から徒歩1分。', onchange: (e) => commit([{ id: s.id, after: { ...F.get(s.id), desc: e.target.value.trim() } }]) }, s.desc || ''),
          h('label', { class: 'lbl' }, 'このバス停を通る路線'),
          rs.length ? h('div', { class: 'name-list' }, ...rs.map((r) => h('div', { class: 'name-item', onclick: () => { st.mode = 'route'; st.route = r.id; st.stop = null; sync(); refreshPanel(); } },
            h('span', { class: 'name-sw', style: { background: r.color } }), h('span', { class: 'nm' }, r.name || '名前なし'))))
            : h('div', { class: 'muted' }, 'まだありません。「② 路線を作る」でバス停をクリックすると追加されます。'),
          h('div', { class: 'btn-row', style: { marginTop: '12px' } },
            h('button', { class: 'btn danger', onclick: async () => { if (await ask(`「${s.name || 'バス停'}」を削除しますか？`, '削除')) removeStop(s.id); } }, icon('trash'), 'バス停を削除')));
      }
    } else {
      // 路線の一覧と新規作成
      const input = h('input', { type: 'text', id: 'bus-new', placeholder: '新しい路線の名前（例：1系統 駅前線）' });
      const add = () => {
        const name = input.value.trim(); if (!name) return;
        const used = new Set(routes().map((r) => r.color));
        const r = { id: newId(), kind: 'busroute', name, color: BUS_COLORS.find((c) => !used.has(c)) || BUS_COLORS[routes().length % BUS_COLORS.length], desc: '', stops: [] };
        commit([{ id: r.id, after: r }]);
        selectRoute(r.id);
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') add(); };
      parts.push(h('div', { class: 'inline', style: { marginTop: '10px' } }, input, h('button', { class: 'btn primary', onclick: add }, '追加')),
        h('div', { class: 'name-list' }, ...routes().map((r) => h('div', { class: `name-item ${r.id === st.route ? 'on' : ''}`, onclick: () => selectRoute(r.id) },
          h('span', { class: 'name-sw', style: { background: r.color } }), h('span', { class: 'nm' }, r.name || '名前なし'),
          h('span', { class: 'muted' }, `${(r.stops || []).length}停留所`),
          h('button', { class: 'icon-btn', title: 'この路線を削除', onclick: async (e) => { e.stopPropagation(); if (await ask(`路線「${r.name}」を削除しますか？（バス停は残ります）`, '削除')) { commit([{ id: r.id, after: null }]); if (st.route === r.id) st.route = null; sync(); refreshPanel(); } } }, icon('trash'))))));
      const r = st.route && F.get(st.route);
      if (!routes().length) parts.push(h('div', { class: 'muted', style: { marginTop: '8px' } }, 'まだ路線がありません。上で名前を入れて追加してください。'));
      if (r) {
        const custom = h('input', { type: 'color', value: r.color, title: '好きな色', onchange: (e) => updateRoute({ color: e.target.value }) });
        parts.push(h('div', { class: 'hint', style: { marginTop: '12px' } },
          h('div', {}, '地図のバス停を、走る順番にクリックすると路線に追加されます。停留所のあいだは道路に沿って自動でつながります。'),
          h('div', {}, 'Delete キーで最後の停留所を外せます。')),
          h('label', { class: 'lbl', for: 'bus-rname' }, '路線名'),
          h('input', { type: 'text', id: 'bus-rname', value: r.name || '', onchange: (e) => updateRoute({ name: e.target.value.trim() }) }),
          h('label', { class: 'lbl' }, '路線の色'),
          h('div', { class: 'swatches' }, ...BUS_COLORS.map((c) => h('button', { class: `swatch ${r.color === c ? 'on' : ''}`, style: { background: c }, title: c, onclick: () => updateRoute({ color: c }) })), custom),
          h('label', { class: 'lbl', for: 'bus-rdesc' }, '説明'),
          h('textarea', { id: 'bus-rdesc', rows: 2, placeholder: '例：平日は15分おき。', onchange: (e) => updateRoute({ desc: e.target.value.trim() }) }, r.desc || ''),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!r.oneway, onchange: (e) => updateRoute({ oneway: e.target.checked }) }), '片方向だけ走る（循環線など）'),
          h('label', { class: 'lbl' }, `停留所（${(r.stops || []).length}）`),
          (r.stops || []).length ? h('ol', { class: 'stop-list' }, ...(r.stops || []).map((id, i) => {
            const s = F.get(id);
            return h('li', {}, h('div', { class: 'stop-row' }, h('span', { class: 'nm' }, s?.name || '（削除されたバス停）'),
              h('button', { class: 'icon-btn', title: '外す', onclick: () => updateRoute({ stops: r.stops.filter((_, k) => k !== i) }) }, icon('x'))));
          })) : h('div', { class: 'muted' }, 'まだありません。地図のバス停をクリックしてください。'));
      }
    }
    box.replaceChildren(...parts);
  }
  function validate() {
    let ch = false;
    if (st.stop && !F.get(st.stop)) { st.stop = null; ch = true; }
    if (st.route && !F.get(st.route)) { st.route = null; ch = true; }
    if (ch) sync();
    return ch;
  }
  return { tool, overlay, renderPanel, validate, hitAt: stopHit, selectStop: (id) => { st.mode = 'stop'; selectStop(id); }, isBusy: () => !!press?.drag };
}
