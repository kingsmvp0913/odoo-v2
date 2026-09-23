// 意圖：統一輸出契約解析必須「健壯＋失敗補救一次」，避免 agent 花完 token 卻因收尾格式抖動整輪報廢（健檢 F）。
const yaml = require('js-yaml');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
const mockLogUsage = jest.fn();
const mockLogFailed = jest.fn();
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: mockLogUsage, logFailedUsage: mockLogFailed }));
const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: mockQuery }));

const { extractResult, parseAgentResult, repairYamlPayload } = require('../pipeline/agent-result');

beforeEach(() => {
  mockRunClaude.mockReset(); mockLogUsage.mockReset(); mockLogFailed.mockReset();
  mockQuery.mockReset().mockResolvedValue({ rows: [{ id: 42 }] });
});

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

// 意圖：raw 整段沒有 <result> 時（實測 task 152 的 coding 只吐中文摘要），補救 agent 連一個 JSON
// 都看不到，沒有目標結構就只能亂猜鍵名＝必然再失敗一次，那次 haiku 呼叫等於白花。
test('parseAgentResult：帶 schemaHint → 補救 prompt 要把目標結構講給 haiku 聽', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>{"status":"qa_running","summary":"加了欄位"}</result>' });
  const v = await parseAgentResult('我已經加好欄位並 commit 了。', {
    parse: JSON.parse,
    schemaHint: '{"status":"qa_running","summary":"本輪實際做了什麼"}',
  });
  expect(v.status).toBe('qa_running');
  expect(mockRunClaude.mock.calls[0][0]).toContain('"status":"qa_running"');
  expect(mockRunClaude.mock.calls[0][0]).toContain('我已經加好欄位並 commit 了。'); // 原文仍要附上
});

// 鑑別力：schemaHint 是呼叫端選用的（只有它知道自己的 parse 期望什麼）。沒帶的呼叫端不得被塞進
// 憑空捏造的結構——那會把補救 agent 導去產一份根本不屬於它的 JSON。
test('parseAgentResult：未帶 schemaHint → 補救 prompt 不得出現結構段', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>{"a":1}</result>' });
  await parseAgentResult('壞掉的輸出', { parse: JSON.parse });
  expect(mockRunClaude.mock.calls[0][0]).not.toContain('結果資料必須是這個結構');
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
  expect(mockRunClaude.mock.calls[0][1].taskId).toBe(42);
});

test('repairYamlPayload：任務補救也帶 DB taskId，受同一張任務的花費上限約束', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>answer: fixed</result>' });
  await repairYamlPayload('answer: [', 'bad YAML', { ref: { taskId: 't1' }, userId: 7 });
  expect(mockRunClaude.mock.calls[0][1].taskId).toBe(42);
});

test('格式補救查不到所屬任務時不開跑 AI，避免失去預算歸屬', async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  await expect(parseAgentResult('壞', { parse: JSON.parse, ref: { taskId: 'missing' }, userId: 7 }))
    .rejects.toThrow('找不到格式補救所屬任務');
  expect(mockRunClaude).not.toHaveBeenCalled();
});

test('parseAgentResult：帶 ref 且補救失敗（非 abort）→ 落一筆 repair 失敗帳、回 null', async () => {
  mockRunClaude.mockRejectedValue(new Error('boom'));
  const v = await parseAgentResult('壞', { parse: JSON.parse, ref: { taskId: 't2' }, userId: 7 });
  expect(v).toBeNull();
  expect(mockLogFailed).toHaveBeenCalled();
});

test('parseAgentResult：YAML 路徑（analysis-project）— <result> 包住含 fence 的 YAML 能 load', async () => {
  const raw = '<result>\n```yaml\ncase_id: "t1"\nmodule: sale\n```\n</result>';
  const v = await parseAgentResult(raw, { parse: yaml.load });
  expect(v.case_id).toBe('t1');
  expect(v.module).toBe('sale');
});

