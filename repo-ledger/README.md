# repo-ledger

> 繁體中文版：[README.zh-TW.md](README.zh-TW.md). The mod's on-screen text is
> in Traditional Chinese.

A Claude Code mod that draws one line above the prompt: the repos this
conversation has touched that still have uncommitted changes.
When you work across several repos at once (for example chezmoi, a vault, and
mango-mods together), one glance before asking the agent to commit tells you
what is still left.

Tested on: Claude Code 2.1.289 (0.1.0, loaded with `--plugin-dir`; tested two
repos with one edited file each, one of them turning into a check mark after
its commit, and showing alongside ctx-relay). The mods API is still in early
access, so a Claude Code release may require changes.

## The band

![repo-ledger band in a live session (top line; the bottom line is ctx-relay)](../docs/assets/bands.png)

A live Claude Code 2.1.290 session. The top line is repo-ledger:
`demo-app(main) 1 · 本輪 2 檔` ("2 files this turn"). With several repos they
share one line, for example `repoA(master) 1 · repoB(master) ✓ · 本輪 2 檔`.

- Each repo shows `name(branch)` followed by its count of uncommitted files
  (untracked files included, in orange); a clean repo shows a gray check mark.
- `↑N`: commits not yet pushed. `⎇N`: extra worktrees of this repo.
- `本輪 N 檔` ("N files this turn"): files inside repos edited with Edit /
  Write since you last sent a message; turns orange above 5 files, so you
  notice early when a lot is changing.
- With no uncommitted files and no files edited this turn, the line is not
  drawn. Unpushed commits alone do not keep it on screen.
- When another mod also draws a band (for example ctx-relay), the two lines
  stack. Which one is on top depends on load order: in the screenshot above,
  with all four mods loaded through `--plugin-dir`, repo-ledger is on top.
- The icon needs a Nerd Font; without one, the line starts with a box.

## Which repos it tracks

- The repo containing any file changed with Edit / Write / NotebookEdit.
  Files outside a repo, such as a scratchpad, do not count.
- Literal paths after `cd`, `pushd`, and `git -C` in Bash commands (paths
  starting with `~/` included).
- A Bash `git` command with no `cd` / `git -C` counts the session's working
  directory.
- The working directory is not listed from the start: until the conversation
  touches it, existing changes there are not shown. Once touched, every
  uncommitted file in the repo counts (including those from before the
  conversation started).

## When it updates

At the end of every turn, after any Bash command containing `git`, and the
first time a new repo is touched.

## Known limits

- Only literal paths are recognized: `S=/x; cd "$S"` or `git -C "$(…)"` cannot
  be seen through and are not tracked.
- Files changed by Bash (`sed -i`, scripts, and so on) do not count toward
  `本輪 N 檔`; if the repo is already tracked, they show up in the uncommitted
  count on the next refresh.
- The text `cd some-repo` inside a heredoc or a commit message may also add
  that repo (one extra entry; the others are unaffected).
- The name is the last component of the repo root: `~/.local/share/chezmoi`
  shows as `chezmoi`, a vault as its folder name.
- The tracked list survives `/clear`, and is read back from `$.state` after a
  hot reload. Neither has been tested live yet.
- Needs `git` on PATH.

## Risks

- The mod runs `git status` and `git worktree list` in tracked repos on its
  own, so settings in the repo's own `.git/config` take effect. Merely `cd`-ing
  into an untrusted repo in the conversation triggers this.
- `core.fsmonitor` is blocked: every `git status` runs with
  `-c core.fsmonitor=false`, so a repo's fsmonitor command never runs.
- Other settings that run commands are not blocked. For example
  `filter.<name>.clean`: `git status` may run it while comparing file
  contents (an assumption, not tested). Use it only in repos you trust.
