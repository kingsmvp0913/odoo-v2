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
    messages: [{ date: '2026-06-25 10:00:00', body: '<p>First comment</p>' }]
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
  expect(rows[0].original_text).toContain('Test Task A');
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
    messages: [{ date: '2026-06-25 11:00:00', body: '<p>補充說明</p>', attachment_ids: [] }]
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
