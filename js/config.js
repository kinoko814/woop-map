// =============================================================
// Supabase の接続情報
//   Supabase の Project Settings → API にある値を貼り付けてください。
//   空のままだと「設定が必要です」の画面になります。
// =============================================================
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

export const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
