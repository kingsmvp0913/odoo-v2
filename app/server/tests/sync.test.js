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

beforeEach(() => {
  mockFetch.mockReset();
  // DB 跨 test 累積既有任務，syncUser 主同步跑完後會對「既有未封存任務」各做一次結案偵測查詢
  // （自帶 auth＋search_read）。未被 positional mock 明確排到的一律回空結果（＝沒有其它單結案），
  // 避免這些尾端查詢吃到 undefined 而讓既有測試爆掉。
  mockFetch.mockImplementation(() => makeFetchResponse({ jsonrpc: '2.0', result: [] }));
});

// body-aware router（給結案封存測試用，與 positional mock 解耦、不受呼叫順序影響）：
// 依 URL／model 路由；結案偵測查詢的判別＝domain 帶 ['id','in',...]（僅該查詢會用 id 清單回查）。
function routeClosedProbe({ odooClosed = [], serviceClosed = [] } = {}) {
  mockFetch.mockImplementation((url, opts) => {
    if (String(url).includes('/web/session/authenticate')) {
      return makeFetchResponse({ jsonrpc: '2.0', result: { uid: 1 } }, 'session_id=x');
    }
    const params = (JSON.parse(opts.body).params) || {};
    if (params.method === 'search_read') {
      const domain = (params.kwargs && params.kwargs.domain) || [];
      const isProbe = domain.some(d => Array.isArray(d) && d[0] === 'id' && d[1] === 'in');
      if (params.model === 'project.task') {
        return makeFetchResponse({ jsonrpc: '2.0', result: isProbe ? odooClosed.map(id => ({ id })) : [] });
      }
      if (params.model === 'service.question.feedback') {
        return makeFetchResponse({ jsonrpc: '2.0', result: isProbe ? serviceClosed.map(id => ({ id })) : [] });
      }
    }
    return makeFetchResponse({ jsonrpc: '2.0', result: [] });
  });
}

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
  await dbModule.query(
    "INSERT INTO projects (name, odoo_version, odoo_project_name) VALUES ('入庫測試專案 A', '17.0', 'Proj-99')"
  );
  setupOdooMocks({
    tasks: [{
      id: 9001,
      name: 'Test Task A',
      project_id: [1, 'Proj-99'],
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
  await dbModule.query(
    "INSERT INTO projects (name, odoo_version, service_respondent_name) VALUES ('客服對應專案', '17.0', '王小明')"
  );
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

test('assembleTaskContext() 組出標題／專案／狀態／分類標頭，無 task_messages 時 fallback 無訊息內容', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('組裝測試專案', '17.0') RETURNING id"
  );
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, stage_label, classification_label, project_id, status)
     VALUES ($1,'task_ctx_empty','odoo','C 任務','描述內容','處理中','技術問題',$2,'new') RETURNING id`,
    [userId, p.id]
  );
  const ctx = await syncModule.assembleTaskContext(t.id);
  expect(ctx).toContain('標題: C 任務');
  expect(ctx).toContain('專案: 組裝測試專案');
  expect(ctx).toContain('狀態: 處理中');
  expect(ctx).toContain('分類: 技術問題');
  expect(ctx).toContain('描述內容');
  expect(ctx).toContain('---message---\n無訊息內容');
});

// 意圖：附件（客戶截圖）是需求的主要載體，context 必須列出可 Read 的絕對路徑並明確授權唯讀，
// agent 才會真的去看；沒有附件時不得出現附件區塊（避免空洞指示）。
test('assembleTaskContext() 有附件時列出絕對路徑供 Read，無附件時不附加區塊', async () => {
  const { rows: [withAtt] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, has_attachment, status)
     VALUES ($1,'task_ctx_att','odoo','A','desc',true,'new') RETURNING id`,
    [userId]
  );
  await dbModule.query(
    `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin)
     VALUES ($1, $2, $3, $4, 'ticket_main')`,
    [withAtt.id, '維修單欄位.png', 'image/png', `task_${withAtt.id}/1_維修單欄位.png`]
  );
  const { rows: [noAtt] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, has_attachment, status)
     VALUES ($1,'task_ctx_noatt','odoo','B','desc',false,'new') RETURNING id`,
    [userId]
  );
  const ctxWith = await syncModule.assembleTaskContext(withAtt.id);
  const ctxWithout = await syncModule.assembleTaskContext(noAtt.id);
  expect(ctxWith).toContain('【任務附件】');
  expect(ctxWith).toContain('維修單欄位.png');
  const { uploadRoot } = require('../lib/attachments');
  expect(ctxWith).toContain(require('path').resolve(uploadRoot(), `task_${withAtt.id}/1_維修單欄位.png`));
  expect(ctxWith).not.toContain('無法直接讀取');
  expect(ctxWithout).not.toContain('【任務附件】');
});

test('assembleTaskContext() 手動上傳（origin=manual）附件同樣列入【任務附件】——跨來源一致', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, has_attachment, status)
     VALUES ($1,'task_ctx_manual','manual','A','desc',true,'new') RETURNING id`,
    [userId]
  );
  await dbModule.query(
    `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin)
     VALUES ($1, $2, $3, $4, 'manual')`,
    [t.id, '需求截圖.png', 'image/png', `task_${t.id}/1_需求截圖.png`]
  );
  const ctx = await syncModule.assembleTaskContext(t.id);
  expect(ctx).toContain('【任務附件】');
  expect(ctx).toContain('需求截圖.png');
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

test('syncUser 新訊息含 attachment_ids → 抓取 ir.attachment 內容並存為 task_attachments', async () => {
  mockFetch
    // auth
    .mockImplementationOnce(() => makeFetchResponse({ jsonrpc: '2.0', result: { uid: 1 } }, 'session_id=abc'))
    // task search_read
    .mockImplementationOnce(() => makeFetchResponse({
      jsonrpc: '2.0',
      result: [{
        id: 9400, name: 'Attach Task', project_id: [1, 'My Project'],
        stage_id: [2, 'In Progress'], description: '<p>desc</p>'
      }]
    }))
    // mail.message search_read（含 attachment_ids）
    .mockImplementationOnce(() => makeFetchResponse({
      jsonrpc: '2.0',
      result: [{ id: 601, date: '2026-07-01 09:00:00', body: '<p>附件在這</p>', attachment_ids: [9001] }]
    }))
    // ir.attachment read
    .mockImplementationOnce(() => makeFetchResponse({
      jsonrpc: '2.0',
      result: [{ id: 9001, name: 'screenshot.png', mimetype: 'image/png', datas: Buffer.from('fake-png').toString('base64') }]
    }));
  setupServiceMocks({ tasks: [] });

  await syncModule.syncUser(userId);

  const { rows: [t] } = await dbModule.query("SELECT id, has_attachment FROM tasks WHERE task_id = 'task_odoo_9400'");
  expect(t.has_attachment).toBe(true);

  const { rows: atts } = await dbModule.query(
    `SELECT filename, mimetype, origin, synced_to_odoo FROM task_attachments WHERE task_id = $1`, [t.id]
  );
  expect(atts.length).toBe(1);
  expect(atts[0].filename).toBe('screenshot.png');
  expect(atts[0].origin).toBe('synced_message');
  expect(atts[0].synced_to_odoo).toBe(true);
});

test('syncUser 訊息無 attachment_ids → 不呼叫 ir.attachment、不產生 task_attachments', async () => {
  setupOdooMocks({
    tasks: [{ id: 9401, name: 'No Attach', project_id: [1, 'My Project'], stage_id: [2, 'In Progress'], description: '<p>d</p>' }],
    messages: [{ id: 602, date: '2026-07-01 09:00:00', body: '<p>沒附件</p>', attachment_ids: [] }]
  });
  setupServiceMocks({ tasks: [] });

  await syncModule.syncUser(userId);

  const { rows: [t] } = await dbModule.query("SELECT id, has_attachment FROM tasks WHERE task_id = 'task_odoo_9401'");
  expect(t.has_attachment).toBe(false);
  const { rows: atts } = await dbModule.query('SELECT * FROM task_attachments WHERE task_id = $1', [t.id]);
  expect(atts.length).toBe(0);
});

// 意圖：service.question.feedback.file 是 Many2many→ir.attachment，search_read 回傳「附件 id 陣列」而非 base64；
// 真正位元組要再 ir.attachment.read 取 datas（同訊息附件機制）。過去誤把 id 陣列當 base64 解＝寫出 1-byte 壞檔。
// 這裡驗證：file=[id] 時去參照取真檔、存 ticket_main 附件，檔名／mimetype 用來源 ir.attachment 的真值。
test('syncUser eService 工單 file 為附件 id 陣列 → ir.attachment.read 取真檔存 ticket_main', async () => {
  setupOdooMocks({ tasks: [] });
  setupServiceMocks({
    tasks: [{
      id: 3100, name_seq: 'SQ-3100', subject: '附件工單',
      state: 'draft', question_description: '<p>desc</p>',
      classification: false, respondent: [5, '王小明'],
      file: [7001]
    }],
    messages: []
  });
  // ingestTicketMainAttachments → ir.attachment.read
  const realBytes = Buffer.from('\x89PNG\r\n\x1a\n-real-image-bytes', 'latin1');
  mockFetch.mockImplementationOnce(() => makeFetchResponse({
    jsonrpc: '2.0',
    result: [{ id: 7001, name: '委外維修.png', mimetype: 'image/png', datas: realBytes.toString('base64') }]
  }));

  await syncModule.syncUser(userId);

  const { rows: [t] } = await dbModule.query("SELECT id, has_attachment FROM tasks WHERE task_id = 'task_service_3100'");
  expect(t.has_attachment).toBe(true);
  const { rows: atts } = await dbModule.query(
    "SELECT origin, message_id, filename, mimetype, file_path, external_attachment_id FROM task_attachments WHERE task_id = $1", [t.id]
  );
  expect(atts.length).toBe(1);
  expect(atts[0].origin).toBe('ticket_main');
  expect(atts[0].message_id).toBeNull();
  expect(atts[0].filename).toBe('委外維修.png');
  expect(atts[0].mimetype).toBe('image/png');
  expect(atts[0].external_attachment_id).toBe('7001');
  // 磁碟上是真檔內容，不是 1-byte 壞檔
  const { readAttachmentFile } = require('../lib/attachments');
  expect(readAttachmentFile(atts[0].file_path).equals(realBytes)).toBe(true);
});

// file 是 m2m，可多附件；一次 read 全部取回，逐一落地
test('syncUser eService 工單 file 多個 id → 存多筆 ticket_main 附件', async () => {
  setupOdooMocks({ tasks: [] });
  setupServiceMocks({
    tasks: [{
      id: 3102, name_seq: 'SQ-3102', subject: '多附件工單',
      state: 'draft', question_description: '<p>desc</p>',
      classification: false, respondent: [5, '王小明'],
      file: [7010, 7011]
    }],
    messages: []
  });
  mockFetch.mockImplementationOnce(() => makeFetchResponse({
    jsonrpc: '2.0',
    result: [
      { id: 7010, name: 'a.jpg', mimetype: 'image/jpeg', datas: Buffer.from('aaa').toString('base64') },
      { id: 7011, name: 'b.jpg', mimetype: 'image/jpeg', datas: Buffer.from('bbb').toString('base64') }
    ]
  }));

  await syncModule.syncUser(userId);

  const { rows: [t] } = await dbModule.query("SELECT id FROM tasks WHERE task_id = 'task_service_3102'");
  const { rows: atts } = await dbModule.query(
    "SELECT external_attachment_id FROM task_attachments WHERE task_id = $1 ORDER BY id", [t.id]
  );
  expect(atts.map(a => a.external_attachment_id)).toEqual(['7010', '7011']);
});

test('syncUser eService 工單 file 為 false → 不呼叫 ir.attachment、不產生附件', async () => {
  setupOdooMocks({ tasks: [] });
  setupServiceMocks({
    tasks: [{
      id: 3101, name_seq: 'SQ-3101', subject: '無附件工單',
      state: 'draft', question_description: '<p>desc</p>',
      classification: false, respondent: [5, '王小明'], file: false
    }],
    messages: []
  });

  await syncModule.syncUser(userId);

  const { rows: [t] } = await dbModule.query("SELECT id, has_attachment FROM tasks WHERE task_id = 'task_service_3101'");
  expect(t.has_attachment).toBe(false);
  const { rows: atts } = await dbModule.query('SELECT * FROM task_attachments WHERE task_id = $1', [t.id]);
  expect(atts.length).toBe(0);
});

// 核心回歸（task 129 情境）：既有工單首次同步時 file 為空、之後才補圖，再同步必須回填主附件。
test('syncUser 既有 eService 工單再同步 → 回填先前漏抓的 ticket_main 主附件', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, has_attachment)
     VALUES ($1,'task_service_3807','service','委外維修單','desc','cs_running', false) RETURNING id`,
    [userId]
  );
  setupOdooMocks({ tasks: [] });
  setupServiceMocks({
    tasks: [{
      id: 3807, name_seq: 'IDX-2026070049', subject: '委外維修單，要有廠商簡稱',
      state: 'open', question_description: '<p>desc</p>',
      classification: false, respondent: [5, '王小明'], file: [6177]
    }],
    messages: []
  });
  mockFetch.mockImplementationOnce(() => makeFetchResponse({
    jsonrpc: '2.0',
    result: [{ id: 6177, name: '委外維修-增加廠商簡稱.jpg', mimetype: 'image/jpeg', datas: Buffer.from('jpeg-bytes').toString('base64') }]
  }));

  await syncModule.syncUser(userId);

  const { rows: [after] } = await dbModule.query("SELECT has_attachment FROM tasks WHERE id = $1", [t.id]);
  expect(after.has_attachment).toBe(true);
  const { rows: atts } = await dbModule.query(
    "SELECT origin, filename, external_attachment_id FROM task_attachments WHERE task_id = $1", [t.id]
  );
  expect(atts.length).toBe(1);
  expect(atts[0].origin).toBe('ticket_main');
  expect(atts[0].filename).toBe('委外維修-增加廠商簡稱.jpg');
});

// 舊版把 id 陣列當 base64 寫出的 1-byte 壞檔列（origin=ticket_main、external_attachment_id 為 NULL）
// 必須在回填時汰換：刪壞列＋落地真檔，最終每附件只留一筆正確列，不留重複。
test('syncUser 回填時清掉舊版 1-byte 壞檔列（external_attachment_id NULL）並換成真檔', async () => {
  const attachments = require('../lib/attachments');
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, has_attachment)
     VALUES ($1,'task_service_3814','service','舊壞檔工單','desc','cs_running', true) RETURNING id`,
    [userId]
  );
  // 模擬舊版壞檔：1-byte 檔 + external_attachment_id 為 NULL 的 ticket_main 列
  const badRel = attachments.saveAttachmentFile(t.id, 'ticket_3814_attachment', Buffer.from([0x21]));
  await dbModule.query(
    `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin, synced_to_odoo)
     VALUES ($1, 'ticket_3814_attachment', NULL, $2, 'ticket_main', true)`,
    [t.id, badRel]
  );

  setupOdooMocks({ tasks: [] });
  setupServiceMocks({
    tasks: [{
      id: 3814, name_seq: 'IDX-2026070056', subject: '復修累計次數不對',
      state: 'open', question_description: '<p>desc</p>',
      classification: false, respondent: [5, '王小明'], file: [6200]
    }],
    messages: []
  });
  const good = Buffer.from('good-image-content-bytes');
  mockFetch.mockImplementationOnce(() => makeFetchResponse({
    jsonrpc: '2.0',
    result: [{ id: 6200, name: 'real.jpg', mimetype: 'image/jpeg', datas: good.toString('base64') }]
  }));

  await syncModule.syncUser(userId);

  const { rows: atts } = await dbModule.query(
    "SELECT filename, file_path, external_attachment_id FROM task_attachments WHERE task_id = $1", [t.id]
  );
  expect(atts.length).toBe(1); // 壞列已刪，只剩真檔列
  expect(atts[0].external_attachment_id).toBe('6200');
  expect(attachments.readAttachmentFile(atts[0].file_path).equals(good)).toBe(true);
  // 舊壞檔實體已被收走
  expect(attachments.attachmentSize(badRel)).toBe(0);
});

