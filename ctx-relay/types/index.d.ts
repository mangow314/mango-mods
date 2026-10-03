// 一筆主線回合結束時的讀數
export type Reading = { tokens: number; percent: number; costUsd: number }

// 上一個主線回合的收據
export type Receipt = { deltaTokens: number; deltaCost: number; durationMs: number; cachePct: number | null }

// 門檻（token 數）：fuse＝引擎回報的壓縮點；handoff 來源 auto＝壓縮點 85%、config＝handoffTokens、capped＝設定值超過 auto 改用 auto
export type Limits = { window: number; fuse: number; nudge: number; handoff: number; source: 'auto' | 'config' | 'capped' }

// 自動交接狀態機：idle →（deferred ⇄）countdown → preparing → 切換；failed／cancelled／done 為本對話終態。
// $.state 在 /clear 後歸零，所以新對話一律從 idle 開始。
export type AutoPhase = 'idle' | 'deferred' | 'countdown' | 'preparing' | 'done' | 'failed' | 'cancelled'
export type Auto = { phase: AutoPhase; deadline?: number; detail?: string }

declare module 'claude-code' {
  interface PluginState {
    'ctx-relay': {
      readings: Reading[]
      receipt: Receipt | null
      limits: Limits | null
      startedAt: number
      auto: Auto
    }
  }
}
