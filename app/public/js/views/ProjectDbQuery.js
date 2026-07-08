window.ProjectDbQueryView = Vue.defineComponent({
  name: 'ProjectDbQueryView',
  data() {
    return {
      conns: [], loading: true, saving: false, running: false, testing: false,
      form: { id: null, name: '', ssh_host: '', ssh_port: 22, ssh_user: '', auth_type: 'password', ssh_password: '', ssh_key_content: '', connect_mode: 'docker', docker_container: 'odoo-db', db_user: 'odoo', sudo_user: 'odoo', db_name: 'odoo_prd', db_host: '', db_port: 5432, db_password: '', db_ssl: false, db_engine: 'postgres', description: '' },
      selectedId: '', sql: '', result: null, error: ''
    };
  },
  async created() { await this.load(); },
  methods: {
    pid() { return this.$route.params.id; },
    async load() {
      this.loading = true;
      try { this.conns = await Api.get(`projects/${this.pid()}/db-connections`); }
      catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    resetForm() { this.form = { id: null, name: '', ssh_host: '', ssh_port: 22, ssh_user: '', auth_type: 'password', ssh_password: '', ssh_key_content: '', connect_mode: 'docker', docker_container: 'odoo-db', db_user: 'odoo', sudo_user: 'odoo', db_name: 'odoo_prd', db_host: '', db_port: 5432, db_password: '', db_ssl: false, db_engine: 'postgres', description: '' }; },
    editConn(c) { this.form = { ...c, ssh_password: '', db_password: '' }; },
    validForm() {
      if (this.form.connect_mode === 'direct')
        return this.form.name && this.form.db_host && this.form.db_user && (this.form.id || this.form.db_password) && this.form.db_name;
      return this.form.name && this.form.ssh_host && this.form.ssh_user && this.form.db_name;
    },
    async testConn() {
      this.testing = true;
      try {
        const r = await Api.post(`projects/${this.pid()}/db-connections/test`, this.form);
        if (r.ok) showToast('連線成功', 'success'); else showToast('連線失敗：' + (r.error || '未知錯誤'), 'error');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.testing = false; }
    },
    async saveConn() {
      if (!this.validForm()) return showToast(this.form.connect_mode === 'direct' ? '名稱/DB主機/DB使用者/密碼/資料庫 必填' : '名稱/主機/使用者/資料庫 必填', 'error');
      this.saving = true;
      try {
        if (this.form.id) await Api.put(`projects/${this.pid()}/db-connections/${this.form.id}`, this.form);
        else await Api.post(`projects/${this.pid()}/db-connections`, this.form);
        this.resetForm(); await this.load(); showToast('已儲存連線', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.saving = false; }
    },
    async deleteConn(c) {
      if (!confirm(`刪除連線「${c.name}」？`)) return;
      try { await Api.delete(`projects/${this.pid()}/db-connections/${c.id}`); await this.load(); showToast('已刪除', 'success'); }
      catch (e) { showToast(e.message, 'error'); }
    },
    async runQuery() {
      if (!this.selectedId) return showToast('請先選連線', 'error');
      if (!this.sql.trim()) return showToast('請輸入 SQL', 'error');
      this.running = true; this.result = null; this.error = '';
      try {
        const r = await Api.post(`projects/${this.pid()}/db-connections/${this.selectedId}/query`, { sql: this.sql });
        if (r.ok) this.result = r; else this.error = r.error || '查詢失敗';
      } catch (e) { this.error = e.message; }
      finally { this.running = false; }
    }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/projects/'+pid())" style="margin-right:12px">← 返回專案</button>
      <h1>資料庫查詢</h1>
    </div>
    <div class="content" v-if="!loading">
      <div class="admin-section" style="margin-bottom:20px">
        <h2 class="section-title">連線管理（{{ conns.length }}）</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="border-bottom:1px solid var(--border);text-align:left">
            <th style="padding:8px 10px">名稱</th><th style="padding:8px 10px">主機</th><th style="padding:8px 10px">模式</th><th style="padding:8px 10px">DB</th><th style="padding:8px 10px">操作</th>
          </tr></thead>
          <tbody>
            <tr v-for="c in conns" :key="c.id" style="border-bottom:1px solid var(--border)">
              <td style="padding:8px 10px;font-weight:600">{{ c.name }}</td>
              <td style="padding:8px 10px">{{ c.connect_mode === 'direct' ? (c.db_user + '@' + c.db_host + ':' + c.db_port) : (c.ssh_user + '@' + c.ssh_host + ':' + c.ssh_port) }}</td>
              <td style="padding:8px 10px">{{ c.connect_mode }}</td>
              <td style="padding:8px 10px">{{ c.db_name }}</td>
              <td style="padding:8px 10px"><div style="display:flex;gap:6px">
                <button class="btn btn-outline btn-sm" @click="editConn(c)">編輯</button>
                <button class="btn btn-outline btn-sm" style="color:var(--error)" @click="deleteConn(c)">刪除</button>
              </div></td>
            </tr>
            <tr v-if="conns.length === 0"><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">尚無連線</td></tr>
          </tbody>
        </table>
      </div>

      <div class="admin-section" style="margin-bottom:20px">
        <h2 class="section-title">{{ form.id ? '編輯連線' : '新增連線' }}</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div class="form-group" style="margin:0"><label>連線名稱</label><input v-model="form.name" class="form-control" placeholder="hj-鴻久-正式" /></div>
          <div class="form-group" style="margin:0"><label>連線模式</label><select v-model="form.connect_mode" class="form-control"><option value="docker">docker（SSH→容器）</option><option value="local">local（SSH→本機）</option><option value="direct">direct（直連 TCP）</option></select></div>
          <template v-if="form.connect_mode!=='direct'">
            <div class="form-group" style="margin:0"><label>SSH 主機</label><input v-model="form.ssh_host" class="form-control" placeholder="1.2.3.4" /></div>
            <div class="form-group" style="margin:0"><label>SSH 埠</label><input v-model.number="form.ssh_port" class="form-control" /></div>
            <div class="form-group" style="margin:0"><label>SSH 使用者</label><input v-model="form.ssh_user" class="form-control" placeholder="root" /></div>
            <div class="form-group" style="margin:0"><label>認證方式</label><select v-model="form.auth_type" class="form-control"><option value="password">密碼</option><option value="key">金鑰</option></select></div>
            <div class="form-group" style="margin:0" v-if="form.auth_type==='password'"><label>SSH 密碼（留空＝不變）</label><input v-model="form.ssh_password" type="password" class="form-control" placeholder="••••••" /></div>
            <div class="form-group" style="margin:0" v-else><label>SSH 金鑰內容（PEM）</label><textarea v-model="form.ssh_key_content" class="form-control" rows="4" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----" style="font-family:monospace;font-size:11px"></textarea></div>
            <div class="form-group" style="margin:0" v-if="form.connect_mode==='docker'"><label>Docker 容器</label><input v-model="form.docker_container" class="form-control" /></div>
            <div class="form-group" style="margin:0" v-if="form.connect_mode==='docker'"><label>DB 使用者</label><input v-model="form.db_user" class="form-control" /></div>
            <div class="form-group" style="margin:0" v-if="form.connect_mode==='local'"><label>sudo 使用者</label><input v-model="form.sudo_user" class="form-control" /></div>
          </template>
          <template v-else>
            <div class="form-group" style="margin:0"><label>引擎</label><select v-model="form.db_engine" class="form-control"><option value="postgres">PostgreSQL</option><option value="mssql">MS SQL Server</option><option value="mysql">MySQL / MariaDB</option></select></div>
            <div class="form-group" style="margin:0"><label>DB 主機</label><input v-model="form.db_host" class="form-control" placeholder="db.example.com" /></div>
            <div class="form-group" style="margin:0"><label>DB 埠</label><input v-model.number="form.db_port" class="form-control" :placeholder="form.db_engine==='mssql'?'1433':form.db_engine==='mysql'?'3306':'5432'" /></div>
            <div class="form-group" style="margin:0"><label>DB 使用者</label><input v-model="form.db_user" class="form-control" placeholder="reader" /></div>
            <div class="form-group" style="margin:0"><label>DB 密碼（留空＝不變）</label><input v-model="form.db_password" type="password" class="form-control" placeholder="••••••" /></div>
            <div class="form-group" style="margin:0;display:flex;align-items:center;gap:8px"><label style="margin:0">SSL</label><input v-model="form.db_ssl" type="checkbox" style="width:auto" /></div>
          </template>
          <div class="form-group" style="margin:0"><label>資料庫名稱</label><input v-model="form.db_name" class="form-control" /></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" @click="saveConn" :disabled="saving">{{ saving ? '儲存中...' : (form.id ? '更新連線' : '+ 新增連線') }}</button>
          <button class="btn btn-outline btn-sm" @click="testConn" :disabled="testing">{{ testing ? '測試中...' : '測試連線' }}</button>
          <button v-if="form.id" class="btn btn-outline btn-sm" @click="resetForm">取消編輯</button>
        </div>
      </div>

      <div class="admin-section">
        <h2 class="section-title">查詢（只允許 SELECT）</h2>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <select v-model="selectedId" class="form-control" style="max-width:280px">
            <option value="">選擇連線...</option>
            <option v-for="c in conns" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <button class="btn btn-primary btn-sm" @click="runQuery" :disabled="running">{{ running ? '查詢中...' : '執行' }}</button>
        </div>
        <textarea v-model="sql" class="form-control" rows="4" placeholder="SELECT id, login FROM res_users LIMIT 20" style="font-family:monospace"></textarea>
        <div v-if="error" class="error-msg" style="margin-top:10px;white-space:pre-wrap">{{ error }}</div>
        <div v-if="result" style="margin-top:10px;overflow-x:auto">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">{{ result.row_count }} 筆</div>
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="border-bottom:1px solid var(--border);text-align:left">
              <th v-for="col in result.columns" :key="col" style="padding:6px 8px">{{ col }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="(row,i) in result.rows" :key="i" style="border-bottom:1px solid var(--border)">
                <td v-for="(cell,j) in row" :key="j" style="padding:6px 8px">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `
});
