# ctx-relay

> English: [README.md](README.md)。這份是它的繁體中文對譯。band 與指令的畫面文字是英文。交接檔用英文標題、內文照對話語言寫；可選的 `full` 格式是中文（見「交接檔格式」）。

不需要其他 skill 或 hook：交接檔由 mod 自己寫。

一個 Claude Code mod，在提示框上方顯示一行 band：目前 context／交接線、每輪花費、prompt 快取還熱多久。
主對話越過自動交接線時，它會自動交接：產生交接檔，`/clear`，在新對話接續。
新對話開場時，如果有還沒人接手的交接檔，band 多一行 Pending handoff（待接手），按 1 就送出接續指令。

實機測試過的版本：Claude Code 2.1.289（0.5.0，用 `--plugin-dir` 載入；測過倒數、按鈕取消、打字取消、完整自動交接、與 blast-radius 共存）。2.1.294 另測過現行 band 與快取倒數。mods API 還在 early access，改版後可能要跟著調整。

## 會做什麼
| 什麼時候 | 會發生什麼 |
|---|---|
| 主對話停下（Stop），context ≥ 交接線 | Claude Code 回報還有背景工作（shell、子代理、monitor、workflow…）或一次性排程時，延後交接，band 顯示原因；循環排程不擋。沒有的話，倒數 60 秒 |
| 延後中 context 到上限（交接線與壓縮點的中點） | 照樣倒數，交接檔頭寫明還在跑的工作（完成通知可能收不到） |
| 別的 Stop hook 擋下（回合其實沒結束） | 不判斷，等真正停下的那次 |
| 倒數中 | 按 Cancel（hotkey 1）就取消，這段對話之後只提醒；送出任何訊息只延後，這輪結束還在線上就重新倒數 |
| 倒數或準備中有新回合開始（排程、背景通知、別的 session 傳訊） | 這次切換作廢，回合結束再重新判斷 |
| 倒數結束 | mod 收集 git 狀態 → `$.model.fork` 只填各欄內文，每欄用一行 `=== 鍵名 ===` 分段（3 分鐘沒回就放棄）→ mod 用自己寫死的 `## ` 標題組成交接檔，模型沒有機會把標題打錯 → 機器檢查（缺欄位就標 `thin:`；一個分段標記都沒有就記失敗）→ 寫檔並讀回確認 → 確認對話沒變動 → `/clear` → 在新對話送出交接檔路徑和接手規則 |
| 任何一步在 `/clear` 之前失敗 | 留在原對話，band 顯示原因，不重試 |

`full` 格式下，協調契約由 mod 原樣附上，不經模型：fork 寫的 `=== CONTRACT ===` 分段和內文裡的「## 協調契約」段一律丟掉。fork 內文裡其他 `## ` 行會降成 `### `，交接檔的二級標題只有 mod 寫的那幾個。鍵名打錯（例如 `=== VERIFED ===`）的分段：該欄記 `thin:`，內文不丟，附在 Next（`full` 是「關鍵細節備忘」）末尾並標明。fork 輸出裡的 ` ```ui-summary ` 區塊（sitrep mod 要模型每輪附的摘要）會被拿掉。

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
![ctx-relay band：圖示、膠囊進度條、token、費用、快取倒數](../docs/assets/ctx-relay-band.png)

一行，由左到右：

1. 圖示＋10 格膠囊進度條，兩者跟著離交接線的比例（token ÷ 交接線）變色：

   | token ÷ 交接線 | 圖示 | 顏色 |
   |---|---|---|
   | 70% 以下 | 小怪獸 | 綠 |
   | 70% 到提醒線 | 幽靈 | 黃 |
   | 提醒線到交接線 | 骷髏 | 橘 |
   | 到交接線以上 | 骷髏 | 朱紅 |

   進度條會動：每 250ms 一道亮光往右掃過亮格一格，圖示跟著明暗呼吸。快取過期後（你多半不在）動畫停下，下一輪結束再開始。
2. `220K/434K 51%`：目前 context／交接線，以及比例。
3. `· +20K $0.50 12s`：這輪增加的 context、花費、耗時。這輪快取命中率（整輪請求加總）低於 40% 時，後面多一個 `󰜗 12%`：這輪吃到冷快取、比較貴，多半是閒置太久快取過期。
4. `· cache 42m`：prompt 快取倒數，見「快取倒數」。回合進行中不顯示。
5. 長條：最近幾輪結束時的 context，滿格＝到交接線。只在終端機寬度 ≥110 欄時顯示。
6. `· <狀態>`：延後交接（附原因）、正在寫交接檔、失敗、已取消，或這段對話是從哪份交接檔接手的。

