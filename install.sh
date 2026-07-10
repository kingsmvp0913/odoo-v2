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

if ! command -v node &>/dev/null; then
  echo "安裝 Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  install_apt nodejs
fi
echo "Node.js $(node --version)"

command -v git &>/dev/null || install_apt git
command -v python3 &>/dev/null || install_apt python3 python3-venv python3-pip
command -v xmllint &>/dev/null || install_apt libxml2-utils
if ! command -v google-chrome &>/dev/null && ! command -v chromium-browser &>/dev/null; then
  install_apt google-chrome-stable || install_apt chromium-browser
fi
command -v uvx &>/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
command -v psql &>/dev/null || install_apt postgresql postgresql-contrib
command -v docker &>/dev/null || { curl -fsSL https://get.docker.com | sudo sh; sudo usermod -aG docker "$USER" || true; }

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

node "$ROOT/scripts/setup.js" "$@"
