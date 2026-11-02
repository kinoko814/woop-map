// =============================================================
// 管理モード / ログイン / マップ一覧
// =============================================================
import { h, icon, logo, toast, ask } from './dom.js';
import { boundsOf, validBounds, sizeLabel } from '../bounds.js';

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
    h('button', { class: 'btn', onclick: async () => { await store.signOut(); location.reload(); } }, icon('logout'), 'ログアウト'));

  // マップ名
  const name = h('input', { type: 'text', value: map.name, maxlength: 60 });
  inner.append(h('div', { class: 'card' },
    h('h2', {}, 'マップの名前'), h('p', { class: 'desc' }, '表示モードの検索バーやタブに表示されます。'),
    h('div', { class: 'inline' }, name, h('button', { class: 'btn primary', onclick: async () => {
      try { await store.renameMap(name.value.trim() || 'WOOP MAP'); toast('名前を保存しました'); } catch (e) { toast('保存に失敗しました'); }
    } }, '保存'))));

  // マップの範囲（自由に広げたり狭めたりできる）
  inner.append(boundsCard(store));

  // 表示モードの最初の位置
  {
    const fx = h('input', { type: 'number', step: 1, id: 'home-x', value: Number.isFinite(map.home_x) ? map.home_x : 0 });
    const fz = h('input', { type: 'number', step: 1, id: 'home-z', value: Number.isFinite(map.home_z) ? map.home_z : 0 });
    inner.append(h('div', { class: 'card' },
      h('h2', {}, '表示モードの最初の位置'),
      h('p', { class: 'desc' }, '表示モードを開いたとき、この座標を中心に、画面の横幅いっぱいで 5km が入るくらいまで拡大して表示します。'),
      h('div', { class: 'bounds-grid' },
        h('div', {}, h('label', { class: 'lbl', for: 'home-x' }, 'X'), fx),
        h('div', {}, h('label', { class: 'lbl', for: 'home-z' }, 'Z'), fz)),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: async () => {
        const x = Math.round(+fx.value), z = Math.round(+fz.value);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return toast('数字を入れてください');
        try { await store.setStartView(x, z); toast('保存しました'); }
        catch (e) { toast(/home_x/.test(e.message || '') ? 'データベースの更新が必要です（schema.sql をもう一度実行してください）' : `保存できませんでした：${e.message || e}`, 6000); }
      } }, '保存'))));
  }

  if (store.kind !== 'remote') return;

  // 共有リンク
  const linkOf = () => `${location.origin}${location.pathname}?map=${store.mapId}&key=${map.view_key}`;
  const link = h('input', { type: 'text', readonly: true, value: linkOf() });
  inner.append(h('div', { class: 'card' },
    h('h2', {}, '表示モードの共有リンク'),
    h('p', { class: 'desc' }, 'このリンクを渡した人だけがマップを見られます（ログイン不要）。リンクを作り直すと、古いリンクは使えなくなります。'),
    h('div', { class: 'inline' }, link, h('button', { class: 'btn', onclick: () => { navigator.clipboard?.writeText(link.value); toast('コピーしました'); } }, icon('copy'), 'コピー')),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', onclick: async () => {
      if (!(await ask('共有リンクを作り直しますか？今のリンクは使えなくなります。', '作り直す'))) return;
      try { await store.regenerateViewKey(); link.value = linkOf(); toast('新しいリンクを作りました'); } catch (e) { toast('失敗しました'); }
    } }, 'リンクを作り直す'))));

  // サイトのトップ
  const homeState = h('p', { class: 'desc' }, '確認中…');
  const homeBtn = h('button', { class: 'btn primary', hidden: true, onclick: async () => {
    try { await store.setHome(); toast('トップに表示するようにしました'); showHome(); } catch (e) { toast(`変更できませんでした：${e.message || e}`); }
  } }, 'このマップをトップに表示する');
  const showHome = async () => {
    const on = await store.isHome();
    homeState.textContent = on
      ? `このマップは、サイトのURL（${location.origin}${location.pathname}）を開いたときに表示モードで表示されます。`
      : 'いまは別のマップ（または何も）がトップに表示されています。';
    homeBtn.hidden = on;
  };
  inner.append(h('div', { class: 'card' }, h('h2', {}, 'サイトのトップ'), homeState, h('div', { class: 'btn-row' }, homeBtn)));
  showHome();

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
          if (!(await ask(`${m.email} の権限を外しますか？`, '外す'))) return;
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
// auth = { password(email, pw), sendMail(email), verifyCode(email, code) }
export function startLogin(root, auth) {
  const full = { width: '100%', justifyContent: 'center', marginTop: '10px' };
  const email = h('input', { type: 'email', placeholder: 'メールアドレス', autocomplete: 'email' });
  const okEmail = () => { const v = email.value.trim(); return /^\S+@\S+\.\S+$/.test(v) ? v : null; };

  // パスワードでログイン
  const pw = h('input', { type: 'password', placeholder: 'パスワード', autocomplete: 'current-password', style: { marginTop: '8px' },
    onkeydown: (e) => { if (e.key === 'Enter') pwBtn.click(); } });
  const pwMsg = h('div', { class: 'muted', style: { marginTop: '8px' } });
  const pwBtn = h('button', { class: 'btn primary', style: full, onclick: async () => {
    const v = okEmail();
    if (!v) { pwMsg.textContent = 'メールアドレスを確認してください'; return; }
    if (!pw.value) { pwMsg.textContent = 'パスワードを入れてください'; return; }
    pwBtn.disabled = true; pwMsg.textContent = 'ログイン中…';
    try { await auth.password(v, pw.value); location.reload(); }
    catch (e) {
      pwMsg.textContent = /invalid login credentials/i.test(e.message || '')
        ? 'メールアドレスかパスワードが違います。パスワードをまだ作っていない場合は、下の「メールでログイン」から入ってください。'
        : `ログインできませんでした：${e.message || e}`;
      pwBtn.disabled = false;
    }
  } }, 'ログイン');

  // メールでログイン（初回・パスワードを忘れたとき）
  const msg = h('div', { class: 'muted', style: { marginTop: '10px' } });
  const btn = h('button', { class: 'btn', style: full, onclick: async () => {
    const v = okEmail();
    if (!v) { msg.textContent = 'メールアドレスを確認してください'; return; }
    btn.disabled = true; msg.textContent = '送信中…';
    try { await auth.sendMail(v); msg.textContent = `${v} にログイン用のメールを送りました。メールのリンクを押すか、メールに書かれたコードを下に入れてください。`; codeBox.hidden = false; }
    catch (e) {
      msg.textContent = /rate limit/i.test(e.message || '')
        ? 'メールの送信回数の上限に達しました。しばらく（1時間ほど）待ってからもう一度送ってください。'
        : `送信できませんでした：${e.message || e}`;
      btn.disabled = false;
    }
  } }, 'ログインメールを送る');
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: 'メールに書かれたコード', maxlength: 10 });
  const codeMsg = h('div', { class: 'muted', style: { marginTop: '8px' } });
  const codeBtn = h('button', { class: 'btn', style: { ...full, marginTop: '8px' }, onclick: async () => {
    const t = code.value.replace(/\s/g, '');
    if (!/^\d{6,10}$/.test(t)) { codeMsg.textContent = '数字のコードを入れてください'; return; }
    codeBtn.disabled = true; codeMsg.textContent = '確認中…';
    try { await auth.verifyCode(email.value.trim(), t); location.reload(); }
    catch (e) { codeMsg.textContent = `ログインできませんでした：${e.message || e}`; codeBtn.disabled = false; }
  } }, 'コードでログイン');
  const codeBox = h('div', { hidden: true, style: { marginTop: '14px' } }, code, codeBtn, codeMsg);
  const mailBox = h('div', { hidden: true, style: { marginTop: '6px' } },
    h('p', { class: 'desc' }, '初めての方・パスワードを忘れた方は、メールに届くリンクでログインし、マップ一覧の画面でパスワードを作ってください。'),
    btn, msg, codeBox);
  const mailToggle = h('button', { class: 'linklike', onclick: () => { mailBox.hidden = false; mailToggle.hidden = true; } },
    'パスワードがまだない・忘れた → メールでログイン');

  root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'login' },
    logo(), h('h1', {}, '編集・管理にはログイン'),
    h('div', { class: 'card' },
      h('label', { class: 'muted' }, 'メールアドレス'), email, pw, pwBtn, pwMsg,
      h('div', { class: 'login-sep' }), mailToggle, mailBox),
    h('div', { class: 'muted', style: { fontSize: '12px' } }, '一度ログインすれば、このブラウザではログアウトするまでログインしたままになります。'))));
}

