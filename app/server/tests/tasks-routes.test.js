const request = require('supertest');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-tasks-secret';

let app, dbModule, adminToken, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { createApp } = require('../index');
  app = createApp();

  const res = await request(app).post('/api/auth/setup').send({
    username: 'admin', password: 'password123', display_name: '管理員'
  });
  adminToken = res.body.token;

  // Get userId
  const me = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  userId = me.body.id;

  // Insert test tasks directly
  await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1, 'task_odoo_1', 'odoo', 'Odoo Task 1', 'content 1', 'new'),
            ($1, 'task_odoo_2', 'odoo', 'Odoo Task 2', 'content 2', 'confirm_pending'),
            ($1, 'task_service_1', 'service', 'Service Task 1', 'content 3', 'analysis_running')`,
    [userId]
  );
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

test('GET /api/tasks → 401 without token', async () => {
  const res = await request(app).get('/api/tasks');
  expect(res.status).toBe(401);
});

test('GET /api/tasks → returns all 3 tasks', async () => {
  const res = await request(app).get('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
  expect(res.body.length).toBe(3);
});

test('GET /api/tasks?needs_action=true → returns only confirm_pending task', async () => {
  const res = await request(app).get('/api/tasks?needs_action=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBe(1);
  expect(res.body[0].status).toBe('confirm_pending');
});

test('GET /api/tasks?source=service → returns only service task', async () => {
  const res = await request(app).get('/api/tasks?source=service')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.length).toBe(1);
  expect(res.body[0].source).toBe('service');
});

// 健檢 U2：全歸零會讓「繼續」一鍵繳械所有重試上限（任務 52 無限循環的直接機制）。
// 新意圖：只歸零與續跑關卡對應的那一顆，其餘關卡的累計保留。
test('POST /api/tasks/:id/resolve-blocker 無 resume_status → 回 new 且計數器全數保留', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, qa_retry_count, deploy_retry_count, pw_retry_count, blocker_content)
     VALUES ($1,'task_resolve','odoo','R','stopped',3,2,1,'boom') RETURNING id`,
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/resolve-blocker`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ resolution: '已排除' });
  expect(res.status).toBe(200);
  const { rows: [after] } = await dbModule.query(
    'SELECT status, qa_retry_count, deploy_retry_count, pw_retry_count FROM tasks WHERE id=$1', [t.id]
  );
  expect(after.status).toBe('new');
  expect(after.qa_retry_count).toBe(3);
  expect(after.deploy_retry_count).toBe(2);
  expect(after.pw_retry_count).toBe(1);
});

test('resolve-blocker 從 deploy_testing 續跑 → 只歸零 deploy 計數器，qa/pw 累計保留', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, resume_status, qa_retry_count, deploy_retry_count, pw_retry_count, blocker_content)
     VALUES ($1,'task_resolve_dp','odoo','R','stopped','deploy_testing',2,3,1,'boom') RETURNING id`,
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/resolve-blocker`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ resolution: '已修好測試環境' });
  expect(res.status).toBe(200);
  const { rows: [after] } = await dbModule.query(
    'SELECT status, qa_retry_count, deploy_retry_count, pw_retry_count FROM tasks WHERE id=$1', [t.id]
  );
  expect(after.status).toBe('deploy_testing');
  expect(after.deploy_retry_count).toBe(0); // 使用者聲稱已處理，此關卡重新取得完整重試額度
  expect(after.qa_retry_count).toBe(2);     // 其他關卡的歷史不因此消失
  expect(after.pw_retry_count).toBe(1);
});

test('resolve-blocker 有 resume_status → 回到中斷的那一關（而非 new）', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, resume_status, blocker_content)
     VALUES ($1,'task_resume','odoo','R','stopped','coding_running','boom') RETURNING id`,
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/resolve-blocker`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ resolution: '繼續' });
  expect(res.status).toBe(200);
  const { rows: [after] } = await dbModule.query(
    'SELECT status, resume_status, blocker_content FROM tasks WHERE id=$1', [t.id]
  );
  expect(after.status).toBe('coding_running');  // 回到中斷處，非 new
  expect(after.resume_status).toBeNull();        // 用完清除
  expect(after.blocker_content).toBeNull();
});

test('GET /api/tasks/:id → returns task detail with logs array', async () => {
  const listRes = await request(app).get('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`);
  const taskId = listRes.body[0].id;

  const res = await request(app).get(`/api/tasks/${taskId}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('task');
  expect(res.body).toHaveProperty('logs');
  expect(Array.isArray(res.body.logs)).toBe(true);
});

test('GET /api/tasks/:id → 404 for non-existent task', async () => {
  const res = await request(app).get('/api/tasks/999999')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
});

test('POST /api/tasks/:id/answer → 400 for non-confirm_pending task', async () => {
  const listRes = await request(app).get('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`);
  const task = listRes.body.find(t => t.status === 'new');

  const res = await request(app).post(`/api/tasks/${task.id}/answer`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ user_answer: 'my answer' });
  expect(res.status).toBe(400);
});

