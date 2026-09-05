// 把用量狀態的落檔導去暫存區，避免測試污染 repo 的 data/。必須在任何 require 之前設定：
// lib/claude-usage 在載入當下就把路徑算好了。
process.env.CLAUDE_RATE_LIMIT_CACHE = require('path').join(require('os').tmpdir(), 'test-claude-rate-limit.json');

const { newDb } = require('pg-mem');

jest.mock('child_process', () => ({ spawn: jest.fn() }));

let dbModule, logTokenUsage;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ logTokenUsage } = require('../pipeline/token-logger'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('logTokenUsage inserts a server record', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('x', 4);
  const { rows: [u] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ('tlu1', $1, 'TL') RETURNING id`, [hash]
  );
  await logTokenUsage(
    { taskId: 'task_odoo_1' }, u.id, 'cs',
    { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    1234
  );
  const { rows } = await dbModule.query("SELECT * FROM token_usage WHERE task_id='task_odoo_1'");
  expect(rows.length).toBe(1);
  expect(rows[0].agent_type).toBe('cs');
  expect(rows[0].input_tokens).toBe(100);
  expect(rows[0].output_tokens).toBe(50);
  expect(rows[0].duration_ms).toBe(1234);
  expect(rows[0].source).toBe('server');
});

test('logTokenUsage silently skips when usage is null', async () => {
  await expect(logTokenUsage({ taskId: 'x' }, null, 'cs', null, null)).resolves.toBeUndefined();
});

// 成本歸屬：runClaude 把 resolved model 折進 usage.model，logTokenUsage 須落 model 欄
test('logTokenUsage 落 usage.model 到 model 欄（供 USD 成本按 model 單價計）', async () => {
  await logTokenUsage(
    { taskId: 'task_model_1' }, null, 'chat',
    { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5' },
    100
  );
  const { rows } = await dbModule.query("SELECT model FROM token_usage WHERE task_id='task_model_1'");
  expect(rows.length).toBe(1);
  expect(rows[0].model).toBe('claude-sonnet-5');
});

// 意圖：手動暫停（abort）不是 Agent 失敗；失敗原因須顯示「手動暫停」而非「XXX 執行失敗：aborted」，
// 讓使用者看得懂那是自己按的暫停，不是程式壞掉。
test('stopReason：手動暫停顯示「手動暫停」，真正失敗才帶階段前綴', () => {
  const { abortError, stopReason } = require('../pipeline/claude-runner');
  expect(abortError().aborted).toBe(true);
  expect(stopReason('實作 Agent 執行失敗', abortError())).toBe('手動暫停');
  expect(stopReason('QA Agent 執行失敗', new Error('boom'))).toBe('QA Agent 執行失敗：boom');
});

// 意圖：逾時被砍的那一輪，已經把整包 code 讀進 session 了。err 不帶 sessionId 出來，呼叫端就無從
// --resume 續跑，只能從零重讀、然後再逾時一次（task 180 的分析關 600s 探索全數作廢就是這樣來的）。
// session_id 在第一則 init 事件就到手，失敗當下必定已有值——這條驗它真的被帶出去。
test('runClaude 逾時 → err 帶出 sessionId（供呼叫端 --resume 續跑，不必從零重讀）', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.pid = 4243;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: () => {},
    // init 事件先到（真實 CLI 的第一則就是它），然後什麼都不做——讓 timeoutMs 到期砍掉這一輪
    end: () => setImmediate(() => child.stdout.emit('data',
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-TIMEDOUT' }) + '\n')),
    on: () => {}
  };
  child.kill = jest.fn(() => { setImmediate(() => child.emit('close', 143)); });
  child.unref = () => {};
  spawn.mockReturnValue(child);

  const { runClaude } = require('../pipeline/claude-runner');
  const err = await runClaude('p', { timeoutMs: 30 }).then(() => null, e => e);
  expect(err).toBeTruthy();
  expect(err.claudeStatus).toBe('timeout');
  expect(err.sessionId).toBe('sess-TIMEDOUT');
});

// 健檢 U9：runClaude 逾時——CLI 掛死＝任務永久卡在 *_running、
// merge 鎖鏈永不釋放，只能重啟 server。逾時必須主動 kill 並 reject。
// Windows 上 signal 殺不到子孫（claude Bash 出去的 find.exe 會變孤兒），故改走 taskkill /T 連根收；
// 其餘平台維持 child.kill('SIGTERM')。兩條路都算「有殺子行程」，依平台驗對應手段。
test('runClaude 逾時 → kill 子行程樹並以逾時錯誤 reject', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.pid = 4242; // taskkill 走 pid，沒 pid 會被視為無對象跳過
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = jest.fn(() => { setImmediate(() => child.emit('close', 143)); });
  child.unref = () => {};
  spawn.mockReturnValue(child);
  // 上一條逾時測試（pid 4243）也會打一次 taskkill，而 spawn 的呼叫紀錄是跨測試累積的。
  // 不清掉的話下面的 find 會撈到那一次，斷言就變成在驗別人的 pid。
  spawn.mockClear();

  const { runClaude } = require('../pipeline/claude-runner');
  await expect(runClaude('p', { timeoutMs: 30 })).rejects.toThrow(/逾時/);
  if (process.platform === 'win32') {
    const tk = spawn.mock.calls.find(c => c[0] === 'taskkill');
    expect(tk).toBeTruthy();
    expect(tk[1]).toEqual(expect.arrayContaining(['/pid', String(child.pid), '/T', '/F']));
  } else {
    expect(child.kill).toHaveBeenCalled();
  }
});

// 逾時上限的落差本身就是失敗來源：analysis／qa／merge／cs 都沒帶 timeoutMs，共用預設一低，
// 「要讀完既有模組才產得出東西」的關卡就會在讀碼階段被砍、整輪報廢（task 180 的分析關即此）。
// 這裡鎖的是「沒帶 timeoutMs 時拿到的是放寬後的共用上限」，不是某個實作細節。
test('runClaude 未指定 timeoutMs → 用 2400s 共用上限（不是舊的 600s）', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => setImmediate(() => child.emit('close', 0)), on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValueOnce(child);

  const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
  try {
    const { runClaude } = require('../pipeline/claude-runner');
    await runClaude('p', {});
    const delays = setTimeoutSpy.mock.calls.map(c => c[1]);
    expect(delays).toContain(2400000);
  } finally {
    setTimeoutSpy.mockRestore();
  }
});

// Prompt 稽核：runClaude 送出前把完整 prompt 落 prompt_logs（含 agent_type/model/task_id/字數），
// 供管理員頁確認「實際送出了什麼」。落地為 best-effort（fire-and-forget），故輪詢等待。
test('runClaude：送出前把完整 prompt 落 prompt_logs', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => setImmediate(() => child.emit('close', 0)), on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValueOnce(child);

  const { runClaude } = require('../pipeline/claude-runner');
  const PROMPT = '這是一段測試 prompt 內容 hello';
  await runClaude(PROMPT, { agentType: 'coding', model: 'opus', taskId: 42 });

  let row;
  for (let i = 0; i < 20 && !row; i++) {
    const { rows } = await dbModule.query("SELECT * FROM prompt_logs WHERE agent_type='coding'");
    row = rows[0];
  }
  expect(row).toBeTruthy();
  expect(row.prompt).toBe(PROMPT);
  expect(row.model).toBe('opus');
  expect(row.task_id).toBe('42');
  expect(row.char_len).toBe(PROMPT.length);
});

// B-1（主題 B）：init 事件抓 session_id 回傳、給 resumeSessionId 才帶 --resume。
// 原在 task-agent.test.js 測 spawnClaude，合併後 runClaude 承接（健檢 U13）。
test('runClaude：從 init 事件抓到 session_id 並回傳', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValue(child);

  const { runClaude } = require('../pipeline/claude-runner');
  const p = runClaude('p', {});
  child.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc' }) + '\n');
  child.stdout.emit('data', JSON.stringify({ type: 'result', result: 'done', usage: null, duration_ms: 5 }) + '\n');
  child.emit('close', 0);
  const r = await p;
  expect(r.sessionId).toBe('sess-abc');
});

// 用量顯示的救命索：usage endpoint 被 429 擋住時，串流裡的 rate_limit_event 是唯一還會更新、
// 且量的正是「跑任務這把憑證」的來源。漏接它 = 限流期間完全沒有任何新鮮的用量訊號。
test('runClaude：攔下 rate_limit_event 並記進用量狀態', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValue(child);

  const usage = require('../lib/claude-usage');
  usage._resetCacheForTesting();
  const { runClaude } = require('../pipeline/claude-runner');
  const p = runClaude('p', {});
  child.stdout.emit('data', JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', resetsAt: 1787809200, rateLimitType: 'five_hour' }
  }) + '\n');
  child.stdout.emit('data', JSON.stringify({ type: 'result', result: 'done', usage: null, duration_ms: 5 }) + '\n');
  child.emit('close', 0);
  await p;
  expect(usage.getRateLimitState()).toMatchObject({
    status: 'allowed', rate_limit_type: 'five_hour', resets_at: '2026-08-27T05:40:00.000Z'
  });
});

// result-contract 關卡的救命索：assistantText 累積「整段」assistant 文字，即使 <result> 出現在中間輪、
// 末輪 ev.result 只剩收尾散文，assistantText 仍保有完整 transcript 供 extractResult 撈回契約（task#79 回歸）。
test('runClaude：assistantText 累積全部 assistant 文字（非只末輪 ev.result）', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValue(child);

  const { runClaude } = require('../pipeline/claude-runner');
  const p = runClaude('p', {});
  // 中間輪吐出 <result>，末輪只剩收尾散文
  child.stdout.emit('data', JSON.stringify({ type: 'assistant', message: { model: 'x', content: [{ type: 'text', text: '<result>{"ok":1}</result>' }] } }) + '\n');
  child.stdout.emit('data', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '收尾散文' }] } }) + '\n');
  child.stdout.emit('data', JSON.stringify({ type: 'result', result: '收尾散文', usage: null, duration_ms: 3 }) + '\n');
  child.emit('close', 0);
  const r = await p;
  expect(r.text).toBe('收尾散文');                       // 末輪 ev.result 已丟契約
  expect(r.assistantText).toContain('<result>{"ok":1}</result>');  // 但 transcript 撈得回
});

test('runClaude：給 resumeSessionId → args 含 --resume；不給 → 不含', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const mk = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => setImmediate(() => child.emit('close', 0)), on: () => {} };
    child.kill = jest.fn();
    return child;
  };
  const { runClaude } = require('../pipeline/claude-runner');

  spawn.mockReturnValueOnce(mk());
  await runClaude('p', { resumeSessionId: 'sess-xyz' });
  expect(spawn.mock.calls[spawn.mock.calls.length - 1][1]).toEqual(expect.arrayContaining(['--resume', 'sess-xyz']));

  spawn.mockReturnValueOnce(mk());
  await runClaude('p', {});
  expect(spawn.mock.calls[spawn.mock.calls.length - 1][1]).not.toContain('--resume');
});

// 意圖：釘住「不採用 --exclude-dynamic-system-prompt-sections」這個決定（2026-08-17 實測後裁決）。
// 該旗標把 cwd／git status 移出 system prompt 換取跨任務快取命中，實測有效但只值約 1.2% 成本；
// 代價是那些資訊被降格到 user message，而 user message 會被 auto-compact 壓縮、system prompt 不會。
// 依 rules/always.md 第 10 條「穩定 > 準確 > 省 token」不採用。
// 這支測試存在的理由：下一個做成本優化的人會再次翻到這個旗標（它看起來就是白撿的），
// 紅燈會把他導向 claude-runner.js 裡那段寫明實測數字與裁決理由的註解，而不是重跑一次相同的實驗。
test('runClaude：不帶 --exclude-dynamic-system-prompt-sections（實測僅省 1.2%，不值準確率風險）', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => setImmediate(() => child.emit('close', 0)), on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValueOnce(child);

  const { runClaude } = require('../pipeline/claude-runner');
  await runClaude('p', {});
  const args = spawn.mock.calls[spawn.mock.calls.length - 1][1];
  expect(args).not.toContain('--exclude-dynamic-system-prompt-sections');
});

// 暫停時序缺口：signal 在 runClaude 被呼叫「之前」就已 abort（使用者在前置 DB 查詢／
// 同關前一次 runClaude 期間按暫停）——addEventListener 對已 abort 的 signal 不會觸發，
// 不前置檢查的話整段 claude 會照跑白燒 token。
test('runClaude：signal 已 abort → 不 spawn、直接以手動暫停 reject', async () => {
  const { spawn } = require('child_process');
  spawn.mockClear();
  const { runClaude } = require('../pipeline/claude-runner');
  const ctrl = new AbortController();
  ctrl.abort();
  await expect(runClaude('p', { signal: ctrl.signal })).rejects.toMatchObject({ aborted: true });
  expect(spawn).not.toHaveBeenCalled();
});

// exit code null＝被外部 signal 終止（OOM killer／伺服器重開）：不能拿空結果當成功回傳，
// 否則下游拿到空輸出會誤歸因成「agent 沒回有效結果」。且須標 claudeStatus='interrupted'（非 error），
// 用量報表才把它排除在失敗數之外（見 token-report-routes.js by_agent）。
test('runClaude：exit code null（外部 kill）→ reject 且 claudeStatus=interrupted', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValueOnce(child);
  const { runClaude } = require('../pipeline/claude-runner');
  const p = runClaude('p', {});
  child.emit('close', null, 'SIGKILL');
  await expect(p).rejects.toMatchObject({ message: expect.stringMatching(/外部終止/), claudeStatus: 'interrupted' });
});

// CLI 自己判定失敗時（額度用盡、模型不可用），真因在 stdout 那則 result 事件的 subtype／result，
// stderr 是空的。不撿起來的話錯誤只剩「exited with code 1」——2026-09-04 feedback_triage 連 5 次
// 全掛（每次 1.5 秒），真因到現在都查不出來，因為那幾行當場就沒了（該關 taskId=null，連
// task_events 都不落地）。這一支釘住「stderr 空時改用 result 事件的錯誤字面」。
test('runClaude：exit 非 0 且 stderr 空 → 用 stdout result 事件的錯誤內容當訊息', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValueOnce(child);
  const { runClaude } = require('../pipeline/claude-runner');
  const p = runClaude('p', {});
  child.stdout.emit('data', JSON.stringify({
    type: 'result', subtype: 'error_max_turns', is_error: true, result: '額度已用盡'
  }) + '\n');
  child.emit('close', 1);
  await expect(p).rejects.toMatchObject({
    message: expect.stringMatching(/error_max_turns.*額度已用盡/), claudeStatus: 'error'
  });
});

// 反向錨：成功那則也是 type='result'，無條件收下會把正常產出當錯誤訊息塞進 blocker。
test('runClaude：exit 0 的 result 事件不被當成錯誤，正常回傳內容', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValueOnce(child);
  const { runClaude } = require('../pipeline/claude-runner');
  const p = runClaude('p', {});
  child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', result: '做完了' }) + '\n');
  child.emit('close', 0);
  await expect(p).resolves.toMatchObject({ text: '做完了' });
});

// 健檢 U12：失敗/中斷/逾時的執行也要記帳（usage 為零＋status 標記），
// 否則最貴的情境（失敗重跑）在 token 帳面上隱形，成本控管系統性低估。
test('logFailedUsage：失敗執行落一筆零用量記錄，status 標注失敗類別', async () => {
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('x', 4);
  const { rows: [u] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ('tlu2', $1, 'TL2') RETURNING id`, [hash]
  );
  const { logFailedUsage } = require('../pipeline/token-logger');
  const err = Object.assign(new Error('claude subprocess timed out'), { claudeStatus: 'timeout', durationMs: 600000 });
  await logFailedUsage({ taskId: 'task_fail_1', projectId: null }, u.id, 'coding', err);

  const { rows } = await dbModule.query("SELECT * FROM token_usage WHERE task_id='task_fail_1'");
  expect(rows.length).toBe(1);
  expect(rows[0].status).toBe('timeout');
  expect(rows[0].input_tokens).toBe(0);
  expect(rows[0].duration_ms).toBe(600000);
});

