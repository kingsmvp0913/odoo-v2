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

// 意圖：users.odoo_settings 的密碼欄位原本明碼存放。只靠「寫入時加密」的話，既有資料要等使用者
// 哪天重存一次設定才會轉——實務上多數人不會，等於這個修正對現有帳號完全沒效果。所以 migrate()
// 要主動把既有明碼轉密文；而它每次啟動都會跑，重複執行必須不能把密文再包一層（rules/db-schema #44）。
describe('一次性遷移：odoo_settings 密碼欄位加密', () => {
  const APP_SECRET_BACKUP = process.env.APP_SECRET;
  beforeAll(() => { process.env.APP_SECRET = process.env.APP_SECRET || 'test-migration-secret'; });
  afterAll(() => {
    if (APP_SECRET_BACKUP === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = APP_SECRET_BACKUP;
  });

  test('既有明碼被轉成密文，且重跑 migrate 不會二次加密', async () => {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('x', 4);
    const { rows: [u] } = await dbModule.query(
      `INSERT INTO users (username, password_hash, display_name, odoo_settings)
       VALUES ('legacy-plain-pw', $1, 'Legacy', $2) RETURNING id`,
      [hash, JSON.stringify({ odoo_url: 'https://erp.test', odoo_username: 'alice', odoo_password: 'plain-pw' })]
    );

    await dbModule.migrate();
    const read = async () => {
      const { rows } = await dbModule.query('SELECT odoo_settings FROM users WHERE id = $1', [u.id]);
      return typeof rows[0].odoo_settings === 'string' ? JSON.parse(rows[0].odoo_settings) : rows[0].odoo_settings;
    };
    const afterFirst = await read();
    expect(afterFirst.odoo_password).not.toBe('plain-pw');          // 已轉密文
    expect(afterFirst.odoo_username).toBe('alice');                 // 非祕密欄位不動
    const { decryptSettings } = require('../lib/user-settings');
    expect(decryptSettings(afterFirst).odoo_password).toBe('plain-pw');

    // 冪等：再跑一次不得改變密文（二次加密的話解一次只會解回上一層密文，同步會靜默拿密文去登入）
    await dbModule.migrate();
    const afterSecond = await read();
    expect(afterSecond.odoo_password).toBe(afterFirst.odoo_password);
    expect(decryptSettings(afterSecond).odoo_password).toBe('plain-pw');
  });
});

// 意圖：Phase 7 把健檢提案改成預設核准，通道守門已補齊（DENY 四支＋基線比較＋fix-review）。
// 新建列要直接拿到 approved（見 ALTER COLUMN SET DEFAULT），既有卡在 pending 的提案要一次性
// 轉正——但只轉 kind='proposal'：agent（例行診斷）／signal（證據不足的候選）本來就不進修正
// 通道，一起轉會製造「畫面上多出一堆從沒被人看過的『已核准』」的雜訊。
describe('一次性遷移：health_check_findings.status 改預設核准', () => {
  test('新建列（未指定 status）預設拿到 approved', async () => {
    const { rows: [run] } = await dbModule.query("INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id");
    const { rows: [f] } = await dbModule.query(
      `INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity, kind)
       VALUES ($1,'__audit__','新提案','medium','proposal') RETURNING status`, [run.id]);
    expect(f.status).toBe('approved');
  });

  // 這個轉換只能真的發生一次，故需要獨立的 pg-mem 連線：外層 dbModule 的連線在 beforeAll 就已經
  // 跑過 migrate()（那時沒有 pending 資料），若沿用同一條連線，這裡插入的 pending 資料會遇到旗標
  // 已被消耗、永遠轉不了正。獨立連線讓「插入舊資料」發生在該連線的第一次 migrate() 之前，才能正確
  // 驗證「第一次轉正」這個語意。
  //
  // 表本身也是靠 migrate() 建立，第一次呼叫必然會順便消耗旗標（此時無資料，UPDATE 影響 0 列）——
  // 故第一次呼叫後手動刪掉 migration_flags 那一列，模擬「這個轉換的 key 尚未被任何一次 migrate()
  // 消耗過」的資料庫狀態，才能在插入舊資料後驗證「真正的第一次轉正」會不會發生。
  test('既有 pending 的 proposal 被一次性轉成 approved；agent／signal 的 pending 不受影響', async () => {
    const { newDb } = require('pg-mem');
    const freshDb = newDb();
    const { Pool } = freshDb.adapters.createPg();
    const freshPool = new Pool();
    dbModule._setPoolForTesting(freshPool);
    try {
      await dbModule.migrate(); // 只為了建表；順帶消耗旗標，下面立刻復原
      await dbModule.query(
        "DELETE FROM migration_flags WHERE key='health_check_findings_pending_to_approved'"
      );

      const { rows: [run] } = await dbModule.query("INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id");
      const insertPending = async (kind) => {
        const { rows: [f] } = await dbModule.query(
          `INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity, kind, status)
           VALUES ($1,'__audit__','舊資料',$2,$3,'pending') RETURNING id`,
          [run.id, kind === 'proposal' ? 'medium' : 'ok', kind]
        );
        return f.id;
      };
      const proposalId = await insertPending('proposal');
      const agentId = await insertPending('agent');
      const signalId = await insertPending('signal');

      await dbModule.migrate(); // 這條連線的第一次一次性遷移

      // 不用 WHERE id = ANY($1)：pg-mem 對 SERIAL PK 的 int 陣列型別調解會查不到既有列
      // （testing.md #12），逐筆查詢繞開這個限制。
      const statusOf = async (id) => {
        const { rows: [r] } = await dbModule.query('SELECT status FROM health_check_findings WHERE id = $1', [id]);
        return r.status;
      };
      expect(await statusOf(proposalId)).toBe('approved');   // 只有 proposal 被轉正
      expect(await statusOf(agentId)).toBe('pending');       // agent 不動
      expect(await statusOf(signalId)).toBe('pending');      // signal 不動
    } finally {
      dbModule._setPoolForTesting(null);
    }
  });

  // 缺陷回歸：nightly-fix 的機器退場（連續失敗 3 次，見 retireToHuman）會把提案 status 改回
  // 'pending' 且 verdict_note 帶「自動退場：」前綴。若一次性轉正只靠資料狀態判斷冪等，下次
  // server 重啟時這條退場的提案會被誤判成「還沒轉正」而翻回 approved——等於退場機制被繞過，
  // 提案每晚重新變回候選、無限重燒 NIGHTLY_FIX_MAX 額度。這裡驗證：第二次以後的 migrate()，
  // 即使 DB 裡出現新的 status='pending' AND kind='proposal' 列，也絕對不能再被轉正。
  test('一次性遷移只跑一次：機器退場產生的新 pending proposal 在後續 migrate() 不會被翻回 approved', async () => {
    const { newDb } = require('pg-mem');
    const freshDb = newDb();
    const { Pool } = freshDb.adapters.createPg();
    const freshPool = new Pool();
    dbModule._setPoolForTesting(freshPool);
    try {
      await dbModule.migrate(); // 第一次：此時無資料，轉換旗標在此消耗

      const { rows: [run] } = await dbModule.query("INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id");
      const { rows: [f] } = await dbModule.query(
        `INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity, kind, status)
         VALUES ($1,'__audit__','曾核准後又退場','medium','proposal','pending') RETURNING id`,
        [run.id]
      );
      // 模擬 retireToHuman：verdict_note 帶機器退場前綴、decided_by/decided_at 清空
      await dbModule.query(
        "UPDATE health_check_findings SET verdict_note='自動退場：連續 3 次修復失敗' WHERE id=$1",
        [f.id]
      );

      await dbModule.migrate(); // 模擬下次 server 重啟（第二次以後）

      const { rows: [after] } = await dbModule.query(
        'SELECT status FROM health_check_findings WHERE id=$1', [f.id]
      );
      expect(after.status).toBe('pending'); // 必須仍是 pending，不得被翻回 approved
    } finally {
      dbModule._setPoolForTesting(null);
    }
  });
});

// 被重啟砍掉的批次要在開機時收掉。健檢與夜間批次都靠 finally 把自己那一列從 running 收成 done，
// 而重啟（人工 docker restart，或別條修正合併後的自動重啟）會連 node 行程一起帶走那個 finally。
// 留下的假 running 不只是少一列紀錄：健檢紀錄頁會永遠顯示「執行中」，而夜間批次判「上一批是不是
// 還在跑」也會被它騙住。實測 2026-09-05：run #21 就是這樣被留下來的。
describe('開機收掉被重啟中斷的執行', () => {
  // ⚠ 自備 pool：本檔上一個 describe 在 finally 裡把 pool 設回 null，沿用會拿到
  // 「no PostgreSQL user name specified in startup packet」。
  beforeAll(async () => {
    const freshDb = newDb();
    const { Pool } = freshDb.adapters.createPg();
    dbModule._setPoolForTesting(new Pool());
    await dbModule.migrate();
  });
  afterAll(() => { dbModule._setPoolForTesting(null); });

  test('停在 running 的 health_check_runs → 標 error 並寫明原因，不留成假的「執行中」', async () => {
    const { rows: [run] } = await dbModule.query(
      "INSERT INTO health_check_runs (status, cadence) VALUES ('running','nightly-fix') RETURNING id");
    const { rows: [done] } = await dbModule.query(
      "INSERT INTO health_check_runs (status, cadence) VALUES ('done','daily') RETURNING id");

    await dbModule.migrate();   // ＝下一次開機

    const { rows: [after] } = await dbModule.query(
      'SELECT status, finished_at, error FROM health_check_runs WHERE id=$1', [run.id]);
    // 標 error 不是 done：它確實沒跑完，記成 done 會讓那一晚的空結果看起來像「本來就沒事做」
    expect(after.status).toBe('error');
    expect(after.finished_at).not.toBeNull();
    expect(after.error).toContain('中斷');
    // 對照組：已經收掉的不准被動到，否則每次開機都會把歷史紀錄改寫一遍
    const { rows: [untouched] } = await dbModule.query(
      'SELECT status, error FROM health_check_runs WHERE id=$1', [done.id]);
    expect(untouched.status).toBe('done');
    expect(untouched.error).toBeNull();
  });

  test('停在 running 的 finding_fixes → 標 failed（已經沒有行程在推它了）', async () => {
    const { rows: [run] } = await dbModule.query(
      "INSERT INTO health_check_runs (status) VALUES ('done') RETURNING id");
    const { rows: [f] } = await dbModule.query(
      `INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity, kind, status)
       VALUES ($1,'__audit__','診斷','medium','proposal','approved') RETURNING id`, [run.id]);
    const { rows: [fx] } = await dbModule.query(
      "INSERT INTO finding_fixes (finding_id, status) VALUES ($1,'running') RETURNING id", [f.id]);
    const { rows: [adopted] } = await dbModule.query(
      "INSERT INTO finding_fixes (finding_id, status) VALUES ($1,'adopted') RETURNING id", [f.id]);

    await dbModule.migrate();

    const { rows: [after] } = await dbModule.query(
      'SELECT status, reject_reason FROM finding_fixes WHERE id=$1', [fx.id]);
    expect(after.status).toBe('failed');
    expect(after.reject_reason).toContain('中斷');
    // ⚠ adopted 不可被掃掉：那是「改好了只差合併」，下一批的 resumeAdoptedFixes 要靠它撿回來。
    // 一起收掉的話，分支上那顆審過的 commit 就再也沒人撿了。
    const { rows: [keep] } = await dbModule.query(
      'SELECT status FROM finding_fixes WHERE id=$1', [adopted.id]);
    expect(keep.status).toBe('adopted');
  });
});
