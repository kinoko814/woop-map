// =============================================================
// WOOP MAP 地形エンジン
//   世界を 256m × 256m の「チャンク」に分け、1m = 1セル で
//   水・陸・森を保持する。一面同じ色のチャンクは値1つだけで
//   保持するので、100km四方でも軽い。
//   座標は Minecraft と同じ：X が東(右)、Z が南(下)。
// =============================================================

export const CS = 256;          // チャンク一辺 (m)
export const PV = 32;           // 縮小プレビュー一辺 (1セル = 8m)
const PVS = CS / PV;            // 8

export const T = { NONE: 0, LAND: 1, WATER: 2, FOREST: 3 };
export const T_NAMES = ['未設定', '陸', '水', '森'];
export const T_COLORS = ['#e9ebee', '#ffffff', '#a9d3f2', '#c6e6b3'];
const RGBA = T_COLORS.map(hexToRgba);

function hexToRgba(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}
// RGBA を 32bit 1発で書き込むためのテーブル (リトルエンディアン)
const PACKED = RGBA.map(([r, g, b, a]) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0);

const OFF = 32768;
export const keyOf = (cx, cz) => (cx + OFF) * 65536 + (cz + OFF);
export const cxOf = (k) => Math.floor(k / 65536) - OFF;
export const czOf = (k) => (k % 65536) - OFF;

// ---------- RLE + base64 (保存・通信用) ----------
export function rleEncode(arr) {
  const out = [];
  let i = 0;
  const n = arr.length;
  while (i < n) {
    const v = arr[i];
    let j = i + 1;
    while (j < n && arr[j] === v) j++;
    let run = j - i;
    // varint
    while (run >= 128) { out.push((run & 127) | 128); run >>>= 7; }
    out.push(run);
    out.push(v);
    i = j;
  }
  return bytesToB64(Uint8Array.from(out));
}
export function rleDecode(b64, size) {
  const src = b64ToBytes(b64);
  const out = new Uint8Array(size);
  let p = 0, o = 0;
  while (p < src.length && o < size) {
    let run = 0, shift = 0, b;
    do { b = src[p++]; run |= (b & 127) << shift; shift += 7; } while (b & 128);
    const v = src[p++];
    out.fill(v, o, Math.min(size, o + run));
    o += run;
  }
  return out;
}
function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

// ---------- Chunk ----------
// u     : 一様な値 (number) / 一様でなければ null
// data  : Uint8Array(CS*CS)  (u===null かつ読み込み済みのとき)
// pv    : Uint8Array(PV*PV)  (u===null のとき常に存在)
class Chunk {
  constructor(cx, cz, u = 0) {
    this.cx = cx; this.cz = cz;
    this.u = u; this.data = null; this.pv = null;
    this.canvas = null;      // 1m解像度キャッシュ
    this.pvCanvas = null;    // プレビューキャッシュ
    this.lastUse = 0;
  }
}

export class Terrain {
  /**
   * @param {object} opts
   *   loader(keys:number[]) => Promise<[{cx,cz,data:string}]>  未読込チャンクの本データ取得
   *   bounds: {x0,x1,z0,z1} マップの範囲(m)。塗りつぶしの範囲制限
   */
  constructor(opts = {}) {
    this.chunks = new Map();
    this.loader = opts.loader || null;
    this.bounds = opts.bounds || { x0: -50000, x1: 50000, z0: -50000, z1: 50000 };
    this.onChange = () => {};    // (keys:Set) => void   描画・保存へ通知
    this.useTick = 0;
    this.maxLoaded = opts.maxLoaded || 1500;  // 本データを保持する上限
    this.pending = new Map();    // 読み込み中 Promise
  }

