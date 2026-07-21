window.ProjectDetailView = Vue.defineComponent({
  name: 'ProjectDetailView',
  data() {
    return {
      project: null,
      repos: [],
      loading: true,
      newRepo: { label: '', repo_url: '', is_primary: false },
      savingRepo: false,
      env: null,
      envWorking: false,
      _pollTimer: null,
      _reposPollTimer: null,
      editOdooProjectName: '',
      editServiceRespondentName: '',
      editE2eDisabled: false,
      savingE2e: false,
      runtimeLog: null,
      logLoading: false
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
        const data = await Api.get(`projects/${this.$route.params.id}`);
        this.project = data;
        UnreadStore.byProject[String(this.project.id)] = this.project.unread_count || 0;
        this.repos = data.repos || [];
        this.editOdooProjectName = data.odoo_project_name || '';
        this.editServiceRespondentName = data.service_respondent_name || '';
        this.editE2eDisabled = !!data.e2e_disabled;
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    async addRepo() {
      if (!this.newRepo.label || !this.newRepo.repo_url) return showToast('請填寫標籤和 repo URL', 'error');
      this.savingRepo = true;
      try {
        await Api.post(`projects/${this.$route.params.id}/repos`, { ...this.newRepo });
        this.newRepo = { label: '', repo_url: '', is_primary: false };
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
      try {
        this.env = await Api.get(`projects/${this.$route.params.id}/env`);
      } catch { this.env = { status: 'idle' }; }
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
    async syncUsers() {
      this.envWorking = true;
      try {
        await Api.post(`projects/${this.$route.params.id}/env/sync-users`, {});
        showToast('使用者已同步到測試區（全部管理員）', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.envWorking = false; }
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
        await Api.patch(`projects/${this.project.id}`, payload);
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
    isAdmin() { return window.UserStore.role === 'admin'; }
  },
  template: `
    <div v-if="loading" class="loading">載入中...</div>
    <template v-else-if="project">
      <div class="topbar">
        <button class="btn btn-outline btn-sm" @click="$router.push('/projects')" style="margin-right:var(--space-3)">← 返回</button>
        <h1>{{ project.name }}</h1>
        <span style="font-size:var(--fs-base);color:var(--text-muted);margin-left:var(--space-3)">Odoo {{ project.odoo_version }}</span>
        <div style="display:flex;gap:6px;margin-left:var(--space-4)">
          <button class="btn btn-outline btn-sm" style="background:var(--primary);color:#fff">設定</button>
          <button v-if="isAdmin()" class="btn btn-outline btn-sm" @click="$router.push('/projects/'+project.id+'/db')">資料庫查詢</button>
          <button class="btn btn-outline btn-sm" @click="goWiki">📖 Wiki</button>
          <button class="btn btn-outline btn-sm" @click="goChat">💬 Chat
            <span v-if="unreadCount()" style="display:inline-block;min-width:16px;padding:0 5px;margin-left:var(--space-1);border-radius:var(--radius);background:var(--error,#e5484d);color:#fff;font-size:var(--fs-xs);line-height:16px;text-align:center">{{ unreadCount() }}</span>
          </button>
          <button class="btn btn-outline btn-sm" @click="initWiki">🔄 初始化 Wiki</button>
        </div>
      </div>
      <div class="content">
        <div v-if="project.description" style="color:var(--text-muted);font-size:var(--fs-base);margin-bottom:var(--space-4)">{{ project.description }}</div>

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
          <input v-model="newRepo.repo_url" placeholder="Git URL（自動 clone）" class="form-control" />
          <label style="display:flex;align-items:center;gap:6px;font-size:var(--fs-base)">
            <input type="checkbox" v-model="newRepo.is_primary" /> 設為主要 repo
          </label>
        </div>
        <button class="btn btn-primary btn-sm" style="margin-top:var(--space-2)" @click="addRepo" :disabled="savingRepo">+ 新增 Repo</button>

        <div style="margin-top:var(--space-4);padding:var(--space-3);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm)">
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

        <div v-if="env" style="margin-top:var(--space-6);padding-top:var(--space-4);border-top:1px solid var(--border)">
          <div class="form-section">Odoo 測試環境</div>
          <div style="font-size:var(--fs-base);margin-bottom:10px;display:flex;align-items:center;gap:var(--space-2)">
            <span>狀態：</span>
            <span :style="{ color: env.status === 'running' ? 'var(--success,#48bb78)' : env.status === 'error' ? 'var(--error)' : 'var(--text-muted)' }">
              {{ { idle:'● 閒置', setting_up:'⟳ 建立中（自動重新整理）', running:'● 運行中', error:'✕ 錯誤' }[env.status] || env.status }}
            </span>
            <a v-if="env.url" :href="env.url" target="_blank" style="font-size:var(--fs-sm)">{{ env.url }}</a>
            <span v-if="env.port && env.status === 'running'" style="font-size:var(--fs-sm);color:var(--text-muted)">port {{ env.port }}</span>
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
              <a v-if="env.url" class="btn btn-primary btn-sm" :href="env.url" target="_blank">開啟測試區</a>
              <button class="btn btn-outline btn-sm" @click="stopEnv" :disabled="envWorking">停止</button>
            </template>
            <button v-if="env.built" class="btn btn-outline btn-sm" @click="syncUsers" :disabled="envWorking || env.status === 'setting_up'">👥 同步使用者</button>
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
  `
});
