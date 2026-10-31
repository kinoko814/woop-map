// =============================================================
// 営業時間
//   hours = { mode: 'none' | '24h' | 'week', days: [[開店, 閉店] | null ×7（月〜日）], note }
//   時刻は "09:00" 形式。閉店が開店より前なら日をまたぐ（例 18:00〜02:00）
// =============================================================
export const DAY_NAMES = ['月', '火', '水', '木', '金', '土', '日'];
export const defaultHours = () => ({ mode: 'week', days: Array.from({ length: 7 }, () => ['09:00', '18:00']), note: '' });

const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
/** 月=0 … 日=6 */
const dayIndex = (d) => (d.getDay() + 6) % 7;

/** いま営業中か（true / false / null=不明） */
export function isOpenNow(hours, now = new Date()) {
  if (!hours || hours.mode === 'none') return null;
  if (hours.mode === '24h') return true;
  const t = now.getHours() * 60 + now.getMinutes();
  const d = dayIndex(now);
  const inRange = (span, minute, prevDay) => {
    if (!span) return false;
    const o = toMin(span[0]), c = toMin(span[1]);
    if (c > o) return !prevDay && minute >= o && minute < c;
    // 日をまたぐ営業
    return prevDay ? minute < c : minute >= o;
  };
  return inRange(hours.days?.[d], t, false) || inRange(hours.days?.[(d + 6) % 7], t, true);
}
export function hoursSummary(hours) {
  if (!hours || hours.mode === 'none') return '';
  if (hours.mode === '24h') return '24時間営業';
  return DAY_NAMES.map((n, i) => `${n} ${hours.days?.[i] ? `${hours.days[i][0]}〜${hours.days[i][1]}` : '定休日'}`).join(' / ');
}
