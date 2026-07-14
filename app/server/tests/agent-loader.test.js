const fs = require('fs');
const L = require('../pipeline/agent-loader');

// 意圖：loader 是「呼叫時帶入 model + prompt」的單一來源。
// 這些測試鎖定：frontmatter 正確解析、placeholder 正確代入、
// body 內的 ---RESULT-JSON--- 標記不被 frontmatter 切割破壞、
// updateAgent 只改 model/body 並保留其餘 frontmatter、且會擋非法輸入。

test('loadAgent 解析 frontmatter（model / stage / label）', () => {
  const a = L.loadAgent('cs');
  expect(a.model).toBe('haiku'); // 健檢 F：cs 純分類降 haiku
  expect(a.stage).toBe('cs');
  expect(a.label).toBe('客服');
  expect(typeof a.render).toBe('function');
});

test('render 代入 placeholder，無殘留', () => {
  const a = L.loadAgent('cs');
  const out = a.render({ title: 'HELLO-123', original_text: 'x', wiki: 'y' });
  expect(out).toContain('HELLO-123');
  expect(out.match(/\{\{\w+\}\}/)).toBeNull();
});

test('缺值的 placeholder 代空字串', () => {
  const out = L.loadAgent('cs').render({ title: 'T' }); // 只給 title
  expect(out).toContain('T');
  expect(out.match(/\{\{\w+\}\}/)).toBeNull();
});

test('body 內的 <result> 契約標記不被 frontmatter 解析破壞', () => {
  const out = L.loadAgent('analysis-project').render({
    project_name: 'P', odoo_version: '17.0', original_text: 'OT', task_id: 'task_1'
  });
  expect(out).toContain('<result>');
  expect(out).toContain('</result>');
  expect(out).toContain('task_1');
  expect(out.match(/\{\{\w+\}\}/)).toBeNull();
});

test('render 漏傳 placeholder → console.warn 告警（不靜默劣化，健檢 F）', () => {
  const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  L.loadAgent('cs').render({ title: 'T' }); // 漏傳 original_text / wiki / answers
  expect(spy.mock.calls.some(c => String(c[0]).includes('未匹配 placeholder'))).toBe(true);
  spy.mockRestore();
});

test('listAgents 含所有實際使用的 agent', () => {
  const names = L.listAgents().map(a => a.name);
  for (const n of [
    'analysis-basic', 'analysis-project', 'coding-project',
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
  expect(labels.deploy_fix).toBe('部署分類');
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

  test('改 prompt 會寫入新 body（保留既有 placeholder）', () => {
    const p = '新的提示詞 {{wiki}} {{history}} {{user_message}}';
    const updated = L.updateAgent('chat', { prompt: p });
    expect(updated.body.trim()).toBe(p);
    expect(updated.render({ wiki: 'W', history: 'H', user_message: 'X' })).toContain('X');
  });

  test('移除既有 placeholder 遭拒（400，防契約漂移）', () => {
    expect.assertions(1);
    // chat 有 {{wiki}}/{{history}}/{{user_message}}；只留一個＝移除其餘，JS 端仍會傳入
    try { L.updateAgent('chat', { prompt: '只剩 {{user_message}}' }); }
    catch (e) { expect(e.status).toBe(400); }
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

test('updateAgent 移除 <result> 契約標記遭拒（400，防 UI 改壞契約使下輪 stopped）', () => {
  const orig = fs.readFileSync(L.agentPath('qa'), 'utf8');
  try {
    let err;
    try { L.updateAgent('qa', { prompt: '對 {{main_branch}}...{{git_branch}} 審查，但沒有結果標記' }); }
    catch (e) { err = e; }
    expect(err?.status).toBe(400);
    expect(err?.message).toContain('<result>');
  } finally {
    fs.writeFileSync(L.agentPath('qa'), orig); L.invalidate('qa');
  }
});

test('analysis-reject 可載入且 render 填入分診專屬 placeholder', () => {
  const { loadAgent } = require('../pipeline/agent-loader');
  const agent = loadAgent('analysis-reject');
  expect(agent.model).toBe('sonnet');
  const out = agent.render({
    project_name: 'P', odoo_version: '17.0', main_branch: 'main', git_branch: 'task/x',
    analysis_yaml: 'module: sale', stuck_stage: 'QA 審查', stop_context: '金額算錯',
    user_instruction: '沒事誤判', runtime_log_path: 'C:/x/odoo.log', allow_bug: 'true'
  });
  expect(out).toContain('金額算錯');
  expect(out).toContain('沒事誤判');
  expect(out).toContain('allow_bug = true');
  expect(out).toContain('git diff main...HEAD');
  // CLAUDE_MD_AGENTS → 應 prepend 專案規則（CLAUDE.md 內含「Odoo Constraints」字樣）
  expect(out).toContain('Odoo Constraints');
});

// 意圖（健檢 U3）：coding-retry 只走 --resume，session 已含 fresh 輪帶入的 CLAUDE.md；
// 再 prepend 會佔掉 resume prompt 八成以上，抵銷「resume 只送短 feedback」的省 token 設計
test('coding-retry 不重複注入 CLAUDE.md（resume 短 prompt）', () => {
  const { loadAgent } = require('../pipeline/agent-loader');
  const out = loadAgent('coding-retry').render({
    gate: 'QA 未通過', retry_feedback: 'x', resolution: '（無）', commit_message: 'm'
  });
  expect(out).not.toContain('Odoo Constraints');
  expect(out).toContain('接續「同一個任務的上一輪實作」');
});

// 意圖：只有「診斷／修復型」關卡（analysis-reject、coding-project）該拿到系統化除錯方法論；
// 其餘關卡不得被污染。coding-retry 尤其不可拿（靠 --resume 繼承 coding-project 的 session，守 U3）。
describe('DEBUG_AGENTS 注入 systematic-debugging 方法論', () => {
  const { loadAgent } = require('../pipeline/agent-loader');

  test('analysis-reject render 含方法論標記', () => {
    const out = loadAgent('analysis-reject').render({
      project_name: 'P', odoo_version: '17.0', main_branch: 'main', git_branch: 'task/x',
      analysis_yaml: 'module: sale', stuck_stage: 'QA', stop_context: 'x',
      user_instruction: 'y', runtime_log_path: 'C:/x/odoo.log', allow_bug: 'true'
    });
    expect(out).toContain('# 系統化除錯（pipeline 版）');
  });

  test('coding-project render 含方法論標記', () => {
    const out = loadAgent('coding-project').render({
      project_name: 'P', odoo_version: '17.0', analysis_yaml: 'module: sale',
      work_dir: '/w', repo_list: '- sale/', task_id: 'task_1', commit_message: 'm'
    });
    expect(out).toContain('# 系統化除錯（pipeline 版）');
  });

  test('coding-retry render 不含方法論（守 U3，靠 --resume 繼承）', () => {
    const out = loadAgent('coding-retry').render({
      gate: 'QA 未通過', retry_feedback: 'x', resolution: '（無）', commit_message: 'm'
    });
    expect(out).not.toContain('# 系統化除錯（pipeline 版）');
  });

  test('非診斷關（cs）render 不含方法論', () => {
    const out = loadAgent('cs').render({ title: 'T', original_text: 'x', wiki: 'y' });
    expect(out).not.toContain('# 系統化除錯（pipeline 版）');
  });
});
