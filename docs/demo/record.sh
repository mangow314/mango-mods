#!/bin/bash
# 把 tmux -L shot 那個 session 錄成 <name>.mp4（錄 <秒數> 秒），放在目前目錄：
# vhs 開一個 1130x720（120x34 欄列）的終端機 attach 上去，錄完離開。
# 錄影時另一邊用 tmux -L shot send-keys 操作；剪接、裁切、轉 GIF 見 README.md。
set -euo pipefail
name=$1
secs=$2
cat > "$name.tape" <<EOF
Output $name.mp4
Set Shell bash
Set FontFamily "Sarasa Term TC, Symbols Nerd Font"
Set FontSize 16
Set Width 1130
Set Height 720
Set Padding 12
Set Framerate 30
Set Theme GruvboxDarkHard
Hide
Type "tmux -L shot attach -t s"
Enter
Sleep 2s
Show
Sleep ${secs}s
EOF
timeout $((secs + 90)) vhs "$name.tape" >/dev/null 2>&1
rm -f "$name.tape"
ls -la "$name.mp4"
