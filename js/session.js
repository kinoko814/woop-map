// =============================================================
// MapSession : 地形編集・保存・Undo/Redo・他の編集者との同期
//
// 保存は2段構え（100km四方でも行数を少なく保つため）
//   lv1 : 4096m 四方の「スーパーチャンク」= 16×16 チャンクの代表値 u
//   lv0 : 代表値と違うチャンクだけを個別に保存
//   → 全体を海で塗っても保存は数百行で済む
// =============================================================
import { keyOf, cxOf, czOf } from './engine/terrain.js';

export const SC = 16;    // スーパーチャンク一辺 (チャンク数)
const skeyOf = (sx, sz) => `${sx},${sz}`;

export class MapSession {
  constructor(store, terrain) {
    this.store = store;
    this.terrain = terrain;
    this.undoStack = []; this.redoStack = [];
    this.dirty = new Set();
    this.bases = new Map();       // "sx,sz" -> 保存済みの代表値
    this.chain = Promise.resolve();
    this.saveTimer = null;
    this.saving = false;
    this.onStatus = () => {};     // ('saving'|'saved'|'unsaved'|'error'|'busy', msg)
    this.onHistory = () => {};
    // 保存前のチャンクはメモリから追い出さない
    terrain.protectFn = (k) => this.dirty.has(k);
  }

  async load(progress = () => {}) {
    const rows = await this.store.loadTerrainMeta(progress);
    applyRows(this.terrain, this.bases, rows);
    this.terrain.loader = (keys) => this.store.loadTerrainData(keys);
    if (this.store.kind === 'local') this.terrain.maxLoaded = Infinity;
  }

  _run(fn) {
    const p = this.chain.then(fn);
    this.chain = p.catch((e) => { console.error(e); this.onStatus('error', String(e.message || e)); });
    return p;
  }
  async _apply(op) {
    if (op.t === 'stroke') return this.terrain.stroke(op.pts, op.w, op.v);
    if (op.t === 'fill') return this.terrain.fill(op.x, op.z, op.v, (n) => this.onStatus('busy', `塗りつぶし中… ${n.toLocaleString()} チャンク`));
    return null;
  }

  /** 自分の操作 */
  doOp(op) {
    return this._run(async () => {
      this.onStatus('busy', '処理中…');
      const res = await this._apply(op);
      if (!res || !res.keys.size) { this.onStatus(this.dirty.size ? 'unsaved' : 'saved'); return; }
      this.undoStack.push(res.undo);
      if (this.undoStack.length > 40) this.undoStack.shift();
      this.redoStack = [];
      this.onHistory();
      this.store.sendOp(op);
      this._markDirty(res.keys);
    });
  }
  /** 他の編集者の操作 */
  applyRemote(op) {
    return this._run(async () => {
      await this._apply(op);
      this.onStatus(this.dirty.size || this.saving ? 'unsaved' : 'saved');
    });
  }
  /** 他の編集者の Undo などで、チャンクを取り直す */
  reload(list) {
    return this._run(async () => {
      const sks = new Map();
      for (const [cx, cz] of list) { const sx = Math.floor(cx / SC), sz = Math.floor(cz / SC); sks.set(skeyOf(sx, sz), [sx, sz]); }
      const [supers, rows] = await Promise.all([
        this.store.fetchRows(1, [...sks.values()]),
        this.store.fetchRows(0, list),
      ]);
      for (const r of supers) this.bases.set(skeyOf(r.cx, r.cz), r.u);
      const got = new Set(rows.map((r) => keyOf(r.cx, r.cz)));
      const filled = list.filter(([cx, cz]) => !got.has(keyOf(cx, cz)))
        .map(([cx, cz]) => ({ cx, cz, u: this.bases.get(skeyOf(Math.floor(cx / SC), Math.floor(cz / SC))) ?? 0 }));
      this.terrain.ingestMeta([...rows, ...filled]);
      this.terrain.onChange(new Set(list.map(([cx, cz]) => keyOf(cx, cz))));
    });
  }

  undo() { return this._history(this.undoStack, this.redoStack); }
  redo() { return this._history(this.redoStack, this.undoStack); }
  _history(from, to) {
    return this._run(async () => {
      const snap = from.pop();
      if (!snap) return;
      await this.terrain.ensureLoaded([...snap.keys()]);
      const inverse = new Map();
      for (const k of snap.keys()) this.terrain._snap(inverse, k, this.terrain.chunks.get(k));
      to.push(inverse);
      const keys = this.terrain.restore(snap);
      this.onHistory();
      this._markDirty(keys, true);
    });
  }