// 舊壞檔清掉、來源 file 又已無附件（file=[]）時，has_attachment 必須據實收回 false，別讓旗標說謊
test('syncUser 清掉舊壞檔且來源已無附件 → has_attachment 收回 false、無附件列', async () => {
  const attachments = require('../lib/attachments');
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, has_attachment)
     VALUES ($1,'task_service_3791','service','來源已無附件','desc','cs_running', true) RETURNING id`,
    [userId]
  );
  const badRel = attachments.saveAttachmentFile(t.id, 'ticket_3791_attachment', Buffer.from([0x21]));
  await dbModule.query(
    `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin, synced_to_odoo)
     VALUES ($1, 'ticket_3791_attachment', NULL, $2, 'ticket_main', true)`,
    [t.id, badRel]
  );

  setupOdooMocks({ tasks: [] });
  setupServiceMocks({
    tasks: [{
      id: 3791, name_seq: 'IDX-2026070033', subject: '信件通知字體加大',
      state: 'draft', question_description: '<p>desc</p>',
      classification: false, respondent: [5, '王小明'], file: []
    }],
    messages: []
  });

  await syncModule.syncUser(userId);

  const { rows: [after] } = await dbModule.query("SELECT has_attachment FROM tasks WHERE id = $1", [t.id]);
  expect(after.has_attachment).toBe(false);
  const { rows: atts } = await dbModule.query('SELECT * FROM task_attachments WHERE task_id = $1', [t.id]);
  expect(atts.length).toBe(0);
  expect(attachments.attachmentSize(badRel)).toBe(0);
});

// 冪等：已有正確 ticket_main（external_attachment_id 已對上）的工單再同步，不重抓、不重複插入
test('syncUser 既有正確 ticket_main 再同步 → 不重複抓取或插入', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, has_attachment)
     VALUES ($1,'task_service_3900','service','已同步工單','desc','cs_running', true) RETURNING id`,
    [userId]
  );
  await dbModule.query(
    `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin, external_attachment_id, synced_to_odoo)
     VALUES ($1, 'done.jpg', 'image/jpeg', $2, 'ticket_main', '8000', true)`,
    [t.id, `task_${t.id}/done.jpg`]
  );

  setupOdooMocks({ tasks: [] });
  setupServiceMocks({
    tasks: [{
      id: 3900, name_seq: 'SQ-3900', subject: '已同步',
      state: 'open', question_description: '<p>desc</p>',
      classification: false, respondent: [5, '王小明'], file: [8000]
    }],
    messages: []
  });
  // 不排入 ir.attachment.read mock：若程式又去抓就會拿到錯的下一個 mock 或報錯

  await syncModule.syncUser(userId);

  const { rows: atts } = await dbModule.query(
    "SELECT external_attachment_id FROM task_attachments WHERE task_id = $1", [t.id]
  );
  expect(atts.length).toBe(1);
  expect(atts[0].external_attachment_id).toBe('8000');
});

