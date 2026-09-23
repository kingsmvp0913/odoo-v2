(function () {
  // 專案詳情保留既有資料與操作（Repo、測試環境、同步設定），畫面改為新版資訊分區。
  window.UiNextProjectDetailView = Vue.defineComponent({
    name: "UiNextProjectDetailView",
    components: {
      ReleaseModal: window.ReleaseModal,
      UiNextIcon: window.UiNextIcon,
    },
    // detailTab 的初始猜值也要看角色（回合 1 審查發現）：這裡跑在 created() 之前，project
    // 還沒載入，因此 deploy 這個要看 auto_deploy_enabled 的分頁一律先排除；repos／db 只看
    // 角色（window.UserStore 是同步可用的全域，不必等 Vue 初始化）。created() 裡的
    // selectTab() 會在資料到齊後用完整的分頁清單再核一次，兩層都守住才不會有一拍露出。
    data() { return { editServiceContactName: "", editName: "", editDescription: "", savingBasics: false, project: null, repos: [], branchInfo: {}, loading: true, loadError: "", newRepo: { label: "", repo_url: "", is_primary: false, base_branch: "" }, remoteBranches: [], probingBranches: false, branchProbeError: "", branchPickerOpen: false, branchQuery: "", lastProbedUrl: null, savingRepo: false, env: null, envWorking: false, editOdooProjectName: "", editServiceRespondentName: "", editE2eEnabled: true, savingE2e: false, editEdition: "community", savingEdition: false, runtimeLog: null, logLoading: false, showReleaseModal: false, editAutoDeploy: false, savingAutoDeploy: false, detailTab: (window.UserStore.role === "admin" ? ["repos","env","settings","chat","db","wiki"] : ["env","chat","wiki"]).includes(this.$route.query.tab) ? this.$route.query.tab : "chat", chats: [], chatsLoading: false, chatsError: "", chatSearch: "", creatingChat: false, showNewChat: false, newChatTitle: "", newChatText: "", newChatFiles: [], newChatPreviews: [], _pollTimer: null, _reposPollTimer: null }; },
    computed: {
      // tabs 是 computed 不是靜態陣列：這個專案的自動部署開關關閉時，分頁必須整個不存在。
      // 這只是畫面——後端每一支部署端點自己也擋（requireAdmin + requireAutoDeploy）。
      // Repo／連線設定／設定／自動部署四個分頁的寫入端點全是平台管理員限定，連線設定連 GET 也是——
      // 一般使用者切進去要嘛看得到按不動、要嘛連清單都讀不到，藏整頁比留著顯示更清楚。
      // 「設定」是 2026-09-21 補進來的：它整頁只有兩個區塊，兩個都是平台管理員限定的寫入
      //（基本資料 → PUT /api/projects/:id、同步來源對應 → PATCH /api/projects/:id/mapping），
      // 只藏按鈕會留下一張填得動、存不了的空殼表單——那比藏起來更像壞掉。專案名稱與備註本來就
      // 印在本頁標題上，藏掉這一頁不會少掉任何一般使用者看得到的資訊。
      // 側欄「專案設定」那一項早就掛著 v-if="isAdmin"（UiNextApp.js 的專案列 ⋮），這裡只是補上同一個判準。
      // 陣列字面量刻意維持完整、用 filter 拿掉不該顯示的分頁（而非用 push 動態組出來）：
      // tour-isolation.test.js 用文字掃描從這裡數 tab key，拆成條件式 push 會讓它只掃到一半。
      tabs() {
        const all = [["chat","Chat"],["settings","設定"],["repos","Repo"],["db","連線設定"],["env","測試環境"],["wiki","Wiki"],["deploy","自動部署"]];
        return all.filter(([key]) => {
          if (key === "repos" || key === "db" || key === "settings") return this.isAdmin();
          if (key === "deploy") return this.isAdmin() && this.project && this.project.auto_deploy_enabled;
          return true;
        });
      },
      // 縱深防禦（回合 1 審查發現）：db／deploy 是管理員限定分頁，這裡不能只看 detailTab 就掛元件——
      // deploy 掛上去會直接打管理員限定的部署端點。萬一 detailTab 因為某個沒顧到的路徑（如
      // data() 初始猜值、或未來新增的入口）落到這兩個值，元件本身也要有第二層擋，不能只靠分頁列藏起來。
      embeddedTab() { const map = { wiki: window.UiNextWikiView }; if (this.isAdmin()) { map.db = window.UiNextDbView; map.deploy = window.UiNextDeployTargetsView; } return map[this.detailTab] || null; }, filteredChats() { const q = this.chatSearch.trim().toLowerCase(); return q ? this.chats.filter((c) => (c.title || "新對話").toLowerCase().includes(q)) : this.chats; }, hasCloning() { return this.repos.some((repo) => repo.clone_status === "cloning"); }, envActive() { return !!(this.env && (this.env.status === "setting_up" || this.env.status === "running" || this.env.built)); }, filteredBranches() { const q = this.branchQuery.trim().toLowerCase(); return q ? this.remoteBranches.filter((branch) => branch.toLowerCase().includes(q)) : this.remoteBranches; } },
    watch: {
      // 改用 this.tabs（依角色與 auto_deploy_enabled 過濾過）而不是寫死的分頁鍵清單：
      // 否則一般使用者若靠網址把 tab 切成 repos/db/deploy，這裡會照樣接受，
      // 畫面卻是「分頁按鈕不見了、內容還在」的半調子狀態。
      "$route.query.tab"(tab) {
        const next = this.tabs.some((t) => t[0] === tab) ? tab : "chat";
        if (next === this.detailTab) return;
        this.detailTab = next;
        if (next === "chat") this.loadChats();
      },
      "env.status"(value) { if (value === "setting_up") this._startPoll(); else this._stopPoll(); },
      hasCloning(value) { if (value) this._startReposPoll(); else this._stopReposPoll(); },
    },
    async created() {
      // 專案資料是非同步載入的，初始化當下還不知道 deploy 分頁在不在，載回來後要再驗一次。
      await Promise.all([this.load(), this.loadEnv()]);
      this.selectTab(this.detailTab);
      if (this.detailTab === "chat") this.loadChats();
    },
    // 沒有這行，離開專案頁之後那兩個 timer 還會繼續打 API（元件早就卸載，畫面也不會更新）。
    mounted() { this._onBranchPickerOutside = (event) => { if (!event.target.closest(".ui-next-branch-picker")) this.branchPickerOpen = false; }; document.addEventListener("pointerdown", this._onBranchPickerOutside); },
    beforeUnmount() { this.revokeNewChatUrls(); this._stopPoll(); this._stopReposPoll(); document.removeEventListener("pointerdown", this._onBranchPickerOutside); },
    methods: {
      // 環境建立／repo clone 都是背景長工，後端不推事件；不輪詢的話「建立中」「同步中」會永遠停在原地。
      _startPoll() { if (this._pollTimer) return; this._pollTimer = setInterval(() => this.loadEnv(), 5000); },
      _stopPoll() { if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; } },
      _startReposPoll() { if (this._reposPollTimer) return; this._reposPollTimer = setInterval(async () => { const data = await Api.get(`projects/${this.$route.params.id}`).catch(() => null); if (data) this.repos = data.repos || []; }, 3000); },
      _stopReposPoll() { if (this._reposPollTimer) { clearInterval(this._reposPollTimer); this._reposPollTimer = null; } },
      isTourDemo() { return !!(window.TourDemo && window.TourDemo.isProject(this.$route.params.id)); },
      async load() { this.loading = true; this.loadError = ""; if (this.isTourDemo()) { this.project = window.TourDemo.project(); this.repos = window.TourDemo.project().repos || []; this.loading = false; this.loadEnv(); return; } try { const data = await Api.get(`projects/${this.$route.params.id}`); this.project = data; this.editName = this.project?.name || ""; this.editDescription = this.project?.description || ""; this.repos = data.repos || []; this.editOdooProjectName = data.odoo_project_name || ""; this.editServiceRespondentName = data.service_respondent_name || ""; this.editServiceContactName = data.service_contact_name || ""; this.editE2eEnabled = !data.e2e_disabled; this.editAutoDeploy = !!data.auto_deploy_enabled; this.editEdition = data.edition || "community"; await Promise.all(this.repos.filter((repo) => repo.clone_status === "done").map(async (repo) => { const info = await Api.get(`projects/${data.id}/repos/${repo.id}/branches`).catch(() => null); if (info) this.branchInfo[repo.id] = info; })); } catch (error) { this.loadError = error.message || "無法載入專案"; showToast(this.loadError, "error", 0); } finally { this.loading = false; } },
      async loadEnv() { if (this.isTourDemo()) { this.env = window.TourDemo.env(); return; } this.env = await Api.get(`projects/${this.$route.params.id}/env`).catch(() => this.env || { status: "idle" }); },
      async addRepo() { if (!this.newRepo.label || !this.newRepo.repo_url) return showToast("請填寫標籤和 repo URL", "error"); this.savingRepo = true; try { await Api.post(`projects/${this.$route.params.id}/repos`, { ...this.newRepo }); this.newRepo = { label: "", repo_url: "", is_primary: false, base_branch: "" }; this.remoteBranches = []; this.lastProbedUrl = null; this.branchProbeError = ""; await this.load(); showToast("Repo 已新增，正在同步", "success"); } catch (error) { showToast(error.message || "新增 Repo 失敗", "error", 0); } finally { this.savingRepo = false; } },
      async probeRemoteBranches() { const url = this.newRepo.repo_url.trim(); if (!url || url === this.lastProbedUrl) return; this.lastProbedUrl = url; this.probingBranches = true; this.branchProbeError = ""; try { const data = await Api.get(`git/remote-branches?url=${encodeURIComponent(url)}`); this.remoteBranches = data.ok ? data.branches || [] : []; this.branchProbeError = data.ok ? "" : (data.reason || "讀不到分支"); this.newRepo.base_branch = data.defaultBranch || ""; } catch (error) { this.remoteBranches = []; this.branchProbeError = error.message || "讀不到分支"; } finally { this.probingBranches = false; } },
      // 貼上網址當下就去讀分支：等游標離開欄位才讀，等於逼人多點一下畫面才看得到選項。
      onRepoUrlPaste() { setTimeout(() => this.probeRemoteBranches(), 0); },
      openBranchPicker() { if (this.probingBranches || !this.remoteBranches.length) return; this.branchPickerOpen = true; this.branchQuery = ""; this.$nextTick(() => this.$refs.branchTrigger?.focus()); },
      // 標籤空著就拿分支名補：兩欄十之八九同名，讓人再打一次是白工。
      selectBranch(branch) { this.newRepo.base_branch = branch; if (branch && !this.newRepo.label.trim()) this.newRepo.label = branch; this.branchPickerOpen = false; this.branchQuery = ""; },
      onBranchPickerKeydown(event) {
        if (event.key === "Escape") { this.branchPickerOpen = false; this.branchQuery = ""; this.$nextTick(() => this.$refs.branchTrigger?.focus()); return; }
        if (event.key === "Enter" && this.branchPickerOpen) { const first = this.filteredBranches[0]; if (first) { event.preventDefault(); this.selectBranch(first); } return; }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!this.branchPickerOpen) return this.openBranchPicker();
          const options = this.$refs.branchOptions ? Array.from(this.$refs.branchOptions.querySelectorAll("button")) : [];
          const index = options.indexOf(document.activeElement);
          (options[index + (event.key === "ArrowDown" ? 1 : -1)] || options[event.key === "ArrowDown" ? 0 : options.length - 1])?.focus();
        }
      },
      async removeRepo(id) { if (!await confirmDialog({ title: "移除 Repo", message: "確定移除此 repo？本機 clone 的程式碼將一併刪除，且無法復原。", danger: true, confirmText: "移除" })) return; try { await Api.delete(`projects/${this.$route.params.id}/repos/${id}`); await this.load(); } catch (error) { showToast(error.message || "移除失敗", "error", 0); } }, async reclone(id) { try { await Api.post(`projects/${this.$route.params.id}/repos/${id}/reclone`, {}); await this.load(); } catch (error) { showToast(error.message || "同步失敗", "error", 0); } }, updateRepo(id) { return this.reclone(id); },
      unreadCount() { return this.project ? (window.UnreadStore.byProject[String(this.project.id)] || this.project.unread_count || 0) : 0; },  // 七個頁籤裡只有三個是同一頁的區塊，其餘四個是獨立路由；切同頁的頁籤要同步寫進 ?tab=，否則重整會跳回第一個。
      selectTab(key) {
        // 分頁可能因總開關關閉而不存在（含有人存了 ?tab=deploy 的深連結）
        if (!this.tabs.some((t) => t[0] === key)) key = "chat";
        this.detailTab = key; this.$router.replace({ query: { ...this.$route.query, tab: key } });
        if (key === "chat") this.loadChats(); },
      // 對話清單只在切到該頁籤時才讀，進專案頁不必先打這支 API。
      async saveBasics() {
        const name = this.editName.trim();
        if (!name || this.savingBasics) return;
        this.savingBasics = true;
        try {
          const updated = await Api.put(`projects/${this.$route.params.id}`, { name, description: this.editDescription });
          this.project = { ...this.project, name: updated.name, description: updated.description };
          // 側欄專案清單印的就是這個 name，外殼只載一次，不通知它就會一路顯示舊名字。
          window.dispatchEvent(new CustomEvent("ui-next:sidebar-refresh"));
          showToast("已儲存", "success");
        } catch (error) { showToast(error.message || "儲存失敗", "error"); }
        finally { this.savingBasics = false; }
      },
      async loadChats() {
        this.chatsLoading = true; this.chatsError = "";
        // 示範專案 id 是 'demo'，打真 API 會 500（後端拿它比對 integer 的 project_id）——同 loadProjectChats。
        if (this.isTourDemo()) { this.chats = window.TourDemo.chats(); this.chatsLoading = false; return; }
        try { this.chats = await Api.get(`projects/${this.$route.params.id}/chats`); }
        catch (error) { this.chatsError = error.message || "無法載入對話清單"; }
        finally { this.chatsLoading = false; }
      },
      // 「新對話」先展開輸入框而不是直接建一則空對話：截圖說明問題最常走貼上這條路，
      // 而建完才跳進對話頁貼圖，等於逼人先進去再重打一次背景。留白直接按「開始對話」，
      // 行為與原本的「建一則空對話並跳進去」完全相同。
      openNewChat() { this.showNewChat = true; this.$nextTick(() => this.$refs.newChatText?.focus()); },
      resetNewChat() { this.revokeNewChatUrls(); this.newChatTitle = ""; this.newChatText = ""; this.newChatFiles = []; this.newChatPreviews = []; this.showNewChat = false; },
      onNewChatPaste(event) { const files = Array.from((event.clipboardData || {}).files || []).filter((file) => window.CHAT_FILE_TYPES.allows(file)); if (files.length) { event.preventDefault(); this.addNewChatFiles(files); } },
      onNewChatFilesSelected(event) { this.addNewChatFiles(Array.from(event.target.files || [])); event.target.value = ""; },
      // 限制與對話輸入列同一組：window.CHAT_FILE_TYPES，與後端 lib/attachments.js 同一份清單。
      // previews 對非圖片存空字串（沒有縮圖可畫），模板因此用 index 當 key，不是 url。
      addNewChatFiles(files) { files.forEach((file) => { if (!window.CHAT_FILE_TYPES.allows(file) || file.size > window.CHAT_FILE_TYPES.maxBytes || this.newChatFiles.length >= window.CHAT_FILE_TYPES.maxFiles) return; this.newChatFiles.push(file); this.newChatPreviews.push(window.CHAT_FILE_TYPES.isImage(file) ? URL.createObjectURL(file) : ""); }); },
      removeNewChatFile(index) { if (this.newChatPreviews[index]) URL.revokeObjectURL(this.newChatPreviews[index]); this.newChatFiles.splice(index, 1); this.newChatPreviews.splice(index, 1); },
      revokeNewChatUrls() { this.newChatPreviews.forEach((url) => { if (url) URL.revokeObjectURL(url); }); },
      async createChat() {
        if (this.creatingChat) return;
        this.creatingChat = true;
        const content = this.newChatText.trim(), files = this.newChatFiles.slice();
        try { const chat = await Api.post(`projects/${this.$route.params.id}/chats`, { title: this.newChatTitle.trim() || "新對話" });
          // 理由同 ProjectChat.createChat：側欄的最近對話要看到這場新對話。
          window.dispatchEvent(new CustomEvent("ui-next:sidebar-refresh"));
          // ⚠ 訊息端點會 await 整輪 AI 回覆（動輒數分鐘），等它回來才換頁＝畫面像當掉。
          // 比照首頁：送出即不等待，對話頁靠 ?pending=1 立刻進入「回覆中」並開始輪詢。
          if (content || files.length) {
            let request;
            if (files.length) { const form = new FormData(); form.append("content", content); files.forEach((file) => form.append("files", file)); request = Api.postForm(`projects/${this.$route.params.id}/chats/${chat.id}/messages`, form); }
            else request = Api.post(`projects/${this.$route.params.id}/chats/${chat.id}/messages`, { content });
            request.catch((error) => showToast(error.message || "訊息送出失敗", "error", 0));
            try { sessionStorage.setItem(`ui-next:pending-msg:${chat.id}`, content); } catch (_) { /* 隱私模式沒有 sessionStorage，退回原本的空白等待 */ }
          }
          this.resetNewChat();
          this.$router.push(`/projects/${this.$route.params.id}/chat/${chat.id}${content || files.length ? "?pending=1" : ""}`); }
        catch (error) { showToast(error.message || "無法建立對話", "error"); }
        finally { this.creatingChat = false; }
      },
      openChat(chat) { this.$router.push(`/projects/${this.$route.params.id}/chat/${chat.id}`); },
      chatDate(value) { return value ? new Date(value).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"; },
      
      async setupEnv() { this.envWorking = true; try { await Api.post(`projects/${this.$route.params.id}/env/setup`, {}); this.env = { ...(this.env || {}), status: "setting_up" }; showToast("環境建立已開始", "success"); } catch (error) { showToast(error.message || "建立環境失敗", "error", 0); } finally { this.envWorking = false; } }, async stopEnv() { this.envWorking = true; try { await Api.post(`projects/${this.$route.params.id}/env/stop`, {}); await this.loadEnv(); } finally { this.envWorking = false; } }, async releaseExternal() { await Api.post(`projects/${this.$route.params.id}/env/external/release`, {}); await this.loadEnv(); }, openEnv() { return openEnvTab(this.$route.params.id); }, async viewLog() { this.logLoading = true; try { const data = await Api.get(`projects/${this.$route.params.id}/env/log`); this.runtimeLog = data.exists ? data.log || "（log 為空）" : "（尚無 log 檔）"; } finally { this.logLoading = false; } }, async deleteEnv() { if (!await confirmDialog({ title: "刪除測試環境", message: "確定刪除整個測試環境？", danger: true, confirmText: "刪除" })) return; await Api.delete(`projects/${this.$route.params.id}/env`); await this.loadEnv(); },
      // 沒有 catch 的話後端一拒絕（這支是平台管理員限定）就是一個沒人接的 promise rejection：
      // 畫面完全沒反應，使用者只會再按一次、再一次，然後認定平台壞了。形狀比照同檔的 saveBasics。
      async saveProjectMapping() { try { await Api.patch(`projects/${this.project.id}/mapping`, { odoo_project_name: this.editOdooProjectName || null, service_respondent_name: this.editServiceRespondentName || null, service_contact_name: this.editServiceContactName || null }); showToast("已儲存", "success"); } catch (error) { showToast(error.message || "儲存失敗", "error"); } }, async saveE2eSetting() { this.savingE2e = true; try { await Api.patch(`projects/${this.project.id}`, { e2e_disabled: !this.editE2eEnabled }); } finally { this.savingE2e = false; } }, async saveEdition() { this.savingEdition = true; try { await Api.patch(`projects/${this.project.id}`, { edition: this.editEdition }); } finally { this.savingEdition = false; } }, async saveAutoDeploy() { this.savingAutoDeploy = true; try { await Api.patch(`projects/${this.project.id}`, { auto_deploy_enabled: this.editAutoDeploy }); this.project.auto_deploy_enabled = this.editAutoDeploy; this.selectTab(this.detailTab); } catch (e) { this.editAutoDeploy = !this.editAutoDeploy; showToast(e.message || '儲存失敗', 'error', 0); } finally { this.savingAutoDeploy = false; } }, isAdmin() { return window.UserStore.role === "admin"; },
    },
    template: `
      <section v-if="loading" class="ui-next-page">
<div class="ui-next-loading-card">載入專案中…</div>
</section>
      <!-- loadError 一定要排在 project 之前判：載入失敗時 project 仍是 null，會掉進最後那個
           「專案不存在」的 v-else——把網路／權限錯誤誤報成資料不存在，使用者會去找根本沒消失的專案。 -->
      <section v-else-if="loadError" class="ui-next-page">
<div class="ui-next-loading-card ui-next-error-text">{{ loadError }} <button type="button" @click="load">重試</button></div>
</section>
      <section v-else-if="project" class="ui-next-page ui-next-project-detail">
        <header class="ui-next-page-head ui-next-detail-head">
<div>
<h1>{{ project.name }}</h1>
<p>{{ project.description || '集中管理 Repo、測試環境與專案設定。' }}</p>
</div>
<div class="ui-next-detail-actions">
<button @click="openEnv">測試區</button>
<!-- 條件用後端算好的 project.can_release（GET /api/projects/:id 已補，見 project-routes.js），
     不能用 isAdmin：判準是 canReleaseProject（平台管理員 or 該專案綁定勾了可上正式的公司管理員），
     光看 role 算不出來，掛 isAdmin 會把有權限的公司管理員也擋掉。 -->
<button @click="showReleaseModal=true" :disabled="project.can_release&&!repos.some(r=>r.clone_status==='done')">{{ project.can_release?'上正式':'待上正式清單' }}</button>
<button class="ui-next-back" @click="$router.push('/projects')"><ui-next-icon name="arrow-left"/> 所有專案</button>
</div>
</header>
        <div class="ui-next-project-statbar">
<span>Odoo {{ project.odoo_version || '—' }}</span>
<span>{{ editEdition==='enterprise'?'企業版':'社群版' }}</span>
<span>{{ repos.length }} 個 Repo</span>
<span :class="['is-'+(env&&env.status||'idle')]">{{ {idle:'環境未建立',setting_up:'環境建立中',running:'環境運行中',error:'環境發生錯誤'}[env&&env.status] || '環境未建立' }}</span>
</div>
        <nav data-tour="pd-tools" class="ui-next-detail-tabs">
<button :data-tour="'pd-tab-' + tab[0]" v-for="tab in tabs" :key="tab[0]" :class="{active:detailTab===tab[0]}" @click="selectTab(tab[0])">{{ tab[1] }}<span v-if="tab[0]==='chat'&&unreadCount()">{{ unreadCount() }}</span></button>
</nav>
        <!-- isAdmin() 是縱深防禦（回合 1 審查發現）：分頁列藏了 repos 不代表這裡也擋了，
             detailTab 只要用任何路徑（含深連結一拍未修正前）落到 'repos'，這個含新增/移除/
             重新同步的整塊就會照畫。 -->
        <div v-if="detailTab==='repos'&&isAdmin()" class="ui-next-project-detail-grid">
<section data-tour="pd-repos" class="ui-next-panel ui-next-repos">
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
<input v-model="newRepo.repo_url" placeholder="Git URL" @paste="onRepoUrlPaste" @blur="probeRemoteBranches">
<div class="ui-next-branch-picker" @keydown="onBranchPickerKeydown" @click="openBranchPicker">
<input ref="branchTrigger" type="text" role="combobox" aria-autocomplete="list" aria-label="主分支" :aria-expanded="branchPickerOpen" :disabled="probingBranches||!remoteBranches.length" :value="branchPickerOpen?branchQuery:newRepo.base_branch" :placeholder="probingBranches?'讀取分支中…':(remoteBranches.length?'主分支':(branchProbeError||'主分支自動偵測'))" @focus="openBranchPicker" @input="branchQuery=$event.target.value;branchPickerOpen=true">
<ui-next-icon name="chevron-down"/>
<div v-if="branchPickerOpen" ref="branchOptions" class="ui-next-project-picker-options" role="listbox" aria-label="選擇主分支" @click.stop>
<button type="button" role="option" :aria-selected="!newRepo.base_branch" @click="selectBranch('')">自動偵測</button>
<button v-for="branch in filteredBranches" :key="branch" type="button" role="option" :aria-selected="branch===newRepo.base_branch" @click="selectBranch(branch)">{{ branch }}</button>
<p v-if="!filteredBranches.length">找不到符合的分支</p>
</div>
</div>
<label>
<input type="checkbox" v-model="newRepo.is_primary"> 主要 Repo</label>
<button class="ui-next-primary" :disabled="savingRepo||probingBranches">{{ savingRepo?'新增中…':'新增 Repo' }}</button>
</form>
</section>
</div>
        <section v-if="detailTab==='env'" data-tour="pd-env" class="ui-next-panel ui-next-env-card">
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
<!-- 這四顆對應 env-routes.js 的四支平台管理員限定端點（建立/停止/刪除/歸還對外名額）；
     開啟測試區、查看 log、重新整理走的是開放給所有人的 GET，維持不擋。 -->
<button v-if="isAdmin()&&(!env||env.status==='idle'||env.status==='error')" class="ui-next-primary" @click="setupEnv" :disabled="envWorking">{{ envWorking?'處理中…':(env&&env.built?'重新啟動':'建立環境') }}</button>
<button v-if="env&&env.status==='running'" class="ui-next-primary" @click="openEnv">開啟測試區</button>
<button v-if="isAdmin()&&env&&env.status==='running'&&env.external_slot!=null" @click="releaseExternal" :disabled="envWorking">關閉對外</button>
<button v-if="isAdmin()&&env&&env.status==='running'" @click="stopEnv" :disabled="envWorking">停止</button>
<button v-if="env&&(env.built||env.status!=='idle')" @click="viewLog" :disabled="logLoading">{{ logLoading?'讀取中…':'查看 log' }}</button>
<button v-if="isAdmin()&&env&&(env.status!=='idle'||env.built)" class="danger" @click="deleteEnv" :disabled="envWorking">刪除環境</button>
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
        <section v-if="embeddedTab" class="ui-next-embedded-tab"><component :is="embeddedTab" :embedded="true"/></section>
<section v-if="detailTab==='chat'" class="ui-next-panel ui-next-chat-tab">
<div class="ui-next-card-title">
<div><h2>對話</h2><p>{{ chats.length }} 則對話；點一則進入專心模式。</p></div>
<button v-if="!showNewChat" class="ui-next-primary" @click="openNewChat">新對話</button>
</div>
<div v-if="showNewChat" class="ui-next-new-chat">
<input v-model="newChatTitle" placeholder="對話標題（選填）">
<textarea ref="newChatText" v-model="newChatText" class="ui-next-new-chat-text" placeholder="第一句想問什麼…可貼上截圖或附檔案" @paste="onNewChatPaste"></textarea>
<div v-if="newChatPreviews.length" class="ui-next-new-chat-files">
<span v-for="(url,index) in newChatPreviews" :key="index"><img v-if="url" :src="url" alt="待傳圖片" title="點擊放大" @click="previewImage({src:url})"><em v-else class="ui-next-file-chip"><ui-next-icon name="paperclip"/>{{ newChatFiles[index] && newChatFiles[index].name }}</em><button type="button" aria-label="移除待傳附件" @click="removeNewChatFile(index)"><ui-next-icon name="close"/></button></span>
</div>
<div class="ui-next-new-chat-foot">
<label class="ui-next-icon-button" title="上傳附件"><ui-next-icon name="paperclip"/><input type="file" accept="${window.CHAT_FILE_TYPES.accept}" multiple aria-label="上傳附件" @change="onNewChatFilesSelected"></label>
<span class="ui-next-new-chat-actions"><button type="button" @click="resetNewChat">取消</button><button type="button" class="ui-next-primary" @click="createChat" :disabled="creatingChat">{{ creatingChat?'建立中…':'開始對話' }}</button></span>
</div>
</div>
<input v-if="chats.length" v-model="chatSearch" class="ui-next-chat-tab-search" type="search" placeholder="搜尋對話標題" aria-label="搜尋對話">
<p v-if="chatsError" class="ui-next-inline-error" role="alert">{{ chatsError }} <button type="button" @click="loadChats">重試</button></p>
<p v-else-if="chatsLoading" class="ui-next-chat-tab-empty">載入中…</p>
<p v-else-if="!chats.length" class="ui-next-chat-tab-empty">還沒有對話。建立一則，討論會保留在這個專案裡。</p>
<p v-else-if="!filteredChats.length" class="ui-next-chat-tab-empty">沒有符合「{{ chatSearch }}」的對話。</p>
<ul v-else class="ui-next-chat-tab-list">
<li v-for="chat in filteredChats" :key="chat.id">
<button type="button" @click="openChat(chat)">
<b>{{ chat.title || '新對話' }}</b>
<span v-if="chat.unread" class="ui-next-chat-tab-unread">{{ chat.unread }}</span>
<em v-if="chat.reply_pending">AI 回覆中</em>
<em v-if="chat.converted_task_id" class="ui-next-chat-tab-task" :title="'已轉為任務 #'+chat.converted_task_id+'，點擊開啟'" @click.stop="$router.push('/task/'+chat.converted_task_id)">已轉任務</em>
<small>{{ chatDate(chat.created_at) }}</small>
</button>
</li>
</ul>
</section>
<!-- 縱深防禦，比照上面的 embeddedTab：分頁列已經藏起來，但 detailTab 落到 'settings' 的路徑
           不只一條（data() 的初始猜值、?tab= 深連結、未來新增的入口），區塊本身也要自己擋一層。 -->
<section v-if="detailTab==='settings' && isAdmin()" class="ui-next-project-settings">
<div class="ui-next-panel">
<h2>基本資料</h2>
<p>顯示在專案清單與側欄的名稱與備註。</p>
<label>專案名稱<input v-model="editName" autocomplete="off"></label>
<label>專案備註<textarea v-model="editDescription" placeholder="這個專案在做什麼、有什麼要注意的"></textarea></label>
<template v-if="isAdmin()">
<label class="ui-next-inline-field">Odoo 版本類型
<select v-model="editEdition" @change="saveEdition" :disabled="savingEdition">
<option value="community">社群版（Community）</option>
<option value="enterprise">企業版（Enterprise）</option>
</select>
</label>
<div class="ui-next-inline-field">E2E 測試
<label class="ui-next-toggle ui-next-toggle-row">
<input type="checkbox" v-model="editE2eEnabled" @change="saveE2eSetting" :disabled="savingE2e">
<span></span>{{ editE2eEnabled?'啟用中':'已停用' }}</label>
</div>
<div v-if="isAdmin()" class="ui-next-inline-field">自動部署
<label class="ui-next-toggle ui-next-toggle-row">
<input type="checkbox" v-model="editAutoDeploy" @change="saveAutoDeploy" :disabled="savingAutoDeploy">
<span></span>{{ editAutoDeploy?'啟用中':'已停用' }}</label>
</div>
<p v-if="editAutoDeploy" class="ui-next-field-hint">任務核准併入 ai-dev 會自動部署到客戶測試區；按「上正式」會接著部署到客戶正式區。部署失敗只還原程式檔案，<b>資料庫的改動不會還原</b>。</p>
</template>
<div class="ui-next-panel-actions">
<button class="ui-next-primary" @click="saveBasics" :disabled="savingBasics||!editName.trim()">{{ savingBasics?'儲存中…':'儲存' }}</button>
</div>
</div>
<div data-tour="pd-mapping" class="ui-next-panel">
<h2>同步來源對應</h2>
<p>一行一個名稱，可自動綁定 Odoo 與客服同步來源。</p>
<label>Odoo 專案名稱<textarea v-model="editOdooProjectName" placeholder="一行一個完整名稱">
</textarea>
</label>
<label>客服來源名稱<textarea v-model="editServiceRespondentName" placeholder="一行一個完整名稱">
</textarea>
</label>
<label>主要聯絡人<textarea v-model="editServiceContactName" placeholder="一行一個完整名稱">
</textarea>
</label>
<div class="ui-next-panel-actions">
<button class="ui-next-primary" @click="saveProjectMapping">儲存對應</button>
</div>
</div>

</section>
        <ReleaseModal v-if="showReleaseModal" :project-id="$route.params.id" @close="showReleaseModal=false" />
      </section>
      <section v-else class="ui-next-page">
<div class="ui-next-empty-state">專案不存在。</div>
</section>`,
  });

})();
