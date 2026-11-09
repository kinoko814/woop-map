// 表示・編集モード共通：座標表示、縮尺バー、ズームボタン
import { h, icon } from './dom.js';
import { fmt, fmtDist } from '../engine/view.js';

export function coordsBox(view) {
  const xy = h('span', {}, 'X — / Z —');
  const bar = h('div');
  const lbl = h('span');
  const box = h('div', { class: 'coords' }, xy, h('span', { class: 'scalebar' }, lbl, bar));
  const upd = () => {
    // 縮尺バー: 5mを最小に、見やすい距離が60〜120pxになるよう選ぶ
    const nice = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    let m = nice[nice.length - 1];
    for (const n of nice) if (n * view.scale >= 60) { m = n; break; }
    bar.style.width = `${m * view.scale}px`;
    lbl.textContent = fmtDist(m);
  };
  const prev = view.onViewChange;
  view.onViewChange = () => { prev(); upd(); };
  const prevP = view.onPointerWorld;
  view.onPointerWorld = (w) => { prevP(w); xy.textContent = `X ${fmt(Math.floor(w[0]))} / Z ${fmt(Math.floor(w[1]))}`; };
  upd();
  return box;
}

export function zoomBox(view, { grid = true } = {}) {
  const center = () => [view.w / 2, view.h / 2];
  const gridBtn = grid ? h('button', { class: 'icon-btn on', title: 'グリッド表示', onclick: () => {
    view.showGrid = !view.showGrid; gridBtn.classList.toggle('on', view.showGrid); view.requestDraw();
  } }, icon('grid')) : null;
  return h('div', { class: 'zoom' },
    gridBtn,
    h('button', { class: 'icon-btn', title: '全体を表示', onclick: () => view.fitAll() }, icon('fit')),
    h('button', { class: 'icon-btn', title: '拡大', onclick: () => view.zoomAt(...center(), 2) }, icon('plus')),
    h('button', { class: 'icon-btn', title: '縮小', onclick: () => view.zoomAt(...center(), 0.5) }, icon('minus')),
  );
}
