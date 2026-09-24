/**
 * exam-byok-spawn.test.js — 送進 AI 的東西逐字不變，只有憑證換人（規格 §4）
 *
 * **為什麼不比對判題結果。** 需求原句是「必須有逐題比對的品質關卡」，但同一份
 * prompt 送兩次，模型本來就會給出不同措辭——差異全部來自取樣，證明不了任何事。
 * 那種測試只會永遠紅，或永遠要人肉判讀。
 *
 * 驗得動的是**輸入**：args 的內容與順序、prompt、cwd、model 一律不得因這次改動
 * 而變化，變的只有子行程 env 裡的認證欄位。這支就是那道關卡。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

jest.mock('child_process', () => ({ spawn: jest.fn() }));

// challenge.js 的沙箱要真的 Odoo 原始碼才建得起來（ensureEvidenceCwd 找不到就丟
// 例外）。這支測的是 spawn 參數，不是沙箱，所以只把那兩支換成固定值。
let mockStageCwd = null;
jest.mock('../lib/exam/evidence', () => {
  const actual = jest.requireActual('../lib/exam/evidence');
  return {
    ...actual,
    ensureEvidenceCwd: () => mockStageCwd,
    sourceDirs: () => [{ name: 'src', path: '/stub/src' }],
  };
});

const MCP_CONFIG = path.join(__dirname, '..', 'lib', 'exam', 'mcp', 'none.json');
const SECRETS = { APP_SECRET: 'leak-a', JWT_SECRET: 'leak-j', DATABASE_URL: 'postgres://leak' };

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdin = { on: jest.fn(), write: jest.fn(), end: jest.fn() };
  c.kill = jest.fn();
  return c;
}

// 讓子行程「回一段合法 JSON 然後正常結束」。
function finishOk(c, json) {
  c.stdout.emit('data', JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(json) }] },
  }) + '\n');
  c.emit('close', 0);
}

let savedSecrets;
beforeAll(() => {
  savedSecrets = { ...SECRETS };
  for (const k of Object.keys(SECRETS)) { savedSecrets[k] = process.env[k]; process.env[k] = SECRETS[k]; }
});
afterAll(() => {
  for (const k of Object.keys(SECRETS)) {
    if (savedSecrets[k] === undefined) delete process.env[k]; else process.env[k] = savedSecrets[k];
  }
});
beforeEach(() => require('child_process').spawn.mockReset());

describe('review.js（讀題、讀章節都走這支）', () => {
  const { runPrompt, MODEL } = require('../lib/exam/review');

  const ARGS_NO_IMAGE = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
    // 沒有截圖時刻意是空字串（原本就是 imagePath ? 'Read' : ''）。改成不傳這一組
    // 參數看起來更乾淨，但那會讓 agent 拿回全部工具——這是成本閘門，不是裝飾。
    '--allowed-tools', '',
    '--strict-mcp-config', '--mcp-config', MCP_CONFIG,
    '--model', MODEL,
  ];

  test('args 逐字不變（內容與順序）', async () => {
    const { spawn } = require('child_process');
    const c = fakeChild();
    spawn.mockReturnValueOnce(c);
    const p = runPrompt({ prompt: 'PROMPT-A', authEnv: { ANTHROPIC_API_KEY: 'k' } });
    finishOk(c, { readable: true });
    await p;

    const [cmd, args] = spawn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual(ARGS_NO_IMAGE);
  });

  test('prompt 原樣寫進 stdin，不因帶憑證而改動', async () => {
    const { spawn } = require('child_process');
    const c = fakeChild();
    spawn.mockReturnValueOnce(c);
    const p = runPrompt({ prompt: 'PROMPT-B', authEnv: { ANTHROPIC_API_KEY: 'k' } });
    finishOk(c, { readable: true });
    await p;

    expect(c.stdin.write).toHaveBeenCalledWith('PROMPT-B');
  });

  test('認證欄位進得了子行程 env，白名單的 HOME 仍在', async () => {
    const { spawn } = require('child_process');
    const c = fakeChild();
    spawn.mockReturnValueOnce(c);
    const p = runPrompt({ prompt: 'x', authEnv: { ANTHROPIC_API_KEY: 'cust-key' } });
    finishOk(c, { readable: true });
    await p;

    const env = spawn.mock.calls[0][2].env;
    expect(env.ANTHROPIC_API_KEY).toBe('cust-key');
    expect(env.HOME).toBe(process.env.HOME);
  });

  // 合併順序寫反（authEnv 放前面）不會報錯，也不會讓任何既有測試變紅——只會靜靜
  // 沿用舊憑證，也就是客戶的帳記到廠商頭上。所以直接釘死「authEnv 蓋得過白名單」。
  // 拿 HOME 當探針是刻意的：它是白名單裡一定存在的鍵，蓋得過它就代表 authEnv 在後面。
  test('authEnv 蓋得過白名單（證明它 spread 在後面）', async () => {
    const { spawn } = require('child_process');
    const c = fakeChild();
    spawn.mockReturnValueOnce(c);
    const p = runPrompt({ prompt: 'x', authEnv: { HOME: '/tmp/probe-home' } });
    finishOk(c, { readable: true });
    await p;

    expect(spawn.mock.calls[0][2].env.HOME).toBe('/tmp/probe-home');
  });

  test('沒帶 authEnv 時行為與改動前相同（env 只有白名單）', async () => {
    const { spawn } = require('child_process');
    const c = fakeChild();
    spawn.mockReturnValueOnce(c);
    const p = runPrompt({ prompt: 'x' });
    finishOk(c, { readable: true });
    await p;

    const env = spawn.mock.calls[0][2].env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test('三把總鑰匙不得進子行程 env', async () => {
    const { spawn } = require('child_process');
    const c = fakeChild();
    spawn.mockReturnValueOnce(c);
    const p = runPrompt({ prompt: 'x', authEnv: { ANTHROPIC_API_KEY: 'k' } });
    finishOk(c, { readable: true });
    await p;

    const env = spawn.mock.calls[0][2].env;
    expect(env.APP_SECRET).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });
});

describe('challenge.js（判題）', () => {
  const challenge = require('../lib/exam/challenge');
  const questions = [{ no: 1, question: 'Q', options: [{ letter: 'A', text: 'a' }], type: 'single' }];
  const raw = { readable: true, questions: [{ no: 1, refuted: false, correct_answer: ['A'], confidence: 90, reason: 'r' }] };

  beforeEach(() => { mockStageCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-stage-')); });
  afterEach(() => { try { fs.rmSync(mockStageCwd, { recursive: true, force: true }); } catch { /* 已被 cleanup 移掉 */ } });

  const call = (authEnv) => challenge.challengePage({
    questions, theirAnswers: [['A']], glossary: [], odooVersion: '19', authEnv,
  });

  test('args 逐字不變（內容與順序）', async () => {
    const { spawn } = require('child_process');
    const c = fakeChild();
    spawn.mockReturnValueOnce(c);
    const p = call({ ANTHROPIC_API_KEY: 'k' });
    finishOk(c, raw);
    await p;

    const [cmd, args, opts] = spawn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      '--add-dir', '/stub/src',
      // 白名單不是限制（實測給 'Read' 它照樣跑 Bash），拒絕清單才是
      '--disallowed-tools', ...challenge.DISALLOWED,
      '--append-system-prompt', challenge.SYSTEM,
      '--strict-mcp-config', '--mcp-config', MCP_CONFIG,
      '--model', 'opus',
    ]);
    expect(opts.cwd).toBe(mockStageCwd);
  });

  test('認證欄位進得了子行程 env，白名單的 HOME 仍在', async () => {
    const { spawn } = require('child_process');
    const c = fakeChild();
    spawn.mockReturnValueOnce(c);
    const p = call({ ANTHROPIC_API_KEY: 'cust-key' });
    finishOk(c, raw);
    await p;

    const env = spawn.mock.calls[0][2].env;
    expect(env.ANTHROPIC_API_KEY).toBe('cust-key');
    expect(env.HOME).toBe(process.env.HOME);
  });

  test('authEnv 蓋得過白名單（證明它 spread 在後面）', async () => {
    const { spawn } = require('child_process');
    const c = fakeChild();
    spawn.mockReturnValueOnce(c);
    const p = call({ HOME: '/tmp/probe-home' });
    finishOk(c, raw);
    await p;

    expect(spawn.mock.calls[0][2].env.HOME).toBe('/tmp/probe-home');
  });

  test('三把總鑰匙不得進子行程 env', async () => {
    const { spawn } = require('child_process');
    const c = fakeChild();
    spawn.mockReturnValueOnce(c);
    const p = call({ ANTHROPIC_API_KEY: 'k' });
    finishOk(c, raw);
    await p;

    const env = spawn.mock.calls[0][2].env;
    expect(env.APP_SECRET).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });
});

