// 意圖：把失敗分 transient/env/code 三類，各退對地方（健檢根因 B、U5）。
// 分類器保守偏向：只有明確才改判，模糊回 unknown 交給 agent；agent 也判不出預設 code（安全＝現況）。
const { newDb } = require('pg-mem');

jest.mock('../pipeline/claude-runner', () => ({ callClaude: jest.fn() }));

const { classifyFailure, classifyFailureWithAgent } = require('../pipeline/failure-classifier');
const { callClaude } = require('../pipeline/claude-runner');

describe('classifyFailure 純函式', () => {
  test('transient：被 kill / 連線重置 / DNS 失敗', () => {
    expect(classifyFailure('Command failed: killed')).toBe('transient');
    expect(classifyFailure('read ECONNRESET')).toBe('transient');
    expect(classifyFailure('socket hang up')).toBe('transient');
    expect(classifyFailure('could not resolve host: github.com')).toBe('transient');
  });

  test('env：DB 連不上 / 缺套件 / 權限 / port 佔用 / env 未運行', () => {
    expect(classifyFailure('could not connect to server: Connection refused')).toBe('env');
    expect(classifyFailure('ModuleNotFoundError: No module named "xlwt"')).toBe('env');
    expect(classifyFailure('PermissionError: [Errno 13] Permission denied')).toBe('env');
    expect(classifyFailure('OSError: [Errno 98] Address already in use')).toBe('env');
    expect(classifyFailure('測試環境無法啟動，請至專案環境頁檢查')).toBe('env');
  });

  test('code：Odoo traceback / XML / 欄位錯誤', () => {
    expect(classifyFailure('Traceback\nodoo.tools.convert.ParseError: Invalid view')).toBe('code');
    expect(classifyFailure('lxml.etree.XMLSyntaxError: Opening and ending tag mismatch')).toBe('code');
    expect(classifyFailure('ValueError: Invalid field "note_t" on model "sale.order"')).toBe('code');
    expect(classifyFailure('SyntaxError: invalid syntax (sale_order.py, line 12)')).toBe('code');
  });

  test('unknown：無法明確判定', () => {
    expect(classifyFailure('something totally unexpected happened')).toBe('unknown');
    expect(classifyFailure('')).toBe('unknown');
  });

  test('timeout 訊號不被誤判成 code/transient（由呼叫端先攔）', () => {
    // classifyFailure 不負責 timeout；即使文字含 timed out 也不當 transient 自動重試
    expect(classifyFailure('claude subprocess timed out', { claudeStatus: 'timeout' })).toBe('unknown');
  });
});

describe('classifyFailureWithAgent', () => {
  beforeEach(() => callClaude.mockReset());

  test('程式已能判定（env）→ 不叫 agent', async () => {
    const r = await classifyFailureWithAgent('could not connect to server');
    expect(r).toBe('env');
    expect(callClaude).not.toHaveBeenCalled();
  });

  test('unknown → 叫 agent；agent 回 env → env', async () => {
    callClaude.mockResolvedValue({ text: '{"type":"env"}' });
    const r = await classifyFailureWithAgent('weird novel error xyz');
    expect(r).toBe('env');
    expect(callClaude).toHaveBeenCalled();
  });

  test('unknown → agent 出錯 → 預設 code（安全）', async () => {
    callClaude.mockRejectedValue(new Error('agent down'));
    const r = await classifyFailureWithAgent('weird novel error xyz');
    expect(r).toBe('code');
  });

  test('unknown → agent 回不合法內容 → 預設 code', async () => {
    callClaude.mockResolvedValue({ text: 'not json at all' });
    const r = await classifyFailureWithAgent('weird novel error xyz');
    expect(r).toBe('code');
  });
});
