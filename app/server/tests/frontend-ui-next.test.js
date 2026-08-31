const fs = require("fs");
const path = require("path");

const read = (file) =>
  fs.readFileSync(path.join(__dirname, "../../public", file), "utf8");

describe("ui-next 平行介面", () => {
  const index = read("index.html");
  const app = read("js/app.js");
  const uiNext = read("js/ui-next/UiNextApp.js");
  const uiNextPages = read("js/ui-next/UiNextPages.js");
  const css = read("css/ui-next.css");
  const pagesCss = read("css/ui-next-pages.css");

  test("只在網址帶 ui=next 時選用新版根介面", () => {
    expect(uiNext).toMatch(/query\.get\(["']ui["']\) === ["']next["']/);
    expect(app).toContain(
      "const RootApp = window.UiNextEnabled ? window.UiNextApp : App;",
    );
  });

  test("新版資產獨立載入，且所有 CSS 規則皆有 ui-next 範圍", () => {
    expect(index).toContain("css/ui-next.css");
    expect(index).toContain("css/ui-next-pages.css");
    expect(index).toContain("js/ui-next/UiNextApp.js");
    expect(index).toContain("js/ui-next/UiNextPages.js");
    expect(css).toContain(".ui-next-shell");
    expect(pagesCss).toContain(".ui-next-chat-page");
    expect(index).toContain("get('ui') === 'next'");
    expect(index).toContain("document.write('<link rel=\"stylesheet\" href=\"css/ui-next.css\">");
  });

  test("Next CSS 的每個 selector 都有專用 scope，不會污染 Legacy DOM", () => {
    const selectors = (source) => {
      const out = [], clean = source.replace(/\/\*[\s\S]*?\*\//g, "");
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
    expect(uiNext).toContain("@keydown.meta.enter.prevent");
  });

  test("Chat 採用問答主畫面，對話紀錄改為按需展開", () => {
    expect(uiNextPages).toContain('showHistory: false');
    expect(uiNextPages).toContain('對話紀錄');
    expect(uiNextPages).toContain('ui-next-chat-history');
    expect(uiNextPages).toContain('ui-next-thread-composer');
    expect(pagesCss).toContain('.ui-next-chat-page {\n  display: block;');
    expect(pagesCss).toContain('.ui-next-chat-history {');
  });

  test("收件匣不進新版日常導覽，新手教學位於更多工具", () => {
    expect(uiNext).not.toMatch(/go\(["']\/inbox["']\)/);
    expect(app).toContain('redirect: window.UiNextEnabled ? "/tasks?tab=needs_action" : undefined');
    expect(uiNextPages).toContain("this.$route.query.tab");
    expect(uiNext).toContain("新手教學");
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
      "UiNextDiagramView",
      "UiNextAdminView",
      "UiNextAdminToolView",
      "UiNextToolFrame",
    ].forEach((name) =>
      expect(uiNextPages).toMatch(new RegExp(`name:\\s*["']${name}["']`)),
    );
    expect(app).toMatch(/nextAdminTool\(\s*window\.AdminUsersView/);
    expect(app).toMatch(/nextTool\(\s*window\.ProjectDbQueryView/);
    expect(app).toMatch(/nextTool\(\s*window\.TerminalView/);
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
  });

  test("動態 HTML 容器不保留子節點，避免 Vue 在進入詳情頁時拒絕編譯", () => {
    expect(uiNextPages).toContain('v-html="renderMd(message.content)" v-show="message.content"></div>');
    expect(uiNextPages).toContain('v-html="ansiToHtml(event.content)"></pre>');
  });

  test("P0：Next 權限、篩選與 Chat route 不會退回 Legacy 或白屏", () => {
    expect(app).not.toContain("window.location.replace(");
    expect(app).toContain('query: { redirect: to.fullPath }');
    expect(app).toContain('return "/forbidden"');
    expect(uiNext).toContain('<router-view :key="$route.fullPath" />');
    expect(uiNextPages).toContain("statusOptions()");
    expect(uiNextPages).not.toContain("window.STATUS_LABELS\" :key");
    expect(uiNextPages).toContain("開始新對話");
    expect(uiNextPages).not.toMatch(/window\.ProjectChatView\.(?:data|computed|watch|methods|created)/);
    expect(uiNextPages).toContain('requestId !== this.requestId');
  });

  test("已移轉的專案清單與設定頁不再委派 Legacy View", () => {
    ["ProjectListView", "SettingsView", "ProjectChatView", "TaskListView"].forEach((name) => {
      expect(uiNextPages).not.toMatch(
        new RegExp(`window\\.${name}\\.(?:data|computed|watch|methods|created|mounted|beforeUnmount|unmounted)`),
      );
    });
    const projectDetail = uiNextPages.slice(
      uiNextPages.indexOf('name: "UiNextProjectDetailView"'),
      uiNextPages.indexOf('name: "UiNextTaskDetailView"'),
    );
    expect(projectDetail).not.toMatch(
      /window\.ProjectDetailView\.(?:data|computed|watch|methods|created|mounted|beforeUnmount|unmounted)/,
    );
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
    expect(css).toContain(".ui-next-shell{height:100vh;min-height:100vh;overflow:hidden}");
    expect(css).toContain(".ui-next-sidebar-scroll{min-height:0;flex:1;overflow:auto}");
    expect(pagesCss).toContain("safe-area-inset-bottom");
  });

  test("Pipeline Monitor 在背景頁籤停止輪詢，回到前景立即更新", () => {
    expect(uiNextPages).toContain('document.addEventListener("visibilitychange", this._onVisibility)');
    expect(uiNextPages).toContain("if (document.hidden) this.stopPolling()");
    expect(uiNextPages).toContain("else { this.load(); this.startPolling(); }");
  });
});
