// =============================================================
// 管理モード / ログイン / マップ一覧
// =============================================================
import { h, icon, logo, toast } from './dom.js';

function pageShell(root, title, onBack, right) {
  const inner = h('div', { class: 'page-in' });
  root.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page-top' },
      onBack ? h('button', { class: 'icon-btn', onclick: onBack, title: '戻る' }, icon('back')) : null,
      logo(), h('span', { class: 'muted' }, title), h('span', { style: { flex: 1 } }), right || null),
    inner));
  return inner;
}

// ---------- 管理モード ----------
export async function startAdmin(root, store, nav) {
  const map = store.map;
  const inner = pageShell(root, '管理モード', () => nav('edit'),
    store.kind === 'remote' ? h('button', { class: 'btn', onclick: async () => { await store.signOut(); location.reload(); } }, icon('logout'), 'ログアウト') : null);

  if (store.kind === 'local') inner.append(h('div', { class: 'note' },
    'いまはローカルデモモードです（データはこのブラウザ内だけに保存）。編集者の招待や共有リンクは、README の手順で Supabase を設定すると使えます。'));

  // マップ名
  const name = h('input', { type: 'text', value: map.name, maxlength: 60 });
  inner.append(h('div', { class: 'card' },
    h('h2', {}, 'マップの名前'), h('p', { class: 'desc' }, '表示モードの検索バーやタブに表示されます。'),
    h('div', { class: 'inline' }, name, h('button', { class: 'btn primary', onclick: async () => {
      try { await store.renameMap(name.value.trim() || 'WOOP MAP'); toast('名前を保存しました'); } catch (e) { toast('保存に失敗しました'); }
    } }, '保存'))));

  if (store.kind !== 'remote') return;

  // マップの大きさ
  const size = h('select', {}, ...[10, 20, 50, 100, 200].map((k) => h('option', { value: k, selected: map.size_km === k }, `${k} km × ${k} km`)));
  inner.append(h('div', { class: 'card' },
    h('h2', {}, 'マップの大きさ'), h('p', { class: 'desc' }, '中心は X:0 Z:0。1ブロック = 1m です。小さくしても描いた地形は消えません（範囲外は表示されなくなります）。'),
    h('div', { class: 'inline' }, size, h('button', { class: 'btn primary', onclick: async () => {
      try { await store.setSize(+size.value); toast('大きさを保存しました'); } catch (e) { toast('保存に失敗しました'); }
    } }, '保存'))));

  // 共有リンク
  const linkOf = () => `${location.origin}${location.pathname}?map=${store.mapId}&key=${map.view_key}`;
  const link = h('input', { type: 'text', readonly: true, value: linkOf() });
  inner.append(h('div', { class: 'card' },
    h('h2', {}, '表示モードの共有リンク'),
    h('p', { class: 'desc' }, 'このリンクを渡した人だけがマップを見られます（ログイン不要）。リンクを作り直すと、古いリンクは使えなくなります。'),
    h('div', { class: 'inline' }, link, h('button', { class: 'btn', onclick: () => { navigator.clipboard?.writeText(link.value); toast('コピーしました'); } }, icon('copy'), 'コピー')),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onclick: async () => {
      if (!confirm('共有リンクを作り直しますか？今のリンクは使えなくなります。')) return;
      try { await store.regenerateViewKey(); link.value = linkOf(); toast('新しいリンクを作りました'); } catch (e) { toast('失敗しました'); }
    } }, 'リンクを作り直す'))));

  // 編集権限
  const list = h('div');
  const email = h('input', { type: 'email', placeholder: 'example@gmail.com' });
  const role = h('select', { style: { width: '120px', flex: 'none' } }, h('option', { value: 'editor' }, '編集者'), h('option', { value: 'admin' }, '管理者'));
  const refresh = async () => {
    const ms = await store.listMembers();
    list.replaceChildren(...ms.map((m) => {
      const isMe = m.email === store.user.email.toLowerCase();
      const sel = h('select', { disabled: isMe, onchange: async () => { await store.addMember(m.email, sel.value); toast('変更しました'); } },
        h('option', { value: 'editor', selected: m.role === 'editor' }, '編集者'), h('option', { value: 'admin', selected: m.role === 'admin' }, '管理者'));
      return h('div', { class: 'member' }, h('span', { class: 'em' }, m.email, isMe ? h('span', { class: 'muted' }, '（あなた）') : null), sel,
        h('button', { class: 'icon-btn', title: '外す', disabled: isMe, onclick: async () => {
          if (!confirm(`${m.email} の権限を外しますか？`)) return;
          await store.removeMember(m.email); refresh();
        } }, icon('trash')));
    }));
  };
  inner.append(h('div', { class: 'card' },
    h('h2', {}, '編集権限を持つ人'),
    h('p', { class: 'desc' }, 'メールアドレスで追加します。追加された人は、そのアドレスでログインすると編集モードに入れます。管理者はこの画面も使えます。'),
    h('div', { class: 'inline' }, email, role, h('button', { class: 'btn primary', onclick: async () => {
      const v = email.value.trim();
      if (!/^\S+@\S+\.\S+$/.test(v)) return toast('メールアドレスを確認してください');
      try { await store.addMember(v, role.value); email.value = ''; refresh(); toast('追加しました'); } catch (e) { toast('追加に失敗しました'); }
    } }, '追加')),
    h('div', { style: { marginTop: '12px' } }, list)));
  refresh();
}

