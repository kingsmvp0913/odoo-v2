const fs = require('fs');
const L = require('../pipeline/agent-loader');

// 意圖：loader 是「呼叫時帶入 model + prompt」的單一來源。
// 這些測試鎖定：frontmatter 正確解析、placeholder 正確代入、
// body 內的 ---RESULT-JSON--- 標記不被 frontmatter 切割破壞、
// updateAgent 只改 model/body 並保留其餘 frontmatter、且會擋非法輸入。

test('loadAgent 解析 frontmatter（model / stage / label）', () => {
  const a = L.loadAgent('cs');
  expect(a.model).toBe('sonnet'); // cs 升級為可調查的技術客服
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

// 意圖（Rule 9）：retry_feedback／resolution 是「長度大、每輪會變」的區塊值，只該在自己的
// 【】標題底下注入一次。曾經在說明句中間也寫了 {{retry_feedback}}，fillPlaceholders 全域替換後
// 兩個後果：句子被整段失敗訊息塞爆而語意壞掉；body 從那一行起每輪都不同 → 破壞 coding 賴以省
// input 的 prompt cache 前綴（coding 每輪 fresh，見 task-agent.js）。短識別值（branch/專案名）
// 重複 inline 無此問題，故只釘這兩個。
test('coding-project 的區塊型 placeholder 只在專屬區塊出現一次（保語意與 cache 前綴）', () => {
  const body = L.loadAgent('coding-project').body;
  for (const ph of ['{{retry_feedback}}', '{{resolution}}']) {
    expect(body.split(ph).length - 1).toBe(1);
  }
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
    user_instruction: '沒事誤判'
  });
  expect(out).toContain('金額算錯');
  expect(out).toContain('沒事誤判');
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
      user_instruction: 'y'
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
      odoo_core_src: '核心 addons 唯讀路徑：/data/odoo-core/17/addons',
      prior_findings: '（首輪）', resolution: '（無）'
    });
    expect(out).toContain('資料來源守則');
    expect(out).toContain('C:/proj/.worktrees/9/idx_sale');   // 已解析的絕對路徑，非 <子目錄> 佔位
    expect(out).toContain('diff master...task/9');             // base 依實際 repo（master），非硬打 main
    expect(out).toContain('/data/odoo-core/17/addons');        // {{odoo_core_src}} 核心來源守則真的填入
  });

  test('非碰碼關（cs）不注入 source-routing 守則，但注入技術客服能力片段', () => {
    const out = loadAgent('cs').render({ title: 'T', original_text: 'x', answers: '（尚無）', project_name: 'P', repo_paths: '- /repos/p/idx' });
    expect(out).not.toContain('資料來源守則');   // 非 SOURCE_ROUTING_AGENTS
    expect(out).toContain('技術客服');            // 是 CS_CAPABILITY_AGENTS
    expect(out).toContain('/repos/p/idx');        // repo 路徑填入
  });
});

