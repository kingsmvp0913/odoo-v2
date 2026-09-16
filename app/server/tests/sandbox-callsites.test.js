// 意圖：projects 模式只對清單內的測試專案開容器。呼叫點少帶 projectId 時，resolveSandboxPlan 判不出專案，
// 那一關會靜默留在容器外——開關以為開了、實際沒開，而且沒有任何紅燈。這支把「必須帶」鎖在原始碼上。
// 慣例：projectId 與 agentType 寫在同一行（改寫排版時請維持，否則這支會紅）。
const fs = require('fs');
const path = require('path');
const { AGENT_PROFILES } = require('../lib/agent-profiles');

const SRV = path.join(__dirname, '..');
const MUST_HAVE_PROJECT = [
  ['pipeline/chat-agent.js', 'chat', /projectId, chatId/],
  ['pipeline/chat-title.js', 'chat-title', /projectId: chat\.project_id/],
  ['pipeline/chat-to-task.js', 'chat-to-task', /projectId, chatId/],
  ['pipeline/failure-classifier.js', 'deploy_fix', /projectId: opts\.projectId/],
  ['pipeline/classify-rejections.js', 'reject_classify', /projectId: rej\.project_id/],
  ['pipeline/wiki-drift.js', 'wiki_drift_classify', /projectId: d\.project_id/],
  ['pipeline/library-agent.js', 'wiki', /projectId/],
];

test.each(MUST_HAVE_PROJECT)('%s 的 %s 呼叫帶 projectId', (file, agentType, re) => {
  const lines = fs.readFileSync(path.join(SRV, file), 'utf8').split('\n').filter(l => l.includes(`agentType: '${agentType}'`));
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) expect(l).toMatch(re);
});

test('admin 驗 Claude token 的那次呼叫有登記過的 agentType', () => {
  const src = fs.readFileSync(path.join(SRV, 'admin-routes.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes("runClaude('回覆 ok'"));
  expect(line).toMatch(/agentType: 'auth_probe'/);
  expect(AGENT_PROFILES.auth_probe).toBeTruthy();
});

// 任何字面出現的 agentType 都要在 profile 表裡——新增關卡忘了登記，容器模式下整關直接失敗
test('server 內所有字面 agentType 都已登記', () => {
  const found = new Set();
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['tests', 'node_modules'].includes(e.name)) walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/agentType:\s*'([^']+)'/g)) found.add(m[1]);
    }
  };
  walk(SRV);
  const missing = [...found].filter(t => !AGENT_PROFILES[t]);
  expect(missing).toEqual([]);
});
