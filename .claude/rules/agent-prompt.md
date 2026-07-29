---
paths:
  - ".claude/agents/**"
  - "app/server/pipeline/*.md"
---

# 平台開發：Agent Prompt

> 抽自 2026-07-29 的記憶整併。完整清單與來源見 `docs/rules-extraction-2026-07-29.md`。

99. **注入片段要排在「同專案跨任務固定的前綴」位置，per-project 動態資料不進 `promptVersion` 指紋** — prompt cache 靠前綴逐字相同命中；把動態值算進 promptVersion 會 bust 掉 qa/coding 的 session resume。
100. **要改 pipeline agent 的行為，光加「禁令」沒用——必須給正面、已解析、可照抄的答案** — 歷程實證 agent body 早寫了「禁掃碟」「禁猜分支」卻無效，遇到佔位符就臨場猜。平台在 spawn 當下已知 repo 絕對路徑與 base 分支，把真值填進去才根治。
101. **碰 git／在客戶 worktree 執行的關卡不能靠 SKILL.md 傳遞知識，必須用 agent-loader 注入片段** — 那些 agent 的 cwd 在客戶 worktree，載不到 odoo-v2 專案的 skill。
102. **pipeline agent 能不能用 project skill 由子行程 cwd 決定** — chat 沒傳 cwd 故繼承 server（skill 原生可達）；coding／qa／reject_triage 的 cwd 是客戶 worktree，摸不到。`--strict-mcp-config` 只擋 MCP、不擋 skill；headless `claude -p` 會載入 cwd 的 project skill。
103. **CLAUDE.md 裡 `<!-- platform-only -->` 區段會被 `loadPipelineRules()` 剝除** — 寫在那裡的內容對客戶關卡等同不存在。
104. **共用片段只注入 `coding-project`／首輪 agent，不要同時注入 `coding-retry`／`qa-retry`** — retry 靠 `--resume` 繼承上一輪對話，重送等於重複佔 context。「兩者都拿」與「兩者都不拿」都是健檢認定的缺陷。
105. **多個 agent 共用的 persona／規則抽成 `.md` 片段，經 agent-loader 具名集合注入**（比照 `SOURCE_ROUTING_AGENTS`／`CS_CAPABILITY_AGENTS`）— 改一處兩邊生效；新增片段記得納入 `promptVersion`。
106. **agent prompt 必須明令「核心 API 只能查 context7、嚴禁掃碟找 Odoo 核心原始碼、探索範圍限縮 worktree」** — worktree 內沒有 Odoo 核心，agent 會 `find /`／`Get-ChildItem C:\` 掃整個檔案系統，被守衛中止並白燒一整個 turn。
107. **「引用 Odoo 原生行為的關卡」要成對配置：給 context7 ＋ 禁讀／禁掃 core** — 只禁不給等於逼 agent 亂跑。不碰 core 的關卡（merge／wiki）維持 none。
108. **不要在 pipeline 塞 serena；每關 MCP 一律由 `claude-runner.js` 的 `MCP_PROFILES` map 依 agentType 指定** — 生產數據 825 次 tool_use 中 serena 近乎 0。
109. **coding agent 每輪必須先讀 worktree 既有碼、修正輪只做外科式修改、禁止整包重寫** — 不加這條，coding 會反覆整包重生（14k→21k→15k），把 QA 指出的細節蓋回錯誤預設。
110. **澄清類 agent 一律「一次列齊所有阻斷性模糊點、禁止分批追問」** — 分批會讓同一件事問三輪。
111. **分流／客服類 agent 若要負責回答技術問題，必須給 cwd／repo 路徑與 context7，不能用 haiku 零調查分流器**。
112. **對話式 agent 帶入的 history 要有輪數上限（env 可調）** — 逐檔／逐題問答會無界成長。

