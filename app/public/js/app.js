// defineComponent／onMounted 隨舊外殼（App）一起退役，這裡不再取用。
const { createApp, ref } = Vue;
const { createRouter, createWebHashHistory } = VueRouter;

const toasts = ref([]);
// id 同時是 v-for 的 :key 與「時間到移除自己」那段 filter 的依據，必須逐則唯一。
// 原本取 Date.now()：同一輪同步程式碼連發的多則會拿到相同毫秒值，先到期的那則會把同 id 的
// 其他則一起濾掉——訊息互相吃掉且不報錯（socket 事件批次抵達時就是這個情境）。
let _toastSeq = 0;
function dismissToast(id) {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
// duration <= 0 代表「這則要留久一點」——用在錯誤訊息上。
// 原本無條件 setTimeout(…, duration)，於是 showToast(msg, "error", 0) 會在 0ms 後立刻移除
// ——訊息等於沒出現過。ui-next 有 30 幾處錯誤路徑是這樣寫的（意圖正是「錯誤不要一閃即逝」，
// 見規格 §4.6），全部靜默失效：使用者只看到操作沒反應，看不到原因。
//
// 但「永遠不關」也不對：沒人按 × 的話錯誤訊息會一路疊在右下角擋住畫面，換頁也不會消。
// 改成 30 秒後自動收（足夠讀完並複製內容），期間照樣畫 × 讓使用者提早關掉。
const STICKY_TOAST_MS = 30000;
function showToast(message, level = "info", duration = 4000) {
  const id = ++_toastSeq;
  const sticky = !(duration > 0);
  toasts.value.push({ id, message, level, sticky });
  setTimeout(() => dismissToast(id), sticky ? STICKY_TOAST_MS : duration);
  return id;
}
window.showToast = showToast;
window.dismissToast = dismissToast;
// ui-next 也是同一個應用程式，只替換殼層；通知必須共用，否則舊 View 在新版會靜默失去回饋。
// 放在 showToast 導出之後而非 toasts 宣告處：frontend-toast-id.test.js 會把
// 「toasts 宣告 → window.showToast 導出」這一段切出來在 node 環境單獨 eval，
// 區間內出現 window 就會 ReferenceError。所有 window.* 導出集中在區間外。
window.appToasts = toasts;

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
  try {
    inboxUnread.value =
      ((await Api.get("inbox/unread-count")) || {}).count || 0;
  } catch (e) {
    /* 靜默：badge 不是關鍵路徑 */
  }
}
window.loadInboxUnread = loadInboxUnread;

const claudeUsage = ref(null);
const codexUsage = ref(null);
// ui-next 是另一個根介面，但讀取同一份已登入使用者的用量資料；明確掛出 ref，避免各自輪詢。
window.claudeUsage = claudeUsage;
window.codexUsage = codexUsage;
async function loadClaudeUsage() {
  if (!Api.isLoggedIn()) return;
  // 用量僅管理員可見；非 admin 不打（避免 403 噪音）
  if (window.UserStore.role !== "admin") return;
  try {
    claudeUsage.value = await Api.get("claude-usage");
  } catch {
    /* keep stale */
  }
}
window.loadClaudeUsage = loadClaudeUsage;
async function loadCodexUsage() {
  if (window.UserStore.role !== "admin") return;
  try {
    codexUsage.value = await Api.get("codex-usage");
  } catch {
    /* keep stale */
  }
}
window.loadCodexUsage = loadCodexUsage;

// 登入後即抓一次跨專案未讀，填入 UnreadStore → 左側 menu 專案 badge 首屏就準確；
// 之後靠 socket chat:reply 遞增、ProjectChat 標記已讀清零維持即時。
async function loadUnread() {
  if (!Api.isLoggedIn()) return;
  try {
    const { byProject } = await Api.get("chats/unread");
    window.UnreadStore.byProject = byProject || {};
  } catch {
    /* keep stale */
  }
}
window.loadUnread = loadUnread;


