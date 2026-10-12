# How the screenshots were made

The PNGs in [../assets/](../assets/) are cropped screenshots of one real
Claude Code session (2.1.290, Haiku 4.5) running ctx-relay with
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
       --plugin-dir $M/ctx-relay \
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
   - After a few turns: the ctx-relay band. The committed ctx-relay-band.png
     comes from the bands.gif session after `tmux -L shot resize-window -t s -x 172 -y 48`,
     cropped with `-crop 600x26+8+801`.
4. Crop with `magick <raw>.png -crop WxH+X+Y +repage <out>.png` to the band or
   pane. Every crop leaves out Claude Code's status line below the prompt.
5. `tmux -L shot kill-server` when done.

## GIFs (sitrep.gif, bands.gif)

Recorded with sitrep and ctx-relay loaded by `--plugin-dir`, in a throwaway
repo holding a two-line `greet.py`. Same tmux setup as above, but 120x34 and
`--plugin-dir $M/sitrep --plugin-dir $M/ctx-relay`, started with
`--settings '{"enabledPlugins":{"filetree@claude-code-filetree":false,"ctx-relay@mango-mods":false,"sitrep@mango-mods":false}}'`
so no dock pane narrows the screen and the installed copies stay out.
Extra requirement: `ffmpeg`.

1. Record.
   - sitrep.gif (Claude Code 2.1.296, Sonnet 5.5): run
     [rec-sitrep.sh](rec-sitrep.sh). It makes the throwaway repo, starts the
     session, answers the folder trust prompt, starts
     [record.sh](record.sh) in the background, and sends the prompt: change
     `greet()` to take a `name`, run it once, then ask whether to add pytest
     or mypy. It waits for `… 摘錄中` to turn into the box, then sends `C-x`,
     `Tab` (focuses the row above the prompt) and `a`. It writes
     `sitrep-raw.mp4` and `events.log` (seconds of each step; video 0 s is
     about the `prompt` line) next to itself. Run it outside the Bash sandbox:
     it needs the tmux socket, the network and `~/.claude`.
   - bands.gif (Claude Code 2.1.296, Haiku 4.5, so the handoff line is 142K):
     start the session by hand and drive it with `tmux -L shot send-keys`
     (a single `send-keys -l` puts the whole prompt in at once). Add four
     ~74 KB filler text files to the repo and have Claude read them over
     several turns (whole files or `offset`/`limit` slices) to about 66%, so
     the bars on the right go green. Start `./record.sh band-raw 50 &`, then
     send one more read that ends near 76% (yellow): the clip is that turn
     ending.
2. Cut, crop and encode. The crop starts and ends on character rows (12 px
   padding + 20.3 px per row) and leaves out the status line. sitrep.gif
   starts when the turn ends (the reply with `… 摘錄中` under it) and skips
   the working part of the turn:

   ```bash
   ffmpeg -i sitrep-raw.mp4 -filter_complex "[0:v]\
   drawbox=x=318:y=498:w=360:h=23:color=0x1a1a1a:t=fill:enable='between(t,14.7,17.37)+gte(t,22.74)',\
   drawbox=x=318:y=477:w=360:h=23:color=0x1a1a1a:t=fill:enable='between(t,17.37,22.74)',\
   trim=14.75:27.5,setpts=PTS-STARTPTS,crop=1130:488:0:113,fps=12,\
   scale=800:-1:flags=lanczos,split[x][y];[x]palettegen=max_colors=96:stats_mode=diff[p];\
   [y][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" sitrep.gif
   ffmpeg -ss 12.5 -t 4.5 -i band-raw.mp4 -filter_complex "crop=860:22:0:522,fps=8,split[x][y];\
   [x]palettegen=max_colors=64[p];[y][p]paletteuse=dither=none" bands.gif
   ```

   The times depend on the take; read them off a few frames
   (`ffmpeg -ss <t> -i raw.mp4 -frames:v 1 t.png`). The two `drawbox` filters
   paint over "· 5 messages hidden (/focus to show)", which focus mode adds to
   the turn-end line: that line is one row higher while the row above the
   prompt is showing (from the box appearing until `a` is sent). Recording
   with focus mode off makes them unnecessary, but `/focus` toggles the
   setting for every session, so the script leaves it alone.

## Concept animations (ctx-relay-loop.svg, sitrep-excerpt.svg)

Hand-written SVGs with CSS keyframes, each a 14-second loop on a dark card so it
reads on both GitHub themes; `aria-label` describes each and
`prefers-reduced-motion` shows a still frame. To check a change, render it
paused at a few points of the loop in headless Chrome: wrap the SVG in an HTML
page with `.t { animation-play-state: paused; animation-delay: -<seconds>s }`
and run `google-chrome-stable --headless=new --window-size=900,380
--screenshot=out.png file://…/page.html`.
