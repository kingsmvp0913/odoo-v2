// 截圖覆蓋的唯一真相：路由清單、斷點、主題、以及要遮罩的動態內容。
// 新增路由時只改這裡，capture.js／compare.js 都由此推導。

// §3.1 斷點。桌機是回歸門禁（diff 必須為 0），另兩個是進度證據。
const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900, gate: true },
  { key: 'tablet', width: 820, height: 1180, gate: false },
  { key: 'mobile', width: 390, height: 844, gate: false }
];

const THEMES = ['light', 'dark'];

// hash routing（app.js:29 createWebHashHistory）→ URL 形如 <base>/#/task/1
//
// auth:
//   'none'  未登入即可看（截圖前清掉 token）
//   'user'  一般登入態
//   'admin' 需 admin（app.js:61 的 guard 會呼叫 auth/me，非 admin 會被導回首頁）
//
// covered: false = 無法穩定造資料，不進自動 diff，改列人工檢查清單（規格 §2.4 已列明）
const ROUTES = [
  { key: 'login', hash: '#/login', auth: 'none', covered: true },
  { key: 'task-list', hash: '#/', auth: 'user', covered: true },
  { key: 'task-detail', hash: '#/task/:taskId', auth: 'user', covered: true, needs: 'taskId' },
  { key: 'task-terminal', hash: '#/task/:taskId/terminal', auth: 'user', covered: false,
    why: '需要執行中的任務才有終端輸出，無法穩定造資料' },
  { key: 'project-list', hash: '#/projects', auth: 'user', covered: true },
  { key: 'project-detail', hash: '#/projects/:projectId', auth: 'user', covered: true, needs: 'projectId' },
  { key: 'project-wiki', hash: '#/projects/:projectId/wiki', auth: 'user', covered: true, needs: 'projectId' },
  { key: 'project-chat', hash: '#/projects/:projectId/chat', auth: 'user', covered: true, needs: 'projectId' },
  { key: 'project-db', hash: '#/projects/:projectId/db', auth: 'user', covered: false,
    why: '需要可用的遠端資料庫連線，無法穩定造資料' },
  { key: 'token-report', hash: '#/token-report', auth: 'admin', covered: true },
  { key: 'settings', hash: '#/settings', auth: 'user', covered: true },
  { key: 'admin', hash: '#/admin', auth: 'admin', covered: true },
  { key: 'admin-users', hash: '#/admin/users', auth: 'admin', covered: true },
  { key: 'admin-agents', hash: '#/admin/agents', auth: 'admin', covered: true },
  { key: 'admin-pipelines', hash: '#/admin/pipelines', auth: 'user', covered: true },
  { key: 'admin-health', hash: '#/admin/health', auth: 'admin', covered: true },
  { key: 'admin-rejections', hash: '#/admin/rejections', auth: 'admin', covered: true },
  { key: 'admin-classify-samples', hash: '#/admin/classify-samples', auth: 'admin', covered: true },
  { key: 'admin-prompt-logs', hash: '#/admin/prompt-logs', auth: 'admin', covered: true },
  { key: 'admin-port-pool', hash: '#/admin/port-pool', auth: 'admin', covered: true },
  { key: 'admin-enterprise', hash: '#/admin/enterprise', auth: 'admin', covered: true },
  { key: 'styleguide', path: 'styleguide.html', auth: 'none', covered: true }
];

// 會隨時間／資料變動的區塊。不遮掉的話門禁天天假紅，紅到沒人看——
// 那比沒有門禁更糟，因為它會訓練人忽略紅燈。
//
// 用 visibility:hidden 而非 display:none：保留原本佔位，版面不位移，
// 才能驗出「版面有沒有被改壞」這件真正要驗的事。
const STABILIZE_CSS = `
  /* sidebar 的 Claude 用量條：每次執行都不同 */
  .usage-mini { visibility: hidden !important; }
  /* 待處理數字 badge：隨任務狀態變動 */
  .sidebar nav a .badge { visibility: hidden !important; }
  /* 相對時間、時間戳 */
  [data-rwd-volatile] { visibility: hidden !important; }
  /* 動畫與過場一律關閉，避免截到中間影格 */
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
  /* skeleton 的脈動 */
  .skeleton { animation: none !important; opacity: .6 !important; }
`;

// 比對容差。抗字型次像素渲染的微小差異，但不足以蓋掉真正的版面位移。
const DIFF = {
  threshold: 0.1,      // pixelmatch 單點色差門檻
  maxDiffPixels: 100   // 全圖可容忍的差異點數；超過即判定為回歸
};

function activeRoutes() { return ROUTES.filter(r => r.covered); }

function manualCheckList() {
  return ROUTES.filter(r => !r.covered).map(r => ({ key: r.key, why: r.why }));
}

// 一次執行要截的全部組合
function shotPlan({ gateOnly = false } = {}) {
  const vps = gateOnly ? VIEWPORTS.filter(v => v.gate) : VIEWPORTS;
  const plan = [];
  for (const route of activeRoutes()) {
    for (const vp of vps) {
      for (const theme of THEMES) {
        plan.push({ route, viewport: vp, theme, name: `${route.key}__${vp.key}__${theme}` });
      }
    }
  }
  return plan;
}

module.exports = {
  VIEWPORTS, THEMES, ROUTES, STABILIZE_CSS, DIFF,
  activeRoutes, manualCheckList, shotPlan
};
