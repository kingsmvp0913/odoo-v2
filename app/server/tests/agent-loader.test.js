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
    'analysis-project', 'coding-project',
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
    const p = '新的提示詞 {{project_name}} {{wiki}} {{history}} {{user_message}}';
    const updated = L.updateAgent('chat', { prompt: p });
    expect(updated.body.trim()).toBe(p);
    expect(updated.render({ project_name: 'P', wiki: 'W', history: 'H', user_message: 'X' })).toContain('X');
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
  // 分診查真相改用「已解析的 git -C <絕對路徑> diff base...branch」，不再叫 agent 打 main...HEAD（歷程實測 fatal 主因）
  expect(out).toContain('git -C');
  expect(out).toContain('diff main...task/x');
  // CLAUDE_MD_AGENTS → 應 prepend 專案規則（CLAUDE.md 內含「Odoo Constraints」字樣）
  expect(out).toContain('Odoo Constraints');
});

// 意圖：只有「診斷／修復型」關卡（analysis-reject、coding-project）該拿到系統化除錯方法論；其餘關卡不得被污染。
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

  test('非診斷關（cs）render 不含方法論', () => {
    const out = loadAgent('cs').render({ title: 'T', original_text: 'x', wiki: 'y' });
    expect(out).not.toContain('# 系統化除錯（pipeline 版）');
  });
});

// 意圖：碰程式碼／git 的關卡（SOURCE_ROUTING_AGENTS）該拿到「資料來源守則」，且平台已解析的
// repo 絕對路徑／base 分支被真正填入 prompt（根治歷程實測的探路、猜分支、掃碟亂跑）；其餘關卡不注入。
describe('SOURCE_ROUTING_AGENTS 注入資料來源守則（填入已解析真值）', () => {
  const { loadAgent } = require('../pipeline/agent-loader');

  test('qa render 含守則，且填入 repo 絕對路徑與 base...branch 指令', () => {
    const out = loadAgent('qa').render({
      project_name: 'P', odoo_version: '17.0', main_branch: 'master', git_branch: 'task/9',
      repo_paths: '- C:/proj/.worktrees/9/idx_sale', analysis_yaml: 'module: sale',
      prior_findings: '（首輪）', resolution: '（無）'
    });
    expect(out).toContain('資料來源守則');
    expect(out).toContain('C:/proj/.worktrees/9/idx_sale');   // 已解析的絕對路徑，非 <子目錄> 佔位
    expect(out).toContain('diff master...task/9');             // base 依實際 repo（master），非硬打 main
  });

  test('非碰碼關（cs）不注入守則', () => {
    const out = loadAgent('cs').render({ title: 'T', original_text: 'x', wiki: 'y' });
    expect(out).not.toContain('資料來源守則');
  });
});

// 意圖：技術客服能力（cs-capability）是 chat 與 cs 的共用真相來源——兩者 render 都要注入，
// 且 {{project_name}}／{{repo_paths}} 被真正填入（chat/cs 才查得到 repo、curl 得到 wiki）。
describe('CS_CAPABILITY_AGENTS 注入技術客服能力片段', () => {
  const { loadAgent } = require('../pipeline/agent-loader');

  test('chat render 含能力片段，且填入 project_name 與 repo 路徑', () => {
    const out = loadAgent('chat').render({
      project_name: '鴻久', repo_paths: '- /repos/hj/idx_sale',
      history: '', user_message: '預計售價權限在哪'
    });
    expect(out).toContain('技術客服');                 // 片段 persona
    expect(out).toContain('/ai/wiki/pages?project=鴻久'); // project_name 填入 curl 指引
    expect(out).toContain('/repos/hj/idx_sale');        // repo 路徑填入
  });
});

// 意圖（token 效率）：QA 是唯讀審查者——只注入審查相關段落（§1 Odoo Constraints＋§2 Python Constraints＋Rule 12），
// Hard Rules 的寫入規範／前端配色／log 路徑對它無作用卻每輪照付 token。
// Python 規則（round()→台灣四捨五入）是財務正確性把關，拆成獨立 §2 後仍須進 QA。
test('qa 只注入精簡審查規則：含 Odoo/Python Constraints 與 Rule 12，不含 Hard Rules 全文', () => {
  const { loadAgent } = require('../pipeline/agent-loader');
  const out = loadAgent('qa').render({
    project_name: 'P', odoo_version: '17.0', main_branch: 'main', git_branch: 'task/x',
    analysis_yaml: 'module: sale', prior_findings: '（首輪，無上輪清單）', resolution: '（無）'
  });
  expect(out).toContain('Odoo Constraints');
  expect(out).toContain('Python Constraints');
  expect(out).toContain('ROUND_HALF_UP');        // §2 Python 規則須到 QA（財務正確性）
  expect(out).toContain('Rule 12');
  expect(out).not.toContain('Hard Rules');       // §0 寫入規範不注入
  expect(out).not.toContain('app/public');       // 前端規範不注入
});