// パスワードの設定・変更カード
function passwordCard(setPassword) {
  const a = h('input', { type: 'password', placeholder: '新しいパスワード（8文字以上）', autocomplete: 'new-password' });
  const b2 = h('input', { type: 'password', placeholder: 'もう一度', autocomplete: 'new-password', style: { marginTop: '8px' } });
  const msg = h('div', { class: 'muted', style: { marginTop: '8px' } });
  const btn = h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: async () => {
    if (a.value.length < 8) { msg.textContent = '8文字以上にしてください'; return; }
    if (a.value !== b2.value) { msg.textContent = '2つのパスワードが一致しません'; return; }
    btn.disabled = true; msg.textContent = '保存中…';
    try { await setPassword(a.value); a.value = b2.value = ''; msg.textContent = 'パスワードを設定しました。次からはメールアドレスとパスワードでログインできます。'; }
    catch (e) {
      msg.textContent = /different from the old/i.test(e.message || '') ? '今と同じパスワードです' : `設定できませんでした：${e.message || e}`;
    } finally { btn.disabled = false; }
  } }, 'パスワードを設定');
  return h('div', { class: 'card' }, h('h2', {}, 'パスワード'),
    h('p', { class: 'desc' }, 'パスワードを作ると、次からはメールを送らずにメールアドレスとパスワードでログインできます。変更もここからできます。'),
    h('div', { style: { maxWidth: '360px' } }, a, b2, btn, msg));
}