test('writebackTaskMessage 帶附件 → 先 ir.attachment.create 再 message_post(attachment_ids)', async () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const attachments = require('../lib/attachments');
  const tmpFile = attachments.saveAttachmentFile('wb-test', 'note.txt', Buffer.from('hello'));

  mockFetch
    .mockImplementationOnce(() => makeFetchResponse({ jsonrpc: '2.0', result: { uid: 1 } }, 'session_id=abc'))
    .mockImplementationOnce(() => makeFetchResponse({ jsonrpc: '2.0', result: 5555 })) // ir.attachment.create
    .mockImplementationOnce(() => makeFetchResponse({ jsonrpc: '2.0', result: 9999 })); // message_post

  const result = await syncModule.writebackTaskMessage(
    userId,
    { source: 'odoo', task_id: 'task_odoo_9001' },
    '回覆內容',
    [{ filename: 'note.txt', file_path: tmpFile }]
  );

  expect(result.messageExternalId).toBe(9999);
  expect(result.attachmentExternalIds).toEqual([5555]);

  const attCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
  expect(attCallBody.params.model).toBe('ir.attachment');
  expect(attCallBody.params.method).toBe('create');
  expect(attCallBody.params.args[0].res_model).toBe('project.task');

  const postCallBody = JSON.parse(mockFetch.mock.calls[2][1].body);
  expect(postCallBody.params.kwargs.attachment_ids).toEqual([5555]);
});

