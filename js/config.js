// =============================================================
// Supabase の接続情報
//   Supabase の Project Settings → API にある値を貼り付けてください。
//   空のままだと「ローカルデモモード」で動きます
//   （ブラウザ内保存・ログイン不要・同じブラウザのタブ同士で同時編集）。
// =============================================================
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

export const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
