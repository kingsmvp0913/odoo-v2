(function () {
  const fmtNumber = value => Number(value || 0).toLocaleString('zh-TW');
  const fmtCompact = value => {
    const n = Number(value || 0);
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K`;
    return String(Math.round(n));
  };
  const fmtUSD = value => {
    const n = Number(value || 0);
    if (n >= 1000) return `$${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    if (n >= 1) return `$${n.toFixed(2)}`;
    return n ? `$${n.toFixed(4)}` : '$0';
  };
  const elapsed = value => {
    const seconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)} 小時 ${Math.floor(seconds % 3600 / 60)} 分`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    return `${seconds} 秒`;
  };
  const usageLevel = pct => pct >= 90 ? 'critical' : pct >= 70 ? 'warning' : 'healthy';

  window.UiNextTokenReportView = Vue.defineComponent({
    name: 'UiNextTokenReportView',
    data() {
      return {
        loading: true, report: null, projects: [], labels: {}, expanded: {},
        claudeUsage: null, codexUsage: null,
        filters: { range: '30', start: '', end: '', project_id: '', task_id: '', showAll: false }
      };
    },
    computed: {
      dateRange() {
        const now = new Date(), end = now.toISOString().slice(0, 10);
        if (this.filters.range === 'today') { const start = new Date(now); start.setHours(0, 0, 0, 0); return { start: start.toISOString(), end: now.toISOString() }; }
        if (this.filters.range === '7') { const start = new Date(now); start.setDate(start.getDate() - 7); return { start: start.toISOString().slice(0, 10), end }; }
        if (this.filters.range === '30') { const start = new Date(now); start.setDate(start.getDate() - 30); return { start: start.toISOString().slice(0, 10), end }; }
        return { start: this.filters.start, end: this.filters.end };
      },
      quotaRows() {
        const rows = [];
        const claude = this.claudeUsage || {};
        [['Claude · 5 小時', claude.five_hour], ['Claude · 本週', claude.seven_day]].forEach(([label, item]) => {
          if (item && item.utilization != null) rows.push({ label, used: Math.round(item.utilization), note: `${Math.round(item.utilization)}% 已使用` });
        });
        const codex = this.codexUsage || {};
        [['Codex · 主要額度', codex.primary], ['Codex · 週額度', codex.secondary]].forEach(([label, item]) => {
          if (item && item.used_percent != null) rows.push({ label, used: Math.round(item.used_percent), note: `剩 ${Math.round(item.remaining_percent)}%` });
        });
        return rows;
      },
      summaryCards() {
        const s = this.report && this.report.summary;
        if (!s) return [];
        return [
          ['實際花費', fmtUSD(s.cost_usd), '本期間累計'], ['完成任務', fmtNumber(s.done_tasks), '已完成交付'],
          ['每張交付成本', fmtUSD(s.avg_cost_per_task), '平均成本'], ['實際 Token', fmtCompact(s.actual_tokens), '扣除 Cache 後']
        ];
      },
      trendPoints() {
        const rows = (this.report && this.report.daily) || [];
        if (rows.length < 2) return '';
        const max = Math.max(...rows.map(row => Number(row.tokens || 0)), 1);
        return rows.map((row, index) => `${8 + index * (284 / (rows.length - 1))},${80 - Number(row.tokens || 0) / max * 66}`).join(' ');
      }
    },
    async created() {
      const [projects, labels, claude, codex] = await Promise.all([
        Api.get('projects').catch(() => []), Api.get('agents/labels').catch(() => ({})),
        Api.get('claude-usage').catch(() => null), Api.get('codex-usage').catch(() => null)
      ]);
      this.projects = projects; this.labels = labels; this.claudeUsage = claude; this.codexUsage = codex;
      await this.load();
    },
    methods: {
      fmtNumber, fmtCompact, fmtUSD, usageLevel,
      agentLabel(type) { return this.labels[type] || type; },
      toggle(key) { this.expanded[key] = !this.expanded[key]; },
      taskLink(task) {
        if (!task.linkable) return '';
        return task.kind === 'chat' ? `/projects/${task.project_id}/chat/${task.chat_id}` : (task.task_row_id != null ? `/task/${task.task_row_id}` : '');
      },
      async load() {
        this.loading = true;
        try {
          const p = new URLSearchParams(), range = this.dateRange;
          if (range.start) p.set('start', range.start); if (range.end) p.set('end', range.end);
          if (this.filters.project_id) p.set('project_id', this.filters.project_id);
          if (this.filters.task_id) p.set('task_id', this.filters.task_id);
          if (this.filters.showAll) p.set('all', 'true');
          this.report = await Api.get(`token-report?${p}`);
        } catch (error) { showToast(error.message || '無法載入用量報表', 'error'); }
        finally { this.loading = false; }
      }
    },
    template: `
      <section class="ui-next-page ui-next-usage-page">
        <header class="ui-next-page-head"><div><p class="ui-next-eyebrow">分析工具</p><h1>用量報表</h1><p>查看額度、成本與交付品質；篩選只影響下方分析資料。</p></div></header>
        <div class="ui-next-filterbar"><select v-model="filters.range"><option value="today">今天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="custom">自訂期間</option></select><template v-if="filters.range==='custom'"><input v-model="filters.start" type="date"><span>至</span><input v-model="filters.end" type="date"></template><select v-model="filters.project_id"><option value="">全部專案</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select><input v-model="filters.task_id" placeholder="任務 ID"><label><input v-model="filters.showAll" type="checkbox"> 全部使用者</label><button class="ui-next-primary" @click="load" :disabled="loading">{{ loading ? '更新中…' : '更新報表' }}</button></div>
        <div class="ui-next-quota-card"><div class="ui-next-card-title"><div><h2>目前額度</h2><p>顏色只用於額度狀態提醒。</p></div></div><div class="ui-next-quota-list"><div v-for="row in quotaRows" :key="row.label"><div><b>{{ row.label }}</b><span>{{ row.note }}</span></div><i><em :class="usageLevel(row.used)" :style="{width:row.used+'%'}"></em></i></div><p v-if="!quotaRows.length" class="ui-next-empty-inline">目前無法取得訂閱額度。</p></div></div>
        <template v-if="loading"><div class="ui-next-loading-card">載入報表中…</div></template><template v-else-if="report"><div class="ui-next-metric-grid"><article v-for="card in summaryCards" :key="card[0]"><span>{{ card[0] }}</span><strong>{{ card[1] }}</strong><small>{{ card[2] }}</small></article></div><div class="ui-next-usage-grid"><article class="ui-next-panel"><h2>每日趨勢</h2><svg viewBox="0 0 300 92" preserveAspectRatio="none" v-if="trendPoints"><polyline :points="trendPoints" fill="none" stroke="currentColor" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg><p v-else class="ui-next-empty-inline">本期間資料不足，尚無趨勢。</p></article><article class="ui-next-panel"><h2>依專案</h2><div class="ui-next-breakdown" v-for="row in report.by_project" :key="row.project_id"><span>{{ row.project_name }}</span><b>{{ fmtCompact(row.tokens) }}</b></div><p v-if="!report.by_project.length" class="ui-next-empty-inline">尚無專案資料。</p></article><article class="ui-next-panel"><h2>依 Agent</h2><div class="ui-next-breakdown" v-for="row in report.by_agent" :key="row.agent_type"><span>{{ agentLabel(row.agent_type) }}</span><b>{{ fmtCompact(row.tokens) }}</b></div><p v-if="!report.by_agent.length" class="ui-next-empty-inline">尚無 Agent 資料。</p></article></div><section class="ui-next-panel ui-next-usage-detail"><div class="ui-next-card-title"><div><h2>使用明細</h2><p>點選列可展開各 Agent 的模型、用量與耗時。</p></div><span>{{ report.tasks.length }} 筆</span></div><div class="ui-next-data-list"><article v-for="task in report.tasks.slice(0,100)" :key="task.ref_key" @click="toggle(task.ref_key)"><div><b>{{ task.title || task.task_id || '未命名項目' }}</b><span>{{ task.project_name || '未分類專案' }} · {{ task.username || '—' }}</span></div><div><strong>{{ fmtUSD(task.total_cost) }}</strong><span>{{ fmtCompact(task.total_tokens) }} Token</span></div><button type="button">{{ expanded[task.ref_key] ? '⌃' : '⌄' }}</button><div v-if="expanded[task.ref_key]" class="ui-next-detail-row"><router-link v-if="taskLink(task)" :to="taskLink(task)" @click.stop>前往來源</router-link><span v-for="agent in task.agents" :key="agent.agent_type + agent.model">{{ agentLabel(agent.agent_type) }}<template v-if="agent.model"> · {{ agent.model }}</template>：{{ fmtCompact(agent.tokens) }} / {{ fmtUSD(agent.cost) }}</span></div></article><p v-if="!report.tasks.length" class="ui-next-empty-inline">本期間無 Token 使用記錄。</p></div></section></template>
      </section>`
  });

  window.UiNextPipelineView = Vue.defineComponent({
    name: 'UiNextPipelineView',
    data() { return { rows: [], chats: [], loading: true, chatsError: false, pausingId: null, timer: null }; },
    async mounted() { await this.load(); this.timer = setInterval(() => this.load(), 3000); },
    beforeUnmount() { if (this.timer) clearInterval(this.timer); },
    methods: {
      elapsed,
      statusLabel(status) { return window.STATUS_LABELS[status] || status; },
      async load() { const [rows, chats] = await Promise.all([Api.get('admin/pipeline/active').catch(() => null), Api.get('admin/chat/active').catch(() => null)]); if (rows) this.rows = rows.sort((a,b) => b.elapsed_ms-a.elapsed_ms); if (chats) this.chats = chats; this.chatsError = chats === null; this.loading = false; },
      async pause(row) { if (!await confirmDialog({ title:'暫停行程', message:`確定暫停並中止「${row.title || row.task_id}」？`, danger:true, confirmText:'暫停並中止' })) return; this.pausingId=row.id; try { await Api.post(`admin/pipeline/tasks/${row.id}/pause`); await this.load(); showToast('已暫停行程','success'); } catch (error) { showToast(error.message,'error'); } finally { this.pausingId=null; } }
    },
    template: `
      <section class="ui-next-page ui-next-pipeline-page"><header class="ui-next-page-head"><div><p class="ui-next-eyebrow">即時監控</p><h1>進行中 Pipeline</h1><p>僅顯示真正執行中的任務與等待 AI 回覆的對話；每 3 秒更新一次。</p></div><span class="ui-next-live"><i></i>即時更新</span></header><div v-if="loading" class="ui-next-loading-card">讀取執行狀態中…</div><template v-else><div class="ui-next-pipeline-grid"><section class="ui-next-panel"><div class="ui-next-card-title"><div><h2>執行中的任務</h2><p>{{ rows.length }} 個行程</p></div></div><div class="ui-next-run-list"><article v-for="row in rows" :key="row.id"><div class="ui-next-run-stage"><i></i><span>{{ statusLabel(row.status) }}</span></div><div><b>{{ row.title || row.task_id }}</b><span>{{ row.project_name || '未分類專案' }} · {{ row.display_name || row.username || '—' }}</span></div><time>{{ elapsed(row.elapsed_ms) }}</time><div><router-link :to="'/task/'+row.id">查看</router-link><button @click="pause(row)" :disabled="pausingId===row.id">{{ pausingId===row.id ? '處理中…' : '暫停' }}</button></div></article><p v-if="!rows.length" class="ui-next-empty-state">目前沒有執行中的 Pipeline。</p></div></section><section class="ui-next-panel"><div class="ui-next-card-title"><div><h2>進行中的排障對話</h2><p>{{ chats.length }} 段對話</p></div></div><div class="ui-next-run-list"><article v-for="chat in chats" :key="chat.id"><div class="ui-next-run-stage is-chat"><i></i><span>AI 回覆中</span></div><div><b>{{ chat.title || '未命名對話' }}</b><span>{{ chat.project_name || '未分類專案' }} · {{ chat.display_name || chat.username || '—' }}</span></div><time>{{ elapsed(chat.waited_ms) }}</time><div><router-link :to="'/projects/'+chat.project_id+'/chat/'+chat.id">查看</router-link></div></article><p v-if="!chats.length" class="ui-next-empty-state">{{ chatsError ? '暫時無法讀取對話狀態。' : '目前沒有等待 AI 回覆的對話。' }}</p></div></section></div></template></section>`
  });

  // Chat 的資料操作完全沿用既有、已驗證的 methods（附件、貼上、未讀、轉任務、輪詢），只替換畫面結構。
  window.UiNextProjectChatView = Vue.defineComponent({
    name: 'UiNextProjectChatView',
    data() { return { ...window.ProjectChatView.data(), projectName: '專案', showNewChat: false }; },
    async created() {
      await window.ProjectChatView.created.call(this);
      const projects = await Api.get('projects').catch(() => []);
      const project = projects.find(item => String(item.id) === String(this.$route.params.id));
      this.projectName = project ? project.name : '專案';
    },
    beforeUnmount() { window.ProjectChatView.beforeUnmount.call(this); },
    methods: window.ProjectChatView.methods,
    template: `
      <section class="ui-next-chat-page">
        <aside class="ui-next-chat-rail"><div class="ui-next-chat-rail-head"><button @click="$router.push('/projects')">← 專案</button><h1>{{ projectName }}</h1><button class="ui-next-primary" @click="showNewChat=!showNewChat">＋ 新對話</button><div v-if="showNewChat" class="ui-next-new-chat"><input v-model="newTitle" placeholder="對話標題（選填）" @keyup.enter="createChat"><button @click="createChat">建立</button></div></div><div class="ui-next-chat-list"><button v-for="chat in chats" :key="chat.id" :class="{active:activeChat&&activeChat.id===chat.id}" @click="selectChat(chat)"><span><b>{{ chat.title || '新對話' }}</b><small v-if="chat.reply_pending">AI 回覆中</small></span><i v-if="chat.unread">{{ chat.unread }}</i><em v-if="chat.converted_task_id" @click.stop="$router.push('/task/'+chat.converted_task_id)">任務</em><button @click.stop="deleteChat(chat)" aria-label="刪除對話">×</button></button><p v-if="!chats.length">尚無對話，建立一段新的討論開始。</p></div></aside>
        <main class="ui-next-thread"><template v-if="activeChat"><header class="ui-next-thread-head"><div><p>{{ projectName }}</p><h2>{{ activeChat.title || '新對話' }}</h2></div><button @click="toTask" :disabled="draftingTask||sending">{{ draftingTask ? '摘要中…' : '建立任務' }}</button></header><div ref="messages" class="ui-next-thread-messages"><div v-if="loadingMsgs" class="ui-next-empty-state">載入訊息中…</div><article v-for="message in messages" :key="message.id" :class="message.role"><div class="ui-next-message" v-html="renderMd(message.content)" v-show="message.content"></div><div v-if="(message.attachments&&message.attachments.length)||(message.pending_previews&&message.pending_previews.length)" class="ui-next-message-files"><img v-for="attachment in (message.attachments||[])" :key="attachment.id" v-show="attachUrls[attachment.id]" :src="attachUrls[attachment.id]" :alt="attachment.filename" @click="openImage(attachment.id)"><img v-for="(url,index) in (message.pending_previews||[])" :key="'pending'+index" :src="url"></div><small>{{ message.role==='user' ? '你' : 'OAA' }} · {{ formatTime(message.created_at) }}</small></article><div v-if="sending||replyPending" class="ui-next-ai-thinking"><i></i><i></i><i></i> OAA 正在處理</div></div><div v-if="pendingPreviews.length" class="ui-next-pending-files"><span v-for="(url,index) in pendingPreviews" :key="url"><img :src="url"><button @click="removePendingFile(index)">×</button></span></div><form class="ui-next-thread-composer" @submit.prevent="send"><input ref="chatFileInput" type="file" accept="image/*" multiple @change="onFilesSelected"><button type="button" @click="$refs.chatFileInput.click()" title="上傳圖片">⌕</button><textarea v-model="newInput" placeholder="輸入訊息… Enter 送出，Shift + Enter 換行；也可直接貼上截圖。" @paste="onPaste" @keydown.enter="handleEnter"></textarea><button class="ui-next-thread-send" :disabled="sending||(!newInput.trim()&&!pendingFiles.length)">{{ sending ? '…' : '↑' }}</button></form></template><div v-else class="ui-next-thread-empty"><div>✦</div><h2>選擇一段對話</h2><p>或建立新對話，討論會保留在「{{ projectName }}」專案中。</p></div></main>
        <div v-if="showTaskModal" class="ui-next-task-modal-backdrop" @mousedown.self="showTaskModal=false"><section class="ui-next-task-modal"><header><h2>建立任務</h2><button @click="showTaskModal=false">×</button></header><label>標題<input v-model="taskDraft.title" placeholder="任務標題"></label><label>需求內容<textarea v-model="taskDraft.original_text" placeholder="需求描述"></textarea></label><div v-if="taskDraft.attachments&&taskDraft.attachments.length" class="ui-next-task-attachments"><label v-for="attachment in taskDraft.attachments" :key="attachment.id"><input type="checkbox" v-model="attachment.chosen"> {{ attachment.filename }}</label></div><footer><button @click="showTaskModal=false">取消</button><button class="ui-next-primary" @click="submitTask" :disabled="creatingTask">{{ creatingTask?'建立中…':'建立任務' }}</button></footer></section></div>
      </section>`
  });

  window.UiNextProjectListView = Vue.defineComponent({
    name: 'UiNextProjectListView',
    data: window.ProjectListView.data,
    computed: window.ProjectListView.computed,
    async created() { await window.ProjectListView.created.call(this); },
    methods: window.ProjectListView.methods,
    template: `
      <section class="ui-next-page ui-next-project-page"><header class="ui-next-page-head"><div><p class="ui-next-eyebrow">工作區</p><h1>專案</h1><p>每段對話、任務與環境都歸屬於一個專案。</p></div><button class="ui-next-primary" @click="showAddForm=!showAddForm">{{ showAddForm?'取消':'新增專案' }}</button></header><section v-if="showAddForm" class="ui-next-project-create"><input v-model="newProject.name" placeholder="專案名稱"><input v-model="newProject.folder_name" placeholder="英文資料夾名稱"><input v-model="newProject.odoo_version" placeholder="Odoo 版本，例如 17.0"><textarea v-model="newProject.description" placeholder="專案描述（選填）"></textarea><select v-model="newProject.edition"><option value="community">Community</option><option value="enterprise">Enterprise</option></select><button class="ui-next-primary" @click="add" :disabled="saving">{{ saving?'建立中…':'建立專案' }}</button></section><div class="ui-next-project-search"><input v-model="search" placeholder="搜尋專案、版本或描述"><span>{{ filteredProjects.length }} 個專案</span></div><div v-if="loading" class="ui-next-loading-card">載入專案中…</div><div v-else class="ui-next-project-grid"><article v-for="project in filteredProjects" :key="project.id"><header><button @click="toggleFavorite(project)" :class="{active:project.is_favorite}" :title="project.is_favorite?'取消我的最愛':'加入我的最愛'">★</button><span>Odoo {{ project.odoo_version }}</span></header><button class="ui-next-project-open" @click="go(project.id)"><h2>{{ project.name }}</h2><p>{{ project.description || '尚未填寫專案描述。' }}</p></button><footer><span v-if="unread(project.id)">{{ unread(project.id) }} 則未讀</span><span v-else>所有對話已讀</span><div><button @click="goChat(project.id)">Chat</button><button @click="go(project.id)">管理</button></div></footer></article><p v-if="!filteredProjects.length" class="ui-next-empty-state">找不到符合的專案。</p></div></section>`
  });

  window.UiNextTaskListView = Vue.defineComponent({
    name: 'UiNextTaskListView',
    data: window.TaskListView.data,
    computed: window.TaskListView.computed,
    watch: window.TaskListView.watch,
    async created() { await window.TaskListView.created.call(this); },
    mounted() { window.TaskListView.mounted.call(this); },
    beforeUnmount() { window.TaskListView.beforeUnmount.call(this); },
    methods: {
      ...window.TaskListView.methods,
      statusLabel(status) { return window.STATUS_LABELS[status] || status; },
      timeAgo(value) {
        const diff = Date.now() - new Date(value).getTime();
        if (diff < 60000) return '剛剛';
        if (diff < 3600000) return `${Math.floor(diff / 60000)} 分鐘前`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小時前`;
        return `${Math.floor(diff / 86400000)} 天前`;
      },
      onFilesSelected(event) { this.onAddFilesSelected(event); }
    },
    template: `
      <section class="ui-next-page ui-next-task-page"><header class="ui-next-page-head"><div><p class="ui-next-eyebrow">工作區</p><h1>任務列表</h1><p>追蹤所有專案目前的開發、澄清與交付進度。</p></div><button class="ui-next-primary" @click="showAdd=!showAdd">{{ showAdd?'取消':'建立任務' }}</button></header><section v-if="showAdd" class="ui-next-task-create"><select v-model="newTask.project_id"><option value="">選擇專案</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select><input v-model="newTask.title" placeholder="任務標題"><textarea v-model="newTask.original_text" placeholder="需求描述"></textarea><label>附件<input type="file" multiple @change="onFilesSelected"></label><button class="ui-next-primary" @click="submitAdd" :disabled="adding">{{ adding?'建立中…':'建立任務' }}</button></section><div class="ui-next-task-controls"><div><button :class="{active:filter==='needs_action'}" @click="filter='needs_action'">需要處理 {{ needsActionShown }}</button><button :class="{active:filter==='pending'}" @click="filter='pending'">進行中 {{ pendingShown }}</button><button :class="{active:filter==='paused'}" @click="filter='paused'">已暫停 {{ pausedShown }}</button><button :class="{active:filter==='all'}" @click="filter='all'">全部 {{ allShown }}</button></div><input v-model="search" placeholder="搜尋任務、專案或來源"><select v-model="projectFilter"><option value="">全部專案</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></div><div v-if="loading" class="ui-next-loading-card">載入任務中…</div><div v-else class="ui-next-task-list"><router-link v-for="task in filteredTasks" :key="task.id" :to="'/task/'+task.id"><div><span :class="['ui-next-status-dot',task.status]"></span><div><h2>{{ task.title || task.task_id }}</h2><p>{{ task.project_name || '未分類專案' }} · {{ statusLabel(task.status) }}</p></div></div><div class="ui-next-task-meta"><span>{{ timeAgo(task.updated_at||task.created_at) }}</span><em v-if="task.is_paused">已暫停</em></div></router-link><p v-if="!filteredTasks.length" class="ui-next-empty-state">這個篩選條件下沒有任務。</p></div></section>`
  });
})();
