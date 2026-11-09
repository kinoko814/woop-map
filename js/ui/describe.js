// =============================================================
// 表示モードの情報パネルに出す内容を、図形ごとに組み立てる
// =============================================================
import { h } from './dom.js';
import { ROAD_TYPES, ROAD_COLORS, inPoly, centroid, tessellate } from '../engine/roads.js';
import { RAIL_TYPES, railColor, TRAIN_ICON_URL, resolveStationCompany, sortRailsForDisplay } from '../engine/rails.js';
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
  if (f.kind === 'station') return describeStation(F, f, opts);
  if (f.kind === 'poi') return describePoi(F, f);
  if (f.kind === 'busstop') return describeBusStop(F, f);
  return { title: f.name || '名前なし', kind: '', rows: [] };
}

function describeBusStop(F, s) {
  const routes = [...F.ofKind('busroute')].filter((r) => (r.stops || []).includes(s.id));
  const list = routes.length ? h('div', { class: 'bus-routes' }, ...routes.map((r) => {
    const names = (r.stops || []).map((id) => F.get(id)?.name || '').filter(Boolean);
    const ends = names.length ? `${names[0]} ⇄ ${names[names.length - 1]}` : '';
    return h('div', { class: 'bus-route' },
      h('span', { class: 'bus-route-sw', style: { background: r.color } }),
      h('div', {}, h('b', {}, r.name || '名前なし'), h('div', { class: 'muted' }, [r.oneway ? ends.replace('⇄', '→') : ends, `${names.length}停留所`].filter(Boolean).join('・')),
        r.desc ? h('div', { class: 'muted' }, r.desc) : null));
  })) : h('span', { class: 'muted' }, 'このバス停を通る路線はまだありません');
  return {
    title: s.name || 'バス停',
    kind: 'バス停', kindColor: '#1d6fd6',
    desc: s.desc || '',
    rows: [['住所', autoAddr(s, s.x, s.z)], ['座標', fmtXZ(s.x, s.z)], ['路線', list]],
  };
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

function railChipIcon(r) {
  if (r.logo) return h('img', { class: 'chip-logo', src: r.logo, alt: '' });
  if (r.type !== 'metro') return h('img', { class: 'chip-train-icon', src: TRAIN_ICON_URL, alt: '' });
  const sym = String(r.symbol || r.name || 'M').trim().slice(0, 2);
  return h('i', { style: { background: railColor(r) } }, sym);
}

const railChip = (r) => h('span', { class: 'chipline' },
  railChipIcon(r),
  r.name || RAIL_TYPES[r.type].label);
export const stationTitle = (st) => {
  const n = (st.name || '').trim();
  if (!n) return '名前なしの駅';
  return n.endsWith('駅') ? n : `${n}駅`;
};

/** 乗換駅リストを会社名×駅名ごとにまとめ、クリック可能にする */
function renderTransferChips(F, transferStationList, onOpenStation) {
  const groups = new Map();
  for (const o of transferStationList) {
    if (!o) continue;
    const comp = resolveStationCompany(o, F);
    const title = stationTitle(o);
    const key = `${title}\0${comp}`;
    if (!groups.has(key)) {
      groups.set(key, { title, company: comp, stations: [], railIds: new Set() });
    }
    const g = groups.get(key);
    g.stations.push(o);
    for (const rid of o.rails || []) {
      g.railIds.add(rid);
    }
  }

  const chips = [];
  for (const g of groups.values()) {
    const rails = [...g.railIds].map((id) => F.get(id)).filter(Boolean);
    const sortedRails = sortRailsForDisplay(rails);
    const seenImgs = new Set();
    const dedupedRails = [];
    for (const r of sortedRails) {
      if (r.logo) {
        if (seenImgs.has(r.logo)) continue;
        seenImgs.add(r.logo);
        dedupedRails.push(r);
      } else if (r.type !== 'metro') {
        if (seenImgs.has('__train__')) continue;
        seenImgs.add('__train__');
        dedupedRails.push(r);
      } else {
        dedupedRails.push(r);
      }
    }
    const icons = dedupedRails.slice(0, 6).map(railChipIcon);

    const tag = onOpenStation ? 'button' : 'span';
    const props = {
      class: `chipline${onOpenStation ? ' transfer-btn' : ''}`,
      title: g.company ? `${g.company} ${g.title}` : g.title,
    };
    if (onOpenStation) {
      props.type = 'button';
      props.onclick = (e) => {
        e.preventDefault();
        onOpenStation(g.stations, g.company);
      };
    }

    chips.push(h(tag, props, ...icons, g.title));
  }

  return chips;
}

function describeStation(F, st, opts = {}) {
  const rails = (st.rails || []).map((id) => F.get(id)).filter(Boolean);
  // 駅の所属会社は乗り入れる路線から自動取得
  const company = resolveStationCompany(st, F);
  const transfers = (st.transfers || []).map((id) => F.get(id)).filter(Boolean);
  const tChips = renderTransferChips(F, transfers, opts.onOpenStation);
  const exits = (st.exits || []).map((e) => h('span', { class: 'exit-badge' }, e.label));
  const [cx, cz] = centroid(st.poly);
  return {
    title: stationTitle(st), kind: company ? `${company}の駅` : '駅', kindColor: '#2f6fcf', photo: st.photo,
    badges: rails.map(railChip),
    desc: st.desc,
    rows: [
      ['会社名', company || null],
      ['駅ナンバリング', st.numbering],
      ['路線', rails.length ? [...new Set(rails.map((r) => r.name || RAIL_TYPES[r.type]?.label).filter(Boolean))].join('、') : null],
      ['乗換', tChips.length ? tChips : null],
      ['出口', exits.length ? exits : null],
      ['住所', autoAddr(st, cx, cz)],
      ['電話番号', st.phone],
      ['リンク', linksView(st.links)],
      ['座標', fmtXZ(cx, cz)],
    ],
  };
}

/** 同じ会社・同じ駅名の複数駅を統合した情報パネル内容を作る */
export function describeGroupStation(F, stationList, { addr, center, company, onOpenStation } = {}) {
  ADDR = addr || null;
  const rep = stationList[0];
  const [cx, cz] = center || (rep.poly?.length ? centroid(rep.poly) : [rep.x, rep.z]);

  const railMap = new Map();
  for (const st of stationList) {
    for (const rid of st.rails || []) {
      const r = F.get(rid);
      if (r && !railMap.has(r.id)) railMap.set(r.id, r);
    }
  }
  const rails = [...railMap.values()];

  const memberIds = new Set(stationList.map((s) => s.id));
  const transferMap = new Map();
  for (const st of stationList) {
    for (const tid of st.transfers || []) {
      if (memberIds.has(tid)) continue;
      const o = F.get(tid);
      if (o && !transferMap.has(o.id)) transferMap.set(o.id, o);
    }
  }
  const transfers = [...transferMap.values()];
  const tChips = renderTransferChips(F, transfers, onOpenStation);

  const exitMap = new Map();
  for (const st of stationList) {
    for (const ex of st.exits || []) {
      if (ex && !exitMap.has(ex.label)) exitMap.set(ex.label, ex);
    }
  }
  const exits = [...exitMap.values()].map((e) => h('span', { class: 'exit-badge' }, e.label));

  const numList = [...new Set(stationList.map((s) => s.numbering).filter(Boolean))];
  const photo = stationList.map((s) => s.photo).find(Boolean);
  const desc = stationList.map((s) => s.desc).filter(Boolean).join('\n\n');
  const phone = stationList.map((s) => s.phone).find(Boolean);
  const links = stationList.flatMap((s) => s.links || []).filter(Boolean);

  // 駅の所属会社は乗り入れる路線から自動取得
  const comp = company || resolveStationCompany(stationList, F);
  const kind = comp ? `${comp}の駅` : '駅';

  return {
    title: stationTitle(rep),
    kind,
    kindColor: '#2f6fcf',
    photo,
    badges: rails.map(railChip),
    desc,
    rows: [
      ['会社名', comp || null],
      ['駅ナンバリング', numList.length ? numList.join('、') : null],
      ['路線', rails.length ? [...new Set(rails.map((r) => r.name || RAIL_TYPES[r.type]?.label).filter(Boolean))].join('、') : null],
      ['乗換', tChips.length ? tChips : null],
      ['出口', exits.length ? exits : null],
      ['住所', autoAddr(rep, cx, cz)],
      ['電話番号', phone],
      ['リンク', linksView(links)],
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
