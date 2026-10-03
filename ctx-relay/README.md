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

交接線由 `~/.claude/hooks/_lib/ctx-thresholds.sh` 推出：(有效窗 − `CTX_OUTPUT_RESERVE`) × 壓縮百分比 × `CTX_AUTOHANDOFF_PCT`。1M 窗目前是 433,840。
設 `CTX_AUTOHANDOFF_THRESHOLD=<token 數>` 可以直接指定交接線（端到端測試用）。

## 指令
- `/ctx-relay-status`：顯示門檻、讀數、交接狀態和背景工作
- `/ctx-relay-now`：立刻交接；有背景工作在跑時要打 `/ctx-relay-now yes`

## 已知限制
- 背景工作不會逾時作廢：常駐 server 會讓交接一直延後，要交接就用 `/ctx-relay-now yes`。
- 交接內容由 fork 產生，機器檢查只看欄位有沒有空，不保證內容正確。新對話會被要求先用 git 核對。
- 不確定 `$.agent.list()` 會不會列出 agent-bridge worker 還沒回覆的任務。
- `/clear` 之後 `$.state` 會歸零；模組變數和計時器會保留（實測），所以 mod 在 clear 前會先取消計時器。
- 依賴 `~/.claude/hooks/_lib/ctx-thresholds.sh` 和 `harness-paths.sh`（chezmoi 管理的 dotfiles）。
