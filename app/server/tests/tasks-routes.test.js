const request = require('supertest');
const { newDb } = require('pg-mem');

// 卸載測試區 module 走 odoo-bin（無法在單元測試 spawn）→ 只 mock uninstallModule，
// 其餘 env-agent 匯出保持真實，不影響 app 啟動。
jest.mock('../pipeline/env-agent', () => {
  const actual = jest.requireActual('../pipeline/env-agent');
  return { ...actual, uninstallModule: jest.fn().mockResolvedValue({ result: 'skipped_not_installed' }) };
});
const envAgent = require('../pipeline/env-agent');

// 重建 testing 分支涉及 git，無法在單元測試跑真實 repo → mock 之。
jest.mock('../pipeline/rebuild-testing', () => ({
  rebuildTesting: jest.fn().mockResolvedValue(null),
  INFLIGHT_DEPLOYED: ['deploy_testing', 'playwright_running', 'review_pending'],
}));
const rebuildMod = require('../pipeline/rebuild-testing');

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

// 意圖：專案任務的修正指示不再盲目 resume，改交通用分診員（resolve_triage）讀 diff/log＋你的指示判去向；
// resume_status/blocker/計數器保留給分診讀取，最終落點與歸零由分診處理（此處只驗路由的即時效果）。
test('resolve-blocker 專案任務 → 進 resolve_triage 分診，保留 resume_status/計數器並落修正指示', async () => {
  const { rows: [pj] } = await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('RB','17.0') RETURNING id");
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, resume_status, blocker_content, project_id, qa_retry_count)
     VALUES ($1,'task_rb','odoo','R','stopped','qa_running','boom',$2,3) RETURNING id`,
    [userId, pj.id]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/resolve-blocker`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ resolution: '沒事，這是誤判' });
  expect(res.status).toBe(200);
  const { rows: [after] } = await dbModule.query(
    'SELECT status, resume_status, qa_retry_count, blocker_content FROM tasks WHERE id=$1', [t.id]
  );
  expect(after.status).toBe('resolve_triage');   // 進分診，不再盲目 resume
  expect(after.resume_status).toBe('qa_running'); // 保留給分診判斷
  expect(after.qa_retry_count).toBe(3);           // 不在此歸零（落點時才由分診 goto 處理）
  expect(after.blocker_content).toBe('boom');     // 保留供分診讀
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [t.id]);
  expect(logs.some(l => l.role === 'user' && l.content.includes('沒事，這是誤判'))).toBe(true);
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

// confirm_pending 的澄清問題只存在 analysis_yaml，前端無 YAML parser → 後端須解析成 clarification 回傳，
// 否則整合後的時間軸「AI 有問題等待你回覆」下方是空白，使用者看不到要回答什麼（task 81 的回歸）。
test('GET /api/tasks/:id → confirm_pending 解析 analysis_yaml 回傳 clarification 問題清單', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, analysis_yaml)
     VALUES ($1,'task_clarify','odoo','C','confirm_pending',$2) RETURNING id`,
    [userId, 'summary: "改動摘要"\nclarification_channel:\n  questions:\n    - "問題一？"\n    - "問題二？"\n']
  );
  const res = await request(app).get(`/api/tasks/${t.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.clarification.questions).toEqual(['問題一？', '問題二？']);
  expect(res.body.clarification.summary).toBe('改動摘要');
});

// reject_confirm_pending 共用 answer 區但走時間軸對話，analysis_yaml 常殘留當初分析的問題 → 不可冒出來。
test('GET /api/tasks/:id → reject_confirm_pending 不回傳殘留的分析問題', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, analysis_yaml)
     VALUES ($1,'task_reject_clarify','odoo','R','reject_confirm_pending',$2) RETURNING id`,
    [userId, 'summary: "舊摘要"\nclarification_channel:\n  questions:\n    - "舊問題？"\n']
  );
  const res = await request(app).get(`/api/tasks/${t.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.clarification.questions).toEqual([]);
});

