// 意圖：健檢 runner 遍歷有 stage 的 agent（排除 workflow_health 自己）落 findings，best-effort，run 收尾（工作流程健檢子專案 2）。
const { newDb } = require('pg-mem');
// 檔內多處把查詢結果解構成 `fs`，故 node 的 fs 另取名避免遮蔽
const nodeFs = require('fs');
const os = require('os');
const path = require('path');
const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
// 只健檢兩個假 agent，避免依賴真實 .md 清單
jest.mock('../pipeline/agent-loader', () => {
  const actual = jest.requireActual('../pipeline/agent-loader');
  return {
    ...actual,
    listAgents: () => ([
      { name: 'coding-project', stage: 'coding', label: '開發' },
      { name: 'qa', stage: 'qa', label: 'QA' },
      { name: 'workflow-health', stage: 'workflow_health', label: '健檢' } // 應被排除
    ]),
    loadAgent: (n) => n === 'workflow-health'
      ? { name: n, model: 'opus', render: () => 'RENDERED' }
      : actual.loadAgent(n)
  };
});
jest.mock('../pipeline/health-data', () => ({
  buildAgentSummary: jest.fn().mockResolvedValue({ token: {}, tasks: {}, rejections: null }),
  buildTaskSummary: jest.fn().mockResolvedValue({ scope: 'task:1', task: {}, sequence: [], per_stage: {} }),
  buildWindowSummary: jest.fn().mockResolvedValue({
    window: { since: '2026-08-20T00:00:00.000Z', until: '2026-08-21T00:00:00.000Z' },
    volume: { agent_calls: 12, tasks_touched: 4, cost_usd: 1.2, wall_clock: {} },
    per_stage: {}, tasks: [], rejections: []
  })
}));

const { buildAgentSummary, buildTaskSummary, buildWindowSummary } = require('../pipeline/health-data');   // 零樣本測試要逐次覆寫

let dbModule2, runHealthCheck, runTaskHealthCheck, runAudit, resumeInterruptedRuns, hcUserId;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule2 = require('../db');
  dbModule2._setPoolForTesting(new Pool());
  await dbModule2.migrate();
  const { rows: [u] } = await dbModule2.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hc','h','HC') RETURNING id");
  hcUserId = u.id;   // tasks.user_id 是 NOT NULL，跨關卡彙整的 fixture 要用
  // 深診上限在 module load 時讀 env，故必須在 require 之前設。設成 1 是為了讓「截斷要寫進
  // finding、不得靜默」那條測得到——本檔的 fixture 只有兩個 agent，用預設的 8 永遠碰不到上限。
  process.env.HEALTH_MAX_FOCUS = '1';
  ({ runHealthCheck, runTaskHealthCheck, runAudit, resumeInterruptedRuns } = require('../pipeline/health-check-runner'));
});
afterAll(() => dbModule2._setPoolForTesting(null));
beforeEach(() => mockRunClaude.mockReset());

async function newRun() {
  const { rows: [r] } = await dbModule2.query(
    "INSERT INTO health_check_runs (status, window_days) VALUES ('running',30) RETURNING id");
  return r.id;
}

test('runHealthCheck：遍歷有 stage 的 agent（排除 workflow_health），每個落 finding，run 設 done', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<result>{"diagnosis":"ok","severity":"low","suggested_prompt":null,"rationale":"r"}</result>',
    usage: { input_tokens: 1 }, durationMs: 10
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30, startedBy: null });

  const { rows: fs } = await dbModule2.query('SELECT agent_name, severity FROM health_check_findings WHERE run_id=$1 ORDER BY agent_name', [runId]);
  // __summary__＝per-agent 診斷跑完後追加的全域總結（見 summarizeRun）；workflow-health 自己仍被排除
  expect(fs.map(f => f.agent_name)).toEqual(['__summary__', 'coding-project', 'qa']);
  const { rows: [run] } = await dbModule2.query('SELECT status, finished_at FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('done');
  expect(run.finished_at).not.toBeNull();
});

test('每次呼叫 claude 都帶 repo 根當 cwd → 判準 skill 載得到', async () => {
  // headless claude 只認 cwd 的 project skill、不會往上層找，而 server 是 npm start（cwd=app/）起的。
  // 不帶 cwd 時 .claude/skills/healthCheck 載不到，agent 會在沒有判準的情況下照常產出診斷——
  // 測試全綠、健檢照跑，只是判讀規則沒生效。這條把 cwd 釘住，別再退回零訊號的狀態。
  mockRunClaude.mockResolvedValue({
    text: '<result>{"diagnosis":"ok","severity":"low","suggested_prompt":null,"rationale":"r"}</result>',
    usage: { input_tokens: 1 }, durationMs: 10
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30, startedBy: null });

  expect(mockRunClaude).toHaveBeenCalled();
  const repoRoot = path.join(__dirname, '..', '..', '..');
  for (const [, opts] of mockRunClaude.mock.calls) {
    expect(opts.cwd).toBe(repoRoot);
  }
  expect(nodeFs.existsSync(path.join(repoRoot, '.claude', 'skills', 'healthCheck', 'SKILL.md'))).toBe(true);
});

