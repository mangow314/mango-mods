// 驗證：跑過的測試指令；code＝exit code（null＝失敗但看不出幾號），runs＝跑了幾次（code 是最後一次的）
export type Test = { cmd: string; code: number | null; runs: number }
// 背景工作：通知裡的 <status>（completed／failed／killed）與 <summary>
export type Task = { status: string; summary: string }
// 一個 repo 的一段：新 commit（短 hash＋標題）、未 commit 檔（porcelain 原樣）、別的 worktree（路徑＋分支）
export type RepoPart = { name: string; branch: string; commits: string[]; files: string[]; worktrees: string[] }
// 打開時算好的收據；pane 只畫這份，之後的事不會改它
export type Receipt = { awayMs: number; turns: number; usd: number; repos: RepoPart[]; tests: Test[]; tasks: Task[] }

declare module 'claude-code' {
  interface PluginState {
    'away-receipt': {
      receipt: Receipt | null
    }
  }
}
