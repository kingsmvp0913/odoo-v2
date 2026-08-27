const { createApp, defineComponent, ref, onMounted } = Vue;
const { createRouter, createWebHashHistory } = VueRouter;

const toasts = ref([]);
// id 同時是 v-for 的 :key 與「時間到移除自己」那段 filter 的依據，必須逐則唯一。
// 原本取 Date.now()：同一輪同步程式碼連發的多則會拿到相同毫秒值，先到期的那則會把同 id 的
// 其他則一起濾掉——訊息互相吃掉且不報錯（socket 事件批次抵達時就是這個情境）。
let _toastSeq = 0;
function showToast(message, level = 'info', duration = 4000) {
  const id = ++_toastSeq;
  toasts.value.push({ id, message, level });
  setTimeout(() => { toasts.value = toasts.value.filter(t => t.id !== id); }, duration);
}
window.showToast = showToast;

const needsActionCount = ref(0);
window.needsActionCount = needsActionCount;

// 收件匣未讀數。與 needsActionCount 是兩回事：後者是「現在有幾張等你」的狀態快照，
// 這個是「還沒看過的事件」筆數（含已經走掉的退回事件）。socket 收到 action 通知時 +1，
// 進收件匣頁時以後端實際筆數校正。
// 走專用 COUNT 端點而不是「抓清單算 length」：清單有 LIMIT 100，未讀破百後 badge 會靜默封頂在
// 100，樂觀 +1 又把它推過 100 → 數字在 100 與 100+n 之間來回跳。
const inboxUnread = ref(0);
window.inboxUnread = inboxUnread;
async function loadInboxUnread() {
  if (!Api.isLoggedIn || !Api.isLoggedIn()) return;
  try { inboxUnread.value = ((await Api.get('inbox/unread-count')) || {}).count || 0; } catch (e) { /* 靜默：badge 不是關鍵路徑 */ }
}
window.loadInboxUnread = loadInboxUnread;

const claudeUsage = ref(null);
const codexUsage = ref(null);
async function loadClaudeUsage() {
  if (!Api.isLoggedIn()) return;
  // 用量僅管理員可見；非 admin 不打（避免 403 噪音）
  if (window.UserStore.role !== 'admin') return;
  try { claudeUsage.value = await Api.get('claude-usage'); } catch { /* keep stale */ }
}
window.loadClaudeUsage = loadClaudeUsage;
async function loadCodexUsage() {
  if (window.UserStore.role !== 'admin') return;
  try { codexUsage.value = await Api.get('codex-usage'); } catch { /* keep stale */ }
}
window.loadCodexUsage = loadCodexUsage;