test('某 agent 解析失敗 → 落 severity=error finding，其他 agent 照跑，run 仍 done', async () => {
  // 兩個 agent × (主呼叫 + haiku 補救) 都回壞資料 → parseAgentResult 回 null
  mockRunClaude.mockResolvedValue({ text: '不是結果', usage: null, durationMs: 5 });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: fs } = await dbModule2.query('SELECT severity FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(fs.length).toBe(2);
  expect(fs.every(f => f.severity === 'error')).toBe(true);
  const { rows: [run] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('done');
});

test('診斷為空白字串（severity 合法）→ 不採信，落 severity=error finding', async () => {
  // diagnosis 是空白字串時即使 severity 合法也不算有效診斷，須落 fallback error finding
  mockRunClaude.mockResolvedValue({
    text: '<result>{"diagnosis":"  ","severity":"low","suggested_prompt":null,"rationale":"r"}</result>',
    usage: null, durationMs: 5
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: fs } = await dbModule2.query('SELECT severity FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(fs.length).toBe(2);
  expect(fs.every(f => f.severity === 'error')).toBe(true);
});

// --- 建議提示詞走獨立 <prompt> 區塊 ---
// 意圖（run#1 的真實故障）：被分析的 agent prompt 本身常含 <result> 契約範例。舊格式把它塞進
// JSON 的 suggested_prompt 欄位，於是 extractResult 的 lastIndexOf('</result>') 抓到 prompt body
// 裡的那一個，切出破碎 JSON → 整份診斷被丟掉。21 個 agent 有 5 個因此全滅，而且**全是有話要說的
// 那幾個**（判正常的不附提示詞反而都活下來）＝結果系統性偏向「一切正常」。
// 這支測試就是那個場景：建議的新提示詞內含 </result>。
test('建議提示詞內含 </result> → 走 <prompt> 區塊仍正確解析，不再全滅', async () => {
  const suggested = [
    '你是 Odoo 開發工程師。{{analysis_yaml}}',
    '【輸出】完成後輸出：',
    '<result>',
    '{"status":"qa_running"}',
    '</result>'
  ].join('\n');
  mockRunClaude.mockResolvedValue({
    text: `<prompt>\n${suggested}\n</prompt>\n<result>{"diagnosis":"重跑偏高","severity":"medium","has_prompt":true,"rationale":"r"}</result>`,
    usage: null, durationMs: 5
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: fs } = await dbModule2.query(
    "SELECT severity, diagnosis, suggested_prompt FROM health_check_findings WHERE run_id=$1 AND agent_name NOT IN ('__summary__','__system__')", [runId]);
  expect(fs.length).toBe(2);
  expect(fs.every(f => f.severity === 'medium')).toBe(true);   // 不再是 error
  expect(fs[0].diagnosis).toBe('重跑偏高');
  expect(fs[0].suggested_prompt).toContain('{{analysis_yaml}}'); // 動態欄位保住
  expect(fs[0].suggested_prompt).toContain('</result>');         // 被建議 agent 的契約也保住
});

// 判「正常」時不附 <prompt>：suggested_prompt 必須是 null，不能塞空字串（前端據此判斷有無建議）
test('無 <prompt> 區塊 → suggested_prompt 為 null', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<result>{"diagnosis":"表現正常","severity":"ok","has_prompt":false,"rationale":"r"}</result>',
    usage: null, durationMs: 5
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: fs } = await dbModule2.query(
    'SELECT severity, suggested_prompt FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(fs.every(f => f.severity === 'ok')).toBe(true);
  expect(fs.every(f => f.suggested_prompt === null)).toBe(true);
});

// 相容舊格式：agent 若仍把 suggested_prompt 放 JSON 裡（且內容不含 </result> 而解析得動），照樣接受。
// 不做這層相容的話，prompt 改版與 server 部署之間的空窗期會整批落 error。
test('舊格式（suggested_prompt 在 JSON 內）仍接受', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<result>{"diagnosis":"d","severity":"low","suggested_prompt":"新的提示詞 {{x}}","rationale":"r"}</result>',
    usage: null, durationMs: 5
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: fs } = await dbModule2.query(
    'SELECT severity, suggested_prompt FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(fs.every(f => f.severity === 'low')).toBe(true);
  expect(fs[0].suggested_prompt).toBe('新的提示詞 {{x}}');
});

// --- 長文字全部移出 JSON（run#2 的真實故障）---
// 意圖：run#1 只把 suggested_prompt 移出 JSON，治了一半——run#2 的 23 份仍有 7 份首解析失敗、
// 4 份連 haiku 補救都失敗整份報廢，而死的全是輸出量大的那幾份。根因是 diagnosis／rationale
// 這兩段數百字的中文還留在 JSON 字串裡：只要有一個沒逸出的引號或換行就切出破碎 JSON。
// 現在 JSON 只剩 severity 與 has_prompt 兩個短值。
test('診斷／理由走獨立標籤區塊，JSON 只剩短欄位 → 正確落 finding', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<diagnosis>\nrepeat_calls.avg 2.4，反覆重跑\n</diagnosis>\n' +
          '<rationale>\n加強驗收條件複述\n</rationale>\n' +
          '<result>{"severity":"medium","has_prompt":false}</result>',
    usage: null, durationMs: 5
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: fs } = await dbModule2.query(
    "SELECT severity, diagnosis, rationale, suggested_prompt FROM health_check_findings WHERE run_id=$1 AND agent_name NOT IN ('__summary__','__system__')", [runId]);
  expect(fs).toHaveLength(2);
  expect(fs.every(f => f.severity === 'medium')).toBe(true);
  expect(fs[0].diagnosis).toBe('repeat_calls.avg 2.4，反覆重跑');
  expect(fs[0].rationale).toBe('加強驗收條件複述');
  expect(fs[0].suggested_prompt).toBeNull();
});

