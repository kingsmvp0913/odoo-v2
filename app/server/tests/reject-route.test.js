// 意圖：review_pending 退回 → 任務進 reject_triage 分診、原因落 task_rejections（工作流程健檢子專案 1）。
process.env.JWT_SECRET = 'test-reject';
// 附件實體檔導去暫存目錄：saveAttachmentFile 真的會寫檔，不導開會在 app/uploads 留下測試垃圾。
process.env.UPLOAD_DIR = require('path').join(require('os').tmpdir(), 'reject-route-test-uploads');
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
// 呼叫序探針：附件與 runPipeline 的先後只能**同步**量——runPipeline 是 fire-and-forget，
// 在它的 mock 裡 await 查 DB 會落在 microtask 佇列，量到的順序不可靠（實測會假綠）。
jest.mock('../lib/attachments', () => {
  const actual = jest.requireActual('../lib/attachments');
  const order = [];
  return {
    ...actual,
    __order: order,
    saveAttachmentFile: (...args) => { order.push('save'); return actual.saveAttachmentFile(...args); }
  };
});
jest.mock('../pipeline/runner', () => ({
  runPipeline: jest.fn(() => {
    require('../lib/attachments').__order.push('pipeline');
    return Promise.resolve({ dispatched: 0 });
  }),
  getInflightTaskIds: () => []
}));

let dbModule, app, token, userId, taskDbId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name) VALUES ('rv','h','R') RETURNING id");
  userId = u.id;
  token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,odoo_version) VALUES ('P','17.0') RETURNING id");
  const { rows: [t] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id, reentry_count) VALUES ($1,'task_odoo_1','odoo','T','review_pending',$2,0) RETURNING id",
    [userId, p.id]
  );
  taskDbId = t.id;
  const a = express(); a.use(express.json());
  require('../pipeline-routes').registerRoutes(a);
  app = a;
});
afterAll(() => dbModule._setPoolForTesting(null));
const auth = () => ({ Authorization: `Bearer ${token}` });

test('空白原因 → 400（狀態不變）', async () => {
  const res = await request(app).post(`/api/tasks/${taskDbId}/reject`).set(auth()).send({ reason: '   ' });
  expect(res.status).toBe(400);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [taskDbId]);
  expect(t.status).toBe('review_pending');
});

test('review_pending 退回 → reject_triage、原因帶入 feedback、不動 reentry（統計改看 task_rejections）、落 task_rejections(new)', async () => {
  const res = await request(app).post(`/api/tasks/${taskDbId}/reject`).set(auth())
    .send({ reason: '備註欄位型別錯；審核清單想預設收合' });
  expect(res.status).toBe(200);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, reentry_count FROM tasks WHERE id=$1', [taskDbId]);
  expect(t.status).toBe('reject_triage');           // 進分診，不再直進 coding
  expect(t.retry_feedback).toContain('備註欄位型別錯');
  // 人工退回不累加 reentry_count：否則會與下游 reject_triage 判 fix 時的 +1 疊加，
  // 讓乾淨任務（reentry=0）被退一次就撞 MAX_REENTRY 卡死在 stopped，coding 一次都沒重跑。統計改由 task_rejections 承接。
  expect(t.reentry_count).toBe(0);
  const { rows: rej } = await dbModule.query('SELECT task_id, project_id, reason, status FROM task_rejections');
  expect(rej.length).toBe(1);
  expect(rej[0].task_id).toBe('task_odoo_1');       // 業務 id（穩定，硬刪不失真）
  expect(rej[0].status).toBe('new');
  expect(rej[0].reason).toContain('備註欄位型別錯'); // 原始全文仍保留給分類 agent
  const { rows: logRows } = await dbModule.query(
    "SELECT role, content FROM task_logs WHERE task_id=$1 ORDER BY id", [taskDbId]
  );
  // 時間軸只留標記，不渲染原始原因本文（避免整包錯誤 log 灌進畫面）
  expect(logRows.length).toBe(1);
  expect(logRows[0].role).toBe('system');
  expect(logRows[0].content).toBe('[人工退回]');
  expect(logRows[0].content).not.toContain('備註欄位型別錯');
});

test('非 review_pending（已被上題退回成 coding）→ 400', async () => {
  const res = await request(app).post(`/api/tasks/${taskDbId}/reject`).set(auth()).send({ reason: 'x' });
  expect(res.status).toBe(400);
});

// 意圖：視覺類退回（本站佔退回項的 22%）用文字描述不清楚——下游三關（分診／respec／coding）讀的是
// 程式碼 diff、看不到畫面，截圖是它們唯一能看到「審核者實際看到什麼」的管道。
// 本測試真正要釘住的是**時序**：assembleTaskContext 在 agent 起跑時才查 task_attachments，
// 附件若寫在 runPipeline 之後，這輪 agent 一張圖都讀不到——功能靜默失效，而「附件有進 DB」的斷言照樣全綠。
test('退回夾帶截圖 → 落 task_attachments，且在 runPipeline 觸發前就寫好', async () => {
  const { rows: [p] } = await dbModule.query('SELECT id FROM projects LIMIT 1');
  const { rows: [t2] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id, reentry_count) VALUES ($1,'task_odoo_2','odoo','T2','review_pending',$2,0) RETURNING id",
    [userId, p.id]
  );
  const order = require('../lib/attachments').__order;
  order.length = 0;

  const res = await request(app).post(`/api/tasks/${t2.id}/reject`).set(auth())
    .field('reason', '按鈕位置不對，見附圖')
    .attach('files', Buffer.from('fake-png-bytes'), 'shot.png');
  expect(res.status).toBe(200);

  const { rows: atts } = await dbModule.query(
    'SELECT filename, origin FROM task_attachments WHERE task_id=$1', [t2.id]
  );
  expect(atts.length).toBe(1);
  expect(atts[0].filename).toBe('shot.png');
  // origin 沿用 'manual'（與新增任務上傳同值）：下游 taskAttachmentNote 不做 origin 過濾，
  // 換新值等於要盤過所有消費端，沒有好處。
  expect(atts[0].origin).toBe('manual');
  // 關鍵斷言：附件一定要在 runPipeline 觸發**之前**寫完
  expect(order).toEqual(['save', 'pipeline']);
});