// 意圖：所有同步進來的任務都必須綁得到平台專案；綁不到對應專案的「新」Odoo 任務不該入庫，
// 否則會產生無專案任務、卡在無法開發。來源仍在 Odoo，下次對應建好後 sync 會自動補拉。
test('syncUser 新 Odoo 任務綁不到對應專案 → 不入庫（added=0、tasks 無列）', async () => {
  setupOdooMocks({
    tasks: [{
      id: 9500,
      name: '無專案對應任務',
      project_id: [88, 'ZZZ 查無對應專案'],
      stage_id: [2, 'In Progress'],
      description: '<p>x</p>'
    }],
    messages: [{ id: 801, date: '2026-07-01 09:00:00', body: '<p>c</p>' }]
  });
  setupServiceMocks({ tasks: [] });

  const result = await syncModule.syncUser(userId);
  expect(result.odoo.added).toBe(0);

  const { rows } = await dbModule.query(
    "SELECT id FROM tasks WHERE task_id = 'task_odoo_9500' AND user_id = $1", [userId]
  );
  expect(rows.length).toBe(0);
});

// 意圖：客服工單同樣依 respondent 對應專案；respondent 綁不到平台專案的「新」工單不入庫。
test('syncUser 新客服工單 respondent 綁不到對應專案 → 不入庫（added=0、tasks 無列）', async () => {
  setupOdooMocks({ tasks: [] });
  setupServiceMocks({
    tasks: [{
      id: 3500, name_seq: 'SQ-3500', subject: '無對應工單',
      state: 'open', question_description: '<p>desc</p>',
      classification: false, respondent: [99, '查無此對應人ZZZ'], file: false
    }],
    messages: [{ id: 802, date: '2026-07-01 09:00:00', body: '<p>c</p>', attachment_ids: [] }]
  });

  const result = await syncModule.syncUser(userId);
  expect(result.service.added).toBe(0);

  const { rows } = await dbModule.query(
    "SELECT id FROM tasks WHERE task_id = 'task_service_3500' AND user_id = $1", [userId]
  );
  expect(rows.length).toBe(0);
});

