// 意圖：AI 容器的資源上限只能在管理員設定頁改。PUT 是整組覆寫：少帶 memory／cpus／pids 會被清成
// NULL，下一次 AI 執行立刻因「上限未設定」失敗——所以儲存時必須把讀回來的上限原樣帶上。
//
// 2026-09-24 拿掉舊的非容器路徑之後，這一區**不可以**再有「要不要進容器」的開關。
// 下面那條守著這件事：留一顆撥得動的模式選鈕，等於留一個「撥下去就靜默取消隔離」的位置，
// 而走那條路的 AI 是用平台訂閱跑客戶的工作，不會報錯，只會出現在月底帳單上。
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ui-next', 'pages', 'AdminSettings.js'), 'utf8');

test('區塊在「進階」分頁，標題講的是資源上限', () => {
  expect(page).toMatch(/v-show="settingsTab==='adv'" class="setting-block">\s*<div class="setting-block-head">\s*<div class="setting-block-title">AI 容器資源上限<\/div>/);
});

test('沒有任何「要不要進容器」的開關（撥得動就是後門）', () => {
  const block = page.match(/AI 容器資源上限[\s\S]*?agentSandbox\.limits\.pids[\s\S]*?<\/div>/);
  expect(block).not.toBeNull();
  for (const m of ['off', 'internal', 'projects', 'all']) {
    expect(block[0]).not.toContain(`value="${m}"`);
  }
  expect(page).not.toContain('agentSandbox.mode');
});

test('儲存帶齊兩組上限（整組覆寫），且不再送 mode／project_ids', () => {
  const save = page.match(/async saveAgentSandbox\(\)[\s\S]*?\n {6}\},/);
  expect(save).not.toBeNull();
  expect(save[0]).toContain("Api.put('admin/agent-sandbox'");
  for (const k of ['memory', 'cpus', 'pids', 'gateway_memory', 'gateway_cpus', 'gateway_pids']) {
    expect(save[0]).toContain(k);
  }
  expect(save[0]).not.toMatch(/\bmode\b/);
  expect(save[0]).not.toContain('project_ids');
});

// 上限缺值不是小事：容器模式規定上限必填（lib/agent-sandbox.js 硬擋），缺了就是全部 AI 執行失敗。
// 畫面要當場講出來，不要讓人從一堆「執行失敗」裡反推。
test('上限缺值時畫面直接示警', () => {
  expect(page).toMatch(/v-if="!agentSandbox\.limits\.memory[\s\S]{0,120}class="error-msg"/);
});
