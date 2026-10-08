// 一筆主線回合結束時的讀數
export type Reading = { tokens: number; costUsd: number }

// 上一個主線回合的收據
export type Receipt = { deltaTokens: number; deltaCost: number; durationMs: number; cachePct: number | null }

// 門檻（token 數）：fuse＝引擎回報的壓縮點；handoff 來源 auto＝壓縮點 85%、config＝handoffTokens、capped＝設定值超過 auto 改用 auto；
// cap＝有背景工作時延後的上限（交接線與壓縮點的中點）
export type Limits = { window: number; fuse: number; nudge: number; handoff: number; cap: number; source: 'auto' | 'config' | 'capped' }

// 快取倒數：lastRequestAt＝上一次主線回合（或保溫 fork）結束的時間，turnStartedAt＝這一輪開始的時間（算閒置多久）；
// ttlMs／ttlSource＝推定的快取存活時間與依據；observed＝觀測修正的原因（有值＝本 session 改判 5m）；keepalives＝這段閒置已保溫幾次
export type Cache = { lastRequestAt: number | null; turnStartedAt: number | null; ttlMs: number; ttlSource: string; observed: string; keepalives: number }

// 自動交接狀態機：idle →（deferred ⇄）countdown → preparing → 切換；failed／cancelled／done 為本對話終態。
// $.state 在 /clear 後歸零，所以新對話一律從 idle 開始。
export type AutoPhase = 'idle' | 'deferred' | 'countdown' | 'preparing' | 'done' | 'failed' | 'cancelled'
export type Auto = { phase: AutoPhase; deadline?: number; detail?: string }

// handoff-pickup：新對話開場時待接手的交接檔（最新一份）；from＝來源 session 前 8 碼（讀不到為空），more＝其他待接手份數
export type Pickup = { path: string; name: string; mtimeMs: number; from: string; more: number }

declare module 'claude-code' {
  interface PluginState {
    'ctx-relay': {
      readings: Reading[]
      receipt: Receipt | null
      limits: Limits | null
      auto: Auto
      cache: Cache
    }
  }
}
