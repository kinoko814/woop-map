// =============================================================
// 表示モードの情報パネルに出す内容を、図形ごとに組み立てる
// =============================================================
import { h } from './dom.js';
import { ROAD_TYPES, ROAD_COLORS, inPoly, centroid, tessellate } from '../engine/roads.js';
import { RAIL_TYPES, railColor } from '../engine/rails.js';
import { AREA_TYPES } from '../engine/shapes.js';
import { ICONS, iconSvg } from '../engine/icons.js';
import { DAY_NAMES, isOpenNow } from '../hours.js';
import { ADDR_LEVELS, levelIndex } from '../engine/address.js';

let ADDR = null;
const autoAddr = (f, x, z) => f.address || (ADDR ? ADDR.addressText(x, z) : '');
const fmtXZ = (x, z) => `X ${Math.round(x).toLocaleString('ja-JP')}　Z ${Math.round(z).toLocaleString('ja-JP')}`;

/** opts.addr: AddressIndex（住所を自動で出すため） */
export function describe(F, f, opts = {}) {
  ADDR = opts.addr || null;
  if (f.kind === 'addr') return describeAddr(F, f);
  if (f.kind === 'area' && AREA_TYPES[f.type]?.outlineOnly) return describeArea(F, f);
  if (f.kind === 'area') return describeZone(F, f);
  if (f.kind === 'station') return describeStation(F, f);
  if (f.kind === 'poi') return describePoi(F, f);
  return { title: f.name || '名前なし', kind: '', rows: [] };
}

