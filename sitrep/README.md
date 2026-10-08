# sitrep (P0 experiment)

Formerly named reply-lens. "Sitrep" is short for situation report.

> 繁體中文版：[README.zh-TW.md](README.zh-TW.md). The mod's on-screen text is
> in Traditional Chinese.

A Claude Code mod that makes replies easier to scan. This is a P0 experiment
and is not in the marketplace yet.

## What it does

- Appends a section to the system prompt asking the model to end the reply
  that hands control back to you with a ` ```ui-summary ` block: one line of
  JSON with a one-sentence outcome, the decisions waiting on you with their
  options, and the sections that can be collapsed.
- Hides that block when the reply is drawn and puts a rounded outcome box
  under the body, styled like your-turn's:
  - The first row inside is the status (`? 等你決定` decisions waiting,
    `> 等你動手` something for you to do by hand, `! 卡住` blocked,
    `~ 進行中` in progress, `✓ 完成` done) with the duration at the right.
    The status follows the one the model gave: a done or blocked reply stays
    green or red even with a `你要做` line; only a reply that stopped halfway
    to wait for you is `等你動手`. The border is a darker shade of the status color; only the two "waiting
    on you" states are yellow. The box has a fixed width (terminal width
    minus 4, at most 88 columns).
  - Then the one-sentence outcome in bold, and right under it `你要做`
    (what you have to do) in yellow.
  - The sections the model names (for example 變更 changes, 驗證 checks) are
    taken out of the body and become one summary line each inside the box
    (label a step lighter and bold, summary in bright text; `之後我` stays
    the dimmest);
    `▸` puts that section back in its place in the body. When there are
    decisions, a body section whose heading contains 決定 (for example
    `## 待你決定`) is folded the same way as `利弊` (pros and cons), so the
    questions are not written twice.
  - Decisions are listed inside the box. Clicking an option only fills
    "question. option" into the prompt box; nothing is sent. `之後我` (what
    the model does next) comes last, dim.
  - Once a newer reply has its own box, an older box folds to one line
    (`▸ ✓ outcome  8s`); `▸` draws the full box again.
- One row above the prompt: while questions are unanswered it reads
  `? N 題待決` with the first open question's number and options; focus the
  row and press an option's letter (`a`, `b`…), which fills the prompt box
  the same way. With no questions but something for you to do, it reads
  `等你動手：…` (suggestions in a done reply do not count). The row steps aside for a survey, stacks under other mods'
  rows (ctx-relay), and goes away once a newer reply has neither.
- For a turn without a block, the line that closes the turn (`Baked for 3s`)
  becomes a dim `– 本輪結束（無摘要）` ("turn ended, no summary").
- Replaces a collapsed subagent report row (`Message from @…`) with the
  report's first sentence.
- A background task's notification row (subagent, background shell…) starts
  with its status: dim `✓` completed, red `!` failed, dim `–` killed.
- Background subagents dispatched in a turn are listed in that turn's box
  (`⠋ Explore  description  執行中 42s`, the spinner and elapsed time tick
  every 250 ms while any subagent runs) and switch to `✓` with their run
  time when they finish; the engine's own rows stay as they are.
- A status pane (experimental, being redesigned): `/sitrep-pane` opens or
  closes it; it never opens by itself. Top to bottom: needs you (one tinted block
  per question; focus the pane and press an option's letter), running
  (subagents and background jobs with their run time), tasks (the step list the model adds to the summary block
  for multi-step work, ✓／▸／○),
  evidence (the latest verify summary as small tags, kept until the next one),
  changes (files this session edited with +/−; the rest folded into "not
  changed this time, N files"). While the pane is open, questions are
  answered there only: the row above the prompt is not drawn and each reply
  ends with a one-line conclusion instead of the box.
- An expanded subagent report drops the `[Subagent hand-back] …` framing
  written for the model; for a turn that dispatched background subagents,
  the engine's "Waiting for N background agents" line is not drawn (the box
  already lists them).
- An ASCII figure in a reply (a code block with no language, or `text`,
  holding box-drawing characters, arrows, or plain-ASCII `+--` / `|--`)
  is drawn on a gray background under a dim `圖` ("figure") label, so it stands out from the text around it.
- A ```dot block is drawn like an ASCII figure, its label adding rough node
  and edge counts. It is not rendered as a picture: Claude Code turns
  pictures off inside tmux, where this mod is used.
- While a reply is still streaming, an unfinished ui-summary block is hidden
  too, so its JSON does not flash on screen.
- Drawing only: the stored messages are unchanged.

Glyphs: `?` yellow = waiting on you, `>` yellow = for you to do, `!` red = blocked, `~` partly done,
`✓` done, `–` no summary.

## Try it

```bash
claude --plugin-dir ~/projects/mango-mods/sitrep
```

## Known limits

- The turn-closing line carries no turn id, so the "no summary" note is
  matched to `turn.complete` by duration (±3 s); two turns with close
  durations may swap. The engine may skip that line on short turns, which is
  why the outcome bar is drawn inside the reply.
- When tool calls split a reply into several blocks, the box is drawn under
  the block that holds the summary (usually the last one).
- ctrl+o does not show the original reply: an assistant row does not say
  whether it is drawn in the ctrl+o transcript, so the box is drawn there too.
  Use `▸` to put a collapsed section back.
- When the summary arrives at the end of a reply, the collapsed sections leave
  the body at once, so the body still shifts up once.
- The system-prompt section may also reach subagents; a block inside a
  subagent report is removed from its collapsed row.
- In focus mode (`/focus`) the engine hides background-task notification
  rows, so their status glyph is not shown there.

## Development

`claude plugin test .`, `npx -p typescript@5 tsc -p .`.
