// =============================================================
// Features : 道路・交差点・IC/JCT など「図形」データの入れ物
//   第3段階以降の駅・建物・施設・住所もここに入る。
//
//   node : {id, kind:'node', x, z, lv, name?, signal?, r?, median?}
//          道路の中間点。2本以上の道路が共有すると交差点になる。
//          lv = 0 地上 / 1 高架 / -1 地下
//   road : {id, kind:'road', type, color, name, nodes:[nodeId...], segs:[{w, c}]}
//          segs[i] は nodes[i]→nodes[i+1] の区間。w=太さ(m)、c=曲線なら true
//   area : {id, kind:'area', type:'ic'|'jct', name, desc, poly:[[x,z]...]}
//   rail : {id, kind:'rail', type:'jr'|'private'|'metro', name, color, symbol, logo, nodes, segs:[{c}]}
//   station / building / zone / poi : 第3段階（stations.js / shapes.js を参照）
// =============================================================
export const newId = () => crypto.randomUUID();
export const LINE_KINDS = new Set(['road', 'rail', 'river', 'border']);   // 中間点(node)を持つ線

const EMPTY = new Set();

export class Features {
  constructor() {
    this.items = new Map();
    this.nodeRefs = new Map();    // nodeId -> Set(道路・線路の id)
    this.stamp = new Map();       // id -> 変更回数（形状キャッシュの鍵）
    this.onChange = () => {};
    this.kindVer = {};            // 種類ごとの変更回数（住所の再計算などに使う）
  }
  get(id) { return this.items.get(id) || null; }
  *ofKind(kind) { for (const f of this.items.values()) if (f.kind === kind) yield f; }
  /** そのノードを通る線（道路と線路） */
  linesOf(nodeId) { return this.nodeRefs.get(nodeId) || EMPTY; }
  /** そのノードを通る道路だけ */
  roadsOf(nodeId) {
    const s = this.nodeRefs.get(nodeId);
    if (!s) return EMPTY;
    let all = true;
    for (const id of s) if (this.items.get(id)?.kind !== 'road') { all = false; break; }
    return all ? s : new Set([...s].filter((id) => this.items.get(id)?.kind === 'road'));
  }
  railsOf(nodeId) { return new Set([...this.linesOf(nodeId)].filter((id) => this.items.get(id)?.kind === 'rail')); }

  load(rows) {
    this.items.clear(); this.nodeRefs.clear();
    this.apply(rows.map((r) => ({ id: r.id, after: { id: r.id, kind: r.kind, ...r.data } })), true);
  }

  /**
   * changes: [{id, after: feature|null}]
   * @returns 逆向きの変更（Undo 用）
   */
  apply(changes, silent = false) {
    const inverse = [];
    const touched = new Set();
    for (const { id, after } of changes) {
      const before = this.items.get(id) || null;
      inverse.push({ id, after: before });
      for (const k of [before?.kind, after?.kind]) if (k) this.kindVer[k] = (this.kindVer[k] || 0) + 1;
      if (LINE_KINDS.has(before?.kind)) for (const n of before.nodes) this.nodeRefs.get(n)?.delete(id);
      if (after) this.items.set(id, after); else this.items.delete(id);
      if (LINE_KINDS.has(after?.kind)) for (const n of after.nodes) {
        if (!this.nodeRefs.has(n)) this.nodeRefs.set(n, new Set());
        this.nodeRefs.get(n).add(id);
      }
      touched.add(id);
    }
    // 形状キャッシュの鍵を進める（ノードが動いたら、そのノードを通る道路も）
    for (const id of touched) {
      this.bump(id);
      const f = this.items.get(id);
      if (!f || f.kind === 'node') for (const r of this.linesOf(id)) {
        this.bump(r);
        if (this.items.get(r)?.kind === 'border') this.kindVer.border = (this.kindVer.border || 0) + 1;   // 境界の点が動いた
      }
    }
    inverse.reverse();
    if (!silent) this.onChange(touched);
    return inverse;
  }
  bump(id) { this.stamp.set(id, (this.stamp.get(id) || 0) + 1); }
  toRow(id) {
    const f = this.items.get(id);
    if (!f) return null;
    const { id: _, kind, ...data } = f;
    return { id, kind, data };
  }
}

/**
 * 編集トランザクション：まとめて変更して最後に changes を取り出す。
 * 確定前の状態でも get() / roadsOf() が正しく見えるようにしている。
 */
export class Tx {
  constructor(F) { this.F = F; this.w = new Map(); }
  get(id) { return this.w.has(id) ? this.w.get(id) : this.F.get(id); }
  /** 編集用のコピーを返す */
  edit(id) {
    const f = this.get(id);
    if (!f) return null;
    if (!this.w.has(id) || this.w.get(id) === this.F.get(id)) {
      const c = structuredClone(f);
      this.w.set(id, c);
      return c;
    }
    return this.w.get(id);
  }
  put(f) { this.w.set(f.id, f); return f; }
  del(id) { this.w.set(id, null); }
  linesOf(nodeId) {
    const set = new Set(this.F.linesOf(nodeId));
    for (const [rid, f] of this.w) {
      if (f && LINE_KINDS.has(f.kind) && f.nodes.includes(nodeId)) set.add(rid);
      else if (set.has(rid) && (!f || !f.nodes.includes(nodeId))) set.delete(rid);
    }
    return set;
  }
  roadsOf(nodeId) { return new Set([...this.linesOf(nodeId)].filter((id) => this.get(id)?.kind === 'road')); }
  *ofKind(kind) {
    for (const f of this.F.items.values()) if (f.kind === kind && !this.w.has(f.id)) yield f;
    for (const f of this.w.values()) if (f && f.kind === kind) yield f;
  }
  get size() { return this.w.size; }
  changes() {
    const out = [];
    for (const [id, after] of this.w) {
      const before = this.F.get(id);
      if (after === before) continue;
      if (after && before && JSON.stringify(after) === JSON.stringify(before)) continue;
      out.push({ id, after });
    }
    return out;
  }
}
