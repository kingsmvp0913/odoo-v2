// 意圖：AI 容器隔離開關原本只能用指令改（PUT /api/admin/agent-sandbox，後端限管理員，見 admin-routes 測試）。
// 管理員設定頁補一個區塊讓使用者自己切。PUT 是整組覆寫：少帶 memory／cpus／pids 會被清成 NULL，
// 下一次 AI 執行立刻因「上限未設定」失敗——所以儲存時必須把讀回來的上限原樣帶上。
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ui-next', 'pages', 'AdminSettings.js'), 'utf8');

test('區塊在「進階」分頁，四種模式都可選', () => {
  expect(page).toMatch(/v-show="settingsTab==='adv'" class="setting-block">\s*<div class="setting-block-head">\s*<div class="setting-block-title">AI 容器隔離<\/div>/);
  for (const m of ['off', 'internal', 'projects', 'all']) expect(page).toContain(`value="${m}"`);
});

test('儲存帶齊上限（整組覆寫）與專案清單', () => {
  const save = page.match(/async saveAgentSandbox\(\)[\s\S]*?\n {6}\},/);
  expect(save).not.toBeNull();
  expect(save[0]).toContain("Api.put('admin/agent-sandbox'");
  for (const k of ['memory', 'cpus', 'pids', 'gateway_memory', 'gateway_cpus', 'gateway_pids', 'project_ids', 'mode']) {
    expect(save[0]).toContain(k);
  }
});

test('只在 projects 模式顯示專案勾選；切到 all 前要確認', () => {
  expect(page).toMatch(/v-if="agentSandbox\.mode==='projects'"/);
  expect(page).toMatch(/mode === 'all'[\s\S]{0,200}confirm/);
});
