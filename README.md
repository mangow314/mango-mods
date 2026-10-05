# mango-mods

這個 Claude Code marketplace 收我自己用的 mods。mod 就是用 JS/TS function hooks 寫成的 plugin。
結構和官方 [claude-code-playground/claude-code/mods](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods) 一樣，每個 plugin 一個目錄。

| plugin | 用途 |
|---|---|
| [ctx-relay](ctx-relay/README.md) | 顯示每輪花費與剩餘空間；越過自動交接線時自動產生交接檔，然後 /clear 接續 |
| [repo-ledger](repo-ledger/README.md) | 列出這個對話動過、還沒 commit 的 repo（分支、未 commit 檔數、未 push、別的 worktree）和本輪改了幾檔 |
| [your-turn](your-turn/README.md) | 把回覆裡要你親手跑的指令（sudo、`! <cmd>`）列成對話旁可勾選的清單，全部完成後一鍵回報 |

## 開發與發布
- 開發時直接載入目錄，不要用已安裝的副本，因為已安裝的 plugin 會按版本快取：
  `claude --plugin-dir ~/projects/mango-mods/<plugin>`
- 檢查：在 plugin 目錄裡跑 `claude plugin validate .`、`claude plugin test .`、`npx -p typescript@5 tsc -p .`。
  tsc 需要先載入一次 mod，引擎才會產生 `.claude-plugin/types/`，這個目錄不進版控。
- 發布：先調高該 plugin `plugin.json` 的 `version`，然後 commit、push，再跑 `claude plugin marketplace update mango-mods`，最後更新已安裝的版本。
- 安裝任何 mod 前，先看 `claude plugin validate --json` 列出的 hooks 和 calls 清單（安裝閘見 `~/.claude/rules/safety.md`）。

## 授權
[MIT](LICENSE)，涵蓋這個 repo 裡所有 plugin。