// 管理員在網頁設定的長效憑證要真的到得了子行程：注入點集中在 runner（19 個呼叫端零改動），
// 且不得蓋掉呼叫端自帶的 env（playwright 的 E2E_PASSWORD、coding 關的 git 身分）。
describe('Claude 長效憑證注入 spawn env', () => {
  const claudeAuth = require('../lib/claude-auth');
  const mkChild = () => {
    const { EventEmitter } = require('events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => setImmediate(() => child.emit('close', 0)), on: () => {} };
    child.kill = jest.fn();
    return child;
  };
  const lastEnv = () => {
    const { spawn } = require('child_process');
    return spawn.mock.calls[spawn.mock.calls.length - 1][2].env;
  };

  afterEach(() => claudeAuth._setForTesting(null));

  test('已設定 → spawn env 帶 CLAUDE_CODE_OAUTH_TOKEN，且呼叫端 env 不被蓋掉', async () => {
    const { spawn } = require('child_process');
    const { runClaude } = require('../pipeline/claude-runner');
    claudeAuth._setForTesting('sk-oat-live');
    spawn.mockReturnValueOnce(mkChild());
    await runClaude('p', { env: { E2E_PASSWORD: 'pw' } });
    expect(lastEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-oat-live');
    expect(lastEnv().E2E_PASSWORD).toBe('pw');
  });

  // /ai/* 端點的通行碼：算得出來但沒注入子行程，agent 就打不開那些端點，
  // 而症狀是「AI 突然查不到客戶 DB／wiki」，看起來完全不像認證問題（見 lib/ai-token.js）。
  test('spawn env 帶 AIDEV_AI_TOKEN，值與 aiToken() 一致', async () => {
    const { spawn } = require('child_process');
    const { runClaude } = require('../pipeline/claude-runner');
    const { aiToken } = require('../lib/ai-token');
    const saved = process.env.APP_SECRET;
    process.env.APP_SECRET = 'runner-ai-token-secret';
    try {
      spawn.mockReturnValueOnce(mkChild());
      await runClaude('p', {});
      expect(lastEnv().AIDEV_AI_TOKEN).toBe(aiToken());
      expect(lastEnv().AIDEV_AI_TOKEN).toBeTruthy();
    } finally { if (saved === undefined) delete process.env.APP_SECRET; else process.env.APP_SECRET = saved; }
  });

  // base URL 必須跟著執行期 PORT 走：prompt 曾寫死 3939（index.js 的預設值），正式機 PORT=8771，
  // agent 的 curl 全部 connection refused——server 側一句 fail loud 都送不出來，症狀只剩
  // 「讀不到設計稿」，看起來像 Figma token 沒設（實際發生：task 134，2026-08-14）。
  test('spawn env 帶 AIDEV_AI_BASE，埠號取自執行期 PORT 而非寫死預設值', async () => {
    const { spawn } = require('child_process');
    const { runClaude } = require('../pipeline/claude-runner');
    const saved = process.env.PORT;
    process.env.PORT = '8771'; // 刻意不用 3939：與預設值相同就驗不出「有沒有真的讀 PORT」
    try {
      spawn.mockReturnValueOnce(mkChild());
      await runClaude('p', {});
      expect(lastEnv().AIDEV_AI_BASE).toBe('http://localhost:8771');
    } finally { if (saved === undefined) delete process.env.PORT; else process.env.PORT = saved; }
  });

  // 未設定時必須「完全不碰」這個 key，否則會蓋掉手動 export 的環境變數（方案 1 手動版仍須可用）
  test('未設定 → 不塞該 key，繼承自 process.env 的值原樣通過', async () => {
    const { spawn } = require('child_process');
    const { runClaude } = require('../pipeline/claude-runner');
    claudeAuth._setForTesting(null);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'from-shell';
    try {
      spawn.mockReturnValueOnce(mkChild());
      await runClaude('p', {});
      expect(lastEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe('from-shell');
    } finally { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
  });

  // UI 設定優先於環境變數——「在網頁上換帳號」若被 shell 的舊值蓋過就失去意義
  test('DB 有設定 → 覆蓋 process.env 的同名變數', async () => {
    const { spawn } = require('child_process');
    const { runClaude } = require('../pipeline/claude-runner');
    claudeAuth._setForTesting('from-db');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'from-shell';
    try {
      spawn.mockReturnValueOnce(mkChild());
      await runClaude('p', {});
      expect(lastEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe('from-db');
    } finally { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
  });
});

// 認證失效歸因：claude 憑證在並發 spawn 下被刷新踩空時印 "Not logged in" 走 stdout、stderr 空，
// 舊版只剩泛用「claude exited with code 1」，blocker 看不出真因、分類器也判不出。
// 須把 stdout 掃到的認證字面浮到 reject 訊息，並標 claudeStatus='auth' 供分類器歸 transient。
test('runClaude：stdout 印 Not logged in 後 exit 1 → 可讀的認證失效訊息＋claudeStatus=auth', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValueOnce(child);

  const { runClaude } = require('../pipeline/claude-runner');
  const p = runClaude('p', {});
  child.stdout.emit('data', 'Not logged in\n'); // 非 JSON 行，走 raw emit 分支
  child.emit('close', 1);
  await expect(p).rejects.toMatchObject({
    message: expect.stringContaining('未登入或認證失效'),
    claudeStatus: 'auth',
  });
  await expect(p).rejects.toThrow(/Not logged in/); // 保留原始字面供分類器與人工判讀
});

// stderr 才印認證字面的變體（CLI 版本差異）也要歸因，不可只認 stdout
test('runClaude：stderr 印認證字面 → 同樣標 claudeStatus=auth', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, on: () => {} };
  child.kill = jest.fn();
  spawn.mockReturnValueOnce(child);

  const { runClaude } = require('../pipeline/claude-runner');
  const p = runClaude('p', {});
  child.stderr.emit('data', 'Invalid API key · Please run /login');
  child.emit('close', 1);
  await expect(p).rejects.toMatchObject({ claudeStatus: 'auth' });
});

// 回歸：非認證的 exit 1 不可被新分支吃掉，訊息與 claudeStatus 維持原樣
test('runClaude：非認證的 exit 1 → 維持原訊息與 claudeStatus=error', async () => {
  const { spawn } = require('child_process');
  const { EventEmitter } = require('events');
  const mk = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    child.kill = jest.fn();
    return child;
  };
  const { runClaude } = require('../pipeline/claude-runner');

  const c1 = mk();
  spawn.mockReturnValueOnce(c1);
  const p1 = runClaude('p', {});
  c1.stderr.emit('data', 'boom something broke');
  c1.emit('close', 1);
  await expect(p1).rejects.toMatchObject({ message: 'boom something broke', claudeStatus: 'error' });

  const c2 = mk();
  spawn.mockReturnValueOnce(c2);
  const p2 = runClaude('p', {});
  c2.emit('close', 1);
  await expect(p2).rejects.toMatchObject({ message: 'claude exited with code 1', claudeStatus: 'error' });
});

test('logTokenUsage：成功但 usage 為 null 時維持不落帳（相容既有行為）', async () => {
  await expect(require('../pipeline/token-logger').logTokenUsage({ taskId: 'x2' }, null, 'cs', null, null))
    .resolves.toBeUndefined();
  const { rows } = await dbModule.query("SELECT * FROM token_usage WHERE task_id='x2'");
  expect(rows.length).toBe(0);
});