// 意圖：技術客服能力（cs-capability）是 chat 與 cs 的共用真相來源——兩者 render 都要注入，
// 且 {{project_slug}}／{{repo_paths}} 被真正填入（chat/cs 才查得到 repo、curl 得到 wiki）。
describe('CS_CAPABILITY_AGENTS 注入技術客服能力片段', () => {
  const { loadAgent } = require('../pipeline/agent-loader');

  test('chat render 含能力片段，且填入 project_slug 與 repo 路徑', () => {
    const out = loadAgent('chat').render({
      project_name: '鴻久', project_slug: 'odoo17_hungjou', repo_paths: '- /repos/hj/idx_sale',
      history: '', user_message: '預計售價權限在哪'
    });
    expect(out).toContain('技術客服');                            // 片段 persona
    expect(out).toContain('/ai/wiki/search?project=odoo17_hungjou'); // 搜尋端點有教
    expect(out).toContain('/ai/wiki/pages?project=odoo17_hungjou');  // slug 填入 curl 指引
    expect(out).toContain('/repos/hj/idx_sale');                   // repo 路徑填入
    expect(out).toContain('鴻久');                                 // 對話正文仍用得到顯示名
  });

  // 意圖：wiki 的 curl 指引一律吃 {{project_slug}}（已 URL 編碼的 folder_name），不得回頭用中文
  // 顯示名——未編碼的中文放進網址會被 Node 的 HTTP parser 判 400，連 Express 都到不了，
  // 症狀只是「agent 查不到 wiki」，完全不指向網址問題。實測鴻久／北群醫／慈雲寶塔三個專案全中招。
  test('中文專案名走 project_slug（已編碼）→ curl 指引裡不得出現未編碼中文網址', () => {
    const encoded = encodeURIComponent('鴻久');
    const out = loadAgent('chat').render({
      project_name: '鴻久', project_slug: encoded, repo_paths: '- /r',
      history: '', user_message: 'q'
    });
    expect(out).toContain(`/ai/wiki/pages?project=${encoded}`);
    expect(out).not.toContain('/ai/wiki/pages?project=鴻久'); // 未編碼中文網址＝必定 400
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

// 意圖（Rule 9）：權限守則放在 CLAUDE.md §1 內部（### 三級標題），是為了讓 loadQaRules 的
// `## 1. Odoo Constraints ... (?=\n## )` 節錄剛好把它一起帶進 QA——QA 要比對實作與規格 permissions
// 是否一致（P6）。若有人改成 `## 權限` 二級標題，regex 會提早截斷、QA 靜默拿不到守則。
test('權限守則 P0~P6 必須待在 §1 內，才會同時進 full 模式與 QA 精簡模式', () => {
  const { loadAgent } = require('../pipeline/agent-loader');
  const ANCHOR = '權限一律由「錨點」推導';

  const qaOut = loadAgent('qa').render({
    project_name: 'P', odoo_version: '17.0', main_branch: 'main', git_branch: 'task/x',
    analysis_yaml: 'module: sale', prior_findings: '（首輪，無上輪清單）', resolution: '（無）'
  });
  expect(qaOut).toContain(ANCHOR);
  expect(qaOut).toContain('perm_unlink=1');        // P5 也要進 QA
  expect(qaOut).toContain('QA 關要比對實作與');     // P6 專屬片語（只存在於 CLAUDE.md，不會被片段假綠）

  const analysisOut = loadAgent('analysis-project').render({
    project_name: 'P', odoo_version: '17.0', original_text: 'OT', task_id: 'task_1'
  });
  expect(analysisOut).toContain(ANCHOR);
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

// 意圖（Rule 9）：說人話守則要進「會產出給人看的文字」的 11 關。它刻意不走 CLAUDE.md——
// CLAUDE.md 只餵得到 7 關，漏掉 cs／merge-explain／merge-clarify／chat／chat-to-task／library，
// 而這些正是最需要白話的地方。反過來 playwright／coding-project 產的是碼，沒人讀，注入純屬浪費。
describe('PLAIN_LANGUAGE_AGENTS 注入說人話守則', () => {
  const { loadAgent, promptVersion } = require('../pipeline/agent-loader');
  const PL_HEADER = '# 說人話守則';

  test('CLAUDE.md 餵不到的關（cs／merge-explain／library／chat-to-task）也拿得到', () => {
    expect(loadAgent('cs').render({ title: 'T', original_text: 'x', answers: '（尚無）', project_name: 'P', repo_paths: '- /r' })).toContain(PL_HEADER);
    expect(loadAgent('merge-explain').render({})).toContain(PL_HEADER);
    expect(loadAgent('library').render({})).toContain(PL_HEADER);
    expect(loadAgent('chat-to-task').render({ history: 'x' })).toContain(PL_HEADER);
  });

  test('產碼關（coding-project／playwright／merge）不注入', () => {
    const coding = loadAgent('coding-project').render({
      project_name: 'P', odoo_version: '17.0', analysis_yaml: 'module: sale',
      work_dir: '/w', repo_list: '- sale/', task_id: 'task_1', commit_message: 'm'
    });
    expect(coding).not.toContain(PL_HEADER);
    expect(loadAgent('merge').render({})).not.toContain(PL_HEADER);
  });

  test('qa-retry 不注入（--resume 短 prompt，重複前置會抵銷省 token 設計）', () => {
    const out = loadAgent('qa-retry').render({ main_branch: 'main', git_branch: 'task/x', prior_findings: 'x', resolution: '（無）' });
    expect(out).not.toContain(PL_HEADER);
  });

  test('順序：CLAUDE.md 規則 → 說人話 → 專案備註 → debug', () => {
    const out = loadAgent('analysis-reject').render({
      project_name: 'P', odoo_version: '17.0', main_branch: 'main', git_branch: 'task/x',
      analysis_yaml: 'module: sale', stuck_stage: 'QA', stop_context: 'x',
      user_instruction: 'y',
      project_notes: '窗口 Amy'
    });
    const iRules = out.indexOf('Odoo Constraints');
    const iPlain = out.indexOf(PL_HEADER);
    const iNotes = out.indexOf('# 專案備註（人工維護，優先遵循）');
    const iDebug = out.indexOf('# 系統化除錯（pipeline 版）');
    expect(iRules).toBeGreaterThanOrEqual(0);
    expect(iPlain).toBeGreaterThan(iRules);
    expect(iNotes).toBeGreaterThan(iPlain);
    expect(iDebug).toBeGreaterThan(iNotes);
  });

  // 意圖：這是本次改動唯一會「靜默失效」的點——片段改了但 promptVersion 沒把它算進去，
  // 綁定的 resume session 不會 fresh，新規則永遠不生效且無任何錯誤訊息，事後查不出原因。
  test('promptVersion 把說人話片段算進靜態指紋（改片段就換版、強制 fresh）', () => {
    const fs = require('fs');
    const path = require('path');
    const PL_PATH = path.join(__dirname, '..', 'pipeline', 'plain-language.md');
    const orig = fs.readFileSync(PL_PATH, 'utf8');
    try {
      const before = promptVersion('cs');
      fs.writeFileSync(PL_PATH, orig + '\n\n<!-- 指紋探針 -->\n');
      expect(promptVersion('cs')).not.toBe(before);
    } finally {
      fs.writeFileSync(PL_PATH, orig);
    }
  });

  test('未注入的 agent 指紋不受片段變動影響', () => {
    const fs = require('fs');
    const path = require('path');
    const PL_PATH = path.join(__dirname, '..', 'pipeline', 'plain-language.md');
    const orig = fs.readFileSync(PL_PATH, 'utf8');
    try {
      const before = promptVersion('merge');
      fs.writeFileSync(PL_PATH, orig + '\n\n<!-- 指紋探針 -->\n');
      expect(promptVersion('merge')).toBe(before);
    } finally {
      fs.writeFileSync(PL_PATH, orig);
    }
  });

  // 意圖（Rule 9）：名單裡打錯字或日後 agent 檔改名 → 靜默不注入且無任何紅燈，
  // 正是本片段要防的失敗形態。逐一 render 把 11 關全部鎖死（render({}) 只會 console.warn
  // 未匹配 placeholder，不會 throw）。
  test('11 關全數注入（防未來改名或打錯字靜默失效）', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const n of ['analysis-project', 'analysis-reject', 'clarify-chat', 'spec-review', 'qa',
                       'merge-explain', 'merge-clarify', 'cs', 'chat', 'chat-to-task', 'library']) {
        expect(loadAgent(n).render({})).toContain(PL_HEADER);
      }
    } finally { spy.mockRestore(); }
  });
});

// 意圖（Rule 9）：P6 要求分析關把權限攤開給人看。若 analysis-project 的 YAML 格式與範例沒有
// permissions 欄位，agent 不會憑空生出這一欄——規格審核畫面就永遠是空的，P6 形同虛設。
test('analysis-project 的 YAML 格式與範例都含 permissions 區塊（P6 的落地點）', () => {
  const body = require('../pipeline/agent-loader').loadAgent('analysis-project').body;
  // 格式區塊與 <result> 範例各一次，共 2 次
  expect(body.split('permissions:').length - 1).toBe(2);
  expect(body).toContain('沒有涉及權限異動就留空');
});

// 意圖（Rule 9）：clarify-chat／spec-review／respec-patch 三關手上原本只有 analysis_yaml，
// 連「使用者說的『客戶代號』是哪個 Field」都得回頭問人（正式站 task 171：8 個來回、6 分鐘、
// $1.4 還沒推進）。片段給它們 repo 路徑＋「查得到就別問」的硬規則，呼叫端同時把 cwd 指到同一個 worktree。
describe('SPEC_LOOKUP_AGENTS 注入查碼守則', () => {
  const { loadAgent, promptVersion } = require('../pipeline/agent-loader');
  const SL_HEADER = '# 查核程式碼';

  test('三關都拿得到，且 repo 路徑真的被填進去（沒填＝agent 不知道要去哪查）', () => {
    const paths = '- C:/repos/hj/.worktrees/task_9/idx_hj';
    const clar = loadAgent('clarify-chat').render({ analysis_yaml: 'module: hj', conversation: 'x', mode_rule: 'r', repo_paths: paths });
    const spec = loadAgent('spec-review').render({ analysis_yaml: 'module: hj', conversation: 'x', repo_paths: paths });
    const patch = loadAgent('respec-patch').render({ analysis_yaml: 'module: hj', requirements: '1. x', repo_paths: paths });
    for (const out of [clar, spec, patch]) {
      expect(out).toContain(SL_HEADER);
      expect(out).toContain(paths);
    }
  });

  // 這條是本次改動最容易靜默壞掉的地方：任務還沒建 worktree 時呼叫端傳空字串，
  // 若照樣注入，agent 會拿到一份「路徑是空的」的查碼指令，然後開始自己亂找（歷程實測會滾成掃碟）。
  test('沒有 repo 路徑時整段不注入，不留下空路徑的查碼指令', () => {
    const out = loadAgent('clarify-chat').render({ analysis_yaml: 'module: hj', conversation: 'x', mode_rule: 'r', repo_paths: '' });
    expect(out).not.toContain(SL_HEADER);
  });

  test('本來就有 source-routing 的關（qa）不重複注入這一份', () => {
    const out = loadAgent('qa').render({
      main_branch: 'main', git_branch: 'task/x', repo_paths: '- /w/sale',
      analysis_yaml: 'module: sale', diff: 'x', resolution: '（無）'
    });
    expect(out).not.toContain(SL_HEADER);
  });

  // 同 plain-language 的教訓：片段沒進指紋 → 綁定的 resume session 不 fresh，新規則永遠不生效且無錯誤訊息
  test('promptVersion 把查碼片段算進靜態指紋', () => {
    const fs = require('fs');
    const path = require('path');
    const SL_PATH = path.join(__dirname, '..', 'pipeline', 'spec-lookup.md');
    const orig = fs.readFileSync(SL_PATH, 'utf8');
    try {
      const before = promptVersion('clarify-chat');
      fs.writeFileSync(SL_PATH, orig + '\n\n<!-- 指紋探針 -->\n');
      expect(promptVersion('clarify-chat')).not.toBe(before);
      expect(promptVersion('qa')).toBe(promptVersion('qa')); // 未注入的關不受影響
    } finally {
      fs.writeFileSync(SL_PATH, orig);
    }
  });
});

// 意圖（Rule 9）：發問守則要進「會產出要使用者回答的問題」的四關。三條規則各自針對一個實測過的病症：
// Q1 決策樹＝規格只寫了「一次列齊所有阻斷性模糊點」卻沒給窮盡的方法；Q2＝把該自己讀 code 的事拿去問人
// （cs 已有此規則、成效實證，這裡泛化到其他三關）；Q3＝丟白卷讓非工程師面對空白提示詞。
// 名單刻意不含 spec-review／respec-patch（只回答與改規格、自己不提問）與 qa（低頻出口，且每輪必跑＝最貴注入點）。
describe('ASKING_WELL_AGENTS 注入發問守則', () => {
  const { loadAgent, promptVersion } = require('../pipeline/agent-loader');
  const AW_HEADER = '# 發問守則';

  // 名單裡打錯字或日後 agent 檔改名 → 靜默不注入、無任何紅燈，正是本片段要防的失敗形態
  test('四關全數注入（防未來改名或打錯字靜默失效）', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const n of ['analysis-project', 'clarify-chat', 'analysis-reject', 'cs']) {
        expect(loadAgent(n).render({})).toContain(AW_HEADER);
      }
    } finally { spy.mockRestore(); }
  });

  // 這條鎖住的是「誰該收到」這個判斷本身：spec-review／respec-patch 讀對話後只回答或重產規格，
  // 自己不提問；qa 的 spec_questions 是低頻出口而它每輪必跑。日後要加人進來必須先讓這條紅。
  test('不產題目的關不注入（spec-review／respec-patch／qa／coding-project）', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const n of ['spec-review', 'respec-patch', 'qa', 'coding-project']) {
        expect(loadAgent(n).render({})).not.toContain(AW_HEADER);
      }
    } finally { spy.mockRestore(); }
  });

  test('順序：CLAUDE.md 規則 → 說人話 → 發問守則 → 專案備註 → debug', () => {
    const out = loadAgent('analysis-reject').render({
      project_name: 'P', odoo_version: '17.0', main_branch: 'main', git_branch: 'task/x',
      analysis_yaml: 'module: sale', stuck_stage: 'QA', stop_context: 'x',
      user_instruction: 'y',
      project_notes: '窗口 Amy'
    });
    const iRules = out.indexOf('Odoo Constraints');
    const iPlain = out.indexOf('# 說人話守則');
    const iAsk = out.indexOf(AW_HEADER);
    const iNotes = out.indexOf('# 專案備註（人工維護，優先遵循）');
    const iDebug = out.indexOf('# 系統化除錯（pipeline 版）');
    expect(iRules).toBeGreaterThanOrEqual(0);
    expect(iPlain).toBeGreaterThan(iRules);
    expect(iAsk).toBeGreaterThan(iPlain);
    expect(iNotes).toBeGreaterThan(iAsk);
    expect(iDebug).toBeGreaterThan(iNotes);
  });

  // 三條規則是這支片段的全部價值；被截斷或改寫掉其中一條，注入照樣「成功」而不會有紅燈
  test('三條規則都在片段裡（片段被截斷時要紅）', () => {
    const out = loadAgent('analysis-project').render({
      project_name: 'P', odoo_version: '17.0', work_dir: '/w', repo_list: '- sale/',
      task_id: 'task_1', original_text: 'x', clarification: '（無）', cs_findings: '（無）',
      main_branch: 'main', git_branch: 'task/x', repo_paths: '- /w/sale'
    });
    expect(out).toContain('## Q1 先攤決策樹，再決定哪些要問');
    expect(out).toContain('## Q2 查得到的事實不准問');
    expect(out).toContain('## Q3 每題附建議答案與猜錯的代價');
  });

  // 同 plain-language／spec-lookup 的教訓：片段沒進指紋 → 綁定的 resume session 不 fresh，
  // 新規則永遠不生效且無錯誤訊息，事後查不出原因
  test('promptVersion 把發問守則算進靜態指紋（改片段就換版）', () => {
    const fs = require('fs');
    const path = require('path');
    const AW_PATH = path.join(__dirname, '..', 'pipeline', 'asking-well.md');
    const orig = fs.readFileSync(AW_PATH, 'utf8');
    try {
      const before = promptVersion('clarify-chat');
      const beforeQa = promptVersion('qa');
      fs.writeFileSync(AW_PATH, orig + '\n\n<!-- 指紋探針 -->\n');
      expect(promptVersion('clarify-chat')).not.toBe(before);
      expect(promptVersion('qa')).toBe(beforeQa); // 未注入的關不受影響
    } finally {
      fs.writeFileSync(AW_PATH, orig);
    }
  });
});

