# away-receipt

> 繁體中文版：[README.zh-TW.md](README.zh-TW.md). The mod's on-screen text is
> in Traditional Chinese.

A Claude Code mod for when you leave Claude running and come back a while
later: a pane beside the conversation lists what happened while you were away.
No more asking "what did you do while I was gone": how long, how many turns,
the cost, which repos were touched, whether tests passed, whether background
work failed — all on one receipt.
The mod only runs git to read state; it never runs other commands for you.

Tested on: Claude Code 2.1.289 (0.1.0, loaded with `--plugin-dir`; tested in a
160-column tmux: opening with `/receipt`, new commits, uncommitted files, a
failing `make test` with exit 2 in red, `claude plugin test` with exit 0, a
finished background shell, closing with `q`, and the record still there on the
next `/receipt`; typing a character 22 minutes after sending a message opened
it automatically with focus left in the prompt, and after closing it, clearing
the draft and typing again did not reopen it; 0.2.0 was tested pressing 1 to
put the failed `make test` into the prompt, the receipt closing, and typing on
into the prompt). The mods API is still in early access, so a Claude Code
release may require changes.

## The pane

![away-receipt in a live session: a new commit, an uncommitted file, one failing and one passing test](../docs/assets/away-receipt.png)

A live Claude Code 2.1.290 session: in this stretch, 1 new commit and 1
uncommitted file; `make test` failed and `npm test` passed. With background
work there is also a 背景工作 ("background work") section below 驗證
("verification"); with other worktrees, the repo section gets a
`⎇ <path> (<branch>)` line.

- First line: how long you were away (since you last sent a message), how many
  turns the main conversation ran in that time (subagent turns excluded), and
  what it cost (the difference in the session's cumulative cost).
- One section per touched repo: branch, new commits while you were away (short
  hash + subject), uncommitted files (`git status --porcelain` as is), other
  worktrees. At most 10 new commits and 10 uncommitted files are listed; the
  rest become "還有 N 個" ("N more"). A clean repo with no new commits gets a
  single line, "✓ 沒有新 commit、沒有未 commit 檔" ("no new commits, no
  uncommitted files").
- Verification: test commands that ran and their exit codes. A command that
  ran several times is listed once, with the last exit code and `×N`. Failures
  are red.
- Background work: subagents and background shells that finished or failed,
  using the summary from the notification. Anything not completed is red, with
  its status.
- When all three sections are empty: "這段時間沒有動到 repo、沒跑測試、沒有背景工作"
  ("no repos touched, no tests run, no background work in this time").
- Colors follow ctx-relay: repo names sky blue `#56B4E9`, commit hashes orange
  `#E69F00`, notes gray `#7d8794`; failures use vermillion `#D55E00` from the
  same color-blind-friendly palette.

## When it opens

- If you last sent a message more than 20 minutes ago, it opens automatically
  when you come back and type the first character into the prompt (the draft
  going from empty to non-empty; typing or pasting both count). It opens
  automatically only once per absence. If you start Claude and leave without
  ever sending a message, typing on your return does not open it.
- Automatic opening does not steal focus; you can keep typing.
- `/receipt`: opens it at any time, drawn at any width.
- Closing: press `q` or ctrl+x x while the pane has focus. Opened with
  `/receipt`, the pane has focus; opened automatically, focus stays in the
  prompt, so switch over with ctrl+x tab first (with focus in the prompt,
  ctrl+x x does not close it, measured 2026-10-05).
- The receipt is computed when it opens; if you then send messages and Claude
  keeps working, the pane does not change until the next time it opens.

## Pressing a failed test

- In the verification section, failed tests are buttons: with the pane
  focused, press the number key (the first 9; the number in `1: ✗`) or click
  the ✗.
- This puts "`<command>` 失敗（exit N），幫我找出原因並修好。" ("`<command>` failed
  (exit N); find the cause and fix it.") into the prompt, closes the receipt,
  and returns focus to the prompt; press Enter to send (measured 2026-10-05).
- An empty prompt gets it as is; if there is already text, it goes on the next
  line without overwriting what you typed.
- If the prompt cannot take the text (for example a dialog is open), a toast
  appears and the receipt stays open.

## What counts as "away"

- From the moment you yourself send a message (from the prompt, or Remote
  Control) until the receipt opens.
- Messages a plugin sends for you (ctx-relay's resume, your-turn's report),
  background-work notifications, and scheduled triggers do not count as you
  coming back.
- Typing `/receipt` is not sending a message, so the record does not restart.
- The record lives in the mod's module variables: it survives `/clear`, so a
  ctx-relay automatic `/clear` handoff does not break it. Reloading the mod
  (hot reload, restarting Claude) starts over.

## What counts

- Touched repos (recognized the same way as repo-ledger, in both the main
  conversation and subagents): the repo of any file changed with Edit / Write
  / NotebookEdit; literal paths after `cd` / `pushd` / `git -C` in Bash
  commands (anything with `$` or backticks cannot be seen through and is
  ignored); the working directory when git runs without a `cd`.
- Test commands: a Bash command containing `npm` / `pnpm` / `yarn` / `bun` /
  `deno` / `cargo` / `go` / `make` / `just` / `mix` / `dotnet` / `gradle` /
  `mvn` / `swift` / `zig` followed by `test` (optionally with `run` in
  between), or `pytest`, `unittest`, `bats`, `jest`, `vitest`, `mocha`,
  `prove`, `rspec`, `phpunit`, `ctest`, `tox`, `tsc`, `claude plugin test`,
  `claude plugin validate`. The shell's `test -f` does not count. Commands sent
  to the background have no visible end and are listed under background work
  instead. Only the command's first line is shown.
- Exit code: 0 on success; when Bash reports an error, the `Exit code N` in the
  error text; `exit ?` when the number cannot be found.
- Background work: `<status>` and `<summary>` from the notification
  (`<task-notification>`) Claude Code sends when background work ends.

## Known limits

- New commits are filtered by commit time with `git log --since`: a rebase,
  cherry-pick, or a commit with a wrong clock during your absence may be listed
  extra or missed.
- The cost is the difference in the session's cumulative cost; if `/clear`
  resets the total, it accumulates again from the reset (whether `/clear`
  resets it has not been tested).
- Automatic opening is a proactive open: the terminal must be at least 144
  columns wide for it to draw (110 once you have opened it with `/receipt` and
  not closed it by hand since). When narrower, the pane waits undrawn and a
  toast suggests typing `/receipt`.
- git runs only when you type the first character on your return: with many
  touched repos, that first character may lag a little.
- Long lines are truncated.
