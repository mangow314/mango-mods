# ctx-relay

一個 Claude Code mod，在提示框上方顯示一行 band：每輪花費、context 佔模型窗的百分比、離交接線還剩幾輪。
主對話越過自動交接線時，它會自動交接：產生交接檔，`/clear`，在新對話接續。

測試過的版本：Claude Code 2.1.288。mods API 還在 early access，改版後可能要跟著調整。

## 會做什麼
| 什麼時候 | 會發生什麼 |
|---|---|
| 主對話回合結束，context ≥ 交接線 | 有子代理或背景 Bash 在跑時，延後交接，band 顯示原因；沒有的話，倒數 60 秒 |
| 倒數中 | 按「取消自動交接」（hotkey 1）或送出任何訊息就取消，這段對話之後只提醒 |
| 倒數結束 | mod 收集 git 狀態和 progress INDEX → `$.model.fork` 依 handoff skill 的 8 欄位產生交接檔 → 機器檢查（缺欄位就標 `thin:`）→ 寫檔並讀回確認 → 確認對話沒變動 → `/clear` → 在新對話送出交接檔路徑和接手規則 |
| 任何一步在 `/clear` 之前失敗 | 留在原對話，band 顯示原因，不重試 |

## 門檻
- 壓縮點：Claude Code 自己回報的 auto-compact 觸發點（`$.session.usage({ breakdown })` 的 `autoCompactThreshold`）。auto-compact 關掉時改用模型窗。
- 交接線：設定 `handoffTokens` 就用設定值；沒設（0）就用壓縮點的 85%。設定值超過壓縮點的 85% 時（例如換到 200K 模型），改用 85%，`/ctx-relay-status` 會註明。
- 橘色提醒線：交接線的 88%。

設定交接線：`/config` 裡的 ctx-relay 那一列，或在 shell 跑：

```bash
echo '{"handoffTokens": "400000"}' | claude plugin configure ctx-relay@mango-mods --values-stdin
```

改設定會重新載入 mod。端到端測試可以把它設得很低（例如 1）。

注意：設了 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 時，Claude Code 回報的壓縮點可能沒有套用這個百分比。2.1.288 實測：`CLAUDE_CODE_AUTO_COMPACT_WINDOW=600000`、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=88` 時，回報 567,000（=600,000−33,000）。真正在哪裡壓縮沒有驗證。用了這個環境變數，就請設 `handoffTokens`。

## band
`◆ ctx 22% 220K/400K · 本輪 +20K $0.50 12s cache 90% · 剩約 10 輪到交接線 · 1h20m ▁▂▃▅`

- 顏色：天藍＝正常、橘＝過提醒線、朱紅＝過交接線／倒數／失敗。狀態粗體，次要資訊 dim。
- `220K/400K`：目前 context／交接線。
- 「剩約 N 輪」從第 2 輪結束起出現（第一筆增量含系統提示，不算）。
- 經過時間和長條只在終端機寬度 ≥110 欄時顯示；長條高度對交接線，滿格＝到交接線。

## 交接檔放哪裡
git repo：`<git-common-dir>/harness/handoff/`；非 git：`~/.claude/harness/<目錄名>-<sha256 前 8 碼>/handoff/`。
有 `<同一根目錄>/progress/<session id>/INDEX.md` 的話，會一起交給 fork 參考。

## 指令
- `/ctx-relay-status`：顯示門檻、讀數、交接狀態和背景工作
- `/ctx-relay-now`：立刻交接；有背景工作在跑時要打 `/ctx-relay-now yes`

## 已知限制
- 背景工作不會逾時作廢：常駐 server 會讓交接一直延後，要交接就用 `/ctx-relay-now yes`。
- 交接內容由 fork 產生，機器檢查只看欄位有沒有空，不保證內容正確。新對話會被要求先用 git 核對。
- 不確定 `$.agent.list()` 會不會列出 agent-bridge worker 還沒回覆的任務。
- `/clear` 之後 `$.state` 會歸零；模組變數和計時器會保留（實測），所以 mod 在 clear 前會先取消計時器。
- 需要 PATH 上有 `bash` 和 `git`；非 git 目錄還要 `realpath`（GNU，支援 `-m`），以及 `sha256sum` 或 `shasum`。
- 交接檔路徑的演算法照抄 mango 的 dotfiles `hooks/_lib/harness-paths.sh`，讓兩邊的 handoff 檔放在同一處；改一邊要改另一邊。