// 意圖：MCP 名單漏登記與「刻意不掛」在程式上長得一樣（都是查不到 key → none.json），
// 沒有守衛就分不出來。實際代價：playwright-spec 的 prompt 明寫「走 context7 查證、不要掃碟找
// Odoo 核心原始碼」，但 spec_tour 沒進 MCP_PROFILES，agent 於是改用 WebSearch/WebFetch 去抓
// Odoo core，跑滿逾時零產出。這組測試逼「新增 stage 必須在兩張表之一做出決定」。
describe('MCP_PROFILES 覆蓋所有 agent stage', () => {
  const path = require('path');
  const { MCP_PROFILES, NO_MCP_STAGES, mcpConfigPath } = require('../pipeline/claude-runner');

  // agent 定義是 stage 的唯一來源；直接掃目錄而非寫死清單，新增 agent 才擋得住
  const stages = [...new Set(L.listNames()
    .map(n => L.loadAgent(n).stage)
    .filter(Boolean))];

  test('每個 stage 都做過明確決定（掛 MCP 或具名不掛）', () => {
    expect(stages.length).toBeGreaterThan(10);   // 掃空了就不是「全過」而是沒測到
    const undecided = stages.filter(s => !(s in MCP_PROFILES) && !NO_MCP_STAGES.has(s));
    expect(undecided).toEqual([]);
  });

  test('兩張表不得重疊（同一個 stage 不能又掛又不掛）', () => {
    const both = Object.keys(MCP_PROFILES).filter(s => NO_MCP_STAGES.has(s));
    expect(both).toEqual([]);
  });

  test('NO_MCP_STAGES 不得列入已不存在的 stage', () => {
    const stale = [...NO_MCP_STAGES].filter(s => !stages.includes(s));
    expect(stale).toEqual([]);
  });

  // 上面三條只驗名單自洽；這條驗名單真的接到子行程參數上——spec_tour 當初正是「prompt 寫了、
  // 表沒填」，若只比對名單而不看 mcpConfigPath 的實際回傳，補完名單仍可能接錯檔。
  test('prompt 叫 agent 查 context7 的關卡，實際拿到的是 context7 設定檔', () => {
    const asked = L.listNames()
      .map(n => ({ name: n, agent: L.loadAgent(n) }))
      .filter(({ agent }) => agent.stage && /context7/.test(agent.render({})))
      // spec-lookup.md 那幾關明寫「你這一關也沒有 context7」，是否定句、不算要求
      .filter(({ agent }) => !NO_MCP_STAGES.has(agent.stage));
    // 不寫死清單（注入片段會讓成員變動，例如 cs-capability 讓 chat／cs 也入列），
    // 但 playwright-spec 必須在內：它就是本組測試要擋的那個回歸
    expect(asked.map(a => a.name)).toContain('playwright-spec');
    for (const { name, agent } of asked) {
      expect(`${name}:${path.basename(mcpConfigPath(agent.stage))}`)
        .toMatch(new RegExp(`^${name}:context7(\\.local)?\\.json$`));
    }
  });
});
