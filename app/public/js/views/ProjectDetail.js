window.ProjectDetailView = Vue.defineComponent({
  name: 'ProjectDetailView',
  components: { SearchableSelect: window.SearchableSelect },
  data() {
    return {
      project: null,
      repos: [],
      branchInfo: {},      // repoId → { branches, base_branch, effective, ready }（唯讀顯示用）
      loading: true,
      newRepo: { label: '', repo_url: '', is_primary: false, base_branch: '' },
      remoteBranches: [],  // 新增表單用：ls-remote 讀到的遠端分支（clone 前就要能選）
      probingBranches: false,
      savingRepo: false,
      env: null,
      envWorking: false,
      _pollTimer: null,
      _reposPollTimer: null,
      editOdooProjectName: '',
      editServiceRespondentName: '',
      editE2eDisabled: false,
      savingE2e: false,
      editEdition: 'community',
      savingEdition: false,
      runtimeLog: null,
      logLoading: false,
      showReleaseModal: false
    };
  },
  computed: {
    hasCloning() { return this.repos.some(r => r.clone_status === 'cloning'); },
    hasIndexing() { return this.repos.some(r => r.graphify_status === 'running'); },
    envActive() { return !!(this.env && (this.env.status === 'setting_up' || this.env.status === 'running' || this.env.built)); }
  },
  watch: {
    'env.status'(val) {
      if (val === 'setting_up') this._startPoll();
      else this._stopPoll();
    },
    hasCloning(val) {
      if (val || this.hasIndexing) this._startReposPoll();
      else this._stopReposPoll();
    },
    hasIndexing(val) {
      if (val || this.hasCloning) this._startReposPoll();
      else this._stopReposPoll();
    }
  },
  async created() {
    await this.load();
    await this.loadEnv();
  },
  beforeUnmount() { this._stopPoll(); this._stopReposPoll(); },
  methods: {
    _startPoll() {
      if (this._pollTimer) return;
      this._pollTimer = setInterval(() => this.loadEnv(), 5000);
    },
    _stopPoll() {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    },
    _startReposPoll() {
      if (this._reposPollTimer) return;
      this._reposPollTimer = setInterval(async () => {
        const data = await Api.get(`projects/${this.$route.params.id}`).catch(() => null);
        if (data) this.repos = data.repos || [];
      }, 3000);
    },
    _stopReposPoll() {
      if (this._reposPollTimer) { clearInterval(this._reposPollTimer); this._reposPollTimer = null; }
    },
    async load() {
      this.loading = true;
      try {
        // 新手教程的示範專案（/projects/demo）：資料來自 tour-demo.js，不打 API
        const data = window.TourDemo && window.TourDemo.isProject(this.$route.params.id)
          ? window.TourDemo.project()
          : await Api.get(`projects/${this.$route.params.id}`);
        this.project = data;
        UnreadStore.byProject[String(this.project.id)] = this.project.unread_count || 0;
        this.repos = data.repos || [];
        this.editOdooProjectName = data.odoo_project_name || '';
        this.editServiceRespondentName = data.service_respondent_name || '';
        this.editE2eDisabled = !!data.e2e_disabled;
        this.editEdition = data.edition || 'community';
        // 分支清單另外抓（要讀 clone 的 refs，跟專案主資料不同來源）；示範專案不打 API
        if (!(window.TourDemo && window.TourDemo.isProject(this.$route.params.id))) this.loadBranches();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    async addRepo() {
      if (!this.newRepo.label || !this.newRepo.repo_url) return showToast('請填寫標籤和 repo URL', 'error');
      this.savingRepo = true;
      try {
        await Api.post(`projects/${this.$route.params.id}/repos`, { ...this.newRepo });
        this.newRepo = { label: '', repo_url: '', is_primary: false, base_branch: '' };
        this.remoteBranches = [];
        await this.load();
        showToast('Repo 已新增，正在 clone...', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingRepo = false; }
    },
    async removeRepo(repoId) {
      if (!await confirmDialog({ title: '移除 Repo', message: '確定移除此 repo？本機 clone 的程式碼將一併刪除，且無法復原。', danger: true, confirmText: '移除' })) return;
      try {
        await Api.delete(`projects/${this.$route.params.id}/repos/${repoId}`);
        await this.load();
        showToast('已移除 repo', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    // 讀各 repo「目前生效的主分支」供唯讀顯示（主分支已不可事後修改，故不再需要選項清單）。
    async loadBranches() {
      const id = this.$route.params.id;
      for (const r of this.repos.filter(x => x.clone_status === 'done')) {
        const d = await Api.get(`projects/${id}/repos/${r.id}/branches`).catch(() => null);
        if (d) this.branchInfo[r.id] = d;
      }
    },
    // 新增 repo 前先問遠端有哪些分支。clone 還沒發生，所以走 ls-remote 而非本地 refs。
    // 讀不到就靜靜維持自動偵測：私有 repo 沒 PAT、網址打到一半都會失敗，那不該打斷填表。
    async probeRemoteBranches() {
      const url = (this.newRepo.repo_url || '').trim();
      this.remoteBranches = [];
      this.newRepo.base_branch = '';
      if (!url) return;
      this.probingBranches = true;
      try {
        const d = await Api.get(`git/remote-branches?url=${encodeURIComponent(url)}`);
        if (d && d.ok) {
          this.remoteBranches = d.branches || [];
          // 預選遠端預設分支（origin/HEAD）：多數情況這就是對的，讓人確認而不是從頭挑。
          if (d.defaultBranch) this.newRepo.base_branch = d.defaultBranch;
        }
      } catch { /* 降級成自動偵測 */ }
      finally { this.probingBranches = false; }
    },
    async reclone(repoId) {
      try {
        await Api.post(`projects/${this.$route.params.id}/repos/${repoId}/reclone`, {});
        await this.load();
        showToast('重新 clone 已開始', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    async updateRepo(repoId) {
      try {
        await Api.post(`projects/${this.$route.params.id}/repos/${repoId}/reclone`, {});
        await this.load();
        showToast('更新中（git pull 最新程式碼）...', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    async initWiki() {
      const doneRepos = this.repos.filter(r => r.clone_status === 'done');
      if (!doneRepos.length) {
        return showToast('請先新增 Repo 並等待 clone 完成', 'error');
      }
      try {
        await Api.post(`projects/${this.$route.params.id}/wiki/init`, {});
        showToast('Wiki 初始化完成', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    unreadCount() { return this.project ? (UnreadStore.byProject[String(this.project.id)] || 0) : 0; },
    goWiki() { this.$router.push(`/projects/${this.$route.params.id}/wiki`); },
    goChat() { this.$router.push(`/projects/${this.$route.params.id}/chat`); },
    async loadEnv() {
      if (window.TourDemo && window.TourDemo.isProject(this.$route.params.id)) { this.env = window.TourDemo.env(); return; }
      try {
        this.env = await Api.get(`projects/${this.$route.params.id}/env`);
      } catch {
        // 暫時性失敗（server 重啟、網路抖動）不得改寫狀態：寫成 idle 會讓 env.status 的 watcher
        // 立刻 _stopPoll()，之後再也沒有人去問真實狀態，畫面永遠停在「未建立」但環境其實正在建。
        // 「這專案沒有環境」後端是回 200 + {status:'idle'}（見 env-routes.js），走的是成功路徑，
        // 所以保留舊狀態不會讓已刪除的環境留下殘影。只有首次載入尚無狀態可留時才給預設值。
        if (!this.env) this.env = { status: 'idle' };
      }
    },
    async setupEnv() {
      const restart = this.env && this.env.built;
      this.envWorking = true;
      try {
        await Api.post(`projects/${this.$route.params.id}/env/setup`, {});
        showToast(restart ? '環境啟動中...' : '環境建立已開始，系統自動分配 port...', 'success');
        // 樂觀進入「建立中」：立即以 loading 取代按鈕、觸發輪詢，避免空窗期重複點擊
        // 注意：不在此立即呼叫 loadEnv()，因 runEnvSetup 為 fire-and-forget，
        // DB 可能尚未寫入 setting_up，即時查詢會拿到舊狀態並觸發 _stopPoll() 殺死輪詢
        this.env = { ...(this.env || {}), status: 'setting_up' };
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.envWorking = false; }
    },
    async stopEnv() {
      this.envWorking = true;
      try {
        await Api.post(`projects/${this.$route.params.id}/env/stop`, {});
        showToast('環境已停止', 'success');
        await this.loadEnv();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.envWorking = false; }
    },
    // 對外檢視名額只有 10 個、且真人「關掉分頁」偵測不到，沒有這顆按鈕就只剩「閒置 20 分」
    // 一條歸還路徑——別人得乾等前一個人逾時才借得到。只收名額、不停環境（pipeline 可能還在用）。
    async releaseExternal() {
      this.envWorking = true;
      try {
        await Api.post(`projects/${this.$route.params.id}/env/external/release`, {});
        showToast('已歸還對外名額，環境仍在運行', 'success');
        await this.loadEnv();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.envWorking = false; }
    },
    async openEnv() {
      // JWT 走 Authorization header，瀏覽器導航不會帶上 → 先 fetch SSO 端點拿免密登入 URL 再開。
      // popup-blocker：window.open 必須在 click handler 內同步開，不能等 await 後才開。
      const w = window.open('about:blank', '_blank');
      // 環境可能已被閒置回收，後端會自動起並回 starting；首建可達數分鐘，
      // 空白分頁乾等會被當成當掉，故先在分頁裡寫一句話再輪詢。
      if (w) {
        try {
          w.document.write('<p style="font-family:sans-serif;padding:2rem">測試區建立中，請稍候…</p>');
        } catch (e) { console.debug('about:blank document.write 被瀏覽器擋下，不影響後續導向:', e && e.message); }
      }
      try {
        const url = await pollEnvSso(this.$route.params.id);
        if (w) w.location = url; else window.location = url;
      } catch (e) {
        if (w) w.close();
        showToast(e.message || '無法開啟測試區', 'error');
      }
    },
    async viewLog() {
      this.logLoading = true;
      try {
        const data = await Api.get(`projects/${this.$route.params.id}/env/log`);
        this.runtimeLog = data.exists ? (data.log || '（log 為空，server 尚未輸出）') : '（尚無 log 檔，環境未啟動過）';
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.logLoading = false; }
    },
    async deleteEnv() {
      if (!await confirmDialog({ title: '刪除測試環境', message: '確定刪除整個測試環境？將移除 Odoo 原始碼與 venv（數 GB），下次需重新建立。', danger: true, confirmText: '刪除' })) return;
      this.envWorking = true;
      try {
        await Api.delete(`projects/${this.$route.params.id}/env`);
        showToast('環境已刪除', 'success');
        await this.loadEnv();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.envWorking = false; }
    },
    async saveProjectMapping() {
      try {
        const payload = {
          odoo_project_name:       this.editOdooProjectName      || null,
          service_respondent_name: this.editServiceRespondentName || null
        };
        await Api.patch(`projects/${this.project.id}/mapping`, payload);
        showToast('已儲存', 'success');
        await this.load();
      } catch (err) { showToast(err.message, 'error'); }
    },
    async saveE2eSetting() {
      this.savingE2e = true;
      try {
        await Api.patch(`projects/${this.project.id}`, { e2e_disabled: this.editE2eDisabled });
        showToast(this.editE2eDisabled ? '已停用 E2E 測試' : '已啟用 E2E 測試', 'success');
        await this.load();
      } catch (err) { showToast(err.message, 'error'); }
      finally { this.savingE2e = false; }
    },
    async saveEdition() {
      this.savingEdition = true;
      try {
        await Api.patch(`projects/${this.project.id}`, { edition: this.editEdition });
        showToast('已儲存，需重新建置測試區才會生效', 'success');
        await this.load();
      } catch (err) { showToast(err.message, 'error'); }
      finally { this.savingEdition = false; }
    },
    isAdmin() { return window.UserStore.role === 'admin'; }
  },
  template: `
    <div v-if="loading" class="loading">載入中...</div>
    <template v-else-if="project">
      <div class="topbar">
        <button class="btn btn-outline btn-sm" @click="$router.push('/projects')" style="margin-right:var(--space-3)">← 返回</button>
        <h1>{{ project.name }}</h1>
        <span style="font-size:var(--fs-base);color:var(--text-muted);margin-left:var(--space-3)">Odoo {{ project.odoo_version }}</span>
        <div data-tour="pd-tools" style="display:flex;gap:6px;margin-left:var(--space-4)">
          <button class="btn btn-outline btn-sm" style="background:var(--primary);color:#fff">設定</button>
          <button class="btn btn-outline btn-sm" @click="showReleaseModal = true"
            :disabled="!repos.some(r => r.clone_status === 'done')"
            title="把 ai-dev 上已核准的任務合併到 main">🚀 上正式</button>
          <button class="btn btn-outline btn-sm" @click="$router.push('/projects/'+project.id+'/db')">資料庫查詢</button>
          <button class="btn btn-outline btn-sm" @click="goWiki">📖 Wiki</button>
          <button class="btn btn-outline btn-sm" @click="goChat">💬 Chat
            <span v-if="unreadCount()" style="display:inline-block;min-width:16px;padding:0 5px;margin-left:var(--space-1);border-radius:var(--radius);background:var(--error,#e5484d);color:#fff;font-size:var(--fs-xs);line-height:16px;text-align:center">{{ unreadCount() }}</span>
          </button>
          <button v-if="!project.has_wiki" class="btn btn-outline btn-sm" @click="initWiki">🔄 初始化 Wiki</button>
        </div>
      </div>
      <div class="content">
        <div v-if="project.description" style="color:var(--text-muted);font-size:var(--fs-base);margin-bottom:var(--space-4)">{{ project.description }}</div>

        <!-- 教程錨點：整個 repo 區塊要一起被打光，故只加一層 wrapper，內層不重排縮排 -->
        <div data-tour="pd-repos">
        <div class="form-section">Git Repositories</div>
        <div v-if="repos.length === 0" style="color:var(--text-muted);font-size:var(--fs-base);margin-bottom:var(--space-4)">尚未綁定任何 repo</div>
        <div v-for="r in repos" :key="r.id" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-3);margin-bottom:var(--space-2)">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span style="font-weight:var(--fw-semibold)">{{ r.label }}</span>
                <span v-if="r.is_primary" style="font-size:var(--fs-xs);background:var(--primary);color:#fff;border-radius:4px;padding:1px 6px">主要</span>
                <span v-if="r.clone_status === 'cloning'" class="pill pill-info">⟳ Clone 中...</span>
                <span v-else-if="r.clone_status === 'done'" class="pill pill-success">✓ 已同步</span>
                <span v-else-if="r.clone_status === 'error'" class="pill pill-danger">✕ Clone 失敗</span>
                <span v-if="r.graphify_status === 'running'" class="pill pill-warn">⟳ 索引中...</span>
                <span v-else-if="r.graphify_status === 'done'" class="pill pill-success">✓ 已索引</span>
                <span v-else-if="r.graphify_status === 'error'" class="pill pill-danger" :title="r.graphify_error">✕ 索引失敗</span>
              </div>
              <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:2px">{{ r.repo_url }}</div>
              <div v-if="r.local_path" style="font-size:var(--fs-sm);color:var(--text-muted)">路徑：{{ r.local_path }}</div>
              <!-- 主分支只讀：AI 的 ai-dev 分支是新增 repo 當下從主分支長出來的，事後改設定並不會
                   讓它跟著搬家，同步從此變成兩條平行線硬合。與其留一個必然造成不一致的入口，
                   不如關掉——要換主分支請移除 repo 後重新新增。 -->
              <div v-if="r.clone_status === 'done'" style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap">
                <span style="font-size:var(--fs-sm);color:var(--text-muted)">主分支</span>
                <code>{{ (branchInfo[r.id] && branchInfo[r.id].effective) || r.base_branch || '自動偵測' }}</code>
                <span style="font-size:var(--fs-sm);color:var(--text-muted)" title="ai-dev 已經長在這條分支上，改設定不會讓它搬家">
                  （建立後不可變更，需更換請移除 repo 重新新增）
                </span>
              </div>
              <div v-if="r.clone_error" style="font-size:var(--fs-xs);color:#dc2626;margin-top:4px;white-space:pre-wrap">{{ r.clone_error }}</div>
            </div>
            <div style="display:flex;gap:6px;margin-left:var(--space-3);flex-shrink:0">
              <button v-if="r.clone_status === 'error'" class="btn btn-outline btn-sm" @click="reclone(r.id)" title="重新 clone">↺</button>
              <button v-if="r.clone_status === 'done'" class="btn btn-outline btn-sm" @click="updateRepo(r.id)" title="git pull 拉最新程式碼">↻ 更新</button>
              <button class="btn btn-outline btn-sm" style="color:var(--error)" @click="removeRepo(r.id)"
                :disabled="envActive || r.clone_status === 'cloning'"
                :title="envActive ? '測試環境使用中，請先刪除環境' : (r.clone_status === 'cloning' ? '正在 clone/更新中' : '')">移除</button>
            </div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2);margin-top:var(--space-3)">
          <input v-model="newRepo.label" placeholder="標籤（如 main、plugin-hr）" class="form-control" />
          <input v-model="newRepo.repo_url" placeholder="Git URL（自動 clone）" class="form-control" @blur="probeRemoteBranches" />
          <!-- 主分支只有這一刻能選（新增後即鎖死），故在還沒 clone 的當下就用 ls-remote 把遠端分支
               撈出來讓人挑。讀不到（私有 repo 無 PAT／網址還沒填完）就維持自動偵測，不擋新增。 -->
          <label style="display:flex;align-items:center;gap:6px;font-size:var(--fs-base)">
            <span style="color:var(--text-muted);white-space:nowrap">主分支</span>
            <SearchableSelect v-if="remoteBranches.length"
              :model-value="newRepo.base_branch"
              :options="remoteBranches.map(b => ({ value: b, label: b }))"
              all-label="自動偵測"
              placeholder="自動偵測"
              @update:modelValue="v => newRepo.base_branch = v || ''" />
            <span v-else style="font-size:var(--fs-sm);color:var(--text-muted)">
              {{ probingBranches ? '讀取遠端分支中…' : '自動偵測（填入網址後可選）' }}
            </span>
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:var(--fs-base)">
            <input type="checkbox" v-model="newRepo.is_primary" /> 設為主要 repo
          </label>
        </div>
        <div v-if="newRepo.base_branch" style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:4px">
          AI 的 <code>ai-dev</code> 分支會從 <code>{{ newRepo.base_branch }}</code> 長出來，建立後不可變更。
        </div>
        <button class="btn btn-primary btn-sm" style="margin-top:var(--space-2)" @click="addRepo" :disabled="savingRepo">+ 新增 Repo</button>
        </div>

        <div data-tour="pd-mapping" style="margin-top:var(--space-4);padding:var(--space-3);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm)">
          <h3 style="font-size:var(--fs-md);font-weight:var(--fw-semibold);margin-bottom:var(--space-2)">同步來源對應</h3>
          <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:var(--space-2)">一行一個名稱，可綁定多個來源。</div>
          <div style="display:flex;flex-direction:column;gap:var(--space-2);font-size:var(--fs-base)">
            <label>Odoo 專案名稱（同步時自動綁定）
              <textarea v-model="editOdooProjectName" class="form-control" rows="3" placeholder="與 Odoo ERP 的專案名稱完全一致，一行一個" style="margin-top:4px"></textarea>
            </label>
            <label>客服來源名稱（Service 同步時自動綁定）
              <textarea v-model="editServiceRespondentName" class="form-control" rows="3" placeholder="與 eService 的 respondent 名稱完全一致，一行一個" style="margin-top:4px"></textarea>
            </label>
            <button class="btn btn-primary btn-sm" @click="saveProjectMapping" style="align-self:flex-start">儲存對應</button>
          </div>
        </div>

        <div v-if="isAdmin()" style="margin-top:var(--space-4);padding:var(--space-3);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm)">
          <h3 style="font-size:var(--fs-md);font-weight:var(--fw-semibold);margin-bottom:var(--space-2)">測試流程設定</h3>
          <div style="display:flex;flex-direction:column;gap:var(--space-2);font-size:var(--fs-base)">
            <span style="font-size:var(--fs-sm);color:var(--text-muted)">此專案串接外部系統，無法在測試區實測；停用後任務將跳過 E2E，部署測試區成功後直接進最終人工審核。</span>
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none">
              <div style="position:relative;width:44px;height:24px;flex-shrink:0">
                <input type="checkbox" v-model="editE2eDisabled" style="opacity:0;width:0;height:0;position:absolute" @change="saveE2eSetting" :disabled="savingE2e" />
                <div :style="{background: editE2eDisabled ? 'var(--primary)' : 'var(--border)', borderRadius:'var(--radius-lg)', width:'44px', height:'24px', transition:'background 0.2s'}"></div>
                <div :style="{position:'absolute', top:'3px', left: editE2eDisabled ? '23px' : '3px', width:'18px', height:'18px', background:'#fff', borderRadius:'50%', transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,.25)'}"></div>
              </div>
              <span style="font-size:var(--fs-md);color:var(--text)">{{ editE2eDisabled ? '已停用 E2E 測試' : 'E2E 測試啟用中' }}</span>
            </label>
          </div>
        </div>

        <div v-if="isAdmin()" style="margin-top:var(--space-4);padding:var(--space-3);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm)">
          <h3 style="font-size:var(--fs-md);font-weight:var(--fw-semibold);margin-bottom:var(--space-2)">Odoo 版本類型</h3>
          <div style="display:flex;flex-direction:column;gap:var(--space-2);font-size:var(--fs-base)">
            <span style="font-size:var(--fs-sm);color:var(--text-muted)">
              企業版會在建置測試區時額外掛入該 Odoo 大版本的 enterprise addons（唯讀）。
              需先由管理員在「企業版來源」登記並同步該版本，否則建置會直接失敗。
              <strong>改動後需重新建置測試區才會生效。</strong>
            </span>
            <select v-model="editEdition" class="form-control" style="max-width:280px" @change="saveEdition" :disabled="savingEdition">
              <option value="community">社群版（Community）</option>
              <option value="enterprise">企業版（Enterprise）</option>
            </select>
          </div>
        </div>

        <div v-if="env" data-tour="pd-env" style="margin-top:var(--space-6);padding-top:var(--space-4);border-top:1px solid var(--border)">
          <div class="form-section">Odoo 測試環境</div>
          <div style="font-size:var(--fs-base);margin-bottom:10px;display:flex;align-items:center;gap:var(--space-2)">
            <span>狀態：</span>
            <span :style="{ color: env.status === 'running' ? 'var(--success,#48bb78)' : env.status === 'error' ? 'var(--error)' : 'var(--text-muted)' }">
              {{ { idle:'● 閒置', setting_up:'⟳ 建立中（自動重新整理）', running:'● 運行中', error:'✕ 錯誤' }[env.status] || env.status }}
            </span>
          </div>
          <div v-if="env.error_msg" class="error-msg" style="margin-bottom:10px;white-space:pre-wrap">{{ env.error_msg }}</div>
          <details v-if="env.setup_log" style="margin-bottom:10px">
            <summary style="font-size:var(--fs-sm);color:var(--text-muted);cursor:pointer;user-select:none">▶ 查看建立記錄</summary>
            <pre style="background:#1e1e1e;color:#d4d4d4;border-radius:4px;padding:10px;font-size:var(--fs-xs);overflow-x:auto;margin-top:6px;white-space:pre-wrap;max-height:300px;overflow-y:auto">{{ env.setup_log }}</pre>
          </details>
          <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap">
            <template v-if="env.status === 'idle' || env.status === 'error'">
              <button class="btn btn-primary btn-sm" @click="setupEnv" :disabled="envWorking">
                <span v-if="envWorking" class="spinner"></span>{{ envWorking ? '處理中…' : (env.built ? '重新啟動' : '一鍵建立環境') }}
              </button>
            </template>
            <button v-if="env.status === 'setting_up'" class="btn btn-primary btn-sm" disabled>
              <span class="spinner"></span>建立中…
            </button>
            <template v-if="env.status === 'running'">
              <button v-if="env.status === 'running'" class="btn btn-primary btn-sm" @click="openEnv">開啟測試區</button>
              <button v-if="env.external_slot != null" class="btn btn-outline btn-sm" @click="releaseExternal" :disabled="envWorking"
                title="把對外檢視名額還回池子讓別人能用。環境本身不停，pipeline 不受影響">關閉對外</button>
              <button class="btn btn-outline btn-sm" @click="stopEnv" :disabled="envWorking">停止</button>
            </template>
            <button v-if="env.built || env.status !== 'idle'" class="btn btn-outline btn-sm" @click="viewLog" :disabled="logLoading">
              <span v-if="logLoading" class="spinner"></span>📄 查看 log
            </button>
            <button v-if="env.status !== 'idle' || env.built" class="btn btn-outline btn-sm" style="color:var(--error)" @click="deleteEnv" :disabled="envWorking">刪除環境</button>
            <button class="btn btn-outline btn-sm" @click="loadEnv" :disabled="envWorking">↺ 重新整理</button>
          </div>
          <div v-if="runtimeLog !== null" style="margin-top:var(--space-3)">
            <div style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:6px">
              <span style="font-size:var(--fs-sm);color:var(--text-muted)">Odoo 運行記錄（server log 尾端）</span>
              <button class="btn btn-outline btn-sm" @click="viewLog" :disabled="logLoading" title="重新抓取最新 log">↺</button>
              <button class="btn btn-outline btn-sm" @click="runtimeLog = null">關閉</button>
            </div>
            <pre style="background:#1e1e1e;color:#d4d4d4;border-radius:4px;padding:10px;font-size:var(--fs-xs);overflow-x:auto;white-space:pre-wrap;max-height:420px;overflow-y:auto">{{ runtimeLog }}</pre>
          </div>
          <div v-if="env.status === 'setting_up'" style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:var(--space-2)">
            系統自動分配可用 port，每 5 秒自動更新狀態
          </div>
        </div>
      </div>
    </template>
    <div v-else style="padding:var(--space-6);color:var(--text-muted)">專案不存在</div>

    <!-- 上正式：列出待合併任務供確認，整條 ai-dev 一起併進 main（彈窗與列表頁共用） -->
    <ReleaseModal v-if="showReleaseModal" :project-id="$route.params.id" @close="showReleaseModal = false" />
  `
});