// 登入後即抓一次跨專案未讀，填入 UnreadStore → 左側 menu 專案 badge 首屏就準確；
// 之後靠 socket chat:reply 遞增、ProjectChat 標記已讀清零維持即時。
async function loadUnread() {
  if (!Api.isLoggedIn()) return;
  try {
    const { byProject } = await Api.get('chats/unread');
    window.UnreadStore.byProject = byProject || {};
  } catch { /* keep stale */ }
}
window.loadUnread = loadUnread;

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: window.LoginView },
    { path: '/', component: window.TaskListView, meta: { requiresAuth: true } },
    { path: '/task/:id', component: window.TaskDetailView, meta: { requiresAuth: true } },
    { path: '/inbox', component: window.InboxView, meta: { requiresAuth: true } },
    { path: '/task/:id/terminal', component: window.TerminalView, meta: { requiresAuth: true } },
    { path: '/projects', component: window.ProjectListView, meta: { requiresAuth: true } },
    { path: '/projects/:id', component: window.ProjectDetailView, meta: { requiresAuth: true } },
    { path: '/projects/:id/wiki', component: window.WikiView, meta: { requiresAuth: true } },
    { path: '/projects/:id/wiki/:slug', component: window.WikiView, meta: { requiresAuth: true } },
    { path: '/projects/:id/chat', component: window.ProjectChatView, meta: { requiresAuth: true } },
    { path: '/projects/:id/chat/:chatId', component: window.ProjectChatView, meta: { requiresAuth: true } },
    { path: '/projects/:id/db', component: window.ProjectDbQueryView, meta: { requiresAuth: true } },
    { path: '/projects/:id/deploy-sop', component: window.DeploySopView, meta: { requiresAuth: true } },
    { path: '/token-report', component: window.TokenReportView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/settings', component: window.SettingsView, meta: { requiresAuth: true } },
    { path: '/architecture', component: window.ArchitectureView, meta: { requiresAuth: true } },
    { path: '/pipeline-flow', component: window.PipelineFlowView, meta: { requiresAuth: true } },
    { path: '/admin', component: window.AdminView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/admin/users', component: window.AdminUsersView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/admin/agents', component: window.AdminAgentsView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/admin/schedules', component: window.AdminSchedulesView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/admin/pipelines', component: window.AdminPipelinesView, meta: { requiresAuth: true } },
    { path: '/admin/health', component: window.AdminHealthCheckView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/admin/rejections', component: window.AdminRejectionsView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/admin/classify-samples', component: window.AdminClassifySamplesView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/admin/prompt-logs', component: window.AdminPromptLogsView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/admin/port-pool', component: window.AdminPortPoolView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/admin/enterprise', component: window.AdminEnterpriseView, meta: { requiresAuth: true, requiresAdmin: true } },
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
    // 每次導覽刷新角色（登入後第一次導覽即設好 role）→ 再依角色載入用量小工具
    Api.get('auth/me').then(me => {
      window.UserStore.role = me.role || '';
      // 深色偏好也在此同步：表單登入只走 afterEach（不經 mounted 的已登入分支），
      // 漏了會讓無痕登入永遠停在預設淺色（localStorage 空、又沒讀 DB 偏好）。
      ThemeManager.syncFromServer(me.odoo_settings && me.odoo_settings.theme);
      SocketManager.initSocket(me.id);
      loadClaudeUsage();
      loadCodexUsage();
      loadUnread();
      loadInboxUnread();
    }).catch(() => {});
  }
  if (to.path === '/login') { SocketManager.disconnectSocket(); window.UserStore.role = ''; }
});

// 與 lib/claude-usage.js 的 CACHE_TTL_MS 對齊：原本 60s 輪詢配 60s TTL＝每次都 miss，
// 等於 24/7 每分鐘打一次限流很兇的 /api/oauth/usage，配額燒光後畫面反而長時間卡在 stale。
setInterval(loadClaudeUsage, 10 * 60 * 1000);
setInterval(loadCodexUsage, 10 * 60 * 1000);