// spec_review（MODE_B 規格審核閘門）：前端無 YAML parser → 後端解析 analysis_yaml 成 spec 回傳，
// 讓審核頁渲染可讀規格（摘要／模組／實作項／驗收項），使用者看不到原始 YAML。
test('GET /api/tasks/:id → spec_review 解析 analysis_yaml 回傳 spec 物件', async () => {
  const yamlText = [
    'case_id: "task_sr"',
    'module: idx_sale_note',
    'odoo_version: "17.0"',
    'execution_mode: MODE_B',
    'summary: 在報價單加備註欄位',
    'requirements:',
    '  - 加一個 note 欄位',
    '  - 顯示在報價單頁',
    'acceptance:',
    '  - 報價單看得到備註欄位',
    'low_confidence: false',
    'clarification_channel:',
    '  questions: []',
    '  user_answer: ""',
  ].join('\n');
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, analysis_yaml)
     VALUES ($1,'task_specreview','odoo','SR','spec_review',$2) RETURNING id`,
    [userId, yamlText]
  );
  const res = await request(app).get(`/api/tasks/${t.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.spec).toBeTruthy();
  expect(res.body.spec.summary).toBe('在報價單加備註欄位');
  expect(res.body.spec.module).toBe('idx_sale_note');
  expect(res.body.spec.execution_mode).toBe('MODE_B');
  expect(res.body.spec.requirements).toEqual(['加一個 note 欄位', '顯示在報價單頁']);
  expect(res.body.spec.acceptance).toEqual(['報價單看得到備註欄位']);
});

// 非 spec_review 不附 spec（避免其他狀態殘留規格冒出來，比照 clarification 的狀態守門）
test('GET /api/tasks/:id → 非 spec_review 不回傳 spec', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, analysis_yaml)
     VALUES ($1,'task_notspec','odoo','NS','coding_running','summary: x\nmodule: y') RETURNING id`,
    [userId]
  );
  const res = await request(app).get(`/api/tasks/${t.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.spec == null).toBe(true);
});

// spec_review 是需人工動作狀態 → needs_action 清單要撈得到（任務列表正確標示）
test('GET /api/tasks?needs_action=true → 含 spec_review 任務', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status)
     VALUES ($1,'task_sr_needsaction','odoo','SRNA','spec_review') RETURNING id`,
    [userId]
  );
  const res = await request(app).get('/api/tasks?needs_action=true')
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.some(x => x.id === t.id)).toBe(true);
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

test('POST /api/tasks/:id/messages 夾帶檔案 → 建立 manual_reply 附件', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_msg_file','odoo','M','base','coding_running') RETURNING id`,
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/messages`)
    .set('Authorization', `Bearer ${adminToken}`)
    .field('content', '附檔案的留言')
    .attach('files', Buffer.from('fake-image-bytes'), 'shot.png');
  expect(res.status).toBe(200);
  expect(res.body.attachments.length).toBe(1);
  expect(res.body.attachments[0].filename).toBe('shot.png');

  const { rows: atts } = await dbModule.query(
    "SELECT origin, synced_to_odoo FROM task_attachments WHERE task_id = $1", [t.id]
  );
  expect(atts.length).toBe(1);
  expect(atts[0].origin).toBe('manual_reply');
});

test('POST /api/tasks/:id/messages 超過檔案數量限制 → 400', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_msg_toomany','odoo','M','base','coding_running') RETURNING id`,
    [userId]
  );
  let req = request(app).post(`/api/tasks/${t.id}/messages`)
    .set('Authorization', `Bearer ${adminToken}`)
    .field('content', '太多檔案');
  for (let i = 0; i < 6; i++) req = req.attach('files', Buffer.from('x'), `f${i}.txt`);
  const res = await req;
  expect(res.status).toBe(400);
});

test('GET /api/tasks/:id/attachments/:attId/download → 回傳檔案內容，非白名單 mimetype 強制 application/octet-stream', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_dl','odoo','M','base','new') RETURNING id`,
    [userId]
  );
  const attachments = require('../lib/attachments');
  const relPath = attachments.saveAttachmentFile(t.id, 'doc.txt', Buffer.from('文件內容'));
  const { rows: [att] } = await dbModule.query(
    `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin)
     VALUES ($1, 'doc.txt', 'text/plain', $2, 'ticket_main') RETURNING id`,
    [t.id, relPath]
  );

  const res = await request(app).get(`/api/tasks/${t.id}/attachments/${att.id}/download`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('application/octet-stream');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.body.toString()).toContain('文件內容');
});

test('GET /api/tasks/:id/attachments/:attId/download 對不在白名單的 mimetype 一律回 application/octet-stream（防 XSS）', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_dl_xss','odoo','M','base','new') RETURNING id`,
    [userId]
  );
  const attachments = require('../lib/attachments');
  const relPath = attachments.saveAttachmentFile(t.id, 'evil.html', Buffer.from('<script>alert(1)</script>'));
  const { rows: [att] } = await dbModule.query(
    `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin)
     VALUES ($1, 'evil.html', 'text/html', $2, 'manual_reply') RETURNING id`,
    [t.id, relPath]
  );

  const res = await request(app).get(`/api/tasks/${t.id}/attachments/${att.id}/download`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('application/octet-stream');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
});

