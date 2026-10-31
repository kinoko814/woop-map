// =============================================================
// Supabase 保存 (本番用)：ログイン・権限・保存・同時編集
// =============================================================
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

let sbModule = null;
async function lib() {
  if (!sbModule) sbModule = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  return sbModule;
}
/** viewKey を渡すと「リンクを知っている人だけ閲覧可」の鍵をヘッダーに載せる */
export async function makeClient(viewKey) {
  const { createClient } = await lib();
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: viewKey ? { headers: { 'x-map-key': viewKey } } : {},
    auth: { persistSession: !viewKey, storageKey: 'woopmap-auth' },
  });
}

// ---------- ログイン ----------
export async function currentUser(sb) {
  const { data } = await sb.auth.getSession();
  return data.session?.user || null;
}
export async function sendLoginMail(sb, email) {
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname + location.search },
  });
  if (error) throw error;
}

// ---------- マップ一覧 (ダッシュボード) ----------
export async function listMyMaps(sb) {
  const { data, error } = await sb.from('maps').select('id,name,x_min,x_max,z_min,z_max,created_at').order('created_at');
  if (error) throw error;
  return data;
}
export async function createMap(sb, name) {
  const { data, error } = await sb.from('maps').insert({ name }).select('id').single();
  if (error) throw error;
  return data.id;
}

// ---------- 1枚のマップを扱うストア ----------
export class RemoteStore {
  constructor(sb, mapId, user) {
    this.kind = 'remote';
    this.sb = sb; this.mapId = mapId; this.user = user;
    this.clientId = Math.random().toString(36).slice(2);
    this.urlCache = new Map();
  }
  async init() {
    const { data, error } = await this.sb.from('maps').select('*').eq('id', this.mapId).single();
    if (error || !data) throw new Error('マップが見つからないか、権限がありません');
    this.map = data;
    this.role = null;
    if (this.user) {
      if (data.owner === this.user.id) this.role = 'admin';
      else {
        const { data: m } = await this.sb.from('map_members').select('role')
          .eq('map_id', this.mapId).eq('email', this.user.email.toLowerCase()).maybeSingle();
        this.role = m?.role || null;
      }
    }
    return this.map;
  }

