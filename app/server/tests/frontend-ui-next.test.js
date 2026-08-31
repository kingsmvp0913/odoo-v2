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
    expect(css).toContain('.ui-next-task-rich-head h2 a{color:#fff}');
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
    const projectDetail = uiNextPages.slice(
      uiNextPages.indexOf('name: "UiNextProjectDetailView"'),
      uiNextPages.indexOf('name: "UiNextTaskDetailView"'),
    );
    expect(projectDetail).not.toMatch(
      /window\.ProjectDetailView\.(?:data|computed|watch|methods|created|mounted|beforeUnmount|unmounted)/,
    );
  });

  test("Wiki 新增頁面視窗保留焦點、取消與失敗回饋", () => {
    const wiki = uiNextPages.slice(
      uiNextPages.indexOf('name: "UiNextWikiView"'),
      uiNextPages.indexOf('name: "UiNextDeploySopView"'),
    );
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
  });

  test("首頁專案選擇器保留最後專案，並區分載入、錯誤與真實測試環境狀態", () => {
    expect(uiNext).toContain("oaa.next.last-project-id");
    expect(uiNext).toContain('class="ui-next-project-picker"');
    expect(uiNext).toContain('role="listbox"');
    expect(uiNext).toContain("onProjectPickerKeydown(event)");
    expect(uiNext).toContain("測試環境狀態讀取失敗");
    expect(uiNext).toContain('Api.get(`projects/${this.projectId}/env/summary`)');
  });

  test("任務詳情以三個可還原 query 的頁籤分離需求、對話與執行歷程", () => {
    expect(uiNextPages).toContain("taskTab: 'requirements'");
    expect(uiNextPages).toContain("['requirements', 'conversation', 'history']");
    expect(uiNextPages).toContain("setTaskTab(tab)");
    expect(uiNextPages).toContain("@click=\"setTaskTab('requirements')\"");
    expect(uiNextPages).toContain("@click=\"setTaskTab('conversation')\"");
    expect(uiNextPages).toContain("@click=\"setTaskTab('history')\"");
    expect(uiNextPages).toContain("is-tab-'+taskTab");
    expect(uiNextPages).toContain('eventSummary(event)');
    expect(uiNextPages).toContain('toggleEvent(event)');
    expect(uiNextPages).toContain('eventsError');
    expect(uiNextPages).toContain('ui-next-event-summary');
    expect(pagesCss).toContain('.ui-next-task-detail-grid.is-tab-conversation{grid-template-columns:minmax(0,1fr)}');
    expect(pagesCss).toContain('.ui-next-task-detail-grid.is-tab-conversation .ui-next-task-side{grid-column:1}');
  });

  test("Chat Thread 使用單一 Composer 並提供原始程式碼複製", () => {
    expect(uiNext).toContain("window.renderNextMarkdown");
    expect(uiNext).toContain("navigator.clipboard.writeText(code)");
    expect(uiNext).toContain('data-copy-code="true"');
    expect(uiNextPages).toContain('@click="handleMessageClick"');
    expect(uiNextPages).toContain('@click="handleTaskMessageClick"');
    expect(pagesCss).toContain(".ui-next-code-block{");
    expect(pagesCss).toContain(".ui-next-thread-messages{min-height:0;flex:1;overflow:auto");
  });

  test("對話歷程是可 Escape 與 focus trap 的右側 Drawer", () => {
    expect(uiNextPages).toContain('ref="historyDrawer"');
    expect(uiNextPages).toContain("onHistoryKeydown(event)");
    expect(uiNextPages).toContain("this.closeHistory(); return;");
    expect(pagesCss).toContain("inset: 0 0 0 auto;");
    expect(pagesCss).toContain("width: min(380px, 100vw);");
  });

  test("Chat 建立任務 Overlay 可關閉、圈限焦點並保留失敗內容", () => {
    const chat = uiNextPages.slice(
      uiNextPages.indexOf('name: "UiNextProjectChatView"'),
      uiNextPages.indexOf('name: "UiNextProjectDetailView"'),
    );
    expect(chat).toContain('onTaskModalKeydown(event)');
    expect(chat).toContain('ref="chatTaskModal"');
    expect(chat).toContain('closeTaskModal()');
    expect(chat).toContain('建立任務失敗，請重試。');
    expect(chat).toContain('role="alert"');
  });

  test("專案建立表單有可見 label、資料夾即時驗證、取消與搜尋清除", () => {
    const projects = uiNextPages.slice(
      uiNextPages.indexOf('name: "UiNextProjectListView"'),
      uiNextPages.indexOf('name: "UiNextWikiView"'),
    );
    expect(projects).toContain('folderNameError()');
    expect(projects).toContain('openAddForm()');
    expect(projects).toContain('closeAddForm()');
    expect(projects).toContain('id="project-folder-help"');
    expect(projects).toContain('清除搜尋');
    expect(projects).toContain("project.is_favorite?'star-filled':'star'");
    expect(projects).toContain('<p v-if="project.description">');
    expect(projects).not.toContain('尚未填寫專案描述。');
    expect(projects).not.toContain('專案工作原則');
    expect(projects).not.toContain('快捷操作');
    expect(projects).toContain('<header class="ui-next-project-card-title">');
    expect(projects).toContain('<button class="ui-next-project-title-open"');
    expect(projects).toContain("{{ project.name }} <small>Odoo {{ project.odoo_version }}");
    expect(projects).not.toContain('ui-next-project-card-meta');
    expect(projects).toContain('ui-next-project-more-menu');
    expect(projects).toContain('goDb(id)');
    expect(projects).toContain('goDeploySop(id)');
    expect(projects).toContain('openRelease(id)');
    expect(projects).toContain('_onProjectMoreOutside');
  });
});
