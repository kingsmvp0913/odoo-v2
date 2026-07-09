const { newDb } = require('pg-mem');

let dbModule, syncModule;
let userId;

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeFetchResponse(body, cookieHeader = '') {
  return Promise.resolve({
    ok: true,
    headers: { get: (h) => h === 'set-cookie' ? cookieHeader : null },
    json: () => Promise.resolve(body)
  });
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  // Insert test user with odoo_settings
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password123', 4);
  const { rows } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, role, odoo_settings, sync_interval)
     VALUES ('testuser', $1, '測試員', 'user', $2, 15) RETURNING id`,
    [hash, JSON.stringify({
      odoo_url: 'https://odoo.example.com',
      odoo_db: 'mydb',
      odoo_username: 'admin',
      odoo_password: 'pass',
      odoo_user_id: 1,
      service_url: 'https://service.example.com',
      service_db: 'servicedb',
      service_username: 'svc',
      service_password: 'svcpass',
      service_user_id: 2
    })]
  );
  userId = rows[0].id;

  syncModule = require('../pipeline/sync');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(() => { mockFetch.mockReset(); });

function setupOdooMocks({ tasks = [], messages = [] } = {}) {
  mockFetch
    // auth
    .mockImplementationOnce(() => makeFetchResponse(
      { jsonrpc: '2.0', result: { uid: 1 } }, 'session_id=abc123'
    ))
    // task search_read
    .mockImplementationOnce(() => makeFetchResponse({
      jsonrpc: '2.0',
      result: tasks
    }));
  // message search_read for each task
  tasks.forEach(() => {
    mockFetch.mockImplementationOnce(() => makeFetchResponse({
      jsonrpc: '2.0',
      result: messages
    }));
  });
}

function setupServiceMocks({ tasks = [], messages = [] } = {}) {
  mockFetch
    .mockImplementationOnce(() => makeFetchResponse(
      { jsonrpc: '2.0', result: { uid: 2 } }, 'session_id=svc123'
    ))
    .mockImplementationOnce(() => makeFetchResponse({
      jsonrpc: '2.0',
      result: tasks
    }));
  tasks.forEach(() => {
    mockFetch.mockImplementationOnce(() => makeFetchResponse({
      jsonrpc: '2.0',
      result: messages
    }));
  });
}

test('syncUser with no tasks → returns { added: 0 } for both sources', async () => {
  setupOdooMocks({ tasks: [] });
  setupServiceMocks({ tasks: [] });

  const result = await syncModule.syncUser(userId);
  expect(result.odoo.added).toBe(0);
  expect(result.service.added).toBe(0);
});

test('syncUser adds new Odoo task to DB', async () => {
  setupOdooMocks({
    tasks: [{
      id: 9001,
      name: 'Test Task A',
      project_id: [1, 'My Project'],
      stage_id: [2, 'In Progress'],
      description: '<p>Task description</p>'
    }],
    messages: [{ id: 501, date: '2026-06-25 10:00:00', body: '<p>First comment</p>' }]
  });
  setupServiceMocks({ tasks: [] });

  const result = await syncModule.syncUser(userId);
  expect(result.odoo.added).toBe(1);

  const { rows } = await dbModule.query(
    "SELECT * FROM tasks WHERE task_id = 'task_odoo_9001' AND user_id = $1",
    [userId]
  );
  expect(rows.length).toBe(1);
  expect(rows[0].title).toBe('Test Task A');
  expect(rows[0].source).toBe('odoo');
  expect(rows[0].status).toBe('new');
  expect(rows[0].original_text).toBe('Task description');
  expect(rows[0].stage_label).toBe('In Progress');

  const { rows: msgs } = await dbModule.query(
    'SELECT source, external_id, content FROM task_messages WHERE task_id = $1 ORDER BY occurred_at',
    [rows[0].id]
  );
  expect(msgs.length).toBe(1);
  expect(msgs[0].source).toBe('sync');
  expect(msgs[0].content).toBe('First comment');
});

test('syncUser skips duplicate tasks (ON CONFLICT DO NOTHING)', async () => {
  setupOdooMocks({
    tasks: [{
      id: 9001,
      name: 'Test Task A (duplicate)',
      project_id: [1, 'My Project'],
      stage_id: [2, 'In Progress'],
      description: '<p>Dup</p>'
    }],
    messages: []
  });
  setupServiceMocks({ tasks: [] });

  const result = await syncModule.syncUser(userId);
  expect(result.odoo.added).toBe(0); // already exists
});

test('syncUser adds new Service task to DB', async () => {
  setupOdooMocks({ tasks: [] });
  setupServiceMocks({
    tasks: [{
      id: 3001,
      name_seq: 'SQ-3001',
      subject: '系統問題回報',
      system: [1, 'CRM'],
      respondent: [5, '王小明'],
      state: 'open',
      question_description: '<p>詳細說明</p>',
      classification: [2, '技術問題'],
      file: []
    }],
    messages: [{ id: 701, date: '2026-06-25 11:00:00', body: '<p>補充說明</p>', attachment_ids: [] }]
  });

  const result = await syncModule.syncUser(userId);
  expect(result.service.added).toBe(1);

  const { rows } = await dbModule.query(
    "SELECT * FROM tasks WHERE task_id = 'task_service_3001' AND user_id = $1",
    [userId]
  );
  expect(rows.length).toBe(1);
  expect(rows[0].title).toContain('SQ-3001');
  expect(rows[0].source).toBe('service');
  expect(rows[0].original_text).toBe('詳細說明');
  expect(rows[0].stage_label).toBe('處理中');
  expect(rows[0].classification_label).toBe('技術問題');
});

test('syncUser skips when odoo_url not configured', async () => {
  const { rows: users } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('noconfig', 'x', 'No Config', 'user') RETURNING id"
  );
  const noConfigUserId = users[0].id;

  const result = await syncModule.syncUser(noConfigUserId);
  expect(result.odoo.added).toBe(0);
  expect(result.service.added).toBe(0);
  expect(mockFetch).not.toHaveBeenCalled();
});

// 一個專案可綁定多個來源名稱（odoo_project_name 一行一個），命中任一即自動綁定
test('syncUser auto-binds Odoo task when its project name matches one of multiple mapped names', async () => {
  await dbModule.query(
    "INSERT INTO projects (name, odoo_version, odoo_project_name) VALUES ('Multi 專案', '17.0', $1)",
    ['別的專案\nMy Project\n第三個']
  );
  setupOdooMocks({
    tasks: [{
      id: 9100,
      name: 'Binding Task',
      project_id: [7, 'My Project'],
      stage_id: [2, 'In Progress'],
      description: '<p>x</p>'
    }],
    messages: []
  });
  setupServiceMocks({ tasks: [] });

  await syncModule.syncUser(userId);

  const { rows } = await dbModule.query(
    "SELECT p.name AS pname FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.task_id = 'task_odoo_9100'"
  );
  expect(rows.length).toBe(1);
  expect(rows[0].pname).toBe('Multi 專案');
});

test('assembleTaskContext() 無 task_messages 時，組回 original_text + 無訊息內容 fallback', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_ctx_empty','odoo','C','---id---\n1\n---title---\nC','new') RETURNING id`,
    [userId]
  );
  const ctx = await syncModule.assembleTaskContext(t.id);
  expect(ctx).toContain('---id---\n1');
  expect(ctx).toContain('---message---\n無訊息內容');
});

