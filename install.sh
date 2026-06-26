#!/usr/bin/env bash
set -e
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "=== AI Dev 安裝程式 ==="

# 1. 檢查 Node.js
if ! command -v node &>/dev/null; then
    echo "安裝 Node.js..."
    if command -v nvm &>/dev/null; then
        nvm install 20 && nvm use 20
    elif command -v brew &>/dev/null; then
        brew install node@20
    elif command -v apt-get &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    else
        echo "無法自動安裝 Node.js，請手動安裝：https://nodejs.org" && exit 1
    fi
fi
echo "Node.js $(node --version)"

# 2. 安裝相依套件
cd "$ROOT/app" && npm install --prefer-offline && cd "$ROOT"

# 3. 建立 data 目錄
mkdir -p "$ROOT/data"
CONFIG="$ROOT/data/config.json"

if [ ! -f "$CONFIG" ]; then
    echo ""
    echo "=== PostgreSQL 連線設定 ==="
    echo "（直接按 Enter 使用括號內預設值）"

    if [ -n "$PG_HOST" ]; then
        pg_host="$PG_HOST"
    else
        read -rp "PG_HOST [localhost]: " pg_host
        pg_host="${pg_host:-localhost}"
    fi

    if [ -n "$PG_PORT" ]; then
        pg_port="$PG_PORT"
    else
        read -rp "PG_PORT [5432]: " pg_port
        pg_port="${pg_port:-5432}"
    fi

    if [ -n "$PG_DB" ]; then
        pg_db="$PG_DB"
    else
        read -rp "PG_DB [aidev]: " pg_db
        pg_db="${pg_db:-aidev}"
    fi

    if [ -n "$PG_USER" ]; then
        pg_user="$PG_USER"
    else
        read -rp "PG_USER: " pg_user
    fi

    if [ -n "$PG_PASSWORD" ]; then
        pg_password="$PG_PASSWORD"
    else
        read -rsp "PG_PASSWORD: " pg_password
        echo ""
    fi

    DATABASE_URL="postgres://${pg_user}:${pg_password}@${pg_host}:${pg_port}/${pg_db}"
    JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")

    node -e "
const fs = require('fs');
const cfg = { DATABASE_URL: process.argv[1], JWT_SECRET: process.argv[2], PORT: 3939 };
fs.writeFileSync(process.argv[3], JSON.stringify(cfg, null, 2));
" "$DATABASE_URL" "$JWT_SECRET" "$CONFIG"

    echo "設定檔已產生：$CONFIG"
else
    echo "設定檔已存在，略過建立：$CONFIG"
fi

# 4. 啟動伺服器
echo ""
node -e "
const c = require(process.argv[1]);
const port = String(c.PORT || 3939);
process.env.DATABASE_URL = c.DATABASE_URL;
process.env.JWT_SECRET   = c.JWT_SECRET;
process.env.PORT         = port;
const { execSync } = require('child_process');
try {
  if (process.platform === 'linux')  execSync('xdg-open http://localhost:' + port + '/setup.html', { stdio: 'ignore' });
  else if (process.platform === 'darwin') execSync('open http://localhost:' + port + '/setup.html', { stdio: 'ignore' });
} catch (_) {}
console.log('AI Dev 啟動於 http://localhost:' + port);
require('./app/server/index.js');
" "$CONFIG"
