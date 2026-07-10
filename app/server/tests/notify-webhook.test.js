const { newDb } = require('pg-mem');

let dbModule, webhookMod, notify;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  webhookMod = require('../notify-webhook');
  notify = require('../notify');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  webhookMod._resetCacheForTesting();
  await dbModule.query('DELETE FROM teams_settings');
});

async function setUrl(url) {
  await dbModule.query(
    'INSERT INTO teams_settings (id, notify_webhook_url) VALUES (1, $1)',
    [url]
  );
}

// 意圖：使用者離線時（未開網頁、未設 Teams），需人工動作的狀態必須有外部出口——
// 設定了 notify_webhook_url 就要 POST，payload 帶得出任務身分與狀態。
test('已設定 URL → POST payload（含 user_id 與狀態）', async () => {
  await setUrl('https://hook.example/notify');
  const ok = await webhookMod.sendWebhook(7, { taskId: 3, task_id: 'task_odoo_3', title: 'T', status: 'review_pending' });
  expect(ok).toBe(true);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toBe('https://hook.example/notify');
  expect(JSON.parse(opts.body)).toMatchObject({ user_id: 7, task_id: 'task_odoo_3', status: 'review_pending' });
});

test('未設定 URL → 不發送', async () => {
  const ok = await webhookMod.sendWebhook(7, { status: 'stopped' });
  expect(ok).toBe(false);
  expect(global.fetch).not.toHaveBeenCalled();
});

// 意圖：通知只是旁路，webhook 掛掉不得讓 pipeline 狀態轉移噴錯
test('fetch 失敗 → 回 false 不拋錯', async () => {
  await setUrl('https://hook.example/notify');
  global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
  await expect(webhookMod.sendWebhook(7, { status: 'stopped' })).resolves.toBe(false);
});

test('registerWebhookChannel 後 notifyAction 會觸發 webhook', async () => {
  await setUrl('https://hook.example/notify');
  webhookMod.registerWebhookChannel();
  notify.notifyAction(9, { taskId: 1, task_id: 'task_x', title: 'X', status: 'confirm_pending' });
  // channel 是 fire-and-forget，等 microtask/IO 跑完
  await new Promise(r => setTimeout(r, 50));
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ user_id: 9, status: 'confirm_pending' });
});