// 意圖：agent 最終輸出被截斷（有 <result> 卻無 </result>）＝不完整，不可拿殘缺內容冒充完整結果放行（Rule 12 fail loud）。
// 這正是 task 128 卡「未回傳有效結果」的根因：截斷的 <result> 被當有效結果解析。
test('extractResult：有 <result> 但無 </result>（輸出被截斷）→ 回 null，不取殘缺內容', () => {
  expect(extractResult('前言\n<result>\ncase_id: t1\nmodule: sale\nfiles:')).toBeNull();
});

test('extractResult：完整組在前、截斷殘句在後 → 取最後一組「有閉合」的內容', () => {
  const r = extractResult('<result>{"x":1}</result> 收尾殘句 <result>{"x":2');
  expect(JSON.parse(r).x).toBe(1);
});

test('parseAgentResult：analysis 最終輸出被截斷（無 </result>）→ 觸發 haiku 補救而非誤判成功', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>\ncase_id: t9\nmodule: sale\nsummary: s\nrequirements: r\n</result>' });
  const raw = '<result>\ncase_id: t9\nmodule: sale\nsummary: s\nrequirements:'; // 截斷、無閉合
  const v = await parseAgentResult(raw, { parse: yaml.load });
  expect(mockRunClaude).toHaveBeenCalledTimes(1);
  expect(v.case_id).toBe('t9');
});

// 意圖：補救 agent 收不到解析器的抱怨就等於盲修。實測 task 110——analysis 的 YAML 只是把
// `permissions: |` 吐了兩次（duplicated mapping key），其餘完全正確，但補救 prompt 只寫「可能夾雜
// 多餘文字或格式錯誤」，haiku 花了 147 秒／7.8k tokens 把同一份壞 YAML 原封抄回來，整輪 opus
// 分析報廢。錯誤訊息必須進到 prompt，補救才有東西可修。
test('parseAgentResult：解析錯誤訊息要帶進補救 prompt（否則 haiku 只能原文照抄）', async () => {
  const broken = '<result>\ncase_id: t10\npermissions: |\npermissions: |\nlow_confidence: false\n</result>';
  mockRunClaude.mockResolvedValue({ text: '<result>\ncase_id: t10\npermissions: ""\nlow_confidence: false\n</result>' });
  const v = await parseAgentResult(broken, { parse: s => yaml.load(s, { schema: yaml.CORE_SCHEMA }) });
  expect(v.case_id).toBe('t10');
  expect(mockRunClaude.mock.calls[0][0]).toContain('duplicated mapping key');
});

// 對照組：解析器沒抱怨過（根本抽不出 <result>）時不得憑空編一段錯誤訊息餵給補救 agent，
// 那會把它導去修一個不存在的問題。
test('parseAgentResult：抽不出 <result>（無解析錯誤可報）→ 補救 prompt 不帶錯誤段落', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>{"status":"fixed"}</result>' });
  await parseAgentResult('完全沒有標記的一段話', { parse: JSON.parse });
  expect(mockRunClaude.mock.calls[0][0]).not.toContain('上一次解析失敗');
});

// 意圖：契約裡「使用者非看到不可的那一段」（對話回覆）不該跟「結構化附載」（YAML 規格／題目）同生共死。
// 實測 task 254：clarify-chat 跑了 285 秒／22.6k output，回覆完全正確，只因題目 YAML 有一行縮排差兩格
// （`  user_answer: ''`）就整輪報廢，使用者只看到「AI 回覆失敗，請再送出一次」。
// lenientParse 是 strict＋haiku 補救都失敗之後的最後一道，由呼叫端決定哪些欄位可以降級成 null。
test('parseAgentResult：strict 成功時不得動用 lenientParse', async () => {
  const lenient = jest.fn();
  const v = await parseAgentResult('<result>{"status":"ok"}</result>', { parse: JSON.parse, lenientParse: lenient });
  expect(v.status).toBe('ok');
  expect(lenient).not.toHaveBeenCalled();
});