// 這是整條鏈真正要擋的東西：診斷正文本來就會逐字引用被分析 agent 的契約與訊息，內含 </result>
// 與成對引號。舊格式（塞進 JSON 字串）遇到這種內容必定報廢；走標籤區塊則原樣存活。
test('診斷正文含 </result> 與未逸出引號 → 仍完整解析，不再報廢', async () => {
  const diag = '該 agent 的契約要求輸出 <result>{"a":1}</result>，但它回了「表現正常」這種散文。';
  mockRunClaude.mockResolvedValue({
    text: `<diagnosis>\n${diag}\n</diagnosis>\n<result>{"severity":"high","has_prompt":false}</result>`,
    usage: null, durationMs: 5
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: fs } = await dbModule2.query(
    'SELECT severity, diagnosis FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(fs.every(f => f.severity === 'high')).toBe(true);   // 不是 error
  expect(fs[0].diagnosis).toBe(diag);                        // 一字不缺
});

// severity 對不上的代價是整份診斷被丟掉，不值得為大小寫或尾隨空白付這個價（rules/pipeline.md §72）。
test('severity 帶大寫與空白 → 正規化後接受', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<diagnosis>d</diagnosis><result>{"severity":" OK ","has_prompt":false}</result>',
    usage: null, durationMs: 5
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: fs } = await dbModule2.query('SELECT severity FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(fs.every(f => f.severity === 'ok')).toBe(true);
});

// 止血：解析失敗時 opus 早就把診斷寫出來了（run#2 失敗的四份各 5–7k output tokens），
// 舊行為整份丟掉且不留存，於是「為什麼解析不過」永遠無從查起。
test('解析失敗 → 模型原始輸出落檔，且 diagnosis 指得出檔名', async () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));
  const prev = process.env.HEALTH_LOG_DIR;
  process.env.HEALTH_LOG_DIR = dir;
  try {
    mockRunClaude.mockResolvedValue({ text: '這是一段解析不出來的散文', usage: null, durationMs: 5 });
    const runId = await newRun();
    await runHealthCheck(runId, { windowDays: 30 });

    const { rows: fs } = await dbModule2.query(
      'SELECT severity, diagnosis FROM health_check_findings WHERE run_id=$1 ORDER BY agent_name', [runId]);
    expect(fs.every(f => f.severity === 'error')).toBe(true);
    expect(fs[0].diagnosis).toContain(`health-run${runId}-coding-project.log`);
    expect(nodeFs.readFileSync(path.join(dir, `health-run${runId}-coding-project.log`), 'utf8'))
      .toBe('這是一段解析不出來的散文');
  } finally {
    if (prev === undefined) delete process.env.HEALTH_LOG_DIR; else process.env.HEALTH_LOG_DIR = prev;
  }
});

// 零樣本不記 ok：實測 run#2 的 14 個 ok 裡，deploy-fix 與 wiki-drift-classifier 都是 0 次呼叫。
// 存成 ok 到前端就是一顆綠燈，整頁綠得虛胖反而蓋掉真正該看的那幾則。
test('該關近期零呼叫 → severity 覆寫為未取樣，不採信模型判的 ok', async () => {
  // 用 mockResolvedValue 而非 Once：分流階段也會為每個 agent 算一次摘要，Once 會被分流先吃掉，
  // 深診拿到的就變成預設值，測試會以「severity 是 ok」的形式假失敗（與零樣本邏輯本身無關）。
  buildAgentSummary.mockResolvedValue({ token: { calls: 0 }, tasks: {}, rejections: null });
  mockRunClaude.mockResolvedValue({
    text: '<diagnosis>零執行樣本，無訊號可判</diagnosis><result>{"severity":"ok","has_prompt":false}</result>',
    usage: null, durationMs: 5
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: fs } = await dbModule2.query(
    "SELECT severity FROM health_check_findings WHERE run_id=$1 AND agent_name NOT IN ('__summary__','__system__')", [runId]);
  expect(fs).toHaveLength(2);
  expect(fs.every(f => f.severity === 'n/a')).toBe(true);   // 不是 ok
});

// 有樣本時不得誤判成未取樣，否則上一條的覆寫會把整頁洗成未取樣、同樣失去鑑別力。
test('該關有呼叫紀錄 → 維持模型判定的 severity', async () => {
  // 同上：分流也會為每個 agent 算一次摘要，用 Once 會被它先吃掉（見零樣本那條的註解）
  buildAgentSummary.mockResolvedValue({ token: { calls: 12 }, tasks: {}, rejections: null });
  mockRunClaude.mockResolvedValue({
    text: '<diagnosis>各項正常</diagnosis><result>{"severity":"ok","has_prompt":false}</result>',
    usage: null, durationMs: 5
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: fs } = await dbModule2.query(
    "SELECT severity FROM health_check_findings WHERE run_id=$1 AND agent_name NOT IN ('__summary__','__system__')", [runId]);
  expect(fs.every(f => f.severity === 'ok')).toBe(true);
});

// --- 跨關卡彙整 ---
// 意圖：per-agent 健檢天生看不到「不屬於任何單一 agent」的問題。實測 run#1：同一個 blocker
// （asset bundle 編不出來）出現在七個 agent 的摘要裡，每一則都正確判定「屬環境層、非本 agent 的
// 提示詞可左右」——七個判斷都對，合起來沒有人負責，21 份 finding 沒有一則指向它。
test('多張任務卡在同一類原因 → 落一筆跨關卡的系統層 finding', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<result>{"diagnosis":"正常","severity":"ok","has_prompt":false,"rationale":"r"}</result>',
    usage: null, durationMs: 5
  });
  await dbModule2.query("DELETE FROM tasks");
  for (const [tid, blocker] of [
    ['s1', '[部署測試區 asset 檢查失敗]\n後台 JS bundle 編不出來：/web/assets/a.js → HTTP 500'],
    ['s2', '[部署測試區 asset 檢查失敗]\n後台 JS bundle 編不出來：/web/assets/b.js → HTTP 500'],
    ['s3', '[QA 未通過]\n欄位型別錯']
  ]) {
    await dbModule2.query(
      "INSERT INTO tasks (user_id, task_id, source, status, blocker_content, updated_at) VALUES ($3,$1,'manual','stopped',$2,NOW())",
      [tid, blocker, hcUserId]);
  }
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: [sys] } = await dbModule2.query(
    "SELECT agent_label, severity, diagnosis, suggested_prompt FROM health_check_findings WHERE run_id=$1 AND agent_name='__system__'", [runId]);
  expect(sys).toBeTruthy();
  expect(sys.agent_label).toBe('跨關卡彙整');
  expect(sys.severity).toBe('high');                       // 2/3 = 67% ≥ 50%
  expect(sys.diagnosis).toContain('部署測試區 asset 檢查失敗');
  expect(sys.diagnosis).toContain('2 張');
  expect(sys.suggested_prompt).toBeNull();                 // 這類問題改任何 agent 的 prompt 都沒用
});