// ---------- マップ一覧 ----------
export function startDashboard(root, { maps, create, signOut, email, setPassword }) {
  const inner = pageShell(root, email, null, h('button', { class: 'btn', onclick: signOut }, icon('logout'), 'ログアウト'));
  const name = h('input', { type: 'text', placeholder: '新しいマップの名前（例：ウープ島）' });
  inner.append(h('div', { class: 'card' },
    h('h2', {}, '新しいマップを作る'), h('p', { class: 'desc' }, '作った人が最初の管理者になります。'),
    h('div', { class: 'inline' }, name, h('button', { class: 'btn primary', onclick: async () => {
      try { const id = await create(name.value.trim() || '新しいマップ'); location.href = `?map=${id}&mode=edit`; } catch (e) { console.error(e); toast(`作成に失敗しました：${e.message || e}`, 8000); }
    } }, '作成'))));
  inner.append(h('div', { class: 'card maplist' },
    h('h2', {}, 'あなたが編集できるマップ'),
    maps.length ? null : h('p', { class: 'desc' }, 'まだありません。管理者に招待してもらうか、新しく作ってください。'),
    ...maps.map((m) => h('a', { href: `?map=${m.id}&mode=edit` }, h('span', {}, h('b', {}, m.name), ' ', h('span', { class: 'muted' }, sizeLabel(boundsOf(m)))), icon('edit')))));
  if (setPassword) inner.append(passwordCard(setPassword));
}

// ---------- マップの範囲 ----------
function boundsCard(store) {
  const b = boundsOf(store.map);
  const step = h('select', { id: 'bstep', style: { width: 'auto' } }, ...[[256, '256m'], [1000, '1km'], [5000, '5km'], [10000, '10km']].map(([v, l]) => h('option', { value: v, selected: v === 1000 }, l)));
  const label = h('b');
  const err = h('div', { class: 'muted', style: { color: '#c93838' } });
  const fields = {};
  const sides = [
    ['z0', '北の端 (Z)', -1], ['z1', '南の端 (Z)', 1],
    ['x0', '西の端 (X)', -1], ['x1', '東の端 (X)', 1],
  ];
  const cur = () => ({ x0: +fields.x0.value, x1: +fields.x1.value, z0: +fields.z0.value, z1: +fields.z1.value });
  const upd = () => { const c = cur(); const e = validBounds(c); err.textContent = e || ''; label.textContent = e ? '—' : sizeLabel(c); };
  const grid = h('div', { class: 'bounds-grid' }, ...sides.map(([k, lbl, dir]) => {
    fields[k] = h('input', { type: 'number', id: `b-${k}`, step: 1, value: b[k], oninput: upd });
    const bump = (sign) => { fields[k].value = +fields[k].value + sign * dir * +step.value; upd(); };
    return h('div', {}, h('label', { class: 'lbl', for: `b-${k}` }, lbl),
      h('div', { class: 'stepper' },
        h('button', { class: 'btn', title: '狭める', onclick: () => bump(-1) }, '−'), fields[k],
        h('button', { class: 'btn', title: '広げる', onclick: () => bump(1) }, '＋')));
  }));
  const all = (sign) => { for (const [k, , dir] of sides) fields[k].value = +fields[k].value + sign * dir * +step.value; upd(); };
  upd();
  return h('div', { class: 'card' },
    h('h2', {}, 'マップの範囲'),
    h('p', { class: 'desc' }, '東西南北それぞれの端を、マイクラの座標（1ブロック = 1m）で自由に決められます。1辺は最大 200km。狭めても描いた内容は消えず、範囲の外に出た部分が表示されなくなるだけです。'),
    grid,
    h('div', { class: 'btn-row', style: { alignItems: 'center' } },
      h('span', { class: 'muted' }, '増減の単位'), step,
      h('button', { class: 'btn', onclick: () => all(1) }, '四方に広げる'),
      h('button', { class: 'btn', onclick: () => all(-1) }, '四方を狭める')),
    h('div', { class: 'btn-row', style: { alignItems: 'center', justifyContent: 'space-between' } },
      h('span', {}, '大きさ ', label), err,
      h('button', { class: 'btn primary', onclick: async () => {
        const c = cur(); const e = validBounds(c);
        if (e) return toast(e);
        try { await store.setBounds(c); toast(`範囲を ${sizeLabel(c)} にしました`); } catch (x) { console.error(x); toast('保存できませんでした。通信状況を確認してもう一度お試しください'); }
      } }, '範囲を保存')));
}