  _markDirty(keys, announceReload = false) {
    for (const k of keys) this.dirty.add(k);
    if (announceReload) this._reloadAfterSave = [...(this._reloadAfterSave || []), ...keys];
    this.onStatus('unsaved');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 800);
  }

  async flush() {
    if (this.saving) { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.flush(), 500); return; }
    if (!this.dirty.size) return;
    this.saving = true;
    const keys = [...this.dirty]; this.dirty.clear();
    const reload = this._reloadAfterSave || []; this._reloadAfterSave = [];
    this.onStatus('saving', '保存中…');
    try {
      const plan = this._plan(keys);
      if (plan.clearSupers.length) await this.store.deleteSupers(plan.clearSupers, SC);
      if (plan.del.length) await this.store.deleteRows(0, plan.del);
      const rows = [...plan.supers, ...plan.put.map((k) => ({ lv: 0, ...this.terrain.serialize(k) }))];
      await this.store.saveRows(rows, (n) => this.onStatus('saving', `保存中… ${Math.round((n / rows.length) * 100)}%`));
      for (const [sk, u] of plan.newBases) this.bases.set(sk, u);
      if (reload.length) this.store.sendReload(reload.map((k) => [cxOf(k), czOf(k)]));
      this.onStatus(this.dirty.size ? 'unsaved' : 'saved');
    } catch (e) {
      console.error(e);
      keys.forEach((k) => this.dirty.add(k));
      this.onStatus('error', '保存に失敗しました。自動で再試行します');
      clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.flush(), 4000);
    } finally { this.saving = false; }
  }

  /** 保存内容を決める：スーパーチャンクごとに代表値を出し、違うものだけ個別保存 */
  _plan(keys) {
    const t = this.terrain;
    const groups = new Map();
    for (const k of keys) {
      const sx = Math.floor(cxOf(k) / SC), sz = Math.floor(czOf(k) / SC);
      const sk = skeyOf(sx, sz);
      if (!groups.has(sk)) groups.set(sk, { sx, sz, keys: [] });
      groups.get(sk).keys.push(k);
    }
    const plan = { supers: [], clearSupers: [], put: [], del: [], newBases: [] };
    const valOf = (k) => { const c = t.chunks.get(k); return c ? c.u : 0; };   // null = 一様でない
    for (const [sk, g] of groups) {
      const cnt = new Map();
      for (let j = 0; j < SC; j++) for (let i = 0; i < SC; i++) {
        if (!t.inBounds(g.sx * SC + i, g.sz * SC + j)) continue;
        const u = valOf(keyOf(g.sx * SC + i, g.sz * SC + j));
        if (u !== null) cnt.set(u, (cnt.get(u) || 0) + 1);
      }
      let b = 0, best = -1;
      for (const [u, n] of [...cnt].sort((a, c) => a[0] - c[0])) if (n > best) { best = n; b = u; }
      const prev = this.bases.get(sk) ?? 0;
      if (b !== prev) {
        // 代表値が変わった → このスーパーチャンクを丸ごと書き直す
        plan.supers.push({ lv: 1, cx: g.sx, cz: g.sz, u: b, data: null, pv: null });
        plan.clearSupers.push([g.sx, g.sz]);
        for (let j = 0; j < SC; j++) for (let i = 0; i < SC; i++) {
          if (!t.inBounds(g.sx * SC + i, g.sz * SC + j)) continue;
          const k = keyOf(g.sx * SC + i, g.sz * SC + j);
          if (valOf(k) !== b) plan.put.push(k);
        }
        plan.newBases.push([sk, b]);
      } else {
        for (const k of g.keys) {
          if (valOf(k) === b) plan.del.push([cxOf(k), czOf(k)]);
          else plan.put.push(k);
        }
      }
    }
    return plan;
  }
  get hasUnsaved() { return this.dirty.size > 0 || this.saving; }
}

/** 読み込んだ行 (lv0/lv1 混在) を地形に反映する */
export function applyRows(terrain, bases, rows) {
  const supers = rows.filter((r) => r.lv === 1);
  const chunks = rows.filter((r) => r.lv !== 1);
  const expanded = [];
  for (const s of supers) {
    bases.set(skeyOf(s.cx, s.cz), s.u);
    if (!s.u) continue;
    for (let j = 0; j < SC; j++) for (let i = 0; i < SC; i++) expanded.push({ cx: s.cx * SC + i, cz: s.cz * SC + j, u: s.u });
  }
  terrain.ingestMeta(expanded);
  terrain.ingestMeta(chunks);
}
