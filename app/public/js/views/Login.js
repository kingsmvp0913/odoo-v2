window.LoginView = Vue.defineComponent({
  name: 'LoginView',
  data() {
    return {
      mode: 'login',            // 'login' | 'setup' | 'register'
      step: 1,                  // register 精靈步驟 1..6
      form: { username: '', password: '', display_name: '' },
      // 憑證累積：Odoo/eService 存進同一個 odoo_settings，故累積後整包 PUT，避免互相覆蓋
      creds: { odoo_username: '', odoo_password: '', odoo_user_id: '', service_username: '', service_password: '', service_user_id: '' },
      git: { pat: '', login: '', verifying: false, done: false },
      odoo: { verifying: false, done: false },
      service: { verifying: false, done: false },
      notify: { supported: !!(window.NotifyManager && NotifyManager.supported), done: false },
      loading: false,
      error: ''
    };
  },
  async created() {
    const status = await Api.checkSetup().catch(() => ({ setup_done: false }));
    if (!status.setup_done) this.mode = 'setup';
  },
  computed: {
    steps() { return ['建立帳號', 'Git 認證', 'Odoo 帳密', 'eService 帳密', '桌面通知', '完成']; },
    patLink() { return 'https://github.com/settings/tokens/new?scopes=repo&description=aidev-platform'; }
  },
  methods: {
    async submit() {
      this.loading = true; this.error = '';
      try {
        const endpoint = this.mode === 'setup' ? 'auth/setup' : 'auth/login';
        const payload = this.mode === 'setup'
          ? { username: this.form.username, password: this.form.password, display_name: this.form.display_name }
          : { username: this.form.username, password: this.form.password };
        const res = await Api.post(endpoint, payload);
        Api.setToken(res.token);
        this.$router.push('/');
      } catch (e) { this.error = e.message; }
      finally { this.loading = false; }
    },
    goRegister() { this.mode = 'register'; this.step = 1; this.error = ''; },
    backToLogin() { Api.clearToken(); this.mode = 'login'; this.step = 1; this.error = ''; },
    // Step 1：建立 pending 帳號，拿到 token 供後續步驟呼叫 settings endpoint
    async doRegister() {
      if (!this.form.username || !this.form.password || !this.form.display_name) { this.error = '請填寫所有欄位'; return; }
      if (this.form.password.length < 8) { this.error = '密碼至少 8 個字元'; return; }
      this.loading = true; this.error = '';
      try {
        const res = await Api.post('auth/register', {
          username: this.form.username, password: this.form.password, display_name: this.form.display_name
        });
        Api.setToken(res.token);
        this.step = 2;
      } catch (e) { this.error = e.message; }
      finally { this.loading = false; }
    },
    // Step 2：GitHub PAT（後端驗證＋加密存 users.github_pat_enc）
    async verifyGit() {
      if (!this.git.pat.trim()) { this.error = '請貼上 GitHub PAT'; return; }
      this.git.verifying = true; this.error = '';
      try {
        const r = await Api.post('settings/github-pat', { pat: this.git.pat.trim() });
        this.git.login = r.login; this.git.done = true; this.git.pat = '';
      } catch (e) { this.error = e.message || 'PAT 驗證失敗'; }
      finally { this.git.verifying = false; }
    },
    // Step 3/4：驗證帳密（回 uid）→ 整包 creds PUT 進 odoo_settings
    async verifyOdoo() {
      if (!this.creds.odoo_username || !this.creds.odoo_password) { this.error = '請填寫 Odoo 帳號和密碼'; return; }
      this.odoo.verifying = true; this.error = '';
      try {
        const { uid } = await Api.post('settings/verify-odoo', { odoo_username: this.creds.odoo_username, odoo_password: this.creds.odoo_password });
        this.creds.odoo_user_id = String(uid);
        await Api.put('settings', { odoo_settings: { ...this.creds } });
        this.odoo.done = true; this.step = 4;
      } catch (e) { this.error = e.message; }
      finally { this.odoo.verifying = false; }
    },
    async verifyService() {
      if (!this.creds.service_username || !this.creds.service_password) { this.error = '請填寫 eService 帳號和密碼'; return; }
      this.service.verifying = true; this.error = '';
      try {
        const { uid } = await Api.post('settings/verify-service', { service_username: this.creds.service_username, service_password: this.creds.service_password });
        this.creds.service_user_id = String(uid);
        await Api.put('settings', { odoo_settings: { ...this.creds } });
        this.service.done = true; this.step = 5;
      } catch (e) { this.error = e.message; }
      finally { this.service.verifying = false; }
    },
    async enableNotify() {
      this.error = '';
      try {
        const r = await NotifyManager.enable();
        this.notify.done = !!(r && r.ok);
        if (!this.notify.done) this.error = '瀏覽器未授權通知（可略過，稍後於設定頁再開）';
        else this.step = 6;
      } catch { this.error = '無法開啟通知（可略過）'; }
    },
    goStep(n) { this.error = ''; this.step = n; }
  },
  template: `
    <div class="login-wrap">
      <div class="login-box" :style="mode === 'register' ? 'max-width:520px' : ''">
        <div class="login-title">AI Dev</div>

        <!-- 登入 / 首次設定 -->
        <template v-if="mode !== 'register'">
          <div class="login-sub">{{ mode === 'setup' ? '首次設定管理帳號' : '登入工作台' }}</div>
          <div v-if="error" class="error-msg">{{ error }}</div>
          <form @submit.prevent="submit">
            <div v-if="mode === 'setup'" class="form-group">
              <label>顯示名稱</label>
              <input v-model="form.display_name" required placeholder="你的名字" />
            </div>
            <div class="form-group">
              <label>帳號</label>
              <input v-model="form.username" required autocomplete="username" placeholder="admin" />
            </div>
            <div class="form-group">
              <label>密碼</label>
              <input v-model="form.password" type="password" required autocomplete="current-password" placeholder="••••••••" />
            </div>
            <button class="btn btn-primary" style="width:100%" :disabled="loading" type="submit">
              {{ loading ? '處理中...' : (mode === 'setup' ? '建立帳號' : '登入') }}
            </button>
          </form>
          <div v-if="mode === 'login'" style="text-align:center;margin-top:14px;font-size:var(--fs-sm);color:var(--text-muted)">
            還沒有帳號？<a href="javascript:void(0)" @click="goRegister" style="color:var(--primary);font-weight:var(--fw-semibold)">註冊新帳號</a>
          </div>
        </template>

        <!-- 註冊精靈 -->
        <template v-else>
          <div class="login-sub">註冊新帳號</div>
          <!-- Stepper -->
          <div style="display:flex;align-items:center;justify-content:center;gap:4px;margin:6px 0 18px">
            <template v-for="(s, i) in steps" :key="i">
              <div :title="s" :style="{width:'24px',height:'24px',borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:'var(--fs-xs)',fontWeight:'var(--fw-semibold)',flexShrink:0,background: (step >= i+1 ? 'var(--primary)' : 'var(--border)'), color: (step >= i+1 ? '#fff' : 'var(--text-muted)')}">{{ i+1 }}</div>
              <div v-if="i < steps.length-1" :style="{width:'16px',height:'2px',background: (step > i+1 ? 'var(--primary)' : 'var(--border)')}"></div>
            </template>
          </div>
          <div style="text-align:center;font-weight:var(--fw-semibold);margin-bottom:12px">{{ step }}. {{ steps[step-1] }}</div>
          <div v-if="error" class="error-msg">{{ error }}</div>

          <!-- Step 1 建立帳號 -->
          <template v-if="step === 1">
            <div class="form-group"><label>顯示名稱</label><input v-model="form.display_name" placeholder="你的名字" /></div>
            <div class="form-group"><label>帳號</label><input v-model="form.username" autocomplete="username" placeholder="英數帳號" /></div>
            <div class="form-group"><label>密碼</label><input v-model="form.password" type="password" placeholder="至少 8 個字元" /></div>
            <button class="btn btn-primary" style="width:100%" :disabled="loading" @click="doRegister">{{ loading ? '建立中...' : '下一步' }}</button>
          </template>

          <!-- Step 2 Git 認證（詳細說明） -->
          <template v-else-if="step === 2">
            <p style="font-size:var(--fs-base);color:var(--text-secondary);line-height:1.6;margin-bottom:10px">
              平台會代替你 clone／commit／push 你負責的專案程式碼，需要一組你的 GitHub 個人存取權杖（PAT）當作 Git 密碼。
              權杖會<b>加密保存</b>，只用於你的 Git 操作，可隨時到設定頁撤銷。
            </p>
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;font-size:var(--fs-sm);line-height:1.8;margin-bottom:10px">
              <b>如何取得 PAT：</b>
              <ol style="margin:6px 0 0 18px;padding:0">
                <li>前往 GitHub → 右上頭像 → <b>Settings</b></li>
                <li>左側捲到最底 <b>Developer settings</b></li>
                <li><b>Personal access tokens → Tokens (classic) → Generate new token (classic)</b></li>
                <li><b>Note</b> 填好認的名字，例如 <code>aidev-platform</code></li>
                <li><b>Expiration</b> 選有效期（建議 90 天以上）</li>
                <li><b>Scopes</b> 勾選 <code>repo</code>（clone／push 私有庫必需）</li>
                <li>按 <b>Generate token</b>，複製那串 <code>ghp_...</code>（<b>只會顯示一次</b>）</li>
              </ol>
              <div style="margin-top:8px">
                <a :href="patLink" target="_blank" style="color:var(--primary);font-weight:var(--fw-semibold)">↗ 開啟 GitHub 建立權杖頁（已預帶 repo 權限與名稱）</a>
              </div>
            </div>
            <div v-if="git.done" class="pill pill-success" style="display:block;padding:8px 10px;margin-bottom:10px">✓ 已連結 GitHub 帳號：{{ git.login }}</div>
            <template v-else>
              <div class="form-group"><label>GitHub PAT</label><input v-model="git.pat" placeholder="ghp_xxxxxxxx" /></div>
              <button class="btn btn-primary" style="width:100%" :disabled="git.verifying" @click="verifyGit">{{ git.verifying ? '驗證中...' : '驗證並儲存' }}</button>
            </template>
            <div style="display:flex;justify-content:space-between;margin-top:12px">
              <button class="btn btn-outline btn-sm" @click="goStep(1)">上一步</button>
              <button class="btn btn-primary btn-sm" v-if="git.done" @click="goStep(3)">下一步</button>
              <button class="btn btn-outline btn-sm" v-else @click="goStep(3)">略過，稍後設定</button>
            </div>
          </template>

          <!-- Step 3 Odoo 帳密 -->
          <template v-else-if="step === 3">
            <p style="font-size:var(--fs-base);color:var(--text-secondary);line-height:1.6;margin-bottom:10px">
              填入你的 Odoo ERP 帳號密碼，平台會用它同步你負責的工單。驗證會連線 Odoo 確認帳密正確。
            </p>
            <div class="form-group"><label>Odoo 帳號</label><input v-model="creds.odoo_username" placeholder="你的 Odoo 登入帳號" /></div>
            <div class="form-group"><label>Odoo 密碼</label><input v-model="creds.odoo_password" type="password" placeholder="••••••" /></div>
            <button class="btn btn-primary" style="width:100%" :disabled="odoo.verifying" @click="verifyOdoo">{{ odoo.verifying ? '驗證中...' : '驗證並繼續' }}</button>
            <div style="display:flex;justify-content:space-between;margin-top:12px">
              <button class="btn btn-outline btn-sm" @click="goStep(2)">上一步</button>
              <button class="btn btn-outline btn-sm" @click="goStep(4)">略過，稍後設定</button>
            </div>
          </template>

          <!-- Step 4 eService 帳密 -->
          <template v-else-if="step === 4">
            <p style="font-size:var(--fs-base);color:var(--text-secondary);line-height:1.6;margin-bottom:10px">
              填入你的 eService（客服系統）帳號密碼，平台會用它同步你負責的客服工單。
            </p>
            <div class="form-group"><label>eService 帳號</label><input v-model="creds.service_username" placeholder="你的 eService 登入帳號" /></div>
            <div class="form-group"><label>eService 密碼</label><input v-model="creds.service_password" type="password" placeholder="••••••" /></div>
            <button class="btn btn-primary" style="width:100%" :disabled="service.verifying" @click="verifyService">{{ service.verifying ? '驗證中...' : '驗證並繼續' }}</button>
            <div style="display:flex;justify-content:space-between;margin-top:12px">
              <button class="btn btn-outline btn-sm" @click="goStep(3)">上一步</button>
              <button class="btn btn-outline btn-sm" @click="goStep(5)">略過，稍後設定</button>
            </div>
          </template>

          <!-- Step 5 桌面通知 -->
          <template v-else-if="step === 5">
            <p style="font-size:var(--fs-base);color:var(--text-secondary);line-height:1.6;margin-bottom:10px">
              開啟桌面通知後，任務有進度或需要你確認時，瀏覽器會即時提醒你，不必一直盯著頁面。
            </p>
            <div v-if="!notify.supported" class="pill pill-warn" style="display:block;padding:8px 10px;margin-bottom:10px">此瀏覽器不支援桌面通知，可略過。</div>
            <div v-else-if="notify.done" class="pill pill-success" style="display:block;padding:8px 10px;margin-bottom:10px">✓ 桌面通知已開啟</div>
            <button v-else class="btn btn-primary" style="width:100%" @click="enableNotify">開啟桌面通知</button>
            <div style="display:flex;justify-content:space-between;margin-top:12px">
              <button class="btn btn-outline btn-sm" @click="goStep(4)">上一步</button>
              <button class="btn btn-primary btn-sm" @click="goStep(6)">{{ notify.done ? '下一步' : '略過，完成' }}</button>
            </div>
          </template>

          <!-- 全部略過：任一憑證/通知步驟都能一鍵跳到完成，稍後於設定頁再設 -->
          <div v-if="step >= 2 && step <= 5" style="text-align:center;margin-top:14px">
            <a href="javascript:void(0)" @click="goStep(6)" style="font-size:var(--fs-sm);color:var(--text-muted)">全部略過，稍後於設定頁再設定 →</a>
          </div>

          <!-- Step 6 完成 -->
          <template v-else-if="step === 6">
            <div style="text-align:center;padding:10px 0">
              <div style="font-size:32px;margin-bottom:8px">🎉</div>
              <div style="font-weight:var(--fw-semibold);margin-bottom:8px">註冊完成，等待管理員審核</div>
              <p style="font-size:var(--fs-base);color:var(--text-secondary);line-height:1.6">
                你的帳號已建立並停用中。管理員核准後，用剛剛設定好的帳號密碼登入即可開始工作。
              </p>
              <button class="btn btn-primary" style="width:100%;margin-top:14px" @click="backToLogin">前往登入頁</button>
            </div>
          </template>
        </template>
      </div>
    </div>
  `
});
