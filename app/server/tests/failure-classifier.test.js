// 意圖：把失敗分 transient/env/code 三類，各退對地方（健檢根因 B、U5）。
// 反轉舉證：只有「明確是開發者寫錯」才判 code 退 coding；模糊回 unknown 交給 agent，
// agent 也判不出 → 預設 env（丟人工，不退 coding 空轉——避免 task 84 那種缺依賴誤判成 code 的震盪）。
const { newDb } = require('pg-mem');

jest.mock('../pipeline/claude-runner', () => ({ runClaude: jest.fn() }));

const { classifyFailure, classifyFailureWithAgent } = require('../pipeline/failure-classifier');
const { runClaude } = require('../pipeline/claude-runner');

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

  test('真實 Odoo ParseError traceback（call stack 經過 venv 套件）→ 判 code 不被 env 誤搶', () => {
    const tb = [
      'Traceback (most recent call last):',
      '  File "/odoo-envs/proj/src/odoo/modules/loading.py", line 500, in load_module_graph',
      '  File "/odoo-envs/proj/venv/lib/python3.10/site-packages/lxml/etree.pyx", line 3',
      'odoo.tools.convert.ParseError: while parsing idx_module/views/x.xml:28'
    ].join('\n');
    expect(classifyFailure(tb)).toBe('code'); // venv 出現在路徑不代表是環境問題
  });

  test('開發者錯誤 import（ImportError）→ 判 code 不判 env', () => {
    expect(classifyFailure("ImportError: cannot import name 'Model' from 'odoo.models'")).toBe('code');
  });

  // 回歸（task 84）：缺依賴的 install-time UserError 是鐵板釘釘的部署環境問題（相依模組不在 addons path）。
  // 必須由純函式直接判 env——不可只拆掉 CODE 全包網後回 unknown 丟給 haiku agent，實測 agent 會因
  // 「depends 寫在 manifest」誤判成 code、退 coding 空轉。故加精準 ENV 規則 /not available in your system/ 鎖死。
  test('缺依賴 UserError（install 中止）→ 直接判 env（task 84 震盪根因）', () => {
    const tb = [
      'Traceback (most recent call last):',
      '  File "/odoo-envs/proj/src/odoo/addons/base/models/ir_module.py", line 700',
      "odoo.exceptions.UserError: You try to install module 'idx_hj' that depends on module 'web_login_styles'.",
      'But the latter module is not available in your system.'
    ].join('\n');
    expect(classifyFailure(tb)).toBe('env'); // 精準 ENV 規則命中，不再被 CODE 誤搶、也不必賭 agent
  });

  // 反轉舉證：籠統 ValidationError 不再算「明確開發者寫錯」（install 時常來自資料/設定）→ unknown 交給 agent
  test('籠統 ValidationError（無 field/syntax 特徵）→ 回 unknown 不判 code', () => {
    expect(classifyFailure('odoo.exceptions.ValidationError: 檢核未通過')).toBe('unknown');
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
  beforeEach(() => runClaude.mockReset());

  test('程式已能判定（env）→ 不叫 agent', async () => {
    const r = await classifyFailureWithAgent('could not connect to server');
    expect(r).toBe('env');
    expect(runClaude).not.toHaveBeenCalled();
  });

  test('unknown → 叫 agent；agent 回 env → env', async () => {
    runClaude.mockResolvedValue({ text: '{"type":"env"}' });
    const r = await classifyFailureWithAgent('weird novel error xyz');
    expect(r).toBe('env');
    expect(runClaude).toHaveBeenCalled();
  });

  test('unknown → agent 出錯 → 預設 env（丟人工，不退 coding 空轉）', async () => {
    runClaude.mockRejectedValue(new Error('agent down'));
    const r = await classifyFailureWithAgent('weird novel error xyz');
    expect(r).toBe('env');
  });

  test('unknown → agent 回不合法內容 → 預設 env', async () => {
    runClaude.mockResolvedValue({ text: 'not json at all' });
    const r = await classifyFailureWithAgent('weird novel error xyz');
    expect(r).toBe('env');
  });

  test('unknown → agent 明確回 code → 仍尊重 agent 判 code（明確才退 coding）', async () => {
    runClaude.mockResolvedValue({ text: '{"type":"code"}' });
    const r = await classifyFailureWithAgent('weird novel error xyz');
    expect(r).toBe('code');
  });
});

// R1 意圖：Claude API 過載/伺服器錯是 agent 關卡實際最常見的失敗字面，等幾秒重試幾乎必過；
// 不收進 TRANSIENT 就落 unknown → 關卡直接停等人工（QA 關實測 529/500 停機、blocker_type=null）。
describe('R1 Claude API 過載/5xx 屬 transient', () => {
  test('529 overloaded / 500 internal → transient（可自動重試）', () => {
    expect(classifyFailure('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe('transient');
    expect(classifyFailure('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}')).toBe('transient');
  });
  test('4xx（如 400 bad request）不可誤判 transient——重試救不了請求本身的錯', () => {
    expect(classifyFailure('API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}')).toBe('unknown');
  });
});
