window.AdminView = Vue.defineComponent({
  name: 'AdminView',
  data() {
    return {
      odoo: { url: '', db: '', sync_interval: 60 },
      service: { url: '', db: '', sync_interval: 60 },
      teams: { tenant_id: '', client_id: '', client_secret: '', team_id: '', channel_id: '', webhook_url: '' },
      e2e: { login: '', password: '' },
      testMode: false,
      loading: true,
      savingConn: false,
      savingTeams: false,
      testingTeams: false,
      savingTestMode: false,
      steppingPipeline: false
    };
  },
  async created() { await this.loadAll(); },
  methods: {
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
          Object.assign(this.teams, {
            tenant_id: d.tenant_id || '', client_id: d.client_id || '',
            client_secret: d.client_secret || '', team_id: d.team_id || '',
            channel_id: d.channel_id || '', webhook_url: d.webhook_url || ''
          });
        }
        try { this.e2e = await Api.get('admin/e2e-account'); } catch (_) { /* 顯示用，取不到不擋頁面 */ }
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
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
        <div class="setting-block">
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

            <div class="conn-group" style="margin-top:20px">
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

        <!-- E2E 測試帳號（固定，唯讀顯示）-->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">E2E 測試帳號</div>
            <div class="setting-block-desc">Playwright 自動化測試登入測試區用的固定帳號。建立環境／同步使用者時會自動寫入 Odoo 測試區（管理員權限）。此帳密固定、無法從此處修改。</div>
          </div>
          <div class="setting-block-body">
            <div class="conn-fields">
              <div class="field-item">
                <label class="field-label">帳號</label>
                <input :value="e2e.login" class="field-input" readonly />
              </div>
              <div class="field-item">
                <label class="field-label">密碼</label>
                <input :value="e2e.password" class="field-input" readonly />
              </div>
            </div>
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

        <!-- 測試模式 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">Pipeline 測試模式</div>
            <div class="setting-block-desc">開啟後，排程停止自動推進 Pipeline，改為手動逐步執行，方便測試每個階段結果。</div>
          </div>
          <div class="setting-block-body">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none">
              <div style="position:relative;width:44px;height:24px;flex-shrink:0">
                <input type="checkbox" v-model="testMode" style="opacity:0;width:0;height:0;position:absolute" @change="saveTestMode" :disabled="savingTestMode" />
                <div :style="{background: testMode ? 'var(--primary)' : 'var(--border)', borderRadius:'12px', width:'44px', height:'24px', transition:'background 0.2s'}"></div>
                <div :style="{position:'absolute', top:'3px', left: testMode ? '23px' : '3px', width:'18px', height:'18px', background:'#fff', borderRadius:'50%', transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,.25)'}"></div>
              </div>
              <span style="font-size:14px;color:var(--text)">{{ testMode ? '測試模式已啟用' : '測試模式已關閉' }}</span>
            </label>
          </div>
          <div v-if="testMode" class="setting-block-footer warn">
            <span style="font-size:12px;color:var(--warning)">測試模式已啟用 — 請至「任務列表」使用「▶ 推進 Pipeline」按鈕手動推進</span>
          </div>
        </div>

        <!-- 使用者管理 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">使用者管理</div>
            <div class="setting-block-desc">新增、刪除帳號，調整角色與存取權限。</div>
          </div>
          <div class="setting-block-footer" style="border-top:none;padding-top:0">
            <button class="btn btn-primary btn-sm" @click="$router.push('/admin/users')">前往使用者管理 →</button>
          </div>
        </div>

        <!-- Agent 管理 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">Agent 管理</div>
            <div class="setting-block-desc">調整各 agent 的模型與提示詞。</div>
          </div>
          <div class="setting-block-footer" style="border-top:none;padding-top:0">
            <button class="btn btn-primary btn-sm" @click="$router.push('/admin/agents')">前往 Agent 管理 →</button>
          </div>
        </div>

        <!-- 工作流程健檢 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">工作流程健檢</div>
            <div class="setting-block-desc">分析各 pipeline agent 近期表現，提出提示詞改進建議。</div>
          </div>
          <div class="setting-block-footer" style="border-top:none;padding-top:0">
            <button class="btn btn-primary btn-sm" @click="$router.push('/admin/health')">前往健檢 →</button>
          </div>
        </div>

      </div>
    </div>
  `
});
