window.LoginView = Vue.defineComponent({
  name: 'LoginView',
  data() {
    return {
      mode: 'login',
      form: { username: '', password: '', display_name: '' },
      loading: false,
      error: ''
    };
  },
  async created() {
    const status = await Api.checkSetup().catch(() => ({ setup_done: false }));
    if (!status.setup_done) this.mode = 'setup';
  },
  methods: {
    async submit() {
      this.loading = true;
      this.error = '';
      try {
        const endpoint = this.mode === 'setup' ? 'auth/setup' : 'auth/login';
        const payload = this.mode === 'setup'
          ? { username: this.form.username, password: this.form.password, display_name: this.form.display_name }
          : { username: this.form.username, password: this.form.password };
        const res = await Api.post(endpoint, payload);
        Api.setToken(res.token);
        this.$router.push('/');
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    }
  },
  template: `
    <div class="login-wrap">
      <div class="login-box">
        <div class="login-title">AI Dev</div>
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
      </div>
    </div>
  `
});
