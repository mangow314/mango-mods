#!/bin/bash
# 把 tmux -L shot 那個 session 現在的畫面截成 <name>.png，放在目前目錄：
# vhs 開一個 1600x1000（172x48 欄列）的終端機 attach 上去，截圖後離開。
# tmux session 要先用 172x48 建好，並設 window-size manual，attach 時才不會被縮放。
set -euo pipefail
name=$1
cat > "$name.tape" <<EOF
Output $name.gif
Set Shell bash
Set FontFamily "Sarasa Term TC, Symbols Nerd Font"
Set FontSize 16
Set Width 1600
Set Height 1000
Set Padding 12
Set Theme GruvboxDarkHard
Hide
Type "tmux -L shot attach -t s"
Enter
Sleep 3s
Show
Sleep 500ms
Screenshot $name.png
Sleep 500ms
EOF
timeout 120 vhs "$name.tape" >/dev/null 2>&1
rm -f "$name.gif" "$name.tape"
ls -la "$name.png"
