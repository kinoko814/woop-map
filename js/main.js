// =============================================================
// WOOP MAP 起動・画面の切り替え
//   ?map=ID&key=KEY        → 表示モード（リンクを知っている人だけ）
//   ?map=ID&mode=edit      → 編集モード（ログイン＋権限が必要）
//   ?map=ID&mode=admin     → 管理モード（管理者のみ）
//   ?map=ID&mode=view      → 権限者が表示モードを確認
//   ?login                 → ログイン / マップ一覧
//   パラメータなし         → トップのマップを表示モードで（無ければログイン）
// =============================================================
import { USE_SUPABASE } from './config.js';
import { startEditor } from './ui/editor.js';
import { startViewer } from './ui/viewer.js';
import { startAdmin, startLogin, startDashboard } from './ui/admin.js';
import { h, logo } from './ui/dom.js';

const root = document.getElementById('app');
const q = new URLSearchParams(location.search);

function go(params) {
  const u = new URLSearchParams(params);
  location.href = `${location.pathname}?${u}`;
}
function message(title, text, action) {
  root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'login' }, logo(), h('h1', {}, title),
    h('div', { class: 'muted' }, text), action ? h('div', { style: { marginTop: '18px' } }, action) : null)));
}

function needSetup() {
  message('Supabase の設定が必要です', 'js/config.js に Supabase の URL と anon key を入れてください（手順は README.md）。');
}

async function runRemote() {
  const R = await import('./store/remote.js');
  const mapId = q.get('map');
  const key = q.get('key');

  let sb = null;
  const openView = async (id, k, loggedIn) => {
    const vsb = await R.makeClient(k);
    const store = new R.RemoteStore(vsb, id, null);
    try { await store.init(); } catch (e) { return message('マップを開けません', 'リンクが正しくないか、作り直された可能性があります。'); }
    return startViewer(root, store, { toLogin: () => go({ map: id, mode: 'edit' }), loggedIn });
  };

  // 表示モード（共有リンク）
  sb = await R.makeClient(null);
  if (mapId && key) return openView(mapId, key, !!(await R.currentUser(sb)));

  const loggingIn = /access_token|code=/.test(location.href);

  // URL だけで開いたとき：トップのマップを表示モードで
  if (!mapId && !q.has('login') && !loggingIn) {
    const home = await R.homeMap(sb).catch(() => null);
    if (home) return openView(home.id, home.view_key, !!(await R.currentUser(sb)));
  }

  // メールのリンクから戻ってきた直後はセッション確立を少し待つ
  let user = await R.currentUser(sb);
  if (!user && loggingIn) {
    await new Promise((r) => setTimeout(r, 800));
    user = await R.currentUser(sb);
  }
  if (!user) return startLogin(root, {
    password: (email, pw) => R.signInWithPassword(sb, email, pw),
    sendMail: (email) => R.sendLoginMail(sb, email),
    verifyCode: (email, code) => R.verifyLoginCode(sb, email, code),
  });

  if (!mapId) {
    const maps = await R.listMyMaps(sb);
    return startDashboard(root, {
      maps, email: user.email,
      create: (name) => R.createMap(sb, name),
      setPassword: (pw) => R.setPassword(sb, pw),
      signOut: async () => { await sb.auth.signOut(); location.href = location.pathname; },
    });
  }

  const store = new R.RemoteStore(sb, mapId, user);
  try { await store.init(); } catch (e) { return message('マップを開けません', 'このマップの編集権限がありません。管理者に招待してもらってください。', h('a', { class: 'btn', href: location.pathname + '?login' }, 'マップ一覧へ')); }
  if (!store.role) return message('編集権限がありません', `${user.email} はこのマップの編集者に登録されていません。`, h('a', { class: 'btn', href: location.pathname + '?login' }, 'マップ一覧へ'));

  const mode = q.get('mode') || 'edit';
  const nav = (m) => go({ map: mapId, mode: m });
  if (mode === 'view') return startViewer(root, store, { backToEdit: () => nav('edit') });
  if (mode === 'admin') {
    if (store.role !== 'admin') return nav('edit');
    return startAdmin(root, store, nav);
  }
  return startEditor(root, store, nav);
}

(USE_SUPABASE ? runRemote() : Promise.resolve(needSetup())).catch((e) => {
  console.error(e);
  message('エラーが発生しました', String(e.message || e));
});
