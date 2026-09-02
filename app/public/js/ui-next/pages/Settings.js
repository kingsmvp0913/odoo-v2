(function () {
  window.UiNextSettingsView = Vue.defineComponent({
    name: "UiNextSettingsView",
    components: { UiNextIcon: window.UiNextIcon },
    data() { return { me: { username: "", display_name: "" }, teamsUserId: "", savedSettings: {}, creds: { odoo_username: "", odoo_password: "", odoo_user_id: "", service_username: "", service_password: "", service_user_id: "" }, pwSet: { odoo: false, service: false }, pw: { current: "", next: "", confirm: "" }, pwError: "", loading: true, loadError: "", saving: false, savingPw: false, verifyingOdoo: false, verifyingService: false, isDark: window.ThemeManager?.current() === "dark", notifyOn: window.NotifyManager?.isOn(), githubPat: { input: "", configured: false, login: "", saving: false } }; },
    computed: { patLink() { return "https://github.com/settings/tokens/new?scopes=repo&description=aidev-platform"; }, pwValidation() { if (!this.pw.current) return "請輸入目前密碼"; if (this.pw.next.length < 8) return "新密碼至少 8 個字元"; return this.pw.next === this.pw.confirm ? "" : "兩次輸入的新密碼不一致"; } },
    async created() { await this.load(); },
    mounted() { this._onThemeChange = (event) => { this.isDark = event.detail === "dark"; }; window.addEventListener("themechange", this._onThemeChange); },
    unmounted() { window.removeEventListener("themechange", this._onThemeChange); },
    methods: {
      toggleTheme() { window.ThemeManager?.toggle(); },
      async toggleNotify(event) { if (event.target.checked) { const result = await window.NotifyManager?.enable(); this.notifyOn = !!result?.ok; if (!this.notifyOn) showToast(result?.reason === "denied" ? "瀏覽器已封鎖通知權限" : "此瀏覽器不支援通知", "error", 0); } else { window.NotifyManager?.disable(); this.notifyOn = false; } },
      async load() { this.loading = true; this.loadError = ""; try { const [me, settings, pat] = await Promise.all([Api.get("auth/me"), Api.get("settings"), Api.get("settings/github-pat")]); this.me = { username: me.username || "", display_name: me.display_name || "" }; const saved = settings.odoo_settings || {}; this.savedSettings = saved; this.teamsUserId = saved.teams_user_id || ""; Object.assign(this.creds, { odoo_username: saved.odoo_username || "", odoo_user_id: saved.odoo_user_id || "", odoo_password: "", service_username: saved.service_username || "", service_user_id: saved.service_user_id || "", service_password: "" }); this.pwSet = { odoo: !!saved.odoo_password_set, service: !!saved.service_password_set }; this.githubPat.configured = !!pat.configured; this.githubPat.login = pat.login || ""; } catch (error) { this.loadError = error.message || "無法載入設定"; showToast(this.loadError, "error", 0); } finally { this.loading = false; } },
      async save() { this.saving = true; try { const odoo_settings = { ...this.savedSettings, teams_user_id: this.teamsUserId, ...this.creds, theme: window.ThemeManager?.current() }; await Promise.all([Api.put("auth/me", { display_name: this.me.display_name }), Api.put("settings", { odoo_settings })]); showToast("設定已儲存", "success"); } catch (error) { showToast(error.message || "儲存設定失敗", "error", 0); } finally { this.saving = false; } },
      async savePw() { this.pwError = this.pwValidation; if (this.pwError) return; this.savingPw = true; try { await Api.put("auth/me", { current_password: this.pw.current, new_password: this.pw.next }); this.pw = { current: "", next: "", confirm: "" }; showToast("密碼已更新", "success"); } catch (error) { showToast(error.message || "密碼更新失敗", "error", 0); } finally { this.savingPw = false; } },
      async verifyOdoo() { if (!this.creds.odoo_username || (!this.creds.odoo_password && !this.pwSet.odoo)) return showToast("請先填寫 Odoo 帳號和密碼", "error"); this.verifyingOdoo = true; try { const { uid } = await Api.post("settings/verify-odoo", { odoo_username: this.creds.odoo_username, odoo_password: this.creds.odoo_password }); this.creds.odoo_user_id = String(uid); showToast(`驗證成功，使用者 ID：${uid}`, "success"); } catch (error) { showToast(error.message || "驗證失敗", "error", 0); } finally { this.verifyingOdoo = false; } },
      async verifyService() { if (!this.creds.service_username || (!this.creds.service_password && !this.pwSet.service)) return showToast("請先填寫 eService 帳號和密碼", "error"); this.verifyingService = true; try { const { uid } = await Api.post("settings/verify-service", { service_username: this.creds.service_username, service_password: this.creds.service_password }); this.creds.service_user_id = String(uid); showToast(`驗證成功，使用者 ID：${uid}`, "success"); } catch (error) { showToast(error.message || "驗證失敗", "error", 0); } finally { this.verifyingService = false; } },
      // NotifyManager.show() 在權限未授權時是靜默 no-op，所以直接呼叫它等於「按了沒反應」。
      // 三個擋下的原因各自要能被使用者看見並知道怎麼解，否則使用者只會回報「通知壞了」。
      testNotify() { const perm = window.Notification ? Notification.permission : "unsupported"; if (perm === "denied") return showToast("瀏覽器已封鎖此網站的通知，請至瀏覽器設定 → 網站通知 → 解除封鎖後重新整理", "error", 8000); if (perm === "default") return showToast("尚未授權通知，請先開啟通知開關", "error", 6000); if (!window.NotifyManager?.enabled()) return showToast("通知未啟用（localStorage 已停用）", "error", 6000); window.NotifyManager.show("測試通知", "桌面通知運作正常 ✓", "test"); showToast("測試通知已發送", "success"); },
      async saveGithubPat() { if (!this.githubPat.input.trim()) return showToast("請貼上 PAT", "error"); this.githubPat.saving = true; try { const result = await Api.post("settings/github-pat", { pat: this.githubPat.input.trim() }); this.githubPat.configured = true; this.githubPat.login = result.login; this.githubPat.input = ""; showToast(`已連結 GitHub 帳號 ${result.login}`, "success"); } catch (error) { showToast(error.message || "PAT 驗證失敗", "error", 0); } finally { this.githubPat.saving = false; } },
      async removeGithubPat() { if (!await confirmDialog({ title: "移除 GitHub PAT", message: "移除後你的任務將無法 push，直到重新設定。", danger: true, confirmText: "移除" })) return; try { await Api.delete("settings/github-pat"); this.githubPat.configured = false; this.githubPat.login = ""; showToast("已移除 GitHub PAT", "success"); } catch (error) { showToast(error.message || "移除失敗", "error", 0); } },
    },
    template: `
      <section class="ui-next-page ui-next-settings-page">
<header class="ui-next-page-head">
<div>
<p class="ui-next-eyebrow">帳號與設定</p>
<h1>個人設定</h1>
<p>管理帳號、通知、GitHub 與外部系統連線。</p>
</div>
</header>
<div v-if="loading" class="ui-next-loading-card">載入設定中…</div>
<div v-else-if="loadError" class="ui-next-loading-card ui-next-error-text">{{ loadError }} <button type="button" @click="load">重試</button></div>
<div v-else class="ui-next-settings-grid">
<section class="ui-next-panel">
<h2>外觀與通知</h2>
<label class="ui-next-toggle" data-tour="set-dark">
<input type="checkbox" :checked="isDark" @change="toggleTheme">
<span>
</span>深色模式</label>
<label class="ui-next-toggle" data-tour="set-notify">
<input type="checkbox" :checked="notifyOn" @change="toggleNotify">
<span>
</span>桌面通知（有任務需要你處理時提醒）</label>
<button v-if="notifyOn" @click="testNotify"><ui-next-icon name="alert"/> 測試通知</button>
<p>開啟後瀏覽器會請求通知權限；需保持至少一個分頁開著才能收到。</p>
</section>
<section class="ui-next-panel">
<h2>帳號資料</h2>
<label>帳號<input :value="me.username" disabled>
</label>
<label>顯示名稱<input v-model="me.display_name" placeholder="你的名字">
</label>
<button class="ui-next-primary" @click="save" :disabled="saving">{{ saving?'儲存中…':'儲存帳號設定' }}</button>
</section>
<section class="ui-next-panel">
<h2>變更密碼</h2>
<label>目前密碼<input v-model="pw.current" type="password">
</label>
<label>新密碼<input v-model="pw.next" type="password" placeholder="至少 8 個字元" :class="{'is-invalid':pw.next&&pw.next.length<8}">
</label>
<label>確認新密碼<input v-model="pw.confirm" type="password" :class="{'is-invalid':pw.confirm&&pw.next!==pw.confirm}">
</label>
<p v-if="pwError" class="ui-next-error-text">{{ pwError }}</p>
<button @click="savePw" :disabled="savingPw">{{ savingPw?'更新中…':'更新密碼' }}</button>
</section>
<section class="ui-next-panel" data-tour="set-github">
<h2>GitHub 認證</h2>
<p>個人 GitHub Personal Access Token，供你的任務推送程式碼使用。</p>
<p v-if="githubPat.configured">已連結：<b>{{ githubPat.login }}</b></p>
<p v-else class="ui-next-error-text">尚未設定個人 GitHub PAT——你的任務將被擋下，請先設定。</p>
<!-- 輸入框與儲存鈕不能藏在 v-else 裡：token 會過期，已連結狀態下換 token 是常態操作，
     藏起來等於逼使用者先「移除連結」把自己鎖在門外再重設。 -->
<input v-model="githubPat.input" type="password" :placeholder="githubPat.configured?'貼上新的 Personal Access Token 以更換':'貼上 GitHub Personal Access Token'">
<div class="ui-next-help-box">
<b>如何取得 PAT：</b>
<ol>
<li>GitHub → 右上頭像 → <b>Settings</b> → 左側最底 <b>Developer settings</b></li>
<li><b>Personal access tokens → Tokens (classic) → Generate new token (classic)</b></li>
<li><b>Scopes</b> 勾 <code>repo</code>；<b>Expiration</b> 建議 90 天以上</li>
<li>按 <b>Generate token</b>，複製那串 <code>ghp_…</code>（<b>只會顯示一次</b>）</li>
</ol>
<a :href="patLink" target="_blank" rel="noopener">↗ 開啟 GitHub 建立權杖頁（已預帶 repo 權限與名稱）</a>
<p>需對目標 org repo 有 read/write 權限；若 org 開啟 SAML SSO，建立後請在 GitHub「Authorize」此 token。</p>
</div>
<div class="ui-next-inline-actions">
<button class="ui-next-primary" @click="saveGithubPat" :disabled="githubPat.saving">{{ githubPat.saving?'驗證中…':(githubPat.configured?'更新 PAT':'連結 GitHub') }}</button>
<button v-if="githubPat.configured" class="danger" @click="removeGithubPat">移除連結</button>
</div>
</section>
<section class="ui-next-panel ui-next-settings-wide">
<h2>外部系統連線</h2>
<div class="ui-next-settings-connection">
<div data-tour="set-odoo">
<h3>Odoo</h3>
<p>Odoo 伺服器位址由管理員統一設定，此處填寫你的個人登入憑證。</p>
<label>帳號<input v-model="creds.odoo_username" placeholder="admin">
</label>
<label>密碼<input v-model="creds.odoo_password" type="password" :placeholder="pwSet.odoo?'已設定，留空不變更':'輸入密碼'">
</label>
<!-- 使用者 ID 沒有輸入框時，verifyOdoo 寫進來的值與 save() 送出去的值都是看不見也改不掉的。 -->
<label>使用者 ID<input v-model="creds.odoo_user_id" placeholder="點擊驗證自動取得">
</label>
<p class="ui-next-field-note">任務負責人篩選會用到；按下驗證會自動填入。</p>
<button @click="verifyOdoo" :disabled="verifyingOdoo">{{ verifyingOdoo?'驗證中…':'驗證 Odoo' }}</button>
</div>
<div data-tour="set-eservice">
<h3>eService</h3>
<p>eService 伺服器位址由管理員統一設定，此處填寫你的個人登入憑證。</p>
<label>帳號<input v-model="creds.service_username" placeholder="admin">
</label>
<label>密碼<input v-model="creds.service_password" type="password" :placeholder="pwSet.service?'已設定，留空不變更':'輸入密碼'">
</label>
<label>使用者 ID<input v-model="creds.service_user_id" placeholder="點擊驗證自動取得">
</label>
<p class="ui-next-field-note">任務負責人篩選會用到；按下驗證會自動填入。</p>
<button @click="verifyService" :disabled="verifyingService">{{ verifyingService?'驗證中…':'驗證 eService' }}</button>
</div>
</div>
<button class="ui-next-primary" @click="save" :disabled="saving">{{ saving?'儲存中…':'儲存連線設定' }}</button>
</section>
<section class="ui-next-panel">
<h2>Teams 通知</h2>
<p>填寫你的 Azure AD 物件識別碼，任務通知時系統會以你的顯示名稱 @mention。</p>
<label>Teams 使用者 ID（AAD Object ID）<input v-model="teamsUserId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">
</label>
<p class="ui-next-field-note">Azure AD → 使用者 → 物件識別碼</p>
<button class="ui-next-primary" @click="save" :disabled="saving">{{ saving?'儲存中…':'儲存' }}</button>
</section>
</div>
</section>`,
  });

})();
