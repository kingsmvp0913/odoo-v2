---
name: container-no-root-no-apt
description: 我的 shell 就在 odoo-v2 容器內，沒有 sudo、apt 索引是空的、家目錄不是 volume——別再建議使用者 sudo apt-get install
metadata: 
  node_type: memory
  type: project
  originSessionId: f67467ed-ef4b-4119-bb27-cd1c8e0790c1
---

實測 2026-08-07：

- shell 在容器內（`/.dockerenv` 存在，hostname `ai-server`，Ubuntu 24.04，使用者 `odoo`）
- **沒有 `sudo`**（指令根本不存在），裝不了系統套件
- `/var/lib/apt/lists/` 是空的，`apt-get download` 直接 `Unable to locate package`；`apt-get update` 要 root
- **只有三個路徑是 bind mount，其餘容器重建就消失**：`/home/odoo/odoo-v2`、`/home/odoo/odoo-envs`、`/home/odoo/.claude`（後者是 docker volume `odoo-v2_claude-home`）。`/home/odoo` 本身不是——所以 `~/.local/share/` 之類的東西不會留下。
- 有 `/run/docker.sock` 與 `docker` CLI（可操作 sibling 容器）、有對外網路（curl GitHub OK）、有 `/usr/bin/google-chrome`

**Why**：我曾建議使用者跑 `! sudo apt-get install -y fonts-noto-cjk`，那行在這裡不可能成功，是浪費對方一輪的錯誤建議。
**How to apply**：需要額外二進位／資產時，走「curl 下載 → 放進三個持久掛載之一 → 用環境變數指過去」。RWD 截圖字型就是這樣處理的（`app/rwd/.fontroot/` + `XDG_DATA_HOME`，見 [[rwd-project-status]]）。真的非改 image 不可就改 repo 根的 `Dockerfile` 並告知使用者要重建容器，不要假設能就地安裝。

相關：[[deployment-topology]]、[[vpn-sibling-mount-homomorphic]]。