- 只用前景色，沒有底色。
- 文字顏色用 Claude Code 的主題色名稱（`text`、`inactive`、`warning`、`error`…），跟著你的 `/theme` 走，淺色、daltonized 都一樣。圖示和進度條維持上表的固定色：進度條是 `Raster`，只吃 RGB。
- 不到 80 欄就拿掉進度條（圖示和數字保留）；還是放不下的部分從尾端截掉。
- 倒數時整行換成 `󰚌 Handoff in 42s · at 400K · send a message to postpone`，旁邊是 `Cancel [1]` 按鈕。
- 交接後（自動交接，或按待接手那行的 `Resume [1]`），狀態寫 `Resumed from <檔名> · next: <下一步欄的第一行> · /ctx-relay-notes`，自動交接還會跳一個 toast。你一打字，next 那段就收掉。
- `/clear` 成功但接續訊息送不出去時，這行顯示 `Cleared, but <原因>. Type: Read <路徑> and continue from it`。「Type:」後面是要你貼進對話的接續指令；`full` 格式時是中文（`讀 <路徑> 並依其接續`）。
- 別的 mod 也畫 band 時（例如 blast-radius 在窄終端機把 Proceed／Cancel 畫在這裡），它的內容在上、ctx-relay 這行在下。高度不夠或對方不讓位時，ctx-relay 這行會看不到，見「已知限制」。
- 圖示、雪花、膠囊（U+EE00–EE05，Nerd Fonts 3.0 起才有）都要 Nerd Font（例如 Symbols Nerd Font 補字），沒有的話會變成方框。
- 在 tmux 裡，Claude Code 預設只用 256 色。tmux 有開 RGB 的話，設 `CLAUDE_CODE_TMUX_TRUECOLOR=1` 才會照原色畫。

## 快取倒數
prompt 快取讓下一次請求便宜地重讀對話。一段時間沒有請求就會過期（存活時間 TTL），每次請求都會重新計時。倒數告訴你還剩多久，方便決定要繼續、先壓縮，還是開新 session。

