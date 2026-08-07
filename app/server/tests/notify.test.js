// 意圖：進入「需使用者動作」狀態時要派送 action 通知（含 title），非動作狀態不派送；
// 並保留可插拔 channel 介面供之後串 Teams/Discord。
jest.mock('../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ task_id: 'task_9', title: '測試任務' }] })
}));

const notify = require('../notify');

function fakeIo() {
  const emit = jest.fn();
  return { io: { to: jest.fn(() => ({ emit })), emit: jest.fn() }, emit };
}

test('ACTION_STATUSES 含關鍵需動作狀態、不含進行中或已移除狀態', () => {
  expect(notify.ACTION_STATUSES.has('confirm_pending')).toBe(true);
  expect(notify.ACTION_STATUSES.has('review_pending')).toBe(true);
  expect(notify.ACTION_STATUSES.has('spec_review')).toBe(true); // MODE_B 規格審核閘門也是需人工動作狀態
  expect(notify.ACTION_STATUSES.has('clarify_pending')).toBe(true); // QA 停下請使用者裁決規格也是需人工動作狀態
  expect(notify.ACTION_STATUSES.has('coding_running')).toBe(false);
  expect(notify.ACTION_STATUSES.has('deploy_ready')).toBe(false);
});

test('notifyAction 經 socket 發 notify:action 並呼叫已註冊 channel', () => {
  const { io, emit } = fakeIo();
  notify.setIo(io);
  const ch = jest.fn();
  notify.registerChannel(ch);

  notify.notifyAction(7, { taskId: 1, status: 'stopped' });

  expect(io.to).toHaveBeenCalledWith('user:7');
  expect(emit).toHaveBeenCalledWith('notify:action', expect.objectContaining({ status: 'stopped' }));
  expect(ch).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'stopped' }));
});

test('emitToUser 對 action 狀態補查 title 並派送 notify:action', async () => {
  const { io, emit } = fakeIo();
  notify.setIo(io);

  notify.emitToUser(3, 'task:updated', { taskId: 1, status: 'confirm_pending' });
  await new Promise(r => setImmediate(r)); // 等 async 補查 title

  const call = emit.mock.calls.find(c => c[0] === 'notify:action');
  expect(call).toBeTruthy();
  expect(call[1]).toMatchObject({ status: 'confirm_pending', title: '測試任務', task_id: 'task_9' });
});

test('emitToUser 對 clarify_pending 狀態補查 title 並派送 notify:action', async () => {
  const { io, emit } = fakeIo();
  notify.setIo(io);

  notify.emitToUser(3, 'task:updated', { taskId: 1, status: 'clarify_pending' });
  await new Promise(r => setImmediate(r)); // 等 async 補查 title

  const call = emit.mock.calls.find(c => c[0] === 'notify:action');
  expect(call).toBeTruthy();
  expect(call[1]).toMatchObject({ status: 'clarify_pending', title: '測試任務', task_id: 'task_9' });
});

// 收件匣：即時通知會被錯過（人不在電腦前、分頁關了），收件匣是回來之後補看的那一份。
// 兩者刻意並存——通知是「現在告訴你」，收件匣是「發生過什麼」。
test('emitToUser 對 action 狀態同時寫一筆收件匣 action 事件', async () => {
  const { query } = require('../db');
  query.mockClear();
  const { io } = fakeIo();
  notify.setIo(io);

  notify.emitToUser(3, 'task:updated', { taskId: 1, status: 'review_pending' });
  await new Promise(r => setImmediate(r));

  const insert = query.mock.calls.find(c => /INSERT INTO user_inbox/.test(c[0]));
  expect(insert).toBeTruthy();
  expect(insert[1]).toEqual([3, 1, 'action', 'review_pending', '測試任務']);
});

test('emitToUser 對非 action 狀態不寫收件匣（否則每次狀態變動都進收件匣＝沒有收件匣）', async () => {
  const { query } = require('../db');
  query.mockClear();
  const { io } = fakeIo();
  notify.setIo(io);

  notify.emitToUser(3, 'task:updated', { taskId: 1, status: 'coding_running' });
  await new Promise(r => setImmediate(r));

  expect(query.mock.calls.find(c => /INSERT INTO user_inbox/.test(c[0]))).toBeFalsy();
});

test('emitToUser 對非 action 狀態不派送 notify:action', async () => {
  const { io, emit } = fakeIo();
  notify.setIo(io);

  notify.emitToUser(3, 'task:updated', { taskId: 1, status: 'coding_running' });
  await new Promise(r => setImmediate(r));

  expect(emit.mock.calls.find(c => c[0] === 'notify:action')).toBeFalsy();
});
