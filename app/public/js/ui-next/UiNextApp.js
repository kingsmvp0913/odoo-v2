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
      <path v-else-if="name==='project'" d="M3 7h7l2 2h9v10H3z"/><path v-else-if="name==='flow'" d="M6 5h12M6 12h12M6 19h12"/><g v-else-if="name==='dots'" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></g><path v-else-if="name==='grid'" d="M5 5h5v5H5zm9 0h5v5h-5zM5 14h5v5H5zm9 0h5v5h-5z"/>
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
        menuProjectId: null,
        menuChatId: null,
        releaseId: null,
        renamingChatId: null,
        renameTitle: "",
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
          rows.push({ provider: "claude", label: "Claude 5hr", used: Math.round(claude.five_hour.utilization), updatedAt: claude.updated_at });
        }
        const codex = this.codexUsage;
        if (codex && codex.available && codex.primary) {
          rows.push({ provider: "codex", label: "Codex 5hr", used: Math.round(codex.primary.used_percent), updatedAt: codex.updated_at });
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
      currentProjectId() {
        return this.$route.params.id ? String(this.$route.params.id) : "";
      },
      currentChatId() {
        return this.$route.params.chatId ? String(this.$route.params.chatId) : "";
      },
      sidebarProjects() {
        const projectById = new Map(this.projects.map((project) => [String(project.id), project]));
        const selected = new Map();
        this.sidebarChatProjects.slice(0, 5).forEach((item) => {
          const project = projectById.get(String(item.project_id));
          if (project) selected.set(String(project.id), project);
        });
        this.projects.filter((project) => project.is_favorite).forEach((project) => selected.set(String(project.id), project));
        // 目前路由的專案是唯一例外：開著一個既不在近期、也不是最愛的舊專案時，
        // 不補進來的話側欄整棵樹選不到自己，使用者看不出人在哪裡。
        const current = projectById.get(this.currentProjectId);
        if (current) selected.set(String(current.id), current);
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
        // 直接開 Chat 深連結時 watch 不會觸發（路由沒變過），所以載完專案要自己補一次。
        this.syncSidebarToRoute();
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
            this.closeSidebarMenus();
            this.closeMobileSidebar();
          }
        };
        window.addEventListener("keydown", this._onCommandKey);
        this._onOutsidePointer = (event) => {
          if (!event.target.closest(".ui-next-tools-wrap") && !event.target.closest(".ui-next-account-wrap")) this.closePopovers();
          if (!event.target.closest(".ui-next-row-menu") && !event.target.closest(".ui-next-row-more")) this.closeSidebarMenus();
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
      "$route.path"() { this.syncSidebarToRoute(); },
    },
    methods: {
      formatUsageUpdated(value) {
        if (!value) return "—";
        return new Date(value).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
      },
      // 對話僅在展開專案時才讀，避免登入就對每個專案發請求；標題由既有 Chat API 回傳。
      // 收合不清 cache，所以重複展開同一個專案只會打一次 API。
      async ensureProjectChats(id) {
        if (Object.prototype.hasOwnProperty.call(this.projectChats, id)) return;
        try {
          this.projectChats[id] = await Api.get(`projects/${id}/chats`);
        } catch (e) {
          this.projectChats[id] = [];
          showToast("無法載入專案對話", "error");
        }
      },
      async toggleProject(project) {
        const id = project.id;
        const opening = !this.expandedProjects[id];
        this.expandedProjects[id] = opening;
        if (opening) await this.ensureProjectChats(id);
      },
      // 側欄只放得下 5 筆，但目前 Chat 若排在第 6 筆之後就會整列消失——
      // 深連結進來時使用者看到的是一份「沒有自己」的清單。
      // ⚠ 清單順序必須固定：把目前 Chat 提到最前面的話，點一下清單就重排，
      // 使用者的眼睛還停在剛才那個位置，會覺得點錯了。只在它真的被擠出去時才補進來。
      visibleChats(project) {
        const chats = this.projectChats[project.id] || [];
        if (this.currentProjectId !== String(project.id)) return chats.slice(0, 5);
        const at = chats.findIndex((chat) => String(chat.id) === this.currentChatId);
        if (at < 0 || at < 5) return chats.slice(0, 5);
        // 擠掉第 5 筆而不是重排：前 4 筆位置原封不動。
        return [...chats.slice(0, 4), chats[at]];
      },
      isCurrentChat(project, chat) {
        return this.currentProjectId === String(project.id) && this.currentChatId === String(chat.id);
      },
      // 深連結與 SPA 內換頁都要讓側欄指到目前位置。只在 mounted 做一次的話，
      // 從任務頁點進 Chat 時整棵樹仍是收合的，看起來像沒有這個 Chat。
      async syncSidebarToRoute() {
        if (!this.$route.path.startsWith("/projects")) return;
        const id = this.currentProjectId;
        if (!id) return;
        this.expandedProjects[id] = true;
        await this.ensureProjectChats(id);
      },
      toggleTools(event) {
        const opening = !this.toolsOpen;
        this.accountOpen = false;
        this.toolsOpen = opening;
        if (opening) {
          this.toolsTrigger = event.currentTarget;
          this.$nextTick(() => this.focusMenuItem(this.$refs.toolsMenu, 0));
        }
      },
      toggleAccount(event) {
        const opening = !this.accountOpen;
        this.toolsOpen = false;
        this.accountOpen = opening;
        if (opening) {
          this.accountTrigger = event.currentTarget;
          this.$nextTick(() => this.focusMenuItem(this.$refs.accountMenu, 0));
        }
      },
      // 用 DOM 查詢而不是維護索引：選單項會隨 isAdmin 動態增減（v-if），
      // 維護索引就得跟著條件渲染同步，遲早對不上。
      // step 0 = 移到第一項（開啟時用），±1 = 相對移動並循環。
      focusMenuItem(menu, step) {
        if (!menu) return;
        const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(
          (el) => el.offsetParent !== null,
        );
        if (!items.length) return;
        if (step === 0) { items[0].focus(); return; }
        const at = items.indexOf(document.activeElement);
        items[(at + step + items.length) % items.length].focus();
      },
      moveMenu(event, step) {
        this.focusMenuItem(event.currentTarget, step);
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
      // ── 側欄 ⋮ 選單 ───────────────────────────────────────────────
      // 兩份選單共用「同時只能開一個」的規則，否則點開第二個時第一個還浮在上面。
      toggleProjectMenu(project, event) {
        event.stopPropagation();
        this.menuChatId = null;
        this.menuProjectId = this.menuProjectId === project.id ? null : project.id;
      },
      toggleChatMenu(chat, event) {
        event.stopPropagation();
        this.menuProjectId = null;
        this.menuChatId = this.menuChatId === chat.id ? null : chat.id;
      },
      closeSidebarMenus() {
        this.menuProjectId = null;
        this.menuChatId = null;
      },
      // 頁籤寫進 query，專案詳情頁的 detailTab 會照著開；直接 push 路徑只會停在第一個頁籤。
      goProjectTab(id, tab) {
        this.closeSidebarMenus();
        this.go(tab ? `/projects/${id}?tab=${tab}` : `/projects/${id}`);
      },
      // 沿用專案頁那支：先開空白分頁再輪詢 SSO URL。不先開分頁的話，
      // 等 await 回來才 window.open 會被瀏覽器當成非使用者手勢而擋掉。
      async openEnv(id) {
        this.closeSidebarMenus();
        const popup = window.open("about:blank", "_blank");
        try {
          const url = await window.pollEnvSso(id);
          if (popup) popup.location = url; else window.location.href = url;
        } catch (error) {
          if (popup) popup.close();
          showToast(error.message || "無法開啟測試區", "error", 0);
        }
      },
      openRelease(id) {
        this.closeSidebarMenus();
        this.releaseId = id;
      },
      startRenameChat(chat) {
        this.closeSidebarMenus();
        this.renamingChatId = chat.id;
        this.renameTitle = chat.title || "";
        this.$nextTick(() => this.$refs.renameInput && this.$refs.renameInput[0] && this.$refs.renameInput[0].select());
      },
      cancelRenameChat() {
        this.renamingChatId = null;
        this.renameTitle = "";
      },
      async submitRenameChat(project, chat) {
        const title = this.renameTitle.trim();
        if (!title || title === chat.title) { this.cancelRenameChat(); return; }
        try {
          const updated = await Api.put(`projects/${project.id}/chats/${chat.id}`, { title });
          // 只改 cache 裡那一筆：重抓整份清單會讓側欄閃一下，而且會蓋掉其他專案的展開狀態。
          const list = this.projectChats[project.id] || [];
          const at = list.findIndex((item) => String(item.id) === String(chat.id));
          if (at > -1) list[at] = { ...list[at], title: updated.title };
        } catch (error) {
          showToast(error.message || "無法重新命名對話", "error");
        }
        this.cancelRenameChat();
      },
      async deleteChat(project, chat) {
        this.closeSidebarMenus();
        if (!await confirmDialog({ title: "刪除對話", message: `確定刪除「${chat.title || "新對話"}」？`, danger: true, confirmText: "刪除" })) return;
        try {
          await Api.delete(`projects/${project.id}/chats/${chat.id}`);
          this.projectChats[project.id] = (this.projectChats[project.id] || []).filter((item) => String(item.id) !== String(chat.id));
          // 刪掉的正是目前開著的那個 Chat，留在原地會是一頁 404。
          if (this.isCurrentChat(project, chat)) this.go(`/projects/${project.id}/chat`);
        } catch (error) {
          showToast(error.message || "無法刪除對話", "error");
        }
      },
      toProject(project) {
        this.expandedProjects[project.id] = true;
        this.ensureProjectChats(project.id);
        this.go(`/projects/${project.id}`);
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
          <!-- 沒有「問答」：它和上面的「新對話」都是導到 /，同一個入口列兩次。 -->
          <router-link class="ui-next-nav" :class="{ 'is-active': $route.path === '/tasks' || $route.path.startsWith('/task/') }" to="/tasks" @click="mobileSidebarOpen=false"><ui-next-icon name="tasks"/>任務列表 <span v-if="needsActionCount">{{ needsActionCount }}</span></router-link>
          <!-- 專案清單是「專案」這個入口的下層，不是另一個區塊。沒有展開箭頭：
               清單常駐，專案的展開改成點名稱本身，右側 ⋮ 才是那一列的操作入口。 -->
          <div class="ui-next-nav-group">
            <router-link class="ui-next-nav" :class="{ 'is-active': $route.path.startsWith('/projects') }" to="/projects" @click="mobileSidebarOpen=false"><ui-next-icon name="project"/>專案 <span v-if="projectUnreadTotal">{{ projectUnreadTotal }}</span></router-link>
            <div class="ui-next-projects"><p v-if="sidebarProjectsError" class="ui-next-sidebar-error">{{ sidebarProjectsError }}</p><p v-else-if="!sidebarProjects.length" class="ui-next-sidebar-empty">沒有近期對話或我的最愛專案</p><div v-for="project in sidebarProjects" :key="project.id"><div class="ui-next-project-head" :class="{ 'is-current': currentProjectId === String(project.id), 'has-menu': menuProjectId === project.id }"><button @click="toggleProject(project)" :aria-expanded="!!expandedProjects[project.id]"><ui-next-icon name="project"/>{{ project.name }}</button><button type="button" class="ui-next-row-more" :aria-label="project.name + ' 更多操作'" :aria-expanded="menuProjectId === project.id ? 'true' : 'false'" aria-haspopup="menu" @click="toggleProjectMenu(project, $event)"><ui-next-icon name="dots"/></button><div v-if="menuProjectId === project.id" class="ui-next-row-menu" role="menu"><button type="button" role="menuitem" @click="openEnv(project.id)">測試區</button><button type="button" role="menuitem" @click="openRelease(project.id)">上正式</button><button type="button" role="menuitem" @click="goProjectTab(project.id, 'repos')">REPO</button><button type="button" role="menuitem" @click="goProjectTab(project.id, 'db')">連線設定</button><button type="button" role="menuitem" @click="goProjectTab(project.id, 'settings')">專案設定</button></div></div><div v-if="expandedProjects[project.id]" class="ui-next-project-chats"><div v-for="chat in visibleChats(project)" :key="chat.id" class="ui-next-chat-row" :class="{ 'has-menu': menuChatId === chat.id, 'is-active': isCurrentChat(project, chat) }"><input v-if="renamingChatId === chat.id" ref="renameInput" v-model="renameTitle" class="ui-next-rename-input" :aria-label="'重新命名對話'" @keydown.enter.prevent="submitRenameChat(project, chat)" @keydown.esc.prevent="cancelRenameChat" @blur="submitRenameChat(project, chat)"><template v-else><button :aria-current="isCurrentChat(project, chat) ? 'page' : null" @click="go('/projects/' + project.id + '/chat/' + chat.id)">{{ chat.title || '新對話' }}</button><button type="button" class="ui-next-row-more" :aria-label="(chat.title || '新對話') + ' 更多操作'" :aria-expanded="menuChatId === chat.id ? 'true' : 'false'" aria-haspopup="menu" @click="toggleChatMenu(chat, $event)"><ui-next-icon name="dots"/></button><div v-if="menuChatId === chat.id" class="ui-next-row-menu" role="menu"><button type="button" role="menuitem" @click="startRenameChat(chat)">重新命名</button><button type="button" role="menuitem" class="danger" @click="deleteChat(project, chat)">刪除</button></div></template></div><button v-if="(projectChats[project.id] || []).length" class="ui-next-all-chats" @click="go('/projects/' + project.id + '?tab=chat')">查看全部對話</button></div></div></div>
          </div>
          </div>
          <div class="ui-next-bottom">
            <div class="ui-next-tools-wrap"><div v-if="toolsOpen" ref="toolsMenu" class="ui-next-account-menu" role="menu" @keydown.down.prevent="moveMenu($event, 1)" @keydown.up.prevent="moveMenu($event, -1)"><small>其他功能</small><button role="menuitem" @click="openTour"><ui-next-icon name="book"/>新手教學</button><button role="menuitem" v-if="isAdmin" @click="go('/admin/pipelines')"><ui-next-icon name="flow"/>進行中 Pipeline</button><button role="menuitem" v-if="isAdmin" @click="go('/token-report')"><ui-next-icon name="chart"/>用量報表</button><button role="menuitem" @click="go('/architecture')"><ui-next-icon name="project"/>架構圖</button><button role="menuitem" @click="go('/pipeline-flow')"><ui-next-icon name="flow"/>流程圖</button></div><button ref="toolsTrigger" class="ui-next-tools" @click="toggleTools($event)" :aria-expanded="toolsOpen" aria-haspopup="menu"><ui-next-icon name="grid"/>更多工具 <ui-next-icon :name="toolsOpen ? 'chevron-up' : 'chevron-down'"/></button></div>
            <div class="ui-next-account-wrap"><div v-if="accountOpen" ref="accountMenu" class="ui-next-account-menu" role="menu" @keydown.down.prevent="moveMenu($event, 1)" @keydown.up.prevent="moveMenu($event, -1)"><button role="menuitem" @click="go('/settings')">設定</button><button role="menuitem" @click="toggleTheme">切換深淺色</button><button role="menuitem" v-if="isAdmin" @click="go('/admin')">管理員</button><button role="menuitem" @click="logout">登出</button></div><button ref="accountTrigger" class="ui-next-account" @click="toggleAccount($event)" :aria-expanded="accountOpen" aria-haspopup="menu"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ui-next-user-icon" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg><span>帳號與設定</span><ui-next-icon :name="accountOpen ? 'chevron-up' : 'chevron-down'"/></button></div>
            <router-link v-if="isAdmin && usageRows.length" class="ui-next-usage" to="/token-report"><div v-for="row in usageRows" :key="row.label" class="ui-next-usage-row"><span v-if="row.provider==='claude'" class="usage-provider-logo claude" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="currentColor"><path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"></path></svg></span><span v-else class="usage-provider-logo codex" aria-hidden="true"><img src="https://images.ctfassets.net/kftzwdyauwt9/77tJ5U1tgxHMZflZ5m4Z24/ace4d8b6ad200d87ebcb69c466344343/Blossom_4k_Icon_1.png?w=1920&amp;q=90&amp;fm=webp" alt=""></span><b>{{ row.label }}</b><strong>剩 {{ row.remaining }}%</strong><small>更新 {{ formatUsageUpdated(row.updatedAt) }}</small><i><em :class="row.level" :style="{ width: row.used + '%' }"></em></i></div></router-link>
          </div>
        </aside>
        <main id="ui-next-main" class="ui-next-main" tabindex="-1"><router-view :key="$route.path" /></main>
        <!-- 掛在 shell 而不是 aside 內：側欄是 overflow:hidden，放進去會被裁掉一半。 -->
        <ReleaseModal v-if="releaseId" :key="releaseId" :project-id="releaseId" @close="releaseId=null" />
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