// 順序很重要：lenientParse 是零成本的，必須排在 haiku 整段補救之前。實測 task 254 的整段補救
// 花了 92 秒、照抄同一份壞資料回來——那 92 秒是使用者盯著轉圈的時間，而且結果還是失敗。
test('parseAgentResult：strict 失敗 → 先用零成本的 lenientParse，成功就不呼叫 haiku', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>{"status":"fixed"}</result>' });
  const v = await parseAgentResult('<result>DECISION: revise\nREPLY:\n改好了\n---SPEC---\n: : 壞 YAML</result>', {
    parse: () => { throw new Error('壞 YAML'); },
    lenientParse: s => ({ salvaged: true, src: s })
  });
  expect(v.salvaged).toBe(true);
  expect(v.src).toContain('改好了');          // 拿到的是 <result> 內層原文，不是整段 raw
  expect(mockRunClaude).not.toHaveBeenCalled();
});

test('parseAgentResult：strict 與 lenient 都失敗 → 才走 haiku 整段補救', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>{"status":"fixed"}</result>' });
  const v = await parseAgentResult('壞掉的輸出', {
    parse: JSON.parse,
    lenientParse: () => { throw new Error('連寬鬆解析都救不了'); }
  });
  expect(v.status).toBe('fixed');
  expect(mockRunClaude).toHaveBeenCalledTimes(1);
});

test('parseAgentResult：三種解析全失敗 → 回 null（例外不得炸給呼叫端）', async () => {
  mockRunClaude.mockResolvedValue({ text: '還是壞的' });
  const v = await parseAgentResult('<result>垃圾</result>', {
    parse: () => { throw new Error('x'); },
    lenientParse: () => { throw new Error('連寬鬆解析都救不了'); }
  });
  expect(v).toBeNull();
});

// ── repairYamlPayload：只修 YAML 那半邊 ──────────────────────────────────
// 整段補救要 model 把數千字中文回覆逐字重抄一遍才能改掉一個縮排，實測它會直接照抄壞資料回來。
// 只送 YAML 區塊，它要做的事才回到做得到的尺寸——這是「格式錯了也能自己走下去」的關鍵。
test('repairYamlPayload：prompt 只含 YAML 區塊，不得夾帶回覆全文', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>\nintro: 說明\nuser_answer: ""\n</result>' });
  const fixed = await repairYamlPayload('intro: 說明\n  user_answer: ""', 'bad indentation', { schemaHint: 'intro／user_answer 要頂格' });
  expect(fixed).toContain('user_answer');
  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain('bad indentation');        // 錯誤原文要轉述，否則它只能盲修
  expect(prompt).toContain('intro／user_answer 要頂格');
  expect(prompt).not.toContain('DECISION');           // 回覆那半邊完全不進 prompt
});

test('repairYamlPayload：修回來的東西仍不是合法 YAML 物件 → 回 null（絕不放行壞資料）', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>\n: : : 還是壞的 : :\n</result>' });
  expect(await repairYamlPayload('壞 YAML', 'err', {})).toBeNull();
});

test('repairYamlPayload：修回來的是純量／陣列而非物件 → 回 null', async () => {
  mockRunClaude.mockResolvedValue({ text: '<result>\n- a\n- b\n</result>' });
  expect(await repairYamlPayload('壞 YAML', 'err', {})).toBeNull();
});

test('repairYamlPayload：空輸入不浪費一次呼叫', async () => {
  expect(await repairYamlPayload('   ', 'err', {})).toBeNull();
  expect(mockRunClaude).not.toHaveBeenCalled();
});

test('repairYamlPayload：補救途中 abort → rethrow（不吞成 null）', async () => {
  const aborted = new Error('aborted'); aborted.aborted = true;
  mockRunClaude.mockRejectedValue(aborted);
  await expect(repairYamlPayload('intro: x', 'err', {})).rejects.toThrow();
});
