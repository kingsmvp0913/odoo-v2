// 意圖：統一輸出契約解析必須「健壯＋失敗補救一次」，避免 agent 花完 token 卻因收尾格式抖動整輪報廢（健檢 F）。
const yaml = require('js-yaml');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));

const { extractResult, parseAgentResult } = require('../pipeline/agent-result');

beforeEach(() => mockRunClaude.mockReset());

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

test('parseAgentResult：YAML 路徑（analysis-basic）— <result> 包住含 fence 的 YAML 能 load', async () => {
  const raw = '<result>\n```yaml\ncase_id: "t1"\nmodule: sale\n```\n</result>';
  const v = await parseAgentResult(raw, { parse: yaml.load });
  expect(v.case_id).toBe('t1');
  expect(v.module).toBe('sale');
});