test('POST /api/tasks/:id/answer → updates status to confirm_answered', async () => {
  const listRes = await request(app).get('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`);
  const task = listRes.body.find(t => t.status === 'confirm_pending');

  const res = await request(app).post(`/api/tasks/${task.id}/answer`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ user_answer: 'my answer' });
  expect(res.status).toBe(200);

  // Verify status updated
  const detail = await request(app).get(`/api/tasks/${task.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(detail.body.task.status).toBe('confirm_answered');
});

// 意圖：手動新增的任務要以 'new' 進入 pipeline（由 triage 接手），source 標記為 manual
test('POST /api/tasks → 建立手動任務，status=new / source=manual', async () => {
  const res = await request(app).post('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title: '手動任務', original_text: '需求描述' });
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('new');
  expect(res.body.source).toBe('manual');
  expect(res.body.task_id).toMatch(/^manual_/);

  // 確實寫入且可被列出
  const detail = await request(app).get(`/api/tasks/${res.body.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(detail.body.task.title).toBe('手動任務');
  expect(detail.body.task.original_text).toBe('需求描述');
});

test('POST /api/tasks → 缺標題回 400', async () => {
  const res = await request(app).post('/api/tasks')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ original_text: '沒有標題' });
  expect(res.status).toBe(400);
});

test('POST /api/tasks → 401 無 token', async () => {
  const res = await request(app).post('/api/tasks').send({ title: 'x' });
  expect(res.status).toBe(401);
});

// 意圖：任務進 pipeline 前（new）可修正需求內容；一旦分析/開發已依原內容展開就不再允許改，避免內容與已產出的分析/程式碼脫節
test('PUT /api/tasks/:id → status=new 時可修改 original_text', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_edit_new','odoo','E','舊內容','new') RETURNING id`,
    [userId]
  );
  const res = await request(app).put(`/api/tasks/${t.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ original_text: '新內容' });
  expect(res.status).toBe(200);

  const detail = await request(app).get(`/api/tasks/${t.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(detail.body.task.original_text).toBe('新內容');
});

test('PUT /api/tasks/:id → 非 new 狀態回 400，內容不變', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_edit_locked','odoo','E','舊內容','coding_running') RETURNING id`,
    [userId]
  );
  const res = await request(app).put(`/api/tasks/${t.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ original_text: '想改但不行' });
  expect(res.status).toBe(400);

  const detail = await request(app).get(`/api/tasks/${t.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(detail.body.task.original_text).toBe('舊內容');
});

test('PUT /api/tasks/:id → 缺 original_text 回 400', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_edit_empty','odoo','E','舊內容','new') RETURNING id`,
    [userId]
  );
  const res = await request(app).put(`/api/tasks/${t.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({});
  expect(res.status).toBe(400);
});

test('GET /api/tasks/:id/messages → 新到舊排序', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_msg_list','odoo','M','base','new') RETURNING id`,
    [userId]
  );
  await dbModule.query(
    `INSERT INTO task_messages (task_id, source, external_id, content, occurred_at) VALUES
     ($1,'sync','1','舊的','2026-07-01 09:00:00'),
     ($1,'sync','2','新的','2026-07-05 09:00:00')`,
    [t.id]
  );

  const res = await request(app).get(`/api/tasks/${t.id}/messages`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.map(m => m.content)).toEqual(['新的', '舊的']);
});

