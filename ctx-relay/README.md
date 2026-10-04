# ctx-relay

一個 Claude Code mod，在提示框上方顯示一行 band：目前 context／交接線、每輪花費、離交接線還剩幾輪。
主對話越過自動交接線時，它會自動交接：產生交接檔，`/clear`，在新對話接續。

實機測試過的版本：Claude Code 2.1.289（0.5.0，用 `--plugin-dir` 載入；測過倒數、按鈕取消、打字取消、完整自動交接、與 blast-radius 共存）。mods API 還在 early access，改版後可能要跟著調整。

## 會做什麼
| 什麼時候 | 會發生什麼 |
|---|---|
| 主對話停下（Stop），context ≥ 交接線 | Claude Code 回報還有背景工作（shell、子代理、monitor、workflow…）或一次性排程時，延後交接，band 顯示原因；循環排程不擋。沒有的話，倒數 60 秒 |
| 延後中 context 到上限（交接線與壓縮點的中點） | 照樣倒數，交接檔頭寫明還在跑的工作（完成通知可能收不到） |
| 別的 Stop hook 擋下（回合其實沒結束） | 不判斷，等真正停下的那次 |
| 倒數中 | 按「取消自動交接」（hotkey 1）或送出任何訊息就取消，這段對話之後只提醒 |
| 倒數或準備中有新回合開始（排程、背景通知、別的 session 傳訊） | 這次切換作廢，回合結束再重新判斷 |
| 倒數結束 | mod 收集 git 狀態和 progress INDEX → `$.model.fork` 依 handoff skill 的 8 欄位產生交接檔（3 分鐘沒回就放棄）→ 機器檢查（缺欄位就標 `thin:`）→ 附上來源交接檔的協調契約原文 → 寫檔並讀回確認 → 確認對話沒變動 → `/clear` → 在新對話送出交接檔路徑和接手規則 |
| 任何一步在 `/clear` 之前失敗 | 留在原對話，band 顯示原因，不重試 |

協調契約由 mod 原樣附上，不經模型：fork 自己寫的「協調契約」段落一律丟掉。

## 門檻
- 壓縮點：Claude Code 自己回報的 auto-compact 觸發點（`$.session.usage({ breakdown })` 的 `autoCompactThreshold`）。auto-compact 關掉時改用模型窗。
- 交接線：設定 `handoffTokens` 就用設定值；沒設（0）就用壓縮點的 85%。設定值超過壓縮點的 85% 時（例如換到 200K 模型），改用 85%，`/ctx-relay-status` 會註明。
- 橘色提醒線：交接線的 88%。
- 延後上限：有背景工作時，最多延後到交接線與壓縮點的中點。

設定交接線：`/config` 裡的 ctx-relay 那一列，或在 shell 跑：

```bash
echo '{"handoffTokens": "400000"}' | claude plugin configure ctx-relay@mango-mods --values-stdin
```

從 shell 改的設定，要重開 Claude Code 或在 session 裡跑 `/reload-plugins` 才生效。端到端測試可以把它設得很低（例如 1）。

