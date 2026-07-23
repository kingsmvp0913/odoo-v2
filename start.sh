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
export DATABASE_URL="$(read_config DATABASE_URL)"

# 測試區埠範圍（選用）：宿主低位埠已被其他服務佔滿的機器可整段換到乾淨區段；
# 未設定則沿用程式預設 8069-20068，其他機器行為不變。
_PPMIN="$(read_config PROJECT_PORT_MIN)"
if [ -n "$_PPMIN" ]; then export PROJECT_PORT_MIN="$_PPMIN"; fi
_PPMAX="$(read_config PROJECT_PORT_MAX)"
if [ -n "$_PPMAX" ]; then export PROJECT_PORT_MAX="$_PPMAX"; fi

ANTHROPIC_KEY="$(read_config ANTHROPIC_API_KEY)"
if [ -n "$ANTHROPIC_KEY" ]; then export ANTHROPIC_API_KEY="$ANTHROPIC_KEY"; fi

_port="$(read_config PORT)"; _url="http://localhost:${_port:-3939}"
if command -v xdg-open &>/dev/null; then xdg-open "$_url" 2>/dev/null &
elif command -v open &>/dev/null; then open "$_url" 2>/dev/null &
fi
node "$ROOT/app/server/index.js"
