# your-turn

> 繁體中文版：[README.zh-TW.md](README.zh-TW.md). The mod's on-screen text is
> in Traditional Chinese, and it recognizes "run this yourself" hints written
> in Chinese.

A Claude Code mod that turns the commands Claude's last reply asks you to run
yourself into a checklist in a pane beside the conversation.
Steps like `sudo` are always yours to run, yet the commands are often buried in
a long reply. Tick each one off with its number key once it has run; when all
are ticked, press `r` to report, which sends "N/N 完成了" ("N/N done").
The mod only organizes the list; it never runs a command for you.

Tested on: Claude Code 2.1.289 (0.1.0, loaded with `--plugin-dir`; tested the
toast at 141 columns, opening with `/your-turn`, ticking with number keys, and
the report button appearing; the first, powerline-style version was tested
sending "3/3 完成了" from the report button and replacing the whole list on new
commands; the TUI-panel version was tested in a 160-column tmux for frame
titles, right-edge alignment, frames turning gray when done, and the report
button; 0.2.0 was tested splitting into three frames in reply order with only
the finished frame turning gray; 0.3.0 was tested listing both lines of a
"請你在終端機登入 gcloud" ("please log in to gcloud in your terminal") block,
not listing an `ls` after "我剛剛跑了" ("I just ran"), the note line above each
step, and the report button after ticking everything; 0.6.0 was tested on
2.1.290 sending "5/5 完成了" by pressing `r` after ticking everything). The
mods API is still in early access, so a Claude Code release may require
changes.

## The pane

![your-turn in a live session: 5 commands in two frames, 2 ticked off](../docs/assets/your-turn.png)

A live Claude Code 2.1.290 session: the reply asks you to run 5 commands by
hand, split into two frames, 在終端機跑 ("run in a terminal") and 在提示框打
("type in the prompt"); 1 and 2 are ticked. With everything ticked:

![your-turn with everything ticked: gray frames, press r to report](../docs/assets/your-turn-done.png)

The group icons are Nerd Font U+F120 and U+F075; without a Nerd Font they
render as boxes.

- TUI-panel style (after lazygit and btop): the title is plain text; each run
  of consecutive commands that run in the same place gets a rounded frame with
  the group name set into its top border; at the bottom, a progress bar and a
  lazygit-style key bar. One blank line separates the title, each group, and
  the bottom.
- Colors match the terminal, using Gruvbox Dark Hard's bright colors: yellow
  `#fabd2f` = run in a terminal, aqua `#8ec07c` = type in the prompt, green
  `#b8bb26` = done and keys. While a frame still has unfinished commands, its
  border uses the group color; once all are done, it turns dark gray
  `#504945`.
- Frames are drawn with text: a Box's own border is painted over its
  children, so the group name cannot sit on it (measured 2026-10-05). The
  right border is aligned by computing the pane width and column widths; CJK
  characters count as 2 columns.
- In the bottom progress bar, done cells are green and the rest dark gray, up
  to 16 cells, shrinking with a narrow pane.
