#!/usr/bin/env bash
set -e
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "=== odoo-v2 系統套件安裝 (Linux) ==="

install_apt() {
  sudo apt-get update -y
  sudo apt-get install -y "$@"
}

# curl／gnupg／ca-certificates 是後續加 apt repo 與抓安裝腳本的前提，最小安裝的 Ubuntu Server 未必內建
command -v curl &>/dev/null || install_apt curl ca-certificates
command -v gpg &>/dev/null || install_apt gnupg

if ! command -v node &>/dev/null; then
  echo "安裝 Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  install_apt nodejs
fi
echo "Node.js $(node --version)"

command -v git &>/dev/null || install_apt git
command -v python3 &>/dev/null || install_apt python3 python3-venv python3-pip
command -v xmllint &>/dev/null || install_apt libxml2-utils
# Google Chrome 不在 Ubuntu 預設 apt 來源；先加官方 repo 再裝 .deb，失敗才退 chromium。
# （chromium 在新版 Ubuntu 是 snap 轉接，未必落在 /usr/bin，checks.js 的 findChrome 可能找不到）
if ! command -v google-chrome &>/dev/null && ! command -v google-chrome-stable &>/dev/null \
   && ! command -v chromium-browser &>/dev/null && ! command -v chromium &>/dev/null; then
  echo "安裝 Google Chrome..."
  # subshell + || 保護：Chrome 自動安裝失敗（無網路／apt 來源問題）不中斷整個 bootstrap，
  # 由稍後 setup.js 的 verifyRuntimeDeps 明確列缺項提示手動安裝。
  (
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      | sudo tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
    install_apt google-chrome-stable || install_apt chromium-browser
  ) || echo "警告：Chrome 自動安裝失敗，請手動安裝 Google Chrome 後重跑 node scripts/setup.js"
fi
command -v uvx &>/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
command -v psql &>/dev/null || install_apt postgresql postgresql-contrib
command -v docker &>/dev/null || { curl -fsSL https://get.docker.com | sudo sh; sudo usermod -aG docker "$USER" || true; }

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

node "$ROOT/scripts/setup.js" "$@"
