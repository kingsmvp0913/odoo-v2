// 意圖：cron 慢慢把 raw 退回原因拆成分類 rejection_items；解析失敗標 error 不無限重試（子專案 1）。
const { newDb } = require('pg-mem');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));

let dbModule, classifyPendingRejections, projectId, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name) VALUES ('c','h','C') RETURNING id");
  userId = u.id;
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,odoo_version) VALUES ('CP','17.0') RETURNING id");
  projectId = p.id;
  ({ classifyPendingRejections } = require('../pipeline/classify-rejections'));
});
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(() => mockRunClaude.mockReset());

async function insertRejection(reason) {
  const { rows: [r] } = await dbModule.query(
    "INSERT INTO task_rejections (task_id, project_id, user_id, reason, status) VALUES ('task_odoo_1',$1,$2,$3,'new') RETURNING id",
    [projectId, userId, reason]
  );
  return r.id;
}

test('new 退回 → 分類 agent 拆多項寫 rejection_items、status=classified；未知分類歸「其他」', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<result>[{"description":"備註型別錯","category":"實作錯誤"},{"description":"想改預設收合","category":"胡亂分類"}]</result>',
    usage: null, durationMs: null
  });
  const rid = await insertRejection('備註型別錯，另想改預設收合');
  await classifyPendingRejections();

  const { rows: [r] } = await dbModule.query('SELECT status FROM task_rejections WHERE id=$1', [rid]);
  expect(r.status).toBe('classified');
  const { rows: items } = await dbModule.query('SELECT description, category FROM rejection_items WHERE rejection_id=$1 ORDER BY id', [rid]);
  expect(items.length).toBe(2);
  expect(items[0].category).toBe('實作錯誤');
  expect(items[1].category).toBe('其他'); // 不在固定集合 → 歸其他
});

test('分類輸出無法解析 → status=error、不寫 items、下一 tick 不再撈到（不無限重試）', async () => {
  mockRunClaude.mockResolvedValue({ text: '不是 JSON 也沒有標記', usage: null, durationMs: null }); // 主呼叫＋haiku 補救都壞
  const rid = await insertRejection('壞掉的退回');
  await classifyPendingRejections();

  const { rows: [r] } = await dbModule.query('SELECT status FROM task_rejections WHERE id=$1', [rid]);
  expect(r.status).toBe('error');
  const { rows: items } = await dbModule.query('SELECT * FROM rejection_items WHERE rejection_id=$1', [rid]);
  expect(items.length).toBe(0);
});

test('無 new 退回 → 不呼叫 runClaude（零成本早退）', async () => {
  // 前面測試已把所有退回變 classified/error，無 new
  await classifyPendingRejections();
  expect(mockRunClaude).not.toHaveBeenCalled();
});
