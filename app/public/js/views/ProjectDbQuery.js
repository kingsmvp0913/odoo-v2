window.ProjectDbQueryView = Vue.defineComponent({
  name: 'ProjectDbQueryView',
  data() {
    return {
      conns: [], loading: true, saving: false, running: false, testing: false,
      form: { id: null, name: '', ssh_host: '', ssh_port: 22, ssh_user: '', auth_type: 'password', ssh_password: '', ssh_key_content: '', connect_mode: 'docker', docker_container: 'odoo-db', db_user: 'odoo', sudo_user: 'odoo', db_name: 'odoo_prd', db_host: '', db_port: 5432, db_password: '', db_ssl: false, db_engine: 'postgres', description: '', vpn_enabled: false, vpn_config: '', vpn_config_name: '', vpn_username: '', vpn_password: '' },
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
    resetForm() { this.form = { id: null, name: '', ssh_host: '', ssh_port: 22, ssh_user: '', auth_type: 'password', ssh_password: '', ssh_key_content: '', connect_mode: 'docker', docker_container: 'odoo-db', db_user: 'odoo', sudo_user: 'odoo', db_name: 'odoo_prd', db_host: '', db_port: 5432, db_password: '', db_ssl: false, db_engine: 'postgres', description: '', vpn_enabled: false, vpn_config: '', vpn_config_name: '', vpn_username: '', vpn_password: '' }; },
    editConn(c) { this.form = { ...c, ssh_password: '', db_password: '', vpn_config: '', vpn_config_name: '', vpn_password: '' }; },
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
    onVpnFileChange(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        this.form.vpn_config = reader.result;
        this.form.vpn_config_name = file.name;
        // 部分廠牌 GUI（如鴻久 SSLVPN）把帳密存成 openvpn 會忽略的 # 註解欄位；抓得到就直接代填。
        const userMatch = reader.result.match(/^#SSLVPN_AUTH_USERNAME=(.*)$/m);
        const passMatch = reader.result.match(/^#SSLVPN_AUTH_PASSWORD=(.*)$/m);
        if (userMatch && userMatch[1].trim()) this.form.vpn_username = userMatch[1].trim();
        if (passMatch && passMatch[1].trim()) this.form.vpn_password = passMatch[1].trim();
        if ((userMatch && userMatch[1].trim()) || (passMatch && passMatch[1].trim())) {
          showToast('已從設定檔自動帶入 VPN 帳密，請確認無誤', 'success');
        }
      };
      reader.readAsText(file);
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
      if (!await confirmDialog({ title: '刪除連線', message: `確定刪除連線「${c.name}」？`, danger: true, confirmText: '刪除' })) return;
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
    <div class="content" v-if="loading">
      <div class="settings-section">
        <h2 class="section-title">連線管理</h2>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>名稱</th><th>主機</th><th>模式</th><th>DB</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="i in 3" :key="i">
                <td><Skeleton width="100px" /></td>
                <td><Skeleton width="160px" /></td>
                <td><Skeleton width="60px" /></td>
                <td><Skeleton width="90px" /></td>
                <td><Skeleton width="110px" /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="content" v-else>
      <div class="settings-section" style="margin-bottom:20px">
        <h2 class="section-title">連線管理（{{ conns.length }}）</h2>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr>
              <th>名稱</th><th>主機</th><th>模式</th><th>DB</th><th>操作</th>
            </tr></thead>
            <tbody>
              <tr v-for="c in conns" :key="c.id">
                <td style="font-weight:var(--fw-semibold)">{{ c.name }}</td>
                <td>{{ c.connect_mode === 'direct' ? (c.db_user + '@' + c.db_host + ':' + c.db_port) : (c.ssh_user + '@' + c.ssh_host + ':' + c.ssh_port) }}</td>
                <td>{{ c.connect_mode }}</td>
                <td>{{ c.db_name }} <span v-if="c.vpn_enabled" style="font-size:11px;padding:1px 6px;border-radius:3px;background:var(--primary);color:#fff">VPN</span></td>
                <td><div style="display:flex;gap:6px">
                  <button class="btn btn-outline btn-sm" @click="editConn(c)">編輯</button>
                  <button class="btn btn-outline btn-sm" style="color:var(--error)" @click="deleteConn(c)">刪除</button>
                </div></td>
              </tr>
              <tr v-if="conns.length === 0" class="empty-row"><td colspan="5">尚無連線</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="settings-section" style="margin-bottom:20px">
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
        <div style="margin-bottom:12px;display:flex;align-items:center;gap:8px">
          <input v-model="form.vpn_enabled" type="checkbox" id="vpnEnabled" style="width:auto" />
          <label for="vpnEnabled" style="margin:0">此連線需要 VPN</label>
        </div>
        <div v-if="form.vpn_enabled" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;padding:12px;border:1px solid var(--border);border-radius:6px">
          <div class="form-group" style="margin:0">
            <label>VPN 設定檔（.ovpn）{{ form.vpn_config_name ? '－已選擇：' + form.vpn_config_name : (form.id ? '（留空＝不變）' : '') }}</label>
            <input type="file" accept=".ovpn,.conf" class="form-control" @change="onVpnFileChange" />
          </div>
          <div class="form-group" style="margin:0"><label>VPN 帳號</label><input v-model="form.vpn_username" class="form-control" /></div>
          <div class="form-group" style="margin:0"><label>VPN 密碼（留空＝不變）</label><input v-model="form.vpn_password" type="password" class="form-control" placeholder="••••••" /></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" @click="saveConn" :disabled="saving">{{ saving ? '儲存中...' : (form.id ? '更新連線' : '+ 新增連線') }}</button>
          <button class="btn btn-outline btn-sm" @click="testConn" :disabled="testing">{{ testing ? '測試中...' : '測試連線' }}</button>
          <button v-if="form.id" class="btn btn-outline btn-sm" @click="resetForm">取消編輯</button>
        </div>
      </div>

      <div class="settings-section">
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
        <div v-if="result" style="margin-top:10px">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">{{ result.row_count }} 筆</div>
          <div class="table-wrap">
          <table class="data-table">
            <thead><tr>
              <th v-for="col in result.columns" :key="col">{{ col }}</th>
            </tr></thead>
            <tbody>
              <tr v-for="(row,i) in result.rows" :key="i">
                <td v-for="(cell,j) in row" :key="j">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  `
});
