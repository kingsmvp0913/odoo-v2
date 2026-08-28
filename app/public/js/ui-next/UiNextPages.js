(function () {
  const fmtNumber = (value) => Number(value || 0).toLocaleString("zh-TW");
  const fmtCompact = (value) => {
    const n = Number(value || 0);
    if (n >= 1e6)
      return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
    if (n >= 1e3)
      return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "")}K`;
    return String(Math.round(n));
  };
  const fmtUSD = (value) => {
    const n = Number(value || 0);
    if (n >= 1000) return `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
    if (n >= 1) return `$${n.toFixed(2)}`;
    return n ? `$${n.toFixed(4)}` : "$0";
  };
  const elapsed = (value) => {
    const seconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
    if (seconds >= 3600)
      return `${Math.floor(seconds / 3600)} 小時 ${Math.floor((seconds % 3600) / 60)} 分`;
    if (seconds >= 60)
      return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    return `${seconds} 秒`;
  };
  const usageLevel = (pct) =>
    pct >= 90 ? "critical" : pct >= 70 ? "warning" : "healthy";

  window.UiNextTokenReportView = Vue.defineComponent({
    name: "UiNextTokenReportView",
    data() {
      return {
        loading: true,
        report: null,
        projects: [],
        labels: {},
        expanded: {},
        claudeUsage: null,
        codexUsage: null,
        filters: {
          range: "30",
          start: "",
          end: "",
          project_id: "",
          task_id: "",
          showAll: false,
        },
      };
    },
    computed: {
      dateRange() {
        const now = new Date(),
          end = now.toISOString().slice(0, 10);
        if (this.filters.range === "today") {
          const start = new Date(now);
          start.setHours(0, 0, 0, 0);
          return { start: start.toISOString(), end: now.toISOString() };
        }
        if (this.filters.range === "7") {
          const start = new Date(now);
          start.setDate(start.getDate() - 7);
          return { start: start.toISOString().slice(0, 10), end };
        }
        if (this.filters.range === "30") {
          const start = new Date(now);
          start.setDate(start.getDate() - 30);
          return { start: start.toISOString().slice(0, 10), end };
        }
        return { start: this.filters.start, end: this.filters.end };
      },
      quotaRows() {
        const rows = [];
        const claude = this.claudeUsage || {};
        [
          ["Claude · 5 小時", claude.five_hour],
          ["Claude · 本週", claude.seven_day],
        ].forEach(([label, item]) => {
          if (item && item.utilization != null)
            rows.push({
              label,
              used: Math.round(item.utilization),
              note: `${Math.round(item.utilization)}% 已使用`,
            });
        });
        const codex = this.codexUsage || {};
        [
          ["Codex · 主要額度", codex.primary],
          ["Codex · 週額度", codex.secondary],
        ].forEach(([label, item]) => {
          if (item && item.used_percent != null)
            rows.push({
              label,
              used: Math.round(item.used_percent),
              note: `剩 ${Math.round(item.remaining_percent)}%`,
            });
        });
        return rows;
      },
      summaryCards() {
        const s = this.report && this.report.summary;
        if (!s) return [];
        return [
          ["實際花費", fmtUSD(s.cost_usd), "本期間累計"],
          ["完成任務", fmtNumber(s.done_tasks), "已完成交付"],
          ["每張交付成本", fmtUSD(s.avg_cost_per_task), "平均成本"],
          ["實際 Token", fmtCompact(s.actual_tokens), "扣除 Cache 後"],
        ];
      },
      trendPoints() {
        const rows = (this.report && this.report.daily) || [];
        if (rows.length < 2) return "";
        const max = Math.max(...rows.map((row) => Number(row.tokens || 0)), 1);
        return rows
          .map(
            (row, index) =>
              `${8 + index * (284 / (rows.length - 1))},${80 - (Number(row.tokens || 0) / max) * 66}`,
          )
          .join(" ");
      },
    },
    async created() {
      const [projects, labels, claude, codex] = await Promise.all([
        Api.get("projects").catch(() => []),
        Api.get("agents/labels").catch(() => ({})),
        Api.get("claude-usage").catch(() => null),
        Api.get("codex-usage").catch(() => null),
      ]);
      this.projects = projects;
      this.labels = labels;
      this.claudeUsage = claude;
      this.codexUsage = codex;
      await this.load();
    },
    methods: {
      fmtNumber,
      fmtCompact,
      fmtUSD,
      usageLevel,
      agentLabel(type) {
        return this.labels[type] || type;
      },
      toggle(key) {
        this.expanded[key] = !this.expanded[key];
      },
      taskLink(task) {
        if (!task.linkable) return "";
        return task.kind === "chat"
          ? `/projects/${task.project_id}/chat/${task.chat_id}`
          : task.task_row_id != null
            ? `/task/${task.task_row_id}`
            : "";
      },
      async load() {
        this.loading = true;
        try {
          const p = new URLSearchParams(),
            range = this.dateRange;
          if (range.start) p.set("start", range.start);
          if (range.end) p.set("end", range.end);
          if (this.filters.project_id)
            p.set("project_id", this.filters.project_id);
          if (this.filters.task_id) p.set("task_id", this.filters.task_id);
          if (this.filters.showAll) p.set("all", "true");
          this.report = await Api.get(`token-report?${p}`);
        } catch (error) {
          showToast(error.message || "無法載入用量報表", "error");
        } finally {
          this.loading = false;
        }
      },
    },
    template: `
      <section class="ui-next-page ui-next-usage-page">
        <header class="ui-next-page-head">
<div>
<p class="ui-next-eyebrow">分析工具</p>
<h1>用量報表</h1>
<p>查看額度、成本與交付品質；篩選只影響下方分析資料。</p>
</div>
</header>
        <div class="ui-next-filterbar">
<select v-model="filters.range">
<option value="today">今天</option>
<option value="7">最近 7 天</option>
<option value="30">最近 30 天</option>
<option value="custom">自訂期間</option>
</select>
<template v-if="filters.range==='custom'">
<input v-model="filters.start" type="date">
<span>至</span>
<input v-model="filters.end" type="date">
</template>
<select v-model="filters.project_id">
<option value="">全部專案</option>
<option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
</select>
<input v-model="filters.task_id" placeholder="任務 ID">
<label>
<input v-model="filters.showAll" type="checkbox"> 全部使用者</label>
<button class="ui-next-primary" @click="load" :disabled="loading">{{ loading ? '更新中…' : '更新報表' }}</button>
</div>
        <div class="ui-next-quota-card">
<div class="ui-next-card-title">
<div>
<h2>目前額度</h2>
<p>顏色只用於額度狀態提醒。</p>
</div>
</div>
<div class="ui-next-quota-list">
<div v-for="row in quotaRows" :key="row.label">
<div>
<b>{{ row.label }}</b>
<span>{{ row.note }}</span>
</div>
<i>
<em :class="usageLevel(row.used)" :style="{width:row.used+'%'}">
</em>
</i>
</div>
<p v-if="!quotaRows.length" class="ui-next-empty-inline">目前無法取得訂閱額度。</p>
</div>
</div>
        <template v-if="loading">
<div class="ui-next-loading-card">載入報表中…</div>
</template>
<template v-else-if="report">
<div class="ui-next-metric-grid">
<article v-for="card in summaryCards" :key="card[0]">
<span>{{ card[0] }}</span>
<strong>{{ card[1] }}</strong>
<small>{{ card[2] }}</small>
</article>
</div>
<div class="ui-next-usage-grid">
<article class="ui-next-panel">
<h2>每日趨勢</h2>
<svg viewBox="0 0 300 92" preserveAspectRatio="none" v-if="trendPoints">
<polyline :points="trendPoints" fill="none" stroke="currentColor" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
</svg>
<p v-else class="ui-next-empty-inline">本期間資料不足，尚無趨勢。</p>
</article>
<article class="ui-next-panel">
<h2>依專案</h2>
<div class="ui-next-breakdown" v-for="row in report.by_project" :key="row.project_id">
<span>{{ row.project_name }}</span>
<b>{{ fmtCompact(row.tokens) }}</b>
</div>
<p v-if="!report.by_project.length" class="ui-next-empty-inline">尚無專案資料。</p>
</article>
<article class="ui-next-panel">
<h2>依 Agent</h2>
<div class="ui-next-breakdown" v-for="row in report.by_agent" :key="row.agent_type">
<span>{{ agentLabel(row.agent_type) }}</span>
<b>{{ fmtCompact(row.tokens) }}</b>
</div>
<p v-if="!report.by_agent.length" class="ui-next-empty-inline">尚無 Agent 資料。</p>
</article>
</div>
<section class="ui-next-panel ui-next-usage-detail">
<div class="ui-next-card-title">
<div>
<h2>使用明細</h2>
<p>點選列可展開各 Agent 的模型、用量與耗時。</p>
</div>
<span>{{ report.tasks.length }} 筆</span>
</div>
<div class="ui-next-data-list">
<article v-for="task in report.tasks.slice(0,100)" :key="task.ref_key" @click="toggle(task.ref_key)">
<div>
<b>{{ task.title || task.task_id || '未命名項目' }}</b>
<span>{{ task.project_name || '未分類專案' }} · {{ task.username || '—' }}</span>
</div>
<div>
<strong>{{ fmtUSD(task.total_cost) }}</strong>
<span>{{ fmtCompact(task.total_tokens) }} Token</span>
</div>
<button type="button">{{ expanded[task.ref_key] ? '⌃' : '⌄' }}</button>
<div v-if="expanded[task.ref_key]" class="ui-next-detail-row">
<router-link v-if="taskLink(task)" :to="taskLink(task)" @click.stop>前往來源</router-link>
<span v-for="agent in task.agents" :key="agent.agent_type + agent.model">{{ agentLabel(agent.agent_type) }}<template v-if="agent.model"> · {{ agent.model }}</template>：{{ fmtCompact(agent.tokens) }} / {{ fmtUSD(agent.cost) }}</span>
</div>
</article>
<p v-if="!report.tasks.length" class="ui-next-empty-inline">本期間無 Token 使用記錄。</p>
</div>
</section>
</template>
      </section>`,
  });

  window.UiNextPipelineView = Vue.defineComponent({
    name: "UiNextPipelineView",
    data() {
      return {
        rows: [],
        chats: [],
        loading: true,
        chatsError: false,
        pausingId: null,
        timer: null,
      };
    },
    async mounted() {
      await this.load();
      this.timer = setInterval(() => this.load(), 3000);
    },
    beforeUnmount() {
      if (this.timer) clearInterval(this.timer);
    },
    methods: {
      elapsed,
      statusLabel(status) {
        return window.STATUS_LABELS[status] || status;
      },
      async load() {
        const [rows, chats] = await Promise.all([
          Api.get("admin/pipeline/active").catch(() => null),
          Api.get("admin/chat/active").catch(() => null),
        ]);
        if (rows) this.rows = rows.sort((a, b) => b.elapsed_ms - a.elapsed_ms);
        if (chats) this.chats = chats;
        this.chatsError = chats === null;
        this.loading = false;
      },
      async pause(row) {
        if (
          !(await confirmDialog({
            title: "暫停行程",
            message: `確定暫停並中止「${row.title || row.task_id}」？`,
            danger: true,
            confirmText: "暫停並中止",
          }))
        )
          return;
        this.pausingId = row.id;
        try {
          await Api.post(`admin/pipeline/tasks/${row.id}/pause`);
          await this.load();
          showToast("已暫停行程", "success");
        } catch (error) {
          showToast(error.message, "error");
        } finally {
          this.pausingId = null;
        }
      },
    },
    template: `
      <section class="ui-next-page ui-next-pipeline-page">
<header class="ui-next-page-head">
<div>
<p class="ui-next-eyebrow">即時監控</p>
<h1>進行中 Pipeline</h1>
<p>僅顯示真正執行中的任務與等待 AI 回覆的對話；每 3 秒更新一次。</p>
</div>
<span class="ui-next-live">
<i>
</i>即時更新</span>
</header>
<div v-if="loading" class="ui-next-loading-card">讀取執行狀態中…</div>
<template v-else>
<div class="ui-next-pipeline-grid">
<section class="ui-next-panel">
<div class="ui-next-card-title">
<div>
<h2>執行中的任務</h2>
<p>{{ rows.length }} 個行程</p>
</div>
</div>
<div class="ui-next-run-list">
<article v-for="row in rows" :key="row.id">
<div class="ui-next-run-stage">
<i>
</i>
<span>{{ statusLabel(row.status) }}</span>
</div>
<div>
<b>{{ row.title || row.task_id }}</b>
<span>{{ row.project_name || '未分類專案' }} · {{ row.display_name || row.username || '—' }}</span>
</div>
<time>{{ elapsed(row.elapsed_ms) }}</time>
<div>
<router-link :to="'/task/'+row.id">查看</router-link>
<button @click="pause(row)" :disabled="pausingId===row.id">{{ pausingId===row.id ? '處理中…' : '暫停' }}</button>
</div>
</article>
<p v-if="!rows.length" class="ui-next-empty-state">目前沒有執行中的 Pipeline。</p>
</div>
</section>
<section class="ui-next-panel">
<div class="ui-next-card-title">
<div>
<h2>進行中的排障對話</h2>
<p>{{ chats.length }} 段對話</p>
</div>
</div>
<div class="ui-next-run-list">
<article v-for="chat in chats" :key="chat.id">
<div class="ui-next-run-stage is-chat">
<i>
</i>
<span>AI 回覆中</span>
</div>
<div>
<b>{{ chat.title || '未命名對話' }}</b>
<span>{{ chat.project_name || '未分類專案' }} · {{ chat.display_name || chat.username || '—' }}</span>
</div>
<time>{{ elapsed(chat.waited_ms) }}</time>
<div>
<router-link :to="'/projects/'+chat.project_id+'/chat/'+chat.id">查看</router-link>
</div>
</article>
<p v-if="!chats.length" class="ui-next-empty-state">{{ chatsError ? '暫時無法讀取對話狀態。' : '目前沒有等待 AI 回覆的對話。' }}</p>
</div>
</section>
</div>
</template>
</section>`,
  });

  // Chat 的資料操作完全沿用既有、已驗證的 methods（附件、貼上、未讀、轉任務、輪詢），只替換畫面結構。
  window.UiNextProjectChatView = Vue.defineComponent({
    name: "UiNextProjectChatView",
    components: { UiNextIcon: window.UiNextIcon },
    data() {
      return {
        ...window.ProjectChatView.data(),
        projectName: "專案",
        showNewChat: false,
        showHistory: false,
      };
    },
    async created() {
      await window.ProjectChatView.created.call(this);
      const projects = await Api.get("projects").catch(() => []);
      const project = projects.find(
        (item) => String(item.id) === String(this.$route.params.id),
      );
      this.projectName = project ? project.name : "專案";
    },
    beforeUnmount() {
      window.ProjectChatView.beforeUnmount.call(this);
    },
    methods: window.ProjectChatView.methods,
    template: `
      <section class="ui-next-chat-page">
        <main class="ui-next-thread">
<template v-if="activeChat">
<header class="ui-next-thread-head">
<div>
<p>{{ projectName }}</p>
<h2>{{ activeChat.title || '新對話' }}</h2>
</div>
<div class="ui-next-thread-actions">
<button type="button" @click="showHistory=!showHistory"><ui-next-icon name="chat"/> 對話紀錄<span v-if="chats.length">{{ chats.length }}</span></button>
<button type="button" @click="showNewChat=!showNewChat"><ui-next-icon name="plus"/> 新對話</button>
<button type="button" class="ui-next-task-action" @click="toTask" :disabled="draftingTask||sending">{{ draftingTask ? '摘要中…' : '建立任務' }}</button>
</div>
</header>
<div v-if="showNewChat" class="ui-next-new-chat ui-next-new-chat-popover">
<input v-model="newTitle" placeholder="對話標題（選填）" @keyup.enter="createChat">
<button @click="createChat">開始對話</button>
</div>
<aside v-if="showHistory" class="ui-next-chat-history" aria-label="對話紀錄">
<div class="ui-next-chat-history-head"><strong>對話紀錄</strong><button type="button" @click="showHistory=false" aria-label="關閉對話紀錄">×</button></div>
<div class="ui-next-chat-list">
<article v-for="chat in chats" :key="chat.id" :class="{active:activeChat&&activeChat.id===chat.id}" @click="selectChat(chat);showHistory=false">
<div><b>{{ chat.title || '新對話' }}</b><small v-if="chat.reply_pending">AI 回覆中</small></div>
<i v-if="chat.unread">{{ chat.unread }}</i>
<em v-if="chat.converted_task_id" @click.stop="$router.push('/task/'+chat.converted_task_id)">任務</em>
<button type="button" @click.stop="deleteChat(chat)" aria-label="刪除對話">×</button>
</article>
<p v-if="!chats.length">尚無對話，建立一段新的討論開始。</p>
</div>
</aside>
<div ref="messages" class="ui-next-thread-messages">
<div v-if="loadingMsgs" class="ui-next-empty-state">載入訊息中…</div>
<article v-for="message in messages" :key="message.id" :class="message.role">
<div class="ui-next-message" v-html="renderMd(message.content)" v-show="message.content">
</div>
<div v-if="(message.attachments&&message.attachments.length)||(message.pending_previews&&message.pending_previews.length)" class="ui-next-message-files">
<img v-for="attachment in (message.attachments||[])" :key="attachment.id" v-show="attachUrls[attachment.id]" :src="attachUrls[attachment.id]" :alt="attachment.filename" @click="openImage(attachment.id)">
<img v-for="(url,index) in (message.pending_previews||[])" :key="'pending'+index" :src="url">
</div>
<small>{{ message.role==='user' ? '你' : 'OAA' }} · {{ formatTime(message.created_at) }}</small>
</article>
<div v-if="sending||replyPending" class="ui-next-ai-thinking">
<i>
</i>
<i>
</i>
<i>
</i> OAA 正在處理</div>
</div>
<div v-if="pendingPreviews.length" class="ui-next-pending-files">
<span v-for="(url,index) in pendingPreviews" :key="url">
<img :src="url">
<button @click="removePendingFile(index)">×</button>
</span>
</div>
<form class="ui-next-thread-composer" @submit.prevent="send">
<input ref="chatFileInput" type="file" accept="image/*" multiple @change="onFilesSelected">
<button type="button" @click="$refs.chatFileInput.click()" title="上傳圖片" aria-label="上傳圖片"><ui-next-icon name="paperclip"/></button>
<textarea v-model="newInput" placeholder="輸入你的需求或追問… Enter 送出，Shift + Enter 換行；也可直接貼上截圖。" @paste="onPaste" @keydown.enter="handleEnter">
</textarea>
<button class="ui-next-thread-send" :disabled="sending||(!newInput.trim()&&!pendingFiles.length)">{{ sending ? '…' : '↑' }}</button>
</form>
</template>
<div v-else class="ui-next-thread-empty">
<div>✦</div>
<h2>選擇一段對話</h2>
<p>或建立新對話，討論會保留在「{{ projectName }}」專案中。</p>
</div>
</main>
        <div v-if="showTaskModal" class="ui-next-task-modal-backdrop" @mousedown.self="showTaskModal=false">
<section class="ui-next-task-modal">
<header>
<h2>建立任務</h2>
<button @click="showTaskModal=false">×</button>
</header>
<label>標題<input v-model="taskDraft.title" placeholder="任務標題">
</label>
<label>需求內容<textarea v-model="taskDraft.original_text" placeholder="需求描述">
</textarea>
</label>
<div v-if="taskDraft.attachments&&taskDraft.attachments.length" class="ui-next-task-attachments">
<label v-for="attachment in taskDraft.attachments" :key="attachment.id">
<input type="checkbox" v-model="attachment.chosen"> {{ attachment.filename }}</label>
</div>
<footer>
<button @click="showTaskModal=false">取消</button>
<button class="ui-next-primary" @click="submitTask" :disabled="creatingTask">{{ creatingTask?'建立中…':'建立任務' }}</button>
</footer>
</section>
</div>
      </section>`,
  });

  // 專案詳情保留既有資料與操作（Repo、測試環境、同步設定），畫面改為新版資訊分區。
  window.UiNextProjectDetailView = Vue.defineComponent({
    name: "UiNextProjectDetailView",
    components: {
      SearchableSelect: window.SearchableSelect,
      ReleaseModal: window.ReleaseModal,
    },
    data() {
      return { ...window.ProjectDetailView.data(), detailTab: "overview" };
    },
    computed: window.ProjectDetailView.computed,
    watch: window.ProjectDetailView.watch,
    async created() {
      await window.ProjectDetailView.created.call(this);
    },
    beforeUnmount() {
      window.ProjectDetailView.beforeUnmount.call(this);
    },
    methods: window.ProjectDetailView.methods,
    template: `
      <section v-if="loading" class="ui-next-page">
<div class="ui-next-loading-card">載入專案中…</div>
</section>
      <section v-else-if="project" class="ui-next-page ui-next-project-detail">
        <header class="ui-next-page-head ui-next-detail-head">
<div>
<button class="ui-next-back" @click="$router.push('/projects')">← 所有專案</button>
<p class="ui-next-eyebrow">專案工作區</p>
<h1>{{ project.name }}</h1>
<p>{{ project.description || '集中管理 Repo、測試環境與專案設定。' }}</p>
</div>
<div class="ui-next-detail-actions">
<button @click="goChat">Chat<span v-if="unreadCount()">{{ unreadCount() }}</span>
</button>
<button @click="goWiki">Wiki</button>
<button @click="goDeploySop">部署 SOP</button>
<button @click="showReleaseModal=true" :disabled="!repos.some(r=>r.clone_status==='done')">上正式</button>
</div>
</header>
        <div class="ui-next-project-statbar">
<span>Odoo {{ project.odoo_version || '—' }}</span>
<span>{{ editEdition==='enterprise'?'企業版':'社群版' }}</span>
<span>{{ repos.length }} 個 Repo</span>
<span :class="['is-'+(env&&env.status||'idle')]">{{ {idle:'環境未建立',setting_up:'環境建立中',running:'環境運行中',error:'環境發生錯誤'}[env&&env.status] || '環境未建立' }}</span>
</div>
        <nav class="ui-next-detail-tabs">
<button v-for="tab in [['overview','總覽'],['repos','Repo'],['env','測試環境'],['settings','設定']]" :key="tab[0]" :class="{active:detailTab===tab[0]}" @click="detailTab=tab[0]">{{ tab[1] }}</button>
</nav>
        <section v-if="detailTab==='overview'" class="ui-next-detail-overview">
<article class="ui-next-panel">
<h2>Repo 概況</h2>
<p>{{ repos.length }} 個程式庫；{{ repos.filter(r=>r.clone_status==='done').length }} 個已同步。</p>
<button @click="detailTab='repos'">管理 Repo</button>
</article>
<article class="ui-next-panel">
<h2>測試環境</h2>
<p>{{ {idle:'尚未建立',setting_up:'建立中',running:'運行中',error:'發生錯誤'}[env&&env.status]||'尚未建立' }}</p>
<button @click="detailTab='env'">管理測試環境</button>
</article>
<article class="ui-next-panel">
<h2>專案工具</h2>
<button @click="$router.push('/projects/'+project.id+'/db')">資料庫查詢</button>
<button v-if="!project.has_wiki" @click="initWiki">初始化 Wiki</button>
</article>
</section>
        <div v-if="detailTab==='repos'" class="ui-next-project-detail-grid">
<section class="ui-next-panel ui-next-repos">
<div class="ui-next-card-title">
<div>
<h2>Git Repositories</h2>
<p>原始碼、主分支與同步狀態。</p>
</div>
</div>
<div v-if="!repos.length" class="ui-next-empty-state">尚未綁定任何 Repo。</div>
<article v-for="repo in repos" :key="repo.id" class="ui-next-repo-row">
<div>
<div class="ui-next-repo-name">
<b>{{ repo.label }}</b>
<span v-if="repo.is_primary">主要</span>
<em :class="repo.clone_status">{{ {cloning:'同步中',done:'已同步',error:'同步失敗'}[repo.clone_status] || repo.clone_status }}</em>
</div>
<p>{{ repo.repo_url }}</p>
<small v-if="repo.clone_status==='done'">主分支：{{ (branchInfo[repo.id]&&branchInfo[repo.id].effective)||repo.base_branch||'自動偵測' }}<template v-if="branchInfo[repo.id]&&branchInfo[repo.id].ai_branch"> · AI：{{ branchInfo[repo.id].ai_branch }}</template>
</small>
<small v-if="repo.clone_error" class="ui-next-error-text">{{ repo.clone_error }}</small>
</div>
<div class="ui-next-repo-actions">
<button v-if="repo.clone_status==='error'" @click="reclone(repo.id)">重新同步</button>
<button v-if="repo.clone_status==='done'" @click="updateRepo(repo.id)">更新</button>
<button class="danger" @click="removeRepo(repo.id)" :disabled="envActive||repo.clone_status==='cloning'">移除</button>
</div>
</article>
<form class="ui-next-add-repo" @submit.prevent="addRepo">
<input v-model="newRepo.label" placeholder="標籤，例如 main">
<input v-model="newRepo.repo_url" placeholder="Git URL" @blur="probeRemoteBranches">
<SearchableSelect v-if="remoteBranches.length" :model-value="newRepo.base_branch" :options="remoteBranches.map(b=>({value:b,label:b}))" all-label="自動偵測" placeholder="主分支" @update:modelValue="v=>newRepo.base_branch=v||''"/>
<span v-else class="ui-next-field-note">{{ probingBranches?'讀取分支中…':'主分支自動偵測' }}</span>
<label>
<input type="checkbox" v-model="newRepo.is_primary"> 主要 Repo</label>
<button class="ui-next-primary" :disabled="savingRepo||probingBranches">{{ savingRepo?'新增中…':'新增 Repo' }}</button>
</form>
</section>
</div>
        <section v-if="detailTab==='env'" class="ui-next-panel ui-next-env-card">
<div class="ui-next-card-title">
<div>
<h2>Odoo 測試環境</h2>
<p>可獨立建立、啟動與檢視測試區。</p>
</div>
<span :class="['ui-next-env-status',env&&env.status]">{{ {idle:'未建立',setting_up:'建立中',running:'運行中',error:'錯誤'}[env&&env.status] || '未建立' }}</span>
</div>
<p v-if="env&&env.error_msg" class="ui-next-error-text">{{ env.error_msg }}</p>
<p v-if="env&&env.addons_drift&&env.addons_drift.length" class="ui-next-warning-text">新增的 Repo 尚未掛進既有環境：{{ env.addons_drift.join('、') }}。停止後重新啟動即可重建掛載。</p>
<div class="ui-next-env-actions">
<button v-if="!env||env.status==='idle'||env.status==='error'" class="ui-next-primary" @click="setupEnv" :disabled="envWorking">{{ envWorking?'處理中…':(env&&env.built?'重新啟動':'建立環境') }}</button>
<button v-if="env&&env.status==='running'" class="ui-next-primary" @click="openEnv">開啟測試區</button>
<button v-if="env&&env.status==='running'&&env.external_slot!=null" @click="releaseExternal" :disabled="envWorking">關閉對外</button>
<button v-if="env&&env.status==='running'" @click="stopEnv" :disabled="envWorking">停止</button>
<button v-if="env&&(env.built||env.status!=='idle')" @click="viewLog" :disabled="logLoading">{{ logLoading?'讀取中…':'查看 log' }}</button>
<button v-if="env&&(env.status!=='idle'||env.built)" class="danger" @click="deleteEnv" :disabled="envWorking">刪除環境</button>
<button @click="loadEnv" :disabled="envWorking">重新整理</button>
</div>
<details v-if="env&&env.setup_log">
<summary>查看建立記錄</summary>
<pre>{{ env.setup_log }}</pre>
</details>
<div v-if="runtimeLog!==null" class="ui-next-runtime-log">
<div>
<span>Odoo 運行記錄</span>
<button @click="runtimeLog=null">關閉</button>
</div>
<pre>{{ runtimeLog }}</pre>
</div>
</section>
        <section v-if="detailTab==='settings'" class="ui-next-project-settings">
<div class="ui-next-panel">
<h2>同步來源對應</h2>
<p>一行一個名稱，可自動綁定 Odoo 與客服同步來源。</p>
<label>Odoo 專案名稱<textarea v-model="editOdooProjectName" placeholder="一行一個完整名稱">
</textarea>
</label>
<label>客服來源名稱<textarea v-model="editServiceRespondentName" placeholder="一行一個完整名稱">
</textarea>
</label>
<button class="ui-next-primary" @click="saveProjectMapping">儲存對應</button>
</div>
<div v-if="isAdmin()" class="ui-next-panel">
<h2>測試流程</h2>
<p>E2E 會依驗收條件建立並在部署後執行。</p>
<label class="ui-next-toggle">
<input type="checkbox" v-model="editE2eEnabled" @change="saveE2eSetting" :disabled="savingE2e">
<span>
</span>{{ editE2eEnabled?'E2E 測試啟用中':'已停用 E2E 測試' }}</label>
<hr>
<h2>Odoo 版本類型</h2>
<select v-model="editEdition" @change="saveEdition" :disabled="savingEdition">
<option value="community">社群版（Community）</option>
<option value="enterprise">企業版（Enterprise）</option>
</select>
</div>
</section>
        <ReleaseModal v-if="showReleaseModal" :project-id="$route.params.id" @close="showReleaseModal=false" />
      </section>
      <section v-else class="ui-next-page">
<div class="ui-next-empty-state">專案不存在。</div>
</section>`,
  });

  // 任務詳情的資料、輪詢、附件與每種 Pipeline 動作均沿用既有實作；新版只重組資訊層級。
  window.UiNextTaskDetailView = Vue.defineComponent({
    name: "UiNextTaskDetailView",
    components: { UiNextIcon: window.UiNextIcon },
    data: window.TaskDetailView.data,
    computed: window.TaskDetailView.computed,
    watch: window.TaskDetailView.watch,
    async created() {
      await window.TaskDetailView.created.call(this);
    },
    mounted() {
      window.TaskDetailView.mounted.call(this);
    },
    beforeUnmount() {
      window.TaskDetailView.beforeUnmount.call(this);
    },
    methods: {
      ...window.TaskDetailView.methods,
      submitAnswer() {
        if (!this.clarQuestions.length) this.newMessageText = this.resolution;
        return window.TaskDetailView.methods.submitAnswer.call(this);
      },
    },
    template: `
      <section class="ui-next-page ui-next-task-detail">
<div v-if="loading" class="ui-next-loading-card">載入任務中…</div>
<div v-else-if="error" class="ui-next-loading-card ui-next-error-text">{{ error }}</div>
<template v-else-if="task">
<header class="ui-next-page-head ui-next-detail-head">
<div>
<button class="ui-next-back" @click="back">← 任務列表</button>
<p class="ui-next-eyebrow">{{ task.project_name || '專案任務' }}</p>
<h1>{{ task.title || task.task_id }}</h1>
<p>{{ task.task_id }} · 最後更新 {{ formatTime(task.updated_at) }}</p>
</div>
<div class="ui-next-detail-actions">
<button v-if="testMode" @click="stepPipeline" :disabled="stepping">{{ stepping?'執行中…':'推進 Pipeline' }}</button>
<button v-if="task.status!=='stopped'&&task.status!=='done'" @click="togglePause">{{ task.is_paused?'恢復任務':'暫停任務' }}</button>
<button v-if="task.env_status" @click="openEnv">測試機</button>
<button v-if="isAdmin&&!isTourDemo" @click="startHealthCheck" :disabled="healthChecking">{{ healthChecking?'健檢中…':'任務健檢' }}</button>
<button v-if="isAdmin&&task.git_branch" @click="downloadCodeZip" :disabled="downloadingZip">{{ downloadingZip?'打包中…':'下載程式碼' }}</button>
</div>
</header>
<div class="ui-next-task-detail-grid">
<main>
<section class="ui-next-panel ui-next-task-summary">
<div class="ui-next-task-badges">
<span :class="['ui-next-status-badge',task.status]">{{ statusLabel }}</span>
<span v-if="serverConfirmedRunning" class="is-live">處理中</span>
<a v-if="sourceUrl()" :href="sourceUrl()" target="_blank">{{ sourceLabel() }}</a>
<span v-else>{{ sourceLabel() }}</span>
<span v-if="task.stage_label">{{ task.stage_label }}</span>
<span v-if="task.module">{{ task.module }}</span>
</div>
<div class="ui-next-card-title">
<h2>需求內容</h2>
<button v-if="canEditContent&&!editingContent" @click="startEditContent">編輯</button>
</div>
<p v-if="!editingContent" class="ui-next-task-content">{{ task.original_text || '（無內容）' }}</p>
<div v-else>
<textarea v-model="editText">
</textarea>
<div class="ui-next-inline-actions">
<button class="ui-next-primary" @click="saveContent" :disabled="savingContent||!editText.trim()">{{ savingContent?'儲存中…':'儲存' }}</button>
<button @click="cancelEditContent">取消</button>
</div>
</div>
<div v-if="ticketAttachments.length" class="ui-next-ticket-files">
<b>主附件</b>
<button v-for="file in ticketAttachments" :key="file.id" @click="downloadAttachment(file.id,file.filename)">⌕ {{ file.filename }} <small v-if="file.size">{{ formatSize(file.size) }}</small>
</button>
</div>
</section>
<section class="ui-next-panel ui-next-conversation">
<div class="ui-next-card-title">
<div>
<h2>對話與執行歷程</h2>
<p>保留完整溝通與系統紀錄。</p>
</div>
</div>
<div ref="convPanel" class="ui-next-conv-list" @scroll="onConvScroll">
<button v-if="hasMoreConv" @click="loadMoreConv">載入更早的對話（{{ timeline.length-convVisible }}）</button>
<article v-for="item in visibleTimeline" :key="item._key" :class="timelineClass(item)">
<template v-if="isErrorLog(item)||machineLogHint(item)">
<button @click="toggleLog(item._key)">{{ expandedLogs[item._key]?'收合':'展開' }} 技術紀錄（{{ logLineCount(item) }} 行）</button>
<pre v-if="expandedLogs[item._key]">{{ item.content }}</pre>
</template>
<template v-else>
<p>{{ item.content }}</p>
<div v-if="item.attachments&&item.attachments.length">
<button v-for="file in item.attachments" :key="file.id" @click="downloadAttachment(file.id,file.filename)">⌕ {{ file.filename }}</button>
</div>
</template>
<small>{{ timelineMeta(item) }} · {{ formatTime(item.ts) }}</small>
</article>
<p v-if="!timeline.length" class="ui-next-empty-state">尚無對話記錄。</p>
</div>
</section>
</main>
<aside class="ui-next-task-side">
<section class="ui-next-panel ui-next-task-action">
<p class="ui-next-eyebrow">下一步</p>
<h2>{{ {answer:'等待回答',spec_review:'規格審核',review:'人工審核',conflict:'合併衝突',cs_reply:'客服回覆',cs_data:'補充資料',blocker:'需要介入',archive:'任務完成',message:'新增留言'}[timelineActionMode] }}</h2>
<template v-if="timelineActionMode==='answer'">
<p v-if="clarIntro">{{ clarIntro }}</p>
<template v-if="clarQuestions.length">
<div v-for="(q,index) in clarVisible()" :key="q.id" class="ui-next-question">
<b>{{ index+1 }}. {{ q.text }}</b>
<template v-if="q.type==='choice'">
<label v-for="opt in q.options" :key="opt.key">
<input type="radio" :name="'answer_'+q.id" :value="opt.key" v-model="answerFields[q.id]"> {{ opt.label }}</label>
<textarea v-model="answerExtra[q.id]" placeholder="補充說明">
</textarea>
</template>
<textarea v-else v-model="answerFields[q.id]" placeholder="輸入回答">
</textarea>
</div>
<input ref="answerFileInput" type="file" multiple @change="onAnswerFilesSelected">
<button class="ui-next-primary" @click="submitAnswer" :disabled="submitting||clarBusy||!clarAllAnswered">{{ submitting?'送出中…':'送出回答' }}</button>
</template>
<template v-else>
<textarea v-model="resolution" placeholder="輸入給 AI 的回答或補充">
</textarea>
<input ref="answerFileInput" type="file" multiple @change="onAnswerFilesSelected">
<button class="ui-next-primary" @click="submitAnswer" :disabled="submitting||!resolution.trim()">{{ submitting?'送出中…':'送出回答' }}</button>
</template>
</template>
<template v-else-if="timelineActionMode==='spec_review'">
<p>{{ spec&&spec.summary || '請確認規格後開始實作。' }}</p>
<ul v-if="spec&&spec.acceptance">
<li v-for="(item,index) in spec.acceptance" :key="index">{{ item }}</li>
</ul>
<textarea v-model="specFeedback" placeholder="補充或要求調整規格">
</textarea>
<div class="ui-next-inline-actions">
<button @click="specRevise" :disabled="specRevising||!specFeedback.trim()">{{ specRevising?'送出中…':'要求調整' }}</button>
<button class="ui-next-primary" @click="specApprove" :disabled="specApproving">{{ specApproving?'處理中…':'確認開工' }}</button>
</div>
</template>
<template v-else-if="timelineActionMode==='review'">
<button @click="toggleDiff" :disabled="diffLoading">{{ diffLoading?'讀取中…':(diffOpen?'收合程式變更':'查看程式變更') }}</button>
<pre v-if="diffOpen&&diffData">{{ diffData.repos.map(r=>r.label+' — '+(r.diff||'無變更')).join(' | ') }}</pre>
<textarea v-model="rejectReason" placeholder="退回原因">
</textarea>
<input ref="rejectFileInput" type="file" multiple @change="onRejectFilesSelected">
<div class="ui-next-inline-actions">
<button @click="reject" :disabled="rejecting||!rejectReason.trim()">{{ rejecting?'退回中…':'退回修正' }}</button>
<button class="ui-next-primary" @click="approve" :disabled="approving">{{ approving?'處理中…':'審核通過' }}</button>
</div>
</template>
<template v-else-if="timelineActionMode==='conflict'">
<p v-if="task.blocker_content" class="ui-next-error-text">{{ task.blocker_content }}</p>
<div v-for="(item,index) in conflictItems" :key="item.key" class="ui-next-question">
<b>{{ item.repo }} / {{ item.file }}</b>
<label v-for="choice in ['take_theirs','take_ours','manual']" :key="choice">
<input type="radio" :name="'conflict_'+index" :value="choice" v-model="conflictChoices[item.key]"> {{ recLabel(choice) }}</label>
</div>
<button v-if="conflictItems.length" class="ui-next-primary" @click="submitConflictResolutions" :disabled="submittingConflicts||!conflictAllChosen">送出裁決</button>
<button v-else class="ui-next-primary" @click="markConflictResolved" :disabled="conflictResolving">{{ conflictResolving?'處理中…':'已手動解決衝突' }}</button>
</template>
<template v-else-if="timelineActionMode==='cs_reply'">
<p>{{ task.cs_reply }}</p>
<textarea v-model="csFollowup" placeholder="要求調整客服回覆">
</textarea>
<div class="ui-next-inline-actions">
<button @click="csFollowupSubmit" :disabled="csFollowingUp||!csFollowup.trim()">送出</button>
<button class="ui-next-primary" @click="csConfirm" :disabled="csConfirming">確認結案</button>
</div>
</template>
<template v-else-if="timelineActionMode==='cs_data'">
<div v-for="(question,index) in csQuestions" :key="index" class="ui-next-question">
<b>{{ question }}</b>
<textarea v-model="csAnswers[question]" placeholder="輸入補充資料">
</textarea>
</div>
<button class="ui-next-primary" @click="csDataSubmit" :disabled="csRetrying||!csAllAnswered">送出補充資料</button>
</template>
<template v-else-if="timelineActionMode==='blocker'">
<p class="ui-next-error-text">{{ task.blocker_content || '任務執行中斷' }}</p>
<button v-for="shortcut in blockerShortcuts" :key="shortcut.label" @click="applyResolutionShortcut(shortcut.text)">{{ shortcut.label }}</button>
<textarea v-model="resolution" placeholder="說明修正方向">
</textarea>
<button class="ui-next-primary" @click="resolveBlocker" :disabled="resolving||!resolution.trim()">{{ resolving?'處理中…':'從中斷處繼續' }}</button>
</template>
<template v-else-if="timelineActionMode==='archive'">
<p>任務已完成，可手動封存。</p>
<button @click="archive" :disabled="archiving">{{ archiving?'封存中…':'封存任務' }}</button>
</template>
<template v-else>
<textarea v-model="newMessageText" placeholder="新增留言">
</textarea>
<input type="file" multiple @change="onMessageFilesSelected">
<label v-if="showWritebackOption">
<input type="checkbox" v-model="messageWriteback"> 同步回寫至來源</label>
<button class="ui-next-primary" @click="sendTaskMessage" :disabled="sendingMessage||(!newMessageText.trim()&&!newMessageFiles.length)">{{ sendingMessage?'送出中…':'送出留言' }}</button>
</template>
</section>
<section class="ui-next-panel ui-next-events">
<h2>執行輸出</h2>
<div ref="eventsBox" @scroll="onEventsScroll">
<pre v-for="event in events" :key="event.id||event.content" v-html="ansiToHtml(event.content)">
</pre>
<p v-if="!events.length">尚無執行輸出。</p>
</div>
<router-link :to="'/task/'+task.id+'/terminal'">開啟完整終端機</router-link>
</section>
</aside>
</div>
</template>
</section>`,
  });

  window.UiNextSettingsView = Vue.defineComponent({
    name: "UiNextSettingsView",
    data: window.SettingsView.data,
    computed: window.SettingsView.computed,
    async created() {
      await window.SettingsView.created.call(this);
    },
    mounted() {
      window.SettingsView.mounted.call(this);
    },
    unmounted() {
      window.SettingsView.unmounted.call(this);
    },
    methods: window.SettingsView.methods,
    template: `
      <section class="ui-next-page ui-next-settings-page">
<header class="ui-next-page-head">
<div>
<p class="ui-next-eyebrow">帳號與設定</p>
<h1>個人設定</h1>
<p>管理帳號、通知、GitHub 與外部系統連線。</p>
</div>
</header>
<div v-if="loading" class="ui-next-loading-card">載入設定中…</div>
<div v-else class="ui-next-settings-grid">
<section class="ui-next-panel">
<h2>外觀與通知</h2>
<label class="ui-next-toggle">
<input type="checkbox" :checked="isDark" @change="toggleTheme">
<span>
</span>深色模式</label>
<label class="ui-next-toggle">
<input type="checkbox" :checked="notifyOn" @change="toggleNotify">
<span>
</span>桌面通知</label>
<button v-if="notifyOn" @click="testNotify">測試通知</button>
</section>
<section class="ui-next-panel">
<h2>帳號資料</h2>
<label>帳號<input :value="me.username" disabled>
</label>
<label>顯示名稱<input v-model="me.display_name" placeholder="你的名字">
</label>
<label>Teams 使用者 ID<input v-model="teamsUserId" placeholder="選填，用於 Teams 通知識別">
</label>
<button class="ui-next-primary" @click="save" :disabled="saving">{{ saving?'儲存中…':'儲存帳號設定' }}</button>
</section>
<section class="ui-next-panel">
<h2>變更密碼</h2>
<label>目前密碼<input v-model="pw.current" type="password">
</label>
<label>新密碼<input v-model="pw.next" type="password" placeholder="至少 8 個字元">
</label>
<label>確認新密碼<input v-model="pw.confirm" type="password">
</label>
<p v-if="pwError" class="ui-next-error-text">{{ pwError }}</p>
<button @click="savePw" :disabled="savingPw">{{ savingPw?'更新中…':'更新密碼' }}</button>
</section>
<section class="ui-next-panel">
<h2>GitHub 認證</h2>
<p v-if="githubPat.configured">已連結：{{ githubPat.login }}</p>
<template v-else>
<p>設定 Personal Access Token，供任務推送程式碼。</p>
<input v-model="githubPat.input" type="password" placeholder="github_pat_…">
<a :href="patLink" target="_blank">建立 GitHub Token</a>
</template>
<div class="ui-next-inline-actions">
<button v-if="githubPat.configured" class="danger" @click="removeGithubPat">移除連結</button>
<button v-else class="ui-next-primary" @click="saveGithubPat" :disabled="githubPat.saving">{{ githubPat.saving?'驗證中…':'連結 GitHub' }}</button>
</div>
</section>
<section class="ui-next-panel ui-next-settings-wide">
<h2>外部系統連線</h2>
<div class="ui-next-settings-connection">
<div>
<h3>Odoo</h3>
<label>帳號<input v-model="creds.odoo_username">
</label>
<label>密碼<input v-model="creds.odoo_password" type="password" :placeholder="pwSet.odoo?'已設定，留空不變更':'輸入密碼'">
</label>
<button @click="verifyOdoo" :disabled="verifyingOdoo">{{ verifyingOdoo?'驗證中…':'驗證 Odoo' }}</button>
</div>
<div>
<h3>eService</h3>
<label>帳號<input v-model="creds.service_username">
</label>
<label>密碼<input v-model="creds.service_password" type="password" :placeholder="pwSet.service?'已設定，留空不變更':'輸入密碼'">
</label>
<button @click="verifyService" :disabled="verifyingService">{{ verifyingService?'驗證中…':'驗證 eService' }}</button>
</div>
</div>
<button class="ui-next-primary" @click="save" :disabled="saving">{{ saving?'儲存中…':'儲存連線設定' }}</button>
</section>
</div>
</section>`,
  });

  // 以已核可預覽的資訊密度重做專案清單；所有既有專案操作仍直接使用 ProjectListView methods。
  window.UiNextProjectListView = Vue.defineComponent({
    name: "UiNextProjectListView",
    components: { ReleaseModal: window.ReleaseModal, UiNextIcon: window.UiNextIcon },
    data: window.ProjectListView.data,
    computed: window.ProjectListView.computed,
    async created() {
      await window.ProjectListView.created.call(this);
    },
    methods: window.ProjectListView.methods,
    template: `
      <section class="ui-next-page ui-next-project-page">
<header class="ui-next-page-head">
<div>
<p class="ui-next-eyebrow">工作區</p>
<h1>專案</h1>
<p>管理程式庫、測試環境、對話與交付流程。</p>
</div>
<button class="ui-next-primary" @click="showAddForm=!showAddForm">{{ showAddForm?'取消':'新增專案' }}</button>
</header>
<section v-if="showAddForm" class="ui-next-project-create">
<input v-model="newProject.name" placeholder="專案名稱">
<input v-model="newProject.folder_name" placeholder="英文資料夾名稱">
<input v-model="newProject.odoo_version" placeholder="Odoo 版本，例如 17.0">
<textarea v-model="newProject.description" placeholder="專案描述（選填）">
</textarea>
<select v-model="newProject.edition">
<option value="community">Community</option>
<option value="enterprise">Enterprise</option>
</select>
<button class="ui-next-primary" @click="add" :disabled="saving">{{ saving?'建立中…':'建立專案' }}</button>
</section>
<div class="ui-next-project-search">
<input v-model="search" placeholder="搜尋專案名稱、版本或說明…">
<span>{{ filteredProjects.length }} 個專案</span>
</div>
<div v-if="loading" class="ui-next-loading-card">載入專案中…</div>
<template v-else>
<div class="ui-next-project-grid ui-next-project-grid-rich">
<article v-for="project in filteredProjects" :key="project.id">
<header>
<button @click="toggleFavorite(project)" :class="{active:project.is_favorite}" :title="project.is_favorite?'取消我的最愛':'加入我的最愛'">★</button>
<span>Odoo {{ project.odoo_version }} · {{ project.edition==='enterprise'?'企業版':'社群版' }}</span>
</header>
<button class="ui-next-project-open" @click="go(project.id)">
<span class="ui-next-project-folder"><ui-next-icon name="project"/></span>
<h2>{{ project.name }}</h2>
<p>{{ project.description || '尚未填寫專案描述。' }}</p>
</button>
<div class="ui-next-project-facts">
<span>{{ project.repo_count || 0 }} 個 Repo</span>
<span>{{ unread(project.id) ? unread(project.id)+' 則未讀 Chat' : '所有對話已讀' }}</span>
<span>{{ project.folder_name || '尚未設定資料夾' }}</span>
</div>
<footer>
<button @click="goChat(project.id)">問答</button>
<button @click="openEnv(project.id)">測試區</button>
<button @click="goWiki(project.id)">Wiki</button>
<button @click="go(project.id)">管理</button>
</footer>
</article>
<p v-if="!filteredProjects.length" class="ui-next-empty-state">找不到符合的專案。</p>
</div>
<section class="ui-next-project-context">
<article class="ui-next-panel">
<h2>專案工作原則</h2>
<p>對話、任務、Repo 與測試環境都歸屬於同一個專案；用專案取代傳統資料夾，才能讓開發脈絡連續。</p>
</article>
<article class="ui-next-panel">
<h2>快捷操作</h2>
<div>
<button @click="showAddForm=true">新增專案</button>
<button @click="$router.push('/tasks')">查看所有任務</button>
</div>
</article>
</section>
</template>
<ReleaseModal v-if="releaseId" :key="releaseId" :project-id="releaseId" @close="releaseId=null" />
</section>`,
  });

  // 任務清單恢復預覽中的摘要、篩選、批次與流程列，操作直接沿用原始 View。
  window.UiNextTaskListView = Vue.defineComponent({
    name: "UiNextTaskListView",
    components: window.TaskListView.components,
    data: window.TaskListView.data,
    computed: {
      ...window.TaskListView.computed,
      doneCount() {
        return this.tasks.filter((t) => t.status === "done").length;
      },
      activeCount() {
        return this.tasks.filter(
          (t) => !t.is_paused && t.status !== "done" && !this.needsAction(t),
        ).length;
      },
    },
    watch: window.TaskListView.watch,
    async created() {
      await window.TaskListView.created.call(this);
    },
    mounted() {
      window.TaskListView.mounted.call(this);
    },
    beforeUnmount() {
      window.TaskListView.beforeUnmount.call(this);
    },
    methods: window.TaskListView.methods,
    template: `
      <section class="ui-next-page ui-next-task-page ui-next-task-page-rich">
<header class="ui-next-page-head">
<div>
<p class="ui-next-eyebrow">工作區</p>
<h1>任務列表</h1>
<p>跨專案追蹤開發、澄清與交付進度。</p>
</div>
<div class="ui-next-head-tools">
<button @click="toggleBatchMode">{{ batchMode?'取消批次':'批次' }}</button>
<button @click="syncNow" :disabled="syncing">{{ syncing?'同步中…':'同步' }}</button>
<button class="ui-next-primary" @click="openAdd">建立任務</button>
</div>
</header>
<section v-if="showAdd" class="ui-next-task-create">
<select v-model="newTask.project_id">
<option value="">選擇專案</option>
<option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
</select>
<input v-model="newTask.title" placeholder="任務標題">
<textarea v-model="newTask.original_text" placeholder="需求描述">
</textarea>
<label>附件<input type="file" multiple @change="onAddFilesSelected">
</label>
<button class="ui-next-primary" @click="submitAdd" :disabled="adding">{{ adding?'建立中…':'建立任務' }}</button>
</section>
<div class="ui-next-task-summary-grid">
<article>
<small>進行中</small>
<b>{{ activeCount }}</b>
<span>Pipeline 自動推進</span>
</article>
<article>
<small>等待處理</small>
<b>{{ needsActionCount }}</b>
<span>需要你的回覆</span>
</article>
<article>
<small>本頁完成</small>
<b>{{ doneCount }}</b>
<span>已結案任務</span>
</article>
<article>
<small>已暫停</small>
<b>{{ pausedShown }}</b>
<span>可隨時恢復</span>
</article>
</div>
<div class="ui-next-task-tabs">
<button v-for="item in [['needs_action','需回覆',needsActionShown],['pending','待處理',pendingShown],['paused','暫停中',pausedShown],['all','全部',allShown],['archived','已封存','']]" :key="item[0]" :class="{active:filter===item[0]}" @click="filter=item[0]">{{ item[1] }} <b v-if="item[2]!==''">{{ item[2] }}</b>
</button>
</div>
<div class="ui-next-task-toolbar">
<input v-model="search" placeholder="搜尋標題、任務 ID、專案或來源…">
<button @click="filtersOpen=!filtersOpen">篩選 <b v-if="activeFilterCount">{{ activeFilterCount }}</b>
</button>
<select v-model="sort">
<option value="updated_desc">最近更新</option>
<option value="created_desc">最新建立</option>
<option value="title_asc">標題 A→Z</option>
<option value="status_asc">依狀態</option>
</select>
</div>
<div v-if="filtersOpen" class="ui-next-task-filters">
<select v-model="projectFilter">
<option value="">全部專案</option>
<option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
</select>
<select v-model="statusFilter">
<option value="">全部狀態</option>
<option v-for="(label,status) in window.STATUS_LABELS" :key="status" :value="status">{{ label }}</option>
</select>
<select v-model="sourceFilter">
<option value="">全部來源</option>
<option value="odoo">Odoo</option>
<option value="service">eService</option>
<option value="manual">手動增加</option>
</select>
<select v-model="releaseFilter">
<option value="all">全部（上正式）</option>
<option value="released">已上正式</option>
<option value="pending_release">待上正式</option>
</select>
<button @click="clearFilters">清除篩選</button>
</div>
<div v-if="batchMode" class="ui-next-batch-bar">
<label>
<input type="checkbox" :checked="allSelected" @change="toggleSelectAll"> 全選</label>
<span>已選 {{ selectedIds.length }} 筆</span>
<button @click="batchPause" :disabled="batchWorking||!selectedIds.length">暫停</button>
<button @click="batchArchive" :disabled="batchWorking||!selectedIds.length">封存</button>
<button class="danger" @click="batchDelete" :disabled="batchWorking||!selectedIds.length">刪除</button>
</div>
<div v-if="loading" class="ui-next-loading-card">載入任務中…</div>
<div v-else class="ui-next-task-rich-list">
<article v-for="task in filteredTasks" :key="task.id" :class="{selected:selectedIds.includes(task.id),need:needsAction(task)&&!task.is_paused}" @click="batchMode?toggleSelect(task.id,$event):openTask(task)">
<div class="ui-next-task-rich-head">
<label v-if="batchMode">
<input type="checkbox" :checked="selectedIds.includes(task.id)" @click.stop="toggleSelect(task.id,$event)">
</label>
<div>
<h2>{{ task.title||task.task_id }}</h2>
<p>{{ sourceLabel(task.source) }} · {{ task.project_name||'未分類專案' }} · {{ timeAgo(task.updated_at||task.created_at) }}</p>
</div>
<div>
<button v-if="!batchMode&&!isStopped(task)&&task.status!=='done'" @click.stop="togglePause(task,$event)">{{ task.is_paused?'恢復':'暫停' }}</button>
<span>{{ statusLabel(task.status) }}</span>
</div>
</div>
<div class="ui-next-task-rich-meta">
<span>{{ sourceLabel(task.source) }}</span>
<span v-if="task.env_status">測試機</span>
<span v-if="task.merged_to_main_at">已上正式</span>
<span v-if="task.module">{{ task.module }}</span>
</div>
<StatusBar :status="task.status" :source="task.source" :git-branch="task.git_branch" :e2e-disabled="task.e2e_disabled" />
</article>
<p v-if="!filteredTasks.length" class="ui-next-empty-state">此條件下沒有任務。</p>
</div>
</section>`,
  });

  window.UiNextProjectDetailPreviewFallback = Vue.defineComponent({
    name: "UiNextProjectDetailPreviewFallback",
    components: {
      SearchableSelect: window.SearchableSelect,
      ReleaseModal: window.ReleaseModal,
    },
    data() {
      return { ...window.ProjectDetailView.data(), detailTab: "overview" };
    },
    computed: window.ProjectDetailView.computed,
    watch: window.ProjectDetailView.watch,
    async created() {
      await window.ProjectDetailView.created.call(this);
    },
    beforeUnmount() {
      window.ProjectDetailView.beforeUnmount.call(this);
    },
    methods: window.ProjectDetailView.methods,
    template: `<section v-if="loading" class="ui-next-page">
<div class="ui-next-loading-card">載入專案中…</div>
</section>
<section v-else-if="project" class="ui-next-page ui-next-project-detail">
<header class="ui-next-page-head ui-next-detail-head">
<div>
<button class="ui-next-back" @click="$router.push('/projects')">← 所有專案</button>
<p class="ui-next-eyebrow">專案工作區</p>
<h1>{{ project.name }}</h1>
<p>{{ project.description||'集中管理程式庫、測試環境與交付流程。' }}</p>
</div>
<div class="ui-next-detail-actions">
<button @click="goChat">Chat</button>
<button @click="goWiki">Wiki</button>
<button @click="goDeploySop">部署 SOP</button>
<button @click="showReleaseModal=true" :disabled="!repos.some(r=>r.clone_status==='done')">上正式</button>
</div>
</header>
<div class="ui-next-project-statbar">
<span>Odoo {{ project.odoo_version }}</span>
<span>{{ editEdition==='enterprise'?'企業版':'社群版' }}</span>
<span>{{ repos.length }} 個 Repo</span>
<span>{{ {idle:'環境未建立',setting_up:'環境建立中',running:'環境運行中',error:'環境錯誤'}[env&&env.status]||'環境未建立' }}</span>
</div>
<nav class="ui-next-detail-tabs">
<button v-for="tab in [['overview','總覽'],['repos','Repo'],['env','測試環境'],['settings','設定']]" :key="tab[0]" :class="{active:detailTab===tab[0]}" @click="detailTab=tab[0]">{{ tab[1] }}</button>
</nav>
<section v-if="detailTab==='overview'" class="ui-next-detail-overview">
<article class="ui-next-panel">
<h2>Repo 概況</h2>
<p>{{ repos.length }} 個程式庫；{{ repos.filter(r=>r.clone_status==='done').length }} 個已同步。</p>
<button @click="detailTab='repos'">管理 Repo</button>
</article>
<article class="ui-next-panel">
<h2>測試環境</h2>
<p>{{ {idle:'尚未建立',setting_up:'建立中',running:'運行中',error:'發生錯誤'}[env&&env.status]||'尚未建立' }}</p>
<button @click="detailTab='env'">管理測試環境</button>
</article>
<article class="ui-next-panel">
<h2>專案工具</h2>
<button @click="$router.push('/projects/'+project.id+'/db')">資料庫查詢</button>
<button v-if="!project.has_wiki" @click="initWiki">初始化 Wiki</button>
</article>
</section>
<section v-if="detailTab==='repos'" class="ui-next-panel ui-next-repos">
<div class="ui-next-card-title">
<h2>Git Repositories</h2>
</div>
<article v-for="repo in repos" :key="repo.id" class="ui-next-repo-row">
<div>
<div class="ui-next-repo-name">
<b>{{ repo.label }}</b>
<span v-if="repo.is_primary">主要</span>
<em :class="repo.clone_status">{{ {cloning:'同步中',done:'已同步',error:'同步失敗'}[repo.clone_status] }}</em>
</div>
<p>{{ repo.repo_url }}</p>
<small>主分支：{{ (branchInfo[repo.id]&&branchInfo[repo.id].effective)||repo.base_branch||'自動偵測' }}</small>
</div>
<div class="ui-next-repo-actions">
<button v-if="repo.clone_status==='done'" @click="updateRepo(repo.id)">更新</button>
<button v-if="repo.clone_status==='error'" @click="reclone(repo.id)">重新同步</button>
<button class="danger" @click="removeRepo(repo.id)" :disabled="envActive||repo.clone_status==='cloning'">移除</button>
</div>
</article>
<form class="ui-next-add-repo" @submit.prevent="addRepo">
<input v-model="newRepo.label" placeholder="標籤，例如 main">
<input v-model="newRepo.repo_url" placeholder="Git URL" @blur="probeRemoteBranches">
<SearchableSelect v-if="remoteBranches.length" :model-value="newRepo.base_branch" :options="remoteBranches.map(b=>({value:b,label:b}))" all-label="自動偵測" placeholder="主分支" @update:modelValue="v=>newRepo.base_branch=v||''"/>
<span v-else>主分支自動偵測</span>
<label>
<input type="checkbox" v-model="newRepo.is_primary"> 主要 Repo</label>
<button class="ui-next-primary" :disabled="savingRepo||probingBranches">新增 Repo</button>
</form>
</section>
<section v-if="detailTab==='env'" class="ui-next-panel ui-next-env-tab">
<h2>Odoo 測試環境</h2>
<p>{{ {idle:'尚未建立',setting_up:'建立中',running:'運行中',error:'發生錯誤'}[env&&env.status]||'尚未建立' }}</p>
<p v-if="env&&env.error_msg" class="ui-next-error-text">{{ env.error_msg }}</p>
<div class="ui-next-env-actions">
<button v-if="!env||env.status==='idle'||env.status==='error'" class="ui-next-primary" @click="setupEnv" :disabled="envWorking">{{ envWorking?'處理中…':(env&&env.built?'重新啟動':'建立環境') }}</button>
<button v-if="env&&env.status==='running'" class="ui-next-primary" @click="openEnv">開啟測試區</button>
<button v-if="env&&env.status==='running'" @click="stopEnv">停止</button>
<button v-if="env&&(env.built||env.status!=='idle')" @click="viewLog">查看 log</button>
<button v-if="env&&(env.built||env.status!=='idle')" class="danger" @click="deleteEnv">刪除環境</button>
</div>
<details v-if="runtimeLog!==null">
<summary>Odoo 運行記錄</summary>
<pre>{{ runtimeLog }}</pre>
</details>
</section>
<section v-if="detailTab==='settings'" class="ui-next-project-settings">
<div class="ui-next-panel">
<h2>同步來源對應</h2>
<label>Odoo 專案名稱<textarea v-model="editOdooProjectName">
</textarea>
</label>
<label>客服來源名稱<textarea v-model="editServiceRespondentName">
</textarea>
</label>
<button class="ui-next-primary" @click="saveProjectMapping">儲存對應</button>
</div>
<div v-if="isAdmin()" class="ui-next-panel">
<h2>測試流程</h2>
<label class="ui-next-toggle">
<input type="checkbox" v-model="editE2eEnabled" @change="saveE2eSetting">
<span>
</span>{{ editE2eEnabled?'E2E 測試啟用中':'已停用 E2E 測試' }}</label>
<hr>
<h2>Odoo 版本類型</h2>
<select v-model="editEdition" @change="saveEdition">
<option value="community">社群版（Community）</option>
<option value="enterprise">企業版（Enterprise）</option>
</select>
</div>
</section>
<ReleaseModal v-if="showReleaseModal" :project-id="$route.params.id" @close="showReleaseModal=false" />
</section>`,
  });
  // Wiki 的樹狀導覽、編輯、防呆與即時建立進度均沿用既有資料流程，只重做頁面層級。
  window.UiNextWikiView = Vue.defineComponent({
    name: "UiNextWikiView",
    components: { "wiki-node": window.WikiNode },
    data: window.WikiView.data,
    computed: window.WikiView.computed,
    watch: window.WikiView.watch,
    async created() {
      await window.WikiView.created.call(this);
    },
    mounted() {
      window.WikiView.mounted.call(this);
    },
    beforeUnmount() {
      window.WikiView.beforeUnmount.call(this);
    },
    methods: window.WikiView.methods,
    template: `
      <section class="ui-next-page ui-next-wiki-page">
        <header class="ui-next-page-head"><div><button class="ui-next-back" @click="$router.push('/projects/'+$route.params.id)">← 返回專案</button><p class="ui-next-eyebrow">專案知識庫</p><h1>Wiki</h1><p>集中人工備註、模組文件與 AI 產生的排障結論。</p></div><div class="ui-next-detail-actions"><button v-if="canBuild" class="ui-next-primary" @click="buildWiki" :disabled="building">{{ building?'建立中…':'建立 Wiki' }}</button><button @click="openAddPage">新增頁面</button></div></header>
        <section v-if="building" class="ui-next-panel ui-next-wiki-progress"><div><b>{{ progress.message||'建立中…' }}</b><span>{{ progress.percent }}%</span></div><i><em :style="{width:progress.percent+'%'}"></em></i></section>
        <div class="ui-next-wiki-layout"><aside class="ui-next-panel ui-next-wiki-tree"><div class="ui-next-card-title"><h2>頁面</h2><span>{{ pages.length }}</span></div><p v-if="loading" class="ui-next-empty-inline">載入中…</p><div v-else-if="loadError" class="ui-next-error-text">頁面清單載入失敗：{{ loadError }}<button @click="loadPages">重試</button></div><template v-else><wiki-node v-for="node in tree" :key="node.id" :node="node" :depth="0" :current-slug="current&&current.slug" :refreshing="refreshing" :editing-slug="editingSlug" @open="loadPage" @refresh="refreshNode" @remove="removePage"/><p v-if="!pages.length" class="ui-next-empty-inline">尚無頁面。</p></template></aside><main class="ui-next-panel ui-next-wiki-content"><template v-if="current"><header><div><p class="ui-next-eyebrow">{{ current.node_type==='notes'?'人工維護':'文件頁' }}</p><h2>{{ current.title }}</h2></div><div><button v-if="current.node_type!=='notes'&&!editing" @click="editing=true;editContent=current.content">編輯</button><button v-if="editing||current.node_type==='notes'" class="ui-next-primary" @click="save" :disabled="saving">{{ saving?'儲存中…':'儲存' }}</button><button v-if="editing&&current.node_type!=='notes'" @click="editing=false">取消</button></div></header><p v-if="current.node_type==='notes'" class="ui-next-field-note">這裡的內容會提供給 AI 作為專案優先脈絡。</p><textarea v-if="editing||current.node_type==='notes'" v-model="editContent" @input="editing=true"></textarea><article v-else class="ui-next-wiki-markdown" v-html="renderedContent"></article></template><div v-else class="ui-next-empty-state">選擇或建立一個頁面開始。</div></main></div>
        <div v-if="showAddModal" class="ui-next-task-modal-backdrop" @mousedown.self="showAddModal=false"><section class="ui-next-task-modal"><header><h2>新增頁面</h2><button @click="showAddModal=false">×</button></header><label>標題<input ref="newTitleInput" v-model="newPageTitle" @input="onTitleInput" @keyup.enter="submitAddPage" placeholder="例如：銷售訂單模組"></label><label>Slug<input v-model="newPageSlug" @input="onSlugInput" @keyup.enter="submitAddPage" placeholder="例如：sale-order"></label><footer><button @click="showAddModal=false">取消</button><button class="ui-next-primary" @click="submitAddPage" :disabled="addingPage||!newPageTitle.trim()||!newPageSlug.trim()">{{ addingPage?'新增中…':'新增' }}</button></footer></section></div>
      </section>`,
  });
  window.UiNextDeploySopView = Vue.defineComponent({
    name: "UiNextDeploySopView",
    data: window.DeploySopView.data,
    computed: window.DeploySopView.computed,
    async created() {
      await window.DeploySopView.created.call(this);
    },
    methods: window.DeploySopView.methods,
    template: `<section class="ui-next-page ui-next-sop-page"><header class="ui-next-page-head"><div><button class="ui-next-back" @click="$router.push('/projects/'+pid())">← 返回專案</button><p class="ui-next-eyebrow">交付工具</p><h1>自動部署 SOP</h1><p>將測試與正式環境的必要事實整理成可逐步驗證的部署流程。</p></div></header><div v-if="loading" class="ui-next-loading-card">載入專案設定中…</div><template v-else><section class="ui-next-panel"><h2>環境對應</h2><p class="ui-next-field-note">這些資料只用來生成下方指令，不會儲存；每次部署前都應重新確認。</p><div class="ui-next-sop-grid"><article v-for="side in sides" :key="side.key"><h3>{{ side.label }}</h3><label>連線<select v-model="side.d.connId" @change="onConnPick(side.key)"><option value="">— 請指認 —</option><option v-for="conn in conns" :key="conn.id" :value="conn.id">{{ conn.name }}（{{ conn.db_name }}）</option></select></label><p v-if="side.conn">資料庫：{{ dbOf(side.conn) }}</p><label>systemd 服務名<input v-model="side.d.service" placeholder="odoo.service"></label><label>設定檔路徑<input v-model="side.d.conf" placeholder="/etc/odoo.conf"></label><label>目前 addons 路徑<input v-model="side.d.addons" placeholder="/odoo/custom/addons"></label><label>HTTP port<input v-model="side.d.port"></label></article></div><p v-if="sameConn" class="ui-next-error-text">正式區與測試區不能使用同一個連線，請先分開指認。</p></section><section class="ui-next-panel"><h2>Repo 與分支</h2><div class="ui-next-sop-fields"><label>Repo URL<input v-model="repoUrl"></label><label>自訂模組名稱<input v-model="addon"></label><label>測試分支<input v-model="branchTest"></label><label>正式分支<input v-model="branchProd"></label></div></section><section class="ui-next-panel ui-next-sop-steps"><article v-for="step in [['1','查出伺服器現況',cmdInspect],['2','備份與比對既有 addons',cmdBackup],['3','建立 Git 部署目錄',cmdAttachGit],['4','設定 GitHub Runner',cmdRunner],['5','最小權限 sudo',cmdSudoers],['6','部署 workflow',deployYaml],['7','驗證測試區',cmdVerify]]" :key="step[0]"><header><span>{{ step[0] }}</span><h2>{{ step[1] }}</h2><button @click="copy(step[2])">複製</button></header><pre>{{ step[2] }}</pre></article></section></template></section>`,
  });
  window.UiNextDiagramView = Vue.defineComponent({
    name: "UiNextDiagramView",
    props: { type: { type: String, required: true } },
    components: {
      ArchitectureView: window.ArchitectureView,
      PipelineFlowView: window.PipelineFlowView,
    },
    computed: {
      isArchitecture() {
        return this.type === "architecture";
      },
      title() {
        return this.isArchitecture ? "系統地景圖" : "Pipeline 流程圖";
      },
      description() {
        return this.isArchitecture
          ? "查看平台、外部來源、程式庫與測試環境之間的關係。"
          : "查看任務從需求進入到部署交付的完整路徑。";
      },
    },
    template: `<section class="ui-next-page ui-next-diagram-page"><header class="ui-next-page-head"><div><p class="ui-next-eyebrow">系統導覽</p><h1>{{ title }}</h1><p>{{ description }}</p></div><span class="ui-next-diagram-hint">可點選圖中節點查看說明</span></header><section class="ui-next-diagram-panel"><ArchitectureView v-if="isArchitecture"/><PipelineFlowView v-else/></section></section>`,
  });
  window.UiNextAdminView = Vue.defineComponent({
    name: "UiNextAdminView",
    components: { AdminView: window.AdminView },
    template: `<section class="ui-next-page ui-next-admin-page"><header class="ui-next-page-head"><div><p class="ui-next-eyebrow">系統維運</p><h1>管理員設定</h1><p>管理平台連線、AI 訂閱、用量閘門與維運工具。</p></div></header><section class="ui-next-admin-legacy"><AdminView/></section></section>`,
  });
  window.UiNextAdminToolView = Vue.defineComponent({
    name: "UiNextAdminToolView",
    props: { title: String, description: String, view: Object },
    template: `<section class="ui-next-page ui-next-admin-page"><header class="ui-next-page-head"><div><p class="ui-next-eyebrow">系統維運</p><h1>{{ title }}</h1><p>{{ description }}</p></div><button @click="$router.push('/admin')">返回管理員</button></header><section class="ui-next-admin-legacy"><component :is="view"/></section></section>`,
  });
  window.UiNextToolFrame = Vue.defineComponent({
    name: "UiNextToolFrame",
    props: { title: String, description: String, back: String, view: Object },
    template: `<section class="ui-next-page ui-next-tool-page"><header class="ui-next-page-head"><div><p class="ui-next-eyebrow">專案工具</p><h1>{{ title }}</h1><p>{{ description }}</p></div><button @click="$router.push(back==='project'?'/projects/'+$route.params.id:back)">返回</button></header><section class="ui-next-tool-legacy"><component :is="view"/></section></section>`,
  });
})();
