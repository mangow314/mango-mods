# ctx-relay

> 繁體中文版：[README.zh-TW.md](README.zh-TW.md). The band and commands are in
> English. Handoff files use English headings with the body in the
> conversation's language; the optional `full` format is in Traditional
> Chinese (see "Handoff file format").

It needs no other skill or hook: the mod writes the handoff file itself.

A Claude Code mod for handing off: when the main conversation crosses the
automatic handoff line, it writes a structured handoff file, runs `/clear`,
and resumes in the new conversation. When a new conversation starts and there
is a handoff file nobody has picked up, it offers to resume it; press 1.

It does not show context usage: use your status line for that. The band above
the prompt appears only while there is something to do or know about a
handoff (countdown, deferral, writing, failure, resume, pending pickup), so an
idle session costs no redraws.

Tested on Claude Code 2.1.289 to 2.1.296. The mods API is still in early
access, so a Claude Code release may require changes.

## What it does

| When | What happens |
| --- | --- |
| A main-conversation turn ends (not interrupted) with context ≥ the handoff line | If Claude Code reports background work (shells, subagents, monitors, workflows, …) or a one-shot scheduled task, the handoff is deferred and the band shows why; recurring schedules do not block it. Otherwise a 60-second countdown starts. Signed in with a Team or Enterprise plan, Claude Code's built-in guard keeps the Stop report from user mods, so only running subagents defer it |
| While deferred, context reaches the cap (halfway between the handoff line and the compaction point) | The countdown runs anyway; the handoff file header lists the work still running (its completion notice may never arrive) |
| Another Stop hook blocks the stop (the turn has not really ended) | No decision; wait for the stop that really ends the turn |
| During the countdown | Press Cancel (hotkey 1) to cancel; for the rest of this conversation it only reminds you. Sending any message only postpones it: if you are still past the line when that turn ends, the countdown starts again |
| A new turn starts during the countdown or preparation (a schedule, a background notification, a message from another session) | This switch is dropped; it decides again when the turn ends |
| The main conversation is compacted (`/compact`, auto-compact, idle compaction) during a countdown, preparation or deferral | Dropped: the context is small again; it decides again when the next turn ends |
| The countdown ends | The mod collects git state → `$.model.fork` fills in only the body of each field, one `=== KEY ===` line per field (gives up after 3 minutes without an answer) → the mod assembles the handoff file under its own hard-coded `## ` headings, so the model has no chance to mistype a heading → machine check (a missing field is marked `thin:`; no section marker at all counts as a failure) → write the file and read it back → confirm the conversation has not changed → `/clear` → send the handoff file path and the pickup rules in the new conversation |
| Any step fails before `/clear` | Stays in the original conversation, the band shows why, no retry |

In the `full` format, the mod appends the coordination contract verbatim, without the model: a
`=== CONTRACT ===` section written by the fork, and any `## 協調契約`
("coordination contract") section in its body, are always dropped. Any other
`## ` line in the fork's body is demoted to `### `, so the only second-level
headings in a handoff file are the mod's own. A section whose key is mistyped
(for example `=== VERIFED ===`): that field is marked `thin:`, and its body is
kept, appended at the end of Next (`full`: 關鍵細節備忘, "key details") with a note. A
` ```ui-summary ` block in the fork's output (written by sitrep versions
before 0.3.0) is removed.

## Thresholds

- Compaction point: the auto-compact trigger Claude Code reports itself
  (`autoCompactThreshold` from `$.session.usage({ breakdown })`). With
  auto-compact off, the model's context window is used instead.
- Handoff line: the `handoffTokens` setting if set; if not (0), 85% of the
  compaction point. A setting above 85% of the compaction point (for example
  after switching to a 200K model) falls back to 85%, and
  `/ctx-relay-status` says so.
- Deferral cap: with background work, the handoff can be deferred at most to
  halfway between the handoff line and the compaction point.

Set the handoff line from the ctx-relay row in `/config`, or from a shell:

```bash
echo '{"handoffTokens": "400000"}' | claude plugin configure ctx-relay@mango-mods --values-stdin
```

A setting changed from the shell takes effect after restarting Claude Code or
running `/reload-plugins` in the session. For end-to-end tests you can set it
very low (for example 1).

Note: with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` set, the compaction point Claude
Code reports may not apply that percentage. Measured on 2.1.288: with
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=600000` and
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=88`, it reported 567,000 (=600,000−33,000).
Measured on 2.1.289 with a 120,000 window: it reported 87,000, and compaction
happened on the turn where context grew from 86,412 to 88,335; both the
reported value and (120,000−20,000)×88% = 88,000 fall in that range, so it is
impossible to tell which is right. With a 600K window the real compaction point
may still be 510K, 528K, or 567K. If you use this environment variable, set
`handoffTokens`.

When loaded with `claude --plugin-dir`, the installed copy's `handoffTokens`
is not read, so the handoff line is the automatic value.