- Grouped by where the command runs: `sudo` and other commands you run in a
  separate terminal go under 在終端機跑; commands starting with `!` go under
  在提示框打 (typed into Claude's prompt).
- Above each step (one code block, or the inline `` `! cmd` `` on one line) is
  a dim gray note: the sentence before it in the reply, copied as is (for
  example "wait for the install, then start the service:" or "takes about 2
  minutes:"), truncated if too long. That sentence is the nearest non-blank
  line outside a code block; an inline `! cmd` uses its own line. Each
  sentence appears only once; when two code blocks have no text between them,
  the second gets no note.
- Numbering follows the reply's order; groups are not reordered. Consecutive
  commands that run in the same place share a frame, and a change of place
  starts a new one, so one group can have two frames (for example
  `! whoami`, then 3 `sudo` commands, then `! claude plugin list` draws three
  frames: prompt 1, terminal 2–4, prompt 5).
- Each row: number, ○ / ✔, command (truncated if too long). Done commands are
  struck through and dimmed.
- Press the number key again to untick. The first 9 commands have number keys;
  from the 10th on, click with the mouse.
- Press `q` to close the list (as in away-receipt). "q: 關閉" ("close") sits at
  the end of the key bar, also when the list is empty.
- Press `y`, then a number (like vim's `y3`), to copy that command to the
  clipboard without ticking it; useful when a command is too long for the
  pane. After `y`, the key bar changes to "1–3 按編號複製那條指令" ("press a
  number to copy that command"); press `y` again to cancel. After copying, a
  toast says "已複製第 N 條" ("copied #N") and the list goes back to ticking.
  Commands starting with `!` are copied with the `!`, ready to paste into the
  prompt. From the 10th command on there is no number key: after `y`, click
  that command's ○.
- When the pane is not focused, the key bar reads "ctrl+x tab 切過來 │ 1–3 勾選"
  ("ctrl+x tab to switch here │ 1–3 to tick").
- With everything ticked, the key bar reads "r 回報：告訴 Claude 全部完成" ("r
  report: tell Claude everything is done") and a "[ 回報 N/N 完成 ]" button
  appears at the bottom; press `r` (or click it) to send "N/N 完成了" for you
  (labeled as coming from your-turn; the model sees the original text).

## What counts as "a command for you to run"

- Lines in a code block starting with `sudo`. A copied prompt, `$ sudo …`,
  counts too; a trailing `\` joins the next line.
- `! <command>`: inline code (for example `` `! gcloud auth login` ``) or a
  line in a code block. The `!` must be followed by a space, so code like
  `!e.agentId` or `!==` does not count; neither does a placeholder such as
  `! <cmd>` (anything containing `<…>`).
- A shell code block (language tag bash / sh / shell / zsh / console, or no
  tag) whose preceding sentence contains any of 你 ("you"), 手動 ("manually"),
  自己 ("yourself"), 親手 ("by hand"), 在終端機 ("in a terminal"), 另開 ("open
  another"): every line of the block counts, except blank lines and `#`
  comments. For example `gcloud auth login` after "請你在終端機登入 gcloud：".
  A preceding sentence that starts with 我 ("I") does not count ("我自己試了一下："
  / "I tried it myself:", "我在終端機跑了：" / "I ran in the terminal:" are
  Claude describing what it did).
- Ordinary commands in other code blocks (for example `ls` or `git status`
  after "我剛剛跑了：" / "I just ran:") do not count.
- A command that appears again in a later step is listed again (for example
  `sudo -k` at both the start and the end); one mentioned twice in a row is
  listed once ("打 `! whoami`，看 `! whoami` 印出誰" / "type `! whoami` and see
  who `! whoami` prints").
- Grouping looks only at the form: commands starting with `!` go under
  在提示框打 (`! sudo …` included), everything else under 在終端機跑.

## Commands

- `/your-turn`: opens the list, drawn at any width.

## When it updates

- At the end of every main-conversation turn it reads the last reply (the
  answer of `turn.complete`). Subagent turns do not count.
- Commands found: the list is rebuilt, and the pane opens and takes focus.
- No commands found: the list is left alone and the pane does not open.
- After `/clear` the list is empty (`$.state` is reset).

## Known limits

- Automatic opening is a "proactive open": the terminal must be at least 144
  columns wide for it to draw. When narrower, the pane waits undrawn and a
  toast suggests typing `/your-turn`. Once you have opened it with
  `/your-turn` (and not closed it by hand since), the threshold for automatic
  opening drops to 110 columns (measured 2026-10-05: a 141-column tmux pane did
  not open automatically).
- Number keys and `q` work only while the pane has focus. On automatic opening
  it gets focus only if the prompt is empty; after you press Esc to go back to
  the prompt, use ctrl+x tab to switch back to the pane.
- Only the text of the turn's last reply is read; messages earlier in the same
  turn, before tool calls, are not included.
- `sudo` lines written as a script example in a code block are listed too.
- When the preceding sentence has a hint like 你 but the block is really
  sample output (untagged, for example "你會看到：" / "you will see:" followed
  by untagged output), every output line is listed as a command. Blocks tagged
  `text` or another non-shell language are not.
- The note is only the preceding sentence, with no understanding of
  dependencies; a waiting instruction written after the command is not
  picked up.
- With an emoji in a command, the right border may be off by one column (the
  column-width calculation does not handle emoji).
