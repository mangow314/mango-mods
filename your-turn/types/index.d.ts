// 一條要使用者親手跑的指令；isDone＝使用者在 pane 按數字鍵勾了完成；
// note＝回覆裡這段指令的前一句（只有每段第一條有，空字串＝不畫說明行）
export type Step = { cmd: string; isDone: boolean; note?: string }

declare module 'claude-code' {
  interface PluginState {
    'your-turn': {
      // 最近一則帶指令的回覆抽出的清單；$.state 在 /clear 後歸零
      steps: Step[]
    }
  }
}
