// =============================================================
// ローカル保存 (デモ用)：ブラウザの IndexedDB に保存する。
// Supabase を設定していないときに使われる。
// 同じブラウザの別タブ同士では BroadcastChannel で同時編集できる。
// =============================================================
const DB = 'woopmap-local';

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (db.objectStoreNames.contains('chunks')) db.deleteObjectStore('chunks'); // 旧形式は作り直す
      db.createObjectStore('chunks');
      if (!db.objectStoreNames.contains('overlays')) db.createObjectStore('overlays', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); location.reload(); }; res(db); };
    r.onerror = () => rej(r.error);
    r.onblocked = () => alert('WOOP MAP を開いている他のタブを閉じてから再読み込みしてください');
  });
}
const tx = (db, store, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(store, mode);
  const s = t.objectStore(store);
  const out = fn(s);
  t.oncomplete = () => res(out && 'result' in out ? out.result : out);
  t.onerror = () => rej(t.error);
});
const all = (db, store) => new Promise((res, rej) => {
  const r = db.transaction(store).objectStore(store).getAll();
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});

export class LocalStore {
  constructor() {
    this.kind = 'local';
    this.bc = 'BroadcastChannel' in window ? new BroadcastChannel('woopmap-local') : null;
    this.clientId = Math.random().toString(36).slice(2);
    this.user = { email: `tab-${this.clientId.slice(0, 4)}@local`, id: 'local' };
    this.urls = new Map();
  }
  async init() {
    this.db = await openDb();
    const name = await new Promise((res) => {
      const r = this.db.transaction('meta').objectStore('meta').get('name');
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    });
    this.map = { id: 'local', name: name || 'WOOP MAP デモ', size_km: 100 };
    this.role = 'admin';
    return this.map;
  }
  async renameMap(name) {
    await tx(this.db, 'meta', 'readwrite', (s) => s.put(name, 'name'));
    this.map.name = name;
  }

  // ---- 地形 ----
  // キーは "lv:cx,cz"。ローカルは本データも一緒に返す（読み込みが速いので）
  async loadTerrainMeta() { return all(this.db, 'chunks'); }
  async loadTerrainData() { return []; }
  async fetchRows(lv, list) {
    const s = this.db.transaction('chunks').objectStore('chunks');
    const rows = await Promise.all(list.map(([cx, cz]) => new Promise((res) => {
      const r = s.get(`${lv}:${cx},${cz}`);
      r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
    })));
    return rows.filter(Boolean);
  }
  async saveRows(rows) {
    await tx(this.db, 'chunks', 'readwrite', (s) => { for (const r of rows) s.put(r, `${r.lv}:${r.cx},${r.cz}`); });
  }
  async deleteRows(lv, list) {
    await tx(this.db, 'chunks', 'readwrite', (s) => { for (const [cx, cz] of list) s.delete(`${lv}:${cx},${cz}`); });
  }
  async deleteSupers(supers, SC) {
    // 既存のキーを一度だけ読み、該当するものを1トランザクションで消す
    const want = new Set(supers.map(([sx, sz]) => `${sx},${sz}`));
    const t = this.db.transaction('chunks', 'readwrite');
    const s = t.objectStore('chunks');
    const req = s.getAllKeys();
    req.onsuccess = () => {
      for (const k of req.result) {
        if (!k.startsWith('0:')) continue;
        const [cx, cz] = k.slice(2).split(',').map(Number);
        if (want.has(`${Math.floor(cx / SC)},${Math.floor(cz / SC)}`)) s.delete(k);
      }
    };
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }

  // ---- 画像レイヤー ----
  async listOverlays() {
    const rows = await all(this.db, 'overlays');
    return rows.map((r) => this._withUrl(r));
  }
  _withUrl(r) {
    if (!this.urls.has(r.id)) this.urls.set(r.id, URL.createObjectURL(r.blob));
    const { blob, ...rest } = r;
    return { ...rest, url: this.urls.get(r.id) };
  }
  async addOverlay(file, meta) {
    const row = { id: crypto.randomUUID(), ...meta, blob: file };
    await tx(this.db, 'overlays', 'readwrite', (s) => s.put(row));
    this._post({ t: 'overlays' });
    return this._withUrl(row);
  }
  async updateOverlay(id, patch) {
    const rows = await all(this.db, 'overlays');
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, patch);
    await tx(this.db, 'overlays', 'readwrite', (s) => s.put(r));
    this._post({ t: 'overlays' });
  }
  async deleteOverlay(id) {
    await tx(this.db, 'overlays', 'readwrite', (s) => s.delete(id));
    this._post({ t: 'overlays' });
  }

  // ---- 同時編集 (同じブラウザのタブ間) ----
  subscribe(h) {
    if (!this.bc) return;
    this.bc.onmessage = (e) => {
      const m = e.data;
      if (m.from === this.clientId) return;
      if (m.t === 'op') h.onOp?.(m.op);
      else if (m.t === 'overlays') h.onOverlays?.();
      else if (m.t === 'reload') h.onReload?.(m.keys);
      else if (m.t === 'presence') h.onPresence?.(m.from, m.state);
    };
  }
  _post(m) { this.bc?.postMessage({ ...m, from: this.clientId }); }
  sendOp(op) { this._post({ t: 'op', op }); }
  sendReload(keys) { this._post({ t: 'reload', keys }); }
  trackPresence(state) { this._post({ t: 'presence', state }); }
  async signOut() {}
}