  // ---- 地形 ----
  // lv1 = スーパーチャンクの代表値、lv0 = 個別チャンク（本データ data は必要な時だけ取得）
  async loadTerrainMeta(onProgress = () => {}) {
    const rows = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.sb.from('terrain_chunks').select('lv,cx,cz,u,pv')
        .eq('map_id', this.mapId).order('lv').order('cx').order('cz').range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push(...data);
      onProgress(rows.length);
      if (data.length < PAGE) break;
    }
    return rows;
  }
  async loadTerrainData(keys) {
    const { cxOf, czOf } = await import('../engine/terrain.js');
    return this.fetchRows(0, keys.map((k) => [cxOf(k), czOf(k)]), 'cx,cz,data');
  }
  async fetchRows(lv, list, cols = 'lv,cx,cz,u,data,pv') {
    const parts = [];
    for (let i = 0; i < list.length; i += 50) parts.push(list.slice(i, i + 50));
    const out = [];
    // 4本並列で取得
    for (let i = 0; i < parts.length; i += 4) {
      const res = await Promise.all(parts.slice(i, i + 4).map((part) => {
        const or = part.map(([cx, cz]) => `and(cx.eq.${cx},cz.eq.${cz})`).join(',');
        return this.sb.from('terrain_chunks').select(cols).eq('map_id', this.mapId).eq('lv', lv).or(or);
      }));
      for (const { data, error } of res) { if (error) throw error; out.push(...data); }
    }
    return out;
  }
  async saveRows(rows, onProgress = () => {}) {
    for (let i = 0; i < rows.length; i += 300) {
      const part = rows.slice(i, i + 300).map((r) => ({ ...r, map_id: this.mapId, updated_by: this.user?.id, updated_at: new Date().toISOString() }));
      const { error } = await this.sb.from('terrain_chunks').upsert(part);
      if (error) throw error;
      onProgress(Math.min(rows.length, i + 300));
    }
  }
  async deleteRows(lv, list) {
    for (let i = 0; i < list.length; i += 50) {
      const or = list.slice(i, i + 50).map(([cx, cz]) => `and(cx.eq.${cx},cz.eq.${cz})`).join(',');
      const { error } = await this.sb.from('terrain_chunks').delete().eq('map_id', this.mapId).eq('lv', lv).or(or);
      if (error) throw error;
    }
  }
  async deleteSupers(supers, SC) {
    for (let i = 0; i < supers.length; i += 500) {
      const part = supers.slice(i, i + 500);
      const { error } = await this.sb.rpc('delete_super_chunks', { m: this.mapId, sx: part.map((p) => p[0]), sz: part.map((p) => p[1]), sc: SC });
      if (error) throw error;
    }
  }

  // ---- 写真（駅・施設）：縮小して公開バケットへ ----
  async uploadPhoto(file) {
    const { imageToDataURL } = await import('../ui/dom.js');
    const dataUrl = await imageToDataURL(file, 1600, 'image/jpeg', 0.84);
    const blob = await (await fetch(dataUrl)).blob();
    const path = `${this.mapId}/${crypto.randomUUID()}.jpg`;
    const { error } = await this.sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg' });
    if (error) throw error;
    return this.sb.storage.from('photos').getPublicUrl(path).data.publicUrl;
  }

  // ---- 図形（道路・交差点など） ----
  async listFeatures() {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await this.sb.from('features').select('id,kind,data')
        .eq('map_id', this.mapId).order('id').range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    return rows;
  }
  async saveFeatures(rows) {
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500).map((r) => ({ ...r, map_id: this.mapId, updated_at: new Date().toISOString() }));
      const { error } = await this.sb.from('features').upsert(part);
      if (error) throw error;
    }
  }
  async deleteFeatures(ids) {
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await this.sb.from('features').delete().eq('map_id', this.mapId).in('id', ids.slice(i, i + 200));
      if (error) throw error;
    }
  }

  // ---- 画像レイヤー ----
  async listOverlays() {
    const { data, error } = await this.sb.from('overlays').select('*').eq('map_id', this.mapId).order('ord');
    if (error) throw error;
    return Promise.all(data.map((r) => this._withUrl(r)));
  }
  async _withUrl(r) {
    if (!this.urlCache.has(r.path)) {
      const { data } = await this.sb.storage.from('overlays').createSignedUrl(r.path, 60 * 60 * 24);
      this.urlCache.set(r.path, data?.signedUrl);
    }
    return { ...r, url: this.urlCache.get(r.path) };
  }
  async addOverlay(file, meta) {
    const id = crypto.randomUUID();
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const path = `${this.mapId}/${id}.${ext}`;
    const up = await this.sb.storage.from('overlays').upload(path, file, { contentType: file.type });
    if (up.error) throw up.error;
    const row = { id, map_id: this.mapId, path, ...meta };
    const { error } = await this.sb.from('overlays').insert(row);
    if (error) throw error;
    return this._withUrl(row);
  }
  async updateOverlay(id, patch) {
    const { error } = await this.sb.from('overlays').update(patch).eq('id', id);
    if (error) throw error;
  }
  async deleteOverlay(id) {
    const { data } = await this.sb.from('overlays').select('path').eq('id', id).single();
    await this.sb.from('overlays').delete().eq('id', id);
    if (data?.path) await this.sb.storage.from('overlays').remove([data.path]);
  }

  // ---- 同時編集 ----
  subscribe(h) {
    const ch = this.sb.channel(`map-${this.mapId}`, { config: { broadcast: { self: false }, presence: { key: this.clientId } } });
    ch.on('broadcast', { event: 'op' }, ({ payload }) => h.onOp?.(payload))
      .on('broadcast', { event: 'reload' }, ({ payload }) => h.onReload?.(payload.keys))
      .on('broadcast', { event: 'cursor' }, ({ payload }) => h.onPresence?.(payload.from, payload.state))
      .on('presence', { event: 'sync' }, () => h.onPeople?.(Object.values(ch.presenceState()).map((a) => a[0])))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'overlays', filter: `map_id=eq.${this.mapId}` }, () => h.onOverlays?.())
      .subscribe(async (st) => {
        if (st === 'SUBSCRIBED') await ch.track({ email: this.user?.email, id: this.clientId });
      });
    this.ch = ch;
  }
  sendOp(op) { this.ch?.send({ type: 'broadcast', event: 'op', payload: op }); }
  sendReload(keys) { this.ch?.send({ type: 'broadcast', event: 'reload', payload: { keys } }); }
  trackPresence(state) { this.ch?.send({ type: 'broadcast', event: 'cursor', payload: { from: this.clientId, state } }); }

  // ---- 管理 ----
  async renameMap(name) {
    const { error } = await this.sb.from('maps').update({ name }).eq('id', this.mapId);
    if (error) throw error;
    this.map.name = name;
  }
  async setBounds(b) {
    const v = { x_min: Math.round(b.x0), x_max: Math.round(b.x1), z_min: Math.round(b.z0), z_max: Math.round(b.z1) };
    const { error } = await this.sb.from('maps').update(v).eq('id', this.mapId);
    if (error) throw error;
    Object.assign(this.map, v);
  }
  async regenerateViewKey() {
    const key = crypto.randomUUID().replace(/-/g, '');
    const { error } = await this.sb.from('maps').update({ view_key: key }).eq('id', this.mapId);
    if (error) throw error;
    this.map.view_key = key;
    return key;
  }
  async listMembers() {
    const { data, error } = await this.sb.from('map_members').select('email,role').eq('map_id', this.mapId).order('email');
    if (error) throw error;
    return data;
  }
  async addMember(email, role) {
    const { error } = await this.sb.from('map_members').upsert({ map_id: this.mapId, email: email.trim().toLowerCase(), role });
    if (error) throw error;
  }
  async removeMember(email) {
    const { error } = await this.sb.from('map_members').delete().eq('map_id', this.mapId).eq('email', email);
    if (error) throw error;
  }
  async signOut() { await this.sb.auth.signOut(); }
}