// 意圖：來源單結案後，主同步再也抓不到它（domain 只抓未結案），平台那張任務會一直留著。
// 補上「回查來源狀態→已結案就封存」：既有未封存 Odoo 任務、來源階段已折疊（已完成／取消）→ 封存。
test('syncUser 既有 Odoo 任務來源已結案（stage 折疊）→ 自動封存並回報 archived', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_odoo_9600','odoo','待封存','desc','new') RETURNING id`,
    [userId]
  );
  routeClosedProbe({ odooClosed: [9600] });

  const result = await syncModule.syncUser(userId);

  const { rows: [after] } = await dbModule.query('SELECT is_hidden FROM tasks WHERE id = $1', [t.id]);
  expect(after.is_hidden).toBe(true);
  expect(result.odoo.archived).toBe(1);
});

// 意圖：來源仍未結案（回查回空）→ 絕不誤封存既有任務。
test('syncUser 既有 Odoo 任務來源仍未結案 → 不封存、archived=0', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_odoo_9601','odoo','仍開啟','desc','new') RETURNING id`,
    [userId]
  );
  routeClosedProbe({ odooClosed: [] });

  const result = await syncModule.syncUser(userId);

  const { rows: [after] } = await dbModule.query('SELECT is_hidden FROM tasks WHERE id = $1', [t.id]);
  expect(after.is_hidden).toBe(false);
  expect(result.odoo.archived).toBe(0);
});