// 不為報而報：沒有任何一類原因達到門檻時不得落 finding，否則每次健檢都多一筆噪音。
test('停下原因分散（無主要群） → 不落系統層 finding', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<result>{"diagnosis":"正常","severity":"ok","has_prompt":false,"rationale":"r"}</result>',
    usage: null, durationMs: 5
  });
  await dbModule2.query("DELETE FROM tasks");
  for (const [tid, blocker] of [
    ['d1', '[QA 未通過]\nA'], ['d2', '[部署失敗]\nB'], ['d3', '[E2E 失敗]\nC'], ['d4', '[環境問題]\nD']
  ]) {
    await dbModule2.query(
      "INSERT INTO tasks (user_id, task_id, source, status, blocker_content, updated_at) VALUES ($3,$1,'manual','stopped',$2,NOW())",
      [tid, blocker, hcUserId]);
  }
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows } = await dbModule2.query(
    "SELECT id FROM health_check_findings WHERE run_id=$1 AND agent_name='__system__'", [runId]);
  expect(rows).toHaveLength(0);   // 每類各 25%，未達 30% 門檻
});

// 「循環 2 次」與「循環 3 次」是同一類問題，不該因為數字不同被拆成兩群而雙雙未達門檻。
test('停下原因只差數字 → 正規化後視為同一類', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<result>{"diagnosis":"正常","severity":"ok","has_prompt":false,"rationale":"r"}</result>',
    usage: null, durationMs: 5
  });
  await dbModule2.query("DELETE FROM tasks");
  for (const [tid, blocker] of [
    ['n1', '任務在各關卡間循環 2 次仍未通過，需人工介入'],
    ['n2', '任務在各關卡間循環 3 次仍未通過，需人工介入'],
    ['n3', '[QA 未通過]\n別的問題']
  ]) {
    await dbModule2.query(
      "INSERT INTO tasks (user_id, task_id, source, status, blocker_content, updated_at) VALUES ($3,$1,'manual','stopped',$2,NOW())",
      [tid, blocker, hcUserId]);
  }
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: [sys] } = await dbModule2.query(
    "SELECT diagnosis FROM health_check_findings WHERE run_id=$1 AND agent_name='__system__'", [runId]);
  expect(sys).toBeTruthy();
  expect(sys.diagnosis).toContain('2 張');   // 兩筆循環被算成同一群
});

