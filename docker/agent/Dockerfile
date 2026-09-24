# docker/agent/Dockerfile
# 子專案 0 §4.1：每次 AI 執行用完即丟的容器映像。
# - 與平台同版的 claude CLI（升版兩邊一起升）；context7-mcp 裝在映像內，容器專用 MCP 設定直接呼叫它
#   （平台生成的設定檔指向宿主 node 與 app/node_modules，容器內都不存在，見計畫 X8）
# - python3＋openpyxl／python-docx／xlrd：chat／cs 讀 Office 附件的指引（chat-agent.js ATTACHMENT_READ_HINTS）
#   指名這三個；平台映像以 pip 裝，這裡走 Debian 套件避開 PEP 668
# - reportlab／matplotlib／pillow＋兩套中文字型：chat 交檔案給使用者（chatFiles skill）要做 PDF、
#   圖表與圖片標註。兩套字型各有用途：reportlab 只嵌得進 TrueType 輪廓，Noto CJK 是 CFF 嵌不進去，
#   PDF 只能用 uming；PIL／matplotlib 兩套都能用，但 matplotlib 讀 .ttc 只認得到第一個 face，
#   Noto CJK 在這個映像裡註冊成「Noto Sans CJK JP」（不是 TC），字型名對不上就靜默退回 DejaVu、
#   中文整片空白——chatFiles skill 裡的字型清單是照這個映像實測寫的，換字型套件要一起改。
# - 不裝 rtk、不帶任何使用者層外掛或設定；以 --user <宿主 uid:gid> 執行（見 lib/agent-sandbox.js）
ARG NODE_IMAGE=node:22-slim
FROM ${NODE_IMAGE}

# 系統套件與 npm 套件刻意分兩層，且本層完全不引用任何 ARG——層的快取鍵含展開後的指令字串，
# 一旦把 ${CLAUDE_CODE_VERSION} 寫進同一層，claude 每次自動升版都會連 188 個 apt 套件一起重跑
# （實測十幾分鐘，而 start.sh 是同步等它，平台整段時間起不來）。拆開後升版只重跑下面那層。
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates \
         python3 python3-openpyxl python3-docx python3-xlrd \
         python3-reportlab python3-matplotlib python3-pil \
         fonts-arphic-uming fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# ARG 宣告放在套件層「之後」：ARG 值改變是從宣告處往下失效，宣告在最上面等於前面全部白拆。
ARG CLAUDE_CODE_VERSION
ARG CONTEXT7_MCP_VERSION
RUN test -n "$CLAUDE_CODE_VERSION" && test -n "$CONTEXT7_MCP_VERSION" \
    && npm i -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@upstash/context7-mcp@${CONTEXT7_MCP_VERSION}" \
    && npm cache clean --force

# 容器內家目錄由 --mount 掛入並以 -e HOME 指定；不在映像內建任何設定檔
WORKDIR /tmp
