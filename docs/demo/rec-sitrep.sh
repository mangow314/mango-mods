#!/bin/bash
# 錄 sitrep.gif 的原始影片：在拋棄式 repo 開 tmux -L shot 跑 Claude，送提示、等摘錄框、選答，
# 同時用 record.sh 錄影。剪接與轉 GIF 見 README.md「GIFs」一節。
# 產出（本檔同目錄）：sitrep-raw.mp4、events.log（各動作在第幾秒，影片 0 秒約等於 prompt）、final.txt（結束畫面）
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
M=$(cd "$here/../.." && pwd)
repo=$(mktemp -d)/greet-demo
cd "$here"

if tmux -L shot has-session -t s 2>/dev/null; then
  echo "tmux -L shot 已有 session s，先處理掉再跑" >&2; exit 1
fi

rm -f sitrep-raw.mp4 sitrep-raw.tape events.log final.txt boot-*.txt
mkdir -p "$repo"
printf 'def greet():\n    print("hello")\n' > "$repo/greet.py"
git -C "$repo" init -q
git -C "$repo" add greet.py
git -C "$repo" -c user.name=demo -c user.email=demo@example.com commit -qm init

tmux -L shot -f /dev/null new-session -d -s s -x 120 -y 34 -c "$repo" \
  "env CLAUDE_CODE_TMUX_TRUECOLOR=1 STOP_CLAIM_AUDIT_LOG=/nonexistent claude --model claude-sonnet-5-5 \
    --plugin-dir $M/sitrep --plugin-dir $M/ctx-relay \
    --settings '{\"enabledPlugins\":{\"filetree@claude-code-filetree\":false,\"ctx-relay@mango-mods\":false,\"sitrep@mango-mods\":false}}' \
    --allowedTools 'Bash(python3 greet.py)' 'Bash(python greet.py)' Edit; echo CLAUDE-EXIT=\$?; sleep 600"
tmux -L shot set -g status off
tmux -L shot set -g window-size manual
tmux -L shot set -g focus-events on
tmux -L shot set -as terminal-features 'xterm-256color:RGB'
tmux -L shot set -g default-terminal tmux-256color

pane() { tmux -L shot capture-pane -p -t s; }
# 等畫面出現（或消失）某字串；逾時就印畫面並結束
wait_for() { # $1=字串 $2=秒 $3=present|absent
  for ((i = 0; i < $2 * 2; i++)); do
    if [[ $(pane) == *"$1"* ]]; then [[ $3 == present ]] && return 0
    else [[ $3 == absent ]] && return 0; fi
    sleep 0.5
  done
  echo "逾時：等「$1」$3" >&2; pane >&2; return 1
}

# 新資料夾的信任詢問；每步都存畫面，Claude 若中途結束就停下並印出畫面
sleep 4
pane > boot-1.txt
# 預設選項是「No, exit」，要先往下移一格
if grep -q 'trust this folder' boot-1.txt; then tmux -L shot send-keys -t s Down; sleep 0.5; tmux -L shot send-keys -t s Enter; sleep 4; fi
sleep 4
pane > boot-2.txt
if grep -q 'CLAUDE-EXIT=' boot-2.txt; then
  echo "Claude 啟動後就結束了，畫面如下：" >&2
  echo "--- 信任詢問前 ---" >&2; command cat boot-1.txt >&2
  echo "--- 現在 ---" >&2; command cat boot-2.txt >&2
  tmux -L shot kill-server; exit 1
fi

start=$(date +%s.%N)
mark() { printf '%6.1f %s\n' "$(echo "$(date +%s.%N) - $start" | bc)" "$1" | tee -a events.log; }

"$M/docs/demo/record.sh" sitrep-raw 45 &
rec=$!
sleep 4
mark prompt
tmux -L shot send-keys -t s -l '把 greet() 改成接收 name 參數，跑一次確認輸出，最後問我要加 pytest 還是 mypy。'
tmux -L shot send-keys -t s Enter

wait_for '摘錄中' 85 present && mark excerpt-pending
wait_for '摘錄中' 30 absent && mark excerpt-done
sleep 2
mark C-x;  tmux -L shot send-keys -t s C-x; sleep 1.5
mark Tab;  tmux -L shot send-keys -t s Tab; sleep 1.5
mark a;    tmux -L shot send-keys -t s a
wait "$rec" || true
pane > final.txt
tmux -L shot kill-server
echo "完成：$here/sitrep-raw.mp4"
command cat events.log
