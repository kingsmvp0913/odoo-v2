#!/usr/bin/env bash
# upgrade.sh — 拉最新程式碼並重啟平台。自動辨識佈署模式：
#   Docker 模式（容器 odoo-v2 執行中）→ 容器內裝相依、docker restart
#   宿主直跑模式                      → npm install、pkill 後於 tmux 重啟
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

# 2. Docker 模式：平台跑在容器內，底下的宿主流程全部不適用且會靜默壞事——
#    pkill 因 PID namespace 隔離殺不到容器內的 node（後接 || true 故不報錯＝看似成功但沒重啟），
#    接著 tmux 那段又會在宿主起第二份 server，違反「僅允許單一 Node 行程」的硬限制
#    （見 DEPLOY.md：兩份各持一份互不知情的鎖，重複派工、寫壞共用 clone）。
#    容器名固定為 odoo-v2（docker-compose.yml 的 container_name）；^…$ 是因為 name filter 為子字串比對。
if command -v docker >/dev/null 2>&1 && [ -n "$(docker ps -q -f name='^odoo-v2$' 2>/dev/null)" ]; then
  echo "偵測到 Docker 模式（容器 odoo-v2 執行中）。"

  # Codex CLI 是平台訂閱登入與 Codex agent 的共同前提；舊 image 尚未內建時在升級補裝。
  if ! docker exec odoo-v2 sh -c 'command -v codex >/dev/null 2>&1'; then
    echo "未偵測到 Codex CLI，於容器內補裝..."
    # 以 root 裝進 /usr/local/bin——此目錄在所有 image 的預設 PATH 中。
    # 不能用 odoo 使用者的 npm prefix（~/.npm-global/bin），舊 image 未把它納入
    # PATH，會形成「npm 顯示已裝、平台仍找不到 codex」的假安裝。
    docker exec -u 0 odoo-v2 sh -lc '
      npm i -g @openai/codex
      command -v codex
      codex --version
    '
  fi

  # 相依變動：在容器內裝，宿主的 node 版本與原生 binding 未必與 image 一致。
  if ! git diff --quiet "$BEFORE" "$AFTER" -- app/package.json app/package-lock.json; then
    echo "相依有更動，於容器內執行 npm install..."
    docker exec odoo-v2 sh -c 'cd "${APP_DIR:-/home/odoo/odoo-v2}/app" && npm install'
  fi

  # image／entrypoint 是 COPY 進 image 的，restart 只會拿到舊版（症狀是改動看起來完全沒作用）。
  # 但 build＋up 會「重建容器」，容器檔案系統內的 ~/.claude.json（MCP／plugin 設定）隨之消失，
  # 需重跑 setup.js 補回——有副作用，故只提示不自動執行，由人決定何時做。
  if ! git diff --quiet "$BEFORE" "$AFTER" -- Dockerfile docker/entrypoint.sh; then
    echo ""
    echo "⚠ Dockerfile／entrypoint.sh 有更動，單純 restart 不會生效，需要重建 image："
    echo "    docker compose build && docker compose up -d"
    echo "    docker exec -it odoo-v2 node scripts/setup.js --skip-start   # 重建容器後補回 MCP／plugin 設定"
    echo "  本腳本只做 restart，上述請自行確認後執行。"
    echo ""
  fi

  echo "重啟容器..."
  docker restart odoo-v2
  echo "完成。看 log： docker logs -f odoo-v2"
  exit 0
fi

# ——以下為宿主直跑模式（Windows 本機／未容器化的 Linux）——

# 3. 只有 app 相依真的變動才 npm install（省時）。git diff --quiet：無異動回 0、有異動回非 0。
if ! git diff --quiet "$BEFORE" "$AFTER" -- app/package.json app/package-lock.json; then
  echo "相依有更動，執行 npm install..."
  (cd app && npm install)
fi

# 舊環境可能早於 Codex 導入；只在缺少時補裝，避免每次升級都改動全域 CLI 版本。
if ! command -v codex >/dev/null 2>&1; then
  echo "未偵測到 Codex CLI，補裝..."
  npm i -g @openai/codex
fi

# 4. 只停「server 行程」、不砍整個 tmux session。
#    關鍵：若你正 attach 在 aidev session 裡跑本腳本，kill-session 會把你當場踢出 tmux
#    並中斷後續重啟；改用 pkill 只結束 node server，session 保留，避免 3939 被佔用／
#    違反「僅允許單一 Node 行程」的硬限制（見 DEPLOY.md）。
echo "重啟 server..."
pkill -f 'app/server/index.js' 2>/dev/null || true
sleep 1

# 5. 確保 session 存在（沒有才建），再把啟動指令送進去。send-keys 會排在本腳本結束後執行，
#    所以就算你人在 aidev 裡跑，這行也會在你回到 prompt 後接手把 server 起回來。
#    ./start.sh 前景阻塞、由 tmux 保活；DB schema 於啟動時自動 migrate。
tmux has-session -t "$SESSION" 2>/dev/null || tmux new-session -d -s "$SESSION"
tmux send-keys -t "$SESSION" "cd '$ROOT' && ./start.sh" Enter

echo "完成。server 已在 tmux session '$SESSION' 背景啟動。"
echo "看 log： tmux attach -t $SESSION   （離開：Ctrl+b 放開再按 d）"
