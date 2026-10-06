# away-receipt

> English: [README.md](README.md)。這份是它的繁體中文對譯。

一個 Claude Code mod：你放著讓 Claude 跑、離開一段時間回來時，對話旁的 pane 列出離開期間發生了什麼。
不用再問「我離開時你做了什麼」：多久、跑了幾輪、花多少，動過哪些 repo、測試過了沒、背景工作有沒有失敗，一張收據看完。
mod 只跑 git 查狀態，不代跑其他指令。

實機測過的版本：Claude Code 2.1.289（0.1.0，用 `--plugin-dir` 載入；在 160 欄的 tmux 測過 `/receipt` 打開、新 commit、未 commit 檔、`make test` 失敗 exit 2 標紅、`claude plugin test` exit 0、背景 shell 完成、按 q 關掉、再打 `/receipt` 紀錄還在；送出訊息 22 分鐘後打一個字自動打開、焦點留在提示框、關掉後清空草稿重打不再打開；0.2.0 測過按 1 把失敗的 `make test` 填進提示框、收據關掉、接著打字進提示框）。mods API 還在 early access，改版後可能要跟著調整。

## pane
![away-receipt 實機畫面：新 commit、未 commit 檔、一個失敗一個通過的測試](../docs/assets/away-receipt.png)

Claude Code 2.1.290 實機截圖：這段時間 1 個新 commit、1 個未 commit 檔，`make test` 失敗、`npm test` 通過。有背景工作時，驗證段下面還會多一段「背景工作」；有別的 worktree 時，repo 段多一行 `⎇ <路徑> (<分支>)`。

- 第一行：離開多久（從你上次送出訊息算起）、這段時間主對話跑了幾輪（子代理的不算）、花了多少（session 累計花費的差額）。
- 每個動過的 repo 一段：分支、離開期間的新 commit（短 hash＋標題）、還沒 commit 的檔（`git status --porcelain` 原樣）、別的 worktree。新 commit、未 commit 檔各最多列 10 條，其餘寫「還有 N 個」。repo 乾淨又沒有新 commit 時只畫一行「✓ 沒有新 commit、沒有未 commit 檔」。
- 驗證：跑過的測試指令和 exit code。同一條指令跑好幾次只列一行，exit code 是最後一次的，後面標 `×N`。失敗的紅色。
- 背景工作：做完或失敗的子代理和背景 shell，照通知裡的摘要。不是 completed 的紅色，後面標狀態。
- 三段都沒東西時寫「這段時間沒有動到 repo、沒跑測試、沒有背景工作」。
- 配色沿用 ctx-relay：repo 名天藍 `#56B4E9`、commit hash 橘 `#E69F00`、說明灰 `#7d8794`；失敗用同一組色盲友善色的 vermillion `#D55E00`。

## 什麼時候打開
- 你上次送出訊息超過 20 分鐘，回來在提示框打第一個字（草稿從空變成有字，打字或貼上都算）時自動打開。同一次離開只自動開一次。開了 Claude 還沒送出過任何訊息就放著，回來打字不會自動打開。
- 自動打開不搶焦點，你可以繼續打字。
- `/receipt`：隨時打開，任何寬度都畫。
- 關掉：pane 有焦點時按 `q` 或 ctrl+x x。用 `/receipt` 打開時 pane 就有焦點；自動打開時焦點留在提示框，要先 ctrl+x tab 切過來（焦點在提示框時 ctrl+x x 關不掉，2026-10-05 實測）。
- 收據是打開那一刻算好的；之後你送出訊息、Claude 繼續跑，pane 上的內容都不變，下次打開才重算。

## 按失敗的測試
- 驗證段裡失敗的測試是按鈕：pane 有焦點時按數字鍵（前 9 條，`1: ✗` 的那個數字），或用滑鼠點 ✗。
- 按下後把「`<指令>` 失敗（exit N），幫我找出原因並修好。」填進提示框，並關掉收據，焦點回到提示框，按 Enter 就送出（2026-10-05 實測）。
- 提示框是空的就直接放；已經有字時接在下一行，不蓋掉你打的。
- 提示框收不到字時（例如有對話框開著）跳 toast，收據不關。

## 怎麼算「離開」
- 從你自己送出訊息（提示框，或 Remote Control）的那一刻算起，到打開收據為止。
- plugin 代你送出的（ctx-relay 接續、your-turn 回報）、背景工作的通知、排程觸發，都不算你回來。
- 打 `/receipt` 不算送出訊息，紀錄不會重來。
- 離開期間的紀錄存在 mod 的模組變數：/clear 之後還在，ctx-relay 自動 /clear 接續時不會斷。mod 重新載入（hot reload、重開 Claude）就從頭算。

## 哪些算
- 動過的 repo（同 repo-ledger 的認法，主對話和子代理都算）：Edit／Write／NotebookEdit 的檔案所在 repo；Bash 指令裡 `cd`／`pushd`／`git -C` 後面的字面路徑（帶 `$` 或反引號的看不穿，不認）；沒有 cd 就跑 git 時的工作目錄。
- 測試指令：Bash 指令裡出現 `npm`／`pnpm`／`yarn`／`bun`／`deno`／`cargo`／`go`／`make`／`just`／`mix`／`dotnet`／`gradle`／`mvn`／`swift`／`zig` 接 `test`（中間可以有 `run`），或 `pytest`、`unittest`、`bats`、`jest`、`vitest`、`mocha`、`prove`、`rspec`、`phpunit`、`ctest`、`tox`、`tsc`、`claude plugin test`、`claude plugin validate`。shell 的 `test -f` 不算。丟到背景跑的看不到結束，改列在背景工作。只列指令第一行。
- exit code：成功是 0；Bash 回報錯誤時取錯誤文字裡的 `Exit code N`，看不出幾號時顯示 `exit ?`。
- 背景工作：背景工作結束時 Claude Code 送來的通知（`<task-notification>`）裡的 `<status>` 和 `<summary>`。

## 已知限制
- 新 commit 用 `git log --since` 照 commit 時間篩：離開期間 rebase、cherry-pick 或時間不準的 commit 可能多列或漏列。
- 花費是 session 累計花費的差額；/clear 如果讓累計歸零，就從歸零後重新累加（沒實測 /clear 會不會歸零）。
- 自動打開屬於主動打開：終端機要 144 欄以上才畫出來（用 `/receipt` 開過一次、之後沒手動關掉的話降到 110 欄）。不夠寬時 pane 等著不畫，改跳 toast 提示打 `/receipt`。
- 回來打第一個字時才跑 git：動過的 repo 多時，第一個字可能慢一點。
- 一行太長就截斷。
