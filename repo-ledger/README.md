# repo-ledger

一個 Claude Code mod，在提示框上方顯示一行：這個對話動過、還沒 commit 的 repo。
跨好幾個 repo 工作時（例如 chezmoi、vault、mango-mods 一起改），叫 agent commit 之前看一眼就知道還有哪裡沒收。

實機測試過的版本：Claude Code 2.1.289（0.1.0，用 `--plugin-dir` 載入；測過兩個 repo 各改一個檔、其中一個 commit 後變打勾、和 ctx-relay 同時顯示）。mods API 還在 early access，改版後可能要跟著調整。

## band
![repo-ledger band 實機畫面（上面那行；下面那行是 ctx-relay）](../docs/assets/bands.png)

Claude Code 2.1.290 實機截圖，上面那行是 repo-ledger：`demo-app(main) 1 · 本輪 2 檔`。動過好幾個 repo 時排成一行，例如 `repoA(master) 1 · repoB(master) ✓ · 本輪 2 檔`。

- 每個 repo 顯示 `名稱(分支)`，後面是未 commit 的檔案數（含未追蹤的檔，橘色）；乾淨的顯示灰色打勾。
- `↑N`：還沒 push 的 commit 數。`⎇N`：這個 repo 另外開的 worktree 數。
- `本輪 N 檔`：你上次送出訊息以來，Edit／Write 過的 repo 內檔案數；超過 5 檔變橘色，改太多時早點看到。
- 沒有未 commit 的檔、本輪也沒改檔時，整行不畫。只剩未 push 的 commit 不會讓這行留著。
- 別的 mod 也畫 band 時（例如 ctx-relay），兩行上下疊在一起。誰在上由載入順序決定：上圖四個 mod 一起用 `--plugin-dir` 載入時，repo-ledger 在上。
- 圖示要 Nerd Font，沒有的話開頭會是方框。

## 追蹤哪些 repo
- Edit／Write／NotebookEdit 改到的檔案所在的 repo。scratchpad 這類不在 repo 裡的檔案不算。
- Bash 指令裡 `cd`、`pushd`、`git -C` 後面的字面路徑（`~/` 開頭的也認）。
- Bash 沒有 `cd`／`git -C` 就跑 `git` 時，算 session 的工作目錄。
- 工作目錄不會一開場就列：對話動到它之前，裡面原有的改動不顯示。動到之後，整個 repo 的未 commit 數都會算進來（包括對話開始前就有的）。

## 什麼時候更新
每輪結束、Bash 跑過含 `git` 的指令之後、第一次碰到新 repo 時。

## 已知限制
- 只認字面路徑：`S=/x; cd "$S"`、`git -C "$(…)"` 這類看不穿，不會追蹤。
- Bash 用 `sed -i`、腳本之類改的檔不算進「本輪 N 檔」；repo 已在追蹤中的話，下次重算時會算進未 commit 數。
- heredoc 或 commit 訊息裡出現 `cd 某個 repo` 字樣，也可能把那個 repo 加進來（多一格，不影響其他格）。
- 名稱用 repo 根目錄的最後一段：`~/.local/share/chezmoi` 顯示 `chezmoi`，vault 顯示資料夾名。
- `/clear` 之後追蹤清單保留；hot reload 之後由 `$.state` 讀回。這兩條還沒有實機測過。
- 需要 PATH 上有 `git`。

## 風險
- mod 會在追蹤中的 repo 裡自動跑 `git status`、`git worktree list`，repo 自己 `.git/config` 裡的設定會跟著生效。對話只是 cd 進一個外來的 repo，也會觸發。
- `core.fsmonitor` 已擋：每次 `git status` 都帶 `-c core.fsmonitor=false`，repo 設的 fsmonitor 指令不會執行。
- 其他會執行指令的設定沒有擋。例如 `filter.<名稱>.clean`：`git status` 比對檔案內容時可能會執行它（推測，沒有實測）。只在你信任的 repo 裡用。
