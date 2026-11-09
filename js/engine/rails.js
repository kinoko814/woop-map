// =============================================================
// 鉄道と駅：種類・描画
//   国鉄  : 濃いグレーの線に白い破線（地図でよくある国鉄のデザイン）
//   私鉄  : グレーの線に垂直の短い線（枕木）が生えたデザイン
//   都市鉄道: 好きな色の実線
// =============================================================
import { segLevel, centroid } from './roads.js';

export const RAIL_TYPES = {
  jr:      { label: '国鉄',     show: 160 },
  private: { label: '私鉄',     show: 90 },
  metro:   { label: '都市鉄道', show: 45 },
};
export const METRO_COLORS = ['#e8432f', '#f39a1e', '#f2c81d', '#3aa64a', '#1e9cd8', '#2a5cb8', '#8a4fb0', '#d4508f', '#8b6a4f', '#7a8089'];
export const STATION_FILL = '#bcdcf4';        // 国鉄・私鉄の駅は薄い青
export const STATION_EDGE = '#5b9bd0';
const FONT = '"Noto Sans JP", system-ui, sans-serif';
export const TRAIN_ICON_URL = new URL('../../assets/default-train.png', import.meta.url).href;

export const railVisible = (rail, mpp) => mpp < (RAIL_TYPES[rail.type]?.show ?? 60);
export const railColor = (rail) => (rail.type === 'metro' ? rail.color || METRO_COLORS[5] : rail.type === 'jr' ? '#5c636b' : '#7b828b');

/** 線路の描画用の太さ（px）。拡大するほど少し太く */
function widthPx(mpp) { return mpp > 30 ? 2.2 : mpp > 8 ? 3 : mpp > 2 ? 4.2 : 5.5; }

