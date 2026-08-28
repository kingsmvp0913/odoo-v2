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
  });

  test("Pipeline 與用量報表使用新版 View，而非沿用舊版 DOM", () => {
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
    expect(uiNextPages).toContain("methods: window.ProjectDetailView.methods");
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
});