test('assembleTaskContext() 依時間正序組回多筆 task_messages', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_ctx_multi','odoo','C','base','new') RETURNING id`,
    [userId]
  );
  await dbModule.query(
    `INSERT INTO task_messages (task_id, source, external_id, content, occurred_at) VALUES
     ($1,'sync','2','第二則','2026-07-02 10:00:00'),
     ($1,'sync','1','第一則','2026-07-01 10:00:00')`,
    [t.id]
  );
  const ctx = await syncModule.assembleTaskContext(t.id);
  const firstIdx = ctx.indexOf('第一則');
  const secondIdx = ctx.indexOf('第二則');
  expect(firstIdx).toBeGreaterThan(-1);
  expect(secondIdx).toBeGreaterThan(firstIdx); // 時間正序：舊的在前
});

test('syncUser 既有任務（非 done/hidden）再次同步 → 只新增來源新增的那一則訊息', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_odoo_9200','odoo','Existing','base','confirm_pending') RETURNING id`,
    [userId]
  );
  await dbModule.query(
    `INSERT INTO task_messages (task_id, source, external_id, content, occurred_at)
     VALUES ($1,'sync','1','舊訊息','2026-06-20 09:00:00')`,
    [t.id]
  );

  setupOdooMocks({
    tasks: [{
      id: 9200,
      name: 'Existing',
      project_id: [1, 'My Project'],
      stage_id: [2, 'In Progress'],
      description: '<p>desc</p>'
    }],
    messages: [
      { id: 1, date: '2026-06-20 09:00:00', body: '<p>舊訊息</p>' },
      { id: 2, date: '2026-06-26 09:00:00', body: '<p>新訊息</p>' }
    ]
  });
  setupServiceMocks({ tasks: [] });

  await syncModule.syncUser(userId);

  const { rows: msgs } = await dbModule.query(
    'SELECT external_id FROM task_messages WHERE task_id = $1 ORDER BY occurred_at', [t.id]
  );
  expect(msgs.map(m => m.external_id)).toEqual(['1', '2']);
});

