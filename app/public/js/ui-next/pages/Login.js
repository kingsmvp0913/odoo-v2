(function () {
  window.UiNextLoginView = Vue.defineComponent({
    name: "UiNextLoginView",
    data() {
      return {
        mode: "login",
        step: 1,
        form: { username: "", password: "", displayName: "" },
        credentials: {
          odooUsername: "",
          odooPassword: "",
          odooUserId: "",
          serviceUsername: "",
          servicePassword: "",
          serviceUserId: "",
        },
        git: { pat: "", login: "", pending: false, configured: false },
        odoo: { pending: false, configured: false },
        service: { pending: false, configured: false },
        notification: { supported: !!(window.NotifyManager && NotifyManager.supported), configured: false },
        loading: false,
        error: "",
      };
    },
    computed: {
      steps() {
        return ["建立帳號", "Git 認證", "Odoo 帳密", "eService 帳密", "桌面通知", "完成"];
      },
      patLink() {
        return "https://github.com/settings/tokens/new?scopes=repo&description=aidev-platform";
      },
    },
    async created() {
      const status = await Api.checkSetup().catch(() => ({ setup_done: false }));
      if (!status.setup_done) this.mode = "setup";
    },
    methods: {
      resetError() {
        this.error = "";
      },
      async submitLogin() {
        this.loading = true;
        this.resetError();
        try {
          const endpoint = this.mode === "setup" ? "auth/setup" : "auth/login";
          const payload = this.mode === "setup"
            ? { username: this.form.username, password: this.form.password, display_name: this.form.displayName }
            : { username: this.form.username, password: this.form.password };
          const result = await Api.post(endpoint, payload);
          Api.setToken(result.token);
          const redirect = this.$route.query.redirect;
          this.$router.push(typeof redirect === "string" && redirect.startsWith("/") ? redirect : "/");
        } catch (error) {
          this.error = error.message || "無法登入，請確認帳號與密碼。";
        } finally {
          this.loading = false;
        }
      },
      startRegister() {
        this.mode = "register";
        this.step = 1;
        this.resetError();
      },
      backToLogin() {
        Api.clearToken();
        this.mode = "login";
        this.step = 1;
        this.resetError();
      },
      async registerAccount() {
        if (!this.form.username || !this.form.password || !this.form.displayName) {
          this.error = "請填寫顯示名稱、帳號與密碼。";
          return;
        }
        if (this.form.password.length < 8) {
          this.error = "密碼至少需要 8 個字元。";
          return;
        }
        this.loading = true;
        this.resetError();
        try {
          const result = await Api.post("auth/register", {
            username: this.form.username,
            password: this.form.password,
            display_name: this.form.displayName,
          });
          Api.setToken(result.token);
          this.step = 2;
        } catch (error) {
          this.error = error.message || "無法建立帳號。";
        } finally {
          this.loading = false;
        }
      },
      async verifyGit() {
        if (!this.git.pat.trim()) {
          this.error = "請貼上 GitHub PAT。";
          return;
        }
        this.git.pending = true;
        this.resetError();
        try {
          const result = await Api.post("settings/github-pat", { pat: this.git.pat.trim() });
          this.git.login = result.login || "已連結帳號";
          this.git.pat = "";
          this.git.configured = true;
        } catch (error) {
          this.error = error.message || "PAT 驗證失敗。";
        } finally {
          this.git.pending = false;
        }
      },
      async verifyOdoo() {
        if (!this.credentials.odooUsername || !this.credentials.odooPassword) {
          this.error = "請填寫 Odoo 帳號和密碼。";
          return;
        }
        this.odoo.pending = true;
        this.resetError();
        try {
          const result = await Api.post("settings/verify-odoo", {
            odoo_username: this.credentials.odooUsername,
            odoo_password: this.credentials.odooPassword,
          });
          this.credentials.odooUserId = String(result.uid);
          await this.saveCredentials();
          this.credentials.odooPassword = "";
          this.odoo.configured = true;
          this.step = 4;
        } catch (error) {
          this.error = error.message || "Odoo 帳密驗證失敗。";
        } finally {
          this.odoo.pending = false;
        }
      },
      async verifyService() {
        if (!this.credentials.serviceUsername || !this.credentials.servicePassword) {
          this.error = "請填寫 eService 帳號和密碼。";
          return;
        }
        this.service.pending = true;
        this.resetError();
        try {
          const result = await Api.post("settings/verify-service", {
            service_username: this.credentials.serviceUsername,
            service_password: this.credentials.servicePassword,
          });
          this.credentials.serviceUserId = String(result.uid);
          await this.saveCredentials();
          this.credentials.servicePassword = "";
          this.service.configured = true;
          this.step = 5;
        } catch (error) {
          this.error = error.message || "eService 帳密驗證失敗。";
        } finally {
          this.service.pending = false;
        }
      },
      async saveCredentials() {
        await Api.put("settings", {
          odoo_settings: {
            odoo_username: this.credentials.odooUsername,
            odoo_password: this.credentials.odooPassword,
            odoo_user_id: this.credentials.odooUserId,
            service_username: this.credentials.serviceUsername,
            service_password: this.credentials.servicePassword,
            service_user_id: this.credentials.serviceUserId,
          },
        });
      },
      async enableNotification() {
        this.resetError();
        try {
          const result = await NotifyManager.enable();
          this.notification.configured = !!(result && result.ok);
          if (this.notification.configured) this.step = 6;
          else this.error = "瀏覽器未授權通知；你可稍後在設定頁開啟。";
        } catch {
          this.error = "無法開啟通知；你可略過並稍後設定。";
        }
      },
      goStep(step) {
        this.step = step;
        this.resetError();
      },
    },
    template: `
      <main class="ui-next-login" data-ui="next" aria-labelledby="ui-next-login-title">
        <section class="ui-next-login-card" :aria-busy="loading">
          <header>
            <img src="favicon.svg" alt="OAA">
            <p>Odoo AI 自動開發平台</p>
            <h1 id="ui-next-login-title">{{ mode === 'setup' ? '建立管理帳號' : mode === 'register' ? '註冊帳號' : '登入工作台' }}</h1>
          </header>
          <p v-if="error" class="ui-next-login-error" role="alert">{{ error }}</p>

          <form v-if="mode !== 'register'" @submit.prevent="submitLogin">
            <label v-if="mode === 'setup'">顯示名稱<input v-model.trim="form.displayName" required autocomplete="name"></label>
            <label>帳號<input v-model.trim="form.username" required autocomplete="username"></label>
            <label>密碼<input v-model="form.password" type="password" required autocomplete="current-password"></label>
            <button class="ui-next-primary" type="submit" :disabled="loading">{{ loading ? '處理中…' : mode === 'setup' ? '建立帳號' : '登入' }}</button>
          </form>

          <template v-else>
            <ol class="ui-next-register-steps" aria-label="註冊步驟">
              <li v-for="(label, index) in steps" :key="label" :class="{ active: step === index + 1, done: step > index + 1 }">{{ index + 1 }}. {{ label }}</li>
            </ol>
            <section v-if="step === 1" class="ui-next-register-panel">
              <label>顯示名稱<input v-model.trim="form.displayName" autocomplete="name"></label>
              <label>帳號<input v-model.trim="form.username" autocomplete="username"></label>
              <label>密碼<input v-model="form.password" type="password" autocomplete="new-password" aria-describedby="register-password-help"></label>
              <small id="register-password-help">密碼至少 8 個字元。</small>
              <button class="ui-next-primary" type="button" :disabled="loading" @click="registerAccount">{{ loading ? '建立中…' : '下一步' }}</button>
            </section>
            <section v-else-if="step === 2" class="ui-next-register-panel">
              <p>GitHub PAT 會加密保存，只用於你授權的 clone、commit 與 push 操作。</p>
              <a :href="patLink" target="_blank" rel="noopener noreferrer">建立 GitHub PAT（需要 repo 權限）</a>
              <p v-if="git.configured" class="ui-next-login-success">已連結 GitHub 帳號：{{ git.login }}</p>
              <label v-else>GitHub PAT<input v-model="git.pat" type="password" autocomplete="off"></label>
              <button v-if="!git.configured" class="ui-next-primary" type="button" :disabled="git.pending" @click="verifyGit">{{ git.pending ? '驗證中…' : '驗證並儲存' }}</button>
              <div class="ui-next-login-actions"><button type="button" @click="goStep(1)">上一步</button><button type="button" @click="goStep(3)">{{ git.configured ? '下一步' : '略過，稍後設定' }}</button></div>
            </section>
            <section v-else-if="step === 3" class="ui-next-register-panel">
              <p>平台會用這組帳密同步你負責的 Odoo 工單。</p>
              <label>Odoo 帳號<input v-model.trim="credentials.odooUsername" autocomplete="username"></label>
              <label>Odoo 密碼<input v-model="credentials.odooPassword" type="password" autocomplete="current-password"></label>
              <button class="ui-next-primary" type="button" :disabled="odoo.pending" @click="verifyOdoo">{{ odoo.pending ? '驗證中…' : '驗證並繼續' }}</button>
              <div class="ui-next-login-actions"><button type="button" @click="goStep(2)">上一步</button><button type="button" @click="goStep(4)">略過，稍後設定</button></div>
            </section>
            <section v-else-if="step === 4" class="ui-next-register-panel">
              <p>平台會用這組帳密同步你的 eService 客服工單。</p>
              <label>eService 帳號<input v-model.trim="credentials.serviceUsername" autocomplete="username"></label>
              <label>eService 密碼<input v-model="credentials.servicePassword" type="password" autocomplete="current-password"></label>
              <button class="ui-next-primary" type="button" :disabled="service.pending" @click="verifyService">{{ service.pending ? '驗證中…' : '驗證並繼續' }}</button>
              <div class="ui-next-login-actions"><button type="button" @click="goStep(3)">上一步</button><button type="button" @click="goStep(5)">略過，稍後設定</button></div>
            </section>
            <section v-else-if="step === 5" class="ui-next-register-panel">
              <p>開啟桌面通知後，任務需要處理時瀏覽器會即時提醒你。</p>
              <p v-if="!notification.supported" class="ui-next-login-error">此瀏覽器不支援桌面通知，可略過。</p>
              <p v-else-if="notification.configured" class="ui-next-login-success">桌面通知已開啟。</p>
              <button v-else class="ui-next-primary" type="button" @click="enableNotification">開啟桌面通知</button>
              <div class="ui-next-login-actions"><button type="button" @click="goStep(4)">上一步</button><button type="button" @click="goStep(6)">略過，完成</button></div>
            </section>
            <section v-else class="ui-next-register-panel">
              <h2>註冊完成</h2>
              <p>帳號已建立，等待管理員核准後即可登入。</p>
              <button class="ui-next-primary" type="button" @click="backToLogin">前往登入頁</button>
            </section>
            <button class="ui-next-login-link" type="button" @click="goStep(6)" v-if="step >= 2 && step <= 5">全部略過，稍後在設定頁完成</button>
          </template>

          <p v-if="mode === 'login'" class="ui-next-login-footer">還沒有帳號？<button class="ui-next-login-link" type="button" @click="startRegister">註冊新帳號</button></p>
          <button v-if="mode === 'register'" class="ui-next-login-link" type="button" @click="backToLogin">返回登入</button>
        </section>
      </main>
    `,
  });

})();