const App = defineComponent({
  name: 'App',
  setup() { return { toasts, needsActionCount, inboxUnread, claudeUsage, codexUsage }; },
  data() { return { _role: '', drawerOpen: false, isDark: (window.ThemeManager && ThemeManager.current() === 'dark') }; },
  watch: {
    // 點了 drawer 裡的連結後，頁面換了但遮罩與側欄還蓋在上面，看起來像卡住 → 導覽即關。
    '$route'() { this.drawerOpen = false; }
  },
  computed: {
    isLoggedIn() { return Api.authState.loggedIn; },
    // 角色以 reactive 的 UserStore 為單一來源：每次導覽（含剛登入）由 afterEach 更新，
    // 不再只靠 mounted 一次性載入 → 表單登入後 isAdmin 立即正確，免重新整理
    isAdmin() { return window.UserStore.role === 'admin'; },
    usageBars() {
      const u = this.claudeUsage;
      if (!u || !u.available) return [];
      const rows = [];
      const add = (key, label, w) => {
        if (!w || w.utilization == null) return;
        const pct = Math.round(w.utilization);
        rows.push({
          key, label, pct,
          level: pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok',
          reset: w.resets_at ? this.fmtReset(w.resets_at) : ''
        });
      };
      add('5h', '5 小時', u.five_hour);
      add('7d', '本週', u.seven_day);
      add('opus', 'Opus 週', u.seven_day_opus);
      add('sonnet', 'Sonnet 週', u.seven_day_sonnet);
      return rows;
    },
    usageStale() { return !!(this.claudeUsage && this.claudeUsage.stale); },
    usageUpdatedLabel() {
      const iso = this.claudeUsage && this.claudeUsage.updated_at;
      return iso ? this.fmtReset(iso) : '';
    },
    codexUsageRows() {
      const u = this.codexUsage;
      if (!u || !u.available) return [];
      const rows = [];
      const add = (key, label, window) => {
        if (!window) return;
        rows.push({ key, label, pct: Math.round(window.used_percent), remaining: Math.round(window.remaining_percent),
          level: window.used_percent >= 90 ? 'crit' : window.used_percent >= 70 ? 'warn' : 'ok',
          reset: window.resets_at ? this.fmtReset(window.resets_at) : '' });
      };
      add('primary', '主要額度', u.primary);
      add('secondary', '週額度', u.secondary);
      return rows;
    },
    tourRemaining() { return window.TourManager ? TourManager.remainingCount() : 0; },
    projectUnreadTotal() {
      return Object.values(window.UnreadStore.byProject).reduce((a, b) => a + (b || 0), 0);
    },
  },
  async mounted() {
    this._onThemeChange = e => { this.isDark = e.detail === 'dark'; };
    window.addEventListener('themechange', this._onThemeChange);
    this._onKeydown = e => { if (e.key === 'Escape') this.drawerOpen = false; };
    window.addEventListener('keydown', this._onKeydown);
    if (Api.isLoggedIn()) {
      const me = await Api.get('auth/me').catch(() => ({}));
      this._role = me.role || '';
      window.UserStore.role = me.role || '';
      ThemeManager.syncFromServer(me.odoo_settings && me.odoo_settings.theme);
      this.isDark = ThemeManager.current() === 'dark';
      loadClaudeUsage();
      loadCodexUsage();
      loadUnread();
    }
  },
  unmounted() {
    window.removeEventListener('themechange', this._onThemeChange);
    window.removeEventListener('keydown', this._onKeydown);
  },
  methods: {
    fmtReset(iso) {
      return new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    },
    toggleTheme() { ThemeManager.toggle(); },
    logout() { Api.clearToken(); window.UserStore.role = ''; SocketManager.disconnectSocket(); this.$router.push('/login'); },
    openTour() { TourManager.open(); }
  },
  template: `
    <template v-if="!isLoggedIn || $route.path === '/login'">
      <router-view />
    </template>
    <template v-else>
      <div class="app-shell">
        <header class="mobile-topbar">
          <button class="drawer-toggle" type="button" @click="drawerOpen = true" aria-label="開啟選單"><span class="drawer-toggle-bars"></span></button>
          <span class="mobile-topbar-title">AI Dev 工作台</span>
        </header>
        <div v-if="drawerOpen" class="drawer-overlay" @click="drawerOpen = false"></div>
        <aside class="sidebar" :class="{ 'is-open': drawerOpen }">
          <div class="sidebar-header">
            <div>AI Dev<span>工作台</span></div>
            <button @click="toggleTheme" :title="isDark ? '切換淺色模式' : '切換深色模式'"
              style="margin-left:auto;background:transparent;border:none;color:var(--sidebar-text);cursor:pointer;font-size:16px;padding:2px 4px;line-height:1">
              {{ isDark ? '☀️' : '🌙' }}
            </button>
          </div>
          <nav>
            <router-link to="/" custom v-slot="{ navigate, isActive }">
              <a data-tour="nav-tasks" :class="{ active: isActive }" @click="navigate">
                📋 任務列表
                <span v-if="needsActionCount > 0" class="badge">{{ needsActionCount }}</span>
              </a>
            </router-link>
            <!-- 收件匣路由保留供既有連結使用，暫不放在日常導覽。 -->
            <router-link to="/projects" custom v-slot="{ navigate, isActive }">
              <a data-tour="nav-projects" :class="{ active: isActive }" @click="navigate">
                📁 專案
                <span v-if="projectUnreadTotal > 0" class="badge">{{ projectUnreadTotal }}</span>
              </a>
            </router-link>
            <router-link to="/admin/pipelines" custom v-slot="{ navigate, isActive }">
              <a data-tour="nav-pipeline" :class="{ active: isActive }" @click="navigate">🚦 進行中 Pipeline</a>
            </router-link>
            <router-link v-if="isAdmin" to="/token-report" custom v-slot="{ navigate, isActive }">
              <a :class="{ active: isActive }" @click="navigate">📊 用量報表</a>
            </router-link>
            <router-link to="/settings" custom v-slot="{ navigate, isActive }">
              <a data-tour="nav-settings" :class="{ active: isActive }" @click="navigate">⚙️ 設定</a>
            </router-link>
            <router-link v-if="isAdmin" to="/admin" custom v-slot="{ navigate, isActive }">
              <a :class="{ active: isActive }" @click="navigate">🔧 管理員</a>
            </router-link>
            <!-- 地景圖與流程圖是「查資料」的兩頁，不是日常操作，故排在所有操作項目之後 -->
            <router-link to="/architecture" custom v-slot="{ navigate, isActive }">
              <a :class="{ active: isActive }" @click="navigate">🏗️ 架構圖</a>
            </router-link>
            <router-link to="/pipeline-flow" custom v-slot="{ navigate, isActive }">
              <a :class="{ active: isActive }" @click="navigate">🗺️ 流程圖</a>
            </router-link>
          </nav>
          <div class="sidebar-footer">
            <div v-if="isAdmin && usageBars.length" class="usage-mini" @click="$router.push('/token-report')" title="檢視用量報表">
              <div class="usage-title">
                <span class="usage-provider-logo claude" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="currentColor"><path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"></path></svg></span>
                <span>Claude 用量</span>
              </div>
              <div v-if="usageStale && usageUpdatedLabel" class="usage-stale">最後更新 {{ usageUpdatedLabel }}</div>
              <div v-for="bar in usageBars" :key="bar.key" class="usage-row">
                <div class="usage-row-top">
                  <span>{{ bar.label }}</span>
                  <span>{{ bar.pct }}%</span>
                </div>
                <div class="usage-track">
                  <div class="usage-fill" :class="bar.level" :style="{ width: bar.pct + '%' }"></div>
                </div>
                <div v-if="bar.reset" class="usage-reset">重置 {{ bar.reset }}</div>
              </div>
            </div>
            <div v-if="isAdmin && codexUsageRows.length" class="usage-mini" @click="$router.push('/token-report')" title="檢視用量報表">
              <div class="usage-title"><span class="usage-provider-logo codex" aria-hidden="true"><img src="https://images.ctfassets.net/kftzwdyauwt9/77tJ5U1tgxHMZflZ5m4Z24/ace4d8b6ad200d87ebcb69c466344343/Blossom_4k_Icon_1.png?w=1920&amp;q=90&amp;fm=webp" alt="" /></span><span>Codex 用量</span></div>
              <div v-for="row in codexUsageRows" :key="row.key" class="usage-row">
                <div class="usage-row-top"><span>{{ row.label }}</span><span>剩 {{ row.remaining }}%</span></div>
                <div class="usage-track"><div class="usage-fill" :class="row.level" :style="{ width: row.pct + '%' }"></div></div>
                <div v-if="row.reset" class="usage-reset">重置 {{ row.reset }}</div>
              </div>
            </div>
            <div class="sidebar-footer-actions">
              <button class="tour-launch" type="button" @click="openTour" title="開啟新手教學">
                🎓 新手教學<span v-if="tourRemaining" class="tour-launch-badge">{{ tourRemaining }}</span>
              </button>
              <a @click="logout" style="cursor:pointer">登出</a>
            </div>
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
    <confirm-dialog-host />
    <tour-host />
  `
});

const app = createApp(App);
app.component('ConfirmDialogHost', window.ConfirmDialogHost);
app.component('Skeleton', window.Skeleton);
app.component('ReleaseModal', window.ReleaseModal);
app.component('TourHost', window.TourHost);
app.use(router);
app.mount('#app');
