# mango-mods

**Claude Code mods for long sessions: see where a reply landed, and hand off
before the context fills up.**

Two things get harder the longer a Claude Code session runs. Replies grow
long, and the part you need (did it work, what does Claude want from you) is
buried in the middle. And the context fills up: auto-compact then squeezes
the conversation into a summary you never see, and details you cared about
can vanish. These two mods take on one problem each:

| Plugin | What it does |
| --- | --- |
| [sitrep](sitrep/README.md) | Under each long reply, a box with the status, a one-line outcome, what you have to do, collapsed sections (changes, checks) and the questions waiting on you; one row above the prompt answers them from the keyboard. Every word in the box is the reply's own: a small model only picks line numbers |
| [ctx-relay](ctx-relay/README.md) | A band with context size, per-turn cost and the prompt-cache countdown. Before the context fills up it writes a handoff file you can read, runs `/clear`, and resumes in the new conversation. Needs no other skill or hook |
| [xv-band](xv-band/README.md) | Early access: a row above the prompt with the live status of xvendor cross-vendor review jobs. Useful only with xvendor, which is not released yet |

A mod is a Claude Code plugin written as JS/TS function hooks: it can draw a
band above the prompt, open a pane beside the conversation, and react to
session events. This repo is a plugin marketplace; the layout follows the
official
[claude-code-playground/claude-code/mods](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods):
one directory per plugin.

> 繁體中文版：[README.zh-TW.md](README.zh-TW.md); each plugin's README also has
> a `README.zh-TW.md`. sitrep's labels are English by default (its `language`
> setting switches them to Traditional Chinese); ctx-relay's band and commands
> are English. What the model writes follows the language of your
> conversation.

## sitrep

![sitrep excerpt: a long reply ends, haiku returns only line numbers, each number is checked against the reply, and the box is built from those lines](docs/assets/sitrep-excerpt.svg)

![sitrep: a reply ends, the outcome box folds the changes and checks into one line each, and the question is answered from the row above the prompt](docs/assets/sitrep.gif)

*Claude edits a file, runs it, and asks a question. The box folds the
changes and checks into one line each; `Ctrl+X Tab` focuses the row above the
prompt and `a` puts the answer in the prompt box (nothing is sent).*

After a long reply, `haiku` picks line numbers only; the mod builds the box
from the reply's own lines, so it cannot say what the reply does not. Details:
[sitrep/README.md](sitrep/README.md).

## ctx-relay

![ctx-relay loop: context grows to the handoff line, the mod writes a handoff file, runs /clear, and the fresh conversation picks up](docs/assets/ctx-relay-loop.svg)

![ctx-relay band as a turn ends: the space invader and capsule bar go from 66% green to 76% yellow, the cell the turn added lights up for a moment, then tokens, cost, cache countdown and per-turn bars in green and yellow](docs/assets/bands.gif)

The bar fills toward the handoff line (85% of the auto-compact point by
default) and changes color as it gets close (here a turn takes it from 66%,
green, to 76%, yellow). When a turn ends, the cells it added light up for a
moment. The right side shows this turn's growth, cost, how long the prompt
cache stays warm, and the last few turns as bars.

Why hand off instead of letting auto-compact run: the handoff file is a plain
Markdown file (Goal, Files, Verified, Next) inside your repo's `.git` folder,
so you can read and fix it, and the new conversation is told to check it
against git before acting.

![ctx-relay pickup line: an unclaimed handoff file, press 1 to resume](docs/assets/ctx-relay-pickup.png)

A new conversation that finds an unclaimed handoff file shows it under the
band; press `1` to send the resume prompt. Details:
[ctx-relay/README.md](ctx-relay/README.md).

Screenshots come from real Claude Code sessions in a throwaway repo; how they
were made is in [docs/demo/](docs/demo/).

## Requirements

- Claude Code 2.1.289 or later; tested up to 2.1.296. The mods API is in
  early access, so a Claude Code release may break these mods.
- No flag or setting to turn on: an installed mod is enabled by default.
- `bash` and `git` on PATH.
- ctx-relay's icons need a Nerd Font (3.0 or later), for example Symbols Nerd
  Font as a fallback; without one they show as boxes.

## Install

```bash
claude plugin marketplace add mangow314/mango-mods
claude plugin install sitrep@mango-mods
claude plugin install ctx-relay@mango-mods
```

Settings (sitrep's `language`, ctx-relay's handoff line and file format) are
in `/config`.

## Cost and privacy

- sitrep sends each long reply (800+ characters or 2+ headings) to `haiku`
  once, for line numbers.
- ctx-relay writes a handoff file with one forked request, which costs about
  as much as one turn on a cold cache.
- Both requests go through your own Claude Code account, like any other turn;
  the mods send nothing anywhere else. ctx-relay runs `git` commands and
  writes handoff files under `.git/harness/` (inside `.git`, so never
  committed); outside git, under `~/.claude/harness/`.
- ctx-relay runs `/clear` on its own after a 60-second countdown (press `1`
  to cancel), then sends a resume prompt in the new conversation.

## Uninstall

```bash
claude plugin uninstall sitrep@mango-mods
claude plugin uninstall ctx-relay@mango-mods
claude plugin marketplace remove mango-mods
```

`claude plugin disable <plugin>@mango-mods` turns one off without removing
it. Handoff files stay in `.git/harness/handoff/`; delete that folder to clean
up.

## Feedback

A personal project I use every day. Bug reports, "this confused me", and
ideas are all welcome in
[GitHub Issues](https://github.com/mangow314/mango-mods/issues). Most useful:
your Claude Code version, a screenshot, and what you expected instead.

## Development

- Load the directory while developing, not the installed copy (installed
  plugins are cached by version):
  `git clone https://github.com/mangow314/mango-mods`, then
  `claude --plugin-dir ./mango-mods/<plugin>`.
- Checks, from the plugin directory: `claude plugin validate .`,
  `claude plugin test .`, `npx -p typescript@5 tsc -p .`. tsc needs the mod
  loaded once first, so the engine generates `.claude-plugin/types/` (not
  tracked).
- Release: bump `version` in the plugin's `plugin.json`, commit and push, run
  `claude plugin marketplace update mango-mods`, then update the installed
  plugin.
- Before installing any mod, read the hooks and calls that
  `claude plugin validate --json` lists.
- Retired plugins (repo-ledger, your-turn, away-receipt) are kept at the git
  tag `archive/mods-before-cleanup`.

## License

[MIT](LICENSE), covering every plugin in this repo.
