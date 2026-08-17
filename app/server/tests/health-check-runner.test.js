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
  buildAgentSummary: jest.fn().mockResolvedValue({ token: {}, tasks: {}, rejections: null })
}));

const { buildAgentSummary } = require('../pipeline/health-data');   // 零樣本測試要逐次覆寫

let dbModule2, runHealthCheck, hcUserId;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule2 = require('../db');
  dbModule2._setPoolForTesting(new Pool());
  await dbModule2.migrate();
  const { rows: [u] } = await dbModule2.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hc','h','HC') RETURNING id");
  hcUserId = u.id;   // tasks.user_id 是 NOT NULL，跨關卡彙整的 fixture 要用
  ({ runHealthCheck } = require('../pipeline/health-check-runner'));
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
  buildAgentSummary
    .mockResolvedValueOnce({ token: { calls: 0 }, tasks: {}, rejections: null })
    .mockResolvedValueOnce({ token: { calls: 0 }, tasks: {}, rejections: null });
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
  buildAgentSummary
    .mockResolvedValueOnce({ token: { calls: 12 }, tasks: {}, rejections: null })
    .mockResolvedValueOnce({ token: { calls: 12 }, tasks: {}, rejections: null });
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
