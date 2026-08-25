window.AdminView = Vue.defineComponent({
  name: 'AdminView',
  data() {
    return {
      odoo: { url: '', db: '', sync_interval: 60 },
      service: { url: '', db: '', sync_interval: 60 },
      teams: { tenant_id: '', client_id: '', client_secret: '', team_id: '', channel_id: '', webhook_url: '', notify_webhook_url: '' },
      testMode: false,
      writebackOdooNotes: false,
      usageGate: { enabled: true, th5: 90, th7: 95 },
      gateStatus: null,
      claudeToken: { configured: false, backup_configured: false, fallback_enabled: false, shadowed_by: null },
      claudeTokenInput: '',
      savingClaudeToken: false,
      clearingClaudeToken: false,
      codexSubscription: { configured: false, pending_login: null },
      startingCodexLogin: false,
      clearingCodexSubscription: false,
      codexLoginTimer: null,
      claudeBackupInput: '',
      savingBackupToken: false,
      clearingBackupToken: false,
      savingFallback: false,
      context7Key: { configured: false },
      context7KeyInput: '',
      savingContext7Key: false,
      clearingContext7Key: false,
      users: [],
      cliPushUserId: null,
      savingCliPushUser: false,
      loading: true,
      savingConn: false,
      savingTeams: false,
      testingTeams: false,
      savingTestMode: false,
      savingWriteback: false,
      savingUsageGate: false,
      steppingPipeline: false,
      embedding: null,
      rebuildingEmbedding: false,
      embeddingTimer: null,
      navTools: [
        { title: '使用者管理', desc: '新增、刪除帳號，調整角色與存取權限。', to: '/admin/users' },
        { title: 'Agent 管理', desc: '調整各 agent 的模型與提示詞。', to: '/admin/agents' },
        { title: '排程', desc: '檢視所有背景排程的週期、狀態與下次執行時間。', to: '/admin/schedules' },
        { title: '工作流程健檢', desc: '分析各 pipeline agent 近期表現，提出提示詞改進建議。', to: '/admin/health' },
        { title: '退回原因管理', desc: '檢視所有人工退回原因與分類，可批次刪除。', to: '/admin/rejections' },
        { title: '失敗分類樣本', desc: 'regex 判不出、交 haiku 分類的案例。看高頻 pattern，把復發的補進 regex 降低呼叫量。', to: '/admin/classify-samples' },
        { title: 'Prompt 送出記錄', desc: '檢視最近送給 AI 的 prompt 完整內容，確認實際送出了什麼。', to: '/admin/prompt-logs' },
        { title: '測試區 port 池', desc: '設定測試區可用的埠段範圍，檢視每個槽位由誰租用、閒置多久。', to: '/admin/port-pool' },
        { title: '企業版來源', desc: '按 Odoo 大版本登記 enterprise addons repo 並同步，供企業版專案的測試區掛載。', to: '/admin/enterprise' }
      ]
    };
  },
  async created() { await this.loadAll(); },
  // 離開頁面要停掉輪詢，否則 timer 會一直打 status 端點。
  unmounted() { if (this.embeddingTimer) clearTimeout(this.embeddingTimer); if (this.codexLoginTimer) clearTimeout(this.codexLoginTimer); },
  methods: {
    async loadEmbedding() {
      try { this.embedding = await Api.get('admin/embedding/status'); } catch (_) { this.embedding = null; }
    },
    // 進度只存在 server 記憶體（重建只要 10–20 秒，不值得為它多一張表），所以靠輪詢看。
    // 排程下一次前先清掉舊 timer：重複按按鈕不該疊出多條輪詢。
    pollEmbedding() {
      if (this.embeddingTimer) clearTimeout(this.embeddingTimer);
      this.embeddingTimer = setTimeout(async () => {
        await this.loadEmbedding();
        const p = this.embedding && this.embedding.progress;
        if (p && !p.finishedAt) this.pollEmbedding();
        else this.rebuildingEmbedding = false;
      }, 2000);
    },
    async rebuildEmbedding() {
      this.rebuildingEmbedding = true;
      try {
        this.embedding = await Api.post('admin/embedding/rebuild', {});
        this.pollEmbedding();
      } catch (e) {
        showToast(e.message, 'error');
        this.rebuildingEmbedding = false;
      }
    },
    async loadAll() {
      this.loading = true;
      try {
        const d = await Api.get('admin/teams-settings');
        if (d) {
          this.odoo.url            = d.odoo_url              || '';
          this.odoo.db             = d.odoo_db               || '';
          this.odoo.sync_interval  = d.odoo_sync_interval    ?? 60;
          this.service.url         = d.service_url           || '';
          this.service.db          = d.service_db            || '';
          this.service.sync_interval = d.service_sync_interval ?? 60;
          this.testMode            = !!d.test_mode;
          this.writebackOdooNotes  = !!d.writeback_odoo_notes;
          this.usageGate.enabled = d.usage_gate_enabled != null ? !!d.usage_gate_enabled : true;
          this.usageGate.th5     = d.usage_gate_5h_threshold ?? 90;
          this.usageGate.th7     = d.usage_gate_7d_threshold ?? 95;
          this.cliPushUserId     = d.cli_push_user_id ?? null;
          Object.assign(this.teams, {
            tenant_id: d.tenant_id || '', client_id: d.client_id || '',
            client_secret: d.client_secret || '', team_id: d.team_id || '',
            channel_id: d.channel_id || '', webhook_url: d.webhook_url || '',
            notify_webhook_url: d.notify_webhook_url || ''
          });
        }
        try { this.gateStatus = await Api.get('usage-gate/status'); } catch (_) { this.gateStatus = null; }
        try { this.claudeToken = await Api.get('admin/claude-token'); } catch (_) { /* 顯示用 */ }
        try { this.codexSubscription = await Api.get('admin/codex-subscription'); } catch (_) { /* 顯示用 */ }
        try { this.context7Key = await Api.get('admin/context7-key'); } catch (_) { /* 顯示用 */ }
        try { this.users = await Api.get('admin/users'); } catch (_) { this.users = []; }
        await this.loadEmbedding();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    async saveClaudeToken() {
      const token = (this.claudeTokenInput || '').trim();
      if (!token) { showToast('請貼上 token', 'error'); return; }
      this.savingClaudeToken = true;
      try {
        // 後端會先實際跑一次 claude 驗證才存，故這裡等待時間較長（數秒）
        const r = await Api.post('admin/claude-token', { token });
        this.claudeTokenInput = '';
        showToast(r.warning || '憑證已儲存並驗證通過', r.warning ? 'error' : 'success');
        this.claudeToken = await Api.get('admin/claude-token');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingClaudeToken = false; }
    },
    async clearClaudeToken() {
      if (!await confirmDialog({
        title: '清除 Claude 憑證',
        message: '清除後 pipeline 會改用伺服器本機的 Claude 登入憑證（併發時可能再出現認證失效）。確定要清除嗎？',
        danger: true, confirmText: '清除'
      })) return;
      this.clearingClaudeToken = true;
      try {
        await Api.delete('admin/claude-token');
        showToast('憑證已清除', 'success');
        this.claudeToken = await Api.get('admin/claude-token');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.clearingClaudeToken = false; }
    },
    pollCodexLogin() {
      if (this.codexLoginTimer) clearTimeout(this.codexLoginTimer);
      this.codexLoginTimer = setTimeout(async () => {
        try {
          this.codexSubscription = await Api.get('admin/codex-subscription');
          if (this.codexSubscription.pending_login) this.pollCodexLogin();
          else if (this.codexSubscription.configured) showToast('Codex 訂閱已連線', 'success');
        } catch (_) { /* 由管理員手動重試即可 */ }
      }, 2000);
    },
    async startCodexDeviceLogin() {
      this.startingCodexLogin = true;
      try {
        const login = await Api.post('admin/codex-subscription/device-login', {});
        this.codexSubscription = { ...this.codexSubscription, pending_login: login };
        this.pollCodexLogin();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.startingCodexLogin = false; }
    },
    async clearCodexSubscription() {
      if (!await confirmDialog({
        title: '中斷 Codex 訂閱連線',
        message: '中斷後 Codex agent 無法執行，直到再次完成訂閱登入。確定要中斷嗎？',
        danger: true, confirmText: '清除'
      })) return;
      this.clearingCodexSubscription = true;
      try {
        await Api.delete('admin/codex-subscription');
        showToast('Codex 訂閱連線已中斷', 'success');
        this.codexSubscription = await Api.get('admin/codex-subscription');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.clearingCodexSubscription = false; }
    },
    async saveBackupToken() {
      const token = (this.claudeBackupInput || '').trim();
      if (!token) { showToast('請貼上備用 token', 'error'); return; }
      this.savingBackupToken = true;
      try {
        // 同主憑證：後端會先實際跑一次 claude 驗證才存，等待數秒屬正常
        const r = await Api.post('admin/claude-token/backup', { token });
        this.claudeBackupInput = '';
        showToast(r.warning || '備用憑證已儲存並驗證通過', r.warning ? 'error' : 'success');
        this.claudeToken = await Api.get('admin/claude-token');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingBackupToken = false; }
    },
    async clearBackupToken() {
      if (!await confirmDialog({
        title: '清除備用憑證',
        message: '清除後主帳號用量撞到門檻時，會回到「暫停自動推進」的行為。確定要清除嗎？',
        danger: true, confirmText: '清除'
      })) return;
      this.clearingBackupToken = true;
      try {
        await Api.delete('admin/claude-token/backup');
        showToast('備用憑證已清除', 'success');
        this.claudeToken = await Api.get('admin/claude-token');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.clearingBackupToken = false; }
    },
    async toggleFallback(enabled) {
      this.savingFallback = true;
      try {
        await Api.put('admin/claude-fallback', { enabled });
        this.claudeToken = await Api.get('admin/claude-token');
        this.gateStatus = await Api.get('usage-gate/status');
        showToast(enabled ? '已啟用備用憑證接手' : '已停用備用憑證接手', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingFallback = false; }
    },
    async saveContext7Key() {
      const key = (this.context7KeyInput || '').trim();
      if (!key) { showToast('請貼上 API key', 'error'); return; }
      this.savingContext7Key = true;
      try {
        // 後端會先打一次 context7 搜尋端點驗證才存
        const r = await Api.post('admin/context7-key', { key });
        this.context7KeyInput = '';
        showToast(r.warning || 'API key 已儲存並驗證通過', r.warning ? 'error' : 'success');
        this.context7Key = await Api.get('admin/context7-key');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingContext7Key = false; }
    },
    async saveCliPushUser() {
      this.savingCliPushUser = true;
      try {
        // 後端會擋掉不存在或沒 PAT 的 id，錯誤訊息直接回顯
        await Api.put('admin/cli-push-user', { cli_push_user_id: this.cliPushUserId });
        showToast('已儲存 CLI 推送身分', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingCliPushUser = false; }
    },
    async clearContext7Key() {
      if (!await confirmDialog({
        title: '清除 context7 API key',
        message: '清除後查 Odoo 官方寫法會退回匿名額度，配額用盡時各關會靜默改用網路搜尋（慢且不準）。確定要清除嗎？',
        danger: true, confirmText: '清除'
      })) return;
      this.clearingContext7Key = true;
      try {
        await Api.delete('admin/context7-key');
        showToast('API key 已清除', 'success');
        this.context7Key = await Api.get('admin/context7-key');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.clearingContext7Key = false; }
    },
    async saveConn() {
      this.savingConn = true;
      try {
        await Api.put('admin/teams-settings', {
          ...this.teams,
          odoo_url: this.odoo.url, odoo_db: this.odoo.db, odoo_sync_interval: this.odoo.sync_interval,
          service_url: this.service.url, service_db: this.service.db, service_sync_interval: this.service.sync_interval
        });
        showToast('連線設定已儲存', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingConn = false; }
    },
    async saveTeams() {
      this.savingTeams = true;
      try {
        await Api.put('admin/teams-settings', {
          ...this.teams,
          odoo_url: this.odoo.url, odoo_db: this.odoo.db, odoo_sync_interval: this.odoo.sync_interval,
          service_url: this.service.url, service_db: this.service.db, service_sync_interval: this.service.sync_interval
        });
        showToast('Teams 設定已儲存', 'success');
        await this.loadAll();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingTeams = false; }
    },
    async testTeams() {
      this.testingTeams = true;
      try {
        await Api.post('admin/teams-settings/test', {});
        showToast('測試訊息已發送', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.testingTeams = false; }
    },
    async saveTestMode() {
      this.savingTestMode = true;
      try {
        await Api.put('admin/teams-settings', {
          ...this.teams,
          odoo_url: this.odoo.url, odoo_db: this.odoo.db, odoo_sync_interval: this.odoo.sync_interval,
          service_url: this.service.url, service_db: this.service.db, service_sync_interval: this.service.sync_interval,
          test_mode: this.testMode
        });
        showToast(this.testMode ? '測試模式已啟用，Pipeline 停止自動推進' : '測試模式已關閉，Pipeline 恢復自動運行', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingTestMode = false; }
    },
    async saveWriteback() {
      this.savingWriteback = true;
      try {
        await Api.put('admin/teams-settings', {
          ...this.teams,
          odoo_url: this.odoo.url, odoo_db: this.odoo.db, odoo_sync_interval: this.odoo.sync_interval,
          service_url: this.service.url, service_db: this.service.db, service_sync_interval: this.service.sync_interval,
          test_mode: this.testMode,
          writeback_odoo_notes: this.writebackOdooNotes
        });
        showToast(this.writebackOdooNotes ? '留言回寫已啟用' : '留言回寫已關閉', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingWriteback = false; }
    },
    async saveUsageGate() {
      const { th5, th7 } = this.usageGate;
      if (![th5, th7].every(n => Number.isInteger(n) && n >= 1 && n <= 100)) {
        showToast('門檻需為 1–100 的整數', 'error');
        return;
      }
      this.savingUsageGate = true;
      try {
        await Api.put('admin/teams-settings', {
          ...this.teams,
          odoo_url: this.odoo.url, odoo_db: this.odoo.db, odoo_sync_interval: this.odoo.sync_interval,
          service_url: this.service.url, service_db: this.service.db, service_sync_interval: this.service.sync_interval,
          usage_gate_enabled: this.usageGate.enabled,
          usage_gate_5h_threshold: th5,
          usage_gate_7d_threshold: th7
        });
        showToast('用量閘門設定已儲存', 'success');
        try { this.gateStatus = await Api.get('usage-gate/status'); } catch (_) { /* 顯示用 */ }
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingUsageGate = false; }
    },
    async stepPipeline() {
      this.steppingPipeline = true;
      try {
        const r = await Api.post('admin/pipeline/step', {});
        const total = r.results.reduce((s, x) => s + x.processed, 0);
        showToast(`Pipeline 推進完成，共處理 ${total} 個任務`, 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.steppingPipeline = false; }
    }
  },
  template: `
    <div class="page-header">
      <div class="page-header-inner">
        <h1 class="page-title">管理員設定</h1>
      </div>
    </div>
    <div class="page-body">
      <div v-if="loading" class="loading">載入中...</div>
      <div v-else class="settings-layout">

        <!-- 系統連線設定 -->
        <div class="setting-block" data-tour="admin-conn">
          <div class="setting-block-head">
            <div class="setting-block-title">系統連線設定</div>
            <div class="setting-block-desc">設定全公司共用的伺服器位址。個人帳號密碼請至「個人設定」填寫。</div>
          </div>
          <div class="setting-block-body">

            <div class="conn-group">
              <div class="conn-group-label">Odoo</div>
              <div class="conn-fields">
                <div class="field-item">
                  <label class="field-label">伺服器網址</label>
                  <input v-model="odoo.url" placeholder="http://localhost:8069" class="field-input" />
                </div>
                <div class="field-item">
                  <label class="field-label">資料庫名稱</label>
                  <input v-model="odoo.db" placeholder="your_db" class="field-input" />
                </div>
                <div class="field-item field-item-narrow">
                  <label class="field-label">同步間隔（分鐘，0 停用）</label>
                  <input v-model.number="odoo.sync_interval" type="number" min="0" max="1440" class="field-input" />
                </div>
              </div>
            </div>

            <div class="conn-group" style="margin-top:var(--space-5)">
              <div class="conn-group-label">eService</div>
              <div class="conn-fields">
                <div class="field-item">
                  <label class="field-label">伺服器網址</label>
                  <input v-model="service.url" placeholder="http://eservice.company.com" class="field-input" />
                </div>
                <div class="field-item">
                  <label class="field-label">資料庫名稱</label>
                  <input v-model="service.db" placeholder="eservice_db" class="field-input" />
                </div>
                <div class="field-item field-item-narrow">
                  <label class="field-label">同步間隔（分鐘，0 停用）</label>
                  <input v-model.number="service.sync_interval" type="number" min="0" max="1440" class="field-input" />
                </div>
              </div>
            </div>

          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="saveConn" :disabled="savingConn">
              {{ savingConn ? '儲存中...' : '儲存連線設定' }}
            </button>
          </div>
        </div>

        <!-- Teams 整合 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">Microsoft Teams 整合</div>
            <div class="setting-block-desc">任務通知發送至指定頻道，並 @mention 各任務負責人。需要 Azure App 權限：ChannelMessage.Send、ChannelMessage.ReadWrite.All。</div>
          </div>
          <div class="setting-block-body">
            <div class="conn-fields-wrap">
              <div class="field-item">
                <label class="field-label">Tenant ID</label>
                <input v-model="teams.tenant_id" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" class="field-input" />
              </div>
              <div class="field-item">
                <label class="field-label">Client ID</label>
                <input v-model="teams.client_id" placeholder="App Registration Client ID" class="field-input" />
              </div>
              <div class="field-item">
                <label class="field-label">Client Secret <span class="field-label-hint">（留空 = 不更新）</span></label>
                <input v-model="teams.client_secret" type="password" placeholder="••••••" class="field-input" />
              </div>
              <div class="field-item">
                <label class="field-label">Team ID</label>
                <input v-model="teams.team_id" placeholder="Teams 群組 ID" class="field-input" />
              </div>
              <div class="field-item">
                <label class="field-label">Channel ID</label>
                <input v-model="teams.channel_id" placeholder="頻道 ID" class="field-input" />
              </div>
              <div class="field-item">
                <label class="field-label">Webhook URL</label>
                <input v-model="teams.webhook_url" placeholder="https://yourserver.com/api/teams/webhook" class="field-input" />
              </div>
              <div class="field-item">
                <label class="field-label">外部通知 Webhook（選填）</label>
                <input v-model="teams.notify_webhook_url" placeholder="任務需人工處理時 POST JSON 至此網址" class="field-input" />
              </div>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="saveTeams" :disabled="savingTeams">
              {{ savingTeams ? '儲存中...' : '儲存 Teams 設定' }}
            </button>
            <button class="btn btn-ghost btn-sm" @click="testTeams" :disabled="testingTeams">
              {{ testingTeams ? '發送中...' : '傳送測試訊息' }}
            </button>
          </div>
        </div>

        <!-- Claude 用量閘門 -->
        <div class="setting-block" data-tour="admin-gate">
          <div class="setting-block-head">
            <div class="setting-block-title">Claude 用量閘門</div>
            <div class="setting-block-desc">Claude 帳號用量達門檻時，自動停止 Pipeline 自動推進（手動「繼續」不受影響）。5 小時視窗或本週任一超標即暫停。全台共用同一帳號，此設定為全域。</div>
          </div>
          <div class="setting-block-body">
            <label class="switch-label-row">
              <div style="position:relative;width:44px;height:24px;flex-shrink:0">
                <input type="checkbox" v-model="usageGate.enabled" style="opacity:0;width:0;height:0;position:absolute" />
                <div :style="{background: usageGate.enabled ? 'var(--primary)' : 'var(--border)', borderRadius:'var(--radius-lg)', width:'44px', height:'24px', transition:'background 0.2s'}"></div>
                <div :style="{position:'absolute', top:'3px', left: usageGate.enabled ? '23px' : '3px', width:'18px', height:'18px', background:'#fff', borderRadius:'50%', transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,.25)'}"></div>
              </div>
              <span style="font-size:var(--fs-md);color:var(--text)">{{ usageGate.enabled ? '閘門已啟用' : '閘門已停用（不看用量，維持自動推進）' }}</span>
            </label>
            <div class="conn-fields" style="margin-top:var(--space-4)">
              <div class="field-item field-item-narrow">
                <label class="field-label">5 小時視窗門檻（%）</label>
                <input v-model.number="usageGate.th5" type="number" min="1" max="100" class="field-input" />
              </div>
              <div class="field-item field-item-narrow">
                <label class="field-label">本週門檻（%）</label>
                <input v-model.number="usageGate.th7" type="number" min="1" max="100" class="field-input" />
              </div>
            </div>
            <div v-if="gateStatus" data-rwd-volatile style="margin-top:var(--space-4);font-size:var(--fs-sm)">
              <template v-if="gateStatus.blocked">
                <span style="color:var(--warning)">
                  ⏸ 已暫停：{{ gateStatus.reason.window === '5h' ? '5 小時視窗' : '本週' }}用量 {{ gateStatus.reason.current }}% 已達門檻 {{ gateStatus.reason.threshold }}%{{ gateStatus.reason.stale ? '（快取資料）' : '' }}；重置：{{ gateStatus.reason.resets_at || '未知' }}
                </span>
              </template>
              <template v-else-if="gateStatus.active_credential === 'backup'">
                <span style="color:var(--warning)">
                  🔄 主憑證用量 {{ gateStatus.primary_reason ? gateStatus.primary_reason.current : '—' }}% 已達門檻，改用<strong>備用憑證</strong>運行中；備用用量
                  {{ gateStatus.backup && gateStatus.backup.available && gateStatus.backup.five_hour ? gateStatus.backup.five_hour.utilization + '%' : '不可得' }}
                  <template v-if="gateStatus.primary_reason"> · 主帳號重置：{{ gateStatus.primary_reason.resets_at || '未知' }}</template>
                </span>
              </template>
              <template v-else-if="gateStatus.enabled === false">
                <span style="color:var(--text-muted)">閘門已停用</span>
              </template>
              <template v-else-if="gateStatus.available === false">
                <span style="color:var(--text-muted)">尚無用量資料，暫不啟用閘門（fail-open）</span>
              </template>
              <template v-else>
                <span style="color:var(--success)">正常運行中（5h {{ gateStatus.five_hour ? gateStatus.five_hour.utilization : '—' }}% / 週 {{ gateStatus.seven_day ? gateStatus.seven_day.utilization : '—' }}%）</span>
              </template>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="saveUsageGate" :disabled="savingUsageGate">
              {{ savingUsageGate ? '儲存中...' : '儲存閘門設定' }}
            </button>
          </div>
        </div>

        <!-- Claude 認證憑證 -->
        <div class="setting-block" data-tour="admin-token">
          <div class="setting-block-head">
            <div class="setting-block-title">Claude 認證憑證</div>
            <div class="setting-block-desc">在任一台裝有 Claude Code 的機器執行 <code>claude setup-token</code> 產生長效 token（綁訂閱、不另計費，效期一年），貼在這裡即可。設定後所有 pipeline 子行程改用它認證，取代伺服器本機的登入憑證檔——後者在多個任務並行時會互相踩到刷新中的憑證，造成任務無故中斷。換帳號只要貼新的 token，不必重啟伺服器。</div>
          </div>
          <div class="setting-block-body">
            <div style="font-size:var(--fs-sm);margin-bottom:var(--space-3)">
              <span v-if="claudeToken.configured" style="color:var(--success)">✓ 已設定憑證</span>
              <span v-else style="color:var(--text-muted)">尚未設定，目前使用伺服器本機的 Claude 登入</span>
            </div>
            <div v-if="claudeToken.shadowed_by" style="font-size:var(--fs-sm);color:var(--warning);margin-bottom:var(--space-3)">
              ⚠ 伺服器環境變數 <code>{{ claudeToken.shadowed_by }}</code> 的優先序高於此設定，目前這裡設的憑證不會生效。請先移除該環境變數並重啟伺服器。
            </div>
            <div class="conn-fields">
              <div class="field-item">
                <label class="field-label">貼上 token</label>
                <input v-model="claudeTokenInput" type="password" class="field-input" placeholder="claude setup-token 產生的 token" autocomplete="off" />
              </div>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="saveClaudeToken" :disabled="savingClaudeToken">
              {{ savingClaudeToken ? '驗證中...' : '儲存並驗證' }}
            </button>
            <button v-if="claudeToken.configured" class="btn btn-ghost btn-sm" @click="clearClaudeToken" :disabled="clearingClaudeToken">
              {{ clearingClaudeToken ? '清除中...' : '清除憑證' }}
            </button>
          </div>
        </div>

        <!-- Codex 訂閱登入 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">Codex 訂閱連線</div>
            <div class="setting-block-desc">使用 ChatGPT 的 Codex 訂閱，不會走 OpenAI API 按量計費。按下連線後，在自己的瀏覽器開啟一次性網址並輸入代碼；正式機只由 Codex CLI 保存與自動刷新登入，平台不會接觸或保存 token 明文。</div>
          </div>
          <div class="setting-block-body">
            <div style="font-size:var(--fs-sm);margin-bottom:var(--space-3)">
              <span v-if="codexSubscription.configured" style="color:var(--success)">✓ 已連線 {{ codexSubscription.email || '' }}{{ codexSubscription.plan_type ? '（' + codexSubscription.plan_type + '）' : '' }}</span>
              <span v-else style="color:var(--text-muted)">尚未連線，Codex agent 無法執行</span>
            </div>
            <div v-if="codexSubscription.pending_login" class="notice-box" style="margin:0">
              <div style="margin-bottom:var(--space-2)">請開啟 <a :href="codexSubscription.pending_login.verification_url" target="_blank" rel="noopener">{{ codexSubscription.pending_login.verification_url }}</a>，登入後輸入以下一次性代碼：</div>
              <code style="font-size:var(--fs-lg);letter-spacing:.08em">{{ codexSubscription.pending_login.user_code }}</code>
              <div style="margin-top:var(--space-2);color:var(--text-secondary)">正在等待授權完成…</div>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="startCodexDeviceLogin" :disabled="startingCodexLogin || !!codexSubscription.pending_login">{{ startingCodexLogin ? '取得代碼中...' : codexSubscription.configured ? '重新連線' : '以 ChatGPT 訂閱連線' }}</button>
            <button v-if="codexSubscription.configured" class="btn btn-ghost btn-sm" @click="clearCodexSubscription" :disabled="clearingCodexSubscription">{{ clearingCodexSubscription ? '中斷中...' : '中斷連線' }}</button>
          </div>
        </div>

        <!-- 備用憑證（用量撞閘門時接手） -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">備用 Claude 憑證</div>
            <div class="setting-block-desc">主憑證的用量撞到上方閘門門檻時，整條 pipeline 會停下等視窗重置。貼一把<strong>另一份訂閱</strong>的 <code>claude setup-token</code>，並開啟下方開關，撞門檻時就改用它繼續推進，主帳號用量降回門檻下自動切回。<strong>務必用不同帳號產生</strong>——同一個帳號的第二把 token 共用同一份用量，切過去照樣是超標狀態。備用帳號的用量能不能讀到取決於該 token 的權限，讀不到時顯示「不可得」，屆時只有跑失敗才會知道它也用完了。</div>
          </div>
          <div class="setting-block-body">
            <div style="font-size:var(--fs-sm);margin-bottom:var(--space-3)">
              <span v-if="claudeToken.backup_configured" style="color:var(--success)">✓ 已設定備用憑證</span>
              <span v-else style="color:var(--text-muted)">尚未設定，主帳號撞門檻時會暫停推進任務</span>
            </div>
            <label class="switch-label-row">
              <div style="position:relative;width:44px;height:24px;flex-shrink:0">
                <input type="checkbox" :checked="claudeToken.fallback_enabled" :disabled="savingFallback"
                       @change="toggleFallback($event.target.checked)" style="opacity:0;width:0;height:0;position:absolute" />
                <div :style="{background: claudeToken.fallback_enabled ? 'var(--primary)' : 'var(--border)', borderRadius:'var(--radius-lg)', width:'44px', height:'24px', transition:'background 0.2s'}"></div>
                <div :style="{position:'absolute', top:'3px', left: claudeToken.fallback_enabled ? '23px' : '3px', width:'18px', height:'18px', background:'#fff', borderRadius:'50%', transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,.25)'}"></div>
              </div>
              <span style="font-size:var(--fs-md);color:var(--text)">{{ claudeToken.fallback_enabled ? '撞門檻時改用備用憑證繼續跑' : '撞門檻時暫停推進（不使用備用憑證）' }}</span>
            </label>
            <div class="conn-fields" style="margin-top:var(--space-4)">
              <div class="field-item">
                <label class="field-label">貼上備用 token</label>
                <input v-model="claudeBackupInput" type="password" class="field-input" placeholder="另一個帳號的 claude setup-token" autocomplete="off" />
              </div>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="saveBackupToken" :disabled="savingBackupToken">
              {{ savingBackupToken ? '驗證中...' : '儲存並驗證' }}
            </button>
            <button v-if="claudeToken.backup_configured" class="btn btn-ghost btn-sm" @click="clearBackupToken" :disabled="clearingBackupToken">
              {{ clearingBackupToken ? '清除中...' : '清除備用憑證' }}
            </button>
          </div>
        </div>

        <!-- context7 API key -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">context7 API key</div>
            <div class="setting-block-desc">AI 寫 Odoo 程式碼時靠 context7 查官方寫法。未設定則使用匿名額度，配額用盡時<strong>不會有任何錯誤</strong>——各關會靜默改用網路搜尋去抓 Odoo 原始碼，慢、不準，且那段消耗不會出現在用量報表上。在 <code>context7.com/dashboard</code> 註冊可取得免費 key（額度遠高於匿名）。貼上後下一張任務即生效，不必重啟伺服器。</div>
          </div>
          <div class="setting-block-body">
            <div style="font-size:var(--fs-sm);margin-bottom:var(--space-3)">
              <span v-if="context7Key.configured" style="color:var(--success)">✓ 已設定 API key</span>
              <span v-else style="color:var(--text-muted)">尚未設定，目前使用匿名額度</span>
            </div>
            <div class="conn-fields">
              <div class="field-item">
                <label class="field-label">貼上 API key</label>
                <input v-model="context7KeyInput" type="password" class="field-input" placeholder="context7.com/dashboard 取得的 key" autocomplete="off" />
              </div>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="saveContext7Key" :disabled="savingContext7Key">
              {{ savingContext7Key ? '驗證中...' : '儲存並驗證' }}
            </button>
            <button v-if="context7Key.configured" class="btn btn-ghost btn-sm" @click="clearContext7Key" :disabled="clearingContext7Key">
              {{ clearingContext7Key ? '清除中...' : '清除 key' }}
            </button>
          </div>
        </div>

        <!-- CLI 推送身分 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">CLI 推送身分</div>
            <div class="setting-block-desc">有人在終端機手動跑 <code>pushRepo/push.js</code> 推 GitHub、又沒指定 <code>--user</code> 時，要用誰的 GitHub PAT。<strong>只影響手動操作</strong>——平台自己的推送（任務完成推 code、合併、企業版 clone）一律用該任務擁有者的 PAT，不看這個設定。未設定時腳本會列出可用帳號要求指定，不會自己猜一個。</div>
          </div>
          <div class="setting-block-body">
            <div class="conn-fields">
              <div class="field-item">
                <label class="field-label">預設推送帳號</label>
                <select v-model="cliPushUserId" class="field-input">
                  <option :value="null">未設定（每次都要帶 --user）</option>
                  <option v-for="u in users" :key="u.id" :value="u.id" :disabled="!u.has_pat">
                    {{ u.display_name || u.username }}（id={{ u.id }}）{{ u.has_pat ? '' : '－未設 PAT' }}
                  </option>
                </select>
              </div>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="saveCliPushUser" :disabled="savingCliPushUser">
              {{ savingCliPushUser ? '儲存中...' : '儲存' }}
            </button>
          </div>
        </div>

        <!-- 測試模式 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">Pipeline 測試模式</div>
            <div class="setting-block-desc">開啟後，排程停止自動推進 Pipeline，改為手動逐步執行，方便測試每個階段結果。</div>
          </div>
          <div class="setting-block-body">
            <label class="switch-label-row">
              <div style="position:relative;width:44px;height:24px;flex-shrink:0">
                <input type="checkbox" v-model="testMode" style="opacity:0;width:0;height:0;position:absolute" @change="saveTestMode" :disabled="savingTestMode" />
                <div :style="{background: testMode ? 'var(--primary)' : 'var(--border)', borderRadius:'var(--radius-lg)', width:'44px', height:'24px', transition:'background 0.2s'}"></div>
                <div :style="{position:'absolute', top:'3px', left: testMode ? '23px' : '3px', width:'18px', height:'18px', background:'#fff', borderRadius:'50%', transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,.25)'}"></div>
              </div>
              <span style="font-size:var(--fs-md);color:var(--text)">{{ testMode ? '測試模式已啟用' : '測試模式已關閉' }}</span>
            </label>
          </div>
          <div v-if="testMode" class="setting-block-footer warn">
            <span style="font-size:var(--fs-sm);color:var(--warning)">測試模式已啟用 — 請至「任務列表」使用「▶ 推進 Pipeline」按鈕手動推進</span>
          </div>
        </div>

        <!-- 留言回寫 Odoo/eService -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">留言回寫 Odoo/eService</div>
            <div class="setting-block-desc">開啟後，使用者在任務詳情頁新增的留言會以「記錄備註」寫回原單據（不發送給客戶、不建活動）。</div>
          </div>
          <div class="setting-block-body">
            <label class="switch-label-row">
              <div style="position:relative;width:44px;height:24px;flex-shrink:0">
                <input type="checkbox" v-model="writebackOdooNotes" style="opacity:0;width:0;height:0;position:absolute" @change="saveWriteback" :disabled="savingWriteback" />
                <div :style="{background: writebackOdooNotes ? 'var(--primary)' : 'var(--border)', borderRadius:'var(--radius-lg)', width:'44px', height:'24px', transition:'background 0.2s'}"></div>
                <div :style="{position:'absolute', top:'3px', left: writebackOdooNotes ? '23px' : '3px', width:'18px', height:'18px', background:'#fff', borderRadius:'50%', transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,.25)'}"></div>
              </div>
              <span style="font-size:var(--fs-md);color:var(--text)">{{ writebackOdooNotes ? '留言回寫已啟用' : '留言回寫已關閉' }}</span>
            </label>
          </div>
        </div>

        <!-- 語意檢索索引 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">語意檢索索引</div>
            <div class="setting-block-desc">wiki 與歷史任務規格的語意索引，供 AI 用「意思相近」而非「字串相同」找資料。索引在內容變動時自動增量更新，夜間另有一輪補算；這裡的重建是換模型或懷疑索引不同步時才需要按。模型未就緒時檢索自動退回關鍵字比對，功能不會中斷。</div>
          </div>
          <div class="setting-block-body">
            <div v-if="embedding" data-rwd-volatile style="font-size:var(--fs-sm)">
              <div style="margin-bottom:var(--space-2)">
                <span v-if="embedding.disabled" style="color:var(--danger)">✕ 已停用（連續失敗達上限）：{{ embedding.lastError || '原因不明' }}</span>
                <span v-else-if="embedding.ready" style="color:var(--success)">✓ 模型就緒（{{ embedding.model }}）</span>
                <span v-else style="color:var(--warning)">⏳ 模型未就緒，檢索退回關鍵字比對{{ embedding.lastError ? '：' + embedding.lastError : '（首次啟動需下載模型權重，約 130 MB）' }}</span>
              </div>
              <div style="color:var(--text-muted)">
                已載入 {{ embedding.cachedChunks }} 個片段<span v-if="embedding.queued"> ・ 佇列中 {{ embedding.queued }} 批</span>
                <span v-if="!embedding.cacheLoaded"> ・ 快取尚未載入</span>
              </div>
              <div v-if="embedding.progress" style="margin-top:var(--space-2)">
                <span v-if="embedding.progress.error" style="color:var(--danger)">重建失敗：{{ embedding.progress.error }}</span>
                <span v-else-if="!embedding.progress.finishedAt" style="color:var(--text)">重建中 {{ embedding.progress.done }} / {{ embedding.progress.total }}</span>
                <span v-else style="color:var(--success)">上次重建完成，共處理 {{ embedding.progress.total }} 個來源</span>
              </div>
            </div>
            <div v-else style="font-size:var(--fs-sm);color:var(--text-muted)">狀態讀取失敗</div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="rebuildEmbedding" :disabled="rebuildingEmbedding">
              {{ rebuildingEmbedding ? '重建中...' : '重建索引' }}
            </button>
          </div>
        </div>

        <!-- 管理工具 -->
        <div class="settings-section-label">管理工具</div>
        <div class="nav-card-grid" data-tour="admin-tools">
          <div v-for="t in navTools" :key="t.to" class="nav-card" @click="$router.push(t.to)">
            <div class="nav-card-title">{{ t.title }}<span class="nav-card-arrow">→</span></div>
            <div class="nav-card-desc">{{ t.desc }}</div>
          </div>
        </div>

      </div>
    </div>
  `
});
