(function () {
  const query = new URLSearchParams(window.location.search);
  window.UiNextEnabled = query.get("ui") === "next";

  function chatTitle(value) {
    const text = (value || "").trim().replace(/\s+/g, " ");
    return text.length > 28 ? `${text.slice(0, 28)}…` : text || "新對話";
  }

  window.renderNextMarkdown = function renderNextMarkdown(value) {
    return renderMarkdown(value)
      .replace(/<pre><code(?: class="language-([^\"]+)")?>/g, (_, language) => `<div class="ui-next-code-block"><div class="ui-next-code-head"><span>${language || "text"}</span><button type="button" data-copy-code="true">複製程式碼</button></div><pre><code>`)
      .replace(/<\/code><\/pre>/g, "</code></pre></div>");
  };

  window.copyNextCode = async function copyNextCode(event) {
    const trigger = event.target.closest("[data-copy-code]");
    if (!trigger) return;
    const code = trigger.closest(".ui-next-code-block")?.querySelector("code")?.textContent || "";
    try {
      await navigator.clipboard.writeText(code);
      trigger.textContent = "已複製";
      setTimeout(() => { trigger.textContent = "複製程式碼"; }, 1800);
    } catch (error) { showToast("無法複製程式碼，請確認瀏覽器權限", "error", 0); }
  };

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
      <path v-else-if="name==='star-filled'" fill="currentColor" stroke="none" d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>
      <path v-else-if="name==='chevron-right'" d="m9 6 6 6-6 6"/><path v-else-if="name==='arrow-right'" d="m14 5 7 7-7 7M21 12H9"/>
      <path v-else-if="name==='download'" d="M12 3v12m0 0 4.2-4.2M12 15l-4.2-4.2M4 19h16"/>
      <path v-else-if="name==='wrench'" d="M14.6 6.4a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>
      <path v-else-if="name==='enter'" d="m9 10-4 4 4 4M5 14h9a4 4 0 0 0 4-4V6"/>
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
        environmentSummaries: {},
        environmentError: "",
        projectPickerOpen: false,
        createdChatId: "",
        sendError: "",
        userName: "使用者",
        sending: false,
        loading: true,
      };
    },
    async created() {
      try {
        const [projects, me, summaries] = await Promise.all([
          Api.get("projects"),
          Api.get("auth/me"),
          Api.get("projects/env-summaries").catch(() => []),
        ]);
        this.projects = projects || [];
        this.userName = me.display_name || me.username || "使用者";
        this.environmentSummaries = (summaries || []).reduce((result, summary) => { result[String(summary.project_id)] = summary; return result; }, {});
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
    mounted() {
      this._onProjectPickerOutside = (event) => {
        if (!event.target.closest(".ui-next-project-picker")) this.projectPickerOpen = false;
      };
      document.addEventListener("pointerdown", this._onProjectPickerOutside);
    },
    beforeUnmount() {
      document.removeEventListener("pointerdown", this._onProjectPickerOutside);
    },
    computed: {
      selectedProject() {
        return this.projects.find(
          (p) => String(p.id) === String(this.projectId),
        );
      },
      environmentLabel() {
        if (!this.projectId) return "請先選擇專案";
        if (this.environmentError) return "測試環境狀態讀取失敗";
        if (!this.environment) return "測試環境狀態載入中";
        return ({ idle: this.environment.built ? "測試環境已停止" : "測試環境未建立", setting_up: "測試環境建立中", running: "測試環境運行中", error: "測試環境錯誤" }[this.environment.status] || "測試環境狀態未知");
      },
    },
    methods: {
      async loadEnvironment() {
        if (!this.projectId) { this.environment = null; this.environmentError = ""; return; }
        this.environment = null;
        this.environmentError = "";
        try { this.environment = await Api.get(`projects/${this.projectId}/env/summary`); this.environmentSummaries[String(this.projectId)] = this.environment; }
        catch (error) { this.environmentError = error.message || "無法讀取測試環境"; }
      },
      environmentOptionLabel(project) {
        const summary = this.environmentSummaries[String(project.id)];
        if (!summary) return "測試環境：狀態未知 · 資料庫連線：狀態未知";
        const environment = ({ idle: "未建立或已停止", setting_up: "建立中", running: "運行中", error: "錯誤" }[summary.status] || "狀態未知");
        const database = ({ connected: "已連線", connecting: "連線中", not_available: "未啟動", error: "錯誤" }[summary.database_status] || "狀態未知");
        return `測試環境：${environment} · 資料庫連線：${database}`;
      },
      onProjectChange() {
        localStorage.setItem("oaa.next.last-project-id", this.projectId);
        this.createdChatId = "";
        this.loadEnvironment();
      },
      selectProject(project) {
        this.projectId = String(project.id);
        this.projectPickerOpen = false;
        this.onProjectChange();
      },
      onProjectPickerKeydown(event) {
        const options = this.$refs.projectOptions ? Array.from(this.$refs.projectOptions.querySelectorAll("button:not([disabled])")) : [];
        if (event.key === "Escape") { this.projectPickerOpen = false; this.$nextTick(() => this.$refs.projectTrigger?.focus()); return; }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!this.projectPickerOpen) { this.projectPickerOpen = true; return; }
          const index = options.indexOf(document.activeElement);
          (options[index + (event.key === "ArrowDown" ? 1 : -1)] || options[event.key === "ArrowDown" ? 0 : options.length - 1])?.focus();
        }
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
                <div class="ui-next-project-picker" @keydown="onProjectPickerKeydown">
                  <button ref="projectTrigger" type="button" class="ui-next-project-picker-trigger" :aria-expanded="projectPickerOpen" aria-haspopup="listbox" @click="projectPickerOpen=!projectPickerOpen" @keydown.enter.prevent="projectPickerOpen=!projectPickerOpen" :disabled="loading || !projects.length">{{ selectedProject ? selectedProject.name + ' · Odoo ' + (selectedProject.odoo_version || '未設定') : '沒有可用專案' }}</button>
                  <div v-if="projectPickerOpen" ref="projectOptions" class="ui-next-project-picker-options" role="listbox" aria-label="選擇專案">
                    <button v-for="project in projects" :key="project.id" type="button" role="option" :aria-selected="String(project.id)===String(projectId)" @click="selectProject(project)"><b>{{ project.name }} · Odoo {{ project.odoo_version || '未設定' }}</b><small>{{ environmentOptionLabel(project) }}</small></button>
                  </div>
                </div>
                <span class="ui-next-environment" :class="{error:environmentError}">{{ environmentLabel }}</span>
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
        dismissToast: window.dismissToast,
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
        commandIndex: 0,
        commandTrigger: null,
        toolsTrigger: null,
        accountTrigger: null,
        projects: [],
        sidebarChatProjects: [],
        sidebarProjectsError: "",
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
        const rows = [];
        const claude = this.claudeUsage;
        if (claude && claude.available && claude.five_hour && claude.five_hour.utilization != null) {
          rows.push({ label: "Claude 5hr", used: Math.round(claude.five_hour.utilization) });
        }
        const codex = this.codexUsage;
        if (codex && codex.available && codex.primary) {
          rows.push({ label: "Codex 5hr", used: Math.round(codex.primary.used_percent) });
        }
        return rows.map((row) => ({
          ...row,
          remaining: Math.max(0, 100 - row.used),
            level:
              row.used >= 90
                ? "critical"
                : row.used >= 70
                  ? "warning"
                  : "healthy",
        }));
      },
      sidebarProjects() {
        const projectById = new Map(this.projects.map((project) => [String(project.id), project]));
        const selected = new Map();
        this.sidebarChatProjects.slice(0, 5).forEach((item) => {
          const project = projectById.get(String(item.project_id));
          if (project) selected.set(String(project.id), project);
        });
        this.projects.filter((project) => project.is_favorite).forEach((project) => selected.set(String(project.id), project));
        return [...selected.values()].sort((a, b) => Number(b.is_favorite) - Number(a.is_favorite) || a.name.localeCompare(b.name, "zh-Hant"));
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
        const [me, projects, sidebarChatProjects] = await Promise.all([
          Api.get("auth/me"),
          Api.get("projects"),
          Api.get("chats/sidebar-projects").catch((error) => {
            this.sidebarProjectsError = error.message || "無法載入近期對話專案";
            return [];
          }),
        ]);
        this.isAdmin = me.role === "admin";
        this.userName = me.display_name || me.username || "使用者";
        window.UserStore.role = me.role || "";
        this.projects = projects || [];
        this.sidebarChatProjects = sidebarChatProjects || [];
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
            this.openCommand();
          }
          if (event.key === "Escape") {
            this.closeCommand();
            this.closePopovers(true);
            this.closeMobileSidebar();
          }
        };
        window.addEventListener("keydown", this._onCommandKey);
        this._onOutsidePointer = (event) => {
          if (!event.target.closest(".ui-next-tools-wrap") && !event.target.closest(".ui-next-account-wrap")) this.closePopovers();
        };
        document.addEventListener("pointerdown", this._onOutsidePointer);
      } catch (e) {
        /* router 的登入守衛處理失效憑證 */
      }
    },
    beforeUnmount() {
      window.removeEventListener("keydown", this._onCommandKey);
      document.removeEventListener("pointerdown", this._onOutsidePointer);
    },
    // 背景捲動鎖定集中在這裡：這兩個狀態各有好幾處會改（按鈕、⌘K、Escape、
    // 點遮罩、切換路由），在每個地方各自加解鎖遲早會漏掉一處。
    watch: {
      commandOpen() { this.syncBodyScroll(); },
      mobileSidebarOpen() { this.syncBodyScroll(); },
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
      toggleTools(event) {
        const opening = !this.toolsOpen;
        this.accountOpen = false;
        this.toolsOpen = opening;
        if (opening) this.toolsTrigger = event.currentTarget;
      },
      toggleAccount(event) {
        const opening = !this.accountOpen;
        this.toolsOpen = false;
        this.accountOpen = opening;
        if (opening) this.accountTrigger = event.currentTarget;
      },
      closePopovers(restoreFocus = false) {
        const hadTools = this.toolsOpen, hadAccount = this.accountOpen;
        this.toolsOpen = false;
        this.accountOpen = false;
        if (restoreFocus) this.$nextTick(() => (hadTools ? this.toolsTrigger : hadAccount ? this.accountTrigger : null)?.focus());
      },
      // 開啟 palette 的唯一入口。搜尋鈕與 ⌘K 兩條路徑都走這裡——
      // 原本 ⌘K 是直接設 commandOpen=true，於是鎖捲動與索引重設只在點按鈕時生效。
      openCommand(trigger) {
        this.commandTrigger = trigger || null;
        this.commandOpen = true;
        this.commandIndex = 0;
        this.focusCommand();
      },
      showSearch(event) {
        this.openCommand(event && event.currentTarget);
      },
      closeCommand() {
        // Escape 是全域監聽，palette 沒開時也會呼叫到這裡；
        // 不擋的話會把別人鎖的背景捲動一起解掉。
        if (!this.commandOpen) return;
        this.commandOpen = false;
        this.$nextTick(() => this.commandTrigger && this.commandTrigger.focus());
      },
      // overlay 開啟時背景不該跟著捲動：不鎖的話在 palette 內滾到底會穿透到後面的頁面。
      // 由「有沒有任何 overlay 開著」推導，而不是在每個開關處各自加解鎖——
      // 後者在「開 palette → 開側欄 → 關 palette」時，會在側欄還開著的情況下把捲動解掉。
      // 呼叫點集中在 watch，狀態從哪裡被改都會同步。
      syncBodyScroll() {
        const anyOpen = this.commandOpen || this.mobileSidebarOpen;
        document.body.style.overflow = anyOpen ? "hidden" : "";
      },
      // ⌘K 的使用者幾乎都在用鍵盤，沒有方向鍵等於只能改用滑鼠點。
      // 循環（%）而不是夾在兩端：清單短時從最後一項往下回到第一項比較順手。
      moveCommand(step) {
        const total = this.commandItems.length;
        if (!total) return;
        this.commandIndex = (this.commandIndex + step + total) % total;
      },
      chooseCommand() {
        const item = this.commandItems[this.commandIndex];
        if (item) this.selectCommand(item);
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
        this.closePopovers();
        this.mobileSidebarOpen = false;
        this.$router.push(path);
      },
      logout() {
        this.closePopovers();
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
      // palette 與行動版抽屜共用。選擇器含 a[href]：抽屜裡的導覽項是 router-link（<a>），
      // 只找 input/button 會漏掉整份選單。offsetParent 過濾掉收合起來的區塊——
      // 把焦點送進看不見的元素，使用者會以為 Tab 壞了。
      trapFocus(event, container) {
        if (event.key !== "Tab" || !container) return;
        const focusable = Array.from(
          container.querySelectorAll('a[href], input, button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
        ).filter((el) => el.offsetParent !== null);
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
      trapCommandFocus(event) {
        this.trapFocus(event, this.$refs.commandPalette);
      },
      // 桌機時 aside 是永久導覽，不該 trap——否則使用者 Tab 不出側欄。
      trapSidebarFocus(event) {
        if (this.mobileSidebarOpen) this.trapFocus(event, this.$refs.mobileSidebar);
      },
      openMobileSidebar(event) {
        this.mobileSidebarTrigger = event && event.currentTarget;
        this.mobileSidebarOpen = true;
        // 焦點要移進抽屜，否則螢幕閱讀器仍停在背景，role="dialog" 等於白宣告。
        this.$nextTick(() => {
          const box = this.$refs.mobileSidebar;
          const first = box && box.querySelector('a[href], button:not([disabled])');
          (first || box)?.focus();
        });
      },
      // 只給「取消」類的關閉用（Escape、點遮罩）：焦點還原到當初開啟的按鈕。
      // 點選單項導航不走這裡——那時頁面已經換了，把焦點丟回選單鈕反而不對。
      closeMobileSidebar() {
        if (!this.mobileSidebarOpen) return;
        this.mobileSidebarOpen = false;
        this.$nextTick(() => this.mobileSidebarTrigger && this.mobileSidebarTrigger.focus());
      },
    },
    template: `
      <template v-if="!isLoggedIn || $route.path === '/login'"><router-view /></template>
      <div v-else class="ui-next-shell" data-ui="next">
        <a class="ui-next-skip-link" href="#ui-next-main">跳到主要內容</a>
        <button class="ui-next-mobile-menu" type="button" aria-label="開啟主選單" :aria-expanded="mobileSidebarOpen ? 'true' : 'false'" @click="openMobileSidebar($event)"><ui-next-icon name="grid"/></button>
        <div v-if="mobileSidebarOpen" class="ui-next-sidebar-backdrop" @click="closeMobileSidebar(); closePopovers()"></div>
        <!-- role/aria-modal 只在行動版抽屜開啟時掛上：桌機的同一個 aside 是永久導覽，
             無條件標成 dialog 會讓輔助技術把整個側欄誤報成對話框。 -->
        <aside ref="mobileSidebar" class="ui-next-sidebar" :class="{ 'is-mobile-open': mobileSidebarOpen }" :role="mobileSidebarOpen ? 'dialog' : null" :aria-modal="mobileSidebarOpen ? 'true' : null" :aria-label="mobileSidebarOpen ? '主選單' : null" :tabindex="mobileSidebarOpen ? '-1' : null" @keydown="trapSidebarFocus">
          <div class="ui-next-brand"><img src="favicon.svg" alt="OAA"><span><b>Odoo AI</b><small>自動開發平台</small></span></div>
          <button class="ui-next-new" @click="go('/')"><ui-next-icon name="plus"/>新對話</button>
          <button class="ui-next-search" @click="showSearch($event)"><ui-next-icon name="search"/>搜尋 <kbd>⌘ K</kbd></button>
          <div class="ui-next-sidebar-scroll">
          <div class="ui-next-sidebar-rule"></div>
          <span class="ui-next-section-label">工作區</span>
          <router-link class="ui-next-nav" to="/" exact-active-class="is-active"><ui-next-icon name="chat"/>問答</router-link>
          <router-link class="ui-next-nav" :class="{ 'is-active': $route.path === '/tasks' || $route.path.startsWith('/task/') }" to="/tasks" @click="mobileSidebarOpen=false"><ui-next-icon name="tasks"/>任務列表 <span v-if="needsActionCount">{{ needsActionCount }}</span></router-link>
          <router-link class="ui-next-nav" :class="{ 'is-active': $route.path.startsWith('/projects') }" to="/projects" @click="mobileSidebarOpen=false"><ui-next-icon name="project"/>專案 <span v-if="projectUnreadTotal">{{ projectUnreadTotal }}</span></router-link>
          <div class="ui-next-projects"><span class="ui-next-section-label">專案 Chat</span><p v-if="sidebarProjectsError" class="ui-next-sidebar-error">{{ sidebarProjectsError }}</p><p v-else-if="!sidebarProjects.length" class="ui-next-sidebar-empty">沒有近期對話或我的最愛專案</p><div v-for="project in sidebarProjects" :key="project.id"><div class="ui-next-project-head"><button @click="toProject(project)"><ui-next-icon name="project"/>{{ project.name }}<ui-next-icon v-if="project.is_favorite" name="star"/></button><button @click="toggleProject(project)" :aria-label="(expandedProjects[project.id] ? '收合' : '展開') + ' ' + project.name" :aria-expanded="!!expandedProjects[project.id]"><ui-next-icon :name="expandedProjects[project.id] ? 'chevron-up' : 'chevron-down'"/></button></div><div v-if="expandedProjects[project.id]" class="ui-next-project-chats"><button v-for="chat in (projectChats[project.id] || []).slice(0, 5)" :key="chat.id" @click="go('/projects/' + project.id + '/chat/' + chat.id)">{{ chat.title || '新對話' }}</button><button v-if="(projectChats[project.id] || []).length" class="ui-next-all-chats" @click="go('/projects/' + project.id + '/chat')">查看全部對話</button></div></div></div>
          </div>
          <div class="ui-next-bottom"><div class="ui-next-tools-wrap"><div v-if="toolsOpen" class="ui-next-account-menu"><small>其他功能</small><button @click="openTour"><ui-next-icon name="book"/>新手教學</button><button v-if="isAdmin" @click="go('/admin/pipelines')"><ui-next-icon name="flow"/>進行中 Pipeline</button><button v-if="isAdmin" @click="go('/token-report')"><ui-next-icon name="chart"/>用量報表</button><button @click="go('/architecture')"><ui-next-icon name="project"/>架構圖</button><button @click="go('/pipeline-flow')"><ui-next-icon name="flow"/>流程圖</button></div><button ref="toolsTrigger" class="ui-next-tools" @click="toggleTools($event)" :aria-expanded="toolsOpen"><ui-next-icon name="grid"/>更多工具 <ui-next-icon :name="toolsOpen ? 'chevron-up' : 'chevron-down'"/></button></div><div class="ui-next-account-wrap"><div v-if="accountOpen" class="ui-next-account-menu"><button @click="go('/settings')">設定</button><button @click="toggleTheme">切換深淺色</button><button v-if="isAdmin" @click="go('/admin')">管理員</button><button @click="logout">登出</button></div><button ref="accountTrigger" class="ui-next-account" @click="toggleAccount($event)" :aria-expanded="accountOpen"><strong>{{ userName.slice(0, 1) }}</strong><span>{{ userName }}<br><small>帳號與設定</small></span><ui-next-icon :name="accountOpen ? 'chevron-up' : 'chevron-down'"/></button></div><router-link v-if="isAdmin && usageRows.length" class="ui-next-usage" to="/token-report"><b>Usage</b><div v-for="row in usageRows" :key="row.label"><span>{{ row.label }} · 剩 {{ row.remaining }}%</span><i><em :class="row.level" :style="{ width: row.used + '%' }"></em></i></div></router-link></div>
        </aside>
        <main id="ui-next-main" class="ui-next-main" tabindex="-1"><router-view :key="$route.fullPath" /></main>
        <div v-if="commandOpen" ref="commandPalette" class="ui-next-command-backdrop" @click.self="closeCommand" @keydown.esc="closeCommand" @keydown.down.prevent="moveCommand(1)" @keydown.up.prevent="moveCommand(-1)" @keydown="trapCommandFocus">
          <section class="ui-next-command" role="dialog" aria-modal="true" aria-label="快速切換">
            <!-- Enter 綁在 input 而不是 backdrop：焦點若在某個選項上，backdrop 的 Enter
                 會和該按鈕的原生 click 同時觸發,等於導航兩次。 -->
            <input ref="commandInput" v-model="commandQuery" autofocus placeholder="搜尋頁面或專案…" role="combobox" aria-expanded="true" aria-controls="ui-next-command-list" :aria-activedescendant="commandItems.length ? 'ui-next-command-item-' + commandIndex : null" @input="commandIndex = 0" @keydown.enter.prevent="chooseCommand()">
            <div id="ui-next-command-list" role="listbox" aria-label="搜尋結果">
              <button v-for="(item, index) in commandItems" :key="item.path" :id="'ui-next-command-item-' + index" role="option" :aria-selected="index === commandIndex" :class="{ 'is-active': index === commandIndex }" @click="selectCommand(item)" @mousemove="commandIndex = index">{{ item.label }}<span><ui-next-icon name="enter"/></span></button>
            </div>
            <p v-if="!commandItems.length">找不到符合的項目</p>
          </section>
        </div>
      </div>
      <!-- 這三個全域 overlay 必須在 v-if/v-else 兩個分支之外。
           原本掛在 shell 這個 v-else 裡面，於是未登入與 /login 頁走 v-if 分支時三者都不存在：
           登入失敗的 toast、確認視窗、新手教學在那些頁面上全部靜默不出現。
           它們都是 position:fixed 的 overlay，放在哪一層不影響定位。 -->
      <div class="toast-container" role="status" aria-live="polite" aria-atomic="false">
        <div v-for="t in toasts" :key="t.id" class="toast" :class="t.level">{{ t.message }}<button v-if="t.sticky" type="button" class="toast-close" aria-label="關閉訊息" @click="dismissToast(t.id)"><ui-next-icon name="close"/></button></div>
      </div>
      <confirm-dialog-host />
      <tour-host />
    `,
  });
})();
