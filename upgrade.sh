#!/usr/bin/env bash
# upgrade.sh — 拉最新程式碼並在 tmux 背景重啟平台。
# 用法：./upgrade.sh   （在任何 shell 都可跑，不必先進 tmux、也不必先手動關掉 server）
set -e
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

SESSION=aidev

echo "=== odoo-v2 更新 ==="

# 1. 拉最新（--ff-only：不產生 merge commit；有本機未提交變更會在此明確報錯而非硬併）。
#    此時 server 可照跑不受影響。
BEFORE="$(git rev-parse HEAD)"
echo "git pull..."
git pull --ff-only
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "已是最新（無新 commit），仍重啟以確保吃到最新狀態。"
fi

# 2. 只有 app 相依真的變動才 npm install（省時）。git diff --quiet：無異動回 0、有異動回非 0。
if ! git diff --quiet "$BEFORE" "$AFTER" -- app/package.json app/package-lock.json; then
  echo "相依有更動，執行 npm install..."
  (cd app && npm install)
fi

# 3. 停舊 server：先砍 tmux session、再補殺任何殘留 node 行程，避免 3939 被佔用／
#    違反「僅允許單一 Node 行程」的硬限制（見 DEPLOY.md）。
echo "重啟 server..."
tmux kill-session -t "$SESSION" 2>/dev/null || true
pkill -f 'app/server/index.js' 2>/dev/null || true
sleep 1

# 4. 在 tmux 背景啟動（./start.sh 前景阻塞，由 tmux 保活；DB schema 於啟動時自動 migrate）。
#    用 send-keys 而非把指令塞進 new-session，好處是 start.sh 若中途結束，session 內留下
#    shell 與錯誤訊息可 attach 檢視，不會整個 session 消失看不到原因。
tmux new-session -d -s "$SESSION"
tmux send-keys -t "$SESSION" "cd '$ROOT' && ./start.sh" Enter

echo "完成。server 已在 tmux session '$SESSION' 背景啟動。"
echo "看 log： tmux attach -t $SESSION   （離開：Ctrl+b 放開再按 d）"