const ForbiddenView = {
  name: "ForbiddenView",
  template: `<main class="auth-container" aria-labelledby="forbidden-title"><section class="auth-card"><h1 id="forbidden-title">403：沒有存取權限</h1><p>你的帳號沒有權限使用此頁面。</p><router-link to="/">返回首頁</router-link></section></main>`,
};

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/login",
      component: window.UiNextLoginView,
    },
    { path: "/forbidden", component: ForbiddenView },
    {
      path: "/",
      component: window.UiNextQuestionView,
      meta: { requiresAuth: true },
    },
    {
      path: "/tasks",
      component: window.UiNextTaskListView,
      meta: { requiresAuth: true },
    },
    {
      path: "/task/:id",
      component: window.UiNextTaskDetailView,
      meta: { requiresAuth: true },
    },
    {
      // 收件匣沒有獨立頁面了（舊版前端 2026-09-22 退役，Inbox.js 一併刪除）。
      // 路由留著只為了讓既有連結／通知信裡的舊網址仍到得了對應的地方。
      path: "/inbox",
      redirect: "/tasks?tab=needs_action",
      meta: { requiresAuth: true },
    },
    {
      // 終端機頁面能直接下指令操作任務所在容器，2026-09-21 使用者裁決 D2「兩個都收」
      // 收斂為平台管理員限定。
      path: "/task/:id/terminal",
      component: window.UiNextTerminalView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/projects",
      component: window.UiNextProjectListView,
      meta: { requiresAuth: true },
    },
    {
      path: "/projects/:id",
      component: window.UiNextProjectDetailView,
      meta: { requiresAuth: true },
    },
    {
      path: "/projects/:id/wiki",
      component: window.UiNextWikiView,
      meta: { requiresAuth: true },
    },
    {
      path: "/projects/:id/wiki/:slug",
      component: window.UiNextWikiView,
      meta: { requiresAuth: true },
    },
    {
      path: "/projects/:id/chat",
      component: window.UiNextProjectChatView,
      meta: { requiresAuth: true },
    },
    {
      path: "/projects/:id/chat/:chatId",
      component: window.UiNextProjectChatView,
      meta: { requiresAuth: true },
    },
    {
      path: "/projects/:id/db",
      component: window.UiNextDbView,
      meta: { requiresAuth: true },
    },
    {
      path: "/token-report",
      component: window.UiNextTokenReportView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/settings",
      component: window.UiNextSettingsView,
      meta: { requiresAuth: true },
    },
    {
      // 架構圖是平台內部實作細節，2026-09-21 起收斂為平台管理員限定（規格 §5.5）。
      path: "/architecture",
      component: window.UiNextArchitectureView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      // 流程圖同上，收斂為平台管理員限定（規格 §5.5）。
      path: "/pipeline-flow",
      component: window.UiNextPipelineFlowView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      // 認證題庫只有 ui-next 版本，沒有 legacy 對應（舊版不再新增頁面）。
      // legacy 模式下 index.html 不載入 ExamBank.js，這裡會是 undefined；
      // 但入口只掛在 ui-next 的「更多工具」選單裡，legacy 使用者走不到這條路由。
      //
      // 用 requiresInternal 而非 requiresAdmin：規格 §5.5 原文把考試列為平台管理員限定，
      // 但 2026-09-21 的裁決推翻了這一列——考試改由公司功能開關（features.exam）決定，
      // 鎖成管理員限定會把考試從 7 個內部同事手上收走。這裡是近似（內部人員＝有考試功能），
      // 真正精確的判斷在後端 requireFeature('exam')（3a Task 2 已上線）與 nav（Task 4 用
      // features.exam）。這個近似在「客戶公司被開了考試功能」時會過嚴：router 擋、後端放行。
      // 這是刻意的保守——router 擋錯的後果是客戶看不到一個他該看到的入口（會有人來說），
      // 放行錯的後果是客戶進到內部題庫（不會有人說）。不要把這裡改回 requiresAdmin。
      path: "/exam-bank",
      component: window.UiNextExamBankView,
      meta: { requiresAuth: true, requiresInternal: true },
    },
    {
      // 考試作戰台（考試當天用）。同樣只有 ui-next 版本、同樣用 requiresInternal，理由同上。
      path: "/exam-run",
      component: window.UiNextExamRunView,
      meta: { requiresAuth: true, requiresInternal: true },
    },
    {
      // 產品化規格頁：只有 ui-next 版本（理由同上）。內容是內部規劃文件，
      // 入口按鈕、這條路由、後端 /api/docs/saas-specs 三處都限管理員（rules/frontend.md 38）。
      path: "/saas-specs",
      component: window.UiNextSaasSpecsView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      // 公司管理員的「公司帳號」頁。只有 ui-next 版本——legacy 不需要維護新頁面。
      // 這頁公司管理員與平台管理員都能進，所以不掛 requiresAdmin（會擋掉公司管理員），
      // 也不另外發明 requiresCompanyAdmin 這個 meta 旗標——只有這一個頁面用得到，
      // 不值得加一個新概念（YAGNI）。guard 用明確的 path 判斷＋角色條件（見下方 beforeEach）。
      path: "/company-users",
      component: window.UiNextCompanyUsersView,
      meta: { requiresAuth: true },
    },
    {
      // 平台管理員的公司管理頁（3b Task 8）。只有 ui-next 版本，legacy 不需要維護新頁面。
      // 用既有的 requiresAdmin（role==='admin'）就夠——不必為單一頁面另外發明旗標。
      // 2026-09-22 從 /companies 搬到 /admin/ 底下：它本來就是管理員設定的一員，
      // 掛在「更多工具」下等於把同一類功能拆成兩個入口，使用者要記哪個在哪裡。
      path: "/admin/companies",
      component: window.UiNextCompanyAdminView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin",
      component: window.UiNextAdminView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/settings",
      component: window.UiNextAdminSettingsView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/users",
      component: window.UiNextAdminUsersView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/agents",
      component: window.UiNextAdminAgentsView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/schedules",
      component: window.UiNextAdminSchedulesView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/pipelines",
      component: window.UiNextPipelineView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/health",
      component: window.UiNextAdminHealthCheckView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/rejections",
      component: window.UiNextAdminRejectionsView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/classify-samples",
      component: window.UiNextAdminClassifySamplesView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/prompt-logs",
      component: window.UiNextAdminPromptLogsView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/port-pool",
      component: window.UiNextAdminPortPoolView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/enterprise",
      component: window.UiNextAdminEnterpriseView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    {
      path: "/admin/feedback",
      component: window.UiNextAdminFeedbackView,
      meta: { requiresAuth: true, requiresAdmin: true },
    },
    // 「平台更版」曾經是一條獨立路由（/admin/release）。2026-09-22 使用者裁決取消：
    // 更版是改善流程的最後一步，待更版清單與「立刻更版」併入 /admin/feedback、
    // 維護時段併入 /admin/settings、「上一次沒有成功」掛在 /admin 首頁。
    // 後端端點（/api/admin/release*）原封不動，只是呼叫的人換了。
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  if (to.meta.requiresAuth && !Api.isLoggedIn())
    return { path: "/login", query: { redirect: to.fullPath } };
  if (to.path === "/login" && Api.isLoggedIn()) return "/";
  if (to.meta.requiresAdmin) {
    try {
      const me = await Api.get("auth/me");
      if (me.role !== "admin") return "/forbidden";
    } catch {
      return { path: "/login", query: { redirect: to.fullPath } };
    }
  }
  // requiresAdmin 與 requiresInternal 各自打一次 auth/me，沒有合併——合併是對的方向，
  // 但那是既有 guard 的重構，超出本次任務範圍。
  if (to.meta.requiresInternal) {
    try {
      const me = await Api.get("auth/me");
      // 平台管理員沒有公司，後端一律視為內部人員；這裡照樣只看 is_internal，
      // 不要再補 role === 'admin' 的特判——特判會讓兩邊的定義慢慢分岔。
      if (me.is_internal !== true) return "/forbidden";
    } catch {
      return { path: "/login", query: { redirect: to.fullPath } };
    }
  }
  // 公司帳號頁專屬條件（見上方 /company-users route 的註解，理由同 Task 3 的
  // requiresInternal：只有一頁用得到的角色組合，不值得發明新 meta 旗標）。
  if (to.path === "/company-users") {
    try {
      const me = await Api.get("auth/me");
      if (me.role !== "company_admin" && me.role !== "admin") return "/forbidden";
    } catch {
      return { path: "/login", query: { redirect: to.fullPath } };
    }
  }
});

