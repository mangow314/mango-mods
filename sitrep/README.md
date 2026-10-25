# sitrep

A Claude Code mod that makes long replies easy to scan. "Sitrep" is short for
situation report.

> 繁體中文版：[README.zh-TW.md](README.zh-TW.md)

Long replies bury the part you need: did it work, and what does Claude want
from you? sitrep puts a box under each long reply with the status, a
one-line outcome, what you have to do, and the questions waiting on you,
which you answer from the keyboard. Every word in the box is copied from the
reply itself: a small model only picks line numbers, so the box cannot say
anything the reply did not.

## Labels and language

The mod's own labels (status, rows, pane titles) are English by default. Set
`language` to `zh-TW` for Traditional Chinese, from the sitrep row in
`/config` or from a shell:

```bash
echo '{"language": "zh-TW"}' | claude plugin configure sitrep@mango-mods --values-stdin
```

The text inside the box is always the reply's own text, so it follows the
language of your conversation.

## Core

- **Excerpt.** When a main-conversation reply is long (800+ characters
  outside code blocks) or has 2+ headings, after the turn ends sitrep numbers
  the reply's lines and asks `haiku` (low effort, 20 s limit) for line numbers
  only: the outcome line, questions with their option lines, what you have to
  do, what Claude does next, and the sections that can be collapsed. The mod
  checks every number and builds the box from those lines. An outcome or a
  question that is out of range or points at the wrong kind of line rejects
  the whole answer; a bad option, recommendation, `You do`, `Then I` or
  section number drops only that item. The
  system prompt is left alone.
  - Headings the mod recognizes override the model's numbers: the first line
    under a `Result`/`Summary`/`## 結果` heading is the outcome, consecutive
    `A.`/`B.` (or `選項 A：`) lines in a `Decisions`/`## 待你決定` section are
    a question's options (the line before them is the question; a later line
    saying "recommend"/`建議` marks the pick), and a Changes/Checks/Risks
    section's summary is the model's pick when it lies in that section,
    otherwise the section's first line. Status, `You do` and `Then I` still
    come from the model.
  - The box keeps only the outcome line's first sentence (up to the first
    `。！？`, or `.!?` followed by a space); the reply is unchanged. A lead-in
    ending in a colon (`Steps:`) or a table header is never the outcome or a
    section summary; the next line is used. A section whose summary repeats
    the outcome, a `You do`/`Then I` line or another summary stays in the
    body. `You do`/`Then I` pointing at a heading are dropped; a question
    pointing at a heading shows the heading text without `#`.
  - While it waits, the reply shows `… excerpting`; a failure shows
    `– excerpt failed: <reason>` where the box would be. If a new turn starts
    before the answer arrives, the excerpt is dropped.
- **The box** under the reply, with a dim `excerpt` tag in its title:
  - The title on the top border shows the status: `? Your call` (questions
    waiting), `> Your move` (something for you to do by hand), `! Blocked`,
    `~ In progress`, `✓ Done`, and the turn's duration on the right. A done or
    blocked reply keeps its color even with a `You do` line; only a reply
    that stopped halfway to wait for you is `Your move`. Only the two
    "waiting on you" states are yellow.
  - Then the outcome in bold, and right under it `You do` lines in yellow.
  - Sections the model picks (for example Changes, Checks) leave the body and
    become one summary line each, under a bold blue label; `▸` puts a section
    back in its place in the body. When there are questions, a section whose
    heading mentions a decision (`## Decisions`, `## 待你決定`) also leaves
    the body, so the questions are not written twice; its other lines (the
    pros and cons, why one is recommended) are shown in the box under the
    questions, with no `▸` to press.
  - Questions come next, one option per line, never cut short. Clicking an
    option only fills "question. option" into the prompt box; nothing is
    sent. A question asked without listed choices shows alone (answer by
    typing). A table row the model picks is shown with its cells joined by
    ` · `. `Then I` (what Claude does next) comes last, dim.
  - The outcome takes at most two lines and ends in `…` past that. Each `▸`
    section is one line, label and summary cut to the box width. A box
    estimated taller than 12 rows is split into sections after the outcome:
    `Risks` in red, `Needs you` in yellow (questions, `You do`), `Details` in
    blue (other sections, subagents, `Then I`), each under a divider joined
    to the border; an empty section is left out.
  - Once a newer reply has its own box, an older box folds to one line
    (`▸ ✓ outcome  8s`); `▸` draws it again.
  - Colors are Claude Code theme names (`warning`, `error`, `success`,
    `inactive`…), so they follow your `/theme`, light and daltonized
    included. The box is the terminal width minus 4, at most 88 columns.
