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
    // ⚠ 這個 fixture 必須列齊 chat 目前所有的 placeholder：updateAgent 會擋下「新 prompt 少了
    // 既有 placeholder」的更新（JS 端仍在傳那份資料）。agent 加了新 placeholder 就要補進來，
    // 否則這條會紅在防護上，而不是紅在真的壞掉。
    const p = '新的提示詞 {{project_name}} {{wiki}} {{data_source_hint}} {{history}} {{user_message}}';
    const updated = L.updateAgent('chat', { prompt: p });
    expect(updated.body.trim()).toBe(p);
    expect(updated.render({ project_name: 'P', wiki: 'W', data_source_hint: '', history: 'H', user_message: 'X' })).toContain('X');
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

// 意圖：agent 打 /ai/* 的 curl 指引寫死在 prompt 裡，通行碼 header 名稱卻是 lib/ai-token 的常數——
// 兩邊分開改就會脫鉤，而症狀是 403「通行碼不正確或未帶」，看起來像認證壞了，完全不指向 prompt。
// 這組把「prompt 教的寫法」釘死在實作上：新增任何 /ai/* 指引都自動受檢，不必記得回來補測試。
describe('/ai/* 的 curl 指引與實作綁在一起', () => {
  const L = require('../pipeline/agent-loader');
  const { AI_TOKEN_HEADER } = require('../lib/ai-token');

  // 每個 agent 都給齊 placeholder 太脆弱；直接讀檔比對，反正 curl 指引不含動態值以外的變數。
  // 共用片段（pipeline/*.md）也要掃——wiki 的 curl 指引就住在 cs-capability.md，只掃 agents/ 會漏掉。
  const fs = require('fs'), path = require('path');
  const agentsDir = path.join(__dirname, '..', '..', '..', '.claude', 'agents');
  const fragDir = path.join(__dirname, '..', 'pipeline');
  const bodies = [
    ...L.listNames().map(n => ({ name: n, body: fs.readFileSync(path.join(agentsDir, `${n}.md`), 'utf8') })),
    ...fs.readdirSync(fragDir).filter(f => f.endsWith('.md'))
      .map(f => ({ name: `pipeline/${f}`, body: fs.readFileSync(path.join(fragDir, f), 'utf8') })),
  ];

  test('凡教 agent 打 /ai/*，header 一律用現行的通行碼名稱（大小寫不拘）', () => {
    const offenders = [];
    for (const { name, body } of bodies) {
      for (const line of body.split('\n')) {
        if (!/\$AIDEV_AI_BASE\/ai\//.test(line)) continue;
        if (!new RegExp(AI_TOKEN_HEADER, 'i').test(line)) offenders.push(`${name}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // 教了一支不存在的端點＝agent 白打一次拿 404，然後照自己的猜測往下寫，全程無訊號
  test('prompt 教的 /ai/ 路徑都真的有註冊', () => {
    const express = require('express');
    const app = express();
    // route 檔 require 進來會連帶拉 auth，載入時就要 JWT_SECRET（見 rules/pipeline 89）
    const prevJwt = process.env.JWT_SECRET;
    process.env.JWT_SECRET = prevJwt || 'test-agent-loader-ai-paths';
    try {
      for (const mod of ['../wiki-routes', '../ai-task-routes', '../db-query-routes']) {
        require(mod).registerRoutes(app);
      }
    } finally {
      if (prevJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prevJwt;
    }
    const registered = app._router.stack
      .filter(l => l.route).map(l => l.route.path).filter(p => p.startsWith('/ai/'));
    const taught = new Set();
    for (const { body } of bodies) {
      for (const m of body.matchAll(/\$AIDEV_AI_BASE(\/ai\/[a-z0-9/_-]+)/gi)) taught.add(m[1]);
    }
    expect(taught.size).toBeGreaterThanOrEqual(5); // 掃空／只掃到一半都不是「全過」而是沒測到
    expect([...taught]).toEqual(expect.arrayContaining(['/ai/tasks/spec', '/ai/wiki/pages'])); // agents/ 與共用片段各要有代表
    expect([...taught].filter(p => !registered.includes(p))).toEqual([]);
  });

  // 埠號寫死是上一版的實際故障：prompt 寫 localhost:3939（index.js 的預設值），正式機 PORT=8771，
  // 於是每一支 /ai/* curl 都是 connection refused。這種失敗連 server 都沒碰到，403/503 那些
  // 指得出真因的訊息一句都送不出來，agent 只會回報「讀不到」——上一版守衛全綠，因為它自己也寫死 3939。
  test('prompt 一律用 $AIDEV_AI_BASE，不得寫死 host:port', () => {
    const offenders = [];
    for (const { name, body } of bodies) {
      for (const line of body.split('\n')) {
        if (/localhost:\d+/.test(line)) offenders.push(`${name}: ${line.trim().slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // 變數名兩邊分開改就會脫鉤：prompt 展開成空字串後 curl 打 `/ai/figma`（相對路徑）直接失敗，
  // 而 spawn env 那側照樣綠。名稱釘在 lib/ai-token 的實作上，改一邊就紅。
  test('prompt 用的變數名＝claude-runner 實際注入的 key', () => {
    const { aiBaseEnv } = require('../lib/ai-token');
    const keys = Object.keys(aiBaseEnv());
    expect(keys).toEqual(['AIDEV_AI_BASE']);
    const users = bodies.filter(b => b.body.includes(`$${keys[0]}/ai/`));
    expect(users.length).toBeGreaterThanOrEqual(2); // analysis（相似任務／既有規格）／cs-capability（wiki 三支）
  });

  // Figma 能力已於 2026-08-14 整組移除。原因不是實作壞掉，是額度：Figma 的 Tier 1（讀檔案／讀節點）
  // 對 View／Collab seat 是 **6 次／月**，而一張任務光是 cs→分析→respec→分析 就會抓上八次。
  // task 136 實際打了約 30 次，把當月配額一次燒光（Retry-After 指到 4.4 天後），分析關空轉到死。
  // 端點、token 管理、後台設定都拔了，所以 prompt 只能教「讀不到，請使用者用文字或截圖描述」。
  // 誰把 curl 加回來這條就紅——連同上面「教的 /ai/ 路徑都真的有註冊」，兩道一起擋。
  test('沒有任何 prompt 還在教 /ai/figma（端點已移除，教了就是叫 agent 去打 404）', () => {
    expect(bodies.filter(b => /\/ai\/figma/.test(b.body)).map(b => b.name)).toEqual([]);
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
// 名單刻意不含 spec-review／respec-patch 與 qa，但兩者理由不同：qa 是低頻出口且每輪必跑＝最貴注入點；
// spec-review／respec-patch 則是 body 各自寫了完整的「什麼情況一定要反問」規則（2026-08-20 更正：
// 原註解寫它們「自己不提問」是錯的），它們吃的是 QUESTIONS_CONTRACT_AGENTS 的格式契約。
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

  // 這條鎖住的是「誰該收到」這個判斷本身：qa 的 spec_questions 是低頻出口而它每輪必跑；
  // spec-review／respec-patch 的反問規則寫在各自 body。日後要加人進來必須先讓這條紅。
  test('不吃發問守則的關（spec-review／respec-patch／qa／coding-project）', () => {
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

// 意圖（Rule 9）：三關原本各自手抄一份「題目撰寫契約」，且已經漂移——analysis-project 寫了
// `depends_on: { question: q1, equals: A }` 的完整語法，clarify-chat 只寫「用 depends_on 欄位表達」，
// 於是同一份畫面規格在兩關有兩種寫法。抽成片段後三關共用同一份真相；這組測試鎖住「誰吃、順序、
// 內容完整、進指紋」四件事，因為漏注入與內容被截斷都是靜默失敗（agent 照跑，只是格式錯到畫面上）。
describe('QUESTIONS_CONTRACT_AGENTS 注入題目撰寫契約', () => {
  const { loadAgent, promptVersion } = require('../pipeline/agent-loader');
  const QC_HEADER = '# 題目撰寫契約';

  test('三關全數注入（防未來改名或打錯字靜默失效）', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const n of ['analysis-project', 'clarify-chat', 'respec-patch']) {
        expect(loadAgent(n).render({})).toContain(QC_HEADER);
      }
    } finally { spy.mockRestore(); }
  });

  // clarify-chat-retry 走 --resume 繼承上一輪對話，重送共用片段等於重複佔 context
  // （rules/agent-prompt 104）。它 body 裡只留一句指回，不吃這片段——日後要加它必須先讓這條紅。
  test('retry 關與不產題目的關不注入（clarify-chat-retry／qa／coding-project／chat）', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const n of ['clarify-chat-retry', 'qa', 'coding-project', 'chat']) {
        expect(loadAgent(n).render({})).not.toContain(QC_HEADER);
      }
    } finally { spy.mockRestore(); }
  });

  // 契約規範的是 body 的輸出格式，故排在所有共用片段之後、最貼近 body
  test('順序：發問守則 → 專案備註 → 題目撰寫契約 → body', () => {
    const out = loadAgent('analysis-project').render({
      project_name: 'P', odoo_version: '17.0', work_dir: '/w', repo_list: '- sale/',
      task_id: 'task_1', original_text: 'x', clarification: '（無）', cs_findings: '（無）',
      main_branch: 'main', git_branch: 'task/x', repo_paths: '- /w/sale',
      project_notes: '窗口 Amy'
    });
    const iAsk = out.indexOf('# 發問守則');
    const iNotes = out.indexOf('# 專案備註（人工維護，優先遵循）');
    const iQc = out.indexOf(QC_HEADER);
    const iBody = out.indexOf('你是 Odoo 開發需求分析師');
    expect(iAsk).toBeGreaterThanOrEqual(0);
    expect(iNotes).toBeGreaterThan(iAsk);
    expect(iQc).toBeGreaterThan(iNotes);
    expect(iBody).toBeGreaterThan(iQc);
  });

  // 這七條是片段的全部價值；被截斷或改寫掉任一條，注入照樣「成功」而不會有紅燈。
  // 每條都對應一個實際壞掉的樣子：雙重編號、條件敘述寫進 text 逼使用者自己判斷該不該答、
  // 選項寫成 (A)(B)(C) 讓他打字、丟白卷沒有建議、把定義題也附上建議而誘導他按預設。
  test('七條規則都在片段裡（片段被截斷時要紅）', () => {
    const out = loadAgent('clarify-chat').render({ analysis_yaml: 'module: sale', conversation: 'x', mode_rule: 'answer' });
    expect(out).toContain('不得放進 `questions`');
    expect(out).toContain('`id`／`text`／`type`');
    expect(out).toContain('雙重編號');
    expect(out).toContain('depends_on: { question: q1, equals: A }');
    expect(out).toContain('(A)(B)(C)');
    expect(out).toContain('recommended_why');
    expect(out).toContain('不得換個說法再問一次');
  });

  // 同 asking-well／plain-language 的教訓：片段沒進指紋 → 綁定的 resume session 不 fresh，
  // 新規則永遠不生效且無錯誤訊息
  test('promptVersion 把題目撰寫契約算進靜態指紋（改片段就換版）', () => {
    const fs = require('fs');
    const path = require('path');
    const QC_PATH = path.join(__dirname, '..', 'pipeline', 'questions-contract.md');
    const orig = fs.readFileSync(QC_PATH, 'utf8');
    try {
      const before = promptVersion('analysis-project');
      const beforeChat = promptVersion('chat');
      fs.writeFileSync(QC_PATH, `${orig}\n\n<!-- 指紋探針 -->\n`);
      expect(promptVersion('analysis-project')).not.toBe(before);
      expect(promptVersion('chat')).toBe(beforeChat); // 未注入的關不受影響
    } finally {
      fs.writeFileSync(QC_PATH, orig);
    }
  });
});

// 意圖（Rule 9）：第二輪去重的三個片段。抽取判準是「會不會漂移」而非「重複幾次」——這三組在各 body
// 的措辭都已各自演化（figma 有五份、每份的後續動作不同；必問三種有四份、只有兩份帶「不是可以嗎」的
// 問法提示；視覺值有三份、只有一份提到 figma）。反之「Think in English…」那句雖也重複五份卻逐字相同、
// 內容穩定，刻意不抽（抽了只是多一個檔要維護）。這組測試鎖住「誰吃、內容完整、方位詞指得到、進指紋」。
describe('第二輪共用片段（must-ask／figma／visual-values）', () => {
  const { loadAgent, promptVersion } = require('../pipeline/agent-loader');
  const MA = '# 這三種一律要問';
  const FG = '# 需求、對話或附件裡出現 figma.com 連結時';
  const VV = '# 規格裡既有的視覺值不准憑印象改';
  const quiet = fn => { const spy = jest.spyOn(console, 'warn').mockImplementation(() => {}); try { fn(); } finally { spy.mockRestore(); } };

  test('must-ask 進四關、不進其他關', () => {
    quiet(() => {
      for (const n of ['analysis-project', 'clarify-chat', 'respec-patch', 'spec-review']) {
        expect(loadAgent(n).render({})).toContain(MA);
      }
      // qa 的 spec_questions 是低頻出口；coding／chat 不產規格題目
      for (const n of ['qa', 'coding-project', 'chat', 'clarify-chat-retry']) {
        expect(loadAgent(n).render({})).not.toContain(MA);
      }
    });
  });

  // chat／cs 原本從 cs-capability.md 拿到 figma 段，改由本片段供應——漏掉它們等於這兩關靜默失去該規則
  test('figma 進六關（含 chat／cs：從 cs-capability 搬家而來）', () => {
    quiet(() => {
      for (const n of ['analysis-project', 'clarify-chat', 'respec-patch', 'spec-review', 'chat', 'cs']) {
        expect(loadAgent(n).render({})).toContain(FG);
      }
      for (const n of ['qa', 'coding-project', 'merge']) {
        expect(loadAgent(n).render({})).not.toContain(FG);
      }
    });
  });

  // 產生端（analysis-project 看截圖量值）與保護端（不准憑印象改）規則不同，刻意只給保護端
  test('visual-values 只進保護端兩關，不進產生端', () => {
    quiet(() => {
      for (const n of ['spec-review', 'respec-patch']) expect(loadAgent(n).render({})).toContain(VV);
      for (const n of ['analysis-project', 'spec-review-retry', 'clarify-chat']) {
        expect(loadAgent(n).render({})).not.toContain(VV);
      }
    });
  });

  // 片段內互相引用時寫了方位詞（visual-values 說「理由見上方【figma】」、cs-capability 說「見下方【figma】」）。
  // 注入順序一改，這些方位詞就指向錯的地方，而且不會有任何紅燈——這條把順序釘死。
  test('方位詞指得到：spec-review 是 must-ask → figma → visual-values → body', () => {
    const out = loadAgent('spec-review').render({ analysis_yaml: 'module: sale', conversation: 'x', repo_paths: '- /w/sale' });
    const iMa = out.indexOf(MA), iFg = out.indexOf(FG), iVv = out.indexOf(VV);
    const iBody = out.indexOf('你是 Odoo 開發任務「規格審核閘門」的對話夥伴');
    expect(iMa).toBeGreaterThanOrEqual(0);
    expect(iFg).toBeGreaterThan(iMa);
    expect(iVv).toBeGreaterThan(iFg);   // visual-values 說「理由見上方【figma】」
    expect(iBody).toBeGreaterThan(iVv); // 各 body 說「見上方【…】」
  });

  test('cs-capability 在 figma 之上（它寫的是「見下方【figma】」）', () => {
    const out = loadAgent('cs').render({ project_name: 'P', project_slug: 'p', repo_paths: '- /w/sale', title: 't', original_text: 'x' });
    expect(out.indexOf('你是本專案的技術客服')).toBeLessThan(out.indexOf(FG));
  });

  test('三份片段的核心條款都在（被截斷時要紅）', () => {
    const out = loadAgent('respec-patch').render({ analysis_yaml: 'module: sale', requirements: 'x', repo_paths: '- /w/sale' });
    expect(out).toContain('兩種以上合理做法');       // must-ask 條一
    expect(out).toContain('已過帳的單據還能不能改');  // must-ask 條二
    expect(out).toContain('**不是**「可以嗎」');       // must-ask 條三的問法提示
    expect(out).toContain('只拿得到空殼');            // figma
    expect(out).toContain('更協調');                  // visual-values：形容詞化＝把規格作廢
    expect(out).toContain('hover');                   // visual-values：量不出來的項目
  });

  test('promptVersion 把三份片段都算進靜態指紋', () => {
    const fs = require('fs');
    const path = require('path');
    for (const [file, agent, unaffected] of [
      ['must-ask.md', 'analysis-project', 'chat'],
      ['figma-unavailable.md', 'chat', 'qa'],
      ['visual-values.md', 'spec-review', 'analysis-project']
    ]) {
      const P = path.join(__dirname, '..', 'pipeline', file);
      const orig = fs.readFileSync(P, 'utf8');
      try {
        const before = promptVersion(agent);
        const beforeUn = promptVersion(unaffected);
        fs.writeFileSync(P, `${orig}\n\n<!-- 指紋探針 -->\n`);
        expect(promptVersion(agent)).not.toBe(before);
        expect(promptVersion(unaffected)).toBe(beforeUn);
      } finally {
        fs.writeFileSync(P, orig);
      }
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

// ---------------------------------------------------------------------------
// provider / effort（pipeline agent 可選 AI 供應商）
//
// 意圖：這一組鎖的不是「欄位存不存在」，而是四種**靜默**失效——每一種都不會報錯、
// 測試不寫就永遠沒有訊號：
//   1. 未知 provider 若靜默退回 claude → 管理頁顯示 codex、實際燒 claude 額度。
//   2. effort 用全域清單校驗 → 放行 gpt-5.4+max，codex 在設定載入階段不擋，spawn 才失敗。
//   3. promptVersion 不含 provider → 切換後護欄以為可續接，拿 claude 的 session 去 codex resume。
//   4. prompt 還寫著 Skill(...) 就切 codex → 那幾支會照指示回報「一切正常」。
// ---------------------------------------------------------------------------

describe('provider / effort', () => {
  const ELIGIBLE = 'reject-classifier';   // 在 CODEX_ELIGIBLE 內、prompt 無 Skill(
  let original;
  beforeAll(() => { original = fs.readFileSync(L.agentPath(ELIGIBLE), 'utf8'); });
  afterAll(() => { fs.writeFileSync(L.agentPath(ELIGIBLE), original); L.invalidate(ELIGIBLE); });

  const expect400 = (fn) => {
    try { fn(); throw new Error('應該要被擋下卻通過了'); }
    catch (e) { expect(e.status).toBe(400); return e.message; }
  };

  test('未指定 provider 的既有 agent＝claude，且不帶 effort', () => {
    const a = L.loadAgent('qa');
    expect(a.provider).toBe('claude');
    expect(a.effort).toBeUndefined();   // claude 沒有這個維度，帶了會讓人以為調它有用
  });

  test('未知 provider 直接擋，不得靜默退回 claude', () => {
    const msg = expect400(() => L.updateAgent(ELIGIBLE, { provider: 'gemini' }));
    // 必須斷言是「provider 這道守衛」擋的。只驗 status 400 是假綠：拿掉這道檢查後，
    // 下一道「model 不屬於該 provider」照樣丟 400、訊息也含 gemini，測試會因為錯的理由通過。
    expect(msg).toContain('不支援的 provider');
    expect(msg).toContain('gemini');
  });

  test('換 provider 未一併給 model 就擋（不替使用者自動挑一支）', () => {
    expect400(() => L.updateAgent(ELIGIBLE, { provider: 'codex' }));
  });

  test('model 不屬於該 provider 就擋', () => {
    expect400(() => L.updateAgent(ELIGIBLE, { provider: 'codex', model: 'sonnet' }));
  });

  test('effort 逐模型校驗：gpt-5.4 不支援 max（用全域清單會放行）', () => {
    // gpt-5.6-terra 有 max，gpt-5.4 只到 xhigh。這一條是本組最關鍵的斷言：
    // codex 在設定載入階段不校驗 effort 值，平台這裡是唯一防線。
    expect(L.modelEfforts('codex', 'gpt-5.6-terra')).toContain('max');
    expect(L.modelEfforts('codex', 'gpt-5.4')).not.toContain('max');
    const msg = expect400(() => L.updateAgent(ELIGIBLE, { provider: 'codex', model: 'gpt-5.4', effort: 'max' }));
    expect(msg).toContain('max');
  });

  test('不在 CODEX_ELIGIBLE 的 agent 不得切 codex（掃碟守衛尚未移植）', () => {
    expect(L.CODEX_ELIGIBLE.has('qa')).toBe(false);
    expect400(() => L.updateAgent('qa', { provider: 'codex', model: 'gpt-5.6-terra' }));
  });

  test('chat is eligible for Codex in Agent management', () => {
    expect(L.CODEX_ELIGIBLE.has('chat')).toBe(true);
    expect(L.loadAgent('chat').body).not.toContain('Skill(');
  });

  test('workflow-health 還原 Claude 預設後保留 Claude Skill 契約', () => {
    const agent = L.loadAgent('workflow-health');
    expect(agent.provider).toBe('claude');
    expect(agent.body).toContain('Skill(healthCheck)');
  });

  test('provider 為 claude 時不接受 effort', () => {
    expect400(() => L.updateAgent(ELIGIBLE, { effort: 'high' }));
  });

  test('切 codex 寫入三欄；切回 claude 會移除 effort 欄', () => {
    const on = L.updateAgent(ELIGIBLE, { provider: 'codex', model: 'gpt-5.6-terra', effort: 'high' });
    expect(on.provider).toBe('codex');
    expect(on.model).toBe('gpt-5.6-terra');
    expect(on.effort).toBe('high');
    expect(fs.readFileSync(L.agentPath(ELIGIBLE), 'utf8')).toMatch(/^effort: high$/m);

    const off = L.updateAgent(ELIGIBLE, { provider: 'claude', model: 'haiku' });
    expect(off.provider).toBe('claude');
    expect(off.effort).toBeUndefined();
    // 欄位要真的從檔案消失，不是只在物件上不見——留著下次切回 codex 會沿用一個沒人選過的值
    expect(fs.readFileSync(L.agentPath(ELIGIBLE), 'utf8')).not.toMatch(/^effort:/m);
  });

  test('promptVersion：provider 與 model 會變動指紋，effort 不會', () => {
    L.updateAgent(ELIGIBLE, { provider: 'claude', model: 'haiku' });
    const base = L.promptVersion(ELIGIBLE);

    // 換 model → 必須變（同一 provider 內換模型也不該續用同一 session 的判斷基礎）
    L.updateAgent(ELIGIBLE, { model: 'sonnet' });
    expect(L.promptVersion(ELIGIBLE)).not.toBe(base);

    // 換 provider → 必須變。不變的話護欄會判定可續接，拿 claude 的 session id 去 codex resume，
    // 每輪白燒一次必定失敗的呼叫。
    L.updateAgent(ELIGIBLE, { provider: 'codex', model: 'gpt-5.6-terra', effort: 'low' });
    const codexVer = L.promptVersion(ELIGIBLE);
    expect(codexVer).not.toBe(base);

    // 只換 effort → **必須不變**。effort 不改變 prompt、也不會讓 session id 失效；
    // 納入指紋只會在調 effort 時無謂作廢所有 resume session 並掉 prompt cache。
    L.updateAgent(ELIGIBLE, { effort: 'high' });
    expect(L.loadAgent(ELIGIBLE).effort).toBe('high');
    expect(L.promptVersion(ELIGIBLE)).toBe(codexVer);
  });

  test('promptVersion：provider 單獨變動也要改指紋（model 固定）', () => {
    // 為什麼要特地寫這一支：兩家的模型名不重疊，走 updateAgent 就不可能「只換 provider」，
    // 上一支測試切 provider 時 model 也跟著換了，**測不出 provider 對指紋的貢獻**。
    // 這裡直接寫 frontmatter 繞過校驗，才問得到「hash 有沒有把 provider 算進去」。
    // 不這樣測的話，把 provider 從 hash 材料裡拿掉，整組測試依然全綠。
    const raw = fs.readFileSync(L.agentPath(ELIGIBLE), 'utf8');
    const withModelOnly = raw.replace(/^provider:.*\r?\n/m, '').replace(/^effort:.*\r?\n/m, '');

    fs.writeFileSync(L.agentPath(ELIGIBLE), withModelOnly.replace(/^model:.*$/m, 'model: X-SAME'));
    L.invalidate(ELIGIBLE);
    const asClaude = L.promptVersion(ELIGIBLE);

    fs.writeFileSync(L.agentPath(ELIGIBLE),
      withModelOnly.replace(/^model:.*$/m, 'model: X-SAME\nprovider: codex'));
    L.invalidate(ELIGIBLE);
    const asCodex = L.promptVersion(ELIGIBLE);

    expect(L.loadAgent(ELIGIBLE).model).toBe('X-SAME');   // 同一個 model
    expect(asCodex).not.toBe(asClaude);                    // 只有 provider 不同 → 指紋必須不同
  });

  test('PROVIDERS 不含 codex-auto-review（visibility: hide，codex review 專用）', () => {
    expect(L.providerModelIds('codex')).not.toContain('codex-auto-review');
    expect(L.providerModelIds('claude')).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
  });
});