function describeArea(F, a) {
  const isJct = a.type === 'jct';
  const tag = isJct ? 'JCT' : 'IC';
  const title = !a.name ? `名前なしの${tag}` : a.name.endsWith(tag) ? a.name : `${a.name} ${tag}`;
  // 範囲の中を通っている道路
  const inside = new Map();
  const xs = a.poly.map((p) => p[0]), zs = a.poly.map((p) => p[1]);
  const box = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
  for (const r of F.ofKind('road')) {
    const g = tessellate(r, (id) => F.get(id));
    if (g.bbox[0] > box[2] || g.bbox[2] < box[0] || g.bbox[1] > box[3] || g.bbox[3] < box[1]) continue;
    // 道路に沿って10mおきに調べ、範囲の中を通っていれば接続とみなす
    const through = g.segs.some((pts) => pts.some((p, k) => {
      if (inPoly(a.poly, p[0], p[1])) return true;
      const q = pts[k + 1]; if (!q) return false;
      const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 10);
      for (let i = 1; i < n; i++) if (inPoly(a.poly, p[0] + ((q[0] - p[0]) * i) / n, p[1] + ((q[1] - p[1]) * i) / n)) return true;
      return false;
    }));
    if (through) inside.set(r.id, r);
  }
  const roads = [...inside.values()].sort((p, q) => (ROAD_TYPES[q.type]?.highway ? 1 : 0) - (ROAD_TYPES[p.type]?.highway ? 1 : 0));
  const named = new Map();
  for (const r of roads) {
    const label = r.name || ROAD_TYPES[r.type]?.label || '道路';
    if (!named.has(label)) named.set(label, r);
  }
  const chips = [...named].map(([label, r]) => h('span', { class: 'chipline' },
    h('i', { style: { background: r.color === 'white' ? '#9aa3ad' : darkerOf(ROAD_COLORS[r.color]?.fill) } }, ROAD_TYPES[r.type]?.highway ? '高' : '道'), label));
  const [cx, cz] = centroid(a.poly);
  return {
    title,
    kind: isJct ? 'ジャンクション' : 'インターチェンジ',
    kindColor: isJct ? '#c86a1e' : '#1f7c6f',
    desc: a.desc || '',
    rows: [
      ['接続する道路', chips.length ? chips : null],
      ['座標', fmtXZ(cx, cz)],
    ],
  };
}
function darkerOf(hex = '#cccccc') {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.round(c * 0.72);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

const railChip = (r) => h('span', { class: 'chipline' },
  h('i', { style: { background: railColor(r) } }, r.type === 'metro' ? (r.symbol || r.name || 'M').slice(0, 2) : r.type === 'jr' ? '国' : '私'),
  r.name || RAIL_TYPES[r.type].label);
export const stationTitle = (st) => (!st.name ? '名前なしの駅' : st.name.endsWith('駅') ? st.name : `${st.name}駅`);

function describeStation(F, st) {
  const rails = (st.rails || []).map((id) => F.get(id)).filter(Boolean);
  const transfers = (st.transfers || []).map((id) => F.get(id)).filter(Boolean);
  const tChips = transfers.map((o) => h('span', { class: 'chipline' },
    ...((o.rails || []).map((id) => F.get(id)).filter(Boolean).slice(0, 3).map((r) => h('i', { style: { background: railColor(r) } }, r.type === 'metro' ? (r.symbol || r.name || 'M').slice(0, 2) : '駅'))),
    stationTitle(o)));
  const exits = (st.exits || []).map((e) => h('span', { class: 'exit-badge' }, e.label));
  const [cx, cz] = centroid(st.poly);
  return {
    title: stationTitle(st), kind: '駅', kindColor: '#2f6fcf', photo: st.photo,
    badges: rails.map(railChip),
    desc: st.desc,
    rows: [
      ['路線', rails.length ? rails.map((r) => `${r.name || RAIL_TYPES[r.type].label}（${RAIL_TYPES[r.type].label}）`).join('、') : null],
      ['乗換', tChips.length ? tChips : null],
      ['出口', exits.length ? exits : null],
      ['住所', autoAddr(st, cx, cz)],
      ['電話番号', st.phone],
      ['リンク', linksView(st.links)],
      ['座標', fmtXZ(cx, cz)],
    ],
  };
}
function describePoi(F, p) {
  const ic = ICONS[p.icon] || ICONS.landmark;
  return {
    title: p.name || '名前なし', kind: ic.label, kindColor: ic.color, photo: p.photo,
    badges: [h('span', { class: 'chipline' }, iconSvg(p.icon, 18), ic.label)],
    desc: p.desc,
    rows: [['営業時間', hoursView(p.hours)], ['情報', p.info], ['住所', autoAddr(p, p.x, p.z)], ['電話番号', p.phone], ['リンク', linksView(p.links)], ['座標', fmtXZ(p.x, p.z)]],
  };
}
function describeZone(F, a) {
  const t = AREA_TYPES[a.type];
  const [cx, cz] = centroid(a.poly);
  let ar = 0; for (let i = 0, j = a.poly.length - 1; i < a.poly.length; j = i++) ar += (a.poly[j][0] + a.poly[i][0]) * (a.poly[j][1] - a.poly[i][1]);
  ar = Math.abs(ar / 2);
  return {
    title: a.name || `名前なしの${t.label}`, kind: t.label, kindColor: t.text,
    desc: a.desc,
    rows: [['広さ', ar >= 1e6 ? `約 ${(ar / 1e6).toFixed(2)} km²` : `約 ${(ar / 1e4).toFixed(1)} ha`], ['座標', fmtXZ(cx, cz)]],
  };
}

/** 営業時間（いま営業中か＋曜日ごと。今日を太字） */
function hoursView(hours) {
  if (!hours || !hours.mode || hours.mode === 'none') return null;
  const open = isOpenNow(hours);
  const status = h('span', { class: `open-chip ${open ? 'on' : 'off'}` }, open ? '営業中' : '営業時間外');
  if (hours.mode === '24h') return [h('div', { class: 'hours-view' }, h('div', {}, status, ' 24時間営業'), hours.note ? h('div', { class: 'muted' }, hours.note) : null)];
  const today = (new Date().getDay() + 6) % 7;
  return [h('div', { class: 'hours-view' }, h('div', {}, status),
    h('table', { class: 'hours-table' }, ...DAY_NAMES.map((n, i) => h('tr', { class: i === today ? 'today' : '' },
      h('th', {}, n), h('td', {}, hours.days?.[i] ? `${hours.days[i][0]}〜${hours.days[i][1]}` : '定休日')))),
    hours.note ? h('div', { class: 'muted' }, hours.note) : null)];
}
function linksView(links) {
  const ok = (links || []).filter((l) => /^https?:\/\//i.test(l.url || ''));
  if (!ok.length) return null;
  return [h('div', { class: 'links-view' }, ...ok.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label || l.url.replace(/^https?:\/\//, ''))))];
}

/** 地名（県・市町村など）をクリックしたとき */
function describeAddr(F, r) {
  const li = levelIndex(r.level), L = ADDR_LEVELS[li];
  const faces = ADDR ? ADDR.namedFaces(li).filter((e) => e.region.id === r.id) : [];
  const area = faces.reduce((a, e) => a + e.face.area, 0);
  const seed = faces[0]?.labelAt || r.seeds?.[0];
  const parents = seed && ADDR ? ADDR.addressAt(seed[0], seed[1]).filter((a) => levelIndex(a.level) < li).map((a) => a.name).join(' ') : '';
  // ひとつ下の階層の地名
  const children = [];
  if (ADDR && li < ADDR_LEVELS.length - 1) {
    const seen = new Set();
    for (const e of ADDR.namedFaces(li + 1)) {
      const [x, z] = e.labelAt;
      const up = ADDR.nameAt(li, x, z);
      if (up?.region.id === r.id && !seen.has(e.region.id)) { seen.add(e.region.id); children.push(e.region.name); }
    }
  }
  return {
    title: r.name, kind: L.label, kindColor: '#6f569a',
    rows: [
      ['所在', parents || null],
      ['広さ', area ? (area >= 1e6 ? `約 ${(area / 1e6).toFixed(2)} km²` : `約 ${(area / 1e4).toFixed(1)} ha`) : null],
      ['飛び地', faces.length > 1 ? `${faces.length}か所に分かれています` : null],
      [`${ADDR_LEVELS[li + 1]?.label || ''}`, children.length ? children.slice(0, 40).join('、') + (children.length > 40 ? ' ほか' : '') : null],
      ['座標', seed ? fmtXZ(seed[0], seed[1]) : null],
    ],
  };
}
