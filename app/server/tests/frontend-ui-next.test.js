const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8');

describe('ui-next 平行介面', () => {
  const index = read('index.html');
  const app = read('js/app.js');
  const uiNext = read('js/ui-next/UiNextApp.js');
  const uiNextPages = read('js/ui-next/UiNextPages.js');
  const css = read('css/ui-next.css');
  const pagesCss = read('css/ui-next-pages.css');

  test('只在網址帶 ui=next 時選用新版根介面', () => {
    expect(uiNext).toContain("query.get('ui') === 'next'");
    expect(app).toContain('const RootApp = window.UiNextEnabled ? window.UiNextApp : App;');
  });

  test('新版資產獨立載入，且所有 CSS 規則皆有 ui-next 範圍', () => {
    expect(index).toContain('css/ui-next.css');
    expect(index).toContain('css/ui-next-pages.css');
    expect(index).toContain('js/ui-next/UiNextApp.js');
    expect(index).toContain('js/ui-next/UiNextPages.js');
    expect(css).toContain('.ui-next-shell');
    expect(pagesCss).toContain('.ui-next-chat-page');
  });

  test('Pipeline 與用量報表使用新版 View，而非沿用舊版 DOM', () => {
    expect(app).toContain('window.UiNextEnabled ? window.UiNextTokenReportView : window.TokenReportView');
    expect(app).toContain('window.UiNextEnabled ? window.UiNextPipelineView : window.AdminPipelinesView');
    expect(app).toContain('window.UiNextEnabled ? window.UiNextProjectChatView : window.ProjectChatView');
    expect(app).toContain('window.UiNextEnabled ? window.UiNextTaskListView : window.TaskListView');
    expect(app).toContain('window.UiNextEnabled ? window.UiNextProjectListView : window.ProjectListView');
    expect(uiNextPages).toContain("name: 'UiNextTokenReportView'");
    expect(uiNextPages).toContain("name: 'UiNextPipelineView'");
    expect(uiNextPages).toContain("name: 'UiNextProjectChatView'");
    expect(uiNextPages).toContain("name: 'UiNextTaskListView'");
    expect(uiNextPages).toContain("name: 'UiNextProjectListView'");
  });

  test('新版入口保留既有 Chat API、附件與自動標題流程', () => {
    expect(uiNext).toContain('projects/${this.projectId}/chats');
    expect(uiNext).toContain('Api.postForm');
    expect(uiNext).toContain('chatTitle(this.prompt)');
    expect(uiNext).toContain('projects/${id}/chats');
    expect(uiNext).toContain("chat.title || '新對話'");
  });

  test('收件匣不進新版日常導覽，新手教學位於更多工具', () => {
    expect(uiNext).not.toMatch(/go\('\/inbox'\)/);
    expect(uiNext).toContain('新手教學');
    expect(uiNext).toContain('window.TourManager.open()');
    expect(uiNext).toContain("go('/admin/pipelines')");
    expect(uiNext).toContain("go('/token-report')");
  });

  test('既有 View 的通知、確認視窗、教學與主題切換在新版殼層仍可用', () => {
    expect(app).toContain('window.appToasts = toasts');
    expect(uiNext).toContain('toasts: window.appToasts');
    expect(uiNext).toContain('<confirm-dialog-host />');
    expect(uiNext).toContain('<tour-host />');
    expect(uiNext).toContain('window.ThemeManager.toggle()');
  });

  test('除收件匣外，既有功能路由仍由同一個 router 提供給新版殼層', () => {
    [
      "'/tasks'", "'/task/:id'", "'/task/:id/terminal'", "'/projects'", "'/projects/:id'",
      "'/projects/:id/chat'", "'/projects/:id/chat/:chatId'", "'/projects/:id/wiki'", "'/projects/:id/wiki/:slug'",
      "'/projects/:id/db'", "'/projects/:id/deploy-sop'", "'/settings'", "'/token-report'", "'/architecture'",
      "'/pipeline-flow'", "'/admin'", "'/admin/users'", "'/admin/agents'", "'/admin/schedules'", "'/admin/pipelines'",
      "'/admin/health'", "'/admin/rejections'", "'/admin/classify-samples'", "'/admin/prompt-logs'", "'/admin/port-pool'",
      "'/admin/enterprise'"
    ].forEach(route => expect(app).toContain(route));
    expect(uiNext).toContain('<router-view />');
  });

  test('日常頁面與工具頁都有 ui-next 範圍內的視覺覆寫', () => {
    [
      '.task-card', '.project-card', '.chat-main', '.settings-section', '.wiki-body',
      '.terminal-body', '.flow-diagram-panel', '.tr-table-card', '.nav-card'
    ].forEach(selector => expect(css).toContain(`.ui-next-main ${selector}`));
  });
});
