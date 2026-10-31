// =============================================================
// 画像レイヤー (Minecraft のマップ画像を下敷きにする)
//   位置 (x,z) は画像の左上のワールド座標、w は幅(m)。
//   縦横比 ar は固定。
// =============================================================
export class OverlayLayer {
  constructor(view) {
    this.view = view;
    this.items = [];          // {id,name,x,z,w,ar,opacity,visible,ord,url,img}
    this.selectedId = null;
    this.enabled = true;      // 編集モードのみ表示
    this.onChange = () => {};
  }
  set(items) {
    const old = new Map(this.items.map((i) => [i.id, i]));
    this.items = items.map((it) => {
      const o = old.get(it.id);
      const img = o && o.url === it.url ? o.img : loadImg(it.url, () => this.view.requestDraw());
      return { ...it, img };
    }).sort((a, b) => a.ord - b.ord);
    this.view.requestDraw();
    this.onChange();
  }
  get selected() { return this.items.find((i) => i.id === this.selectedId) || null; }
  hit(wx, wz) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (!it.visible) continue;
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
    for (const it of this.items) {
      if (!it.visible || !it.img.complete || !it.img.naturalWidth) continue;
      const [sx, sz] = view.toScreen(it.x, it.z);
      const w = it.w * view.scale, h = it.w * it.ar * view.scale;
      if (sx > view.w || sz > view.h || sx + w < 0 || sz + h < 0) continue;
      ctx.globalAlpha = it.opacity;
      ctx.drawImage(it.img, sx, sz, w, h);
    }
    ctx.globalAlpha = 1;
    const s = this.selected;
    if (s) {
      const hs = this.handles(s);
      ctx.strokeStyle = '#03c75a'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
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
