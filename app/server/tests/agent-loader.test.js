const fs = require('fs');
const L = require('../pipeline/agent-loader');

// 意圖：loader 是「呼叫時帶入 model + prompt」的單一來源。
// 這些測試鎖定：frontmatter 正確解析、placeholder 正確代入、
// body 內的 ---RESULT-JSON--- 標記不被 frontmatter 切割破壞、
// updateAgent 只改 model/body 並保留其餘 frontmatter、且會擋非法輸入。

test('loadAgent 解析 frontmatter（model / stage / label）', () => {
  const a = L.loadAgent('triage');
  expect(a.model).toBe('haiku');
  expect(a.stage).toBe('triage');
  expect(a.label).toBe('分診');
  expect(typeof a.render).toBe('function');
});

test('render 代入 placeholder，無殘留', () => {
  const a = L.loadAgent('triage');
  const out = a.render({ original_text: 'HELLO-123' });
  expect(out).toContain('HELLO-123');
  expect(out.match(/\{\{\w+\}\}/)).toBeNull();
});

test('缺值的 placeholder 代空字串', () => {
  const out = L.loadAgent('cs').render({ title: 'T' }); // 只給 title
  expect(out).toContain('T');
  expect(out.match(/\{\{\w+\}\}/)).toBeNull();
});

test('body 內的 ---RESULT-JSON--- 標記不被 frontmatter 解析破壞', () => {
  const out = L.loadAgent('analysis-project').render({
    project_name: 'P', odoo_version: '17.0', original_text: 'OT', task_id: 'task_1'
  });
  expect(out).toContain('---RESULT-JSON---');
  expect(out).toContain('---END-RESULT---');
  expect(out).toContain('task_1');
  expect(out.match(/\{\{\w+\}\}/)).toBeNull();
});

test('listAgents 含所有實際使用的 agent', () => {
  const names = L.listAgents().map(a => a.name);
  for (const n of [
    'triage', 'analysis-basic', 'analysis-project', 'coding-project',
    'cs', 'merge', 'deploy-fix', 'library', 'chat'
  ]) expect(names).toContain(n);
  // PS1「開工」pipeline 已退役，不應再有其 subagent
  for (const n of ['requirements-analyst', 'senior-software-engineer', 'qa-analyst']) {
    expect(names).not.toContain(n);
  }
});

test('getLabels 提供 stage→中文 對照（供全站命名）', () => {
  const labels = L.getLabels();
  expect(labels.analysis).toBe('分析');
  expect(labels.coding).toBe('實作');
  expect(labels.wiki).toBe('知識庫');
  expect(labels.deploy_fix).toBe('部署修復');
});

describe('updateAgent', () => {
  let original;
  beforeAll(() => { original = fs.readFileSync(L.agentPath('chat'), 'utf8'); });
  afterAll(() => { fs.writeFileSync(L.agentPath('chat'), original); L.invalidate('chat'); });

  test('改 model 保留其餘 frontmatter 與 body', () => {
    const before = L.loadAgent('chat');
    const updated = L.updateAgent('chat', { model: 'haiku' });
    expect(updated.model).toBe('haiku');
    expect(updated.body).toBe(before.body);
    const raw = fs.readFileSync(L.agentPath('chat'), 'utf8');
    expect(raw).toContain('stage: chat');
    expect(raw).toContain('label: 對話');
  });

  test('改 prompt 會寫入新 body', () => {
    const updated = L.updateAgent('chat', { prompt: '新的提示詞 {{user_message}}' });
    expect(updated.body.trim()).toBe('新的提示詞 {{user_message}}');
    expect(updated.render({ user_message: 'X' })).toContain('X');
  });

  test('非法 model 擋下（400）', () => {
    expect.assertions(1);
    try { L.updateAgent('chat', { model: 'gpt-4' }); }
    catch (e) { expect(e.status).toBe(400); }
  });

  test('opus / fable 為合法 model', () => {
    expect(L.updateAgent('chat', { model: 'opus' }).model).toBe('opus');
    expect(L.updateAgent('chat', { model: 'fable' }).model).toBe('fable');
  });

  test('未知 agent 擋下（404）', () => {
    expect.assertions(1);
    try { L.updateAgent('does-not-exist', { model: 'sonnet' }); }
    catch (e) { expect(e.status).toBe(404); }
  });
});
