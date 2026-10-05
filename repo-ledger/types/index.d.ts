// 一個 repo 的現況：git status --branch 與 git worktree list 的結果
// dirty＝未 commit 的檔案數（含未追蹤）；ahead＝還沒 push 的 commit 數；worktrees＝這個 repo 另外開的 worktree 數
export type RepoRow = { root: string; name: string; branch: string; dirty: number; ahead: number; worktrees: number }

// band 讀的整份帳本。rows 照 repo 加入的順序，session 工作目錄的 repo 在最前；
// turnFiles＝本輪（上次送出訊息以來）Edit／Write 過的檔案數
export type Ledger = { rows: RepoRow[]; turnFiles: number }

declare module 'claude-code' {
  interface PluginState {
    'repo-ledger': {
      ledger: Ledger
      // 這個對話追蹤中的 repo 根目錄；hot reload 後由 session.start 讀回
      roots: string[]
    }
  }
}
