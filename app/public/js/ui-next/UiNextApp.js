(function () {
  const query = new URLSearchParams(window.location.search);
  window.UiNextEnabled = query.get("ui") === "next";

  function chatTitle(value) {
    const text = (value || "").trim().replace(/\s+/g, " ");
    return text.length > 28 ? `${text.slice(0, 28)}…` : text || "新對話";
  }

  const UiNextIcon = Vue.defineComponent({
    name: "UiNextIcon",
    props: { name: { type: String, required: true } },
    template: `<svg class="ui-next-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path v-if="name==='plus'" d="M12 5v14M5 12h14"/><path v-else-if="name==='search'" d="m20 20-4.2-4.2M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z"/>
      <path v-else-if="name==='chat'" d="M20 11a7 7 0 0 1-7 7H8l-4 3v-6a7 7 0 1 1 16-4Z"/><path v-else-if="name==='tasks'" d="M9 5h10M9 12h10M9 19h10M4 5l1 1 2-2m-3 8 1 1 2-2m-3 8 1 1 2-2"/>
      <path v-else-if="name==='project'" d="M3 7h7l2 2h9v10H3z"/><path v-else-if="name==='flow'" d="M6 5h12M6 12h12M6 19h12"/><circle v-else-if="name==='dots'" cx="6" cy="12" r="1" fill="currentColor"/><path v-else-if="name==='grid'" d="M5 5h5v5H5zm9 0h5v5h-5zM5 14h5v5H5zm9 0h5v5h-5z"/>
      <path v-else-if="name==='book'" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5zM4 5.5v16"/><path v-else-if="name==='chart'" d="M5 20v-8m7 8V4m7 16v-5"/>
      <path v-else-if="name==='paperclip'" d="m21 11.5-8.7 8.7a5 5 0 0 1-7.1-7.1l8.8-8.8a3.5 3.5 0 0 1 5 5l-8.8 8.8a2 2 0 0 1-2.8-2.8l8.1-8.1"/>
      <path v-else-if="name==='arrow-left'" d="m14 5-7 7 7 7M7 12h12"/>
      <path v-else-if="name==='chevron-down'" d="m6 9 6 6 6-6"/><path v-else-if="name==='chevron-up'" d="m6 15 6-6 6 6"/>
      <path v-else-if="name==='close'" d="M6 6l12 12M18 6 6 18"/><path v-else-if="name==='send'" d="m4 4 16 8-16 8 3-8-3-8Zm3 8h13"/>
      <path v-else-if="name==='check'" d="m5 12 4.2 4.2L19 6.5"/><path v-else-if="name==='alert'" d="M12 7v6m0 4h.01M10.2 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.8 3.9a2.1 2.1 0 0 0-3.6 0Z"/>
      <path v-else-if="name==='star'" d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>
    </svg>`,
  });
  window.UiNextIcon = UiNextIcon;

  window.UiNextQuestionView = Vue.defineComponent({
    name: "UiNextQuestionView",
    components: { UiNextIcon },
    data() {
      return {
        projects: [],
        projectId: "",
        prompt: "",
        files: [],
        environment: null,
        createdChatId: "",
        sendError: "",
        userName: "使用者",
        sending: false,
        loading: true,
      };
    },
    async created() {
      try {
        const [projects, me] = await Promise.all([
          Api.get("projects"),
          Api.get("auth/me"),
        ]);
        this.projects = projects || [];
        this.userName = me.display_name || me.username || "使用者";
        const lastProjectId = localStorage.getItem("oaa.next.last-project-id");
        this.projectId = this.projects.some((project) => String(project.id) === lastProjectId)
          ? lastProjectId
          : this.projects[0] ? String(this.projects[0].id) : "";
        await this.loadEnvironment();
      } catch (e) {
        showToast("無法載入專案清單", "error");
      } finally {
        this.loading = false;
      }
    },
    computed: {
      selectedProject() {
        return this.projects.find(
          (p) => String(p.id) === String(this.projectId),
        );
      },
    },
    methods: {
      async loadEnvironment() {
        if (!this.projectId) { this.environment = null; return; }
        this.environment = await Api.get(`projects/${this.projectId}/env`).catch(() => null);
      },
      onProjectChange() {
        localStorage.setItem("oaa.next.last-project-id", this.projectId);
        this.createdChatId = "";
        this.loadEnvironment();
      },
      chooseFiles(e) {
        const selected = Array.from(e.target.files || []);
        this.files = selected.filter((file) => /^image\//.test(file.type) && file.size <= 10 * 1024 * 1024).slice(0, 5);
        if (this.files.length !== selected.length) showToast("附件限圖片、單檔 10MB、最多 5 個", "error");
        e.target.value = "";
      },
      autoResize(event) {
        const textarea = event.currentTarget;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
      },
      removeFile(index) {
        this.files.splice(index, 1);
      },
      async send() {
        if (
          (!this.prompt.trim() && !this.files.length) ||
          !this.projectId ||
          this.sending
        )
          return;
        this.sending = true;
        this.sendError = "";
        try {
          const chat = this.createdChatId
            ? { id: this.createdChatId }
            : await Api.post(`projects/${this.projectId}/chats`, { title: chatTitle(this.prompt) });
          this.createdChatId = String(chat.id);
          const content = this.prompt.trim();
          if (this.files.length) {
            const form = new FormData();
            form.append("content", content);
            this.files.forEach((file) => form.append("files", file));
            await Api.postForm(
              `projects/${this.projectId}/chats/${chat.id}/messages`,
              form,
            );
          } else {
            await Api.post(
              `projects/${this.projectId}/chats/${chat.id}/messages`,
              { content },
            );
          }
          this.$router.push(`/projects/${this.projectId}/chat/${chat.id}`);
          this.createdChatId = "";
        } catch (e) {
          this.sendError = e.message || "無法送出訊息";
          showToast(this.sendError, "error", 0);
        } finally {
          this.sending = false;
        }
      },
    },
    template: `
      <section class="ui-next-question">
        <div class="ui-next-question-inner">
          <div class="ui-next-greeting">嗨，{{ userName }}</div>
          <h1>今天想從哪裡開始？</h1>
          <p>選擇專案後開始對話；系統會依內容自動建立標題並保留在該專案內。</p>
          <form class="ui-next-composer" @submit.prevent="send">
            <div v-if="files.length" class="ui-next-attachments">
              <span v-for="(file, index) in files" :key="file.name + index"><ui-next-icon name="paperclip"/>{{ file.name }} <button type="button" @click="removeFile(index)" aria-label="移除附件"><ui-next-icon name="close"/></button></span>
            </div>
            <textarea v-model="prompt" placeholder="詢問專案需求、流程問題，或描述你想完成的工作…" @input="autoResize" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send"></textarea>
            <p v-if="sendError" class="ui-next-inline-error">{{ sendError }} <button type="button" @click="send">重試</button></p>
            <div class="ui-next-composer-foot">
              <div class="ui-next-composer-options">
                <label class="ui-next-icon-button" title="上傳圖片"><ui-next-icon name="paperclip"/><input type="file" accept="image/*" multiple @change="chooseFiles"></label>
                <select v-model="projectId" @change="onProjectChange" :disabled="loading || !projects.length" aria-label="專案">
                  <option v-if="!projects.length" value="">沒有可用專案</option>
                  <option v-for="project in projects" :key="project.id" :value="String(project.id)">{{ project.name }} · Odoo {{ project.odoo_version || '—' }}</option>
                </select>
                <span class="ui-next-environment">{{ environment ? ({ idle: environment.built ? '已停止' : '未建立', setting_up: '建立中', running: '運行中', error: '錯誤' }[environment.status] || environment.status) : '環境狀態無法取得' }}</span>
              </div>
              <button class="ui-next-send" :disabled="sending || (!prompt.trim() && !files.length) || !projectId" :aria-label="sending ? '送出中' : '送出'"><span v-if="sending">處理中</span><ui-next-icon v-else name="send"/></button>
            </div>
          </form>
          <small>Ctrl + Enter 送出。附件沿用既有 Chat 的圖片上傳限制。</small>
        </div>
      </section>
    `,
  });

  window.UiNextApp = Vue.defineComponent({
    name: "UiNextApp",
    components: { UiNextIcon },
    setup() {
      return {
        toasts: window.appToasts,
        needsActionCount: window.needsActionCount,
        inboxUnread: window.inboxUnread,
        claudeUsage: window.claudeUsage,
        codexUsage: window.codexUsage,
      };
    },
    data() {
      return {
        accountOpen: false,
        toolsOpen: false,
        commandOpen: false,
        commandQuery: "",
        commandTrigger: null,
        projects: [],
        projectChats: {},
        expandedProjects: {},
        mobileSidebarOpen: false,
        isAdmin: false,
        userName: "使用者",
      };
    },
    computed: {
      isLoggedIn() {
        return Api.authState.loggedIn;
      },
      projectUnreadTotal() {
        return Object.values(window.UnreadStore.byProject).reduce(
          (total, count) => total + (count || 0),
          0,
        );
      },
      usageRows() {
        const codex = this.codexUsage;
        if (!codex || !codex.available) return [];
        return [
          ["主要額度", codex.primary],
          ["週額度", codex.secondary],
        ]
          .filter(([, row]) => row)
          .map(([label, row]) => ({
            label,
            used: Math.round(row.used_percent),
            remaining: Math.round(row.remaining_percent),
            level:
              row.used_percent >= 90
                ? "critical"
                : row.used_percent >= 70
                  ? "warning"
                  : "healthy",
          }));
      },
      commandItems() {
        const common = [
          { label: "問答", path: "/" },
          { label: "任務列表", path: "/tasks" },
          { label: "專案", path: "/projects" },
          { label: "設定", path: "/settings" },
          { label: "架構圖", path: "/architecture" },
          { label: "流程圖", path: "/pipeline-flow" },
        ];
        if (this.isAdmin)
          common.push(
            { label: "用量報表", path: "/token-report" },
            { label: "管理員", path: "/admin" },
          );
        this.projects.forEach((project) =>
          common.push({
            label: `專案：${project.name}`,
            path: `/projects/${project.id}`,
          }),
        );
        const query = this.commandQuery.trim().toLowerCase();
        return query
          ? common.filter((item) => item.label.toLowerCase().includes(query))
          : common;
      },
    },
    async mounted() {
      if (!Api.isLoggedIn()) return;
      try {
        const [me, projects] = await Promise.all([
          Api.get("auth/me"),
          Api.get("projects"),
        ]);
        this.isAdmin = me.role === "admin";
        this.userName = me.display_name || me.username || "使用者";
        window.UserStore.role = me.role || "";
        this.projects = projects || [];
        window.loadClaudeUsage && window.loadClaudeUsage();
        window.loadCodexUsage && window.loadCodexUsage();
        window.loadUnread && window.loadUnread();
        window.loadInboxUnread && window.loadInboxUnread();
        this._onCommandKey = (event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "k"
          ) {
            event.preventDefault();
            this.commandOpen = true;
            this.focusCommand();
          }
          if (event.key === "Escape") this.closeCommand();
        };
        window.addEventListener("keydown", this._onCommandKey);
      } catch (e) {
        /* router 的登入守衛處理失效憑證 */
      }
    },
    beforeUnmount() {
      window.removeEventListener("keydown", this._onCommandKey);
    },
    methods: {
      async toggleProject(project) {
        const id = project.id;
        const opening = !this.expandedProjects[id];
        this.expandedProjects[id] = opening;
        // 對話僅在展開專案時才讀，避免登入就對每個專案發請求；標題由既有 Chat API 回傳。
        if (
          opening &&
          !Object.prototype.hasOwnProperty.call(this.projectChats, id)
        ) {
          try {
            this.projectChats[id] = await Api.get(`projects/${id}/chats`);
          } catch (e) {
            this.projectChats[id] = [];
            showToast("無法載入專案對話", "error");
          }
        }
      },
      showSearch(event) {
        this.commandTrigger = event && event.currentTarget;
        this.commandOpen = true;
        this.focusCommand();
      },
      closeCommand() {
        this.commandOpen = false;
        this.$nextTick(() => this.commandTrigger && this.commandTrigger.focus());
      },
      selectCommand(item) {
        this.closeCommand();
        this.commandQuery = "";
        this.go(item.path);
      },
      openTour() {
        this.toolsOpen = false;
        window.TourManager.open();
      },
      toProject(project) {
        this.$router.push(`/projects/${project.id}`);
      },
      go(path) {
        this.accountOpen = false;
        this.mobileSidebarOpen = false;
        this.$router.push(path);
      },
      logout() {
        Api.clearToken();
        window.UserStore.role = "";
        SocketManager.disconnectSocket();
        this.$router.push("/login");
      },
      toggleTheme() {
        window.ThemeManager.toggle();
      },
      focusCommand() {
        this.$nextTick(() => {
          const input = this.$refs.commandPalette && this.$refs.commandPalette.querySelector("input");
          if (input) input.focus();
        });
      },
      trapCommandFocus(event) {
        if (event.key !== "Tab") return;
        const focusable = this.$refs.commandPalette
          ? Array.from(this.$refs.commandPalette.querySelectorAll("input, button:not([disabled])"))
          : [];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      },
    },
    template: `
      <template v-if="!isLoggedIn || $route.path === '/login'"><router-view /></template>
      <div v-else class="ui-next-shell" data-ui="next">
        <button class="ui-next-mobile-menu" type="button" aria-label="開啟主選單" @click="mobileSidebarOpen = true"><ui-next-icon name="grid"/></button>
        <div v-if="mobileSidebarOpen" class="ui-next-sidebar-backdrop" @click="mobileSidebarOpen = false"></div>
        <aside class="ui-next-sidebar" :class="{ 'is-mobile-open': mobileSidebarOpen }">
          <div class="ui-next-brand"><img src="favicon.svg" alt="OAA"><span><b>Odoo AI</b><small>自動開發平台</small></span></div>
          <button class="ui-next-new" @click="go('/')"><ui-next-icon name="plus"/>新對話</button>
          <button class="ui-next-search" @click="showSearch($event)"><ui-next-icon name="search"/>搜尋 <kbd>⌘ K</kbd></button>
          <div class="ui-next-sidebar-scroll">
          <div class="ui-next-sidebar-rule"></div>
          <span class="ui-next-section-label">工作區</span>
          <router-link class="ui-next-nav" to="/" exact-active-class="is-active"><ui-next-icon name="chat"/>問答</router-link>
          <button class="ui-next-nav" :class="{ 'is-active': $route.path === '/tasks' || $route.path.startsWith('/task/') }" @click="go('/tasks')"><ui-next-icon name="tasks"/>任務列表 <span v-if="needsActionCount">{{ needsActionCount }}</span></button>
          <button class="ui-next-nav" :class="{ 'is-active': $route.path.startsWith('/projects') }" @click="go('/projects')"><ui-next-icon name="project"/>專案 <span v-if="projectUnreadTotal">{{ projectUnreadTotal }}</span></button>
          <div class="ui-next-projects" v-if="projects.length"><span class="ui-next-section-label">專案 Chat</span><div v-for="project in projects" :key="project.id"><div class="ui-next-project-head"><button @click="toProject(project)"><ui-next-icon name="project"/>{{ project.name }}</button><button @click="toggleProject(project)" :aria-label="(expandedProjects[project.id] ? '收合' : '展開') + ' ' + project.name" :aria-expanded="!!expandedProjects[project.id]"><ui-next-icon :name="expandedProjects[project.id] ? 'chevron-up' : 'chevron-down'"/></button></div><div v-if="expandedProjects[project.id]" class="ui-next-project-chats"><button v-for="chat in projectChats[project.id] || []" :key="chat.id" @click="go('/projects/' + project.id + '/chat/' + chat.id)">{{ chat.title || '新對話' }}</button><button v-if="!(projectChats[project.id] || []).length" @click="go('/projects/' + project.id + '/chat')">尚無對話</button><button class="ui-next-all-chats" @click="go('/projects/' + project.id + '/chat')">查看全部對話</button></div></div></div>
          </div>
          <div class="ui-next-bottom"><div v-if="isAdmin && usageRows.length" class="ui-next-usage" @click="go('/token-report')"><b>Usage</b><div v-for="row in usageRows" :key="row.label"><span>{{ row.label }} · 剩 {{ row.remaining }}%</span><i><em :class="row.level" :style="{ width: row.used + '%' }"></em></i></div></div><div class="ui-next-tools-wrap"><div v-if="toolsOpen" class="ui-next-account-menu"><small>其他功能</small><button @click="openTour"><ui-next-icon name="book"/>新手教學</button><button v-if="isAdmin" @click="go('/admin/pipelines')"><ui-next-icon name="flow"/>進行中 Pipeline</button><button v-if="isAdmin" @click="go('/token-report')"><ui-next-icon name="chart"/>用量報表</button><button @click="go('/architecture')"><ui-next-icon name="project"/>架構圖</button><button @click="go('/pipeline-flow')"><ui-next-icon name="flow"/>流程圖</button></div><button class="ui-next-tools" @click="toolsOpen = !toolsOpen" :aria-expanded="toolsOpen"><ui-next-icon name="grid"/>更多工具 <ui-next-icon :name="toolsOpen ? 'chevron-up' : 'chevron-down'"/></button></div><div class="ui-next-account-wrap"><div v-if="accountOpen" class="ui-next-account-menu"><button @click="go('/settings')">設定</button><button @click="toggleTheme">切換深淺色</button><button v-if="isAdmin" @click="go('/admin')">管理員</button><button @click="logout">登出</button></div><button class="ui-next-account" @click="accountOpen = !accountOpen" :aria-expanded="accountOpen"><strong>{{ userName.slice(0, 1) }}</strong><span>{{ userName }}<br><small>帳號與設定</small></span><ui-next-icon :name="accountOpen ? 'chevron-up' : 'chevron-down'"/></button></div></div>
        </aside>
        <main class="ui-next-main"><router-view :key="$route.fullPath" /></main>
        <div v-if="commandOpen" ref="commandPalette" class="ui-next-command-backdrop" @click.self="closeCommand" @keydown.esc="closeCommand" @keydown="trapCommandFocus">
          <section class="ui-next-command" role="dialog" aria-modal="true" aria-label="快速切換">
            <input ref="commandInput" v-model="commandQuery" autofocus placeholder="搜尋頁面或專案…">
            <button v-for="item in commandItems" :key="item.path" @click="selectCommand(item)">{{ item.label }}<span>↵</span></button>
            <p v-if="!commandItems.length">找不到符合的項目</p>
          </section>
        </div>
        <div class="toast-container">
          <div v-for="t in toasts" :key="t.id" class="toast" :class="t.level">{{ t.message }}</div>
        </div>
        <confirm-dialog-host />
        <tour-host />
      </div>
    `,
  });
})();