- 剩餘時間＝TTL −（現在 − 主對話上一輪結束的時間）。以分計，不到 1 分鐘改以秒計，最後 5 分鐘變橘色，過期顯示 `󰜗 cold`（同時收掉上一輪的命中率）。
- mod 拿不到 Claude Code 自己的快取狀態（`prompt_cache` 只在 statusline 的輸入裡），所以 ctx-relay 自己推算。它從回合結束算起，比該輪最後一次請求開始的時間晚，可能多算大約最後一則回覆的長度。當參考就好。
- TTL 判定，先符合的算，順序和 Claude Code 相同（[prompt caching](https://code.claude.com/docs/en/prompt-caching)）：
  1. 有設 `FORCE_PROMPT_CACHING_5M` → 5 分鐘
  2. `CLAUDE_CODE_PROMPT_CACHE_TTL`（`5m` 或 `1h`）
  3. 設定 `promptCacheTtl`（`5m` 或 `1h`）
  4. 有設 `ENABLE_PROMPT_CACHING_1H` → 1 小時
  5. Claude 訂閱（session 回報用量上限）→ 1 小時；否則（API key、雲端供應商）→ 5 分鐘
- 觀測修正：閒置超過 5 分鐘、還沒到推定的 TTL 就回來，那輪命中率卻低於 40%，ctx-relay 就把這個 session 改判 5 分鐘（例如訂閱超出方案用量後會降成 5 分鐘）。`/ctx-relay-status` 會寫原因。
- 主對話壓縮後（`/compact`、自動壓縮、閒置壓縮），舊快取對不上對話開頭，倒數先收掉，下一輪結束再算。
- 閒置壓縮：Claude Code 會在你閒置時、快取過期前自己把長對話壓縮，並顯示「Compacted while idle, before the prompt cache expired」。文件沒寫，以下讀自 2.1.294 執行檔：只在快取是 1 小時、還沒過期，context 至少 200K（`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`，下限 100K），閒置到 TTL 的大約 90%（約 54 分鐘），而且 Anthropic 為你的帳號開了這功能時才跑。在 settings 設 `"idleCompaction": false` 可關掉。它會讓 context 變小，所以這時不會碰到交接線。
- ctx-relay 不幫快取保溫：用 `$.model.fork` 送的請求讀不到主對話的快取（見「已知限制」），所以延長不了它。

## 交接檔格式

設定 `handoffFormat` 二選一：

| 格式 | 欄位 | 語言 |
| --- | --- | --- |
| `lite`（預設） | Goal、Files、Verified、Next | 標題與 fork 指示是英文；內文照對話語言寫 |
| `full` | 作者自己 handoff skill 的 8 欄（目標 + 最新指令、已改／將改檔、已驗證 vs 驗證缺口、dirty 無關項、下一步、關鍵細節備忘、硬約束 yaml、指標），加上來源交接檔的協調契約與 session 的 progress `INDEX.md` | 繁體中文 |

`full` 照作者自己環境的慣例，多數人用 `lite` 就好。notes pane 與待接手那行兩種格式都讀得懂，不看設定。

```bash
echo '{"handoffFormat": "full"}' | claude plugin configure ctx-relay@mango-mods --values-stdin
```

## 交接檔放哪裡
git repo：`<git-common-dir>/harness/handoff/`；非 git：`~/.claude/harness/<目錄名>-<sha256 前 8 碼>/handoff/`。
檔名：`<時間戳>-<slug>-<來源 session id 前 8 碼>-<批次號>.md`，同一秒的兩批或共用同一個 git-common-dir 的兩個 session 不會互相覆寫。
`full` 格式下，有 `<同一根目錄>/progress/<session id>/INDEX.md` 的話，會一起交給 fork 參考。

## 待接手（handoff-pickup）
![ctx-relay 待接手：有一份還沒人接手的交接檔，按 1 接續](../docs/assets/ctx-relay-pickup.png)

這行是 `󰯉 Pending handoff: <檔名> (2h ago, from 1f3a9c2e)`，旁邊是 `Resume [1]` 按鈕。還有其他沒接手的交接檔時，後面多一個 `+N`。

| 什麼時候 | 會發生什麼 |
|---|---|
| 新對話開場（啟動時對話還沒有任何訊息；`--resume` 接回的舊對話不算），或你手動 `/clear` 之後 | 找交接檔資料夾裡還沒人接手的交接檔，列最新一份；其他還沒接手的份數標在 `+N` |
| 提示框是空的時候按 1（或點按鈕） | 送出「Read <完整路徑> and continue from it; check the git state and the next step before acting.」（`full` 格式的檔案送中文版「讀 <完整路徑> 並依其接續執行；先確認 git 狀態與下一步再動手。」），這份記為已接手 |
| 主對話開始新回合（你送出訊息、按接續、排程） | 這行收掉 |

- 「已接手」記在 `<交接檔資料夾>/.picked/<交接檔檔名>`（空檔），交接檔本身不動。點開頭的資料夾，handoff skill 用 `ls -t` 找最新交接檔時看不到它。
- 這三種情況會記已接手：按接續；你送出的訊息含某份交接檔的完整路徑（手動貼上接續指令）；ctx-relay 自動交接（在 `/clear` 之前就記，新對話開場不會列它）。
- 第一次啟用時，ctx-relay 把當下時間記在自己的 store（`pickupSince`）：修改時間早於它的交接檔一律當作已接手，不會一裝好就列出一堆舊檔。
- 「多久前」依檔案的修改時間；「來自」取交接檔內文第一個 `session \`<id>\`` 的前 8 碼，讀不到就不顯示。
- 按 1 送出的訊息，來源會標成 ctx-relay（mod 代送，模型看到的是原文）。
- 待接手這行還在時，在空的提示框打「1」會按到接續，不會打進提示框。倒數的取消鈕也是 1，但倒數只會在回合結束後出現，那時待接手這行已經收掉，兩者不會同時在。
- 接續送出被擋（例如 settings 的 hook 拒絕）時，這行留著，也不記已接手。

## 指令
- `/ctx-relay-status`：顯示門檻、讀數、交接狀態、背景工作、快取 TTL（附判定來源）和剩餘時間，以及最近 3 次交接失敗。每次交接失敗（/clear 之前）都會追加到 `<harness root>/ctx-relay/failures.jsonl`（時間、自動或手動、token、你離開幾分鐘、原因；留最近 100 筆）
- `/ctx-relay-notes`：打開（再打一次關掉）一個確認先前狀態用的筆記 pane，內容取自這個對話接手的交接檔（沒有就拿 `handoff/` 最新一份），加上檔頭那個來源 session 的 `INDEX.md` 進度。自動交接後，終端夠寬時會自己打開一次（不搶輸入框焦點）；不夠寬就由 toast 提示指令。分兩頁：`s` 狀態頁（下一步、禁止事項、缺口，再來是目標、階段、改動檔案），`v` 證據頁（已驗證原文、交接檔來源）。只用一個強調色加灰字；紅黃綠只染 ✓ ▲ ✗ 這些符號。長字自動換行。pane 自己畫深色底，終端機透明背景下也一樣好讀。按 `q` 關閉。
- `/ctx-relay-now`：立刻交接；有背景工作在跑時要打 `/ctx-relay-now yes`。fork 指示、交接檔檔頭和新對話的接續訊息都寫明是 `/ctx-relay-now` 手動交接，不寫「越過自動交接線」
  - 後面可以接最新指令，例如 `/ctx-relay-now yes` 換行再打「做 B 並安裝新 mod」。第一個字是 `yes` 才算確定；其餘文字是指令。沒有背景工作時不用 `yes`，整段參數都算指令。
  - 指令原話會交給 fork 寫目標欄和下一步欄（`lite` 是 Goal／Next，`full` 是「目標 + 最新指令」和「下一步」），也原樣寫進交接檔檔頭和接續訊息（每行加 `> `，指令裡的 `## ` 不會變成交接檔的標題）。
  - 附了指令時，接續訊息請新對話核對完 git 狀態就照指令做，不再等你說一次。沒附指令時照舊：回報現況後等你指示。
  - 例外（只有 `full`）：交接檔缺「硬約束」（檔頭 `thin` 有「硬約束」）時，這個任務的限制可能沒寫進去，接續訊息改成先回報打算怎麼照指令做，等你確認再動手。

## 已知限制
- 背景工作不會逾時作廢：常駐 server 會讓交接延後到上限才強制倒數；要早點交接就用 `/ctx-relay-now yes`。
- 指令看到的背景工作是上一次主對話停下時的清單，加上當下在跑的子代理。
- 子代理可能同時出現在 Claude Code 的背景工作清單和子代理清單，延後原因的數字會多算。
- agent-bridge 送出、還沒回覆的任務偵測不到：`/clear` 前請自己確認。
- 跟 blast-radius 一起用、終端機窄到它把攔截框畫在 band 位置時（實測 80 欄會；200 欄它改用側邊窗格，不受影響），攔截期間 ctx-relay 這行可能看不到。按鈕照常可按，攔截結束 band 就回來。
  - 終端機高度至少 42 行才放得下兩者（2.1.289 實測，攔截框列 2 個檔案、共 11 行：41 行以下顯示「↓ 2 more」）。框裡列的檔案越多，需要的行數越多。
  - blast-radius 先畫時，它不把位置交給下一個 mod，多高都看不到。哪個 mod 先畫由載入順序決定，官方文件沒寫。
- 寫交接檔的花費約等於一輪冷快取。fork 讀不到主對話的快取：2.1.294 實測，回合結束 30 秒後送的 fork 命中 43%（只有共用的系統提示和工具定義），同時主對話下一輪命中 100%。
- 壓縮之後，band 上的 token 數仍是壓縮前的讀數，要到下一輪結束才更新。
- 交接內容由 fork 產生，機器檢查只看欄位有沒有空，不保證內容正確。新對話會被要求先用 git 核對。
- `/clear` 之後 `$.state` 會歸零；模組變數和計時器會保留（實測），所以 mod 在 clear 前會先取消計時器。
- 需要 PATH 上有 `bash` 和 `git`；非 git 目錄還要 `realpath`（GNU，支援 `-m`），以及 `sha256sum` 或 `shasum`。
- 交接檔路徑的演算法照抄 mango 的 dotfiles `hooks/_lib/harness-paths.sh`，讓兩邊的 handoff 檔放在同一處；改一邊要改另一邊。
