# xv-band

> 繁體中文版：[README.zh-TW.md](README.zh-TW.md)

A Claude Code mod that draws a band above the prompt with the live status of
`xv` cross-vendor jobs (xvendor's `codex exec` / `agy -p` jobs).

Early access: useful only with
[xvendor](https://github.com/mangow314/xvendor), the author's cross-vendor
review tool. The band's activity words are in Traditional Chinese.

## What it does

- Every 2 seconds it lists `${XV_DATA:-$HOME/.local/share/xvendor}/jobs/`,
  stats each `meta.json` (re-reads it only when its mtime changed), and for a
  running job reads the tail of the current round's `events.jsonl`: the whole
  file when it is at most 16 KB, otherwise the last 16 KB through
  `tail -c 16384` (`$.fs.read` has no offset). It never writes there.
- One line per job that is `running` or finished within the last 10 minutes
  (by `meta.json` mtime), at most 5: every running job first (newest first),
  then at most 2 of the newest finished; the remaining finished jobs fold into
  one line. With no such job the band draws nothing.

  ```
  / codex        4553 r1  running 12m03s  執行 rg -n foo src
  - agy          d266 r2  running 45s     撰寫回答
    codex:local  c2bc r2  done    6s
    另有 3 個已完成（xv list）
  ```

  `<spinner> <vendor>[:<profile>]  <id suffix> r<round>  <status> <elapsed>  <last activity>`,
  columns aligned. The spinner (`| / - \`) turns on running lines only. Status
  is `meta.json`'s own word (running / done / failed / timeout / stopped). The id suffix is the
  job id's last 4 characters; `xv` accepts it in place of the full id. Elapsed is
  now − `round_started` while running, `secs` once finished (`-` when missing).
  Last activity (running only, cut to the band's width): codex's latest command
  (`執行 <cmd>`, with a `/bin/bash -lc '…'` wrapper removed) or the first line of
  its latest agent message (`回報 …`); agy's latest tool (`工具 <tool_name>`) or
  `撰寫回答` while it streams a response.
- Colors: vendor bold (codex green, agy blue), status yellow while running,
  red for failed / timeout, grey for stopped; finished-and-done lines and the last
  activity are dim.
- A partial last line, a missing or corrupt job directory, or a failed read is
  skipped; the mod never throws. It steps aside for a survey and stacks under
  other mods' rows (ctx-relay, sitrep).

## Try it

```bash
git clone https://github.com/mangow314/mango-mods
claude --plugin-dir ./mango-mods/xv-band
```

## Known limits

- A job whose `xv` process died without updating `meta.json` stays `running`
  on the band; the mod does not check `run_pid`.
- The directory is scanned every 2 seconds even when nothing is running (one
  `stat` per job), so a new job shows within 2 seconds; with hundreds of old
  job directories, prune them.
- Agent message text is shown as written (CJK counts as two columns when
  cutting); the band's own decorations are ASCII.