// ---------- ログイン ----------
export function startLogin(root, sendMail) {
  const email = h('input', { type: 'email', placeholder: 'メールアドレス', autocomplete: 'email' });
  const msg = h('div', { class: 'muted', style: { marginTop: '10px' } });
  const btn = h('button', { class: 'btn primary', style: { width: '100%', justifyContent: 'center', marginTop: '10px' }, onclick: async () => {
    const v = email.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(v)) { msg.textContent = 'メールアドレスを確認してください'; return; }
    btn.disabled = true; msg.textContent = '送信中…';
    try { await sendMail(v); msg.textContent = `${v} にログイン用のリンクを送りました。メールを開いてリンクを押してください。`; }
    catch (e) { msg.textContent = `送信できませんでした：${e.message || e}`; btn.disabled = false; }
  } }, 'ログインリンクを送る');
  root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'login' },
    logo(), h('h1', {}, '編集・管理にはログイン'), h('div', { class: 'muted' }, 'パスワードは不要です。メールに届くリンクからログインします。'),
    h('div', { class: 'card' }, h('label', { class: 'muted' }, 'メールアドレス'), email, btn, msg))));
}

// ---------- マップ一覧 ----------
export function startDashboard(root, { maps, create, signOut, email }) {
  const inner = pageShell(root, email, null, h('button', { class: 'btn', onclick: signOut }, icon('logout'), 'ログアウト'));
  const name = h('input', { type: 'text', placeholder: '新しいマップの名前（例：ウープ島）' });
  inner.append(h('div', { class: 'card' },
    h('h2', {}, '新しいマップを作る'), h('p', { class: 'desc' }, '作った人が最初の管理者になります。'),
    h('div', { class: 'inline' }, name, h('button', { class: 'btn primary', onclick: async () => {
      try { const id = await create(name.value.trim() || '新しいマップ'); location.href = `?map=${id}&mode=edit`; } catch (e) { toast('作成に失敗しました'); }
    } }, '作成'))));
  inner.append(h('div', { class: 'card maplist' },
    h('h2', {}, 'あなたが編集できるマップ'),
    maps.length ? null : h('p', { class: 'desc' }, 'まだありません。管理者に招待してもらうか、新しく作ってください。'),
    ...maps.map((m) => h('a', { href: `?map=${m.id}&mode=edit` }, h('span', {}, h('b', {}, m.name), ' ', h('span', { class: 'muted' }, `${m.size_km}km 四方`)), icon('edit')))));
}