## The band

The band is empty unless a handoff needs you. Its lines:

- Countdown: `󰚌 Handoff in 42s · at 400K · send a message to postpone`, with
  a `Cancel [1]` button.
- `Handoff deferred: <reason>`, `Writing handoff file…`,
  `Auto handoff failed: <reason>. Hand off manually`, or
  `Auto handoff cancelled (…; reminders only)`.
- After a handoff (automatic, or `Resume [1]` on a pending one):
  `Resumed from <file> · next: <first line of the next-step field>`, until
  you type. An automatic handoff also shows a toast with the file's path.
- If `/clear` succeeded but the resume message could not be sent:
  `Cleared, but <reason>. Type: Read <path> and continue from it`. The part
  after "Type:" is what you paste into the conversation; with the `full`
  format it is in Chinese (`讀 <path> 並依其接續`). This line stays until you
  clear again.
- `Pending handoff: <file> (5m ago)` with a `Resume [1]` button; see "Waiting
  to be picked up".

- Text colors use Claude Code theme names (`text`, `inactive`, `warning`,
  `error`…), so they follow your `/theme`, light and daltonized included.
- When another mod also draws a band, its content goes on top and the
  ctx-relay line below. When there is not enough height, or the other mod does
  not give way, the ctx-relay line can be hidden; see "Known limits".
- The icons need a Nerd Font, for example Symbols Nerd Font as a fallback;
  without one they render as boxes.

## Handoff file format

The `handoffFormat` setting picks one of two formats:

| Format | Fields | Language |
| --- | --- | --- |
| `lite` (default) | Goal, Files, Verified, Next | English headings and instructions; the fork writes the body in the conversation's language |
| `full` | Author-specific: the 8 fields of the author's own handoff format (goal + latest instruction, files, verified vs gaps, unrelated dirty files, next step, key details, hard constraints as YAML, pointers), plus the source handoff file's coordination contract and the session's progress `INDEX.md` | Traditional Chinese |

`full` follows conventions from the author's own setup; most people want
`lite`. The pickup line reads either format, whatever the setting says.

Both formats:

- Each line under Verified starts with `Verified:` (checked, with the result
  seen), `Unconfirmed:` (done, but the result was never seen, for example the
  last tool call had not returned), `Gap:` (not done yet) or `Failed:` (tried
  and did not work, and why). When there is an `Unconfirmed:` item, Next starts
  by checking it. The resume message tells the new conversation that
  `Unconfirmed:` and `Gap:` items are not done and not to retry what `Failed:`
  lists without a new reason.
- The header quotes your last 3 messages verbatim (oldest first, up to 600
  characters each), taken from the transcript by the mod, not rewritten by the
  fork. Tool results and messages the system inserted (they start with `<`)
  are skipped.

```bash
echo '{"handoffFormat": "full"}' | claude plugin configure ctx-relay@mango-mods --values-stdin
```

## Where handoff files go

In a git repo: `<git-common-dir>/harness/handoff/` (inside `.git`, so never
committed; delete the folder to clean up); outside git:
`~/.claude/harness/<directory name>-<first 8 chars of sha256>/handoff/`. The
folder above `handoff/` is called the harness root below.
File name: `<timestamp>-<slug>-<first 8 chars of the source session id>-<batch number>.md`,
so two batches in the same second, or two sessions sharing one
git-common-dir, never overwrite each other.
The header records HEAD at handoff time (`git rev-parse --short HEAD`). The
resume message tells the new session to run `git log --oneline <HEAD>..HEAD`;
any output means commits landed after the handoff, so it reports the file may
be stale first. It compares commits, not times: another session's commits can
be recorded in UTC and would be missed against the header's local timestamp.
In the `full` format, if `<same root>/progress/<session id>/INDEX.md` exists,
it is passed to the fork as well.

## Waiting to be picked up (handoff-pickup)

![ctx-relay pickup line: an unclaimed handoff file, press 1 to resume](../docs/assets/ctx-relay-pickup.png)

The line reads `󰯉 Pending handoff: <file name> (2h ago, from 1f3a9c2e)`,
with a `Resume [1]` button. When more handoff files are waiting, a `+N`
follows.

| When | What happens |
| --- | --- |
| A new conversation starts (no messages yet at startup; an old conversation reopened with `--resume` does not count), or after you run `/clear` yourself | Look for handoff files in the handoff folder that nobody has picked up, and show the newest; the count of the others goes in `+N` |
| Press 1 while the prompt is empty (or click the button) | Sends "Read <full path> and continue from it; check the git state and the next step before acting.", followed by: if the header has a head line, `git log --oneline <head>..HEAD` printing any commit means the file may be stale, so say so first (the Chinese version for a `full` file), and marks this file as picked up |
| The main conversation starts a new turn (you send a message, press resume, a schedule fires) | The line goes away |

