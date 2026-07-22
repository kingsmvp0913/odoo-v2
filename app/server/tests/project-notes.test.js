const { newDb } = require('pg-mem');

let dbModule;
let getProjectNotes;

// 意圖：getProjectNotes 是「備註要不要注入」的唯一判斷來源。
// 空／純空白＝視為沒寫（不得注入，避免污染 prompt／破壞 cache 前綴）；有內容回 trim 後字串。
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ getProjectNotes } = require('../pipeline/project-notes'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

async function makeProject(name) {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ($1,'17.0') RETURNING id", [name]
  );
  return p.id;
}
async function setNotes(projectId, content) {
  await dbModule.query(
    "INSERT INTO wiki_pages (project_id, parent_id, node_type, slug, title, content) VALUES ($1,NULL,'notes','project-notes','專案備註',$2)",
    [projectId, content]
  );
}

test('沒有 project-notes 頁 → null（不注入）', async () => {
  const pid = await makeProject('無備註');
  expect(await getProjectNotes(pid)).toBeNull();
});

test('備註純空白 → null（不注入）', async () => {
  const pid = await makeProject('空白備註');
  await setNotes(pid, '   \n\t  ');
  expect(await getProjectNotes(pid)).toBeNull();
});

test('備註空字串 → null（不注入）', async () => {
  const pid = await makeProject('空字串備註');
  await setNotes(pid, '');
  expect(await getProjectNotes(pid)).toBeNull();
});

test('備註有內容 → 回 trim 後內容', async () => {
  const pid = await makeProject('有備註');
  await setNotes(pid, '\n部署到 8069 埠，聯絡窗口 Amy\n');
  expect(await getProjectNotes(pid)).toBe('部署到 8069 埠，聯絡窗口 Amy');
});