router.afterEach((to) => {
  if (Api.isLoggedIn() && to.path !== "/login") {
    // 每次導覽刷新角色（登入後第一次導覽即設好 role）→ 再依角色載入用量小工具
    Api.get("auth/me")
      .then((me) => {
        window.UserStore.role = me.role || "";
        // 另外幾個身分旗標原本只有 ui-next 外殼的 mounted() 在寫，而外殼是根元件、整場只掛載一次：
        // 表單登入（登出後或 token 過期後重登）不重新整理的話，features 會整場 session 停在 {}，
        // 內部同事就看不到 features.exam 那個入口，而且畫面上沒有任何徵狀可察覺。
        // 這與 role 當初被搬來 afterEach 的是同一個坑（理由見下方 isAdmin 的註解），
        // 所以照同一個做法修、不另外發明機制——auth/me 本來就回這幾個欄位，不多打一次 API。
        window.UserStore.isInternal = me.is_internal === true;
        window.UserStore.companyId = me.company_id ?? null;
        window.UserStore.companyName = me.company_name || "";
        window.UserStore.features = me.features || {};
        // 公司停用／過期時後端擋掉除 GET /auth/me 以外的每一支 /api（index.js 的公司不可用閘門），
        // 外殼要靠這個旗標講出「為什麼不能用」。缺值一律當可用：載入中先閃一下停用畫面比沒講原因更糟。
        window.UserStore.companyUsable = me.company_usable !== false;
        // 深色偏好也在此同步：表單登入只走 afterEach（不經 mounted 的已登入分支），
        // 漏了會讓無痕登入永遠停在預設淺色（localStorage 空、又沒讀 DB 偏好）。
        ThemeManager.syncFromServer(me.odoo_settings && me.odoo_settings.theme);
        SocketManager.initSocket(me.id);
        loadClaudeUsage();
        loadCodexUsage();
        loadUnread();
        loadInboxUnread();
      })
      .catch(() => {});
  }
  if (to.path === "/login") {
    SocketManager.disconnectSocket();
    window.UserStore.role = "";
    // 比照 UiNextApp 的 logout()：既然上面一併寫入，這裡就要一併清掉。
    // 少清一個，token 過期被踢回登入頁的人下一秒看到的就是上一個帳號的公司名與功能開關。
    window.UserStore.isInternal = false;
    window.UserStore.companyId = null;
    window.UserStore.companyName = "";
    window.UserStore.features = {};
    window.UserStore.companyUsable = true;
  }
});

