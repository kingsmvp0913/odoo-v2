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

let dbModule2, runTaskHealthCheck, runAudit, resumeInterruptedRuns, hcUserId;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule2 = require('../db');
  dbModule2._setPoolForTesting(new Pool());
  await dbModule2.migrate();
  const { rows: [u] } = await dbModule2.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hc','h','HC') RETURNING id");
  hcUserId = u.id;   // tasks.user_id 是 NOT NULL，建 fixture 任務時要用
  ({ runTaskHealthCheck, runAudit, resumeInterruptedRuns } = require('../pipeline/health-check-runner'));
});
afterAll(() => dbModule2._setPoolForTesting(null));
beforeEach(() => mockRunClaude.mockReset());

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

// Phase 7.1：提案通道守門已補齊（DENY 四支＋基線比較＋fix-review），提案改成預設核准，
// 當晚自動實作；候選訊號（kind=signal）證據不夠、本來就不進修正通道，不受這次改動影響。
test('runAudit：落「總結」與「提案」兩種列，提案帶根因層／證據／指標，狀態預設核准', async () => {
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
  expect(proposal.status).toBe('approved');
  // 候選訊號與提案分開存：證據不夠的不該長得像可以動手的，status 不能被欄位 DEFAULT
  // （已改成 approved）連坐——summary／signal 都不是「可核准」的條目。
  expect(rows[0].status).toBe('pending');   // summary
  expect(rows[2].kind).toBe('signal');
  expect(rows[2].status).toBe('pending');   // signal
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

// N9：previousProposals 組 prompt 時，機器退場的 note 不能冠「你的裁決」送回去——那會讓
// auditor 誤以為是人在跟它對話。R1(b) 把 MACHINE_RETIRE_PREFIX 抽到 retire-prefix.js 這個
// 葉節點模組之後，這條風險理論上不會再因為 nightly-fix.js／health-check-runner.js 的 require
// 順序而靜默退化（見 retire-prefix.js 檔頭註解）——但這支測試本身**擋不住循環**：這裡跟本檔案
// 其他測試共用同一個 module registry，多半剛好落在「先 require health-check-runner」那個
// 不會觸發問題的順序，真正擋循環的是 R1(b) 的葉節點抽離，不是這支測試。這支測試唯一保證的是
// 「prompt 字串本身組對了」——一旦哪天真的循環又形成、MACHINE_RETIRE_PREFIX 變回 undefined，
// 這支測試才有機會在自己的 module registry 剛好踩到壞順序時紅一次。
test('runAudit：previousProposals 組 prompt 時，機器退場的 note 不冠「你的裁決」，人的裁決會', async () => {
  const prevRun = await newAuditRun();
  // 機器退場：帶 MACHINE_RETIRE_PREFIX 前綴，且 decided_at 為 NULL（跟前端 isMachineRetired 對齊）
  await dbModule2.query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, kind, layer,
                                        status, verdict_note, target_metric, metric_baseline)
     VALUES ($1,'__audit__','機器退場的提案','機器退場的提案：某某問題','medium','proposal','code',
             'pending','自動退場：自動修正連續失敗 3 次，已退回人工處理','fix_attempts.count','3')`,
    [prevRun]);
  // 人的裁決：即使 note 內容也帶同一段前綴文字（模擬管理員按「待處理」但沒清空預填文字），
  // decided_at 非 NULL 時仍要判成人的裁決——這是 F-3 對齊前端判準的核心。
  await dbModule2.query(
    `INSERT INTO health_check_findings (run_id, agent_name, agent_label, diagnosis, severity, kind, layer,
                                        status, verdict_note, decided_at, target_metric, metric_baseline)
     VALUES ($1,'__audit__','人裁決的提案','人裁決的提案：某某問題','medium','proposal','code',
             'pending','自動退場：這其實是我自己的裁決',NOW(),'fix_attempts.count','1')`,
    [prevRun]);

  mockRunClaude.mockResolvedValue(AUDIT_OK);
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(Date.now() - 86400000), startedBy: null });

  const prompt = mockRunClaude.mock.calls.at(-1)[0];
  // 機器退場那筆：不冠「你的裁決」，改標「夜間批次自動退場」
  expect(prompt).toContain('機器退場的提案：某某問題');
  expect(prompt).toContain('夜間批次自動退場：自動修正連續失敗 3 次，已退回人工處理');
  // 人裁決那筆：即使 note 帶同一段前綴文字，decided_at 非 NULL 時仍要冠「你的裁決」
  expect(prompt).toContain('人裁決的提案：某某問題');
  expect(prompt).toContain('你的裁決：自動退場：這其實是我自己的裁決');
});

// --- 2-C1：夜間批次列（cadence='nightly-fix'）不可被當成舊式逐關健檢重跑 ---
// 根因（已實跑驗證過）：批次插入 health_check_runs 只給 status／window_days／started_by，
// task_db_id 與 since_at 皆 NULL，resumeInterruptedRuns 的三分流 task_db_id ? … : since_at ? … : 舊行為
// 剛好落進最後那個 fallback（runHealthCheck），重啟後會在批次列底下冒出 21 關的全平台診斷。

async function newBatchRun() {
  const { rows: [r] } = await dbModule2.query(
    "INSERT INTO health_check_runs (status, window_days, cadence) VALUES ('running',0,'nightly-fix') RETURNING id");
  return r.id;
}

test('resumeInterruptedRuns：批次列（cadence=nightly-fix）不會被當成舊式逐關健檢續跑，直接收成 error', async () => {
  await dbModule2.query("UPDATE health_check_runs SET status='done' WHERE status='running'");
  const runId = await newBatchRun();

  expect(await resumeInterruptedRuns()).toBe(1);

  // 不能呼叫 runHealthCheck（會產生 21 關的 findings）；批次列底下不該冒出任何一筆 finding
  expect(mockRunClaude).not.toHaveBeenCalled();
  const { rows: findings } = await dbModule2.query(
    'SELECT agent_name FROM health_check_findings WHERE run_id=$1', [runId]);
  expect(findings).toHaveLength(0);
  const { rows: [run] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [runId]);
  expect(run.status).toBe('error');   // 批次無法續跑，不是「執行中」也不是被當成完成
});

test('resumeInterruptedRuns：批次列與其他中斷 run 混在一起時，只有批次列被收掉，其餘照常續跑', async () => {
  await dbModule2.query("UPDATE health_check_runs SET status='done' WHERE status='running'");
  const batchRunId = await newBatchRun();
  const taskRunId = await newTaskRun(1);
  mockRunClaude.mockResolvedValue({
    text: '<diagnosis>處置：補充資訊。</diagnosis><result>{"severity":"low"}</result>', usage: {}, durationMs: 5
  });

  expect(await resumeInterruptedRuns()).toBe(2);
  for (let i = 0; i < 40; i++) {
    const { rows: [r] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [taskRunId]);
    if (r.status !== 'running') break;
    await new Promise(r2 => setTimeout(r2, 25));
  }

  const { rows: [batch] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [batchRunId]);
  expect(batch.status).toBe('error');
  const { rows: [taskRun] } = await dbModule2.query('SELECT status FROM health_check_runs WHERE id=$1', [taskRunId]);
  expect(taskRun.status).toBe('done');   // 沒有被批次列的處理連坐影響
});

// --- 2-M1：批次列不可污染健檢排程的讀取點（auditWindowStart）---

test('auditWindowStart：批次自建的 run 不會被當成「上一輪全平台健檢完成時刻」', async () => {
  await dbModule2.query("UPDATE health_check_runs SET status='done' WHERE status='running'");
  // 真正的全平台健檢：3 天前完成
  const realFinishedAt = new Date(Date.now() - 3 * 86400000);
  await dbModule2.query(
    "INSERT INTO health_check_runs (status, since_at, cadence, finished_at) VALUES ('done', NOW() - INTERVAL '4 day', 'daily', $1)",
    [realFinishedAt]);
  // 夜間批次：剛剛才收尾（finished_at 遠比上面新），若沒排除會把視窗起點拉到現在附近
  await dbModule2.query(
    "INSERT INTO health_check_runs (status, window_days, cadence, finished_at) VALUES ('done', 0, 'nightly-fix', NOW())");

  const { auditWindowStart } = require('../pipeline/health-check-runner');
  const start = await auditWindowStart();

  // 起點要對到「真正的全平台健檢」那筆，不是批次列（誤用批次列會讓 start 落在幾秒鐘前）
  expect(Math.abs(start.getTime() - realFinishedAt.getTime())).toBeLessThan(2000);
});

// --- 2-I2：健檢提案要依 severity／layer 分岔，不符合自動修範圍的落 pending 而非 approved ---
// 規格 §255／§257：low／ok 與超出自動範圍（layer 不在 code／prompt／observability）的提案
// 留在管理頁給人決定。落 approved 卻永遠不會被 nightly-fix.js 的 fetchHealthCandidates 撈到，
// 是「已核准（將自動執行）」但實際永遠不執行的狀態說謊。

test('runAudit：severity=low 的提案落 pending，不是 approved（低嚴重度留給人決定）', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<summary>本輪無重大問題。</summary><result>' + JSON.stringify({
      severity: 'low',
      proposals: [
        { kind: 'proposal', title: '小優化', layer: 'code', severity: 'low', detail: '無關緊要的小事',
          evidence: '#1', action: '順手改一下',
          target_metric: 'x', metric_baseline: '1' }
      ]
    }) + '</result>',
    usage: { input_tokens: 1 }, durationMs: 10
  });
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(Date.now() - 86400000), startedBy: null });

  const { rows: [proposal] } = await dbModule2.query(
    "SELECT status FROM health_check_findings WHERE run_id=$1 AND kind='proposal'", [runId]);
  expect(proposal.status).toBe('pending');
});

test('runAudit：layer=env 的提案落 pending，不是 approved（自動修範圍不含 env）', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<summary>本輪看到環境層問題。</summary><result>' + JSON.stringify({
      severity: 'high',
      proposals: [
        { kind: 'proposal', title: '外部服務逾時', layer: 'env', severity: 'high', detail: '第三方 API 常常逾時',
          evidence: '#1 #2 #3', action: '找對方確認 SLA',
          target_metric: 'x', metric_baseline: '1' }
      ]
    }) + '</result>',
    usage: { input_tokens: 1 }, durationMs: 10
  });
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(Date.now() - 86400000), startedBy: null });

  const { rows: [proposal] } = await dbModule2.query(
    "SELECT status FROM health_check_findings WHERE run_id=$1 AND kind='proposal'", [runId]);
  expect(proposal.status).toBe('pending');
});

test('runAudit：medium 以上且 layer 在自動修範圍（含 platform 別名 code）的提案仍落 approved', async () => {
  mockRunClaude.mockResolvedValue(AUDIT_OK);   // layer='platform', severity 繼承整輪 'medium'
  const runId = await newAuditRun();
  await runAudit(runId, { sinceAt: new Date(Date.now() - 86400000), startedBy: null });

  const { rows: [proposal] } = await dbModule2.query(
    "SELECT status FROM health_check_findings WHERE run_id=$1 AND kind='proposal'", [runId]);
  expect(proposal.status).toBe('approved');
});

// --- 失敗原因要留得下來 ---
// 這一頁收斂成「只看提案」之後，健檢自己掛掉是**看不出來的**：它一筆提案都不會產生，畫面上跟
// 「今晚本來就沒事做」長得一模一樣（此 repo 踩過：夜班空轉 98 輪無人察覺）。實測 run#19
// （2026-09-03 23:00 的自動健檢）就是這樣靜靜掛掉、隔天查不出原因——當時只有 status='error'。

test('runAudit 解析不出結果 → error 欄要寫得出原因，不是只留一個 error 狀態', async () => {
  mockRunClaude.mockResolvedValue({ text: '完全不是格式', usage: { input_tokens: 1 }, durationMs: 10 });
  const runId = await newAuditRun();

  await runAudit(runId, { sinceAt: new Date(Date.now() - 86400000) });

  const { rows: [r] } = await dbModule2.query('SELECT status, error FROM health_check_runs WHERE id=$1', [runId]);
  expect(r.status).toBe('error');
  expect(r.error).toBeTruthy();                 // 正向錨：真的有寫東西進去
  expect(r.error).toContain('解析');            // 而且說得出是哪一類失敗
});

test('已退役的逐關診斷歷史列 → 收成 error 並寫明退役，不會靜默留在 running', async () => {
  // 兩者皆空＝runHealthCheck 的歷史列。它已無程式可續跑；留在 running 的話
  // getHealthCheckSchedule 會一直判「本輪執行中」而不再排程，健檢從此安靜停擺。
  const { rows: [r0] } = await dbModule2.query(
    "INSERT INTO health_check_runs (status, window_days) VALUES ('running',30) RETURNING id");

  await resumeInterruptedRuns();

  const { rows: [r] } = await dbModule2.query('SELECT status, error FROM health_check_runs WHERE id=$1', [r0.id]);
  expect(r.status).toBe('error');
  expect(r.error).toContain('退役');
  expect(mockRunClaude).not.toHaveBeenCalled();  // 不得因此燒掉任何一次模型呼叫
});

// --- 健檢提案同時在「意見回饋管理」開一筆 ---
// 那一頁是唯一的待辦收斂處：使用者提的意見與健檢挖出來的問題最後都要有人決定做不做，
// 分兩個畫面管等於要記得兩個地方都要看。

test('中等以上的提案 → 意見回饋管理開一筆，預設已核准、提交者留空代表 AI 健檢', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<result>' + JSON.stringify({ severity: 'medium', proposals: [
      { title: '某個要修的東西', detail: '細節', layer: 'code', action: '這樣改',
        target_metric: 'm', metric_baseline: 'b', risk_if_wrong: '會壞掉這個' }
    ] }) + '</result>',
    usage: { input_tokens: 1 }, durationMs: 10
  });
  const runId = await newAuditRun();

  await runAudit(runId, { sinceAt: new Date(Date.now() - 86400000) });

  const { rows: [fb] } = await dbModule2.query(
    "SELECT user_id, status, triage_title, triage_layer, finding_id FROM feedback ORDER BY id DESC LIMIT 1");
  expect(fb.status).toBe('approved');       // 預設就是核准，不必再按一次
  expect(fb.user_id).toBeNull();            // 提交者＝AI 健檢
  expect(fb.triage_title).toBe('某個要修的東西');
  expect(fb.triage_layer).toBe('code');     // 健檢的產出直接當翻譯結果，不再燒一次 triage
  expect(fb.finding_id).toBeTruthy();       // 連得回來源提案
});

test('低嚴重度的提案不開單：那是「放著也不會怎樣」，開單等於逼人處理', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<result>' + JSON.stringify({ severity: 'low', proposals: [
      { title: '無關痛癢', detail: 'd', layer: 'code', action: 'a',
        target_metric: 'm', metric_baseline: 'b' }
    ] }) + '</result>',
    usage: { input_tokens: 1 }, durationMs: 10
  });
  const before = await dbModule2.query('SELECT COUNT(*)::int AS n FROM feedback');
  const runId = await newAuditRun();

  await runAudit(runId, { sinceAt: new Date(Date.now() - 86400000) });

  const after = await dbModule2.query('SELECT COUNT(*)::int AS n FROM feedback');
  expect(after.rows[0].n).toBe(before.rows[0].n);
  // 正向錨：提案本身有落地，只是沒開單——不然這支測的可能是「整輪都沒跑」
  const { rows: [p] } = await dbModule2.query(
    "SELECT status FROM health_check_findings WHERE run_id=$1 AND kind='proposal'", [runId]);
  expect(p.status).toBe('pending');
});
