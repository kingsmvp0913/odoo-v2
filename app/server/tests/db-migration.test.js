const { newDb } = require('pg-mem');

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('migrate 建立 task_events 表（執行歷程持久化）', async () => {
  const { rows } = await dbModule.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='task_events'"
  );
  expect(rows.length).toBe(1);
});

test('migrate 加 tasks.resume_status 欄位（解決阻塞回到中斷階段用）', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tasks' AND column_name='resume_status'"
  );
  expect(rows.length).toBe(1);
});

test('migrate 加 tasks.approved_at 欄位（人工審核通過標記，用於禁刪/隱藏刪除鈕）', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tasks' AND column_name='approved_at'"
  );
  expect(rows.length).toBe(1);
});

test('migrate is idempotent — calling twice does not throw', async () => {
  let threw = false;
  try { await dbModule.migrate(); } catch { threw = true; }
  expect(threw).toBe(false);
});

test('projects table has expected columns', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='projects'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('name');
  expect(cols).toContain('odoo_version');
});

test('project_repos table has expected columns', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='project_repos'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('project_id');
  expect(cols).toContain('repo_url');
  expect(cols).toContain('is_primary');
});

test('wiki_pages table has expected columns', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='wiki_pages'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('project_id');
  expect(cols).toContain('slug');
  expect(cols).toContain('content');
});

test('tasks table has project_id column after migration', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tasks' AND column_name='project_id'"
  );
  expect(rows.length).toBe(1);
});

test('token_usage table exists after migrate', async () => {
  const { rows } = await dbModule.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='token_usage'"
  );
  expect(rows.length).toBe(1);
});

test('projects has odoo_project_name column', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='projects' AND column_name='odoo_project_name'"
  );
  expect(rows.length).toBe(1);
});

test('projects has service_respondent_name column', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='projects' AND column_name='service_respondent_name'"
  );
  expect(rows.length).toBe(1);
});

test('wiki_pages has parent_id column', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='wiki_pages' AND column_name='parent_id'"
  );
  expect(rows.length).toBe(1);
});

test('wiki_pages has node_type column', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='wiki_pages' AND column_name='node_type'"
  );
  expect(rows.length).toBe(1);
});

test('tasks 具有 qa_retry_count / pw_retry_count / done_at 欄位', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tasks'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('qa_retry_count');
  expect(cols).toContain('pw_retry_count');
  expect(cols).toContain('done_at');
});

test('users 具有 password_enc 欄位', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='password_enc'"
  );
  expect(rows.length).toBe(1);
});

test('migrate 把已移除狀態的舊任務遷移為 stopped', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('mig1','x','MIG') RETURNING id"
  );
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status) VALUES ($1,'mig_final','manual','final_pending') RETURNING id",
    [u.id]
  );
  await dbModule.migrate(); // 冪等，重跑會套用一次性遷移
  const { rows: [after] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [t.id]);
  expect(after.status).toBe('stopped');
  expect(after.blocker_content).toContain('流程改版');
});

test('project_chats 具有 user_id 與 last_read_message_id 欄位', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('m1','x','M1') RETURNING id"
  );
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('P','17.0') RETURNING id"
  );
  const { rows: [c] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title, user_id) VALUES ($1,'t',$2) RETURNING id, user_id, last_read_message_id",
    [p.id, u.id]
  );
  expect(c.user_id).toBe(u.id);
  expect(c.last_read_message_id).toBe(0);
});

test('migrate 建立 task_attachments 表', async () => {
  const { rows } = await dbModule.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='task_attachments'"
  );
  expect(rows.length).toBe(1);
});

test('task_attachments 具有 origin / external_attachment_id / synced_to_odoo 欄位', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='task_attachments'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('origin');
  expect(cols).toContain('external_attachment_id');
  expect(cols).toContain('synced_to_odoo');
  expect(cols).toContain('message_id');
});

test('tasks 具有 stage_label / classification_label / has_attachment 欄位', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tasks'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('stage_label');
  expect(cols).toContain('classification_label');
  expect(cols).toContain('has_attachment');
});

test('migrate 加 tasks.cs_findings 欄位（cs 初步定因，供分析當待驗證線索）', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='tasks' AND column_name='cs_findings'"
  );
  expect(rows.length).toBe(1);
});

// 意圖：舊專案的備註頁都寫著出廠樣板文字（非空），若不清空會被 getProjectNotes 誤判「有內容」而
// 把無意義樣板注入各關卡 prompt。migrate 一次性正規化：內容恰為舊樣板→清空；使用者已改的保留；可重跑。
describe('migrate 正規化舊備註樣板', () => {
  const OLD_TEMPLATE = '# 專案備註\n\n在此記錄專案注意事項、部署環境、聯絡窗口等人工維護的資訊。';

  async function makeNotes(name, content) {
    const { rows: [p] } = await dbModule.query(
      "INSERT INTO projects (name, odoo_version) VALUES ($1,'17.0') RETURNING id", [name]
    );
    await dbModule.query(
      "INSERT INTO wiki_pages (project_id, parent_id, node_type, slug, title, content) VALUES ($1,NULL,'notes','project-notes','專案備註',$2)",
      [p.id, content]
    );
    return p.id;
  }
  const notesOf = async (pid) => {
    const { rows: [r] } = await dbModule.query(
      "SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='project-notes'", [pid]
    );
    return r.content;
  };

  test('內容恰為舊樣板 → 清成空字串', async () => {
    const pid = await makeNotes('舊樣板專案', OLD_TEMPLATE);
    await dbModule.migrate();
    expect(await notesOf(pid)).toBe('');
  });

  test('使用者已改內容 → 保留不動', async () => {
    const pid = await makeNotes('已改備註專案', '# 專案備註\n\n部署到 8069 埠');
    await dbModule.migrate();
    expect(await notesOf(pid)).toBe('# 專案備註\n\n部署到 8069 埠');
  });

  test('重跑 idempotent（第二次不再變動）', async () => {
    const pid = await makeNotes('冪等專案', OLD_TEMPLATE);
    await dbModule.migrate();
    await dbModule.migrate();
    expect(await notesOf(pid)).toBe('');
  });
});