  // ---- 参照 ----
  get(cx, cz) { return this.chunks.get(keyOf(cx, cz)); }
  getOrCreate(cx, cz) {
    const k = keyOf(cx, cz);
    let c = this.chunks.get(k);
    if (!c) { c = new Chunk(cx, cz, 0); this.chunks.set(k, c); }
    return c;
  }
  cell(x, z) {
    x = Math.floor(x); z = Math.floor(z);
    const cx = Math.floor(x / CS), cz = Math.floor(z / CS);
    const c = this.get(cx, cz);
    if (!c) return 0;
    if (c.u !== null) return c.u;
    const lx = x - cx * CS, lz = z - cz * CS;
    if (c.data) return c.data[lz * CS + lx];
    return c.pv[((lz / PVS) | 0) * PV + ((lx / PVS) | 0)];
  }
  /** 縮小表示用：プレビュー解像度での値 */
  sampleCoarse(x, z) {
    const cx = Math.floor(x / CS), cz = Math.floor(z / CS);
    const c = this.chunks.get(keyOf(cx, cz));
    if (!c) return 0;
    if (c.u !== null) return c.u;
    const lx = x - cx * CS, lz = z - cz * CS;
    return c.pv[((lz / PVS) | 0) * PV + ((lx / PVS) | 0)];
  }

  // ---- 読み込み (外部ストアから) ----
  /** メタ情報 (一様値 or プレビュー) を一括投入 */
  ingestMeta(rows) {
    for (const r of rows) {
      const c = this.getOrCreate(r.cx, r.cz);
      if (r.u !== null && r.u !== undefined) { c.u = r.u; c.data = null; c.pv = null; }
      else {
        c.u = null;
        c.pv = r.pv ? rleDecode(r.pv, PV * PV) : new Uint8Array(PV * PV);
        c.data = r.data ? rleDecode(r.data, CS * CS) : null;
      }
      c.canvas = null; c.pvCanvas = null;
    }
  }
  /** 本データが必要な (一様でない・未読込の) チャンクを読み込む */
  async ensureLoaded(keys) {
    const need = [];
    const waits = [];
    for (const k of keys) {
      const c = this.chunks.get(k);
      if (!c || c.u !== null || c.data) continue;
      if (this.pending.has(k)) waits.push(this.pending.get(k));
      else need.push(k);
    }
    if (need.length && this.loader) {
      const p = this.loader(need).then((rows) => {
        for (const r of rows) {
          const c = this.chunks.get(keyOf(r.cx, r.cz));
          if (c && c.u === null && !c.data && r.data) { c.data = rleDecode(r.data, CS * CS); c.canvas = null; }
        }
      }).finally(() => need.forEach((k) => this.pending.delete(k)));
      need.forEach((k) => this.pending.set(k, p));
      waits.push(p);
    }
    await Promise.all(waits);
    // ローダーが返さなかったものはプレビューから復元 (データ欠損対策)
    for (const k of keys) {
      const c = this.chunks.get(k);
      if (c && c.u === null && !c.data) c.data = upscalePv(c.pv);
    }
  }
  /** 使っていない本データを捨ててメモリを守る (dirty は除く) */
  evict(protect) {
    const loaded = [];
    for (const [k, c] of this.chunks) if (c.data && !protect.has(k) && !this.protectFn?.(k)) loaded.push(c);
    if (loaded.length <= this.maxLoaded) return;
    loaded.sort((a, b) => a.lastUse - b.lastUse);
    for (let i = 0; i < loaded.length - this.maxLoaded; i++) {
      loaded[i].data = null; loaded[i].canvas = null;
    }
  }

  // ---- シリアライズ ----
  serialize(k) {
    const c = this.chunks.get(k);
    if (!c) return { cx: cxOf(k), cz: czOf(k), u: 0, data: null, pv: null };
    if (c.u !== null) return { cx: c.cx, cz: c.cz, u: c.u, data: null, pv: null };
    // 本データがない（読み込み前・手放した後）ものを書き出すと地形が消えるので、はっきりエラーにする
    if (!c.data || !c.pv) throw new Error(`地形データが読み込まれていません（${c.cx},${c.cz}）`);
    return { cx: c.cx, cz: c.cz, u: null, data: rleEncode(c.data), pv: rleEncode(c.pv) };
  }