test('POST /api/tasks/:id/messages → 缺 content 回 400', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_msg_empty','odoo','M','base','coding_running') RETURNING id`,
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/messages`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({});
  expect(res.status).toBe(400);
});

test('POST /api/tasks/:id/messages → 任何狀態都能新增，落地為 source=manual', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_msg_add','odoo','M','base','coding_running') RETURNING id`,
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/messages`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ content: '補充說明' });
  expect(res.status).toBe(200);
  expect(res.body.source).toBe('manual');
  expect(res.body.content).toBe('補充說明');
  expect(res.body.synced_to_odoo).toBe(false);
});

test('POST /api/tasks/:id/messages → writeback_odoo_notes=false 時不觸發任何對外呼叫', async () => {
  const mockFetch = jest.fn();
  const originalFetch = global.fetch;
  global.fetch = mockFetch;
  try {
    await dbModule.query("UPDATE teams_settings SET writeback_odoo_notes = false WHERE id = 1");
    const { rows: [t] } = await dbModule.query(
      `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
       VALUES ($1,'task_odoo_5001','odoo','M','base','coding_running') RETURNING id`,
      [userId]
    );
    const res = await request(app).post(`/api/tasks/${t.id}/messages`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ content: '不該回寫' });
    expect(res.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  } finally { global.fetch = originalFetch; }
});

test('POST /api/tasks/:id/messages → writeback_odoo_notes=true 且回寫成功，external_id 更新避免下次重複拉回', async () => {
  const mockFetch = jest.fn();
  const originalFetch = global.fetch;
  global.fetch = mockFetch;
  try {
    await dbModule.query(
      `INSERT INTO teams_settings (id, odoo_url, odoo_db, writeback_odoo_notes)
       VALUES (1, 'https://odoo.example.com', 'mydb', true)
       ON CONFLICT (id) DO UPDATE SET odoo_url = $1, odoo_db = $2, writeback_odoo_notes = $3`,
      ['https://odoo.example.com', 'mydb', true]
    );
    await dbModule.query(
      'UPDATE users SET odoo_settings = $2 WHERE id = $1',
      [userId, JSON.stringify({ odoo_username: 'admin', odoo_password: 'pass', odoo_user_id: 1 })]
    );
    const { rows: [t] } = await dbModule.query(
      `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
       VALUES ($1,'task_odoo_5002','odoo','M','base','coding_running') RETURNING id`,
      [userId]
    );

    mockFetch
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        headers: { get: (h) => h === 'set-cookie' ? 'session_id=abc' : null },
        json: () => Promise.resolve({ jsonrpc: '2.0', result: { uid: 1 } })
      }))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve({ jsonrpc: '2.0', result: 88888 })
      }));

    const res = await request(app).post(`/api/tasks/${t.id}/messages`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ content: '回寫這則' });
    expect(res.status).toBe(200);
    expect(res.body.synced_to_odoo).toBe(true);

    const { rows: [saved] } = await dbModule.query(
      'SELECT external_id, synced_to_odoo FROM task_messages WHERE id = $1', [res.body.id]
    );
    expect(saved.external_id).toBe('88888');
    expect(saved.synced_to_odoo).toBe(true);
  } finally {
    global.fetch = originalFetch;
    await dbModule.query("UPDATE teams_settings SET writeback_odoo_notes = false WHERE id = 1");
  }
});

test('POST /api/tasks/:id/messages → writeback:false 時即使全域開關為真也不觸發回寫', async () => {
  const mockFetch = jest.fn();
  const originalFetch = global.fetch;
  global.fetch = mockFetch;
  try {
    await dbModule.query(
      `INSERT INTO teams_settings (id, odoo_url, odoo_db, writeback_odoo_notes)
       VALUES (1, 'https://odoo.example.com', 'mydb', true)
       ON CONFLICT (id) DO UPDATE SET odoo_url = $1, odoo_db = $2, writeback_odoo_notes = $3`,
      ['https://odoo.example.com', 'mydb', true]
    );
    await dbModule.query(
      'UPDATE users SET odoo_settings = $2 WHERE id = $1',
      [userId, JSON.stringify({ odoo_username: 'admin', odoo_password: 'pass', odoo_user_id: 1 })]
    );
    const { rows: [t] } = await dbModule.query(
      `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
       VALUES ($1,'task_odoo_5004','odoo','M','base','coding_running') RETURNING id`,
      [userId]
    );

    const res = await request(app).post(`/api/tasks/${t.id}/messages`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ content: '這則不要回寫', writeback: false });
    expect(res.status).toBe(200);
    expect(res.body.synced_to_odoo).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  } finally {
    global.fetch = originalFetch;
    await dbModule.query("UPDATE teams_settings SET writeback_odoo_notes = false WHERE id = 1");
  }
});

test('POST /api/tasks/:id/messages → writeback 失敗時本地留言仍成功建立', async () => {
  const mockFetch = jest.fn();
  const originalFetch = global.fetch;
  global.fetch = mockFetch;
  try {
    await dbModule.query(
      `INSERT INTO teams_settings (id, odoo_url, odoo_db, writeback_odoo_notes)
       VALUES (1, 'https://odoo.example.com', 'mydb', true)
       ON CONFLICT (id) DO UPDATE SET odoo_url = $1, odoo_db = $2, writeback_odoo_notes = $3`,
      ['https://odoo.example.com', 'mydb', true]
    );
    await dbModule.query(
      'UPDATE users SET odoo_settings = $2 WHERE id = $1',
      [userId, JSON.stringify({ odoo_username: 'admin', odoo_password: 'pass', odoo_user_id: 1 })]
    );
    const { rows: [t] } = await dbModule.query(
      `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
       VALUES ($1,'task_odoo_5003','odoo','M','base','coding_running') RETURNING id`,
      [userId]
    );

    mockFetch.mockImplementationOnce(() => Promise.reject(new Error('network down')));

    const res = await request(app).post(`/api/tasks/${t.id}/messages`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ content: '網路壞掉也要存住' });
    expect(res.status).toBe(200);
    expect(res.body.synced_to_odoo).toBe(false);

    const { rows: [saved] } = await dbModule.query(
      'SELECT content FROM task_messages WHERE id = $1', [res.body.id]
    );
    expect(saved.content).toBe('網路壞掉也要存住');
  } finally {
    global.fetch = originalFetch;
    await dbModule.query("UPDATE teams_settings SET writeback_odoo_notes = false WHERE id = 1");
  }
});

// 意圖：task_messages 對 tasks 有 FK 且無 ON DELETE CASCADE（比照 task_logs/task_events）；
// 刪除任務前若沒先清 task_messages，會撞 FK constraint 而 500（實際環境曾發生）
test('DELETE /api/tasks/:id → 任務有 task_messages 時仍可成功刪除，一併清掉', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_del_with_msgs','odoo','D','base','new') RETURNING id`,
    [userId]
  );
  await dbModule.query(
    `INSERT INTO task_messages (task_id, source, content, occurred_at)
     VALUES ($1, 'manual', '留言', NOW())`,
    [t.id]
  );

  const res = await request(app).delete(`/api/tasks/${t.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);

  const { rows: msgs } = await dbModule.query('SELECT * FROM task_messages WHERE task_id = $1', [t.id]);
  expect(msgs.length).toBe(0);
});

// 註：POST /api/tasks/batch/delete 用了同樣的 `DELETE FROM task_messages WHERE task_id = ANY($1::int[])`
// 修法（見 tasks-routes.js），但這條路徑（以及既有的 batch/pause、batch/archive、project 刪除 cascade）
// 全都用 `id = ANY($1::int[])` 查詢既有任務——這個寫法在目前 pg-mem 版本下對 SERIAL 欄位有 bug
// （`WHERE id = ANY($1::int[])` 對已存在的整數 id 永遠查不到列，純測試環境限制，不影響真實 Postgres；
// 已用最小重現腳本驗證：即使不帶參數的字面量 SQL `ANY(ARRAY[1]::int[])` 也一樣查不到，
// 換成 `id::text = ANY($1::text[])` 才正常）。這條路徑因此原本就沒有任何測試覆蓋，本次修復沿用
// 同一個既有、已在正式環境跑過的 ANY(int[]) pattern，不因測試工具限制改寫正式程式碼。
