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
//
// expect: 截圖前必須等到的選擇器＝「這一頁真的渲染出來了」的證據。預設值 DEFAULT_EXPECT
// 涵蓋所有 app 頁（每個 view 自己提供 .content 或 .page-body，view 一炸就一個都不存在），
// 未登入頁與獨立 HTML 頁各自指定。
const ROUTES = [
  { key: 'login', hash: '#/login', auth: 'none', covered: true, expect: '.login-wrap' },
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
  { key: 'pipeline-flow', hash: '#/pipeline-flow', auth: 'user', covered: true },
  { key: 'admin-health', hash: '#/admin/health', auth: 'admin', covered: true },
  { key: 'admin-rejections', hash: '#/admin/rejections', auth: 'admin', covered: true },
  { key: 'admin-classify-samples', hash: '#/admin/classify-samples', auth: 'admin', covered: true },
  { key: 'admin-prompt-logs', hash: '#/admin/prompt-logs', auth: 'admin', covered: true },
  { key: 'admin-port-pool', hash: '#/admin/port-pool', auth: 'admin', covered: true },
  { key: 'admin-enterprise', hash: '#/admin/enterprise', auth: 'admin', covered: true },
  { key: 'styleguide', path: 'styleguide.html', auth: 'none', covered: true, expect: '.sg-wrap' }
];

// 每個 view 的模板自己帶 .content 或 .page-body（app.js 只提供外框與 router-view），
// 所以「兩者都找不到」＝這一頁的 view 根本沒渲染出來。
const DEFAULT_EXPECT = '.content, .page-body';
function expectSelector(route) { return route.expect || DEFAULT_EXPECT; }

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
  /* 側欄底部教程剩餘步數：任何人走一次教程就變 */
  .tour-launch-badge { visibility: hidden !important; }
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

  /* ── 讓 fullPage 真的拍到整頁 ──────────────────────────────────
     app-shell 是「一屏高、內部捲動」的版型（body 100dvh + .main/.content 各自 overflow）。
     Playwright 的 fullPage 看的是 document 的捲動高度，對這種內部捲動的容器無效——
     所以在補上這段之前，**所有 app 頁面的基線都只有一個視窗高**，捲動線以下的內容
     從來沒進過門禁（2026-08-07 發現：126 張基線裡唯一超過一屏的是 styleguide.html，
     因為它是獨立頁面、沒有 app-shell）。門禁號稱「桌機 diff = 0」，其實只驗了第一屏。
     解除高度與 overflow 限制，整份文件才會展開讓 fullPage 拍完。

     漏一個頁面級捲動容器的後果是「那幾頁的基線只有一屏高」，而且沒有任何訊號——
     .page-body 就這樣漏了 Admin／Settings／AdminPortPool／AdminEnterprise／PipelineFlow
     五頁（後者是 802173d 才剛納入門禁的）。判準：app.css 裡 flex:1 + overflow-y:auto
     的單一 class 規則都要列進來（rwd-gate.test.js 守著）。 */
  html, body { height: auto !important; overflow: visible !important; }
  .app-shell, .main, .content, .page-body { height: auto !important; overflow: visible !important; }
  /* 內部還有一層用百分比撐高的容器（wiki 的 calc(100% - 56px)、chat 的 flex 欄）。
     父層一旦變成 height:auto，百分比會解析成 0 → 整頁截成空白。連同解除。 */
  .wiki-body, .wiki-tree-panel, .chat-split, .chat-main, .chat-messages, .terminal-body {
    height: auto !important; min-height: 0 !important; overflow: visible !important;
  }
  /* sticky 頁首在展開後會跟著捲，長頁上會重複入鏡 */
  .page-header, .topbar { position: static !important; }

  /* port 池的槽位內容（主機名／租借狀態／綁定專案）每分鐘都在變——測試環境一啟停就不同。
     遮內容、留佔位：欄寬與列高照樣驗得到，但不會每跑一次就假紅一次。 */
  .port-pool-slot-code, .port-pool-slot-state,
  .port-pool-slot-row > span { visibility: hidden !important; }
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
  VIEWPORTS, THEMES, ROUTES, STABILIZE_CSS, DIFF, DEFAULT_EXPECT,
  activeRoutes, manualCheckList, shotPlan, expectSelector
};
