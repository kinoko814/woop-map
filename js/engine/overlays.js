// =============================================================
// 画像レイヤー (Minecraft のマップ画像を下敷きにする)
//   位置 (x,z) は画像の左上のワールド座標、w は幅(m)。
//   縦横比 ar は固定。
// =============================================================
const MAX_ON_SCREEN = 20;   // 画面に画像がこの枚数くらい入る縮尺から表示
const MAX_LOADED = 160;     // 同時に読み込んでおく画像の上限（超えたら古いものから手放す）

export class OverlayLayer {
  constructor(view) {
    this.view = view;
    this.frame = 0;
    this.zoomHidden = 0;
    this.items = [];          // {id,name,x,z,w,ar,opacity,visible,ord,url,img}
    this.selectedId = null;
    this.enabled = true;      // 編集モードのみ表示
    this.onChange = () => {};
  }
  set(items) {
    const old = new Map(this.items.map((i) => [i.id, i]));
    // 画像は必要になったとき（画面に入って十分に拡大したとき）に読み込む → 何千枚あっても軽い
    this.items = items.map((it) => {
      const o = old.get(it.id);
      return { ...it, img: o && o.url === it.url ? o.img : null, used: o?.used || 0 };
    }).sort((a, b) => a.ord - b.ord);
    this.view.requestDraw();
    this.onChange();
  }
  /**
   * 拡大して見ているときだけ表示する。画面に見えている広さが、その画像およそ 20 枚分以下になったら出す
   * （JourneyMap の 512m タイルなら、画面にタイルが 20 枚くらい入る縮尺から）
   */
  showable(it, view = this.view) {
    if (it.id === this.selectedId) return true;
    const viewArea = (view.w * view.h) / (view.scale * view.scale);
    return viewArea <= MAX_ON_SCREEN * it.w * it.w * it.ar;
  }
  get selected() { return this.items.find((i) => i.id === this.selectedId) || null; }
  hit(wx, wz) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (!it.visible || !this.showable(it)) continue;
      if (wx >= it.x && wx <= it.x + it.w && wz >= it.z && wz <= it.z + it.w * it.ar) return it;
    }
    return null;
  }
  /** 選択中画像の角ハンドル（スクリーン座標） */
  handles(it) {
    const v = this.view;
    const pts = [[it.x, it.z], [it.x + it.w, it.z], [it.x + it.w, it.z + it.w * it.ar], [it.x, it.z + it.w * it.ar]];
    return pts.map(([x, z]) => v.toScreen(x, z));
  }
  draw(ctx, view) {
    if (!this.enabled) return;
    ctx.save();
    ctx.imageSmoothingEnabled = view.scale < 1;
    const frame = ++this.frame;
    let hidden = 0;
    for (const it of this.items) {
      if (!it.visible) continue;
      const [sx, sz] = view.toScreen(it.x, it.z);
      const w = it.w * view.scale, h = it.w * it.ar * view.scale;
      if (sx > view.w || sz > view.h || sx + w < 0 || sz + h < 0) continue;
      if (!this.showable(it, view)) { hidden++; continue; }
      it.used = frame;
      if (!it.img) it.img = loadImg(it.url, () => this.view.requestDraw());
      if (!it.img.complete || !it.img.naturalWidth) continue;
      ctx.globalAlpha = it.opacity;
      ctx.drawImage(it.img, sx, sz, w, h);
    }
    ctx.globalAlpha = 1;
    this.zoomHidden = hidden;   // 縮小しているので隠している枚数（パネルの案内用）
    // 読み込んだ画像が多くなったら、しばらく見ていないものから手放してメモリを節約
    const loaded = this.items.filter((i) => i.img);
    if (loaded.length > MAX_LOADED) {
      loaded.sort((a, b) => a.used - b.used);
      for (const it of loaded.slice(0, loaded.length - MAX_LOADED)) { if (it.used === frame) break; it.img.src = ''; it.img = null; }
    }
    const s = this.selected;
    if (s) {
      const hs = this.handles(s);
      ctx.strokeStyle = '#2fa392'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); hs.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
      for (const [x, y] of hs) { ctx.fillStyle = '#fff'; ctx.fillRect(x - 6, y - 6, 12, 12); ctx.strokeRect(x - 6, y - 6, 12, 12); }
    }
    ctx.restore();
  }
}
function loadImg(url, onload) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = onload;
  img.src = url;
  return img;
}