- **The row above the prompt.** While questions are unanswered it reads
  `? N open` with the first open question's options. Focus the row
  (`Ctrl+X`, then `Tab`) and press an option's letter (`a`, `b`…); that fills
  the prompt box the same way. With no questions but something for you to
  do, it reads `Your move: …` (suggestions in a done reply do not count). It
  steps aside for a survey, stacks under other mods' rows (ctx-relay), and
  goes away once a newer reply has neither.
  While a turn runs and nothing waits on you, the same row is one dim line,
  `tool N · last <tool> <argument>` (for example `tool 4 · last Bash npm
  test`): main-conversation tool calls only, counted from 0 each turn. Elapsed
  time is left to Claude Code's own spinner line; tool rows are not hidden.
- **No silent turns.** For a turn without an excerpt (a short reply, a failed
  or dropped one), the line that closes the turn (`Baked for 3s`) becomes a
  dim `– turn ended (no excerpt)` or the failure reason.

Glyphs: `?` yellow = your call, `>` yellow = your move, `!` red = blocked,
`~` in progress, `✓` done, `–` no excerpt.

## Extras

- A collapsed subagent report row (`Message from @…`) shows the report's
  first sentence; expanded, it drops the `[Subagent hand-back] …` framing
  written for the model.
- A background task's notification row (subagent, background shell…) starts
  with its status: dim `✓` completed, red `!` failed, dim `–` killed.
- Background subagents dispatched in a turn are listed in that turn's box
  (`⠋ Explore  description  running 42s`, ticking every 250 ms) and switch to
  `✓` with their run time. For such a turn, the engine's "Waiting for N
  background agents" line is not drawn.
- sitrep draws no subagent list of its own. Claude Code already lists
  running subagents below the status line, in both fullscreen and the
  default renderer; set `subagentStatusLine` to change what each row shows.
- `/sitrep-pane` opens or closes a status pane (experimental): needs you
  (questions, answer with a letter), running (subagents and background jobs),
  tasks (the engine's task list), evidence (the latest checks as small tags),
  and changes (files this session edited, with +/−). While it is open,
  questions are answered there only: the row above the prompt is not drawn
  and each reply ends with a one-line outcome instead of the box.
- An ASCII figure in a reply (a code block with no language or `text`, where
  at least 2 lines, and at least 30% of the non-blank lines, carry
  box-drawing characters, arrows, or plain `+--` / `|--`) is drawn on a gray
  background under a dim `figure` label. A line with Chinese sentence
  punctuation or starting like a Markdown list item does not count, so
  prose that writes `A → B` stays a plain code block.
- A ```dot block is drawn the same way, its label adding rough node and edge
  counts. It is not rendered as a picture, since Claude Code turns pictures
  off inside tmux.
- Drawing only: the stored messages are unchanged.

## Try it

```bash
git clone https://github.com/mangow314/mango-mods
claude --plugin-dir ./mango-mods/sitrep
```

## Known limits

- Each long reply costs one extra `haiku` request, sent through your own
  Claude Code account.
- The excerpt only picks lines: an outcome the reply never states in one line
  cannot appear, and a decision not written as a question with option lines
  is not offered as buttons. An unanswered question from an earlier reply is
  not carried over unless the new reply repeats it. Which line the model
  calls the outcome, or "next", is its judgment and can be off.
- The turn-closing line carries no turn id, so the "no excerpt" note is
  matched to `turn.complete` by duration (±3 s); two turns with close
  durations may swap. The engine may skip that line on short turns, which is
  why the outcome bar is drawn inside the reply.
- The box is matched to the reply by a hash of its text. When tool calls
  split a reply into several blocks, the box sits under the last one. A reply
  too short for an excerpt gets no box, so subagents it dispatched show only
  in Claude Code's own list below the status line.
- ctrl+o does not show the original reply: an assistant row does not say
  whether it is drawn in the ctrl+o transcript, so the box is drawn there
  too. Use `▸` to put a collapsed section back.
- The excerpt arrives a few seconds after the reply, and the collapsed
  sections leave the body at that moment, so the body shifts up once.
- The box and the status pane record a subagent when `agent.spawn` returns an id; a
  workflow's remote agent has none and is not listed. A subagent whose
  `turn.complete` never arrives keeps spinning until the session ends.
- In focus mode (`/focus`) the engine hides background-task notification
  rows, so their status glyph is not shown there.
- Under a Team/Enterprise sign-in, Claude Code's built-in guard mod keeps
  `classic.*` events from user-installed mods, so the status pane has no
  source for background shells or the task list; its Running section says
  so in one line instead. Subagents are unaffected.

## Development

`claude plugin test .`, `npx -p typescript@5 tsc -p .`.
