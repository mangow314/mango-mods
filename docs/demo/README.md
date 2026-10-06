# How the screenshots were made

The PNGs in [../assets/](../assets/) are cropped screenshots of one real
Claude Code session (2.1.290, Haiku 4.5) running all four mods with
`--plugin-dir`. The session runs in a separate tmux server; [shot.sh](shot.sh)
attaches [vhs](https://github.com/charmbracelet/vhs) to it and takes a
screenshot.

Requirements: `tmux`, `vhs`, `magick` (ImageMagick), and the fonts Sarasa Term
TC and Symbols Nerd Font.

1. Make a throwaway git repo `demo-app` with a `Makefile` whose `test` target
   exits 2, a `package.json` whose `test` script passes, and a `parse.js`.
   For the ctx-relay pickup line, put a handoff file in
   `demo-app/.git/harness/handoff/` and set its mtime to two hours ago.
2. Start the session in its own tmux server, 172x48, true color, no status
   bar:

   ```bash
   M=~/projects/mango-mods
   tmux -L shot -f /dev/null new-session -d -s s -x 172 -y 48 -c demo-app \
     "env CLAUDE_CODE_TMUX_TRUECOLOR=1 claude --model claude-haiku-4-5-20251001 \
       --plugin-dir $M/ctx-relay --plugin-dir $M/repo-ledger \
       --plugin-dir $M/your-turn --plugin-dir $M/away-receipt \
       --allowedTools 'Bash(make test)' 'Bash(npm test)' 'Bash(git add:*)' 'Bash(git commit:*)' Edit Write"
   tmux -L shot set -g status off
   tmux -L shot set -g window-size manual
   tmux -L shot set -g focus-events on
   tmux -L shot set -as terminal-features 'xterm-256color:RGB'
   tmux -L shot set -g default-terminal tmux-256color
   ```

3. Drive it with `tmux -L shot send-keys`, and run `shot.sh <name>` at each
   state:
   - At startup: the ctx-relay pickup line.
   - After asking Claude to commit a change to `parse.js`, run `make test`
     and `npm test`, and create an uncommitted `NOTES.md`: the repo-ledger
     and ctx-relay bands; then `/receipt` for away-receipt.
   - After asking Claude to read [demo-reply.md](demo-reply.md) and reply
     with it verbatim: your-turn opens; tick 1–2, then 3–5.
4. Crop with `magick <raw>.png -crop WxH+X+Y +repage <out>.png` to the band or
   pane. Every crop leaves out Claude Code's status line below the prompt.
5. `tmux -L shot kill-server` when done.