  // ---- 編集の下ごしらえ ----
  _snap(undo, k, c) {
    if (!undo || undo.has(k)) return;
    undo.set(k, c ? { u: c.u, data: c.data ? c.data.slice() : null, pv: c.pv ? c.pv.slice() : null } : { u: 0, data: null, pv: null });
  }
  _toData(c) {
    if (c.u !== null) { c.data = new Uint8Array(CS * CS).fill(c.u); c.pv = new Uint8Array(PV * PV).fill(c.u); c.u = null; }
  }
  /** 編集後：一様になっていたら圧縮し、プレビューを作り直す */
  _finalize(c) {
    if (c.u !== null) { c.data = null; c.pv = null; c.canvas = null; c.pvCanvas = null; return; }
    const d = c.data;
    const v0 = d[0];
    let uniform = true;
    for (let i = 1; i < d.length; i++) if (d[i] !== v0) { uniform = false; break; }
    if (uniform) { c.u = v0; c.data = null; c.pv = null; }
    else {
      const pv = c.pv || (c.pv = new Uint8Array(PV * PV));
      for (let j = 0; j < PV; j++) for (let i = 0; i < PV; i++) {
        pv[j * PV + i] = majority(d, i * PVS, j * PVS);
      }
    }
    c.canvas = null; c.pvCanvas = null;
  }
  inBounds(cx, cz) {
    const b = this.bounds;
    return cx * CS + CS > b.x0 && cx * CS < b.x1 && cz * CS + CS > b.z0 && cz * CS < b.z1;
  }

