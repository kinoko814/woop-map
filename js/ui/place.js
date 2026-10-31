// =============================================================
// 表示モード：左から出てくる情報パネル（IC・駅・施設など共通）
// =============================================================
import { h, icon } from './dom.js';

export function createPlacePanel(root, { onClose } = {}) {
  const body = h('div', { class: 'place-body' });
  const panel = h('aside', { class: 'place', hidden: true, 'aria-live': 'polite' },
    h('button', { class: 'icon-btn place-close', title: '閉じる', onclick: () => { hide(); onClose?.(); } }, icon('x')),
    body);
  root.append(panel);
  function hide() { panel.hidden = true; }
  /**
   * info: {title, kind, kindColor?, photo?, badges?:[node], desc?, rows:[[label, value]], extra?: node}
   */
  function show(info) {
    const parts = [];
    if (info.photo) parts.push(h('div', { class: 'place-photo' }, h('img', { src: info.photo, alt: '' })));
    parts.push(h('div', { class: 'place-head' },
      h('div', { class: 'place-kind', style: info.kindColor ? { color: info.kindColor } : null }, info.kind || ''),
      h('h2', {}, info.title || '名前なし'),
      info.badges?.length ? h('div', { class: 'place-badges' }, ...info.badges) : null));
    if (info.desc) parts.push(h('p', { class: 'place-desc' }, info.desc));
    const rows = (info.rows || []).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
    if (rows.length) parts.push(h('dl', { class: 'place-rows' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, ...(Array.isArray(v) ? v : [v]))])));
    if (info.extra) parts.push(info.extra);
    body.replaceChildren(...parts);
    body.scrollTop = 0;
    panel.hidden = false;
  }
  return { show, hide, get open() { return !panel.hidden; } };
}
