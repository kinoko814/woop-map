// =============================================================
// 口コミと星（駅・施設）
//   表示モード：ログインなしで、ニックネームで星（1〜5）と感想を書ける
//   編集モード：一覧を見て、不適切なものを消せる
// =============================================================
import { h, icon, toast, ask } from './dom.js';

const NICK_KEY = 'woop-nickname';
const COOLDOWN = 30 * 1000;   // 連続投稿の間隔（いたずら防止の目安）
const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 保存できない環境 */ } };

/** 星の表示（rating は小数可） */
export function stars(rating, size = 14) {
  const el = h('span', { class: 'stars', title: `${rating.toFixed(1)} / 5`, 'aria-label': `星 ${rating.toFixed(1)}` });
  el.style.setProperty('--sz', `${size}px`);
  for (let i = 1; i <= 5; i++) {
    const fill = Math.max(0, Math.min(1, rating - (i - 1)));
    el.append(h('span', { class: 'star' }, h('span', { class: 'star-fill', style: { width: `${fill * 100}%` } })));
  }
  return el;
}

/**
 * 口コミの欄
 * @param opts.canDelete 編集モード（消せる）  opts.compose 書く欄を出すか
 */
export function reviewSection(store, featureId, { canDelete = false, compose = true } = {}) {
  const box = h('div', { class: 'reviews' });
  const head = h('div', { class: 'rv-head' }, h('h3', {}, '口コミ'), h('span', { class: 'muted' }, '読み込み中…'));
  const list = h('div', { class: 'rv-list' });
  box.append(head);
  if (!store.listReviews) { head.lastChild.textContent = '口コミは公開版でのみ使えます'; return box; }

  let items = [];
  const render = () => {
    const n = items.length;
    const avg = n ? items.reduce((s, r) => s + r.rating, 0) / n : 0;
    head.replaceChildren(h('h3', {}, '口コミ'),
      n ? h('span', { class: 'rv-avg' }, stars(avg, 15), h('b', {}, avg.toFixed(1)), h('span', { class: 'muted' }, `（${n}件）`))
        : h('span', { class: 'muted' }, 'まだありません'));
    list.replaceChildren(...items.map((r) => h('div', { class: 'rv-item' },
      h('div', { class: 'rv-meta' }, h('b', {}, r.nickname), stars(r.rating, 12), h('span', { class: 'muted' }, fmtDate(r.created_at)),
        canDelete ? h('button', { class: 'icon-btn rv-del', title: 'この口コミを消す', onclick: async () => {
          if (!(await ask(`「${r.nickname}」さんの口コミを消しますか？`, '消す'))) return;
          try { await store.deleteReview(r.id); items = items.filter((x) => x.id !== r.id); forget(featureId); render(); toast('消しました'); }
          catch (e) { toast(`消せませんでした：${e.message || e}`); }
        } }, icon('trash')) : null),
      r.body ? h('p', { class: 'rv-body' }, r.body) : null)));
  };

  if (compose) box.append(form());
  box.append(list);
  load(store, featureId).then((rows) => { items = rows; render(); })
    .catch((e) => { console.error(e); head.lastChild.textContent = /reviews/.test(e.message || '') ? 'データベースの更新が必要です' : '読み込めませんでした'; });
  return box;

  function form() {
    let rating = 0;
    const nick = h('input', { type: 'text', maxlength: 30, placeholder: 'ニックネーム', value: lsGet(NICK_KEY), 'aria-label': 'ニックネーム' });
    const body = h('textarea', { rows: 3, maxlength: 1000, placeholder: '感想（なくても投稿できます）', 'aria-label': '感想' });
    const picker = h('div', { class: 'rv-pick', role: 'radiogroup', 'aria-label': '星の数' });
    const paint = (n) => picker.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i < n));
    for (let i = 1; i <= 5; i++) {
      picker.append(h('button', { type: 'button', title: `${i}`, 'aria-label': `星${i}つ`,
        onclick: () => { rating = i; paint(i); }, onmouseenter: () => paint(i), onmouseleave: () => paint(rating) }, '★'));
    }
    const btn = h('button', { class: 'btn primary', onclick: async () => {
      const nn = nick.value.trim();
      if (!nn) return toast('ニックネームを入れてください');
      if (!rating) return toast('星の数を選んでください');
      const last = +lsGet('woop-review-at') || 0;
      if (Date.now() - last < COOLDOWN) return toast('少し時間をおいてから投稿してください');
      btn.disabled = true;
      try {
        const row = await store.addReview({ featureId, nickname: nn, rating, body: body.value.trim() });
        lsSet(NICK_KEY, nn); lsSet('woop-review-at', String(Date.now()));
        items = [row, ...items]; forget(featureId); render();
        body.value = ''; rating = 0; paint(0);
        toast('投稿しました');
      } catch (e) { console.error(e); toast(`投稿できませんでした：${e.message || e}`); }
      finally { btn.disabled = false; }
    } }, '投稿');
    return h('div', { class: 'rv-form' },
      h('div', { class: 'rv-row' }, nick, picker), body, h('div', { class: 'rv-row', style: { justifyContent: 'space-between' } },
        h('span', { class: 'muted', style: { fontSize: '11px' } }, 'ログインなしで、ニックネームで投稿できます'), btn));
  }
}

// パネルが描き直されるたびに読み直さないよう、少しのあいだ覚えておく
const CACHE = new Map();   // featureId -> {t, p}
function load(store, featureId) {
  const c = CACHE.get(featureId);
  if (c && Date.now() - c.t < 20000) return c.p;
  const p = store.listReviews(featureId);
  CACHE.set(featureId, { t: Date.now(), p });
  p.catch(() => CACHE.delete(featureId));
  return p;
}
const forget = (featureId) => CACHE.delete(featureId);

function fmtDate(s) {
  const d = new Date(s);
  return Number.isNaN(+d) ? '' : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
