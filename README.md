# mango-mods

**Claude Code mods for long sessions: see where a reply landed, and hand off
before the context fills up.**

A Claude Code plugin marketplace with the mods I use every day. A mod is a
plugin written as JS/TS function hooks: it can draw a band above the prompt,
open a pane beside the conversation, and react to session events. The layout
follows the official
[claude-code-playground/claude-code/mods](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods):
one directory per plugin.

![ctx-relay loop: context grows to the handoff line, the mod writes a handoff file, runs /clear, and the fresh conversation picks up](docs/assets/ctx-relay-loop.svg)

> 繁體中文版：[README.zh-TW.md](README.zh-TW.md); each plugin's README also
> has a `README.zh-TW.md`. The on-screen labels are partly in Traditional
> Chinese; what the model writes follows the language of your conversation.

| Plugin | What it does |
| --- | --- |
| [sitrep](sitrep/README.md) | Under each reply, a box with the status, a one-line outcome, what you have to do, collapsed sections (changes, checks) and the questions waiting on you; one row above the prompt answers them from the keyboard. A question you skipped comes back in the next reply |
| [ctx-relay](ctx-relay/README.md) | Band with context size, per-turn cost and the prompt cache countdown. Past the handoff line it writes a handoff file, runs `/clear`, and resumes in the new conversation. Needs no other skill or hook |

## sitrep

<!-- Recording pending: docs/assets/sitrep.gif (reply ends → outcome box → press a to answer) -->

Each reply ends with a small ` ```ui-summary ` block the mod asks for in the
system prompt; the mod hides it and draws the box from it. Details:
[sitrep/README.md](sitrep/README.md).

## ctx-relay

![ctx-relay band: icon, capsule progress bar, tokens, cost, cache countdown](docs/assets/ctx-relay-band.png)

The bar fills toward the handoff line and changes color as it gets close; the
right side shows this turn's growth, cost and how long the prompt cache stays
warm.

![ctx-relay pickup line: an unclaimed handoff file, press 1 to resume](docs/assets/ctx-relay-pickup.png)

A new conversation that finds an unclaimed handoff file shows it under the
band; press `1` to send the resume prompt. Handoff files default to four
sections (Goal, Files, Verified, Next); see
[ctx-relay/README.md](ctx-relay/README.md).

Screenshots come from real Claude Code sessions in a throwaway repo; how they
were made is in [docs/demo/](docs/demo/).

## Status

- A personal experiment, tested on Claude Code 2.1.289 to 2.1.295. The mods
  API is still in early access, so a Claude Code release may break these
  mods. No compatibility guarantee, and issues may go unanswered.
- Read the code before installing: these mods run git commands and write
  files; sitrep adds a section to the system prompt; ctx-relay runs `/clear`
  on its own and sends a resume prompt in the new conversation.

## Install

```bash
claude plugin marketplace add mangow314/mango-mods
claude plugin install sitrep@mango-mods
claude plugin install ctx-relay@mango-mods
```

## Other experiments (not in active use)

These still install and their READMEs still apply, but I no longer run them
day to day and they may be removed.

| Plugin | What it does |
| --- | --- |
| [repo-ledger](repo-ledger/README.md) | Band listing every repo this conversation touched that still has uncommitted changes |
| [your-turn](your-turn/README.md) | Lists the commands you must run yourself in a pane you tick off; when all are done, press `r` to tell Claude |
| [away-receipt](away-receipt/README.md) | When you come back after a while, a pane shows what happened while you were away |

## Development

- Load the directory directly while developing, not the installed copy:
  installed plugins are cached by version.
  `claude --plugin-dir ~/projects/mango-mods/<plugin>`
- Checks, from the plugin directory: `claude plugin validate .`,
  `claude plugin test .`, `npx -p typescript@5 tsc -p .`. tsc needs the mod
  loaded once first, so the engine generates `.claude-plugin/types/` (not
  tracked).
- Release: bump `version` in the plugin's `plugin.json`, commit and push, run
  `claude plugin marketplace update mango-mods`, then update the installed
  plugin.
- Before installing any mod, read the hooks and calls that
  `claude plugin validate --json` lists.

## License

[MIT](LICENSE), covering every plugin in this repo.
