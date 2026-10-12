# sitrep

Formerly named reply-lens. "Sitrep" is short for situation report.

> 繁體中文版：[README.zh-TW.md](README.zh-TW.md). The mod's on-screen labels
> are in Traditional Chinese; the text inside the box follows the language of
> the reply.

A Claude Code mod that makes replies easier to scan. Still an experiment;
install it from the marketplace with `claude plugin install sitrep@mango-mods`.

## What it does

- Leaves the system prompt alone. When a main-thread reply is long (800+
  characters outside code blocks) or has 2+ headings, after the turn ends it numbers the reply's
  lines and asks a small model (`haiku`, low effort, 20 s limit) for line
  numbers only: the outcome line, the decisions with their option lines, what
  you have to do, what comes next, and the sections that can be collapsed.
  The mod checks every number and builds the box from the reply's own lines,
  so the model cannot put words in it that the reply does not have. Any
  number out of range or pointing at the wrong kind of line rejects the whole
  answer. While it waits the reply shows `… 摘錄中` ("excerpting"); a failure
  shows `– 摘錄失敗：reason` in place of the box. If a new turn starts before
  the answer arrives, the excerpt is dropped.
- Puts a rounded outcome box under the body, titled with a dim `摘錄`
  ("excerpt"):
  - The title sits on the top border: the status (`? 等你決定` decisions waiting,
    `> 等你動手` something for you to do by hand, `! 卡住` blocked,
    `~ 進行中` in progress, `✓ 完成` done) with the duration at the right.
    The status follows the one the small model picked: a done or blocked reply stays
    green or red even with a `你要做` line; only a reply that stopped halfway
    to wait for you is `等你動手`. The border is a darker shade of the status color; only the two "waiting
    on you" states are yellow. All of sitrep's colors are Claude Code theme
    names (`warning`, `error`, `success`, `inactive`…), so they follow your
    `/theme`, light and daltonized included. The box has a fixed width (terminal width
    minus 4, at most 88 columns).
  - Then the one-sentence outcome in bold, and right under it `你要做`
    (what you have to do) in yellow.
  - The sections the small model picks (for example 變更 changes, 驗證 checks) are
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
  row (`Ctrl+X`, then `Tab`) and press an option's letter (`a`, `b`…), which fills the prompt box
  the same way. With no questions but something for you to do, it reads
  `等你動手：…` (suggestions in a done reply do not count). The row steps aside for a survey, stacks under other mods'
  rows (ctx-relay), and goes away once a newer reply has neither.
- For a turn without an excerpt (a short reply, a failed or dropped one), the
  line that closes the turn (`Baked for 3s`) becomes a dim
  `– 本輪結束（無摘錄）` ("turn ended, no excerpt") or the failure reason.
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
  (subagents and background jobs with their run time), tasks (the engine's task list, ✓／▸／○),
  evidence (the latest verify summary as small tags, kept until the next one),
  changes (files this session edited with +/−; the rest folded into "not
  changed this time, N files"). While the pane is open, questions are
  answered there only: the row above the prompt is not drawn and each reply
  ends with a one-line conclusion instead of the box.
- An expanded subagent report drops the `[Subagent hand-back] …` framing
  written for the model; for a turn that dispatched background subagents,
  the engine's "Waiting for N background agents" line is not drawn (the box
  already lists them).
- A subagent pane: `/agents-info` opens or closes it; it never opens by
  itself. A top line with the count, running count and total output tokens,
  then "running" and "ended" (latest 10). Each subagent gets two rows: status
  glyph (spinning while it runs), type, description and run time; then in
  grey its model, effort, context of its latest request, request count and
  output tokens. It lists every subagent, including ones a subagent or a
  workflow started. No cost or context percentage: the engine gives no
  per-model window or price. Where nothing can show a pane (a cloud
  session, `claude -p`), `/agents-info` replies with the same list as text
  instead. While subagents run and the pane is not shown, the line above the
  prompt adds `⠋ 子代理 2 個進行中 · 輸出 12k`, so in tmux (not fullscreen by
  default) you need not keep the pane open above the prompt.
- An ASCII figure in a reply (a code block with no language, or `text`,
  where at least 2 lines, and at least 30% of its non-blank lines, carry
  box-drawing characters, arrows, or plain-ASCII `+--` / `|--`; a line with
  Chinese sentence punctuation or starting like a Markdown list item does not
  count, so a handoff draft writing `A → B` stays a plain code block)
  is drawn on a gray background under a dim `圖` ("figure") label, so it stands out from the text around it.
- A ```dot block is drawn like an ASCII figure, its label adding rough node
  and edge counts. It is not rendered as a picture: Claude Code turns
  pictures off inside tmux, where this mod is used.
- Drawing only: the stored messages are unchanged.

Glyphs: `?` yellow = waiting on you, `>` yellow = for you to do, `!` red = blocked, `~` partly done,
`✓` done, `–` no excerpt.

## Try it

```bash
claude --plugin-dir ~/projects/mango-mods/sitrep
```

## Known limits

- The turn-closing line carries no turn id, so the "no excerpt" note is
  matched to `turn.complete` by duration (±3 s); two turns with close
  durations may swap. The engine may skip that line on short turns, which is
  why the outcome bar is drawn inside the reply.
- The box is matched to the reply by a hash of its text: `turn.complete`'s
  answer is the turn's final text, so when tool calls split a reply into
  several blocks the box sits under the last one. A reply too short for an
  excerpt gets no box, so subagents it dispatched show only in the line
  above the prompt and `/agents-info`.
- The excerpt only picks lines: an outcome the reply never states in one line
  cannot appear, and a decision the reply does not spell out as a question
  with option lines is not offered as buttons. An unanswered decision from
  an earlier reply is not carried over unless the new reply repeats it.
- Each long reply costs one extra `haiku` request.
- ctrl+o does not show the original reply: an assistant row does not say
  whether it is drawn in the ctrl+o transcript, so the box is drawn there too.
  Use `▸` to put a collapsed section back.
- When the excerpt arrives, a few seconds after the reply, the collapsed
  sections leave the body at once, so the body still shifts up once.
- `/agents-info` records a subagent when `agent.spawn` returns an id; a
  workflow's remote agent has none and is not listed. A subagent whose
  `turn.complete` never arrives keeps spinning until the session ends.
- In focus mode (`/focus`) the engine hides background-task notification
  rows, so their status glyph is not shown there.

## Development

`claude plugin test .`, `npx -p typescript@5 tsc -p .`.
