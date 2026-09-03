const { newDb } = require('pg-mem');

describe('feedback schema', () => {
  let dbModule;
  beforeAll(async () => {
    jest.resetModules();
    const mem = newDb();
    const pg = mem.adapters.createPg();
    jest.doMock('pg', () => pg);
    dbModule = require('../db');
    await dbModule.migrate();
  });

  test('feedback 表有必要欄位且 status 預設 new', async () => {
    await dbModule.query("INSERT INTO feedback (user_id, content) VALUES (NULL, '按鈕沒留白')");
    const { rows } = await dbModule.query('SELECT status, triage_title, finding_id FROM feedback');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('new');
    expect(rows[0].triage_title).toBeNull();
    expect(rows[0].finding_id).toBeNull();
  });

  // CASCADE 是刻意的：不帶的話刪 feedback 會被附件那條 FK 擋住（此 repo 實測踩過，不是理論風險）
  test('刪 feedback 會連帶刪掉附件列', async () => {
    const { rows: [f] } = await dbModule.query(
      "INSERT INTO feedback (user_id, content) VALUES (NULL, '有圖') RETURNING id");
    await dbModule.query(
      "INSERT INTO feedback_attachments (feedback_id, filename, file_path) VALUES ($1, 'a.png', 'feedback_1/a.png')",
      [f.id]);
    await dbModule.query('DELETE FROM feedback WHERE id = $1', [f.id]);
    const { rows } = await dbModule.query('SELECT id FROM feedback_attachments');
    expect(rows).toHaveLength(0);
  });

  test('teams_settings 有 maintenance_until', async () => {
    await dbModule.query('INSERT INTO teams_settings (id) VALUES (1) ON CONFLICT DO NOTHING');
    const { rows } = await dbModule.query('SELECT maintenance_until FROM teams_settings WHERE id = 1');
    expect(rows[0].maintenance_until).toBeNull();
  });
});