  // ---- ペン ----
  /**
   * 太さ w(m) の線を点列 pts=[[x,z],...] に沿って値 v で描く
   * @returns {Promise<{keys:Set, undo:Map}>}
   */
  async stroke(pts, w, v) {
    const r = Math.max(0.5, w / 2);
    if (pts.length === 1) pts = [pts[0], pts[0]];
    // 影響チャンクを洗い出す
    const segs = [];
    const touched = new Map();      // key -> [segIndex...]
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      segs.push([ax, az, bx, bz]);
      const x0 = Math.floor((Math.min(ax, bx) - r) / CS), x1 = Math.floor((Math.max(ax, bx) + r) / CS);
      const z0 = Math.floor((Math.min(az, bz) - r) / CS), z1 = Math.floor((Math.max(az, bz) + r) / CS);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
        if (!this.inBounds(cx, cz)) continue;
        // チャンクと線分の距離で足切り
        if (rectSegDist(cx * CS, cz * CS, CS, ax, az, bx, bz) > r) continue;
        const k = keyOf(cx, cz);
        let a = touched.get(k);
        if (!a) touched.set(k, (a = []));
        a.push(i);
      }
    }
    // 全面を覆うチャンクは読み込み不要
    const full = new Set();
    const needLoad = [];
    for (const [k, segIdx] of touched) {
      const cx = cxOf(k), cz = czOf(k);
      if (segIdx.some((i) => rectInsideCapsule(cx * CS, cz * CS, CS, segs[i], r))) full.add(k);
      else needLoad.push(k);
    }
    await this.ensureLoaded(needLoad);

    const undo = new Map();
    const keys = new Set();
    const r2 = r * r;
    for (const [k, segIdx] of touched) {
      const cx = cxOf(k), cz = czOf(k);
      const c0 = this.chunks.get(k);
      if (full.has(k)) {
        if (c0 && c0.u === v) continue;
        this._snap(undo, k, c0);
        const c = this.getOrCreate(cx, cz);
        c.u = v; this._finalize(c); keys.add(k);
        continue;
      }
      if (c0 && c0.u === v) continue;
      if (!c0 && v === 0) continue;
      this._snap(undo, k, c0);
      const c = this.getOrCreate(cx, cz);
      this._toData(c);
      const d = c.data;
      const ox = cx * CS, oz = cz * CS;
      let changed = false;
      for (const si of segIdx) {
        const [ax, az, bx, bz] = segs[si];
        const lx0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - ox));
        const lx1 = Math.min(CS - 1, Math.ceil(Math.max(ax, bx) + r - ox));
        const lz0 = Math.max(0, Math.floor(Math.min(az, bz) - r - oz));
        const lz1 = Math.min(CS - 1, Math.ceil(Math.max(az, bz) + r - oz));
        const dx = bx - ax, dz = bz - az;
        const L2 = dx * dx + dz * dz;
        for (let lz = lz0; lz <= lz1; lz++) {
          const pz = oz + lz + 0.5;
          const row = lz * CS;
          for (let lx = lx0; lx <= lx1; lx++) {
            const i = row + lx;
            if (d[i] === v) continue;
            const px = ox + lx + 0.5;
            let t = L2 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = ax + t * dx - px, ez = az + t * dz - pz;
            if (ex * ex + ez * ez <= r2) { d[i] = v; changed = true; }
          }
        }
      }
      this._finalize(c);
      if (changed) keys.add(k); else undo.delete(k);
    }
    this._touch(keys);
    this.onChange(keys);
    return { keys, undo };
  }

  // ---- 塗りつぶし ----
  /**
   * (x,z) とつながった同じ種類の範囲を v に塗る。
   * 一様チャンクは丸ごと1手で処理する「階層フラッドフィル」。
   * @param {(n:number)=>void} progress  処理済みチャンク数
   */
  async fill(x, z, v, progress = () => {}) {
    x = Math.floor(x); z = Math.floor(z);
    const scx = Math.floor(x / CS), scz = Math.floor(z / CS);
    if (!this.inBounds(scx, scz)) return { keys: new Set(), undo: new Map() };
    await this.ensureLoaded([keyOf(scx, scz)]);
    const target = this.cell(x, z);
    if (target === v) return { keys: new Set(), undo: new Map() };

    const undo = new Map();
    const keys = new Set();
    // seeds: 0..CS*CS-1 = セル番号、-1..-4 = 辺全体 (上,右,下,左)
    const seeds = new Map();
    const queue = [];
    const push = (k, s) => {
      let a = seeds.get(k);
      if (!a) { seeds.set(k, (a = [])); queue.push(k); }
      a.push(s);
    };
    push(keyOf(scx, scz), (z - scz * CS) * CS + (x - scx * CS));

    const waiting = [];  // 本データ待ちのチャンク
    let processed = 0;
    let qi = 0;
    while (true) {
      if (qi >= queue.length) {
        if (!waiting.length) break;
        // まとめて読み込んでから再投入
        const ks = waiting.splice(0);
        await this.ensureLoaded(ks);
        for (const k of ks) queue.push(k);
        continue;
      }
      const k = queue[qi++];
      const list = seeds.get(k);
      if (!list) continue;
      const c = this.chunks.get(k);
      const cx = cxOf(k), cz = czOf(k);
      const u = c ? c.u : 0;
      if (u !== null) {
        seeds.delete(k);
        if (u !== target) continue;
        this._snap(undo, k, c);
        const cc = this.getOrCreate(cx, cz);
        cc.u = v; this._finalize(cc); keys.add(k);
        // 4辺すべてへ伝播
        if (this.inBounds(cx, cz - 1)) push(keyOf(cx, cz - 1), -3);
        if (this.inBounds(cx + 1, cz)) push(keyOf(cx + 1, cz), -4);
        if (this.inBounds(cx, cz + 1)) push(keyOf(cx, cz + 1), -1);
        if (this.inBounds(cx - 1, cz)) push(keyOf(cx - 1, cz), -2);
      } else {
        if (!c.data) { if (!waiting.includes(k)) waiting.push(k); continue; }
        seeds.delete(k);
        this._snap(undo, k, c);
        const d = c.data;
        const stack = [];
        for (const s of list) {
          if (s >= 0) stack.push(s);
          else for (let t = 0; t < CS; t++) {
            stack.push(s === -1 ? t : s === -2 ? t * CS + CS - 1 : s === -3 ? (CS - 1) * CS + t : t * CS);
          }
        }
        let changed = false;
        const out = [[], [], [], []]; // 上,右,下,左 の隣チャンクへ渡すセル
        while (stack.length) {
          const i = stack.pop();
          if (d[i] !== target) continue;
          d[i] = v; changed = true;
          const lx = i % CS, lz = (i / CS) | 0;
          if (lx > 0) stack.push(i - 1); else out[3].push(lz);
          if (lx < CS - 1) stack.push(i + 1); else out[1].push(lz);
          if (lz > 0) stack.push(i - CS); else out[0].push(lx);
          if (lz < CS - 1) stack.push(i + CS); else out[2].push(lx);
        }
        if (changed) {
          this._finalize(c); keys.add(k);
          if (out[0].length && this.inBounds(cx, cz - 1)) for (const t of out[0]) push(keyOf(cx, cz - 1), (CS - 1) * CS + t);
          if (out[1].length && this.inBounds(cx + 1, cz)) for (const t of out[1]) push(keyOf(cx + 1, cz), t * CS);
          if (out[2].length && this.inBounds(cx, cz + 1)) for (const t of out[2]) push(keyOf(cx, cz + 1), t);
          if (out[3].length && this.inBounds(cx - 1, cz)) for (const t of out[3]) push(keyOf(cx - 1, cz), t * CS + CS - 1);
        } else undo.delete(k);
      }
      if (++processed % 2000 === 0) { progress(processed); await new Promise((r) => setTimeout(r)); }
    }
    this._touch(keys);
    this.onChange(keys);
    return { keys, undo };
  }

  /** Undo 用：スナップショットへ戻す */
  restore(undo) {
    const keys = new Set();
    for (const [k, s] of undo) {
      const c = this.getOrCreate(cxOf(k), czOf(k));
      c.u = s.u; c.data = s.data ? s.data.slice() : null; c.pv = s.pv ? s.pv.slice() : null;
      if (c.u === null && !c.data) c.data = upscalePv(c.pv);
      c.canvas = null; c.pvCanvas = null;
      keys.add(k);
    }
    this.onChange(keys);
    return keys;
  }
  _touch(keys) { const t = ++this.useTick; for (const k of keys) { const c = this.chunks.get(k); if (c) c.lastUse = t; } }

  // ---- 描画用キャッシュ ----
  chunkCanvas(c) {
    c.lastUse = ++this.useTick;
    if (c.canvas) return c.canvas;
    const cv = makeCanvas(CS, CS);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(CS, CS);
    const u32 = new Uint32Array(img.data.buffer);
    const d = c.data;
    for (let i = 0; i < d.length; i++) u32[i] = PACKED[d[i]];
    ctx.putImageData(img, 0, 0);
    return (c.canvas = cv);
  }
  previewCanvas(c) {
    if (c.pvCanvas) return c.pvCanvas;
    const cv = makeCanvas(PV, PV);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(PV, PV);
    const u32 = new Uint32Array(img.data.buffer);
    for (let i = 0; i < c.pv.length; i++) u32[i] = PACKED[c.pv[i]];
    ctx.putImageData(img, 0, 0);
    return (c.pvCanvas = cv);
  }
  /** 1m解像度キャッシュを持ちすぎない */
  trimCanvases(limit = 400) {
    const arr = [];
    for (const c of this.chunks.values()) if (c.canvas) arr.push(c);
    if (arr.length <= limit) return;
    arr.sort((a, b) => a.lastUse - b.lastUse);
    for (let i = 0; i < arr.length - limit; i++) arr[i].canvas = null;
  }

  /** LODタイル (N×N チャンクを 256px に縮小) を作る */
  buildLodTile(N, tx, tz) {
    const P = 256;
    const cv = makeCanvas(P, P);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(P, P);
    const u32 = new Uint32Array(img.data.buffer);
    const m = (N * CS) / P;             // 1px あたりのメートル
    const ox = tx * N * CS, oz = tz * N * CS;
    const ppc = P / N;                  // 1チャンクあたりのpx
    if (ppc >= 1) {
      // チャンク単位でループ（一様チャンクはまとめて塗る）
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const c = this.chunks.get(keyOf(tx * N + i, tz * N + j));
        const px0 = Math.round(i * ppc), px1 = Math.round((i + 1) * ppc);
        const py0 = Math.round(j * ppc), py1 = Math.round((j + 1) * ppc);
        if (!c || c.u !== null) {
          const col = PACKED[c ? c.u : 0];
          for (let y = py0; y < py1; y++) u32.fill(col, y * P + px0, y * P + px1);
        } else {
          for (let y = py0; y < py1; y++) {
            const pvz = (((y - py0 + 0.5) / (py1 - py0)) * PV) | 0;
            for (let x = px0; x < px1; x++) {
              const pvx = (((x - px0 + 0.5) / (px1 - px0)) * PV) | 0;
              u32[y * P + x] = PACKED[c.pv[pvz * PV + pvx]];
            }
          }
        }
      }
    } else {
      for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
        u32[y * P + x] = PACKED[this.sampleCoarse(ox + x * m + m / 2, oz + y * m + m / 2)];
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }
}