export function drawRails(ctx, v, items, getNode, opts = {}) {
  const mpp = v.mpp, W = widthPx(mpp);
  ctx.save();
  ctx.lineJoin = 'round';
  for (const lv of [-1, 0, 1]) {
    for (const it of items) {
      const r = it.rail, gn = it.getNode || getNode;
      // 同じ高さの区間をつなげて描く
      const runs = [];
      let cur = null;
      it.g.segs.forEach((pts, i) => {
        const l = segLevel(r, i, gn);
        if (cur && cur.lv === l) { for (let k = 1; k < pts.length; k++) cur.pts.push(pts[k]); }
        else { cur = { lv: l, pts: pts.slice() }; runs.push(cur); }
      });
      for (const run of runs) {
        if (run.lv !== lv) continue;
        // 表示モードでは、地下に入った都市鉄道（地下鉄）も破線にせず、そのままの実線で描く
        const solidMetro = opts.metroSolid && r.type === 'metro';
        ctx.globalAlpha = lv === -1 && !solidMetro ? 0.55 : 1;
        if (lv === 1 && W > 3) { ctx.strokeStyle = 'rgba(25,35,45,.14)'; ctx.lineWidth = W + 5; ctx.lineCap = 'round'; linePath(ctx, v, run.pts); ctx.stroke(); }
        if (r.type === 'jr') {
          ctx.lineCap = 'butt';
          ctx.strokeStyle = '#5c636b'; ctx.lineWidth = W + 1; linePath(ctx, v, run.pts); ctx.stroke();
          if (W >= 3) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = W - 1.6; ctx.setLineDash([W * 2.6, W * 2.6]); linePath(ctx, v, run.pts); ctx.stroke(); ctx.setLineDash([]); }
        } else if (r.type === 'private') {
          ctx.lineCap = 'butt';
          ctx.strokeStyle = '#7b828b'; ctx.lineWidth = Math.max(1.4, W * 0.45); linePath(ctx, v, run.pts); ctx.stroke();
          if (mpp < 12) ties(ctx, v, run.pts, W * 1.1, Math.max(6, W * 2));
        } else {
          ctx.lineCap = 'round';
          if (lv === -1 && !solidMetro) ctx.setLineDash([W * 2, W * 1.2]);
          ctx.strokeStyle = railColor(r); ctx.lineWidth = W; linePath(ctx, v, run.pts); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** 私鉄の枕木（線に垂直な短い線） */
function ties(ctx, v, pts, len, gap) {
  const S = pts.map(([x, z]) => v.toScreen(x, z));
  ctx.lineWidth = 1.2; ctx.beginPath();
  let acc = gap / 2;
  for (let k = 0; k < S.length - 1; k++) {
    const [x0, y0] = S[k], [x1, y1] = S[k + 1];
    const L = Math.hypot(x1 - x0, y1 - y0); if (!L) continue;
    const ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    let d = gap - acc;
    while (d <= L) {
      const px = x0 + ux * d, py = y0 + uy * d;
      if (px > -10 && py > -10 && px < v.w + 10 && py < v.h + 10) {
        ctx.moveTo(px - uy * len / 2, py + ux * len / 2); ctx.lineTo(px + uy * len / 2, py - ux * len / 2);
      }
      d += gap;
    }
    acc = (acc + L) % gap;
  }
  ctx.stroke();
}
export function linePath(ctx, v, pts) {
  ctx.beginPath();
  let lx = 0, ly = 0;
  pts.forEach(([x, z], k) => {
    const [sx, sy] = v.toScreen(x, z);
    if (k === 0) { ctx.moveTo(sx, sy); lx = sx; ly = sy; }
    else if (k === pts.length - 1 || Math.abs(sx - lx) + Math.abs(sy - ly) > 1.2) { ctx.lineTo(sx, sy); lx = sx; ly = sy; }
  });
}

// ---------- 駅 ----------
/** 駅の色（最初の路線で決まる。国鉄・私鉄は薄い青） */
export function stationColors(F, st) {
  const r = st.rails?.map((id) => F.get(id)).find(Boolean);
  if (r?.type === 'metro') return { fill: hexA(railColor(r), 0.45), edge: railColor(r) };
  return { fill: STATION_FILL, edge: STATION_EDGE };
}
export function drawStationShapes(ctx, v, stations, F, selectedId) {
  ctx.save();
  for (const st of stations) {
    if (!st.poly || st.poly.length < 3) continue;
    const c = stationColors(F, st);
    ctx.beginPath();
    st.poly.forEach(([x, z], i) => { const [sx, sy] = v.toScreen(x, z); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
    ctx.fillStyle = c.fill; ctx.fill();
    ctx.strokeStyle = c.edge; ctx.lineWidth = st.id === selectedId ? 2.5 : 1.2; ctx.stroke();
  }
  ctx.restore();
}

/** デフォルト電車グリフをCanvasに直接描画（PNG不要） */
function trainGlyph(ctx, x, y, s) {
  ctx.save(); ctx.translate(x - s / 2, y - s / 2); ctx.scale(s / 24, s / 24);
  ctx.fillStyle = '#fff';
  roundRect(ctx, 5, 2, 14, 16, 4); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(7.5, 5, 9, 5);
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(8.5, 14, 1.4, 0, 7); ctx.arc(15.5, 14, 1.4, 0, 7); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(8, 18); ctx.lineTo(5, 22); ctx.moveTo(16, 18); ctx.lineTo(19, 22); ctx.stroke();
  ctx.restore();
}

const logoCache = new Map();
function logoImg(src, onload) {
  if (!src) return null;
  let im = logoCache.get(src);
  if (!im) { im = new Image(); im.onload = onload; im.src = src; logoCache.set(src, im); }
  return im.complete && im.naturalWidth ? im : null;
}

export function resolveRailCompany(r) {
  if (!r) return '';
  if (r.company && r.company.trim()) return r.company.trim();
  const name = r.name || '';
  const m = name.match(/^(.+?(?:電鉄|鉄道|地下鉄|旅客鉄道|交通|急行|メトロ))/);
  if (m) return m[1].trim();
  if (name.startsWith('KR')) return '京日本旅客鉄道';
  if (name.startsWith('JR')) return 'JR';
  return '';
}

export function resolveStationCompany(st, F) {
  if (!st) return '';
  const list = Array.isArray(st) ? st : [st];
  // 駅に乗り入れる路線から自動取得（所属路線の会社に一本化）
  for (const s of list) {
    const lines = (s?.rails || []).map((id) => (F?.get ? F.get(id) : null)).filter(Boolean);
    for (const l of lines) {
      const comp = resolveRailCompany(l);
      if (comp) return comp;
    }
  }
  return '';
}

function stationHasJR(st, F) {
  if (!st) return false;
  const lines = (st.rails || []).map((id) => (F?.get ? F.get(id) : null)).filter(Boolean);
  for (const l of lines) {
    if (l.type === 'jr') return true;
    const comp = resolveRailCompany(l).toUpperCase();
    if (comp.includes('KR') || comp.includes('JR') || comp.includes('国鉄')) return true;
    const lName = (l.name || '').toUpperCase();
    if (lName.includes('KR') || lName.includes('JR') || lName.includes('国鉄')) return true;
  }
  return false;
}

/** 路線マークの同一画像・同一電車の重複を排除する */
function dedupeRailMarks(sortedRails) {
  const seenImgs = new Set();
  const deduped = [];
  for (const r of sortedRails) {
    if (r.logo) {
      if (seenImgs.has(r.logo)) continue;
      seenImgs.add(r.logo);
      deduped.push(r);
    } else if (r.type !== 'metro') {
      if (seenImgs.has('__default_train__')) continue;
      seenImgs.add('__default_train__');
      deduped.push(r);
    } else {
      deduped.push(r);
    }
  }
  return deduped.length ? deduped : [{ type: 'jr' }];
}

/** 駅のマーク（路線ごとに並べる）と駅名。表示した矩形を返す（クリック判定用） */
export function drawStationMarks(ctx, v, stations, F, { onImage, selectedId, taken = [] } = {}) {
  const mpp = v.mpp;
  const hits = [];
  ctx.save();
  ctx.textBaseline = 'middle';
  let visible = stations.map((st) => {
    const [cx, cz] = st.poly?.length ? centroid(st.poly) : [st.x, st.z];
    const [x, y] = v.toScreen(cx, cz);
    const railIds = new Set((st.rails || []).filter((id) => F.get(id)));
    const hasTransfer = (st.transfers || []).some((id) => F.get(id)?.kind === 'station');
    for (const id of st.transfers || []) for (const rid of F.get(id)?.rails || []) railIds.add(rid);
    const priority = (st.id === selectedId ? 10000 : 0) + (hasTransfer ? 1000 : 0) + Math.max(0, railIds.size - 1) * 100;
    return { st, x, y, cx, cz, priority, hasTransfer };
  }).filter(({ x, y }) => x >= -60 && y >= -30 && x <= v.w + 60 && y <= v.h + 30);

  // 縮尺100mより広域の場合のみ同一駅名（同名かつ実世界600m以内、または画面250px以内、または乗換関係）を統合
  // 縮尺100mおよびそれより狭域（mpp * 60 <= 100）ではまとめずに従来の分散処理を適用
  const shouldGroup = mpp * 60 > 100;
  const grouped = [];

  if (shouldGroup) {
    // 同名駅クラスタに国鉄(JR/KR)が存在するかを判定（川島駅等の全社乗換ターミナルを確実にまとめる）
    const nameHasJR = new Map();
    for (const item of visible) {
      const name = (item.st.name || '').trim();
      if (!name) continue;
      if (stationHasJR(item.st, F)) nameHasJR.set(name, true);
    }

    const assigned = new Set();
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      if (assigned.has(item.st.id)) continue;
      const members = [item];
      assigned.add(item.st.id);
      const stName = (item.st.name || '').trim();
      const transferIds = new Set(item.st.transfers || []);

      if (stName) {
        for (let j = i + 1; j < visible.length; j++) {
          const other = visible[j];
          if (assigned.has(other.st.id)) continue;
          const otherName = (other.st.name || '').trim();
          if (otherName !== stName) continue;

          const compA = resolveStationCompany(item.st, F);
          const compB = resolveStationCompany(other.st, F);
          const isSameCompany = compA && compB ? compA === compB : false;

          // 須賀浦・糸里駅では、500m尺以内の場合有電（有田電鉄）だけ内部的に別駅扱い
          if (mpp * 60 <= 500 && (stName === '須賀浦' || stName === '糸里')) {
            const isYudenA = compA.includes('有田') || compA.includes('有電') || compA.includes('城川');
            const isYudenB = compB.includes('有田') || compB.includes('有電') || compB.includes('城川');
            if (isYudenA !== isYudenB) continue;
          }

          // 国鉄（JR / KR）を含む主要乗換ターミナル（川島駅等）は全社まとめる
          // それ以外の駅（桜地駅等）では、同一会社のみ合体させ、他社（三川電鉄 vs 有田電鉄等）は混入させない
          const hasJR = !!nameHasJR.get(stName);
          if (!hasJR && !isSameCompany) continue;

          const isTransfer = transferIds.has(other.st.id) || (other.st.transfers || []).includes(item.st.id);
          const worldDist = Math.hypot(item.cx - other.cx, item.cz - other.cz);
          const screenDist = Math.hypot(item.x - other.x, item.y - other.y);
          if (isTransfer || worldDist < 600 || screenDist < 250) {
            members.push(other);
            assigned.add(other.st.id);
            for (const tid of other.st.transfers || []) transferIds.add(tid);
          }
        }
      }

      // グループ内の全路線を収集して重複排除
      const railMap = new Map();
      for (const m of members) {
        for (const rid of m.st.rails || []) {
          const r = F.get(rid);
          if (r && !railMap.has(r.id)) railMap.set(r.id, r);
        }
      }
      const rails = [...railMap.values()];
      // 国鉄→都市鉄道→私鉄の順に、各グループ内は記号（アルファベット）→数字順で整列
      const sortedRails = sortRailsForDisplay(rails);
      const marks = dedupeRailMarks(sortedRails);

      // 駅中心：現在のナンバリング表示順で一番早い路線を持つ駅レコードを中心にする
      const topRail = sortedRails[0];
      let rep = null;
      if (topRail) {
        const candidates = members.filter((m) => (m.st.rails || []).includes(topRail.id));
        if (candidates.length > 0) {
          candidates.sort((a, b) => {
            const pa = (a.st.id === selectedId ? 100000 : 0) + a.priority;
            const pb = (b.st.id === selectedId ? 100000 : 0) + b.priority;
            return pb - pa;
          });
          rep = candidates[0];
        }
      }
      if (!rep) {
        const sortedMembers = [...members].sort((a, b) => {
          const pa = (a.st.id === selectedId ? 100000 : 0) + a.priority;
          const pb = (b.st.id === selectedId ? 100000 : 0) + b.priority;
          return pb - pa;
        });
        rep = sortedMembers[0];
      }

      const x = rep.x;
      const y = rep.y;
      const priority = Math.max(...members.map((m) => m.priority));
      const hasTransfer = members.some((m) => m.hasTransfer);

      grouped.push({ rep: rep.st, members: members.map((m) => m.st), x, y, priority, hasTransfer, marks, name: stName, isSelected: members.some((m) => m.st.id === selectedId) });
    }
  } else {
    // 縮尺100m以内（狭域）：まとめずに各駅それぞれを個別に分散表示
    for (const item of visible) {
      const rails = (item.st.rails || []).map((id) => F.get(id)).filter(Boolean);
      const sortedRails = sortRailsForDisplay(rails);
      const marks = dedupeRailMarks(sortedRails);
      grouped.push({
        rep: item.st,
        members: [item.st],
        x: item.x,
        y: item.y,
        priority: item.priority,
        hasTransfer: item.hasTransfer,
        marks,
        name: item.st.name || '',
        isSelected: item.st.id === selectedId,
      });
    }
  }

  let drawList = grouped;
  if (mpp > 20) {
    // Place transfer and multi-line stations first, then use remaining gaps for other stations.
    const gap = 20 + Math.min(40, Math.log2(mpp / 20) * 8);
    drawList.sort((a, b) => b.priority - a.priority || a.rep.id.localeCompare(b.rep.id));
    const cells = new Map(), chosen = [];
    for (const item of drawList) {
      const gx = Math.floor(item.x / gap), gy = Math.floor(item.y / gap);
      let crowded = false;
      for (let oy = -1; oy <= 1 && !crowded; oy++) for (let ox = -1; ox <= 1 && !crowded; ox++) {
        for (const p of cells.get(`${gx + ox},${gy + oy}`) || []) {
          if (Math.hypot(item.x - p.x, item.y - p.y) < gap) { crowded = true; break; }
        }
      }
      if (!crowded) {
        chosen.push(item);
        const key = `${gx},${gy}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(item);
      }
    }
    drawList = chosen;
  }

  for (const { rep, members, x, y, priority, hasTransfer, marks, name, isSelected } of drawList) {
    const S = mpp < 3 ? 20 : 16;
    const gap = 3;
    let rowCount = 1;
    if (marks.length >= 4) {
      rowCount = marks.length <= 10 ? 2 : Math.ceil(marks.length / 5);
    }
    const perRow = Math.ceil(marks.length / rowCount);

    const rows = [];
    for (let i = 0; i < marks.length; i += perRow) {
      rows.push(marks.slice(i, i + perRow));
    }

    const rowH = S + gap;
    const totalH = rows.length * rowH - gap;
    const maxRowLen = Math.max(...rows.map((r) => r.length));
    const totalW = maxRowLen * (S + gap) - gap;

    // 先頭のナンバリングアイコンの中心が (x, y) に一致するように配置
    const startX = x - S / 2;
    const startY = y - S / 2;

    for (let rIdx = 0; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      const cy = startY + rIdx * rowH + S / 2;
      let mx = startX;
      for (const r of row) {
        const im = r.logo ? logoImg(r.logo, onImage) : null;
        if (im) {
          ctx.fillStyle = '#fff'; roundRect(ctx, mx - 1, cy - S / 2 - 1, S + 2, S + 2, 4); ctx.fill();
          ctx.drawImage(im, mx, cy - S / 2, S, S);
        } else if (r.type === 'metro') {
          ctx.fillStyle = railColor(r); ctx.beginPath(); ctx.arc(mx + S / 2, cy, S / 2, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
          const sym = (r.symbol || r.name || 'M').slice(0, 2);
          ctx.fillStyle = '#fff'; ctx.font = `800 ${sym.length > 1 ? S * 0.45 : S * 0.6}px ${FONT}`; ctx.textAlign = 'center';
          ctx.fillText(sym, mx + S / 2, cy + 0.5);
        } else {
          ctx.fillStyle = r.type === 'private' ? '#5a6370' : '#2f6fcf';
          roundRect(ctx, mx, cy - S / 2, S, S, 4); ctx.fill();
          trainGlyph(ctx, mx + S / 2, cy, S * 0.62);
        }
        mx += S + gap;
      }
    }
    const box = [startX - 2, startY - 2, startX + totalW + 2, startY + totalH + 2];
    taken.push(box);
    if (isSelected) { ctx.strokeStyle = '#1f7c6f'; ctx.lineWidth = 2; roundRect(ctx, box[0] - 2, box[1] - 2, box[2] - box[0] + 4, box[3] - box[1] + 4, 6); ctx.stroke(); }
    // 駅名
    const wideScale = mpp * 60 >= 2000;
    let hitBox = box;
    if (name && (!wideScale || hasTransfer)) {
      ctx.font = `700 12px ${FONT}`; ctx.textAlign = 'left';
      const tw = ctx.measureText(name).width;
      const lb = [box[2] + 3, y - 9, box[2] + 7 + tw, y + 9];
      if (!taken.some((t) => lb[0] < t[2] && lb[2] > t[0] && lb[1] < t[3] && lb[3] > t[1])) {
        taken.push(lb);
        ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.strokeText(name, box[2] + 5, y + 0.5);
        ctx.fillStyle = '#1d3d66'; ctx.fillText(name, box[2] + 5, y + 0.5);
        hitBox = [box[0], Math.min(box[1], lb[1]), Math.max(box[2], lb[2]), Math.max(box[3], lb[3])];
      }
    }
    for (const m of members) {
      hits.push({ id: m.id, box: hitBox, name, groupMembers: members, isGroup: members.length > 1 });
    }
  }
  ctx.restore();
  return hits;
}

/**
 * 路線を表示順にソートする。
 * ・同一会社（company）がある場合は同一会社を優先してひとまとまりにする
 * ・順序：国鉄（jr）→ 都市鉄道（metro）→ 私鉄（private）
 * ・各社内・各グループ内：路線記号（symbol）アルファベット順 → 数字順 → 路線名順
 */
export function sortRailsForDisplay(rails) {
  const typeOrder = { jr: 0, metro: 1, private: 2 };
  function compareSingleRail(a, b) {
    const ta = typeOrder[a.type] ?? 1, tb = typeOrder[b.type] ?? 1;
    if (ta !== tb) return ta - tb;
    const ka = railSortKey(a), kb = railSortKey(b);
    return ka.localeCompare(kb, 'ja', { numeric: true });
  }

  // 同一会社ごとに路線をまとめる（未設定は路線ごとに独立）
  const companyGroups = new Map();
  for (const r of rails) {
    const comp = resolveRailCompany(r);
    const key = comp ? `comp:${comp}` : `rail:${r.id}`;
    if (!companyGroups.has(key)) companyGroups.set(key, []);
    companyGroups.get(key).push(r);
  }

  // 会社内でソート
  for (const group of companyGroups.values()) {
    group.sort(compareSingleRail);
  }

  // 会社同士を、各会社の最も早い路線の順序でソート
  const sortedGroupList = [...companyGroups.values()].sort((ga, gb) => {
    return compareSingleRail(ga[0], gb[0]);
  });

  return sortedGroupList.flat();
}

/** ソート用キーを作る（アルファベット記号優先 → 数字優先の順） */
function railSortKey(r) {
  const s = (r.symbol || r.name || '').trim();
  // 1. アルファベット記号で始まる路線（例: B, K, SS, M01 など）→ 最優先
  const m = s.match(/^([A-Za-z]+)(\d*)(.*)$/);
  if (m) {
    const alpha = m[1].toUpperCase();
    const num = m[2] ? m[2].padStart(6, '0') : '000000';
    return `0_${alpha}_${num}_${m[3]}`;
  }
  // 2. 数字で始まる路線（例: 1, 2 など）→ 記号の後
  const numMatch = s.match(/^(\d+)(.*)$/);
  if (numMatch) {
    const num = numMatch[1].padStart(6, '0');
    return `1_${num}_${numMatch[2]}`;
  }
  // 3. その他（漢字など）
  return `2_${s}`;
}
/** 出口番号（かなり拡大したときだけ） */
export function drawExits(ctx, v, stations) {
  if (v.mpp > 1.6) return;
  ctx.save();
  ctx.font = `800 11px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const st of stations) for (const ex of st.exits || []) {
    const [x, y] = v.toScreen(ex.x, ex.z);
    if (x < -20 || y < -20 || x > v.w + 20 || y > v.h + 20) continue;
    const t = String(ex.label || '');
    const w = Math.max(16, ctx.measureText(t).width + 8);
    ctx.fillStyle = '#ffd43b'; roundRect(ctx, x - w / 2, y - 8, w, 16, 3); ctx.fill();
    ctx.strokeStyle = '#3a3a3a'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#222'; ctx.fillText(t, x, y + 0.5);
  }
  ctx.restore();
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
