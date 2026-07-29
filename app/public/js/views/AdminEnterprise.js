window.AdminEnterpriseView = Vue.defineComponent({
  name: 'AdminEnterpriseView',
  data() {
    return {
      sources: [], baseDir: '', loading: true, saving: false, syncing: '',
      form: { odoo_version: '', repo_url: '', branch: '' }
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
    async save() {
      if (!this.form.odoo_version || !this.form.repo_url) return showToast('請填版本與 repo URL', 'error');
      this.saving = true;
      try {
        await Api.put(`admin/enterprise-sources/${encodeURIComponent(this.form.odoo_version)}`, {
          repo_url: this.form.repo_url, branch: this.form.branch
        });
        this.form = { odoo_version: '', repo_url: '', branch: '' };
        await this.load();
        showToast('已登記，請按「同步」下載', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.saving = false; }
    },
    async sync(v) {
      this.syncing = v;
      try {
        await Api.post(`admin/enterprise-sources/${v}/sync`, {});
        showToast('同步已開始，完成前狀態為「同步中」', 'success');
        setTimeout(() => this.load(), 3000);
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.syncing = ''; }
    },
    async remove(v) {
      const ok = await confirmDialog({
        title: '移除企業版來源',
        message: `確定移除 Odoo ${v} 的企業版來源？已下載的檔案會保留，但之後建立企業版測試區會失敗。`,
        danger: true,
        confirmText: '移除'
      });
      if (!ok) return;
      try {
        await Api.delete(`admin/enterprise-sources/${v}`);
        await this.load();
        showToast('已移除', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    edit(s) { this.form = { odoo_version: s.odoo_version, repo_url: s.repo_url, branch: s.branch || '' }; },
    statusLabel(s) {
      return { done: '🟢 可用', syncing: '🔄 同步中', pending: '⚪ 尚未同步', error: '🔴 同步失敗' }[s] || s;
    },
    syncedText(s) {
      if (!s.last_synced_at) return '從未同步';
      return `最後同步 ${new Date(s.last_synced_at).toLocaleString('zh-TW')}`;
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
            <div class="conn-fields">
              <div class="field-item field-item-narrow">
                <label class="field-label">Odoo 大版本</label>
                <input v-model="form.odoo_version" placeholder="例：17" class="field-input" />
              </div>
              <div class="field-item">
                <label class="field-label">Git repo URL</label>
                <input v-model="form.repo_url" placeholder="https://github.com/your-org/enterprise.git" class="field-input" />
              </div>
              <div class="field-item field-item-narrow">
                <label class="field-label">分支（選填）</label>
                <input v-model="form.branch" placeholder="例：17.0" class="field-input" />
              </div>
            </div>
            <div class="field-label-hint" style="margin-top:var(--space-3)">
              下載位置：<code>{{ baseDir }}</code>／&lt;版本&gt;。私有 repo 會用你在「設定」填的個人 GitHub PAT 認證。
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
            <div style="display:flex;align-items:center;justify-content:space-between">
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
                 style="display:flex;align-items:center;gap:var(--space-4);padding:var(--space-3) 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
              <code style="min-width:48px;color:var(--text)">{{ s.odoo_version }}</code>
              <span style="min-width:110px;font-size:var(--fs-sm);color:var(--text)">{{ statusLabel(s.clone_status) }}</span>
              <span style="flex:1;min-width:220px;font-size:var(--fs-sm);color:var(--text-muted);word-break:break-all">
                {{ s.repo_url }}<template v-if="s.branch"> （{{ s.branch }}）</template><br />
                {{ syncedText(s) }}
              </span>
              <button class="btn btn-outline btn-sm" @click="sync(s.odoo_version)" :disabled="syncing === s.odoo_version">
                {{ syncing === s.odoo_version ? '同步中...' : '同步' }}
              </button>
              <button class="btn btn-outline btn-sm" @click="edit(s)">編輯</button>
              <button class="btn btn-outline btn-sm" @click="remove(s.odoo_version)">移除</button>
              <div v-if="s.error_msg" class="error-msg" style="flex-basis:100%">{{ s.error_msg }}</div>
            </div>
          </div>
        </div>

      </div>
    </div>
  `
});
