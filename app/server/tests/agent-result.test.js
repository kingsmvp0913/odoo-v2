// 意圖：統一輸出契約解析必須「健壯＋失敗補救一次」，避免 agent 花完 token 卻因收尾格式抖動整輪報廢（健檢 F）。
const yaml = require('js-yaml');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
const mockLogUsage = jest.fn();
const mockLogFailed = jest.fn();
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: mockLogUsage, logFailedUsage: mockLogFailed }));

const { extractResult, parseAgentResult } = require('../pipeline/agent-result');

beforeEach(() => { mockRunClaude.mockReset(); mockLogUsage.mockReset(); mockLogFailed.mockReset(); });

test('extractResult：剝除 ```json fence 取出 JSON', () => {
  const r = extractResult('前言\n<result>\n```json\n{"a":1}\n```\n</result>\n後');
  expect(r).toBe('{"a":1}');
});

test('extractResult：取最後一組 <result>，前面的範例不誤取', () => {
  const r = extractResult('範例：<result>{"x":0}</result>\n真正答案：<result>{"x":9}</result>');
  expect(JSON.parse(r).x).toBe(9);
});

test('extractResult：無 <result> 標記回 null', () => {
  expect(extractResult('完全沒有標記的一段話')).toBeNull();
});

test('parseAgentResult：首次成功 → 不呼叫 haiku', async () => {
  const v = await parseAgentResult('<result>{"status":"ok"}</result>', { parse: JSON.parse });
  expect(v.status).toBe('ok');
  expect(mockRunClaude).not.toHaveBeenCalled();
});

test('parseAgentResult：首次失敗 → haiku 補救一次 → 可 parse', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>{"status":"fixed"}</result>' });
  const v = await parseAgentResult('壞掉的輸出、沒有標記', { parse: JSON.parse });
  expect(v.status).toBe('fixed');
  expect(mockRunClaude).toHaveBeenCalledTimes(1);
  expect(mockRunClaude.mock.calls[0][1].model).toBe('haiku'); // 補救用最便宜的 haiku
});

test('parseAgentResult：haiku 補救也失敗 → null（呼叫端據此 stopped）', async () => {
  mockRunClaude.mockResolvedValue({ text: '還是壞的' });
  const v = await parseAgentResult('壞', { parse: JSON.parse });
  expect(v).toBeNull();
  expect(mockRunClaude).toHaveBeenCalledTimes(1);
});

// 手動暫停不可吞成 null：吞掉會讓呼叫端把「暫停」誤標 stopped，破壞「解除暫停原地續跑」約定
test('parseAgentResult：補救期間 abort → rethrow（不吞成 null）', async () => {
  mockRunClaude.mockRejectedValue(Object.assign(new Error('手動暫停'), { aborted: true }));
  await expect(parseAgentResult('壞', { parse: JSON.parse })).rejects.toMatchObject({ aborted: true });
});

// 健檢 U12 延伸：補救那一次 haiku 呼叫也是真實成本，帶 ref 時必須記帳（否則失敗重跑成本帳面隱形）
test('parseAgentResult：帶 ref → 補救呼叫的 usage 記帳為 repair', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>{"a":1}</result>', usage: { input_tokens: 9 }, durationMs: 42 });
  const v = await parseAgentResult('壞', { parse: JSON.parse, ref: { taskId: 't1' }, userId: 7 });
  expect(v.a).toBe(1);
  expect(mockLogUsage).toHaveBeenCalledWith({ taskId: 't1' }, 7, 'repair', { input_tokens: 9 }, 42);
});

test('parseAgentResult：帶 ref 且補救失敗（非 abort）→ 落一筆 repair 失敗帳、回 null', async () => {
  mockRunClaude.mockRejectedValue(new Error('boom'));
  const v = await parseAgentResult('壞', { parse: JSON.parse, ref: { taskId: 't2' }, userId: 7 });
  expect(v).toBeNull();
  expect(mockLogFailed).toHaveBeenCalled();
});

test('parseAgentResult：YAML 路徑（analysis-basic）— <result> 包住含 fence 的 YAML 能 load', async () => {
  const raw = '<result>\n```yaml\ncase_id: "t1"\nmodule: sale\n```\n</result>';
  const v = await parseAgentResult(raw, { parse: yaml.load });
  expect(v.case_id).toBe('t1');
  expect(v.module).toBe('sale');
});