test('GET /api/tasks/:id/attachments/:attId/download 對白名單內的圖片 mimetype 維持原樣', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_dl_img','odoo','M','base','new') RETURNING id`,
    [userId]
  );
  const attachments = require('../lib/attachments');
  const relPath = attachments.saveAttachmentFile(t.id, 'shot.png', Buffer.from('fake-png-bytes'));
  const { rows: [att] } = await dbModule.query(
    `INSERT INTO task_attachments (task_id, filename, mimetype, file_path, origin)
     VALUES ($1, 'shot.png', 'image/png', $2, 'manual_reply') RETURNING id`,
    [t.id, relPath]
  );

  const res = await request(app).get(`/api/tasks/${t.id}/attachments/${att.id}/download`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('image/png');
});

test('GET /api/tasks/:id/attachments/:attId/download 附件不存在 → 404', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_dl_404','odoo','M','base','new') RETURNING id`,
    [userId]
  );
  const res = await request(app).get(`/api/tasks/${t.id}/attachments/999999/download`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
});

// 意圖：task_attachments 對 tasks 有 FK 且無 ON DELETE CASCADE，比照 task_messages
// 既有修法（見同檔案上方註解），刪任務前沒先清 task_attachments 一樣會撞 FK constraint
test('DELETE /api/tasks/:id → 任務有 task_attachments 時仍可成功刪除', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'task_del_with_atts','odoo','D','base','new') RETURNING id`,
    [userId]
  );
  const attachments = require('../lib/attachments');
  const relPath = attachments.saveAttachmentFile(t.id, 'x.txt', Buffer.from('x'));
  await dbModule.query(
    `INSERT INTO task_attachments (task_id, filename, file_path, origin) VALUES ($1, 'x.txt', $2, 'ticket_main')`,
    [t.id, relPath]
  );

  const res = await request(app).delete(`/api/tasks/${t.id}`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);

  const { rows } = await dbModule.query('SELECT * FROM task_attachments WHERE task_id = $1', [t.id]);
  expect(rows.length).toBe(0);
});
// 同一個既有、已在正式環境跑過的 ANY(int[]) pattern，不因測試工具限制改寫正式程式碼。

// --- 刪任務時卸載測試區 module（子系統 A）---
// 共用：建一個專案 + 一個帶 module 的任務（git_branch 留空，跳過 cleanupTaskGit）
let _projSeq = 0;
async function makeProjectTask({ module, status = 'done' }) {
  _projSeq += 1;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ($1,'17.0') RETURNING id",
    [`proj_uninstall_${_projSeq}`]
  );
  const yaml = module == null ? null : `module: ${module}`;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, analysis_yaml)
     VALUES ($1,$2,'odoo','T',$3,$4,$5) RETURNING id`,
    [userId, `task_uninstall_${_projSeq}`, status, p.id, yaml]
  );
  return { projectId: p.id, taskId: t.id };
}

