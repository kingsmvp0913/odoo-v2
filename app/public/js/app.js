const { createApp, defineComponent, ref, onMounted } = Vue;
const { createRouter, createWebHashHistory } = VueRouter;

const toasts = ref([]);
function showToast(message, level = 'info', duration = 4000) {
  const id = Date.now();
  toasts.value.push({ id, message, level });
  setTimeout(() => { toasts.value = toasts.value.filter(t => t.id !== id); }, duration);
}
window.showToast = showToast;

const needsActionCount = ref(0);
window.needsActionCount = needsActionCount;

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: window.LoginView },
    { path: '/', component: window.TaskListView, meta: { requiresAuth: true } },
    { path: '/task/:id', component: window.TaskDetailView, meta: { requiresAuth: true } },
    { path: '/task/:id/terminal', component: window.TerminalView, meta: { requiresAuth: true } },
    { path: '/projects', component: window.ProjectListView, meta: { requiresAuth: true } },
    { path: '/projects/:id', component: window.ProjectDetailView, meta: { requiresAuth: true } },
    { path: '/projects/:id/wiki', component: window.WikiView, meta: { requiresAuth: true } },
    { path: '/projects/:id/wiki/:slug', component: window.WikiView, meta: { requiresAuth: true } },
    { path: '/projects/:id/chat', component: window.ProjectChatView, meta: { requiresAuth: true } },
    { path: '/projects/:id/chat/:chatId', component: window.ProjectChatView, meta: { requiresAuth: true } },
    { path: '/settings', component: window.SettingsView, meta: { requiresAuth: true } },
    { path: '/admin', component: window.AdminView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/admin/users', component: window.AdminUsersView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
});

router.beforeEach(async (to) => {
  if (to.meta.requiresAuth && !Api.isLoggedIn()) return '/login';
  if (to.path === '/login' && Api.isLoggedIn()) return '/';
  if (to.meta.requiresAdmin) {
    try {
      const me = await Api.get('auth/me');
      if (me.role !== 'admin') return '/';
    } catch { return '/login'; }
  }
});

router.afterEach((to) => {
  if (Api.isLoggedIn() && to.path !== '/login') {
    Api.get('auth/me').then(me => {
      SocketManager.initSocket(me.id);
    }).catch(() => {});
  }
  if (to.path === '/login') SocketManager.disconnectSocket();
});

const App = defineComponent({
  name: 'App',
  setup() { return { toasts, needsActionCount }; },
  data() { return { _role: '' }; },
  computed: {
    isLoggedIn() { return Api.isLoggedIn(); },
    isAdmin() { return this._role === 'admin'; }
  },
  async mounted() {
    if (Api.isLoggedIn()) {
      const me = await Api.get('auth/me').catch(() => ({}));
      this._role = me.role || '';
    }
  },
  methods: {
    logout() { Api.clearToken(); SocketManager.disconnectSocket(); this.$router.push('/login'); }
  },
  template: `
    <template v-if="!isLoggedIn || $route.path === '/login'">
      <router-view />
    </template>
    <template v-else>
      <div style="display:flex;height:100vh;flex:1;min-width:0">
        <aside class="sidebar">
          <div class="sidebar-header">AI Dev<span>工作台</span></div>
          <nav>
            <router-link to="/" custom v-slot="{ navigate, isActive }">
              <a :class="{ active: isActive }" @click="navigate">
                📋 任務列表
                <span v-if="needsActionCount > 0" class="badge">{{ needsActionCount }}</span>
              </a>
            </router-link>
            <router-link to="/projects" custom v-slot="{ navigate, isActive }">
              <a :class="{ active: isActive }" @click="navigate">📁 專案</a>
            </router-link>
            <router-link to="/settings" custom v-slot="{ navigate, isActive }">
              <a :class="{ active: isActive }" @click="navigate">⚙️ 設定</a>
            </router-link>
            <router-link v-if="isAdmin" to="/admin" custom v-slot="{ navigate, isActive }">
              <a :class="{ active: isActive }" @click="navigate">🔧 管理員</a>
            </router-link>
          </nav>
          <div class="sidebar-footer">
            <a @click="logout" style="cursor:pointer">登出</a>
          </div>
        </aside>
        <div class="main">
          <router-view />
        </div>
      </div>
    </template>
    <div class="toast-container">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.level">{{ t.message }}</div>
    </div>
  `
});

const app = createApp(App);
app.use(router);
app.mount('#app');
