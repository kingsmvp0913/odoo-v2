// 意圖：健檢 agent 檔契約正確、runner 遍歷落 findings（工作流程健檢子專案 2）。
const { loadAgent } = require('../pipeline/agent-loader');

test('workflow-health agent：預設 Claude Opus + workflow_health stage + 4 placeholder 可 render', () => {
  const a = loadAgent('workflow-health');
  expect(a.provider).toBe('claude');
  expect(a.model).toBe('opus');
  expect(a.stage).toBe('workflow_health');
  const out = a.render({ agent_label: 'X 標籤', agent_role: '角色', agent_prompt: 'PROMPT-BODY', summary: '{"token":{}}' });
  expect(out).toContain('X 標籤');
  expect(out).toContain('PROMPT-BODY');
  expect(out).toContain('{"token":{}}');
  expect(out).not.toContain('{{');           // 無漏填 placeholder
});

// 單張任務健檢（scope=task）。它與 workflow-health 共用同一份判準但**不得**產生提示詞改動，
// 故契約上刻意沒有 <prompt>：這裡釘住的是「只有一個 {{summary}} placeholder」與「不談 prompt」。
test('health-task agent：opus + workflow_health stage + 只吃 summary placeholder', () => {
  const a = loadAgent('health-task');
  expect(a.model).toBe('opus');
  expect(a.stage).toBe('workflow_health');
  const out = a.render({ summary: '{"scope":"task:7"}' });
  expect(out).toContain('{"scope":"task:7"}');
  expect(out).not.toContain('{{');           // 無漏填 placeholder
  expect(out).toContain('.agents/skills/healthCheck/SKILL.md'); // provider 無關的判準載入
  expect(out).toContain('<result>');
});

// 主導型健檢的契約：它自己查資料、自己回溯，所以 prompt 只有三個 placeholder（上一輪裁決＋起手包＋
// 趨勢比對），且必須指名可用的查詢工具——沒指名它就只能就著起手包判，回溯查證那一步會整個消失。
test('health-auditor agent：opus + 三個 placeholder + 指名查詢工具與判準', () => {
  const a = loadAgent('health-auditor');
  expect(a.model).toBe('opus');
  expect(a.stage).toBe('workflow_health');
  const out = a.render({ previous: '（無）', trend: '（不做）', summary: '{"volume":{}}' });
  expect(out).not.toContain('{{');
  // 每條提案要能各自帶嚴重度：整輪共用一個值時，「輕微的可不處理」的粒度只到整輪
  expect(out).toContain('每條提案的 `severity`');
  expect(out).toContain('.agents/skills/healthCheck/SKILL.md'); // provider 無關的判準載入
  expect(out).toContain('platformDB skill');     // 自己下 SQL 的能力
  expect(out).toContain('回溯');                  // 窗內命中 → 回頭找同類案例湊證據
  expect(out).toContain('<result>');
});

// 修正 agent 的契約：範圍規則同時寫在提示詞（讓它知道）與程式（讓它做不到）。這裡只驗提示詞那半，
// 程式那半在 finding-fix.test.js。兩半都要有——只有提示詞是請求，只有程式檢查則它會一直白做工。
test('platform-fix agent：placeholder 齊、載入平台開發慣例、寫明兩條禁區', () => {
  const a = loadAgent('platform-fix');
  expect(a.model).toBe('opus');
  const out = a.render({
    title: 'T', layer: 'platform', detail: 'D', evidence: 'E', action: 'A',
    target_metric: 'M', metric_baseline: '1'
  });
  expect(out).not.toContain('{{');
  expect(out).toContain('.agents/skills/platformDev/SKILL.md');
  expect(out).toContain('不得修改或刪除');     // 既有測試
  expect(out).toContain('health-');            // 健檢自己
  expect(out).toContain('不要 commit');        // 提交由人決定
});
