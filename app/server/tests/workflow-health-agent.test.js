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