// --- 全域總結（跨關卡推理）---
// 意圖：per-agent 診斷各自為政，跨關問題會被每一關正確地判成「與本關無關」——每個判斷都對，
// 合起來沒有人負責。aggregateSystemFinding 只補了客觀統計（分組計數），做不了因果推理。
// 這組測試釘的是：總結真的讀到各關診斷（而非重新去讀原始數據）、與客觀統計分開存、失敗不拖垮整輪。
test('全域總結：讀本輪各關診斷 → 落一筆 __summary__，與 __system__ 分開', async () => {
  await dbModule2.query('DELETE FROM tasks');           // 清掉上一題的 stopped fixture，避免混入統計
  const seen = [];
  mockRunClaude.mockImplementation(async (prompt) => {
    seen.push(prompt);
    return {
      text: '<diagnosis>各關都把規格歧義丟給下一關</diagnosis><rationale>依客觀統計 2 張不同任務</rationale><result>{"severity":"medium"}</result>',
      usage: null, durationMs: 5
    };
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: [sum] } = await dbModule2.query(
    "SELECT diagnosis, severity, rationale, suggested_prompt FROM health_check_findings WHERE run_id=$1 AND agent_name='__summary__'", [runId]);
  expect(sum).toBeTruthy();
  expect(sum.severity).toBe('medium');
  expect(sum.diagnosis).toContain('丟給下一關');
  expect(sum.rationale).toContain('2 張不同任務');
  // 跨關問題改任何單一 agent 的 prompt 都沒用，硬給一份會把人導去改錯地方（比照 aggregateSystemFinding）
  expect(sum.suggested_prompt).toBeNull();
  // 總結的輸入必須是「已濃縮的各關診斷」而不是重新撈原始數據——否則它就只是第 22 個 per-agent 健檢
  const summaryPrompt = seen[seen.length - 1];
  expect(summaryPrompt).toContain('開發');   // agent_label 出現在餵給總結的 findings 區塊
  expect(summaryPrompt).toContain('QA');
});

test('全域總結解析不過 → 不落假 finding，run 仍 done', async () => {
  await dbModule2.query('DELETE FROM tasks');
  let n = 0;
  mockRunClaude.mockImplementation(async () => {
    n++;
    // 前兩次（per-agent）正常，第三次（總結）吐不合契約的東西
    return n <= 2
      ? { text: '<result>{"diagnosis":"ok","severity":"low"}</result>', usage: null, durationMs: 5 }
      : { text: '這是一段沒有任何契約標籤的散文', usage: null, durationMs: 5 };
  });
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: sum } = await dbModule2.query(
    "SELECT id FROM health_check_findings WHERE run_id=$1 AND agent_name='__summary__'", [runId]);
  expect(sum.length).toBe(0);                       // 寧可沒有，也不落一筆假的擠掉真正該看的
  const { rows: [run] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('done');                  // best-effort：不拖垮已完成的 per-agent 診斷
});

test('續跑：本輪已有 __summary__ → 不重跑總結', async () => {
  await dbModule2.query('DELETE FROM tasks');
  const runId = await newRun();
  await dbModule2.query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity)
     VALUES ($1,'__summary__','全域總結','上一輪就總結過了','low')`, [runId]);
  mockRunClaude.mockResolvedValue({
    text: '<result>{"diagnosis":"ok","severity":"low"}</result>', usage: null, durationMs: 5
  });
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows: sums } = await dbModule2.query(
    "SELECT diagnosis FROM health_check_findings WHERE run_id=$1 AND agent_name='__summary__'", [runId]);
  expect(sums.length).toBe(1);                      // 沒有被追加第二筆
  expect(sums[0].diagnosis).toBe('上一輪就總結過了');
});


// ── 兩階段分流（先用指標點名、再對被點名的關拉提示詞深診）─────────────────────────
// 意圖：原本 21 關各跑一次 opus、每關只看得到自己，跨關問題於是每關都正確判成「與本關無關」，
// 合起來沒有人負責。改成先跑一次全平台分流再深診：省錢是附帶效果，主因是要有一個能看到全局的視角。
const TRIAGE_MARK = '工作流程健檢分流員';
const triageText = (focus, sev = 'medium') =>
  `<diagnosis>全平台看起來有一類跨關問題</diagnosis><rationale>理由</rationale>` +
  `<result>{"focus":${JSON.stringify(focus)},"severity":"${sev}"}</result>`;
const deepText = '<diagnosis>深診結果</diagnosis><rationale>理由</rationale><result>{"severity":"high","has_prompt":false}</result>';

test('分流點名 → 只有被點名的關跑深診，其餘零 token 落 ok', async () => {
  buildAgentSummary.mockResolvedValue({ token: { calls: 5, cost_usd: 1 }, repeat_calls: { avg: 1 }, tasks: { stopped_rate: 0 }, rejections: null });
  mockRunClaude.mockImplementation(async (prompt) =>
    ({ text: prompt.includes(TRIAGE_MARK) ? triageText(['qa']) : deepText, usage: null, durationMs: 5 }));
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows } = await dbModule2.query(
    'SELECT agent_name, severity FROM health_check_findings WHERE run_id=$1 ORDER BY agent_name', [runId]);
  const byName = Object.fromEntries(rows.map(r => [r.agent_name, r.severity]));
  expect(byName['__triage__']).toBe('medium');
  expect(byName['qa']).toBe('high');                    // 被點名 → 深診結果
  expect(byName['coding-project']).toBe('ok');          // 未點名 → 零 token 落 ok，仍留一筆紀錄
  // 深診只跑被點名的那一關：分流 1 次 + qa 1 次 + 總結 1 次（coding-project 不該再呼叫）
  const deepCalls = mockRunClaude.mock.calls.filter(([p]) => !p.includes(TRIAGE_MARK)).length;
  expect(deepCalls).toBeLessThan(3);
});

// 意圖：分流是新加的單點依賴。它壞掉時若「什麼都不檢查」，健檢會安靜地變成空殼——頁面照樣
// 顯示跑完了。故必須退回舊行為（逐關全檢）：貴，但不會靜默漏掉整輪。
test('分流解析失敗 → 退回逐關全檢，不得靜默跳過', async () => {
  buildAgentSummary.mockResolvedValue({ token: { calls: 5 }, tasks: {}, rejections: null });
  mockRunClaude.mockImplementation(async (prompt) =>
    ({ text: prompt.includes(TRIAGE_MARK) ? '<diagnosis>壞掉</diagnosis><result>{"severity":"medium"}</result>' : deepText,
       usage: null, durationMs: 5 }));   // 分流缺 focus 欄位 → 視為失敗
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });

  const { rows } = await dbModule2.query(
    "SELECT agent_name, severity FROM health_check_findings WHERE run_id=$1 AND agent_name NOT IN ('__summary__','__system__','__triage__')", [runId]);
  expect(rows).toHaveLength(2);                          // 兩關都有被檢查
  expect(rows.every(r => r.severity === 'high')).toBe(true);   // 走的是深診那條路
});

// 意圖：分流若把全部都點名就等於沒篩，成本回到改版前。截斷是必要的，但**不能靜默**——
// 被丟掉的關要寫進 finding，否則報告看起來像「全部都檢查過了」。
test('focus 超過上限 → 截斷並把未深診的關寫進 finding', async () => {
  buildAgentSummary.mockResolvedValue({ token: { calls: 5 }, tasks: {}, rejections: null });
  mockRunClaude.mockImplementation(async (prompt) =>
    ({ text: prompt.includes(TRIAGE_MARK) ? triageText(['qa', 'coding-project']) : deepText, usage: null, durationMs: 5 }));
  const runId = await newRun();
  await runHealthCheck(runId, { windowDays: 30 });   // 上限已在 beforeAll 設為 1

  const { rows: [t] } = await dbModule2.query(
    "SELECT rationale FROM health_check_findings WHERE run_id=$1 AND agent_name='__triage__'", [runId]);
  expect(t.rationale).toContain('未深診');
  expect(t.rationale).toContain('coding-project');
});

// --- scope=task：單張任務的健檢（入口在任務詳情頁）---
// 意圖：與全平台健檢共用 runs／findings 表，但只跑一次呼叫、只落一筆 __task__ finding，
// 且**永遠不給 suggested_prompt**——單張任務的證據不得產生提示詞改動（判準的紅旗之一）。

async function newTaskRun(taskDbId) {
  const { rows: [r] } = await dbModule2.query(
    "INSERT INTO health_check_runs (status, task_db_id) VALUES ('running',$1) RETURNING id", [taskDbId]);
  return r.id;
}

test('runTaskHealthCheck：落一筆 __task__ finding（suggested_prompt 為 NULL）、run 設 done', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<diagnosis>處置：重跑 QA。</diagnosis><rationale>依 per_stage</rationale><result>{"severity":"medium"}</result>',
    usage: { input_tokens: 1 }, durationMs: 10
  });
  const runId = await newTaskRun(1);
  await runTaskHealthCheck(runId, { taskDbId: 1, startedBy: null });

  const { rows } = await dbModule2.query(
    'SELECT agent_name, agent_label, severity, diagnosis, suggested_prompt, rationale FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(rows).toHaveLength(1);                       // 不做分流／深診，就這一筆
  expect(rows[0].agent_name).toBe('__task__');
  expect(rows[0].agent_label).toBe('任務健檢');
  expect(rows[0].severity).toBe('medium');
  expect(rows[0].diagnosis).toContain('處置：重跑 QA');
  expect(rows[0].suggested_prompt).toBeNull();
  expect(rows[0].rationale).toBe('依 per_stage');
  expect(mockRunClaude).toHaveBeenCalledTimes(1);
  const { rows: [run] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('done');
});

// 意圖：判成平台程式 bug 時要落 kind='proposal'——那是「🔧 修這條」出得來的唯一條件（前端只渲染
// proposal，後端 fix 端點也擋掉其餘 kind）。原本一律落 'agent'，等於單張任務挖到的平台 bug 沒有任何
// 出口，只能寫成一段字給人自己去改；而判準明寫平台程式碼 bug 一律列入、走獨立出口。
// 「一張任務不算證據」限制的是提示詞（會影響全平台），不是決定性的程式缺陷——所以 suggested_prompt
// 在這條路上仍必須是 NULL，兩件事不可混為一談。
test('runTaskHealthCheck：layer=platform → 落 kind=proposal（「修這條」才出得來），但仍不給 suggested_prompt', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<diagnosis>處置：修平台程式。qa-agent.js 的 resume 沒比對規格。</diagnosis>'
        + '<rationale>與任務內容無關</rationale><result>{"severity":"high","layer":"platform"}</result>',
    usage: {}, durationMs: 5
  });
  const runId = await newTaskRun(1);
  await runTaskHealthCheck(runId, { taskDbId: 1, startedBy: null });
  const { rows: [f] } = await dbModule2.query(
    'SELECT kind, layer, severity, suggested_prompt FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(f.kind).toBe('proposal');
  expect(f.layer).toBe('platform');
  expect(f.severity).toBe('high');
  expect(f.suggested_prompt).toBeNull();
});

// 意圖：platform 是唯一被認的值。模型很容易順手填 'prompt'／'env'——那兩者在這一關都沒有出口
// （提示詞不得由單張任務改；環境問題不是改碼能解），放進 proposal 會生出一顆按鈕去派 agent 改碼。
test('runTaskHealthCheck：layer 填 platform 以外的值一律當沒填，維持 kind=agent', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<diagnosis>處置：補充資訊。</diagnosis><result>{"severity":"low","layer":"prompt"}</result>',
    usage: {}, durationMs: 5
  });
  const runId = await newTaskRun(1);
  await runTaskHealthCheck(runId, { taskDbId: 1, startedBy: null });
  const { rows: [f] } = await dbModule2.query(
    'SELECT kind, layer FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(f.kind).toBe('agent');
  expect(f.layer).toBeNull();
});

test('runTaskHealthCheck：模型就算給了 <prompt> 也不落進 suggested_prompt', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<prompt>改壞的提示詞</prompt><diagnosis>處置：無需處置。</diagnosis><result>{"severity":"ok"}</result>',
    usage: {}, durationMs: 5
  });
  const runId = await newTaskRun(1);
  await runTaskHealthCheck(runId, { taskDbId: 1, startedBy: null });
  const { rows: [f] } = await dbModule2.query('SELECT severity, suggested_prompt FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(f.severity).toBe('ok');
  expect(f.suggested_prompt).toBeNull();              // 前端的「帶入編輯器」按鈕因此不會出現
});

test('runTaskHealthCheck：任務不存在→落 error finding 並把 run 標 error（不可留在 running）', async () => {
  buildTaskSummary.mockResolvedValueOnce(null);
  const runId = await newTaskRun(9999);
  await runTaskHealthCheck(runId, { taskDbId: 9999, startedBy: null });
  const { rows: [f] } = await dbModule2.query('SELECT severity, diagnosis FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(f.severity).toBe('error');
  expect(f.diagnosis).toContain('找不到任務');
  const { rows: [run] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('error');                   // 停在 running 在畫面上與「還在跑」無從分辨
  expect(mockRunClaude).not.toHaveBeenCalled();       // 連呼叫都不該發生
});

test('runTaskHealthCheck：解析不出有效診斷→落 error finding，不靜默略過', async () => {
  mockRunClaude.mockResolvedValue({ text: '模型講了一堆但沒有任何標籤', usage: {}, durationMs: 5 });
  const runId = await newTaskRun(1);
  await runTaskHealthCheck(runId, { taskDbId: 1, startedBy: null });
  const { rows: [f] } = await dbModule2.query('SELECT severity, diagnosis FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(f.severity).toBe('error');
  expect(f.diagnosis).toContain('健檢失敗');
});

test('resumeInterruptedRuns：scope=task 的中斷 run 續跑成任務健檢，不會變成全平台健檢', async () => {
  // 這是「拿 task run 去跑 runHealthCheck」的護欄：錯了不會報錯，只會在同一個 run 底下混進
  // 各關的 findings，畫面上再也分不出這是哪一張任務的診斷——零訊號的靜默失敗。
  await dbModule2.query("UPDATE health_check_runs SET status='done' WHERE status='running'");
  mockRunClaude.mockResolvedValue({
    text: '<diagnosis>處置：補充資訊。</diagnosis><result>{"severity":"low"}</result>', usage: {}, durationMs: 5
  });
  const runId = await newTaskRun(1);
  expect(await resumeInterruptedRuns()).toBe(1);
  for (let i = 0; i < 40; i++) {                       // fire-and-forget，等它自己收尾
    const { rows: [r] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [runId]);
    if (r.status !== 'running') break;
    await new Promise(r2 => setTimeout(r2, 25));
  }
  const { rows } = await dbModule2.query('SELECT agent_name FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(rows.map(r => r.agent_name)).toEqual(['__task__']);   // 沒有 coding-project／qa／__summary__
});

// --- 主導型健檢（runAudit）：產出是「系統優化提案」而不是逐關診斷 ---
// 意圖：舊做法逐關切片，答得出「每關健不健康」卻答不出「系統下一步該優化什麼」——跨關的問題
// 每一關都會正確判成「與本關無關」。這裡釘住新格式的三件事：提案要能追蹤成效（指標＋現值必填）、
// 沒有新資料就不准燒錢、上一輪的裁決要餵回去（跨輪記憶）。

async function newAuditRun() {
  const { rows: [r] } = await dbModule2.query(
    "INSERT INTO health_check_runs (status, since_at) VALUES ('running', NOW() - INTERVAL '1 day') RETURNING id");
  return r.id;
}

const AUDIT_OK = {
  text: '<summary>本輪看到 QA 與實作之間反覆震盪。</summary><result>' +
    JSON.stringify({
      severity: 'medium',
      proposals: [
        { kind: 'proposal', title: '退回顆粒度不足', layer: 'platform', detail: '退回沒有欄位可判斷是否精準',
          evidence: '3 張不同任務：#101 #102 #103', action: '加一個退回原因欄位',
          target_metric: 'qa_rejections.impl_miss', metric_baseline: '15' },
        { kind: 'signal', title: '疑似分診誤判', layer: 'prompt', detail: '只有一張任務',
          evidence: '#101', action: '再觀察', target_metric: 'repeat_calls.avg', metric_baseline: '2.1' }
      ]
    }) + '</result>',
  usage: { input_tokens: 1 }, durationMs: 10
};

test('runAudit：落「總結」與「提案」兩種列，提案帶根因層／證據／指標，狀態預設待處理', async () => {
  mockRunClaude.mockResolvedValue(AUDIT_OK);
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(Date.now() - 86400000), startedBy: null });

  const { rows } = await dbModule2.query(
    'SELECT kind, agent_label, layer, evidence, target_metric, metric_baseline, status FROM health_check_findings WHERE run_id=$1 ORDER BY id',
    [runId]);
  expect(rows.map(r => r.kind)).toEqual(['summary', 'proposal', 'signal']);
  const proposal = rows[1];
  expect(proposal.agent_label).toBe('退回顆粒度不足');
  expect(proposal.layer).toBe('platform');
  expect(proposal.evidence).toContain('3 張不同任務');
  expect(proposal.target_metric).toBe('qa_rejections.impl_miss');
  expect(proposal.metric_baseline).toBe('15');
  expect(proposal.status).toBe('pending');
  // 候選訊號與提案分開存：證據不夠的不該長得像可以動手的
  expect(rows[2].kind).toBe('signal');
  const { rows: [run] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('done');
  expect(mockRunClaude).toHaveBeenCalledTimes(1);          // 一輪一次呼叫，不再逐關各跑一次
});

test('runAudit：說不出「動哪個指標、現值多少」的提案一律丟棄', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<summary>x</summary><result>' + JSON.stringify({
      severity: 'low',
      proposals: [
        { kind: 'proposal', title: '有指標的', layer: 'prompt', detail: 'd', target_metric: 'm', metric_baseline: '1' },
        { kind: 'proposal', title: '沒指標的', layer: 'prompt', detail: 'd' }
      ]
    }) + '</result>', usage: {}, durationMs: 5
  });
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(), startedBy: null });
  const { rows } = await dbModule2.query(
    "SELECT agent_label FROM health_check_findings WHERE run_id=$1 AND kind='proposal'", [runId]);
  expect(rows.map(r => r.agent_label)).toEqual(['有指標的']);   // 沒有驗收條件的提案不成立
});

// signal 的定義就是「證據還不夠、存著等下一輪累積」，判準又叫 agent 把講不出指標的一律降級成
// signal——指標門檻若連 signal 一起套，降級完照樣被丟掉，那個收納桶等於不存在（判準在說謊），
// 而「講不出指標的真 bug」會就這樣人間蒸發。
test('runAudit：候選訊號免附指標照樣入庫；提案缺指標仍然丟掉', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<summary>x</summary><result>' + JSON.stringify({
      severity: 'low',
      proposals: [
        { kind: 'signal', title: '沒指標的訊號', layer: 'platform', detail: '只有一張任務，先存著' },
        { kind: 'proposal', title: '沒指標的提案', layer: 'prompt', detail: 'd' }
      ]
    }) + '</result>', usage: {}, durationMs: 5
  });
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(), startedBy: null });
  const { rows } = await dbModule2.query(
    "SELECT kind, agent_label FROM health_check_findings WHERE run_id=$1 AND kind IN ('proposal','signal')", [runId]);
  expect(rows.map(r => r.agent_label)).toEqual(['沒指標的訊號']);
  expect(rows[0].kind).toBe('signal');
});

// 沒有標題就連「這是在講什麼」都不知道，signal 也一樣不收——免的是指標，不是全部門檻。
test('runAudit：連標題都沒有的候選訊號仍然丟掉', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<summary>x</summary><result>' + JSON.stringify({
      severity: 'low', proposals: [{ kind: 'signal', layer: 'platform', detail: '沒有標題' }]
    }) + '</result>', usage: {}, durationMs: 5
  });
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(), startedBy: null });
  const { rows } = await dbModule2.query(
    "SELECT id FROM health_check_findings WHERE run_id=$1 AND kind='signal'", [runId]);
  expect(rows).toHaveLength(0);
});

// 提案改成預設核准、當晚自動實作之後沒有人會先看過，「做錯了會壞掉什麼」就是下游 fix-review
// 唯一的審查基準。產得出來卻存不下去的話，等於每輪多燒一段 opus output 然後丟掉。
test('runAudit：提案的「做錯了會壞掉什麼」要落地，不能產完就丟', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<summary>x</summary><result>' + JSON.stringify({
      severity: 'medium',
      proposals: [{
        kind: 'proposal', title: '有風險說明的', layer: 'platform', detail: 'd',
        target_metric: 'm', metric_baseline: '1', risk_if_wrong: '改錯會讓 QA 全部誤判通過'
      }]
    }) + '</result>', usage: {}, durationMs: 5
  });
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(), startedBy: null });
  const { rows: [f] } = await dbModule2.query(
    "SELECT risk_if_wrong FROM health_check_findings WHERE run_id=$1 AND kind='proposal'", [runId]);
  expect(f.risk_if_wrong).toBe('改錯會讓 QA 全部誤判通過');
});

test('runAudit：視窗內沒有新資料 → 不呼叫模型，照實記一筆', async () => {
  buildWindowSummary.mockResolvedValueOnce({
    window: { since: '2026-08-20T00:00:00.000Z', until: '2026-08-21T00:00:00.000Z' },
    volume: { agent_calls: 0, tasks_touched: 0, cost_usd: 0, wall_clock: {} },
    per_stage: {}, tasks: [], rejections: []
  });
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(), startedBy: null });
  expect(mockRunClaude).not.toHaveBeenCalled();            // 沒資料還叫模型＝逼它硬生問題出來
  const { rows: [f] } = await dbModule2.query('SELECT kind, severity, diagnosis FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(f.kind).toBe('note');
  expect(f.severity).toBe('ok');
  expect(f.diagnosis).toContain('沒有任何 agent 呼叫');
  const { rows: [run] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('done');
});

test('runAudit：解析不出結果 → 落 error 並把 run 標 error（不可靜默收尾成 done）', async () => {
  mockRunClaude.mockResolvedValue({ text: '模型講了一堆但沒有 result', usage: {}, durationMs: 5 });
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(), startedBy: null });
  const { rows: [f] } = await dbModule2.query('SELECT kind, severity FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(f.severity).toBe('error');
  const { rows: [run] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('error');
});

// 整輪共用一個 severity 時，五條提案一律同色同待辦，「哪幾條可以放著不管」就分不出來——而那正是
// 處理狀態要回答的問題。
test('runAudit：每條提案帶自己的嚴重度；沒帶的才退回整輪的值', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<summary>x</summary><result>' + JSON.stringify({
      severity: 'high',
      proposals: [
        { kind: 'proposal', title: '這條輕微', severity: 'low', layer: 'prompt', detail: 'd', target_metric: 'm1', metric_baseline: '1' },
        { kind: 'proposal', title: '這條沒帶', layer: 'prompt', detail: 'd', target_metric: 'm2', metric_baseline: '2' },
        { kind: 'proposal', title: '這條亂填', severity: '很嚴重', layer: 'prompt', detail: 'd', target_metric: 'm3', metric_baseline: '3' }
      ]
    }) + '</result>', usage: {}, durationMs: 5
  });
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(Date.now() - 86400000), startedBy: null });
  const { rows } = await dbModule2.query(
    "SELECT agent_label, severity FROM health_check_findings WHERE run_id=$1 AND kind='proposal' ORDER BY id", [runId]);
  // 整輪是 high，這條仍該是 low——否則「輕微的可不處理」的粒度只到整輪
  expect(rows).toEqual([
    { agent_label: '這條輕微', severity: 'low' },
    { agent_label: '這條沒帶', severity: 'high' },
    { agent_label: '這條亂填', severity: 'high' }   // 對不上列舉值不能整條丟掉，退回整輪的值
  ]);
});

// 趨勢比對是月健檢唯一與週／日不同的地方。少了它畫面上完全看不出來：一樣跑完、一樣落提案，
// 只是 agent 手上沒有上一期可比，「上次說要降的數字降了沒」永遠答不出來。
test('runAudit：monthly 才另算上一期並餵進 prompt；daily 明講不做趨勢比對', async () => {
  mockRunClaude.mockResolvedValue(AUDIT_OK);
  const sinceAt = new Date(Date.now() - 30 * 86400000);

  buildWindowSummary.mockClear();
  await runAudit(await newAuditRun(), { sinceAt, cadence: 'monthly', startedBy: null });
  expect(buildWindowSummary).toHaveBeenCalledTimes(2);
  // 第二次是「上一期」：同長度、以本期起點為上界，兩期才不會重疊
  const [prevStart, prevUntil] = buildWindowSummary.mock.calls[1];
  expect(prevUntil.getTime()).toBe(sinceAt.getTime());
  expect(sinceAt.getTime() - prevStart.getTime()).toBeGreaterThan(29 * 86400000);
  expect(mockRunClaude.mock.calls.at(-1)[0]).not.toContain('本輪不做趨勢比對');

  buildWindowSummary.mockClear();
  await runAudit(await newAuditRun(), { sinceAt, cadence: 'daily', startedBy: null });
  expect(buildWindowSummary).toHaveBeenCalledTimes(1);       // 日健檢不該為了比對多跑一次聚合
  expect(mockRunClaude.mock.calls.at(-1)[0]).toContain('本輪不做趨勢比對');
});

test('runAudit：上一輪的提案與裁決會餵回下一輪（跨輪記憶，視窗縮短後的關鍵配套）', async () => {
  // 先造一筆「已裁決為不須調整」的舊提案
  const prevRun = await newAuditRun();
  await dbModule2.query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, kind, layer,
                                        status, verdict_note, target_metric, metric_baseline)
     VALUES ($1,'__audit__','舊提案','舊提案：某某問題','low','proposal','prompt','no_change','證據只有一張任務','repeat_calls.avg','2.1')`,
    [prevRun]);

  mockRunClaude.mockResolvedValue(AUDIT_OK);
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(Date.now() - 86400000), startedBy: null });

  const prompt = mockRunClaude.mock.calls.at(-1)[0];
  expect(prompt).toContain('舊提案：某某問題');
  expect(prompt).toContain('不須調整');
  expect(prompt).toContain('證據只有一張任務');           // 沒有這句，下一輪會把同一件事再提一次
  expect(prompt).toContain('repeat_calls.avg');           // 指標要帶回去才驗得到成效
});
