window.SettingsView = Vue.defineComponent({
  name: 'SettingsView',
  data() {
    return {
      me: { username: '', display_name: '' },
      teamsUserId: '',
      creds: {
        odoo_username: '', odoo_password: '', odoo_user_id: '',
        service_username: '', service_password: '', service_user_id: ''
      },
      pw: { current: '', next: '', confirm: '' },
      pwError: '',
      loading: true,
      saving: false,
      savingPw: false,
      verifyingOdoo: false,
      verifyingService: false,
      isDark: (window.ThemeManager && ThemeManager.current() === 'dark'),
      notifyOn: (window.NotifyManager && NotifyManager.isOn())
    };
  },
  computed: {
    pwValidation() {
      if (!this.pw.current) return '請輸入目前密碼';
      if (this.pw.next.length < 8) return '新密碼至少 8 個字元';
      if (this.pw.next !== this.pw.confirm) return '兩次輸入的新密碼不一致';
      return '';
    }
  },
  async created() { await this.load(); },
  mounted() {
    this._onThemeChange = e => { this.isDark = e.detail === 'dark'; };
    window.addEventListener('themechange', this._onThemeChange);
  },
  unmounted() { window.removeEventListener('themechange', this._onThemeChange); },
  methods: {
    toggleTheme() { ThemeManager.toggle(); },
    async toggleNotify(e) {
      if (e.target.checked) {
        const r = await NotifyManager.enable();
        this.notifyOn = r.ok;
        if (r.ok) showToast('已開啟桌面通知', 'success');
        else showToast(r.reason === 'denied' ? '瀏覽器已封鎖通知權限，請至瀏覽器設定開啟' : '此瀏覽器不支援通知', 'error');
      } else {
        NotifyManager.disable();
        this.notifyOn = false;
      }
    },
    async load() {
      this.loading = true;
      try {
        const [me, settings] = await Promise.all([Api.get('auth/me'), Api.get('settings')]);
        this.me.username = me.username || '';
        this.me.display_name = me.display_name || '';
        const s = settings.odoo_settings || {};
        this.teamsUserId            = s.teams_user_id   || '';
        this.creds.odoo_username    = s.odoo_username   || '';
        this.creds.odoo_password    = s.odoo_password   || '';
        this.creds.odoo_user_id     = s.odoo_user_id    || '';
        this.creds.service_username = s.service_username || '';
        this.creds.service_password = s.service_password || '';
        this.creds.service_user_id  = s.service_user_id  || '';
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    async save() {
      this.saving = true;
      try {
        const odoo_settings = { teams_user_id: this.teamsUserId, ...this.creds };
        await Promise.all([
          Api.put('auth/me', { display_name: this.me.display_name }),
          Api.put('settings', { odoo_settings })
        ]);
        showToast('設定已儲存', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.saving = false; }
    },
    async savePw() {
      this.pwError = this.pwValidation;
      if (this.pwError) return;
      this.savingPw = true;
      try {
        await Api.put('auth/me', { current_password: this.pw.current, new_password: this.pw.next });
        this.pw = { current: '', next: '', confirm: '' };
        showToast('密碼已更新', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingPw = false; }
    },
    async verifyOdoo() {
      if (!this.creds.odoo_username || !this.creds.odoo_password) {
        return showToast('請先填寫 Odoo 帳號和密碼', 'error');
      }
      this.verifyingOdoo = true;
      try {
        const { uid } = await Api.post('settings/verify-odoo', {
          odoo_username: this.creds.odoo_username,
          odoo_password: this.creds.odoo_password
        });
        this.creds.odoo_user_id = String(uid);
        showToast(`驗證成功，使用者 ID：${uid}`, 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.verifyingOdoo = false; }
    },
    testNotify() {
      const perm = window.Notification ? Notification.permission : 'unsupported';
      if (perm === 'denied') {
        showToast('瀏覽器已封鎖此網站的通知，請至瀏覽器設定 → 網站通知 → 解除封鎖後重新整理', 'error', 8000);
        return;
      }
      if (perm === 'default') {
        showToast('尚未授權通知，請先開啟通知開關', 'error');
        return;
      }
      if (!NotifyManager.enabled()) {
        showToast('通知未啟用（localStorage 已停用）', 'error');
        return;
      }
      NotifyManager.show('測試通知', '桌面通知運作正常 ✓', 'test');
      showToast('測試通知已發送', 'success');
    },
    async verifyService() {
      if (!this.creds.service_username || !this.creds.service_password) {
        return showToast('請先填寫 eService 帳號和密碼', 'error');
      }
      this.verifyingService = true;
      try {
        const { uid } = await Api.post('settings/verify-service', {
          service_username: this.creds.service_username,
          service_password: this.creds.service_password
        });
        this.creds.service_user_id = String(uid);
        showToast(`驗證成功，使用者 ID：${uid}`, 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.verifyingService = false; }
    }
  },
  template: `
    <div class="page-header">
      <div class="page-header-inner">
        <h1 class="page-title">個人設定</h1>
      </div>
    </div>
    <div class="page-body">
      <div v-if="loading" class="loading">載入中...</div>
      <div v-else class="settings-layout">

        <!-- 外觀與通知 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">外觀與通知</div>
          </div>
          <div class="setting-block-body">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:var(--fs-md);margin-bottom:var(--space-3)">
              <input type="checkbox" :checked="isDark" @change="toggleTheme" style="width:16px;height:16px;cursor:pointer" />
              <span>深色模式</span>
            </label>
            <div style="display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap">
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:var(--fs-md)">
                <input type="checkbox" :checked="notifyOn" @change="toggleNotify" style="width:16px;height:16px;cursor:pointer" />
                <span>桌面通知（有任務需要你處理時提醒）</span>
              </label>
              <button v-if="notifyOn" class="btn btn-primary btn-sm" @click="testNotify" style="white-space:nowrap">🔔 測試通知</button>
            </div>
            <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:6px">開啟後瀏覽器會請求通知權限；需保持至少一個分頁開著才能收到。</div>
          </div>
        </div>

        <!-- 帳號 + 密碼 (同一 block，兩欄) -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">帳號與密碼</div>
          </div>
          <div class="setting-block-body">
            <div class="conn-fields-wrap">
              <!-- 帳號欄 -->
              <div>
                <div class="field-item" style="margin-bottom:var(--space-3)">
                  <label class="field-label">帳號</label>
                  <input :value="me.username" disabled class="field-input" />
                </div>
                <div class="field-item">
                  <label class="field-label">顯示名稱</label>
                  <input v-model="me.display_name" placeholder="你的名字" class="field-input" />
                </div>
              </div>
              <!-- 密碼欄 -->
              <div>
                <div class="field-item" style="margin-bottom:var(--space-3)">
                  <label class="field-label">目前密碼</label>
                  <input v-model="pw.current" type="password" placeholder="••••••••" class="field-input" />
                </div>
                <div class="field-item" style="margin-bottom:var(--space-3)">
                  <label class="field-label">新密碼 <span class="field-label-hint">至少 8 個字元</span></label>
                  <input v-model="pw.next" type="password" placeholder="••••••••" class="field-input" :class="{ error: pw.next && pw.next.length < 8 }" />
                </div>
                <div class="field-item" style="margin-bottom:10px">
                  <label class="field-label">確認新密碼</label>
                  <input v-model="pw.confirm" type="password" placeholder="••••••••" class="field-input" :class="{ error: pw.confirm && pw.next !== pw.confirm }" />
                </div>
                <div v-if="pwError" class="form-error">{{ pwError }}</div>
                <button class="btn btn-ghost btn-sm" @click="savePw" :disabled="savingPw">{{ savingPw ? '更新中...' : '更新密碼' }}</button>
              </div>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="save" :disabled="saving">{{ saving ? '儲存中...' : '儲存帳號設定' }}</button>
          </div>
        </div>

        <!-- Odoo 帳號 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">Odoo 帳號</div>
            <div class="setting-block-desc">Odoo 伺服器位址由管理員統一設定，此處填寫你的個人登入憑證。</div>
          </div>
          <div class="setting-block-body">
            <div class="conn-fields">
              <div class="field-item">
                <label class="field-label">登入帳號</label>
                <input v-model="creds.odoo_username" placeholder="admin" class="field-input" />
              </div>
              <div class="field-item">
                <label class="field-label">密碼</label>
                <input v-model="creds.odoo_password" type="password" placeholder="••••••" class="field-input" />
              </div>
            </div>
            <div class="field-item" style="margin-top:10px;max-width:320px">
              <label class="field-label">使用者 ID <span class="field-label-hint">任務負責人篩選</span></label>
              <div style="display:flex;gap:var(--space-2)">
                <input v-model="creds.odoo_user_id" placeholder="點擊驗證自動取得" class="field-input" />
                <button class="btn btn-outline btn-sm" @click="verifyOdoo" :disabled="verifyingOdoo" style="white-space:nowrap">
                  {{ verifyingOdoo ? '驗證中...' : '驗證取得' }}
                </button>
              </div>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="save" :disabled="saving">{{ saving ? '儲存中...' : '儲存' }}</button>
          </div>
        </div>

        <!-- eService 帳號 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">eService 帳號</div>
            <div class="setting-block-desc">eService 伺服器位址由管理員統一設定，此處填寫你的個人登入憑證。</div>
          </div>
          <div class="setting-block-body">
            <div class="conn-fields">
              <div class="field-item">
                <label class="field-label">登入帳號</label>
                <input v-model="creds.service_username" placeholder="admin" class="field-input" />
              </div>
              <div class="field-item">
                <label class="field-label">密碼</label>
                <input v-model="creds.service_password" type="password" placeholder="••••••" class="field-input" />
              </div>
            </div>
            <div class="field-item" style="margin-top:10px;max-width:320px">
              <label class="field-label">使用者 ID <span class="field-label-hint">任務負責人篩選</span></label>
              <div style="display:flex;gap:var(--space-2)">
                <input v-model="creds.service_user_id" placeholder="點擊驗證自動取得" class="field-input" />
                <button class="btn btn-outline btn-sm" @click="verifyService" :disabled="verifyingService" style="white-space:nowrap">
                  {{ verifyingService ? '驗證中...' : '驗證取得' }}
                </button>
              </div>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="save" :disabled="saving">{{ saving ? '儲存中...' : '儲存' }}</button>
          </div>
        </div>

        <!-- Teams 通知 -->
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">Teams 通知</div>
            <div class="setting-block-desc">填寫你的 Azure AD 物件識別碼，任務通知時系統會以你的顯示名稱 @mention。</div>
          </div>
          <div class="setting-block-body">
            <div class="field-item" style="max-width:420px">
              <label class="field-label">Teams 使用者 ID（AAD Object ID）</label>
              <input v-model="teamsUserId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" class="field-input" />
              <div class="hint-text">Azure AD → 使用者 → 物件識別碼</div>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-primary btn-sm" @click="save" :disabled="saving">{{ saving ? '儲存中...' : '儲存' }}</button>
          </div>
        </div>

      </div>
    </div>
  `
});
