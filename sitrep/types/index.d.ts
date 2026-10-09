// 回覆最後附的 ui-summary 區塊（模型照 sitrep 注入的系統提示寫）
export type Option = { key: string; label: string }
export type Item = { kind: 'decision' | 'user-next' | 'agent-next'; text: string; options?: Option[]; recommended?: string }
export type Facet = { label: string; summary: string; heading?: string }
// 多步驟工作的步驟清單（pane 的任務段）
export type SummaryTask = { text: string; done: boolean }
export type Summary = { status?: 'done' | 'blocked' | 'partial'; outcome: string; items: Item[]; facets: Facet[]; tasks?: SummaryTask[] }
// 一輪結束時記下的結論：TurnDuration 那列沒有輪次編號，只能用耗時對回來
export type TurnNote = { id?: string; durationMs: number; glyph: string; outcome: string }
// 子代理：主對話派的記在派它那一輪的結論框（card＝ui-summary id）下；card 還沒有＝剛啟動、這一輪還沒結束（''＝不屬於任何框）
// model／effort／context（最近一次請求的 context）／output（累計輸出 token）／steps（模型請求次數）給 /agents-info 用
export type AgentNote = {
  id: string; type: string; description: string; status: string; card?: string; durationMs?: number; startedAt?: number
  model?: string; effort?: string | number; context?: number; output?: number; steps?: number
}
// 還沒 commit 的改動（git diff HEAD --numstat）：repo 內路徑、絕對路徑（跟 touched 比）、增刪行數
export type ChangeNote = { path: string; abs: string; add: number; del: number }
// classic.TaskCreated／TaskCompleted 記下的任務
export type TaskNote = { id: string; subject: string; done: boolean }
// pane 證據段：沿用最近一輪有「驗證」段的結論，age＝之後又過了幾輪有摘要的回合
export type Evidence = { chips: string[]; proof: string[]; age: number }

declare module 'claude-code' {
  interface PluginState {
    'sitrep': {
      // 每個 ui-summary 區塊（以內容雜湊當 id）的已選答案：題號 → 選項 key
      answers: Record<string, Record<number, string>>
      // 展開中的收合段落：`${id}:${段落序號}`
      open: Record<string, boolean>
      // 最近幾輪的結論，給 TurnDuration 那列用
      turns: TurnNote[]
      // 最近一張結論框的待決題目，給 prompt 上方那列用；沒附區塊的回合不動它
      // todo＝要你親手做的事（user-next），沒題目時 prompt 上方那列改提示它
      pending: { id: string; decisions: Item[]; todo: string[] } | null
      // 背景子代理與它所屬的結論框
      agents: AgentNote[]
      // 狀態 pane：最近一張結論框、背景工作、任務、git diff --stat
      last: { id: string; summary: Summary } | null
      // 最近一次有「驗證」段的結論：小標籤、細節行、離現在幾輪（0＝這一輪）
      evidence: Evidence | null
      background: string[]
      tasks: TaskNote[]
      changes: ChangeNote[]
      // 這個 session 用 Edit／Write 改過的檔（絕對路徑）
      touched: string[]
      // pane 現在有畫出來：題目移到 pane，prompt 上方那列不畫
      paneOpen: boolean
    }
  }
}
