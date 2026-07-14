const { newDb } = require('pg-mem');

const mockRunClaude = jest.fn().mockResolvedValue({ text: '<result>{"slug":"test-feature","title":"測試功能","content":"# 測試\\n\\n這是測試功能說明。"}</result>', usage: null, durationMs: null });

jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));

let dbModule, runLibraryAgent;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ runLibraryAgent } = require('../pipeline/library-agent'));
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

let userSeq = 0;
async function createUserAndProject() {
  userSeq++;
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: [user] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, role) VALUES ('libtest${userSeq}', $1, 'Lib', 'user') RETURNING id`,
    [hash]
  );
  const { rows: [proj] } = await dbModule.query(
    `INSERT INTO projects (name, odoo_version) VALUES ('LibProj${userSeq}', '17.0') RETURNING id`
  );
  return { userId: user.id, projectId: proj.id };
}

test('no project_id → sets done, no wiki created', async () => {
  const { userId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1, 'T001', 'odoo', 'Test', 'wiki_updating') RETURNING id",
    [userId]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [updated] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
  const { rows: wikiRows } = await dbModule.query('SELECT * FROM wiki_pages WHERE project_id IS NULL');
  expect(wikiRows.length).toBe(0);
});

test('with project_id → upserts wiki page and sets done', async () => {
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1, 'T002', 'odoo', 'Feature X', 'wiki_updating', $2) RETURNING id",
    [userId, projectId]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [updated] } = await dbModule.query('SELECT status, done_at FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
  expect(updated.done_at).toBeTruthy(); // 進 done 時寫入完成時間，供自動封存
  const { rows: fnRows } = await dbModule.query(
    "SELECT * FROM wiki_pages WHERE project_id=$1 AND node_type='function'", [projectId]
  );
  expect(fnRows.length).toBe(1);
  expect(fnRows[0].slug).toBe('test-feature');

  // 功能頁掛在 module 節點下，module 節點掛在 overview 下
  const { rows: [modNode] } = await dbModule.query('SELECT * FROM wiki_pages WHERE id=$1', [fnRows[0].parent_id]);
  expect(modNode.node_type).toBe('module');
  const { rows: [ovNode] } = await dbModule.query('SELECT * FROM wiki_pages WHERE id=$1', [modNode.parent_id]);
  expect(ovNode.node_type).toBe('overview');
});

test('function page is attached under the module from analysis_yaml', async () => {
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id, analysis_yaml) VALUES ($1, 'T100', 'odoo', 'Feat', 'wiki_updating', $2, $3) RETURNING id",
    [userId, projectId, "module: sale_ext\nsummary: x"]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [mod] } = await dbModule.query(
    "SELECT * FROM wiki_pages WHERE project_id=$1 AND node_type='module'", [projectId]
  );
  expect(mod.slug).toBe('module-sale_ext');
});

test('API error → still sets task done', async () => {
  mockRunClaude.mockRejectedValueOnce(new Error('API down'));
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1, 'T003', 'odoo', 'Feature Y', 'wiki_updating', $2) RETURNING id",
    [userId, projectId]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [updated] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
});

// 意圖：parse 失敗不再靜默跳過卻標 done → task_logs 留痕，讓 wiki 缺頁有跡可循（健檢 F fail-loud）
test('F-failloud：library parse 失敗 → task_logs 留痕，任務仍 done', async () => {
  mockRunClaude
    .mockResolvedValueOnce({ text: '不是 JSON 也沒有 result 標記', usage: null, durationMs: null }) // 主呼叫
    .mockResolvedValueOnce({ text: '補救也還是壞的', usage: null, durationMs: null });               // haiku 補救
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'T_badjson','odoo','Feat','wiki_updating',$2) RETURNING id",
    [userId, projectId]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [updated] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [task.id]);
  expect(logs.some(l => l.content.includes('wiki 更新失敗'))).toBe(true);
});

// 意圖：任務完成時應「往上補」——若這次功能讓模組頁/總覽過時或不完整，agent 於 parents 附修正，
// JS 依白名單套用；不需要則父頁原封不動；白名單外的 slug 不得被誤改。
test('往上補：parents 含 overview／本模組頁 → 對應頁 content 被更新', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>' + JSON.stringify({
    slug: 'feat-a', title: '功能A', content: '# 功能A',
    parents: [
      { slug: 'overview', content: '# 更新後總覽' },
      { slug: 'module-sale', content: '# 更新後模組' }
    ]
  }) + '</result>', usage: null, durationMs: null });
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id,task_id,source,title,status,project_id,analysis_yaml) VALUES ($1,'TP1','odoo','Feat','wiki_updating',$2,$3) RETURNING id",
    [userId, projectId, 'module: sale']);
  await runLibraryAgent(task.id, userId);
  const { rows: [ov] } = await dbModule.query("SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='overview'", [projectId]);
  expect(ov.content).toBe('# 更新後總覽');
  const { rows: [mod] } = await dbModule.query("SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='module-sale'", [projectId]);
  expect(mod.content).toBe('# 更新後模組');
});

test('無 parents → 模組頁／總覽 content 原封不動', async () => {
  const { userId, projectId } = await createUserAndProject();
  // 第一次帶 parents 設定已知父頁內容
  mockRunClaude.mockResolvedValueOnce({ text: '<result>' + JSON.stringify({
    slug: 'f1', title: 'F1', content: '# F1',
    parents: [{ slug: 'overview', content: 'OV-KNOWN' }, { slug: 'module-inv', content: 'MOD-KNOWN' }]
  }) + '</result>', usage: null, durationMs: null });
  const { rows: [t1] } = await dbModule.query(
    "INSERT INTO tasks (user_id,task_id,source,title,status,project_id,analysis_yaml) VALUES ($1,'TP2a','odoo','F1','wiki_updating',$2,'module: inv') RETURNING id",
    [userId, projectId]);
  await runLibraryAgent(t1.id, userId);
  // 第二次用預設 mock（無 parents）
  const { rows: [t2] } = await dbModule.query(
    "INSERT INTO tasks (user_id,task_id,source,title,status,project_id,analysis_yaml) VALUES ($1,'TP2b','odoo','F2','wiki_updating',$2,'module: inv') RETURNING id",
    [userId, projectId]);
  await runLibraryAgent(t2.id, userId); // 預設 mock：slug test-feature、無 parents
  const { rows: [ov] } = await dbModule.query("SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='overview'", [projectId]);
  expect(ov.content).toBe('OV-KNOWN');
  const { rows: [mod] } = await dbModule.query("SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='module-inv'", [projectId]);
  expect(mod.content).toBe('MOD-KNOWN');
});

test('白名單：parents 含非 overview／非本任務模組 slug → 忽略、不誤改', async () => {
  const { userId, projectId } = await createUserAndProject();
  await dbModule.query(
    "INSERT INTO wiki_pages (project_id,parent_id,node_type,slug,title,content) VALUES ($1,null,'overview','overview','總覽','OVSEED'),($1,null,'module','module-other','other','OTHER-KEEP')",
    [projectId]);
  mockRunClaude.mockResolvedValueOnce({ text: '<result>' + JSON.stringify({
    slug: 'f3', title: 'F3', content: '# F3',
    parents: [{ slug: 'module-other', content: 'HACKED' }] // 本任務模組是 sale，非 other
  }) + '</result>', usage: null, durationMs: null });
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id,task_id,source,title,status,project_id,analysis_yaml) VALUES ($1,'TP3','odoo','F3','wiki_updating',$2,'module: sale') RETURNING id",
    [userId, projectId]);
  await runLibraryAgent(task.id, userId);
  const { rows: [other] } = await dbModule.query("SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='module-other'", [projectId]);
  expect(other.content).toBe('OTHER-KEEP'); // 未被誤改
});