// 意圖：正常情況（module 沒別的任務用、Odoo 也無下游依存）刪任務要真的把 module 從測試區卸掉
test('DELETE 任務 → 無兄弟、無下游依存時卸載其 module，任務被刪、無警告', async () => {
  envAgent.uninstallModule.mockClear();
  envAgent.uninstallModule.mockResolvedValueOnce({ result: 'uninstalled' });
  const { projectId, taskId } = await makeProjectTask({ module: 'idx_solo' });

  const res = await request(app).delete(`/api/tasks/${taskId}`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(200);
  expect(envAgent.uninstallModule).toHaveBeenCalledWith(projectId, 'idx_solo');
  expect(res.body.warnings).toEqual([]);
  const { rows } = await dbModule.query('SELECT id FROM tasks WHERE id=$1', [taskId]);
  expect(rows.length).toBe(0);
});

// 意圖：module 還有同專案其他任務在用 → 誤卸會弄壞別人的測試區，必須跳過卸載但仍刪任務
test('DELETE 任務 → 同專案其他任務也用同一 module 時不卸載，但仍刪除', async () => {
  envAgent.uninstallModule.mockClear();
  const { projectId, taskId } = await makeProjectTask({ module: 'idx_shared' });
  await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, analysis_yaml)
     VALUES ($1,'task_uninstall_sibling','odoo','T','coding_running',$2,'module: idx_shared')`,
    [userId, projectId]
  );

  const res = await request(app).delete(`/api/tasks/${taskId}`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(200);
  expect(envAgent.uninstallModule).not.toHaveBeenCalled();
  const { rows } = await dbModule.query('SELECT id FROM tasks WHERE id=$1', [taskId]);
  expect(rows.length).toBe(0);
});

// 意圖：硬卸有下游依存的 module 會被 Odoo 連鎖卸載上層 → 回警告、不卸，但刪除照走
test('DELETE 任務 → module 有 Odoo 下游依存時回警告不卸載，任務仍被刪', async () => {
  envAgent.uninstallModule.mockClear();
  envAgent.uninstallModule.mockResolvedValueOnce({ result: 'skipped_dependents', dependents: ['idx_child'] });
  const { taskId } = await makeProjectTask({ module: 'idx_parent' });

  const res = await request(app).delete(`/api/tasks/${taskId}`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(200);
  expect(res.body.warnings.length).toBe(1);
  expect(res.body.warnings[0]).toContain('idx_child');
  const { rows } = await dbModule.query('SELECT id FROM tasks WHERE id=$1', [taskId]);
  expect(rows.length).toBe(0);
});

// 意圖：卸載只是加值收尾，卸載丟例外時絕不能卡住刪除（fail-open），並把錯誤當警告回報
test('DELETE 任務 → 卸載丟例外時任務仍被刪，錯誤以警告回報', async () => {
  envAgent.uninstallModule.mockClear();
  envAgent.uninstallModule.mockRejectedValueOnce(new Error('odoo shell boom'));
  const { taskId } = await makeProjectTask({ module: 'idx_boom' });

  const res = await request(app).delete(`/api/tasks/${taskId}`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(200);
  expect(res.body.warnings.length).toBe(1);
  const { rows } = await dbModule.query('SELECT id FROM tasks WHERE id=$1', [taskId]);
  expect(rows.length).toBe(0);
});

// 意圖：任務沒有 module（無 analysis_yaml）就沒有卸載對象，不該嘗試呼叫卸載
test('DELETE 任務 → 無 analysis_yaml/module 時不嘗試卸載，任務被刪', async () => {
  envAgent.uninstallModule.mockClear();
  const { taskId } = await makeProjectTask({ module: null });

  const res = await request(app).delete(`/api/tasks/${taskId}`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(200);
  expect(envAgent.uninstallModule).not.toHaveBeenCalled();
  const { rows } = await dbModule.query('SELECT id FROM tasks WHERE id=$1', [taskId]);
  expect(rows.length).toBe(0);
});

// 意圖：刪任務後要重建 testing 分支（清掉被刪任務留在 testing 的 source），對該專案觸發一次
test('DELETE 任務 → 刪除後對該專案觸發 testing 重建', async () => {
  rebuildMod.rebuildTesting.mockClear();
  const { projectId, taskId } = await makeProjectTask({ module: 'idx_rebuild' });

  const res = await request(app).delete(`/api/tasks/${taskId}`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(200);
  expect(rebuildMod.rebuildTesting).toHaveBeenCalledWith(projectId, expect.anything());
});

// 意圖：重建暫停待人工（回警告）時，警告要跟卸載警告一起回給前端；刪除照樣完成
test('DELETE 任務 → 重建回警告時併入 warnings，任務仍被刪', async () => {
  rebuildMod.rebuildTesting.mockClear();
  rebuildMod.rebuildTesting.mockResolvedValueOnce('任務 #9 需人工解衝突，解完將自動續跑');
  const { taskId } = await makeProjectTask({ module: 'idx_rebuild_warn' });

  const res = await request(app).delete(`/api/tasks/${taskId}`)
    .set('Authorization', `Bearer ${adminToken}`);

  expect(res.status).toBe(200);
  expect(res.body.warnings.some(w => w.includes('人工解衝突'))).toBe(true);
  const { rows } = await dbModule.query('SELECT id FROM tasks WHERE id=$1', [taskId]);
  expect(rows.length).toBe(0);
});

// 意圖：退回對話要能一來一往——reject_confirm_pending（AI 待你回覆）送出回覆後，
// 同一個 /answer 端點要導回 reject_triage 續跑分診，而非一般澄清的 confirm_answered
test('POST /api/tasks/:id/answer → reject_confirm_pending 回覆導回 reject_triage 並落 user log', async () => {
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
     VALUES ($1,'rcp_1','odoo','T','c','reject_confirm_pending') RETURNING id`,
    [userId]
  );
  const res = await request(app).post(`/api/tasks/${t.id}/answer`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ user_answer: '整區預設收合' });
  expect(res.status).toBe(200);
  const { rows: [row] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [t.id]);
  expect(row.status).toBe('reject_triage');
  const { rows: logs } = await dbModule.query("SELECT role, content FROM task_logs WHERE task_id=$1", [t.id]);
  expect(logs.some(l => l.role === 'user' && l.content.includes('整區預設收合'))).toBe(true);
});
