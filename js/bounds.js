// マップの範囲 (メートル)。X が東西、Z が南北。
export const MAX_SIDE = 200000;   // 1辺の最大 200km

/** マップ情報から範囲を作る（古い size_km 形式にも対応） */
export function boundsOf(map) {
  if (map.x_min !== undefined && map.x_min !== null) {
    return { x0: +map.x_min, x1: +map.x_max, z0: +map.z_min, z1: +map.z_max };
  }
  const h = ((map.size_km || 100) * 1000) / 2;
  return { x0: -h, x1: h, z0: -h, z1: h };
}
export function validBounds(b) {
  const w = b.x1 - b.x0, d = b.z1 - b.z0;
  if (![b.x0, b.x1, b.z0, b.z1].every(Number.isFinite)) return '数値を入力してください';
  if (w < 256 || d < 256) return '1辺は 256m 以上にしてください';
  if (w > MAX_SIDE || d > MAX_SIDE) return '1辺は 200km までです';
  return null;
}
export function sizeLabel(b) {
  const km = (m) => (m / 1000).toLocaleString('ja-JP', { maximumFractionDigits: 2 });
  return `${km(b.x1 - b.x0)}km × ${km(b.z1 - b.z0)}km`;
}
export const inside = (b, x, z) => x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1;