// 意圖：一律封存含進行中——來源結案即無需再做，封存時比照手動封存中止在飛 agent（abortTask）。
test('syncUser 進行中任務來源已結案 → 一律封存並中止在飛 agent', async () => {
  const runner = require('../pipeline/runner');
  const spy = jest.spyOn(runner, 'abortTask');
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, is_paused)
     VALUES ($1,'task_odoo_9602','odoo','進行中','desc','coding_running', true) RETURNING id`,
    [userId]
  );
  routeClosedProbe({ odooClosed: [9602] });

  await syncModule.syncUser(userId);

  const { rows: [after] } = await dbModule.query('SELECT is_hidden, is_paused FROM tasks WHERE id = $1', [t.id]);
  expect(after.is_hidden).toBe(true);
  expect(after.is_paused).toBe(false);
  expect(spy).toHaveBeenCalledWith(t.id);
  spy.mockRestore();
});

// 意圖：eService 結案（state 非 draft/open，涵蓋驗收完成／結案／作廢）→ 封存對應工單任務。
test('syncUser 既有 eService 工單來源已結案（state 非 draft/open）→ 自動封存', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_service_3600','service','待封存工單','desc','cs_running') RETURNING id`,
    [userId]
  );
  routeClosedProbe({ serviceClosed: [3600] });

  const result = await syncModule.syncUser(userId);

  const { rows: [after] } = await dbModule.query('SELECT is_hidden FROM tasks WHERE id = $1', [t.id]);
  expect(after.is_hidden).toBe(true);
  expect(result.service.archived).toBe(1);
});