// 讀官方成績單（sections.js）沿用 review.js 的 runPrompt。它是第三個會燒 token 的
// 入口，只是不在判題佇列上——漏掉它，客戶按「讀成績單」時會用到廠商的訂閱。
describe('sections.js（讀官方成績單）', () => {
  const { readSections } = require('../lib/exam/sections');
  const { MODEL } = require('../lib/exam/review');

  let shot;
  beforeEach(() => {
    shot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'byok-shot-')), 'shot.jpg');
    fs.writeFileSync(shot, Buffer.from([0xff, 0xd8, 0xff]));
  });

  test('憑證一路傳到 spawn，且有截圖時才給 Read', async () => {
    const { spawn } = require('child_process');
    const c = fakeChild();
    spawn.mockReturnValueOnce(c);
    const p = readSections({ imagePath: shot, authEnv: { ANTHROPIC_API_KEY: 'cust-key' } });
    finishOk(c, { readable: true, sections: [] });
    await p;

    const [, args, opts] = spawn.mock.calls[0];
    expect(args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      '--allowed-tools', 'Read',
      '--strict-mcp-config', '--mcp-config', MCP_CONFIG,
      '--model', MODEL,
    ]);
    expect(opts.env.ANTHROPIC_API_KEY).toBe('cust-key');
  });
});