// ---------- 幾何ヘルパー ----------
function majority(d, x0, z0) {
  const cnt = [0, 0, 0, 0];
  for (let z = 0; z < PVS; z += 2) for (let x = 0; x < PVS; x += 2) cnt[d[(z0 + z) * CS + x0 + x]]++;
  let best = 0;
  for (let i = 1; i < 4; i++) if (cnt[i] > cnt[best]) best = i;
  return best;
}
function upscalePv(pv) {
  const d = new Uint8Array(CS * CS);
  for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++) d[z * CS + x] = pv[((z / PVS) | 0) * PV + ((x / PVS) | 0)];
  return d;
}
function segPointDist2(ax, az, bx, bz, px, pz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  let t = L2 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px, ez = az + t * dz - pz;
  return ex * ex + ez * ez;
}
function rectInsideCapsule(x, z, s, seg, r) {
  const [ax, az, bx, bz] = seg;
  const r2 = r * r;
  return segPointDist2(ax, az, bx, bz, x, z) <= r2 && segPointDist2(ax, az, bx, bz, x + s, z) <= r2 &&
    segPointDist2(ax, az, bx, bz, x, z + s) <= r2 && segPointDist2(ax, az, bx, bz, x + s, z + s) <= r2;
}
function rectSegDist(x, z, s, ax, az, bx, bz) {
  // 矩形と線分の最短距離（近似：端点と矩形の距離・矩形角と線分の距離の最小）
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  if (segIntersectsRect(ax, az, bx, bz, x, z, s)) return 0;
  const d1 = Math.hypot(ax - cl(ax, x, x + s), az - cl(az, z, z + s));
  const d2 = Math.hypot(bx - cl(bx, x, x + s), bz - cl(bz, z, z + s));
  const d3 = Math.sqrt(Math.min(segPointDist2(ax, az, bx, bz, x, z), segPointDist2(ax, az, bx, bz, x + s, z),
    segPointDist2(ax, az, bx, bz, x, z + s), segPointDist2(ax, az, bx, bz, x + s, z + s)));
  return Math.min(d1, d2, d3);
}
function segIntersectsRect(ax, az, bx, bz, x, z, s) {
  // Liang–Barsky
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const p = [-dx, dx, -dz, dz], q = [ax - x, x + s - ax, az - z, z + s - az];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; }
    else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return true;
}
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
