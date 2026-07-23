// 意圖：獨立 runner 把已分類的 wiki 漂移套用成「從程式碼重生該頁」。核心是去重——
// 同一頁一輪只重生一次、且最近 DEDUP 天內已重生過就不再重生（＝重複的錯誤不重更新 wiki）；
// 重生來源是程式碼（refreshWikiNode），不是對話 prose；失敗標記已處理不無限重試。
const { newDb } = require('pg-mem');

const mockRefresh = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../pipeline/library-agent', () => ({ refreshWikiNode: (...a) => mockRefresh(...a) }));

let dbModule, applyPendingWikiDrift, projectId, userId;

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
  ({ applyPendingWikiDrift } = require('../pipeline/wiki-drift-runner'));
});
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(async () => {
  mockRefresh.mockClear();
  await dbModule.query('DELETE FROM wiki_drift');
});

async function insertClassified(slug, { applied = false } = {}) {
  const { rows: [r] } = await dbModule.query(
    `INSERT INTO wiki_drift (project_id, user_id, source, slug, reason, category, status, applied_at)
     VALUES ($1,$2,'chat',$3,'頁面與程式不符','過時','classified',${applied ? 'NOW()' : 'NULL'}) RETURNING id`,
    [projectId, userId, slug]
  );
  return r.id;
}

test('同一頁多筆回報 → 一輪只重生一次，兩筆都標 applied_at', async () => {
  await insertClassified('sale-flow');
  await insertClassified('sale-flow');
  const refreshed = await applyPendingWikiDrift();

  expect(refreshed).toBe(1);
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(mockRefresh).toHaveBeenCalledWith(projectId, 'sale-flow', userId);
  const { rows } = await dbModule.query("SELECT applied_at FROM wiki_drift WHERE slug='sale-flow'");
  expect(rows.length).toBe(2);
  expect(rows.every(r => r.applied_at != null)).toBe(true);
});

test('不同頁 → 各自重生一次', async () => {
  await insertClassified('page-a');
  await insertClassified('page-b');
  const refreshed = await applyPendingWikiDrift();
  expect(refreshed).toBe(2);
  expect(mockRefresh).toHaveBeenCalledTimes(2);
});

test('同頁最近已重生過 → 不重更新，只把新回報標記已處理', async () => {
  await insertClassified('sale-flow', { applied: true }); // 模擬上一輪已重生
  const fresh = await insertClassified('sale-flow');       // 之後又被回報同一頁
  const refreshed = await applyPendingWikiDrift();

  expect(refreshed).toBe(0);                 // 去重：不再重生
  expect(mockRefresh).not.toHaveBeenCalled();
  const { rows: [r] } = await dbModule.query('SELECT applied_at FROM wiki_drift WHERE id=$1', [fresh]);
  expect(r.applied_at).not.toBeNull();       // 仍標記已處理，不會每小時反覆撈到
});

test('slug 為空 → 無法定位頁，不重生、不標記（留給健檢／人工）', async () => {
  const { rows: [r] } = await dbModule.query(
    `INSERT INTO wiki_drift (project_id, user_id, source, slug, reason, category, status)
     VALUES ($1,$2,'cs','','某模組描述不符','缺漏','classified') RETURNING id`,
    [projectId, userId]
  );
  const refreshed = await applyPendingWikiDrift();
  expect(refreshed).toBe(0);
  expect(mockRefresh).not.toHaveBeenCalled();
  const { rows: [row] } = await dbModule.query('SELECT applied_at FROM wiki_drift WHERE id=$1', [r.id]);
  expect(row.applied_at).toBeNull();
});

test('重生丟錯（頁不存在等）→ 仍標 applied_at，不無限重試', async () => {
  mockRefresh.mockRejectedValueOnce(Object.assign(new Error('Wiki node not found'), { status: 404 }));
  const id = await insertClassified('ghost-page');
  const refreshed = await applyPendingWikiDrift();
  expect(refreshed).toBe(0);
  const { rows: [r] } = await dbModule.query('SELECT applied_at FROM wiki_drift WHERE id=$1', [id]);
  expect(r.applied_at).not.toBeNull();
});

test('無可套用的漂移 → 回 0、不重生', async () => {
  expect(await applyPendingWikiDrift()).toBe(0);
  expect(mockRefresh).not.toHaveBeenCalled();
});
