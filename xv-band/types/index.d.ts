// band 上一行對應的 xv job（每 2 秒掃一次 jobs/ 算出來）
export type Row = {
  // job id，例如 20261010T041615Z-codex-4553
  id: string
  vendor: string
  profile: string | null
  round: number
  status: string
  // 執行中＝現在 - round_started；結束＝secs；不知道＝null
  elapsed: number | null
  // 執行中才有：最近一個動作，例如「執行 rg foo」「回報 …」「工具 view_file」；沒有＝''
  activity: string
}

// 要畫的東西：rows 執行中在前、再來是最新結束的（最多 2 筆），合計最多 5 筆；
// more＝10 分鐘內結束、但沒畫出來的 job 數（收成一行「另有 N 個已完成」）
export type Band = { rows: Row[]; more: number }

declare module 'claude-code' {
  interface PluginState {
    'xv-band': {
      band: Band
    }
  }
}
