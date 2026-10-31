// =============================================================
// MapView : カメラ・描画ループ・入力 (パン/ズーム/ピンチ)
// =============================================================
import { CS, T_COLORS, keyOf, cxOf, czOf } from './terrain.js';

export const MIN_SCALE = 1 / 400;   // 1px = 400m （100km が 250px）
export const MAX_SCALE = 16;        // 1px = 1/16m
const LOD_NS = [8, 16, 32, 64, 128, 256, 512, 1024];

export class MapView {
  constructor(canvas, terrain, { bounds } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.terrain = terrain;
    this.mb = bounds || terrain.bounds;   // マップの範囲
    this.x = 0; this.z = 0;      // 画面中心のワールド座標
    this.scale = 0.05;           // px / m
    this.w = 0; this.h = 0; this.dpr = 1;
    this.layers = [];            // {draw(ctx, view)} 地形の上に描くもの
    this.tool = null;            // {down,move,up,cursor}
    this.lod = new Map();        // "N:tx:tz" -> {cv, stale}
    this.showGrid = true;
    this.onViewChange = () => {};
    this.onPointerWorld = () => {};
    this._dirty = true;
    this._loadQueued = new Set();
    terrain.onChange = (keys) => { this.invalidate(keys); this.requestDraw(); };
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement || canvas);
    this._bindInput();
    const loop = () => { if (this._dirty) { this._dirty = false; this.draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ---------- 座標変換 ----------
  get mpp() { return 1 / this.scale; }
  toScreen(wx, wz) { return [(wx - this.x) * this.scale + this.w / 2, (wz - this.z) * this.scale + this.h / 2]; }
  toWorld(sx, sz) { return [(sx - this.w / 2) / this.scale + this.x, (sz - this.h / 2) / this.scale + this.z]; }
  /** 画面に見えている範囲（ワールド座標） */
  bounds() {
    const [x0, z0] = this.toWorld(0, 0), [x1, z1] = this.toWorld(this.w, this.h);
    return { x0, z0, x1, z1 };
  }
  setView(x, z, scale) {
    if (scale !== undefined) this.scale = clamp(scale, this.minScale, MAX_SCALE);
    const b = this.mb, mx = (b.x1 - b.x0) * 0.2, mz = (b.z1 - b.z0) * 0.2;
    this.x = clamp(x, b.x0 - mx, b.x1 + mx); this.z = clamp(z, b.z0 - mz, b.z1 + mz);
    this.requestDraw(); this.onViewChange();
  }
  zoomAt(sx, sz, factor) {
    const [wx, wz] = this.toWorld(sx, sz);
    const ns = clamp(this.scale * factor, this.minScale, MAX_SCALE);
    this.scale = ns;
    // カーソル位置を固定
    this.setView(wx - (sx - this.w / 2) / ns, wz - (sz - this.h / 2) / ns);
  }
  get minScale() {
    const b = this.mb;
    return Math.min(MIN_SCALE, (Math.min(this.w || 800, this.h || 600) / Math.max(b.x1 - b.x0, b.z1 - b.z0)) * 0.5);
  }
  fitAll() {
    const b = this.mb;
    const s = Math.min(this.w / (b.x1 - b.x0), this.h / (b.z1 - b.z0)) * 0.94;
    this.setView((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, s);
  }
  /** マップの範囲を変える */
  setBounds(b) { this.mb = b; this.terrain.bounds = b; this.resetCache(); }

  requestDraw() { this._dirty = true; }
  /** 地形を丸ごと読み込み直したとき */
  resetCache() { this.lod.clear(); this.requestDraw(); }
  invalidate(keys) {
    for (const k of keys) {
      const cx = cxOf(k), cz = czOf(k);
      for (const N of LOD_NS) {
        const t = this.lod.get(`${N}:${Math.floor(cx / N)}:${Math.floor(cz / N)}`);
        if (t) t.stale = true;
      }
    }
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.requestDraw();
  }

  // ---------- 描画 ----------
  draw() {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#d5d8dc';
    ctx.fillRect(0, 0, this.w, this.h);
    const t0 = performance.now();
    const mpp = this.mpp;
    // マップ範囲の外には地形を描かない
    const [bx0, bz0] = this.toScreen(this.mb.x0, this.mb.z0), [bx1, bz1] = this.toScreen(this.mb.x1, this.mb.z1);
    ctx.save(); ctx.beginPath(); ctx.rect(bx0, bz0, bx1 - bx0, bz1 - bz0); ctx.clip();
    if (mpp < 1.5) this._drawChunks(true);
    else if (mpp < 6) this._drawChunks(false);
    else this._drawLod(t0);
    ctx.restore();
    this._drawBorder();
    if (this.showGrid) this._drawGrid();
    for (const l of this.layers) l.draw(ctx, this);
    this.terrain.trimCanvases();
  }

  _visibleChunkRange(pad = 0) {
    const b = this.bounds(), m = this.mb;
    return {
      cx0: Math.floor(Math.max(b.x0, m.x0) / CS) - pad, cx1: Math.floor(Math.min(b.x1, m.x1 - 0.001) / CS) + pad,
      cz0: Math.floor(Math.max(b.z0, m.z0) / CS) - pad, cz1: Math.floor(Math.min(b.z1, m.z1 - 0.001) / CS) + pad,
    };
  }

  _drawChunks(full) {
    const { ctx, terrain } = this;
    const { cx0, cx1, cz0, cz1 } = this._visibleChunkRange();
    ctx.imageSmoothingEnabled = false;
    const need = [];
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const [sx0, sz0] = this.toScreen(cx * CS, cz * CS);
        const [sx1, sz1] = this.toScreen(cx * CS + CS, cz * CS + CS);
        const x = Math.floor(sx0), y = Math.floor(sz0), w = Math.ceil(sx1) - x, h = Math.ceil(sz1) - y;
        const c = terrain.chunks.get(keyOf(cx, cz));
        if (!c || c.u !== null) {
          ctx.fillStyle = T_COLORS[c ? c.u : 0];
          ctx.fillRect(x, y, w, h);
        } else if (full && c.data) {
          ctx.drawImage(terrain.chunkCanvas(c), x, y, w, h);
        } else {
          ctx.drawImage(terrain.previewCanvas(c), x, y, w, h);
          if (full) need.push(keyOf(cx, cz));
        }
      }
    }
    if (need.length) {
      const fresh = need.filter((k) => !this._loadQueued.has(k));
      if (fresh.length) {
        fresh.forEach((k) => this._loadQueued.add(k));
        terrain.ensureLoaded(fresh).then(() => {
          fresh.forEach((k) => this._loadQueued.delete(k));
          const vis = new Set();
          const r = this._visibleChunkRange(2);
          for (let cz = r.cz0; cz <= r.cz1; cz++) for (let cx = r.cx0; cx <= r.cx1; cx++) vis.add(keyOf(cx, cz));
          terrain.evict(vis);
          this.requestDraw();
        });
      }
    }
  }

  _drawLod(t0) {
    const { ctx, terrain } = this;
    const mpp = this.mpp;
    let N = 8;
    for (const n of LOD_NS) if (n <= mpp * 1.4) N = n;
    const span = N * CS;
    const b = this.bounds(), m = this.mb;
    const tx0 = Math.floor(Math.max(b.x0, m.x0) / span), tx1 = Math.floor(Math.min(b.x1, m.x1 - 0.001) / span);
    const tz0 = Math.floor(Math.max(b.z0, m.z0) / span), tz1 = Math.floor(Math.min(b.z1, m.z1 - 0.001) / span);
    ctx.imageSmoothingEnabled = true;
    let budgetHit = false;
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
      const key = `${N}:${tx}:${tz}`;
      let t = this.lod.get(key);
      if (!t || t.stale) {
        if (performance.now() - t0 < 14) {
          t = { cv: terrain.buildLodTile(N, tx, tz), stale: false, used: 0 };
          this.lod.set(key, t);
        } else budgetHit = true;
      }
      const [sx0, sz0] = this.toScreen(tx * span, tz * span);
      const [sx1, sz1] = this.toScreen(tx * span + span, tz * span + span);
      const x = Math.floor(sx0), y = Math.floor(sz0);
      if (t) { t.used = performance.now(); ctx.drawImage(t.cv, x, y, Math.ceil(sx1) - x, Math.ceil(sz1) - y); }
      else { ctx.fillStyle = T_COLORS[0]; ctx.fillRect(x, y, Math.ceil(sx1) - x, Math.ceil(sz1) - y); }
    }
    if (budgetHit) this.requestDraw();
    // キャッシュ上限
    if (this.lod.size > 600) {
      const arr = [...this.lod.entries()].sort((a, b) => a[1].used - b[1].used);
      for (let i = 0; i < arr.length - 400; i++) this.lod.delete(arr[i][0]);
    }
  }