test('users 表含 per-user git 認證欄位', async () => {
  const { rows } = await dbModule.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='users'`
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toContain('github_pat_enc');
  expect(cols).toContain('github_login');
  expect(cols).toContain('git_name');
  expect(cols).toContain('git_email');
});

test('migrate 加 teams_settings 用量閘門三欄（含預設 true/90/95）', async () => {
  await dbModule.query('DELETE FROM teams_settings');
  await dbModule.query('INSERT INTO teams_settings (id) VALUES (1)');
  const { rows: [s] } = await dbModule.query(
    'SELECT usage_gate_enabled, usage_gate_5h_threshold, usage_gate_7d_threshold FROM teams_settings WHERE id=1'
  );
  expect(s.usage_gate_enabled).toBe(true);
  expect(s.usage_gate_5h_threshold).toBe(90);
  expect(s.usage_gate_7d_threshold).toBe(95);
});

test('odoo_envs 有 sso_secret 與 e2e_password 欄位', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='odoo_envs'"
  );
  const cols = rows.map(r => r.column_name);
  expect(cols).toEqual(expect.arrayContaining(['sso_secret', 'e2e_password']));
});

// 意圖：port 租約載體從 projects 移到 odoo_envs——併發借埠時要由 DB 擋下撞埠，
// 且 port 為 NULL（未租用）的列必須能有多筆，故必須是 partial unique index。
test('odoo_envs 有 last_active_at 欄位', async () => {
  const { rows } = await dbModule.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name='odoo_envs' AND column_name='last_active_at'"
  );
  expect(rows.length).toBe(1);
});

test('teams_settings 有 port_pool_min/max 欄位', async () => {
  const { rows } = await dbModule.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name='teams_settings' AND column_name IN ('port_pool_min','port_pool_max')"
  );
  expect(rows.length).toBe(2);
});

// 意圖：租約制下 projects.port 已無意義。舊的一次性回填若留著，每次啟動都會把 NULL 填回
// 8069 起的舊池埠段——值沒人讀，卻會讓人以為這欄位還有效，且與現行池範圍完全無關。
test('migrate 不再回填 projects.port', async () => {
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('no-backfill','17.0')");
  await dbModule.migrate();
  const { rows: [p] } = await dbModule.query("SELECT port FROM projects WHERE name='no-backfill'");
  expect(p.port).toBeNull();
});

// 意圖：專案備註（project-notes）是後來才加進 initProjectWiki 的保留節點，既有專案不會回頭補；
// 而 UI 的「新增頁面」端點不收 node_type（一律建成 'function'），使用者沒有任何途徑能自己建出
// 這一頁——症狀是「wiki 裡就是沒有專案備註」，而那頁本該被注入各開發關卡（實測鴻久 25 頁裡沒有，
// 備註功能等同不存在）。這裡驗補建：已有 wiki 的專案補上，未初始化的專案不碰。
test('migrate 補建 project-notes：已有 wiki 的專案補上，沒 wiki 的不動', async () => {
  const { rows: [withWiki] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('已初始化', '17.0') RETURNING id");
  const { rows: [noWiki] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('未初始化', '17.0') RETURNING id");
  await dbModule.query(
    "INSERT INTO wiki_pages (project_id, slug, title, node_type, content) VALUES ($1,'overview','總覽','overview','x')",
    [withWiki.id]);

  await dbModule.migrate();

  const { rows: added } = await dbModule.query(
    "SELECT node_type, title FROM wiki_pages WHERE project_id=$1 AND slug='project-notes'", [withWiki.id]);
  expect(added).toHaveLength(1);
  expect(added[0].node_type).toBe('notes');
  expect(added[0].title).toBe('專案備註');

  // 一頁都沒有＝還沒初始化，交給 initProjectWiki 建才有正確骨架，backfill 不該插手
  const { rows: skipped } = await dbModule.query(
    "SELECT 1 FROM wiki_pages WHERE project_id=$1", [noWiki.id]);
  expect(skipped).toHaveLength(0);
});

// 冪等：第二次 migrate 不得再插一筆（否則每次重啟都多一頁，且會撞 unique 約束）
test('migrate 補建 project-notes 冪等 — 跑第二次不重複插入', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('冪等測試', '17.0') RETURNING id");
  await dbModule.query(
    "INSERT INTO wiki_pages (project_id, slug, title, node_type, content) VALUES ($1,'overview','總覽','overview','x')",
    [p.id]);
  await dbModule.migrate();
  await dbModule.migrate();
  const { rows } = await dbModule.query(
    "SELECT id FROM wiki_pages WHERE project_id=$1 AND slug='project-notes'", [p.id]);
  expect(rows).toHaveLength(1);
});
