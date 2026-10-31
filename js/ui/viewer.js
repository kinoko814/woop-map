// =============================================================
// 表示モード (一般ユーザー向け)
//   第1段階：地形の表示・拡大縮小・クリックで座標表示
//   検索・施設情報・経路検索などは次の段階で追加
// =============================================================
import { h, icon, toast, hideToast } from './dom.js';
import { coordsBox, zoomBox } from './chrome.js';
import { Terrain } from '../engine/terrain.js';
import { MapView, fmt } from '../engine/view.js';
import { applyRows } from '../session.js';

export async function startViewer(root, store, { backToEdit } = {}) {
  const map = store.map;
  const half = (map.size_km * 1000) / 2;
  const terrain = new Terrain({ halfSize: half });
  const canvas = h('canvas');
  const wrap = h('div', { class: 'map-wrap' }, canvas);
  const search = h('div', { class: 'v-search' },
    h('span', { class: 'logo', title: map.name }, h('i', {}, 'W')),
    h('input', { type: 'text', placeholder: `${map.name} を検索`, onkeydown: (e) => { if (e.key === 'Enter') toast('検索は次の段階で使えるようになります'); } }),
    icon('search'));
  const popup = h('div', { class: 'v-popup', style: { display: 'none' } });
  root.replaceChildren(wrap, search, popup);
  if (backToEdit) {
    root.append(h('button', { class: 'btn', style: { position: 'absolute', right: '12px', top: '12px', zIndex: 6, boxShadow: 'var(--shadow)' }, onclick: backToEdit }, icon('edit'), '編集に戻る'));
  }
  document.title = `${map.name} - WOOP MAP`;

  const view = new MapView(canvas, terrain, { halfSize: half });
  view.showGrid = false;
  root.append(coordsBox(view), zoomBox(view, { grid: false }));
  view.fitAll();

  // クリックした地点の座標 (住所は第4段階で追加)
  let pin = null;
  view.setTool({
    pan: true, cursor: 'grab',
  });
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
    const r = canvas.getBoundingClientRect();
    const w = view.toWorld(e.clientX - r.left, e.clientY - r.top);
    pin = [Math.floor(w[0]), Math.floor(w[1])];
    placePopup();
  });
  const placePopup = () => {
    if (!pin) { popup.style.display = 'none'; return; }
    const [x, y] = view.toScreen(pin[0] + 0.5, pin[1] + 0.5);
    popup.style.display = '';
    popup.style.left = `${x}px`; popup.style.top = `${y}px`;
    popup.replaceChildren(h('div', { class: 'muted' }, 'この地点の座標'), h('b', {}, `X: ${fmt(pin[0])}　Z: ${fmt(pin[1])}`));
  };
  const prev = view.onViewChange;
  view.onViewChange = () => { prev(); placePopup(); };

  toast('マップを読み込み中…', 0);
  try {
    const rows = await store.loadTerrainMeta();
    applyRows(terrain, new Map(), rows);
    terrain.loader = (keys) => store.loadTerrainData(keys);
    if (store.kind === 'local') terrain.maxLoaded = Infinity;
    hideToast();
    view.resetCache();
  } catch (e) { console.error(e); toast('読み込みに失敗しました'); }
  view.requestDraw();
}