test('qa-retry 不重複注入規則（resume 短 prompt）', () => {
  const { loadAgent } = require('../pipeline/agent-loader');
  const out = loadAgent('qa-retry').render({
    main_branch: 'main', git_branch: 'task/x', prior_findings: 'x', resolution: '（無）'
  });
  expect(out).not.toContain('Odoo Constraints');
  expect(out).toContain('接續「同一個任務的上一輪 QA 審查」');
});

// 意圖：使用者在 wiki 手寫的「專案備註」要注入 NOTES_AGENTS 各關卡，位置固定在
// 「CLAUDE.md 規則之後、debug／source-routing 之前」——同專案跨任務前綴不變＝吃 prompt cache；
// 空備註不得注入以免破壞前綴。備註是 per-project 動態值，不進 promptVersion 靜態指紋。
describe('NOTES_AGENTS 注入專案備註（人工維護，優先遵循）', () => {
  const { loadAgent, promptVersion } = require('../pipeline/agent-loader');
  const NOTES_HEADER = '# 專案備註（人工維護，優先遵循）';

  const codingVars = (extra) => ({
    project_name: 'P', odoo_version: '17.0', analysis_yaml: 'module: sale',
    work_dir: '/w', repo_list: '- sale/', task_id: 'task_1', commit_message: 'm',
    main_branch: 'master', git_branch: 'task/1', repo_paths: '- /w/sale',
    ...extra
  });

  test('coding-project 有備註 → 注入，且排在規則後、debug 前', () => {
    const out = loadAgent('coding-project').render(codingVars({ project_notes: '部署到 8069 埠' }));
    expect(out).toContain(NOTES_HEADER);
    expect(out).toContain('部署到 8069 埠');
    const iRules = out.indexOf('Odoo Constraints');
    const iNotes = out.indexOf(NOTES_HEADER);
    const iDebug = out.indexOf('# 系統化除錯（pipeline 版）');
    expect(iRules).toBeGreaterThanOrEqual(0);
    expect(iNotes).toBeGreaterThan(iRules);   // 規則在備註之前
    expect(iDebug).toBeGreaterThan(iNotes);   // 備註在 debug 之前
  });

  test('備註空字串 → 不注入（前綴與現況一致）', () => {
    const out = loadAgent('coding-project').render(codingVars({ project_notes: '' }));
    expect(out).not.toContain(NOTES_HEADER);
  });

  test('備註純空白 → 不注入', () => {
    const out = loadAgent('coding-project').render(codingVars({ project_notes: '   \n  ' }));
    expect(out).not.toContain(NOTES_HEADER);
  });

  test('未傳 project_notes → 不注入', () => {
    const out = loadAgent('coding-project').render(codingVars());
    expect(out).not.toContain(NOTES_HEADER);
  });

  test('chat（無規則／debug）→ 備註直接 prepend 在 body 前', () => {
    const out = loadAgent('chat').render({
      project_name: 'P', repo_paths: '- /repos/x', history: '', user_message: '你好', project_notes: '窗口 Amy'
    });
    expect(out).toContain(NOTES_HEADER);
    expect(out).toContain('窗口 Amy');
    expect(out.indexOf(NOTES_HEADER)).toBeLessThan(out.indexOf('以下是使用者在本專案的排障對話'));
  });

  test('chat-to-task 有備註 → 注入', () => {
    const out = loadAgent('chat-to-task').render({ history: 'x', project_notes: '窗口 Amy' });
    expect(out).toContain(NOTES_HEADER);
    expect(out).toContain('窗口 Amy');
  });

  test('非 NOTES_AGENTS（merge）即使傳 project_notes 也不注入', () => {
    const out = loadAgent('merge').render({ project_notes: '窗口 Amy' });
    expect(out).not.toContain(NOTES_HEADER);
  });

  test('promptVersion 不因備註改變（動態值不進靜態指紋）', () => {
    // promptVersion 只吃 agent name，不吃 vars → 備註無從進入指紋；鎖定其為穩定 12 碼 hash。
    const v1 = promptVersion('coding-project');
    const v2 = promptVersion('coding-project');
    expect(v1).toBe(v2);
    expect(v1).toMatch(/^[0-9a-f]{12}$/);
  });
});
