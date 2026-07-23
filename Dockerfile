# 平台本體 image：把 install.sh 的系統套件安裝烘進 layer 取得快取，原始碼則由 bind mount 掛入
# （見 docker-compose.yml 的同構掛載）。容器以 --network host 執行，故容器內外的埠與 loopback
# 位址完全同構——這是「平台連得到測試區 127.0.0.x」與「配埠探測看得到宿主佔用」的前提。
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# 基礎工具＋平台執行期相依（對應 install.sh 的 apt 部分）。
# xmllint 來自 libxml2-utils（view XML 驗證）；tmux 供人工進容器操作時使用。
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git tmux \
        python3 python3-venv python3-pip \
        libxml2-utils iproute2 \
        postgresql postgresql-contrib \
        openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 LTS（與 install.sh 同一來源）。
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI（不含 daemon）：平台用掛進來的宿主 socket 建立測試區 sibling 容器。
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

# Google Chrome（tour E2E 用）。Ubuntu 的 chromium 只出 snap、apt 裝不起來，故改裝官方 .deb；
# 它提供 /usr/bin/google-chrome，正是 scripts/lib/checks.js 的偵測清單第一項，無需 symlink。
RUN curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

# claude CLI（scripts/lib/claude-env.js 的 checkCli 也會補裝，此處預先裝好省首跑時間）。
RUN npm i -g @anthropic-ai/claude-code

# 使用者身分：uid/gid 必須對齊宿主的 odoo（1004:1004），否則 bind mount 進來的 repo 權限錯亂。
# 另加入 gid 999 的群組——宿主 /var/run/docker.sock 是 root:docker 660，gid 999；
# 容器內群組名稱無關緊要，gid 對上才讀得到 socket。999 可能已被前面 apt 裝的套件（如
# postgresql）佔走，故先探測：已存在就沿用該群組，不存在才新建。
RUN groupadd -g 1004 odoo \
    && useradd -u 1004 -g 1004 -m -s /bin/bash odoo \
    && { getent group 999 >/dev/null || groupadd -g 999 dockerhost; } \
    && usermod -aG "$(getent group 999 | cut -d: -f1)" odoo

# PostgreSQL 資料目錄：以 odoo 身分執行（initdb 拒絕 root，但一般使用者完全合法），
# 全程單一使用者可省去容器內切換身分。named volume 首次掛載會繼承此處的擁有者。
ENV PGDATA=/var/lib/postgresql/data
ENV PGBIN=/usr/lib/postgresql/16/bin
RUN mkdir -p "$PGDATA" && chown -R odoo:odoo "$PGDATA" && chmod 700 "$PGDATA"

# unix socket 目錄：apt 的 postgresql 套件把它建成 postgres:postgres，而叢集是以 odoo 執行，
# 會在此建 .s.PGSQL.<port>.lock —— 不改擁有者則 postmaster 一啟動就 FATAL: Permission denied。
RUN chown odoo:odoo /var/run/postgresql

# ensurePostgres 的 admin 身分：initdb 以 odoo 建叢集，故 superuser 即 odoo（預設值 postgres 不存在）。
ENV PGADMIN_USER=odoo

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# claude 設定目錄：compose 掛 named volume 於此保存登入憑證。volume 首次掛載會沿用 image 內
# 該路徑的擁有者，image 內若不存在則 docker 建成 root:root，claude 寫 plugins/ 會 EACCES。
RUN mkdir -p /home/odoo/.claude && chown odoo:odoo /home/odoo/.claude

USER odoo

# uv/uvx（serena MCP 用）。裝在使用者家目錄，故須在 USER 切換之後。
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/home/odoo/.local/bin:/home/odoo/.cargo/bin:${PATH}"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
