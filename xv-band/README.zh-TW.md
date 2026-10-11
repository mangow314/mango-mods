# xv-band

> English: [README.md](README.md)

在 Claude Code 提示框上方畫一條 band，即時顯示 `xv` 跨廠 job（xvendor skill 開的 `codex exec`／`agy -p` job）的狀態。

## 做什麼

- 每 2 秒列一次 `${XV_DATA:-$HOME/.local/share/xvendor}/jobs/`，逐一 stat `meta.json`（mtime 變了才重讀）；執行中的 job 只讀當前輪次 `events.jsonl` 的尾端：檔案 16 KB 以內整個讀，超過就用 `tail -c 16384` 只拿最後 16 KB（`$.fs.read` 沒有 offset）。從不寫進那個目錄。
- 每個 `running`、或 10 分鐘內結束（看 `meta.json` mtime）的 job 一行，最多 5 行：執行中的全部在前（新的在上），結束的只畫最新 2 個，其餘收成一行。沒有這種 job 時整條 band 不畫。

  ```
  / codex        4553 r1  running 12m03s  執行 rg -n foo src
  - agy          d266 r2  running 45s     撰寫回答
    codex:local  c2bc r2  done    6s
    另有 3 個已完成（xv list）
  ```

  格式 `<轉圈> <廠商>[:<profile>]  <id 尾碼> r<輪次>  <狀態> <耗時>  <最近動作>`，各欄對齊。轉圈（`| / - \`）只在執行中的行出現。狀態直接用 `meta.json` 的原字（running／done／failed／timeout／stopped）。尾碼是 job id 最後 4 個字元，`xv` 各指令可直接用它代替完整 id。耗時：執行中是現在 − `round_started`，結束後是 `secs`（缺值顯示 `-`）。最近動作（只有執行中才有，依 band 寬度截斷）：codex 是最近的指令（`執行 <cmd>`，拿掉 `/bin/bash -lc '…'` 外殼）或最近一則 agent message 的第一行（`回報 …`）；agy 是最近的工具（`工具 <tool_name>`），正在串流回覆時是 `撰寫回答`。
- 顏色：廠商粗體（codex 綠、agy 藍），狀態 running 黃、failed／timeout 紅、stopped 灰；完成的行和最近動作變淡。
- 寫到一半的最後一行、缺檔或壞掉的 job 目錄、讀取失敗都直接略過，不會丟例外。有 survey 時讓位；跟其他 mod 的列（ctx-relay、sitrep）疊著畫。

## 試用

```bash
claude --plugin-dir ~/projects/mango-mods/xv-band
```

## 已知限制

- `xv` 行程死掉卻沒更新 `meta.json` 的 job 會一直顯示 `running`；mod 不檢查 `run_pid`。
- 沒有 job 在跑時也每 2 秒掃一次目錄（每個 job 一次 stat），所以新 job 2 秒內就會出現；舊 job 目錄累積到上百個時請清掉。
- agent message 原文照畫（截斷時中日韓字算 2 欄）；band 自己的裝飾字元全是 ASCII。
