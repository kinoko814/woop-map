// =============================================================
// 編集モード：住所ツール
//   ① 階層（県・市町村・区・住所名・番地）を選ぶ
//   ② 「境界線」で中間点を置きながら直線の境界を引く
//   ③ 「地名」で、境界に囲まれた所をクリックして名前を付ける
//      同じ地名で何か所でも塗れる（飛び地）。もう一度クリックで外す
// =============================================================
import { h, icon, toast, ask } from './dom.js';
import { newId } from '../engine/features.js';
import { ADDR_LEVELS, levelIndex } from '../engine/address.js';
import { nameColor } from '../engine/addrlayer.js';

export function createAddressTool({ view, F, session, layer, refreshPanel, borderT }) {
  const st = { level: 'pref', mode: 'border', activeId: null };
  let press = null, hoverFace = null;
  const li = () => levelIndex(st.level);
  const A = layer.addr;
  const regions = () => [...F.ofKind('addr')].filter((r) => r.level === st.level).sort((a, b) => a.name.localeCompare(b.name, 'ja'));

  function setLevel(lv) {
    st.level = lv; st.activeId = null;
    layer.addrEdit = li(); layer.addrActive = null;
    borderT.setBorderLevel(lv);
    refreshPanel(); view.requestDraw();
  }
  function setMode(m) {
    if (borderT.isBusy()) borderT.finishDraw();
    borderT.deselect();
    st.mode = m; hoverFace = null;
    view.canvas.style.cursor = m === 'name' ? 'cell' : 'crosshair';
    refreshPanel(); view.requestDraw();
  }

  /** 面に地名を付ける（同じ面にほかの地名があれば外す。同じ地名ならトグルで外す） */
  function paint(w) {
    const face = A.locate(li(), w[0], w[1]);
    if (!face) return;
    const active = st.activeId ? F.get(st.activeId) : null;
    if (!active) return toast('先に右のパネルで地名を選ぶか、新しい地名を入力してください');
    const changes = [];
    let removedFromActive = false;
    for (const r of regions()) {
      const keep = (r.seeds || []).filter((s) => A.locate(li(), s[0], s[1])?.id !== face.id);
      if (keep.length !== (r.seeds || []).length) {
        if (r.id === active.id) removedFromActive = true;
        changes.push({ id: r.id, after: { ...r, seeds: keep } });
      }
    }
    if (!removedFromActive) {
      const cur = changes.find((c) => c.id === active.id)?.after || active;
      const next = { ...cur, seeds: [...(cur.seeds || []), [Math.round(w[0] * 10) / 10, Math.round(w[1] * 10) / 10]] };
      const i = changes.findIndex((c) => c.id === active.id);
      if (i >= 0) changes[i].after = next; else changes.push({ id: active.id, after: next });
    }
    session.commitFeatures(changes);
    refreshPanel(); view.requestDraw();
  }

  const tool = {
    get cursor() { return st.mode === 'name' ? 'cell' : 'crosshair'; },
    down(w, e, p) {
      if (st.mode === 'border') return borderT.roadTool.down(w, e, p);
      press = { p, x: view.x, z: view.z, moved: false };
    },
    move(w, e, p) {
      if (st.mode === 'border') return borderT.roadTool.move(w, e, p);
      if (!press) return;
      if (!press.moved && Math.hypot(p[0] - press.p[0], p[1] - press.p[1]) > 4) press.moved = true;
      if (press.moved) view.setView(press.x - (p[0] - press.p[0]) / view.scale, press.z - (p[1] - press.p[1]) / view.scale);
    },
    up(w, e, p) {
      if (st.mode === 'border') return borderT.roadTool.up(w, e, p);
      const pr = press; press = null;
      if (pr && !pr.moved) paint(w);
    },
    hover(w, e, p) {
      if (st.mode === 'border') return borderT.roadTool.hover(w, e, p);
      const f = A.locate(li(), w[0], w[1]);
      if (f !== hoverFace) { hoverFace = f; view.requestDraw(); }
    },
    key(e) {
      if (st.mode === 'border') return borderT.roadTool.key(e);
      return false;
    },
    activate() { layer.addrEdit = li(); layer.addrActive = st.activeId; borderT.setBorderLevel(st.level); },
    deactivate() { borderT.roadTool.deactivate(); layer.addrEdit = null; layer.addrActive = null; hoverFace = null; view.requestDraw(); },
  };

  const overlay = {
    draw(ctx, v) {
      if (st.mode === 'border') return borderT.overlay.draw(ctx, v);
      if (!hoverFace) return;
      ctx.save();
      ctx.beginPath();
      hoverFace.poly.forEach(([x, z], i) => { const [sx, sy] = v.toScreen(x, z); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.closePath();
      const active = st.activeId ? F.get(st.activeId) : null;
      ctx.fillStyle = active ? nameColor(active.name, 0.18) : 'rgba(117,210,195,.15)'; ctx.fill();
      ctx.strokeStyle = '#1f7c6f'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke();
      ctx.restore();
    },
  };

  function renderPanel(box) {
    const L = ADDR_LEVELS[li()];
    const seg = (opts, value, on) => h('div', { class: 'seg' }, ...opts.map(([l, v]) => h('button', { class: value === v ? 'on' : '', onclick: () => on(v) }, l)));
    const parts = [h('h3', {}, '住所'),
      h('label', { class: 'lbl' }, '階層'),
      seg(ADDR_LEVELS.map((x) => [x.label, x.key]), st.level, setLevel),
      h('div', { class: 'row' }, seg([['① 境界線を引く', 'border'], ['② 地名を付ける', 'name']], st.mode, setMode))];
    if (st.mode === 'border') {
      if (borderT.isBusy()) { const sub = h('div'); borderT.renderPanel(sub); sub.querySelector('h3')?.remove(); parts.push(sub); }
      else parts.push(h('div', { class: 'hint' },
        h('div', {}, `${L.label}の境界線を、クリックで角を置きながら直線で引きます。ほかの境界線の上に置くとつながります。`),
        h('div', {}, '上の階層の境界（県境など）は、そのまま下の階層の境界にもなります。マップの外周も境界です。'),
        h('div', {}, '海に面した所は、境界線を海の中まで伸ばして区切ってください（住所は陸の上だけに表示されます）。'),
        h('div', {}, '引いた線を直すときは「選択」ツールでクリックします。')));
    } else {
      const input = h('input', { type: 'text', id: 'addr-new', placeholder: `新しい${L.unit}（例：${['ウープ県', '港市', '中央区', '駅前一丁目', '12番地'][li()]}）` });
      const add = () => {
        const name = input.value.trim(); if (!name) return;
        const ex = regions().find((r) => r.name === name);
        if (ex) { st.activeId = ex.id; layer.addrActive = ex.id; refreshPanel(); view.requestDraw(); return; }
        const r = { id: newId(), kind: 'addr', level: st.level, name, seeds: [] };
        session.commitFeatures([{ id: r.id, after: r }]);
        st.activeId = r.id; layer.addrActive = r.id; refreshPanel();
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') add(); };
      const counts = new Map();
      for (const e of A.namedFaces(li())) counts.set(e.region.id, (counts.get(e.region.id) || 0) + 1);
      parts.push(h('div', { class: 'hint' },
        h('div', {}, '地名を選んでから、境界に囲まれた所をクリックするとその地名になります。'),
        h('div', {}, '同じ地名で何か所でもクリックできます（飛び地）。同じ所をもう一度クリックすると外れます。')),
        h('div', { class: 'inline' }, input, h('button', { class: 'btn primary', onclick: add }, '追加')),
        h('div', { class: 'name-list' }, ...regions().map((r) => {
          const on = r.id === st.activeId;
          return h('div', { class: `name-item ${on ? 'on' : ''}`, onclick: () => { st.activeId = r.id; layer.addrActive = r.id; refreshPanel(); view.requestDraw(); } },
            h('span', { class: 'name-sw', style: { background: nameColor(r.name, 0.75) } }),
            on ? h('input', { type: 'text', value: r.name, 'aria-label': '地名を変更', onclick: (e) => e.stopPropagation(), onchange: (e) => { const n = e.target.value.trim(); if (n) session.commitFeatures([{ id: r.id, after: { ...F.get(r.id), name: n } }]); } })
              : h('span', { class: 'nm' }, r.name),
            h('span', { class: 'muted' }, counts.get(r.id) ? `${counts.get(r.id)}か所` : '未設定'),
            h('button', { class: 'icon-btn', title: 'この地名を削除', onclick: async (e) => { e.stopPropagation(); if (await ask(`「${r.name}」を削除しますか？`, '削除')) { session.commitFeatures([{ id: r.id, after: null }]); if (st.activeId === r.id) { st.activeId = null; layer.addrActive = null; } refreshPanel(); } } }, icon('trash')));
        })));
      if (!regions().length) parts.push(h('div', { class: 'muted', style: { marginTop: '8px' } }, `まだ${L.label}の地名がありません。上で入力して追加してください。`));
    }
    box.replaceChildren(...parts);
  }
  function validate() {
    if (st.activeId && !F.get(st.activeId)) { st.activeId = null; layer.addrActive = null; return true; }
    return false;
  }
  return { tool, overlay, renderPanel, validate, isBusy: () => borderT.isBusy() };
}