// 與 lib/claude-usage.js 的 CACHE_TTL_MS 對齊（改一邊必須改另一邊）。2026-08-31 實測
// /api/oauth/usage 的門檻約「5 分鐘 6 次」。原本的 10 分鐘讓數字落後半小時以上，
// 但 60s 那版 24/7 長跑後仍被持續罰站（2026-09-07 觀察到 snapshot 近兩小時未更新），
// 故放寬到 3 分鐘。Codex 端點的門檻沒量過，維持 10 分鐘不動。
setInterval(loadClaudeUsage, 3 * 60 * 1000);
setInterval(loadCodexUsage, 10 * 60 * 1000);

// 外殼只剩 ui-next 這一套（舊版前端 2026-09-22 退役，js/views/ 與 ?ui=legacy 一併刪除）。
const app = createApp(window.UiNextApp);
app.component("ConfirmDialogHost", window.ConfirmDialogHost);
app.component("ImagePreviewHost", window.ImagePreviewHost);
// 放大跳窗要能從任何一支 View 的 template 直接叫（縮圖散在十幾個地方），掛 globalProperties
// 比每支 View 各包一個同名 method 少十幾份重複，也不會漂移成十幾種行為。
app.config.globalProperties.previewImage = window.previewImage;
app.component("Skeleton", window.Skeleton);
app.component("ReleaseModal", window.ReleaseModal);
app.component("TourHost", window.TourHost);
// 可搜尋的專案下拉，跟上面幾個一樣是跨 View 共用的元件，所以一起全域註冊。
app.component("UiNextProjectPicker", window.UiNextShared.UiNextProjectPicker);
app.use(router);
app.mount("#app");
