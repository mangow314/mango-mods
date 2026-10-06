# mango-mods

**給長時間、跨多個 repo 工作用的 Claude Code 小 mod。**

這個 Claude Code marketplace 收我自己用的 mods。mod 就是用 JS/TS function hooks 寫成的 plugin：可以在提示框上方畫一行 band、在對話旁開 pane、對 session 事件做反應。
結構和官方 [claude-code-playground/claude-code/mods](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods) 一樣，每個 plugin 一個目錄。

![your-turn：Claude 要你親手跑的指令，列在對話旁的 pane](docs/assets/your-turn.png)

*your-turn 實機畫面：Claude 的回覆要你親手跑 5 條指令，pane 照順序列出來，按在哪裡跑分框，每段帶上回覆裡說明那一步的句子；已經勾掉 2 條。*

> English: [README.md](README.md)。這份是它的繁體中文對譯；各 plugin 的中文說明在該目錄的 `README.zh-TW.md`。

| plugin | 用途 |
|---|---|
| [ctx-relay](ctx-relay/README.md) | 顯示每輪花費與剩餘空間；越過自動交接線時自動產生交接檔，然後 /clear 接續 |
| [repo-ledger](repo-ledger/README.md) | 列出這個對話動過、還沒 commit 的 repo（分支、未 commit 檔數、未 push、別的 worktree）和本輪改了幾檔 |
| [your-turn](your-turn/README.md) | 把回覆裡要你親手跑的指令（sudo、`! <cmd>`、叫你自己跑的 shell 區塊）列成對話旁可勾選的清單，帶上回覆裡的說明，全部完成後按 r 回報 |
| [away-receipt](away-receipt/README.md) | 離開一段時間回來時，對話旁列出離開期間發生了什麼：多久、幾輪、花多少，動過的 repo、跑過的測試、背景工作 |

## 截圖

截圖都來自真實的 Claude Code 2.1.290 session（Haiku 4.5），在一次性的測試 repo 裡跑，用 [vhs](https://github.com/charmbracelet/vhs) 截下；做法見 [docs/demo/](docs/demo/)。

### ctx-relay＋repo-ledger：提示框上方的 band

![上面是 repo-ledger，下面是 ctx-relay](docs/assets/bands.png)

上面是 repo-ledger：`demo-app` 在 `main`，1 個檔沒 commit，本輪改了 2 檔。下面是 ctx-relay：三隻小怪獸是離交接線還剩的 HP，接著是目前 context／交接線、本輪增量、花費、耗時、cache 命中率，以及每輪 context 大小的長條（滿格＝交接線）。

![ctx-relay 待接手：有一份還沒人接手的交接檔，按 1 接續](docs/assets/ctx-relay-pickup.png)

新對話開場時，如果有還沒人接手的交接檔，band 下面多一行；按 `1` 送出接續指令。

### your-turn：全部勾完

![your-turn 全部勾完，出現回報按鈕](docs/assets/your-turn-done.png)

全部勾完時框線變灰，按 `r` 替你送出「5/5 完成了」。

### away-receipt：離開期間發生了什麼

![away-receipt：新 commit、未 commit 檔、一個失敗一個通過的測試](docs/assets/away-receipt.png)

1 個新 commit、1 個未 commit 檔、失敗的 `make test`（按 `1` 把它填進提示框，請 Claude 修）和通過的 `npm test`。

## 狀態
- 個人實驗，只在 Claude Code 2.1.289、2.1.290 測過。mods API 還在 early access，Claude Code 改版後可能要跟著改；不保證相容，也不保證回 issue。
- 裝之前請先讀程式碼：這些 mod 會跑 git 指令、寫檔；ctx-relay 會自動 /clear，並在新對話送出接續訊息。

## 安裝
```
claude plugin marketplace add mangow314/mango-mods
claude plugin install ctx-relay@mango-mods
```
其他 mod 把 `ctx-relay` 換成目錄名。

## 開發與發布
- 開發時直接載入目錄，不要用已安裝的副本，因為已安裝的 plugin 會按版本快取：
  `claude --plugin-dir ~/projects/mango-mods/<plugin>`
- 檢查：在 plugin 目錄裡跑 `claude plugin validate .`、`claude plugin test .`、`npx -p typescript@5 tsc -p .`。
  tsc 需要先載入一次 mod，引擎才會產生 `.claude-plugin/types/`，這個目錄不進版控。
- 發布：先調高該 plugin `plugin.json` 的 `version`，然後 commit、push，再跑 `claude plugin marketplace update mango-mods`，最後更新已安裝的版本。
- 安裝任何 mod 前，先看 `claude plugin validate --json` 列出的 hooks 和 calls 清單（安裝閘見 `~/.claude/rules/safety.md`）。

## 授權
[MIT](LICENSE)，涵蓋這個 repo 裡所有 plugin。