test('syncUser 既有任務 status=done → 再次同步不新增任何 task_messages', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_odoo_9201','odoo','Done Task','base','done') RETURNING id`,
    [userId]
  );

  setupOdooMocks({
    tasks: [{
      id: 9201,
      name: 'Done Task',
      project_id: [1, 'My Project'],
      stage_id: [2, 'In Progress'],
      description: '<p>desc</p>'
    }],
    messages: [{ id: 99, date: '2026-06-26 09:00:00', body: '<p>不該進來</p>' }]
  });
  setupServiceMocks({ tasks: [] });

  await syncModule.syncUser(userId);

  const { rows: msgs } = await dbModule.query('SELECT * FROM task_messages WHERE task_id = $1', [t.id]);
  expect(msgs.length).toBe(0);
});

test('syncUser 既有任務 is_hidden=true → 再次同步不新增任何 task_messages', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, is_hidden)
     VALUES ($1,'task_odoo_9202','odoo','Hidden Task','base','confirm_pending', true) RETURNING id`,
    [userId]
  );

  setupOdooMocks({
    tasks: [{
      id: 9202,
      name: 'Hidden Task',
      project_id: [1, 'My Project'],
      stage_id: [2, 'In Progress'],
      description: '<p>desc</p>'
    }],
    messages: [{ id: 99, date: '2026-06-26 09:00:00', body: '<p>不該進來</p>' }]
  });
  setupServiceMocks({ tasks: [] });

  await syncModule.syncUser(userId);

  const { rows: msgs } = await dbModule.query('SELECT * FROM task_messages WHERE task_id = $1', [t.id]);
  expect(msgs.length).toBe(0);
});

// 意圖：Odoo 回傳的 mail.message.date 是 UTC 的 naive 字串（無時區標記）。必須明確標成 UTC
// 才能存進 occurred_at（TIMESTAMPTZ），否則正式環境的連線 session timezone 非 UTC 時
// （曾發生：Asia/Taipei，UTC+8）會把絕對時間點解讀錯，存進去的時間差 8 小時。
// pg-mem 對 naive 字串本身就一律當 UTC 解讀，不會重現「連線 session 非 UTC」這個情境，
// 所以這裡驗證的是「無論怎麼寫入，讀回來一定是 Odoo 原意的那個 UTC 時間點」這個不變量。
test('syncUser 訊息的 occurred_at 明確解讀為 UTC（不依賴連線環境 timezone 設定）', async () => {
  setupOdooMocks({
    tasks: [{
      id: 9300,
      name: 'TZ Task',
      project_id: [1, 'My Project'],
      stage_id: [2, 'In Progress'],
      description: '<p>desc</p>'
    }],
    messages: [{ id: 201, date: '2026-06-25 10:00:00', body: '<p>時區測試</p>' }]
  });
  setupServiceMocks({ tasks: [] });

  await syncModule.syncUser(userId);

  const { rows: [msg] } = await dbModule.query(
    "SELECT occurred_at FROM task_messages WHERE task_id = (SELECT id FROM tasks WHERE task_id = 'task_odoo_9300')"
  );
  expect(msg.occurred_at.toISOString()).toBe('2026-06-25T10:00:00.000Z');
});