注意：設了 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 時，Claude Code 回報的壓縮點可能沒有套用這個百分比。2.1.288 實測：`CLAUDE_CODE_AUTO_COMPACT_WINDOW=600000`、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=88` 時，回報 567,000（=600,000−33,000）。2.1.289 實測窗 120,000：回報 87,000，實際在 context 從 86,412 漲到 88,335 的那一輪壓縮；回報值和 (120,000−20,000)×88%＝88,000 都落在這個範圍，分不出哪個對。600K 窗時真正的壓縮點仍可能是 510K、528K 或 567K。用了這個環境變數，就請設 `handoffTokens`。

用 `claude --plugin-dir` 載入時讀不到已安裝版本的 `handoffTokens`，交接線會是自動值。

## band
`󰯉 󰯉 󰊠  CTX 220K/400K · 本輪 +20K $0.50 12s 90% · STAGE 10 輪 ▁▂▃▅`

8-Bit 街機計分板樣式。倒數時整行換成 `󰯉 CONTINUE? 42s（400K 存檔交接／任發訊息取消）`，旁邊是取消按鈕（按 1）。

- 三隻小怪獸是離交接線的 HP（token ÷ 交接線）：<40% 三隻；<70% 一隻變鬼魂；到提醒線前剩一隻＋兩隻鬼魂；過提醒線換骷髏；越過交接線全是骷髏。
- 顏色：天藍＝正常、橘＝過提醒線、朱紅＝過交接線／倒數／失敗。底色跟著三態變深藍／暗橘／暗紅。
- `220K/400K`：目前 context／交接線。`90%`：本輪 cache 命中率（整輪請求加總）。佔模型窗的百分比和經過時間不在 band 上，看 statusline。
- 「STAGE N 輪」＝剩約 N 輪到交接線，從第 2 輪結束起出現（第一筆增量含系統提示，不算）。
- 長條只在終端機寬度 ≥110 欄時顯示；長條高度對交接線，滿格＝到交接線。
- 別的 mod 也畫 band 時（例如 blast-radius 在窄終端機把 Proceed／Cancel 畫在這裡），它的內容在上、ctx-relay 這行在下。高度不夠或對方不讓位時，ctx-relay 這行會看不到，見「已知限制」。
- 圖示要 Nerd Font（例如 Symbols Nerd Font 補字），沒有的話三隻小怪獸會變成方框。
- 在 tmux 裡，Claude Code 預設只用 256 色，暗色底會變成 #00005f 這類亮很多的顏色。tmux 有開 RGB 的話，設 `CLAUDE_CODE_TMUX_TRUECOLOR=1` 才會照原色畫。

## 交接檔放哪裡
git repo：`<git-common-dir>/harness/handoff/`；非 git：`~/.claude/harness/<目錄名>-<sha256 前 8 碼>/handoff/`。
檔名：`<時間戳>-<slug>-<來源 session id 前 8 碼>-<批次號>.md`，同一秒的兩批或共用同一個 git-common-dir 的兩個 session 不會互相覆寫。
有 `<同一根目錄>/progress/<session id>/INDEX.md` 的話，會一起交給 fork 參考。

## 指令
- `/ctx-relay-status`：顯示門檻、讀數、交接狀態和背景工作
- `/ctx-relay-now`：立刻交接；有背景工作在跑時要打 `/ctx-relay-now yes`

## 已知限制
- 背景工作不會逾時作廢：常駐 server 會讓交接延後到上限才強制倒數；要早點交接就用 `/ctx-relay-now yes`。
- 指令看到的背景工作是上一次主對話停下時的清單，加上當下在跑的子代理。
- 子代理可能同時出現在 Claude Code 的背景工作清單和子代理清單，延後原因的數字會多算。
- agent-bridge 送出、還沒回覆的任務偵測不到：`/clear` 前請自己確認。
- 跟 blast-radius 一起用、終端機窄到它把攔截框畫在 band 位置時（實測 80 欄會；200 欄它改用側邊窗格，不受影響），攔截期間 ctx-relay 這行可能看不到。按鈕照常可按，攔截結束 band 就回來。
  - 終端機高度至少 42 行才放得下兩者（2.1.289 實測，攔截框列 2 個檔案、共 11 行：41 行以下顯示「↓ 2 more」）。框裡列的檔案越多，需要的行數越多。
  - blast-radius 先畫時，它不把位置交給下一個 mod，多高都看不到。哪個 mod 先畫由載入順序決定，官方文件沒寫。
- 交接內容由 fork 產生，機器檢查只看欄位有沒有空，不保證內容正確。新對話會被要求先用 git 核對。
- `/clear` 之後 `$.state` 會歸零；模組變數和計時器會保留（實測），所以 mod 在 clear 前會先取消計時器。
- 需要 PATH 上有 `bash` 和 `git`；非 git 目錄還要 `realpath`（GNU，支援 `-m`），以及 `sha256sum` 或 `shasum`。
- 交接檔路徑的演算法照抄 mango 的 dotfiles `hooks/_lib/harness-paths.sh`，讓兩邊的 handoff 檔放在同一處；改一邊要改另一邊。
