window.AdminEnterpriseView = Vue.defineComponent({
  name: 'AdminEnterpriseView',
  data() {
    return {
      sources: [], baseDir: '', loading: true, saving: false, syncing: '',
      form: { odoo_version: '', source_type: 'git', repo_url: '', branch: '' }
    };
  },
  async created() { await this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try {
        const d = await Api.get('admin/enterprise-sources');
        this.sources = d.sources || [];
        this.baseDir = d.base_dir || '';
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    isLocal(s) { return s.source_type === 'local'; },
    async save() {
      const local = this.form.source_type === 'local';
      if (!this.form.odoo_version) return showToast('請填 Odoo 大版本', 'error');
      if (!local && !this.form.repo_url) return showToast('請填 Git repo URL', 'error');
      this.saving = true;
      try {
        await Api.put(`admin/enterprise-sources/${encodeURIComponent(this.form.odoo_version)}`, {
          source_type: this.form.source_type, repo_url: this.form.repo_url, branch: this.form.branch
        });
        this.form = { odoo_version: '', source_type: 'git', repo_url: '', branch: '' };
        await this.load();
        showToast(local ? '已登記，請按「檢查」驗證目錄' : '已登記，請按「同步」下載', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.saving = false; }
    },
    // 本地型態是同步驗證：當場拿到合格與否。git 型態是背景 clone，只能先回「已開始」再輪詢。
    async sync(s) {
      this.syncing = s.odoo_version;
      try {
        const r = await Api.post(`admin/enterprise-sources/${s.odoo_version}/sync`, {});
        if (this.isLocal(s)) {
          await this.load();
          showToast(`檢查通過：${r.moduleCount} 個模組`, 'success');
        } else {
          showToast('同步已開始，完成前狀態為「同步中」', 'success');
          setTimeout(() => this.load(), 3000);
        }
      } catch (e) {
        showToast(e.message, 'error');
        await this.load();   // 失敗原因寫在該列的 error_msg，重載才看得到全文
      }
      finally { this.syncing = ''; }
    },
    async remove(s) {
      const ok = await confirmDialog({
        title: '移除企業版來源',
        message: `確定移除 Odoo ${s.odoo_version} 的企業版來源？${this.isLocal(s) ? '你放進目錄的檔案會保留' : '已下載的檔案會保留'}，但之後建立企業版測試區會失敗。`,
        danger: true,
        confirmText: '移除'
      });
      if (!ok) return;
      try {
        await Api.delete(`admin/enterprise-sources/${s.odoo_version}`);
        await this.load();
        showToast('已移除', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    edit(s) {
      this.form = {
        odoo_version: s.odoo_version, source_type: s.source_type || 'git',
        repo_url: s.repo_url || '', branch: s.branch || ''
      };
    },
    statusLabel(s) {
      const local = this.isLocal(s);
      return {
        done: '🟢 可用',
        syncing: '🔄 同步中',
        pending: local ? '⚪ 尚未檢查' : '⚪ 尚未同步',
        error: local ? '🔴 不合格' : '🔴 同步失敗'
      }[s.clone_status] || s.clone_status;
    },
    syncedText(s) {
      const verb = this.isLocal(s) ? '檢查' : '同步';
      if (!s.last_synced_at) return `從未${verb}`;
      return `最後${verb} ${new Date(s.last_synced_at).toLocaleString('zh-TW')}`;
    }
  },
  template: `
    <div class="page-header">
      <div class="page-header-inner">
        <h1 class="page-title">企業版來源</h1>
      </div>
    </div>
    <div class="page-body">
      <div v-if="loading" class="loading">載入中...</div>
      <div v-else class="settings-layout">

        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">登記來源</div>
            <div class="setting-block-desc">
              企業版就是一包額外的 addons 目錄，且<strong>分大版本</strong>——17 的不能給 18 用，
              每個要支援的版本各登記一列。專案標為企業版後，建置測試區時會以唯讀方式掛入。
            </div>
          </div>
          <div class="setting-block-body">
            <div class="ae-type-choices">
              <label class="opt-card" :class="{ selected: form.source_type === 'git' }">
                <input type="radio" name="ae_source_type" value="git" v-model="form.source_type">
                <span class="opt-card-dot"></span>
                <span>Git repo<br /><span class="field-label-hint">從遠端 clone，私有 repo 需要 PAT</span></span>
              </label>
              <label class="opt-card" :class="{ selected: form.source_type === 'local' }">
                <input type="radio" name="ae_source_type" value="local" v-model="form.source_type">
                <span class="opt-card-dot"></span>
                <span>本地目錄<br /><span class="field-label-hint">自行把 addons 放進共用目錄，不經 git</span></span>
              </label>
            </div>
            <div class="conn-fields">
              <div class="field-item field-item-narrow">
                <label class="field-label">Odoo 大版本</label>
                <input v-model="form.odoo_version" placeholder="例：17" class="field-input" />
              </div>
              <template v-if="form.source_type === 'git'">
                <div class="field-item">
                  <label class="field-label">Git repo URL</label>
                  <input v-model="form.repo_url" placeholder="https://github.com/your-org/enterprise.git" class="field-input" />
                </div>
                <div class="field-item field-item-narrow">
                  <label class="field-label">分支（選填）</label>
                  <input v-model="form.branch" placeholder="例：17.0" class="field-input" />
                </div>
              </template>
            </div>
            <div class="field-label-hint" style="margin-top:var(--space-3)">
              <template v-if="form.source_type === 'local'">
                把該版本的 addons 直接放進 <code>{{ baseDir }}/{{ form.odoo_version || '&lt;版本&gt;' }}</code>——
                底下應該要直接看得到 <code>web_enterprise/</code>。路徑固定不可指定。
                登記後按「檢查」會驗證目錄內容與檔案權限。版本以你放進哪個目錄為準，平台不另行判定。
              </template>
              <template v-else>
                下載位置：<code>{{ baseDir }}</code>／&lt;版本&gt;。私有 repo 會用你在「設定」填的個人 GitHub PAT 認證。
              </template>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="save" :disabled="saving">
              {{ saving ? '儲存中...' : '登記／更新' }}
            </button>
          </div>
        </div>

        <div class="setting-block">
          <div class="setting-block-head">
            <div class="ae-registered-head-row">
              <div class="setting-block-title">已登記版本</div>
              <button class="btn btn-outline btn-sm" :disabled="loading" @click="load">
                {{ loading ? '載入中...' : '重新整理' }}
              </button>
            </div>
            <div class="setting-block-desc">狀態非「可用」時，該版本的企業版專案建置測試區會直接失敗（不會默默降級成社群版）。</div>
          </div>
          <div class="setting-block-body">
            <div v-if="!sources.length" class="field-label-hint">尚未登記任何版本。</div>
            <div v-for="s in sources" :key="s.odoo_version"
                 class="ae-source-row">
              <code style="min-width:48px;color:var(--text)">{{ s.odoo_version }}</code>
              <span class="ae-source-status">{{ statusLabel(s) }}</span>
              <span class="ae-source-repo-info">
                <template v-if="isLocal(s)">本地目錄 <code>{{ s.local_path || (baseDir + '/' + s.odoo_version) }}</code></template>
                <template v-else>{{ s.repo_url }}<template v-if="s.branch"> （{{ s.branch }}）</template></template>
                <br />
                {{ syncedText(s) }}
              </span>
              <button class="btn btn-outline btn-sm" @click="sync(s)" :disabled="syncing === s.odoo_version">
                {{ syncing === s.odoo_version ? (isLocal(s) ? '檢查中...' : '同步中...') : (isLocal(s) ? '檢查' : '同步') }}
              </button>
              <button class="btn btn-outline btn-sm" @click="edit(s)">編輯</button>
              <button class="btn btn-outline btn-sm" @click="remove(s)">移除</button>
              <div v-if="s.error_msg" class="error-msg" style="flex-basis:100%">{{ s.error_msg }}</div>
            </div>
          </div>
        </div>

      </div>
    </div>
  `
});
