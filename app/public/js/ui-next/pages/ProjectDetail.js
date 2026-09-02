(function () {
  // 專案詳情保留既有資料與操作（Repo、測試環境、同步設定），畫面改為新版資訊分區。
  window.UiNextProjectDetailView = Vue.defineComponent({
    name: "UiNextProjectDetailView",
    components: {
      SearchableSelect: window.SearchableSelect,
      ReleaseModal: window.ReleaseModal,
      UiNextIcon: window.UiNextIcon,
    },
    data() { return { editServiceContactName: "", editName: "", editDescription: "", savingBasics: false, project: null, repos: [], branchInfo: {}, loading: true, loadError: "", newRepo: { label: "", repo_url: "", is_primary: false, base_branch: "" }, remoteBranches: [], probingBranches: false, lastProbedUrl: null, savingRepo: false, env: null, envWorking: false, editOdooProjectName: "", editServiceRespondentName: "", editE2eEnabled: true, savingE2e: false, editEdition: "community", savingEdition: false, runtimeLog: null, logLoading: false, showReleaseModal: false, detailTab: ["repos","env","settings","chat","db","sop","wiki"].includes(this.$route.query.tab) ? this.$route.query.tab : "chat", chats: [], chatsLoading: false, chatsError: "", chatSearch: "", creatingChat: false, tabs: [["chat","Chat"],["repos","Repo"],["db","連線設定"],["env","測試環境"],["wiki","Wiki"],["sop","部署 SOP"],["settings","設定"]], _pollTimer: null, _reposPollTimer: null }; },
    computed: { embeddedTab() { return { db: window.UiNextDbView, sop: window.UiNextDeploySopView, wiki: window.UiNextWikiView }[this.detailTab] || null; }, filteredChats() { const q = this.chatSearch.trim().toLowerCase(); return q ? this.chats.filter((c) => (c.title || "新對話").toLowerCase().includes(q)) : this.chats; }, hasCloning() { return this.repos.some((repo) => repo.clone_status === "cloning"); }, envActive() { return !!(this.env && (this.env.status === "setting_up" || this.env.status === "running" || this.env.built)); } },
    watch: {
      "$route.query.tab"(tab) {
        const next = ["repos","env","settings","chat","db","sop","wiki"].includes(tab) ? tab : "chat";
        if (next === this.detailTab) return;
        this.detailTab = next;
        if (next === "chat") this.loadChats();
      },
      "env.status"(value) { if (value === "setting_up") this._startPoll(); else this._stopPoll(); },
      hasCloning(value) { if (value) this._startReposPoll(); else this._stopReposPoll(); },
    },
    async created() { await Promise.all([this.load(), this.loadEnv()]); if (this.detailTab === "chat") this.loadChats(); },
    // 沒有這行，離開專案頁之後那兩個 timer 還會繼續打 API（元件早就卸載，畫面也不會更新）。
    beforeUnmount() { this._stopPoll(); this._stopReposPoll(); },
    methods: {
      // 環境建立／repo clone 都是背景長工，後端不推事件；不輪詢的話「建立中」「同步中」會永遠停在原地。
      _startPoll() { if (this._pollTimer) return; this._pollTimer = setInterval(() => this.loadEnv(), 5000); },
      _stopPoll() { if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; } },
      _startReposPoll() { if (this._reposPollTimer) return; this._reposPollTimer = setInterval(async () => { const data = await Api.get(`projects/${this.$route.params.id}`).catch(() => null); if (data) this.repos = data.repos || []; }, 3000); },
      _stopReposPoll() { if (this._reposPollTimer) { clearInterval(this._reposPollTimer); this._reposPollTimer = null; } },
      async load() { this.loading = true; this.loadError = ""; try { const data = await Api.get(`projects/${this.$route.params.id}`); this.project = data; this.editName = this.project?.name || ""; this.editDescription = this.project?.description || ""; this.repos = data.repos || []; this.editOdooProjectName = data.odoo_project_name || ""; this.editServiceRespondentName = data.service_respondent_name || ""; this.editServiceContactName = data.service_contact_name || ""; this.editE2eEnabled = !data.e2e_disabled; this.editEdition = data.edition || "community"; await Promise.all(this.repos.filter((repo) => repo.clone_status === "done").map(async (repo) => { const info = await Api.get(`projects/${data.id}/repos/${repo.id}/branches`).catch(() => null); if (info) this.branchInfo[repo.id] = info; })); } catch (error) { this.loadError = error.message || "無法載入專案"; showToast(this.loadError, "error", 0); } finally { this.loading = false; } },
      async loadEnv() { this.env = await Api.get(`projects/${this.$route.params.id}/env`).catch(() => this.env || { status: "idle" }); },
      async addRepo() { if (!this.newRepo.label || !this.newRepo.repo_url) return showToast("請填寫標籤和 repo URL", "error"); this.savingRepo = true; try { await Api.post(`projects/${this.$route.params.id}/repos`, { ...this.newRepo }); this.newRepo = { label: "", repo_url: "", is_primary: false, base_branch: "" }; this.remoteBranches = []; await this.load(); showToast("Repo 已新增，正在同步", "success"); } catch (error) { showToast(error.message || "新增 Repo 失敗", "error", 0); } finally { this.savingRepo = false; } },
      async probeRemoteBranches() { const url = this.newRepo.repo_url.trim(); if (!url || url === this.lastProbedUrl) return; this.lastProbedUrl = url; this.probingBranches = true; try { const data = await Api.get(`git/remote-branches?url=${encodeURIComponent(url)}`); this.remoteBranches = data.ok ? data.branches || [] : []; this.newRepo.base_branch = data.defaultBranch || ""; } catch { this.remoteBranches = []; } finally { this.probingBranches = false; } },
      async removeRepo(id) { if (!await confirmDialog({ title: "移除 Repo", message: "確定移除此 repo？本機 clone 的程式碼將一併刪除，且無法復原。", danger: true, confirmText: "移除" })) return; try { await Api.delete(`projects/${this.$route.params.id}/repos/${id}`); await this.load(); } catch (error) { showToast(error.message || "移除失敗", "error", 0); } }, async reclone(id) { try { await Api.post(`projects/${this.$route.params.id}/repos/${id}/reclone`, {}); await this.load(); } catch (error) { showToast(error.message || "同步失敗", "error", 0); } }, updateRepo(id) { return this.reclone(id); },
      unreadCount() { return this.project ? (window.UnreadStore.byProject[String(this.project.id)] || this.project.unread_count || 0) : 0; },  // 七個頁籤裡只有三個是同一頁的區塊，其餘四個是獨立路由；切同頁的頁籤要同步寫進 ?tab=，否則重整會跳回第一個。
      selectTab(key) { 
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
          showToast("已儲存", "success");
        } catch (error) { showToast(error.message || "儲存失敗", "error"); }
        finally { this.savingBasics = false; }
      },
      async loadChats() {
        this.chatsLoading = true; this.chatsError = "";
        try { this.chats = await Api.get(`projects/${this.$route.params.id}/chats`); }
        catch (error) { this.chatsError = error.message || "無法載入對話清單"; }
        finally { this.chatsLoading = false; }
      },
      async createChat() {
        if (this.creatingChat) return;
        this.creatingChat = true;
        try { const chat = await Api.post(`projects/${this.$route.params.id}/chats`, { title: "新對話" });
          this.$router.push(`/projects/${this.$route.params.id}/chat/${chat.id}`); }
        catch (error) { showToast(error.message || "無法建立對話", "error"); }
        finally { this.creatingChat = false; }
      },
      openChat(chat) { this.$router.push(`/projects/${this.$route.params.id}/chat/${chat.id}`); },
      chatDate(value) { return value ? new Date(value).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"; },
      
      async setupEnv() { this.envWorking = true; try { await Api.post(`projects/${this.$route.params.id}/env/setup`, {}); this.env = { ...(this.env || {}), status: "setting_up" }; showToast("環境建立已開始", "success"); } catch (error) { showToast(error.message || "建立環境失敗", "error", 0); } finally { this.envWorking = false; } }, async stopEnv() { this.envWorking = true; try { await Api.post(`projects/${this.$route.params.id}/env/stop`, {}); await this.loadEnv(); } finally { this.envWorking = false; } }, async releaseExternal() { await Api.post(`projects/${this.$route.params.id}/env/external/release`, {}); await this.loadEnv(); }, async openEnv() { const popup = window.open("about:blank", "_blank"); try { const url = await pollEnvSso(this.$route.params.id); if (popup) popup.location = url; else window.location.href = url; } catch (error) { if (popup) popup.close(); showToast(error.message || "無法開啟測試區", "error", 0); } }, async viewLog() { this.logLoading = true; try { const data = await Api.get(`projects/${this.$route.params.id}/env/log`); this.runtimeLog = data.exists ? data.log || "（log 為空）" : "（尚無 log 檔）"; } finally { this.logLoading = false; } }, async deleteEnv() { if (!await confirmDialog({ title: "刪除測試環境", message: "確定刪除整個測試環境？", danger: true, confirmText: "刪除" })) return; await Api.delete(`projects/${this.$route.params.id}/env`); await this.loadEnv(); },
      async saveProjectMapping() { await Api.patch(`projects/${this.project.id}/mapping`, { odoo_project_name: this.editOdooProjectName || null, service_respondent_name: this.editServiceRespondentName || null, service_contact_name: this.editServiceContactName || null }); showToast("已儲存", "success"); }, async saveE2eSetting() { this.savingE2e = true; try { await Api.patch(`projects/${this.project.id}`, { e2e_disabled: !this.editE2eEnabled }); } finally { this.savingE2e = false; } }, async saveEdition() { this.savingEdition = true; try { await Api.patch(`projects/${this.project.id}`, { edition: this.editEdition }); } finally { this.savingEdition = false; } }, isAdmin() { return window.UserStore.role === "admin"; },
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
<button @click="openEnv" :disabled="!envActive">測試區</button>
<button @click="showReleaseModal=true" :disabled="!repos.some(r=>r.clone_status==='done')">上正式</button>
<button class="ui-next-back" @click="$router.push('/projects')"><ui-next-icon name="arrow-left"/> 所有專案</button>
</div>
</header>
        <div class="ui-next-project-statbar">
<span>Odoo {{ project.odoo_version || '—' }}</span>
<span>{{ editEdition==='enterprise'?'企業版':'社群版' }}</span>
<span>{{ repos.length }} 個 Repo</span>
<span :class="['is-'+(env&&env.status||'idle')]">{{ {idle:'環境未建立',setting_up:'環境建立中',running:'環境運行中',error:'環境發生錯誤'}[env&&env.status] || '環境未建立' }}</span>
</div>
        <nav class="ui-next-detail-tabs">
<button v-for="tab in tabs" :key="tab[0]" :class="{active:detailTab===tab[0]}" @click="selectTab(tab[0])">{{ tab[1] }}<span v-if="tab[0]==='chat'&&unreadCount()">{{ unreadCount() }}</span></button>
</nav>
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
        <section v-if="embeddedTab" class="ui-next-embedded-tab"><component :is="embeddedTab" :embedded="true"/></section>
<section v-if="detailTab==='chat'" class="ui-next-panel ui-next-chat-tab">
<div class="ui-next-card-title">
<div><h2>對話</h2><p>{{ chats.length }} 則對話；點一則進入專心模式。</p></div>
<button class="ui-next-primary" @click="createChat" :disabled="creatingChat">{{ creatingChat?'建立中…':'新對話' }}</button>
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
<small>{{ chatDate(chat.created_at) }}</small>
</button>
</li>
</ul>
</section>
<section v-if="detailTab==='settings'" class="ui-next-project-settings">
<div class="ui-next-panel">
<h2>基本資料</h2>
<p>顯示在專案清單與側欄的名稱與備註。</p>
<label>專案名稱<input v-model="editName" autocomplete="off"></label>
<label>專案備註<textarea v-model="editDescription" placeholder="這個專案在做什麼、有什麼要注意的"></textarea></label>
<button class="ui-next-primary" @click="saveBasics" :disabled="savingBasics||!editName.trim()">{{ savingBasics?'儲存中…':'儲存' }}</button>
</div>
<div class="ui-next-panel">
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

})();