- "Picked up" is recorded as `<handoff folder>/.picked/<handoff file name>`
  (an empty file); the handoff file itself is not touched. Because the folder
  name starts with a dot, a plain `ls -t` for the newest handoff file does
  not see it.
- A file is marked as picked up in three cases: you press resume; a message you
  send contains the full path of a handoff file (you pasted a resume prompt by
  hand); ctx-relay hands off automatically (marked before `/clear`, so the new
  conversation does not list it).
- On first enable, ctx-relay stores the current time in its own store
  (`pickupSince`): handoff files modified before that count as picked up, so a
  fresh install does not list a pile of old files.
- "How long ago" uses the file's modification time; "from" is the first 8
  characters of the first `session \`<id>\`` in the handoff file, and is
  omitted if not found.
- The message sent by pressing 1 is labeled as coming from ctx-relay (the mod
  sends it for you; the model sees the original text).
- While the pickup line is shown, typing "1" into an empty prompt presses
  resume instead of typing. The countdown's cancel button is also 1, but the
  countdown only appears after a turn ends, when the pickup line is already
  gone, so the two never appear together.
- If sending the resume prompt is blocked (for example by a hook in settings),
  the line stays and the file is not marked as picked up.

## Commands

- `/ctx-relay-status`: shows context at the end of the last turn, thresholds,
  handoff state, background work, and the last three handoff failures. Every failed handoff (before `/clear`) is appended
  to `<harness root>/ctx-relay/failures.jsonl` (time, auto or manual, tokens,
  minutes since you last typed, reason; last 100 kept).
  It also counts the handoff ledger, `<harness root>/ctx-relay/handoffs.jsonl`
  (last 500 kept): one line per countdown, cancel, postponement (you sent a
  message or a new turn started), completed handoff, and failure. A
  completed handoff records the tokens before it, the fork's token usage
  (input, cache read, cache write, output), and whether the resume message
  was sent, and each countdown records its trigger: `handoff` (crossed the
  line) or `cap` (forced at the cap while background work still ran). Use it
  to judge whether the automatic handoff earns its keep.
- `/ctx-relay-now`: hand off right away; with background work running, type
  `/ctx-relay-now yes`. The fork instructions, the handoff file header, and the
  resume message in the new conversation all say this was a manual
  `/ctx-relay-now` handoff, not "crossed the automatic handoff line".
  - You can append your latest instruction, for example `/ctx-relay-now yes`,
    a newline, then "do B and install the new mod". Only a first word of `yes`
    counts as confirmation; the rest is the instruction. Without background
    work, `yes` is not needed and all the arguments are the instruction.
  - The instruction is passed verbatim to the fork for writing the goal and
    next-step fields (Goal / Next; in `full`, "goal + latest instruction" and
    "next step"), and written verbatim into the
    handoff file header and the resume message (each line prefixed with `> `,
    so a `## ` in the instruction never becomes a handoff file heading).
  - With an instruction attached, the resume message tells the new
    conversation to check git state and then follow the instruction, without
    waiting for you to repeat it. Without one, as before: report the current
    state and wait for you.
  - Exception (`full` only): when the handoff file is missing 硬約束 ("hard constraints";
    the header's `thin` lists 硬約束), the task's constraints may not have been
    written down, so the resume message instead asks the new conversation to
    first report how it plans to follow the instruction and wait for your
    confirmation.

## Known limits

- Background work never times out: a long-running server defers the handoff
  until the cap forces a countdown; to hand off earlier, use
  `/ctx-relay-now yes`.
- The background work the commands see is the list from the last time the
  main conversation stopped, plus the subagents running right now.
- A subagent may appear in both Claude Code's background-work list and its
  subagent list, so the count in the deferral reason can be too high.
- Requests sent to other Claude sessions and not yet answered are not
  detected: check them yourself before `/clear`.
- Another mod that draws a tall box in the band's slot (seen with a
  confirmation-box mod in an 80-column terminal) can hide the ctx-relay line
  while its box is up; the buttons still work and the band comes back after.
  If that mod draws first and does not pass the slot on, no terminal height
  is enough; which mod draws first depends on load order.
- Writing the handoff file costs about as much as one turn on a cold cache.
  The fork does not read the main conversation's cache: measured on 2.1.294,
  a fork sent 30 seconds after a turn hit 43% (only the shared system prompt
  and tools), while the main conversation's next turn hit 100%.
- After a compaction, `/ctx-relay-status` still shows the reading from before
  it until the next turn ends.
- The handoff content comes from the fork; the machine check only looks for
  empty fields and does not guarantee the content is correct. The new
  conversation is asked to check against git first.
- After `/clear`, `$.state` is reset; module variables and timers survive
  (measured), so the mod cancels its timers before clearing.
- Needs `bash` and `git` on PATH; outside git, also `realpath` (GNU, with
  `-m`) and `sha256sum` or `shasum`.
- The handoff folder layout matches the author's own handoff tooling, so
  both find the same files.
