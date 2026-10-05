// 一條要使用者親手跑的指令；isDone＝使用者在 pane 按數字鍵勾了完成
export type Step = { cmd: string; isDone: boolean }

declare module 'claude-code' {
  interface PluginState {
    'your-turn': {
      // 最近一則帶指令的回覆抽出的清單；$.state 在 /clear 後歸零
      steps: Step[]
    }
  }
}