  _drawBorder() {
    const { ctx } = this;
    const [x0, z0] = this.toScreen(this.mb.x0, this.mb.z0), [x1, z1] = this.toScreen(this.mb.x1, this.mb.z1);
    ctx.fillStyle = 'rgba(150,155,162,0.55)';
    ctx.fillRect(0, 0, this.w, Math.max(0, z0));
    ctx.fillRect(0, z1, this.w, this.h - z1);
    ctx.fillRect(0, Math.max(0, z0), Math.max(0, x0), Math.min(z1, this.h) - Math.max(0, z0));
    ctx.fillRect(x1, Math.max(0, z0), this.w - x1, Math.min(z1, this.h) - Math.max(0, z0));
    ctx.strokeStyle = 'rgba(80,85,95,.6)'; ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, z0 + 0.5, x1 - x0, z1 - z0);
  }

  _drawGrid() {
    const { ctx } = this;
    const steps = [10, 50, 100, 500, 1000, 5000, 10000, 50000];
    let step = steps[steps.length - 1];
    for (const s of steps) if (s * this.scale >= 90) { step = s; break; }
    const b = this.bounds();
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(60,70,85,.55)';
    for (let x = Math.ceil(b.x0 / step) * step; x <= b.x1; x += step) {
      const [sx] = this.toScreen(x, 0);
      ctx.strokeStyle = x === 0 ? 'rgba(220,60,60,.45)' : 'rgba(40,60,90,.08)';
      ctx.beginPath(); ctx.moveTo(Math.round(sx) + 0.5, 0); ctx.lineTo(Math.round(sx) + 0.5, this.h); ctx.stroke();
      ctx.fillText(`X ${fmt(x)}`, sx + 3, this.h - 6);
    }
    for (let z = Math.ceil(b.z0 / step) * step; z <= b.z1; z += step) {
      const [, sz] = this.toScreen(0, z);
      ctx.strokeStyle = z === 0 ? 'rgba(60,90,220,.45)' : 'rgba(40,60,90,.08)';
      ctx.beginPath(); ctx.moveTo(0, Math.round(sz) + 0.5); ctx.lineTo(this.w, Math.round(sz) + 0.5); ctx.stroke();
      ctx.fillText(`Z ${fmt(z)}`, this.w - 70, sz - 3);
    }
    ctx.restore();
  }

  // ---------- 入力 ----------
  _bindInput() {
    const cv = this.canvas;
    const pointers = new Map();
    let pan = null, pinch = null, toolActive = false;
    let space = false;
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !isTyping(e)) { space = true; cv.style.cursor = 'grab'; e.preventDefault(); } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') { space = false; cv.style.cursor = this.tool?.cursor || 'default'; } });

    const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        // ピンチ開始 → ツール操作は取り消し
        if (toolActive && this.tool?.cancel) this.tool.cancel();
        toolActive = false; pan = null;
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
        return;
      }
      const wantPan = space || e.button === 1 || e.button === 2 || !this.tool || this.tool.pan;
      if (wantPan) { pan = { sx: p[0], sz: p[1], x: this.x, z: this.z }; cv.style.cursor = 'grabbing'; }
      else if (e.button === 0) { toolActive = true; this.tool.down?.(this.toWorld(...p), e, p); }
    });
    cv.addEventListener('pointermove', (e) => {
      const p = local(e);
      this.onPointerWorld(this.toWorld(...p));
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        this.setView(this.x - (mid[0] - pinch.mid[0]) / this.scale, this.z - (mid[1] - pinch.mid[1]) / this.scale);
        this.zoomAt(mid[0], mid[1], d / pinch.d);
        pinch = { d, mid };
        return;
      }
      if (pan) { this.setView(pan.x - (p[0] - pan.sx) / this.scale, pan.z - (p[1] - pan.sz) / this.scale); return; }
      if (toolActive) this.tool?.move?.(this.toWorld(...p), e, p);
      else this.tool?.hover?.(this.toWorld(...p), e, p);
    });
    const end = (e) => {
      const p = local(e);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pan) { pan = null; cv.style.cursor = space ? 'grab' : this.tool?.cursor || 'default'; }
      if (toolActive) { toolActive = false; this.tool?.up?.(this.toWorld(...p), e, p); }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomAt(p[0], p[1], Math.exp(-dy * 0.0015));
    }, { passive: false });
  }
  setTool(tool) {
    this.tool?.deactivate?.();
    this.tool = tool;
    this.canvas.style.cursor = tool?.cursor || 'default';
    tool?.activate?.();
    this.requestDraw();
  }
}

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
export function fmt(n) { return Math.round(n).toLocaleString('ja-JP'); }
export function fmtDist(m) { return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`; }
function isTyping(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); }
