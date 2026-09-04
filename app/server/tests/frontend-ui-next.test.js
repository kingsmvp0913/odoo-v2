const fs = require("fs");
const path = require("path");

const read = (file) =>
  fs.readFileSync(path.join(__dirname, "../../public", file), "utf8");

// 拆檔當下實測到的跨檔重複 selector 數（2026-09-02）。這些是拆檔前就存在的層疊覆蓋，
// 不是拆檔造成的——拆檔只是讓它們第一次變成看得見的數字。
// 這個數字只該往下走。往上代表又疊了一層「A 檔定義、B 檔靜默蓋掉」，
// 而那正是這個專案反覆踩到的坑：改了規則卻不生效，或移掉一條之後別條浮上來。
const CROSS_FILE_DUP_BASELINE = 28;

describe("ui-next 平行介面", () => {
  const index = read("index.html");
  const app = read("js/app.js");
  const uiNext = read("js/ui-next/UiNextApp.js");
  // 「Next 的頁面碼」現在散在 pages/ 各檔。列舉目錄而不是寫死清單：
  // 漏列一個檔的症狀是針對它的斷言靜默失去對象——測試照樣全綠，但已經沒在檢查了。
  const pagesDir = path.join(__dirname, "../../public/js/ui-next/pages");
  // UiNextShared.js 一併讀：共用的小元件（StatusBar／WikiNode）住在那裡，漏掉它
  // 等於針對那些元件的斷言全部失去對象。
  const uiNextPages = [
    read("js/ui-next/UiNextShared.js"),
    ...fs.readdirSync(pagesDir).filter((f) => f.endsWith(".js"))
      .map((f) => read(`js/ui-next/pages/${f}`)),
  ].join("\n");
  // 取單一 View 的原始碼。拆檔前得在大字串裡「切兩個元件之間」，那寫法依賴元件在檔內的
  // 先後順序——順序一變就默默切出空字串或別人的碼，而斷言照樣「通過」。現在一檔一 View，直接讀。
  const viewSrc = (component) =>
    read(`js/ui-next/pages/${component.replace(/^UiNext|View$/g, "")}.js`);

  const css = read("css/ui-next.css");
  // 拆檔後仍以「串接後的整體」為檢查對象：這些規則本來就是一份層疊，
  // 分開檢查會讓「A 檔定義、B 檔覆蓋」的組合失去意義。順序照 index.html 的清單。
  const cssOrder = index.match(/var UI_NEXT_CSS = \[([\s\S]*?)\]/)[1]
    .match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  const pagesCss = cssOrder.map((n) => read(`css/ui-next-pages/${n}.css`)).join("\n");

  // 版本判準只能有一處。以前 index.html 與 UiNextApp.js 各自讀一次網址，
  // 改了其中一處就會變成「載了新版資產卻走舊版 View」——畫面壞掉但沒有任何錯誤訊息。
  test("根介面依單一來源 window.UiVersion 決定，不自己讀網址", () => {
    expect(uiNext).toContain('window.UiNextEnabled = window.UiVersion === "next"');
    expect(uiNext).not.toMatch(/query\.get\(["']ui["']\)/);
    expect(app).toContain(
      "const RootApp = window.UiNextEnabled ? window.UiNextApp : App;",
    );
  });

  // 舊版是轉正式後的退路：兩個方向都要指定得動，預設值集中在一個常數上，
  // 轉正式就是改那一個字，不必再回頭找散落各處的判斷。
  test("?ui=legacy 與 ?ui=next 都認得，預設值是單一常數", () => {
    expect(index).toContain("window.UiVersion = (function ()");
    expect(index).toMatch(/picked === 'next' \|\| picked === 'legacy' \? picked : DEFAULT_UI/);
    expect(index).toMatch(/var DEFAULT_UI = '(next|legacy)'/);
  });

  test("新版資產獨立載入，且所有 CSS 規則皆有 ui-next 範圍", () => {
    expect(index).toContain("css/ui-next.css");
    expect(index).toContain("css/ui-next-pages/");
    expect(index).toContain("js/ui-next/UiNextApp.js");
    expect(index).toContain("js/ui-next/UiNextShared.js");
    expect(css).toContain(".ui-next-shell");
    expect(pagesCss).toContain(".ui-next-chat-page");
    expect(index).toContain("window.UiVersion === 'next'");
    // CSS 同樣由 ui-next 分支動態寫入，Legacy 不承擔其下載成本。
    expect(index).toContain("document.write(href.map(");
    // JS 由 ui-next 分支動態寫入，且拆出去的 pages/ 也要在同一批載入——
    // 漏掉的話那些 window.UiNextXxxView 不存在，路由拿到 undefined 元件即白畫面。
    expect(index).toContain("js/ui-next/pages/");
    expect(index).toContain("document.write(src.map(");
  });

  // 有幾個 pages/ 檔在載入當下就從 window.UiNextShared 解構取 helper。
  // shared 排到它們後面的話拿到的是 undefined，那幾支檔直接拋錯不執行 —— 白畫面。
  test("UiNextShared.js 排在 pages/ 之前", () => {
    expect(index.indexOf("UiNextShared.js")).toBeGreaterThan(-1);
    expect(index.indexOf("UiNextShared.js")).toBeLessThan(index.indexOf("js/ui-next/pages/"));
  });

  // CSS 的載入順序就是層疊順序：同權重後者贏，而 09-later-patches 整份都是靠排在
  // 最後才生效的補丁。重排或漏載的症狀是樣式默默變掉——沒有錯誤、沒有測試會叫。
  // 檔名前綴的數字順序＝載入順序，兩者對不上就是有人動過其中一邊。
  test("CSS 依檔名數字順序載入，且目錄內每個檔都在清單裡", () => {
    const onDisk = fs
      .readdirSync(path.join(__dirname, "../../public/css/ui-next-pages"))
      .filter((f) => f.endsWith(".css")).map((f) => f.replace(/\.css$/, "")).sort();
    expect(cssOrder).toEqual(onDisk);
    expect(cssOrder).toEqual([...cssOrder].sort());
  });

  // 同一個 selector 在多個檔重複定義＝後面那份靜默蓋掉前面那份。拆檔後這種覆蓋
  // 跨了檔案更難察覺，所以把現況鎖住：新增重複要嘛合併、要嘛在此明列並說明理由。
  test("跨檔重複的 selector 沒有增加", () => {
    const seen = new Map();
    cssOrder.forEach((name) => {
      const src = read(`css/ui-next-pages/${name}.css`)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
      for (const m of src.matchAll(/(^|\})([^{}@]+)\{/g)) {
        for (const sel of m[2].split(",").map((s) => s.trim()).filter(Boolean)) {
          if (!seen.has(sel)) seen.set(sel, new Set());
          seen.get(sel).add(name);
        }
      }
    });
    const crossFile = [...seen.entries()].filter(([, files]) => files.size > 1);
    // 現況基線。要調高就代表又疊了一層跨檔覆蓋，請先確認那是不是本意。
    expect(crossFile.length).toBeLessThanOrEqual(CROSS_FILE_DUP_BASELINE);
  });

  // 載入清單漏一個檔＝那一頁白畫面，而且 index.html 看起來完全正常。
  test("pages/ 內每個檔都被 index.html 列進載入清單", () => {
    const listed = index.match(/var UI_NEXT_PAGES = \[([^\]]*)\]/)[1];
    for (const file of fs.readdirSync(pagesDir).filter((f) => f.endsWith(".js"))) {
      expect(listed).toContain(`'${file.replace(/\.js$/, "")}'`);
    }
  });

  test("Next CSS 的每個 selector 都有專用 scope，不會污染 Legacy DOM", () => {
    const selectors = (source) => {
      const out = [], clean = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
      let buffer = "";
      for (const char of clean) {
        if (char === "{") {
          const selector = buffer.trim();
          if (selector && !selector.startsWith("@")) out.push(...selector.split(",").map((item) => item.trim()));
          buffer = "";
        } else if (char === "}") buffer = "";
        else buffer += char;
      }
      return out;
    };
    for (const selector of selectors(`${css}\n${pagesCss}`)) {
      expect(selector).toMatch(/^(?:\.ui-next|\[data-ui="next"\]|html\[data-theme=)/);
    }
    // keyframes 是全域命名空間，撞名會讓別人的動畫被改掉——名稱一樣要有 ui-next 前綴。
    for (const name of [...`${css}\n${pagesCss}`.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])) {
      expect(name).toMatch(/^ui-next-/);
    }
  });

  test("Next 入口使用對應的新版 View", () => {
    [
      ["UiNextTokenReportView", "TokenReportView"],
      ["UiNextPipelineView", "AdminPipelinesView"],
      ["UiNextProjectChatView", "ProjectChatView"],
      ["UiNextTaskListView", "TaskListView"],
      ["UiNextProjectListView", "ProjectListView"],
      ["UiNextProjectDetailView", "ProjectDetailView"],
      ["UiNextTaskDetailView", "TaskDetailView"],
      ["UiNextWikiView", "WikiView"],
    ].forEach(([next, legacy]) => {
      expect(app).toMatch(
        new RegExp(
          `window\\.UiNextEnabled\\s*\\?\\s*window\\.${next}\\s*:\\s*window\\.${legacy}`,
        ),
      );
      expect(uiNextPages).toMatch(new RegExp(`name:\\s*["']${next}["']`));
    });
      expect(
        (uiNextPages.match(/name:\s*["']UiNextProjectDetailView["']/g) || [])
          .length,
      ).toBe(1);
      ["UiNextProjectListView", "UiNextTaskListView"].forEach((name) =>
        expect(
          (uiNextPages.match(new RegExp(`name:\\s*["']${name}["']`, "g")) || [])
            .length,
        ).toBe(1),
      );
  });

  test("新版入口保留既有 Chat API、附件與自動標題流程", () => {
    expect(uiNext).toContain("projects/${this.projectId}/chats");
    expect(uiNext).toContain("Api.postForm");
    expect(uiNext).toContain("chatTitle(this.prompt)");
    expect(uiNext).toContain("projects/${id}/chats");
    expect(uiNext).toMatch(/chat\.title \|\| ["']新對話["']/);
    expect(uiNext).toContain("oaa.next.last-project-id");
    expect(uiNext).toContain("projects/${this.projectId}/env");
    expect(uiNext).toContain("this.createdChatId");
    expect(uiNext).toContain('@keydown.enter.exact.prevent="send"');
  });

  test("Chat 採用問答主畫面，對話紀錄改為按需展開", () => {
    expect(uiNextPages).toContain('showHistory: false');
    expect(uiNextPages).toContain('對話紀錄');
    expect(uiNextPages).toContain('ui-next-chat-history');
    expect(uiNextPages).toContain('ui-next-thread-composer');
    expect(pagesCss).toMatch(/\.ui-next-chat-page \{\r?\n  display: block;/);
    expect(pagesCss).toContain('.ui-next-chat-history {');
  });

  test("收件匣與新手教學不進新版日常導覽", () => {
    expect(uiNext).not.toMatch(/go\(["']\/inbox["']\)/);
    expect(app).toContain('redirect: window.UiNextEnabled ? "/tasks?tab=needs_action" : undefined');
    expect(uiNextPages).toContain("this.$route.query.tab");
    expect(uiNext).not.toContain('@click="openTour"><ui-next-icon name="book"/>新手教學');
    // 只隱藏入口，保留 TourManager 整合，日後恢復時不需要重建教學功能。
    expect(uiNext).toContain("window.TourManager.open()");
    expect(uiNext).toMatch(/go\(["']\/admin\/pipelines["']\)/);
    expect(uiNext).toMatch(/go\(["']\/token-report["']\)/);
  });

  test("既有 View 的通知、確認視窗、教學與主題切換在新版殼層仍可用", () => {
    expect(app).toContain("window.appToasts = toasts");
    expect(uiNext).toContain("toasts: window.appToasts");
    expect(uiNext).toContain("<confirm-dialog-host />");
    expect(uiNext).toContain("<tour-host />");
    expect(uiNext).toContain("window.ThemeManager.toggle()");
  });

  test("除收件匣外，既有功能路由仍由同一個 router 提供給新版殼層", () => {
    [
      '"/tasks"',
      '"/task/:id"',
      '"/task/:id/terminal"',
      '"/projects"',
      "'/projects/:id'",
      "'/projects/:id/chat'",
      "'/projects/:id/chat/:chatId'",
      "'/projects/:id/wiki'",
      "'/projects/:id/wiki/:slug'",
      "'/projects/:id/db'",
      "'/projects/:id/deploy-sop'",
      "'/settings'",
      "'/token-report'",
      "'/architecture'",
      "'/pipeline-flow'",
      "'/admin'",
      "'/admin/users'",
      "'/admin/agents'",
      "'/admin/schedules'",
      "'/admin/pipelines'",
      "'/admin/health'",
      "'/admin/rejections'",
      "'/admin/classify-samples'",
      "'/admin/prompt-logs'",
      "'/admin/port-pool'",
      "'/admin/enterprise'",
    ].forEach((route) => expect(app).toContain(route.replace(/'/g, '"')));
    expect(uiNext).toContain("<router-view />");
  });

  test("日常頁面與工具頁都有 ui-next 範圍內的視覺覆寫", () => {
    [
      ".task-card",
      ".project-card",
      ".chat-main",
      ".settings-section",
      ".wiki-body",
      ".terminal-body",
      ".flow-diagram-panel",
      ".tr-table-card",
      ".nav-card",
    ].forEach((selector) => expect(css).toContain(`.ui-next-main ${selector}`));
  });

  test("新版工具與管理頁保留原始 View 的資料操作，並有新版框架", () => {
    [
      "UiNextDeploySopView",
      "UiNextAdminView",
    ].forEach((name) =>
      expect(uiNextPages).toMatch(new RegExp(`name:\\s*["']${name}["']`)),
    );
    expect(app).toContain("window.UiNextEnabled ? window.UiNextAdminUsersView : window.AdminUsersView");
    expect(uiNextPages).toContain('name: "UiNextAdminUsersView"');
    expect(app).toContain("window.UiNextEnabled ? window.UiNextDbView : window.ProjectDbQueryView");
    expect(uiNextPages).toContain('name: "UiNextDbView"');
    expect(app).toContain("window.UiNextEnabled ? window.UiNextTerminalView : window.TerminalView");
    expect(uiNextPages).toContain('name: "UiNextTerminalView"');
    expect(pagesCss).toContain(".ui-next-wiki-layout");
    expect(pagesCss).toContain(".ui-next-sop-page");
  });
  test("Next Shell 具有獨立 token、深色模式、鍵盤命令面板與減少動態效果的隔離契約", () => {
    expect(uiNext).toContain('data-ui="next"');
    expect(uiNext).toContain('ref="commandPalette"');
    expect(uiNext).toContain('aria-modal="true"');
    expect(uiNext).toContain('ref="commandInput"');
    expect(uiNext).toContain("this.focusCommand();");
    expect(uiNext).toContain("trapCommandFocus(event)");
    expect(uiNext).toContain("closeCommand()");
    expect(uiNext).toContain("commandTrigger.focus()");
    expect(css).toContain('[data-ui="next"]{--next-bg:');
    expect(css).toContain('html[data-theme="dark"] [data-ui="next"]');
    expect(css).toContain('@media(prefers-reduced-motion:reduce)');
    expect(css).toContain('@media(min-width:768px) and (max-width:1199px)');
    expect(css).toContain('@media(max-width:767px)');
    expect(uiNext).toContain('href="#ui-next-main"');
    expect(uiNext).toContain('<main id="ui-next-main"');
    expect(css).toContain('--next-brand:#93C5FD');
    expect(css).not.toContain('#C5A3BB');
    expect(css).toContain('.ui-next-task-rich-head h2 a{color:var(--text);text-decoration:none}');
    expect(css).not.toMatch(/task-rich-head h2 a\{color:#fff\}/);
  });

  test("動態 HTML 容器不保留子節點，避免 Vue 在進入詳情頁時拒絕編譯", () => {
    expect(uiNextPages).toContain('v-html="renderMd(row.message.content)" v-show="row.message.content"></div>');
    expect(uiNextPages).toContain('v-html="ansiToHtml(event.content)"></pre>');
  });

  test("P0：Next 權限、篩選與 Chat route 不會退回 Legacy 或白屏", () => {
    expect(app).not.toContain("window.location.replace(");
    expect(app).toContain('query: { redirect: to.fullPath }');
    expect(app).toContain('return "/forbidden"');
    // ⚠ key 綁 path 而不是 fullPath：fullPath 含 query，專案頁切頁籤只改 ?tab= 就會換掉 key，
    // 整個 view 被銷毀重建（實測重打三支 API、捲動歸零、畫面閃一下）。換 path／換對話仍會重建，
    // 純 query 變動由各頁自己 watch。改回 fullPath 就會重現那個「跳頁」。
    expect(uiNext).toContain('<router-view :key="$route.path" />');
    expect(uiNext).not.toContain('$route.fullPath');
    // 專案頁必須自己接手 query 變化，否則側欄帶 ?tab=chat 進來時頁籤不會切過去。
    expect(uiNextPages).toMatch(/"\$route\.query\.tab"\(tab\)\s*\{[\s\S]{0,260}this\.detailTab = next/);
    expect(uiNextPages).toContain("statusOptions()");
    expect(uiNextPages).not.toContain("window.STATUS_LABELS\" :key");
    expect(uiNextPages).toContain("開始新對話");
    expect(uiNextPages).toContain('filteredChats()');
    expect(uiNextPages).toContain('搜尋對話');
    expect(uiNextPages).toContain('historyMenuId===chat.id');
    expect(uiNextPages).toContain('無法建立對話，請重試。');
    expect(uiNextPages).toContain('chatsError');
    expect(uiNextPages).toContain('ui-next-chat-full-list');
    expect(uiNextPages).not.toMatch(/window\.ProjectChatView\.(?:data|computed|watch|methods|created)/);
    expect(uiNextPages).toContain('requestId !== this.requestId');
  });

  test("首頁 Project combobox 顯示安全且真實的兩層環境資訊", () => {
    const question = uiNext.slice(
      uiNext.indexOf('name: "UiNextQuestionView"'),
      uiNext.indexOf('name: "UiNextApp"'),
    );
    expect(question).toContain('Api.get("projects/env-summaries")');
    expect(question).toContain('projects/${this.projectId}/env/summary');
    expect(question).toContain('environmentOptionLabel(project)');
    expect(question).toContain('資料庫連線：${database}');
    expect(question).not.toContain('資料庫連線依你的權限顯示');
  });

  test("已移轉的專案清單與設定頁不再委派 Legacy View", () => {
    ["ProjectListView", "SettingsView", "ProjectChatView", "TaskListView", "TaskDetailView", "WikiView"].forEach((name) => {
      expect(uiNextPages).not.toMatch(
        new RegExp(`window\\.${name}\\.(?:data|computed|watch|methods|created|mounted|beforeUnmount|unmounted)`),
      );
    });
    const projectDetail = viewSrc("UiNextProjectDetailView");
    expect(projectDetail).not.toMatch(
      /window\.ProjectDetailView\.(?:data|computed|watch|methods|created|mounted|beforeUnmount|unmounted)/,
    );
  });

  test("Wiki 新增頁面視窗保留焦點、取消與失敗回饋", () => {
    const wiki = viewSrc("UiNextWikiView");
    expect(wiki).toContain('trapAddPageFocus(event)');
    expect(wiki).toContain('ref="wikiAddModal"');
    expect(wiki).toContain('role="dialog"');
    expect(wiki).toContain('role="alert"');
    expect(wiki).toContain('@click="closeAddPage"');
  });

  test("P0：手機任務詳情 action panel 不會維持超出容器的最小寬度", () => {
    expect(pagesCss).toContain(".ui-next-task-detail-grid,");
    expect(pagesCss).toContain(".ui-next-task-side > *");
    expect(pagesCss).toContain("max-width: 100%");
  });

  test("任務清單保留可辨識的流程列與可捲動主內容", () => {
    expect(uiNextPages).toContain('name: "UiNextStatusBar"');
    expect(uiNextPages).toContain('class="stepper"');
    expect(uiNextPages).toContain('class="step-circle"');
    expect(css).toContain(".ui-next-shell{height:calc(100vh / var(--ui-zoom, 1));min-height:calc(100vh / var(--ui-zoom, 1));overflow:hidden}");
    expect(css).toContain(".ui-next-sidebar-scroll{min-height:0;flex:1;overflow:auto}");
    expect(pagesCss).toContain("safe-area-inset-bottom");
    expect(css).toContain(".ui-next-main{box-sizing:border-box;scroll-padding-bottom:max(32px,env(safe-area-inset-bottom));padding-bottom:max(32px,env(safe-area-inset-bottom))}");
  });

  test("側欄帳號與更多工具使用相同的水平內距", () => {
    expect(css).toContain(".ui-next-account{width:100%;display:flex;gap:9px;align-items:center;border:0;background:transparent;color:var(--sidebar-text);padding:8px 9px");
    expect(css).toContain(".ui-next-tools{width:100%;border:0;background:transparent;color:var(--sidebar-text);padding:8px 9px");
    expect(uiNext).toContain('class="ui-next-user-icon"');
    expect(uiNext).toContain('<span>帳號與設定</span>');
    expect(uiNext).not.toContain('{{ userName }}<br><small>帳號與設定</small>');
  });

  test("側欄用量卡顯示服務、剩餘比例與更新時間，不使用泛稱標題", () => {
    expect(uiNext).toContain('provider: "claude", label: "Claude 5hr"');
    expect(uiNext).toContain('formatUsageUpdated(value)');
    expect(uiNext).toMatch(/methods: \{\r?\n\s+formatUsageUpdated\(value\)/);
    expect(uiNext).toContain('class="usage-provider-logo claude"');
    expect(uiNext).toContain('class="usage-provider-logo codex"');
    expect(uiNext).toContain('剩 {{ row.remaining }}%');
    expect(uiNext).toContain('更新 {{ formatUsageUpdated(row.updatedAt) }}');
    expect(uiNext).toContain("width: row.used + '%'");
    expect(uiNext).toContain('<i><em :class="row.level"');
    expect(css).toContain('.ui-next-usage-row i{flex-basis:100%');
    expect(uiNext).not.toContain('<b>Usage</b>');
  });

  test("Pipeline Monitor 在背景頁籤停止輪詢，回到前景立即更新", () => {
    expect(uiNextPages).toContain('document.addEventListener("visibilitychange", this._onVisibility)');
    expect(uiNextPages).toContain("if (document.hidden) this.stopPolling()");
    expect(uiNextPages).toContain("else { this.load(); this.startPolling(); }");
  });

  test("任務列表將可分享篩選同步到 query，並提供鍵盤可達的任務連結", () => {
    expect(uiNextPages).toContain("syncQuery()");
    expect(uiNextPages).toContain("this.$router.replace({ query })");
    expect(uiNextPages).toContain("@keydown=\"!batchMode&&onTaskKeydown(task,$event)\"");
    expect(uiNextPages).toContain("<router-link :to=\"taskPath(task)\"");
    expect(uiNextPages).toContain("選取任務：");
  });

  test("Next 頁面不得委派 Legacy View 的 lifecycle、options 或 component wrapper", () => {
    expect(uiNextPages).not.toMatch(/window\.[A-Za-z]+View\.(?:data|computed|watch|methods|created|mounted|beforeUnmount)/);
    expect(uiNextPages).not.toMatch(/components:\s*\{\s*[A-Za-z]+View:\s*window\./);
    expect(app).not.toContain("nextAdminTool(");
    expect(app).not.toContain("nextTool(");
  });

  test("Next 登入頁是獨立元件，不載入 Legacy Login DOM", () => {
    expect(app).toContain("window.UiNextEnabled ? window.UiNextLoginView : window.LoginView");
    expect(uiNextPages).toContain('name: "UiNextLoginView"');
    expect(uiNextPages).not.toMatch(/window\.LoginView\.(?:data|computed|watch|methods|created|mounted|beforeUnmount)/);
    expect(css).toContain(".ui-next-login{");
    expect(uiNextPages).toContain('class="ui-next-login" data-ui="next"');
    expect(css).toContain('[data-ui="next"].ui-next-login{box-sizing:border-box;width:100%');
  });

  test("Next 任務列表移除頁首統計，仍保留 Modal 與破壞性操作確認", () => {
    expect(uiNextPages).not.toContain('class="ui-next-task-summary-grid"');
    expect(uiNextPages).not.toContain("failedCount()");
    expect(uiNextPages).toContain('role="dialog" aria-modal="true" aria-labelledby="ui-next-task-create-title"');
    expect(uiNextPages).toContain("async deleteTask(task)");
    expect(uiNextPages).toContain('title: "永久刪除任務"');
    expect(pagesCss).toContain(".ui-next-task-modal-backdrop{");
  });

  test("建立任務 Modal 會保留失敗內容、限制附件並管理焦點", () => {
    expect(uiNextPages).toContain("trapAddFocus(event)");
    expect(uiNextPages).toContain("this.addTrigger?.focus()");
    expect(uiNextPages).toContain("最多上傳 5 個附件，請重新選擇。");
    expect(uiNextPages).toContain("removeAddFile(index)");
    expect(uiNextPages).toContain('ref="taskCreateModal"');
    expect(uiNextPages).toContain('class="ui-next-file-preview"');
    expect(uiNextPages).toContain('components: { StatusBar: UiNextStatusBar, UiNextIcon: window.UiNextIcon }');
  });

  test("Sidebar 只用批次 Chat metadata 篩選近期專案，Usage 與 Popover 遵循 Next UX", () => {
    expect(uiNext).toContain('Api.get("chats/sidebar-projects")');
    expect(uiNext).toContain("sidebarChatProjects.slice(0, 5)");
    expect(uiNext).toContain("project.is_favorite");
    expect(uiNext).not.toContain('>尚無對話</button>');
    expect(uiNext).toContain('v-if="(projectChats[project.id] || []).length" class="ui-next-all-chats"');
    expect(uiNext).toContain("document.addEventListener(\"pointerdown\", this._onOutsidePointer)");
    expect(uiNext).toContain("closePopovers(true)");
    expect(uiNext).toContain('label: "Claude 5hr"');
    expect(uiNext).toContain('label: "Codex 5hr"');
    expect(uiNext).toContain('to="/tasks"');
    expect(uiNext).toContain('to="/projects"');
    // 側欄專案仍走 lazy load：改成 mounted 逐專案讀 Chat 會變成每次登入 N+1。
    expect(uiNext).toContain("if (opening) await this.ensureProjectChats(id)");
    expect(uiNext).toMatch(/ensureProjectChats\(id\)\s*\{\s*\n\s*if \(Object\.prototype\.hasOwnProperty\.call\(this\.projectChats, id\)\) return;/);
  });

  test("側欄導覽是一棵樹：沒有區塊小標題，專案清單掛在「專案」底下", () => {
    // 這兩個小標題把同一棵導覽樹切成三段，是本次改版要移除的東西。
    expect(uiNext).not.toContain(">工作區</span>");
    expect(uiNext).not.toContain(">專案 Chat</span>");
    expect(uiNext).not.toContain('class="ui-next-section-label"');
    expect(css).not.toContain(".ui-next-section-label{");
    // 專案清單必須包在「專案」row 的同一個 group 內，而不是另一個獨立區塊。
    expect(uiNext).toMatch(/<div class="ui-next-nav-group">[\s\S]*?to="\/projects"[\s\S]*?class="ui-next-projects"/);
    // 沒有展開箭頭，所以清單常駐（不是 v-if 控制的可收合區塊）。
    expect(uiNext).toContain('<div class="ui-next-projects">');
    expect(uiNext).not.toContain("projectsOpen");
    // 分隔線保留，否則第一層入口會直接黏在搜尋下面。
    expect(uiNext).toContain('<div class="ui-next-sidebar-rule"></div>');
  });

  test("目前 Chat 一定看得到而且看得出是哪一列", () => {
    // 第 11 筆以後的目前 Chat 若被 slice 掉，深連結進來的人會看到一份「沒有自己」的清單。
    expect(uiNext).toContain('v-for="chat in visibleChats(project)"');
    expect(uiNext).not.toContain("(projectChats[project.id] || []).slice(0, 10)");
    // 順序固定：目前 Chat 只在被擠出前 10 筆時才補進來，而且補在末尾。
    // 提到最前面會讓「點一下清單就重排」，使用者的視線還停在原位（實測回報過）。
    expect(uiNext).toMatch(/return \[\.\.\.chats\.slice\(0, 9\), chats\[at\]\]/);
    expect(uiNext).toMatch(/if \(at < 0 \|\| at < 10\) return chats\.slice\(0, 10\)/);
    // 目前專案不在近期／最愛清單時的唯一例外補入。
    expect(uiNext).toMatch(/const current = projectById\.get\(this\.currentProjectId\);\s*\n\s*if \(current\) selected\.set/);
    // 換路由（不只 mounted）都要重新對齊側欄，否則 SPA 內切換 Chat 樹不會跟著展開。
    expect(uiNext).toContain('"$route.path"() { this.syncSidebarToRoute(); }');
    expect(uiNext).toContain("this.syncSidebarToRoute();");
    expect(uiNext).toMatch(/syncSidebarToRoute\(\)\s*\{[\s\S]{0,320}this\.expandedProjects\[id\] = true;[\s\S]{0,120}await this\.loadProjectChats\(id\)/);
    // 路由切到剛建立的 Chat 時強制重抓，不讓 lazy-load cache 把最新一筆藏掉。
    expect(uiNext).toContain("async loadProjectChats(id)");
  });

  test("Menu row 是低對比單層樣式，不再有卡片與左側色條", () => {
    // 「新對話」的卡片外觀讓它看起來像側欄唯一的主要動作，實際上只是導回首頁。
    expect(css).toContain(".ui-next-new{display:flex;align-items:center;border:0;background:transparent;box-shadow:none");
    expect(css).not.toContain(".ui-next-nav.is-active::before{");
    // 尺寸只斷言「四個第一層入口共用同一條規則」與字級，不寫死 px——
    // 寫死的話每次視覺微調都會假紅，而假紅久了就沒人看了。
    // ⚠ 這個 selector 出現兩次：平板 icon-only 的 media query 裡也有一條（font-size:0）。
    // 要的是桌機那條，用 min-height 認人，別直接取第一個匹配。
    const rowRules = [...css.matchAll(/\.ui-next-new,\.ui-next-search,\.ui-next-nav\{([^}]*)\}/g)].map((m) => m[1]);
    const rowRule = rowRules.find((body) => body.includes("min-height"));
    expect(rowRule).toBeTruthy();
    expect(rowRule).toMatch(/font-size:13px/);
    expect(rowRule).toMatch(/font-weight:400/);
    expect(rowRule).toMatch(/border-radius:(?:9|10)px/);
    // 最明確的 selected 底色只留給最深層的目前 Chat；祖先只加深文字。
    expect(css).toContain(".ui-next-nav.is-active{background:transparent;color:var(--sidebar-active);font-weight:500}");
    // selected 底色掛在整列（.ui-next-chat-row.is-active），不是掛在 button 上——
    // 掛 button 上時滑到右側 ⋮，button 失去 hover，整列底色會缺一塊。
    expect(css).toMatch(/\.ui-next-chat-row\.is-active\{background:color-mix\(in srgb,var\(--sidebar-active\) 10%,transparent\)\}/);
    expect(css).not.toMatch(/\.ui-next-project-chats button\.is-active\{/);
    // 籠統的 transition:all 會把 padding/height 這種不該動畫的屬性一起帶進來。
    expect(css).not.toMatch(/\.ui-next-(?:new|search|nav|project-chats button)[^{}]*\{[^{}]*transition:\s*all/);
    expect(css).toContain("translate:0 -2px");
    expect(css).toContain("@media(prefers-reduced-motion:reduce){.ui-next-new:hover");
  });

  test("專案清單延伸到側欄底部，且只有一層細捲軸", () => {
    // 原本 .ui-next-projects 鎖 30vh 又自己 overflow:auto：清單短時底下空一塊、
    // 長時變成「側欄捲軸裡還有一條專案捲軸」。捲動一律交給 .ui-next-sidebar-scroll。
    expect(css).toMatch(/\.ui-next-projects\{[^}]*max-height:none/);
    expect(css).toMatch(/\.ui-next-projects\{[^}]*overflow:visible/);
    expect(css).toContain(".ui-next-sidebar-scroll{min-height:0;flex:1;overflow:auto}");
    // 細捲軸兩套都要寫：scrollbar-width 是標準屬性，::-webkit-* 給舊版 Chromium。
    expect(css).toMatch(/\.ui-next-sidebar-scroll\{[^}]*scrollbar-width:thin/);
    expect(css).toMatch(/\.ui-next-sidebar-scroll\{[^}]*scrollbar-color:color-mix\(in srgb,var\(--sidebar-active\)/);
    expect(css).toContain(".ui-next-sidebar-scroll::-webkit-scrollbar{width:6px}");
    expect(css).toContain(".ui-next-sidebar-scroll::-webkit-scrollbar-track{background:transparent}");
    // 顏色走 --sidebar-active 而不是寫死，否則淺色模式下會是一條看不見（或死黑）的軌道。
    expect(css).toMatch(/::-webkit-scrollbar-thumb\{[^}]*background:color-mix\(in srgb,var\(--sidebar-active\)/);
  });

  test("⋮ 選單不被所在列的樣式污染，hover 也不位移", () => {
    // 選單是「列」的子節點，所以列的規則（padding/font-size/hover 上浮）會一路打進選單裡。
    // 實測後果：專案選單第一項變成 13px、左縮排 24px，和其他三項對不齊；
    // 對話選單則是 hover 每一項都往上跳 2px。兩者都要靠更高權重的 selector 擋住。
    expect(css).toMatch(/\.ui-next-project-head \.ui-next-row-menu button,\.ui-next-chat-row \.ui-next-row-menu button\{/);
    expect(css).not.toMatch(/(?:^|\})\.ui-next-row-menu button\{/);
    // hover 態必須壓過 .ui-next-project-chats button:not(.is-active):hover（同權重、且它在後面），
    // 所以要用 .has-menu 墊高一級。降回無 .has-menu 的寫法就會重現位移。
    expect(css).toMatch(/\.ui-next-project-head\.has-menu \.ui-next-row-menu button:hover,\.ui-next-chat-row\.has-menu \.ui-next-row-menu button:hover\{[^}]*translate:none/);
    // 選單開著時整列不上浮：選單是列的子節點，列一浮選單就跟著跳。
    expect(css).toMatch(/\.ui-next-project-head\.has-menu,\.ui-next-project-head\.has-menu:hover\{translate:none\}/);
    // 選單被後面的兄弟列蓋住就是看得到點不到（實測踩過）。
    expect(css).toMatch(/\.ui-next-project-head\.has-menu,\.ui-next-chat-row\.has-menu\{z-index:5\}/);
  });

  test("⋮ 平時不出現，但鍵盤 focus 時必須看得到", () => {
    // 只綁 :hover 的話，鍵盤使用者 Tab 到 ⋮ 時它仍是 opacity:0——焦點在一個隱形元素上。
    expect(css).toMatch(/\.ui-next-project-head:focus-within \.ui-next-row-more/);
    expect(css).toMatch(/\.ui-next-chat-row:focus-within \.ui-next-row-more/);
    expect(css).toMatch(/\.ui-next-project-head \.ui-next-row-more,\.ui-next-chat-row \.ui-next-row-more\{[^}]*opacity:0/);
    // dots 圖示要真的是三個點：原本只畫一個圓，畫面上是一顆點而不是「更多操作」。
    expect(uiNext).toMatch(/name==='dots'[^>]*><circle cx="12" cy="5"[^>]*\/><circle cx="12" cy="12"[^>]*\/><circle cx="12" cy="19"/);
  });

  test("側欄沒有任何展開箭頭，展開改由點名稱本身觸發", () => {
    // 箭頭全面移除：DOM 與 CSS 都不該再留下它，否則 :last-child 這類選擇器會誤套到別人身上。
    expect(uiNext).not.toContain("ui-next-nav-toggle");
    // 只檢查專案樹那一段：chevron-down/up 仍是「更多工具」「帳號與設定」在用的圖示，
    // 對整份檔案做反向斷言會連它們一起擋掉。
    const tree = uiNext.slice(uiNext.indexOf('<div class="ui-next-nav-group">'), uiNext.indexOf('<div class="ui-next-bottom">'));
    expect(tree).toBeTruthy();
    expect(tree).toContain('class="ui-next-projects"');
    expect(tree).not.toContain("chevron-down");
    expect(tree).not.toContain("chevron-up");
    expect(css).not.toContain("ui-next-nav-row");
    // ⚠ 專案列只剩名稱一個 button 時，button:last-child 會選中名稱自己。
    // 曾因此把名稱設成絕對定位 → 整列高度塌成 0、點不到（實測踩過），不准再出現。
    expect(css).not.toContain(".ui-next-project-head button:last-child");
    // 點名稱是展開／收合，不是導航——所以它必須是 button 綁 toggleProject，不是 router-link。
    expect(uiNext).toMatch(/<button @click="toggleProject\(project\)" :aria-expanded="!!expandedProjects\[project\.id\]">/);
  });

  test("首頁專案選擇器保留最後專案，並區分載入、錯誤與真實測試環境狀態", () => {
    expect(uiNext).toContain("oaa.next.last-project-id");
    // 容許附加 class：這個容器現在同時是 composer 底排的一個 chip（圖示＋文字＋下拉）。
    expect(uiNext).toMatch(/class="ui-next-project-picker[ "]/);
    expect(uiNext).toContain('role="listbox"');
    expect(uiNext).toContain("onProjectPickerKeydown(event)");
    // ⚠ 環境狀態那行小字已依使用者要求從畫面移除，但狀態本身仍要讀得到、錯誤仍要分得出來
    //（下面兩條守的是那個，不是「畫面上有沒有那行字」）。
    expect(uiNext).toContain("測試環境狀態讀取失敗");
    expect(uiNext).toContain('Api.get(`projects/${this.projectId}/env/summary`)');
  });

  test("任務詳情是單欄對話：需求進對話第一則、執行歷程走跳窗、沒有頁籤", () => {
    // 三個頁籤收掉了：需求本文變成對話的第一則（含主附件與就地編輯的入口），
    // 執行歷程改成跳窗。頁面因此只剩「固定頂欄 ＋ 對話 ＋ 底部對話框」，與聊天頁同構。
    expect(uiNextPages).not.toContain("setTaskTab(");
    expect(uiNextPages).not.toContain('class="ui-next-task-tabs" role="tablist"');
    expect(uiNextPages).toContain("isRequirement: true");
    expect(uiNextPages).toContain("row.isRequirement&&canEditContent");   // 編輯需求的入口跟著搬進對話
    expect(uiNextPages).toContain("openEvents()");
    expect(uiNextPages).toContain('class="ui-next-events-modal"');
    expect(uiNextPages).toContain('ui-next-task-topbar');
    expect(uiNextPages).toContain("is-tab-conversation");
    expect(uiNextPages).toContain('eventSummary(event)');
    expect(uiNextPages).toContain('toggleEvent(event)');
    expect(uiNextPages).not.toContain("'/task/'+task.id+'/terminal'");
    expect(uiNextPages).toContain('eventsError');
    expect(uiNextPages).toContain('ui-next-event-summary');
    expect(pagesCss).toContain('.ui-next-task-detail-grid.is-tab-conversation{grid-template-columns:minmax(0,1fr)}');
    expect(pagesCss).toContain('.ui-next-task-detail-grid.is-tab-conversation .ui-next-task-side{grid-column:1}');
  });

  test("任務詳情與管理頁的主要操作維持在頁首，新增使用者改用彈窗", () => {
    const users = viewSrc("UiNextAdminUsersView");
    expect(uiNextPages).toContain("task.status==='done'&&!task.is_hidden");
    expect(uiNextPages).toContain('<ui-next-icon name="arrow-left"/> 返回');
    expect(uiNextPages).not.toContain("task.project_name || '專案任務'");
    expect(users).toContain('addUserOpen: false');
    expect(users).toContain('@click="addUserOpen=true"');
    expect(users).toContain('class="ui-next-user-create"');
    expect(users).not.toContain('<h2 class="section-title">新增使用者</h2>');
    expect(uiNextPages).toContain('<h1 class="page-title">系統設定</h1>');
    expect(uiNextPages).toContain('page-header ui-next-admin-page-head');
  });

  test("Agent 管理首次開啟時預設顯示 CLAUDE.md，全域健檢預填仍優先", () => {
    const agents = viewSrc("UiNextAdminAgentsView");
    expect(agents).toContain("const name = this.$route.query.prefill;");
    expect(agents).toContain("await this.select({ name: 'CLAUDE' });");
    expect(agents).toContain("if (name) {");
  });

  test("Chat Thread 使用單一 Composer 並提供原始程式碼複製", () => {
    expect(uiNext).toContain("window.renderNextMarkdown");
    expect(uiNext).toContain("navigator.clipboard.writeText(code)");
    expect(uiNext).toContain('data-copy-code="true"');
    expect(uiNextPages).toContain('@click="handleMessageClick"');
    expect(uiNextPages).toContain('@click="handleTaskMessageClick"');
    expect(pagesCss).toContain(".ui-next-code-block{");
    expect(pagesCss).toContain(".ui-next-thread-messages{min-height:0;max-height:none;flex:1 0 auto;overflow:visible");
    expect(pagesCss).toContain(".ui-next-main:has(> .ui-next-chat-page){padding-bottom:0}");
    expect(pagesCss).toContain("box-shadow:var(--shadow-lg),inset 0 0 0 1px color-mix(in srgb,var(--text) 22%,transparent)");
    expect(pagesCss).toContain(".ui-next-thread-composer::before{display:none}");
    expect(pagesCss).toContain(".ui-next-task-detail-grid.is-tab-conversation .ui-next-task-content-column{align-content:start}");
  });

  test("Chat 輪詢只在訊息真的變更時更新畫面", () => {
    const chat = viewSrc("UiNextProjectChatView");
    expect(chat).toContain("await this.loadMessages(this.requestId, { background: true })");
    expect(chat).toContain("const shouldFollow = !background || this.isMessagesNearBottom()");
    expect(chat).toContain("if (changed) this.messages = nextMessages");
    expect(chat).toContain("if (changed && shouldFollow) this.$nextTick(() => this.scrollToBottom())");
    expect(chat).toContain('const element = document.querySelector(".ui-next-main")');
  });

  test("任務對話框可縮小且不清除尚未送出的內容", () => {
    const task = viewSrc("UiNextTaskDetailView");
    expect(task).toContain("taskActionCollapsed: false");
    expect(task).toContain("<template v-if=\"!taskActionCollapsed\">");
    expect(task).toContain("taskActionCollapsed=!taskActionCollapsed");
    expect(task).toContain("taskActionCollapsed?'展開任務對話框':'縮小任務對話框'");
    expect(pagesCss).toContain(".ui-next-task-action-collapse{");
    expect(pagesCss).toContain(".ui-next-task-action.is-collapsed{");
  });

  test("對話歷程是可 Escape 與 focus trap 的右側 Drawer", () => {
    expect(uiNextPages).toContain('ref="historyDrawer"');
    expect(uiNextPages).toContain("onHistoryKeydown(event)");
    expect(uiNextPages).toContain("this.closeHistory(); return;");
    expect(pagesCss).toContain("inset: 0 0 0 auto;");
    expect(pagesCss).toContain("width: min(380px, 100vw);");
  });

  test("有內容的專案對話專注訊息與 Composer，建立任務緊鄰上傳附件", () => {
    const chat = viewSrc("UiNextProjectChatView");
    const activeChat = chat.slice(chat.indexOf('<template v-if="activeChat">'), chat.indexOf('<template v-else>'));
    expect(activeChat).not.toContain('ui-next-thread-head');
    // 專案名回來了，但只能是 composer 底排的一個唯讀 chip（與首頁同一組樣式）——追問幾輪
    // 之後「這是在問哪個專案的哪個庫」是最常忘的事（使用者要求）。原本整條禁掉是為了擋
    // 大標題，那個仍然禁著（上一行）。
    expect(activeChat).toMatch(/ui-next-chip-static">[^<]*<ui-next-icon name="project"\/>\{\{ projectName \}\}/);
    expect(activeChat).toContain('title="建立任務" aria-label="建立任務"');
    expect(activeChat).toContain('<ui-next-icon name="plus"/>');
    expect(activeChat).toContain('title="上傳圖片"');
  });

  test("Chat 建立任務 Overlay 可關閉、圈限焦點並保留失敗內容", () => {
    const chat = viewSrc("UiNextProjectChatView");
    expect(chat).toContain('onTaskModalKeydown(event)');
    expect(chat).toContain('ref="chatTaskModal"');
    expect(chat).toContain('closeTaskModal()');
    expect(chat).toContain('建立任務失敗，請重試。');
    expect(chat).toContain('role="alert"');
    expect(chat).toContain('class="ui-next-task-drafting" role="status"');
    expect(chat).toMatch(/this\.showTaskModal = true;[\s\S]{0,180}draft-task/);
  });

  test("首頁與 Chat 都用 Enter 送出、Shift+Enter 換行", () => {
    const chat = viewSrc("UiNextProjectChatView");
    expect(uiNext).toContain('@keydown.enter.exact.prevent="send"');
    expect(uiNext).not.toContain('@keydown.ctrl.enter.prevent="send"');
    expect(chat).toContain('@keydown.enter="handleEnter"');
    expect(chat).toContain('!event.shiftKey');
  });

  test("規格書 QA 使用可辨識選擇卡與自由回答欄", () => {
    const task = viewSrc("UiNextTaskDetailView");
    expect(task).toContain('class="ui-next-qa-options"');
    expect(task).toContain('class="ui-next-qa-custom-answer"');
    // 說明走 placeholder 而不是另一行標題：多一行標題這張卡就比選項卡高一截
    expect(task).toContain('placeholder="以上選項都不適合？直接寫下你的答案或補充說明"');
    expect(task).not.toContain('ui-next-qa-custom-answer-heading');
    expect(pagesCss).toContain('.ui-next-qa-options label.selected');
    // 這一欄與上面兩張選項卡用同一組框（1px --border、10px 圓角、10/11 內距、--surface 底），
    // 三者才讀得出是同一層級的選項；不是裸 textarea，也不是另一種尺寸的框。
    expect(pagesCss).toContain('.ui-next-qa-custom-answer{display:grid;margin-top:6px;padding:10px 11px;border:1px solid var(--border);border-radius:10px;background:var(--surface)');
  });

  test("規格書 QA 提問是單一 Composer：由動作面板本身提供，不再套內層框", () => {
    const task = viewSrc("UiNextTaskDetailView");
    expect(task).toContain('class="ui-next-qa-ask-foot"');
    expect(task).toContain('@submit.prevent="submitAsk"');
    expect(task).not.toContain('看不懂、要補充、或方向要改都在這裡講');
    // 內層框連同它的 CSS 一起移除，兩邊都不許復活（留著就會有人照舊把 class 加回去）
    expect(task).not.toContain('ui-next-qa-ask-composer');
    expect(pagesCss).not.toContain('ui-next-qa-ask-composer');
    // 取而代之：面板自己就是 composer，顏色與陰影照 .ui-next-thread-composer（--shadow-lg、
    // 22%／focus 36%）。⚠ 線用真 border 不是 inset shadow——分頁的線要對得上它，只要一邊
    // 用 inset、一邊用 border 就永遠差一個 border 寬度，接縫處看起來是斷的。
    // 底色走 --ui-next-composer-bg（三處 composer 共用，見比照 AskMe 那組）；邊框與陰影不變
    expect(pagesCss).toContain('.ui-next-task-action{border-radius:22px;border:1px solid color-mix(in srgb,var(--text) 22%,var(--surface));background:var(--ui-next-composer-bg,var(--surface));box-shadow:var(--shadow-lg)');
  });

  test("規格問答的題目頁籤接在動作面板上緣，最後一個是提問", () => {
    const task = viewSrc("UiNextTaskDetailView");
    expect(task).toContain('class="ui-next-q-tabs"');
    expect(task).toContain('ui-next-q-tab-ask');
    // 頁籤要在面板之前＝掛在框外上方，而不是框內又一層
    expect(task.indexOf('ui-next-q-tabs')).toBeLessThan(task.indexOf('ui-next-panel ui-next-task-action'));
    // 舊的「規格書 QA／提問」那層併掉了：兩層頁籤疊在框裡分不出哪層是哪層
    expect(task).not.toContain('>規格書 QA</button>');
    // Chrome 分頁的模型：分頁列是頁面底色，選中的那一頁換成框的底色並長出上圓角。
    // -15px 抵掉 .ui-next-task-side 的 grid gap:14px（只用 -1px 會留 18px 的縫）。
    // -14px 讓分頁列底貼齊框頂但「不重疊」：重疊的話未選中分頁的底色會蓋掉框的上緣線，
    // 框看起來就沒有上緣。只有選中的那一頁用自己的 -1px 往下疊去蓋。
    expect(pagesCss).toContain('margin:0 auto -14px');
    // 選中那一頁換成框的底色（深色下 --surface 比 --bg 亮一階），才會讀成「同一塊」
    expect(pagesCss).toMatch(/\.ui-next-q-tabs button\.active\{[^}]*background:var\(--surface\)/);
    // 分頁是方角（使用者定案），不是膠囊
    expect(pagesCss).not.toMatch(/\.ui-next-q-tabs button\{[^}]*border-radius:999px/);
    // 分頁的線也用真 border（上／左／右，底部不封口），與框同一層級才對得齊
    expect(pagesCss).toMatch(/\.ui-next-q-tabs button\{[^}]*border:1px solid color-mix\(in srgb,var\(--text\) 22%,var\(--surface\)\);border-bottom:0/);
    // 框的邊框維持完整、只收上圓角：上緣線在分頁右側那一大段是必須存在的，整條拿掉會讓
    // 框看起來沒有上緣。接縫改由選中的分頁往下疊 1px 蓋掉（Chrome 的作法）。
    // 只收左上角：分頁只佔左邊一小段，右上角仍要圓

    // 反圓角隨方角一起移除：那兩塊是用來把圓角平滑接進框的，方角不需要
    expect(pagesCss).not.toContain('.ui-next-q-tabs button.active::before');
    // 每一頁都往下疊 1px 蓋掉框的上緣線：分頁與框之間屬於形狀內部，不該有線；
    // 那條線只在最後一頁右側之後才算外圍。相鄰兩頁 -1px 共用一條邊。
    // 分頁不往下疊：疊下去的話左右 border 會跟著多出一截，線頭懸在框裡沒有收尾。
    // 左緣 -1px 讓相鄰兩頁共用一條邊。
    expect(pagesCss).toMatch(/\.ui-next-q-tabs button\{[^}]*margin:0 0 0 -1px/);
    // 框的 border 維持完整（右上圓角要留），只收左上角；分頁底下那一段由分頁自己的遮罩蓋掉。
    // ⚠ 遮罩 2px 不是 1px：--ui-zoom≈1.1，1px 蓋不滿 1.1px 的線。
    expect(pagesCss).toContain('.ui-next-task-side:has(.ui-next-q-tabs) .ui-next-task-action{border-top-left-radius:0}');
    expect(pagesCss).toContain('.ui-next-q-tabs button::after{content:"";position:absolute;left:0;right:0;bottom:-2px;height:2px;background:var(--bg)}');
    expect(pagesCss).toContain('.ui-next-q-tabs button.active::after{background:var(--surface)}');

    // 上緣圓角保留、下緣不封口＝分頁的形狀（使用者定案：只移除下方那對反圓角）
    expect(pagesCss).toMatch(/\.ui-next-q-tabs button\{[^}]*border-radius:9px 9px 0 0/);
    // 分頁是一條連續的列，不是幾顆分開的按鈕
    expect(pagesCss).toMatch(/\.ui-next-q-tabs\{[^}]*gap:0/);
  });

  test("專案建立表單有可見 label、資料夾即時驗證、取消與搜尋清除", () => {
    const projects = viewSrc("UiNextProjectListView");
    expect(projects).toContain('folderNameError()');
    expect(projects).toContain('openAddForm()');
    expect(projects).toContain('closeAddForm()');
    expect(projects).toContain('id="project-folder-help"');
    expect(projects).toContain('清除搜尋');
    expect(projects).toContain("project.is_favorite?'star-filled':'star'");
    expect(projects).toMatch(/<button v-if="project\.description"[^>]*class="ui-next-project-open ui-next-project-note"/);
    expect(projects).toContain('<div v-else class="ui-next-project-note is-empty" aria-hidden="true">');
    // 備註排在標籤（facts）之後
    expect(projects.indexOf('ui-next-project-note')).toBeGreaterThan(projects.indexOf('ui-next-project-facts'));
    expect(projects).not.toContain('尚未填寫專案描述。');
    expect(projects).not.toContain('專案工作原則');
    expect(projects).not.toContain('快捷操作');
    expect(projects).toContain('<header class="ui-next-project-card-title">');
    expect(projects).toContain('<button class="ui-next-project-title-open"');
    expect(projects).toContain("{{ project.name }} <small>Odoo {{ project.odoo_version }}");
    expect(projects).not.toContain('ui-next-project-card-meta');
    expect(projects).toContain('ui-next-project-more-menu');
    // ⋮ 的前段與側欄 ⋮ 同順序（測試區／上正式／REPO／連線設定／專案設定），
    // 側欄沒有的往後放。這裡只斷言入口都在，不綁順序以外的實作細節。
    ['測試區', '上正式', 'REPO', '連線設定', '專案設定', '問答', 'Wiki', '部署 SOP'].forEach((label) =>
      expect(projects).toContain(`>${label}</button>`));
    // 卡片下方那排按鈕已整個收掉，剩下的入口只有標題列的 ⋮。
    expect(projects).not.toMatch(/<footer>\s*<button @click="openEnv/);
    expect(projects).toContain('goTab(id, tab)');
    expect(projects).toContain('/projects/${id}?tab=${tab}');
    expect(projects).not.toContain('>資料庫查詢</button>');
    expect(projects).toContain('_onProjectMoreOutside');
  });
});
