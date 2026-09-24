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

// 2026-09-24 實機驗收撞到：loadAgentSandbox 只有 runBackupNow 會呼叫，loadAll／created 都沒叫，
// 所以這一區從加上去那天起就永遠顯示「狀態讀取失敗」——端點是好的（直接打回 200），
// 唯一能讓它顯示真值的路徑是去按「立即備份」。這種 bug 不會有人回報，因為畫面「看起來有反應」。
test('進頁面就要去讀，不能只靠別的動作順便帶到', () => {
  const loadAll = page.match(/async loadAll\(\)[\s\S]*?\n {6}\},/);
  expect(loadAll).not.toBeNull();
  expect(loadAll[0]).toContain('loadAgentSandbox()');
});

// 同一次驗收撞到的第二件事：拿掉模式選鈕之後，區塊說明還寫著「這裡設定每個容器可以用多少資源」，
// 但畫面上一個輸入框都沒有，儲存鈕只能把讀回來的值原樣 PUT 回去。說明承諾的功能要真的在。
test('六個上限都有輸入框（說明承諾可以設定，就要真的設得了）', () => {
  for (const f of ['agentSandbox.limits.memory', 'agentSandbox.limits.cpus', 'agentSandbox.limits.pids',
                   'agentSandbox.gateway_limits.memory', 'agentSandbox.gateway_limits.cpus', 'agentSandbox.gateway_limits.pids']) {
    expect(page).toMatch(new RegExp(`<input[^>]*v-model[^>]*${f.replace(/\./g, '\\.')}`));
  }
});

// 上限缺值不是小事：容器模式規定上限必填（lib/agent-sandbox.js 硬擋），缺了就是全部 AI 執行失敗。
// 畫面要當場講出來，不要讓人從一堆「執行失敗」裡反推。
test('上限缺值時畫面直接示警', () => {
  expect(page).toMatch(/v-if="!agentSandbox\.limits\.memory[\s\S]{0,120}class="error-msg"/);
});
