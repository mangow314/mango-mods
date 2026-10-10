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

Recorded on Claude Code 2.1.295 with sitrep and ctx-relay loaded by
`--plugin-dir`, in a throwaway repo holding a two-line `greet.py`. Same tmux
setup as above, but 120x34 and `--plugin-dir $M/sitrep --plugin-dir $M/ctx-relay`.
Extra requirement: `ffmpeg`.

1. Start [record.sh](record.sh) in the background (`./record.sh sitrep-raw 70 &`),
   then drive the session with `tmux -L shot send-keys` while it records. A
   single `send-keys -l` puts the whole prompt in at once.
   - sitrep.gif (Sonnet 5.5): ask Claude to change `greet()` to take a `name`,
     run it once, then ask whether to add pytest or mypy. When the turn ends,
     send `C-x`, `Tab` (focuses the row above the prompt), then `a`.
   - bands.gif (Claude Code 2.1.296, Haiku 4.5, so the handoff line is 142K):
     add four ~74 KB filler text files to the repo and have Claude read them
     over several turns (whole files or `offset`/`limit` slices) to about 66%,
     so the bars on the right go green. Start `./record.sh band-raw 50`, then
     send one more read that ends near 76% (yellow): the clip is that turn
     ending. Start Claude with
     `--settings '{"enabledPlugins":{"filetree@claude-code-filetree":false,"ctx-relay@mango-mods":false,"sitrep@mango-mods":false}}'`
     so no dock pane narrows the band and the installed copies stay out.
2. Cut, crop and encode. The crop starts and ends on character rows (12 px
   padding + 20.3 px per row) and leaves out the status line. The model's
   thinking time is played at 4×:

   ```bash
   ffmpeg -i sitrep-raw.mp4 -filter_complex "[0:v]crop=1130:488:0:113,split=3[a][b][c];\
   [a]trim=2.5:5.5,setpts=PTS-STARTPTS[a1];[b]trim=5.5:17.5,setpts=(PTS-STARTPTS)/4[b1];\
   [c]trim=17.5:26.5,setpts=PTS-STARTPTS[c1];[a1][b1][c1]concat=n=3:v=1,fps=12,\
   scale=800:-1:flags=lanczos,split[x][y];[x]palettegen=max_colors=96:stats_mode=diff[p];\
   [y][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" sitrep.gif
   ffmpeg -ss 12.5 -t 4.5 -i band-raw.mp4 -filter_complex "crop=860:22:0:522,fps=8,split[x][y];\
   [x]palettegen=max_colors=64[p];[y][p]paletteuse=dither=none" bands.gif
   ```

   The trim points depend on when the turn ended; read them off a few frames
   (`ffmpeg -ss <t> -i raw.mp4 -frames:v 1 t.png`). The committed sitrep.gif
   starts at 4.0 s (after the prompt is sent) and paints over the
   "· 4 messages hidden (/focus to show)" text that focus mode adds to the
   turn-end line, with `drawbox=x=312:y=480:w=340:h=21:color=0x1a1a1a:t=fill`
   (and `y=501:h=23` once the row above the prompt goes away), each enabled
   only for its time range; turn focus mode off before recording to skip this.

## Concept animation (ctx-relay-loop.svg)

Hand-written SVG with CSS keyframes, a 10-second loop on a dark card so it
reads on both GitHub themes; `aria-label` describes it and
`prefers-reduced-motion` shows a still frame. To check a change, render it
paused at a few points of the loop in headless Chrome: wrap the SVG in an HTML
page with `.t { animation-play-state: paused; animation-delay: -<seconds>s }`
and run `google-chrome-stable --headless=new --window-size=900,380
--screenshot=out.png file://…/page.html`.
