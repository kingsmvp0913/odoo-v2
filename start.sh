#!/usr/bin/env bash
set -e
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
CONFIG="$ROOT/data/config.json"

if [ ! -f "$CONFIG" ]; then
  echo "Error: data/config.json not found. Please run install.sh first." >&2
  exit 1
fi

# 舊安裝也在每次啟動時收緊憑證檔權限；失敗就停止，避免帶著外洩風險開機。
node -e "require('./scripts/lib/config').restrictConfigFile(process.argv[1])" "$CONFIG"

# Shell-injection-safe: pass config path as argv, never shell-expand values
read_config() {
  node -e "
    try {
      const c = require(process.argv[1]);
      process.stdout.write(String(c[process.argv[2]] ?? ''));
    } catch(e) { process.exit(1); }
  " "$CONFIG" "$1"
}

JWT_SECRET="$(read_config JWT_SECRET)"
if [ -z "$JWT_SECRET" ]; then
  echo "Error: JWT_SECRET missing from config.json." >&2
  exit 1
fi

export JWT_SECRET

APP_SECRET="$(read_config APP_SECRET)"
if [ -z "$APP_SECRET" ]; then
  echo "Error: APP_SECRET missing from config.json." >&2
  exit 1
fi
export APP_SECRET

_PORT="$(read_config PORT)"
if [ -n "$_PORT" ]; then export PORT="$_PORT"; fi

# 平台容器名（選用）：沒設時 finding-fix 靠「主機名」找自己是哪個容器。host 網路下同一台主機
# 若再開第二套平台（例如 staging），兩個容器主機名相同 ⇒ 認不出自己，夜間改善合併後的重啟會失敗。
# 放 config.json 而非 docker-compose.yml：upgrade.sh 只 docker restart、不重建容器，compose 的環境變數改了不會生效。
_PC="$(read_config PLATFORM_CONTAINER)"
if [ -n "$_PC" ]; then export PLATFORM_CONTAINER="$_PC"; fi

# 信任的反向代理（選用，逗號分隔的完整 IP）：登入失敗鎖定只在直連對方是這些位址時才採用 X-Real-IP 當來源
# （lib/login-guard.js clientSource）。沒設就一律用直連位址——經 nginx 的使用者會共用同一個來源。
_TP="$(read_config TRUSTED_PROXY_IPS)"
if [ -n "$_TP" ]; then export TRUSTED_PROXY_IPS="$_TP"; fi
export DATABASE_URL="$(read_config DATABASE_URL)"

# 測試區埠範圍（選用）：宿主低位埠已被其他服務佔滿的機器可整段換到乾淨區段；
# 未設定則沿用程式預設 8069-20068，其他機器行為不變。
_PPMIN="$(read_config PROJECT_PORT_MIN)"
if [ -n "$_PPMIN" ]; then export PROJECT_PORT_MIN="$_PPMIN"; fi
_PPMAX="$(read_config PROJECT_PORT_MAX)"
if [ -n "$_PPMAX" ]; then export PROJECT_PORT_MAX="$_PPMAX"; fi

ANTHROPIC_KEY="$(read_config ANTHROPIC_API_KEY)"
if [ -n "$ANTHROPIC_KEY" ]; then export ANTHROPIC_API_KEY="$ANTHROPIC_KEY"; fi

# 有缺才裝：pull 到新增相依（如 archiver）後直接啟動會 MODULE_NOT_FOUND；
# 比對 npm 的 hidden lockfile 與 package-lock.json，缺標記或 lockfile 較新才補裝，相依已滿足則秒過。
_MARKER="$ROOT/app/node_modules/.package-lock.json"
_LOCK="$ROOT/app/package-lock.json"
if [ ! -f "$_MARKER" ] || { [ -f "$_LOCK" ] && [ "$_LOCK" -nt "$_MARKER" ]; }; then
  echo "偵測到相依有異動，執行 npm install..."
  ( cd "$ROOT/app" && npm install --prefer-offline )
fi

# claude 會自行升版（npm i -g latest），而 AI 沙盒映像的 tag 綁 claude 版本——升版後舊映像再也不會
# 被用到，每一次 AI 呼叫都失敗，且只在執行期才看得到。故每次啟動確認一次，讓 agent-infra.js 那句
# 「請管理員重啟平台」真的能解決問題。已存在時只是一次 docker images -q；缺了才建（要數分鐘）。
# 沒 docker（宿主直跑模式）或建置失敗都不擋啟動——平台本身仍可用，缺的只是 AI 的容器隔離模式。
if command -v docker >/dev/null 2>&1; then
  node -e "
    const { ensureAgentImage } = require('./scripts/lib/docker');
    const r = ensureAgentImage();
    console.log('[start] AI 沙盒映像 ' + r.image + (r.built ? ' 已建置' : ' 已存在'));
  " || echo "[start] 警告：AI 沙盒映像補建失敗，沙盒模式不是 off 時 AI 會全部失敗" >&2
fi

_port="$(read_config PORT)"; _url="http://localhost:${_port:-3939}"
if command -v xdg-open &>/dev/null; then xdg-open "$_url" 2>/dev/null &
elif command -v open &>/dev/null; then open "$_url" 2>/dev/null &
fi
# exec 取代本 shell：node 直接成為呼叫者的子行程，停止訊號（含容器的 SIGTERM）才送得到它，
# 不會停在中間這層 bash 而讓 node 變孤兒。本行是腳本最後一步，行為與原本相同。
exec node "$ROOT/app/server/index.js"
