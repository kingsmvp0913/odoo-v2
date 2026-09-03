// 意圖：feedback-triage 是夜間自動修正通道唯一的人工把關前哨（見 .claude/agents/feedback-triage.md）。
// 半夜無人監督時，這一步的判斷會直接決定要不要把一則意見送去改 production 程式碼——
// 判不出來卻硬編，下游沒有任何人會發現。這一支釘住「看不懂就退回 new，不卡在中間狀態」。
const { newDb } = require('pg-mem');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: (...args) => mockRunClaude(...args) }));
const mockLogTokenUsage = jest.fn();
const mockLogFailedUsage = jest.fn();
jest.mock('../pipeline/token-logger', () => ({
  logTokenUsage: (...args) => mockLogTokenUsage(...args),
  logFailedUsage: (...args) => mockLogFailedUsage(...args),
}));

let dbModule, triageOne, mergeCandidates;
let fbId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  ({ triageOne, mergeCandidates } = require('../pipeline/feedback-triage'));
});

beforeEach(async () => {
  mockRunClaude.mockReset();
  mockLogTokenUsage.mockReset();
  mockLogFailedUsage.mockReset();
  const { rows: [fb] } = await dbModule.query(
    "INSERT INTO feedback (user_id, content, status) VALUES (NULL, '按鈕怪怪的', 'approved') RETURNING id");
  fbId = fb.id;
});

test('回 understandable:false → 剔除且 status 退回 new，triage_note 寫原因', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<notes>看不出是哪一頁</notes>\n<result>{"understandable":false,"note":"看不出是哪一頁"}</result>',
    usage: {}, durationMs: 1
  });
  const r = await triageOne(fbId);
  expect(r.understandable).toBe(false);
  const { rows } = await dbModule.query('SELECT status, triage_note FROM feedback WHERE id=$1', [fbId]);
  expect(rows[0].status).toBe('new');
  expect(rows[0].triage_note).toContain('看不出是哪一頁');
});

test('回不出 JSON → 同樣退回 new，不卡在中間狀態', async () => {
  mockRunClaude.mockResolvedValue({ text: '我覺得這個嘛……', usage: {}, durationMs: 1 });
  const r = await triageOne(fbId);
  expect(r.ok).toBe(false);
  const { rows } = await dbModule.query('SELECT status FROM feedback WHERE id=$1', [fbId]);
  expect(rows[0].status).toBe('new');
});

test('看得懂 → 寫回四個 triage 欄位與 verify_route', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<notes>是任務列表的留白問題</notes>\n<result>'
      + '{"title":"任務列表留白過大","detail":"卡片間距異常","layer":"code",'
      + '"action":"調整 CSS gap","understandable":true,"note":"","verify_route":"#/tasks"}'
      + '</result>',
    usage: {}, durationMs: 1
  });
  const r = await triageOne(fbId);
  expect(r.ok).toBe(true);
  expect(r.understandable).toBe(true);
  const { rows } = await dbModule.query(
    `SELECT triage_title, triage_detail, triage_layer, triage_action, verify_route, status
       FROM feedback WHERE id=$1`, [fbId]);
  expect(rows[0].triage_title).toBe('任務列表留白過大');
  expect(rows[0].triage_detail).toBe('卡片間距異常');
  expect(rows[0].triage_layer).toBe('code');
  expect(rows[0].triage_action).toBe('調整 CSS gap');
  expect(rows[0].verify_route).toBe('#/tasks');
  expect(mockLogTokenUsage).toHaveBeenCalled();
});

// ⚠ 兩筆以上才證明得了合併真的發生（一筆時「合併」與「原樣回傳」看不出差別，rules/testing.md #19）
test('三筆講同一件事 → 合併成一組', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<notes>三條都是任務列表留白問題</notes>\n<result>'
      + '{"groups":[{"member_ids":[1,2,3],"title":"版面留白","detail":"三則意見皆指同一版位",'
      + '"action":"調整間距","layer":"code","verify_route":"#/tasks"}]}'
      + '</result>',
    usage: {}, durationMs: 1
  });
  const groups = await mergeCandidates([
    { id: 1, source: 'feedback', title: '按鈕貼太緊', detail: '第一則' },
    { id: 2, source: 'feedback', title: '留白太擠', detail: '第二則' },
    { id: 3, source: 'finding', title: '版面密度過高', detail: '健檢提案' },
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0].member_ids).toEqual([1, 2, 3]);
  expect(mockLogTokenUsage).toHaveBeenCalled();
});
