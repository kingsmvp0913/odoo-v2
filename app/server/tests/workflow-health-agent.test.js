// 意圖：健檢 agent 檔契約正確、runner 遍歷落 findings（工作流程健檢子專案 2）。
const { loadAgent } = require('../pipeline/agent-loader');

test('workflow-health agent：opus + workflow_health stage + 4 placeholder 可 render', () => {
  const a = loadAgent('workflow-health');
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
  expect(out).toContain('Skill(healthCheck)'); // 判準強制載入（載不到就停下來）
  expect(out).toContain('<result>');
});
