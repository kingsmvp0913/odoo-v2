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

test('ACTION_STATUSES 含關鍵需動作狀態、不含進行中狀態', () => {
  expect(notify.ACTION_STATUSES.has('confirm_pending')).toBe(true);
  expect(notify.ACTION_STATUSES.has('deploy_ready')).toBe(true);
  expect(notify.ACTION_STATUSES.has('coding_running')).toBe(false);
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

test('emitToUser 對非 action 狀態不派送 notify:action', async () => {
  const { io, emit } = fakeIo();
  notify.setIo(io);

  notify.emitToUser(3, 'task:updated', { taskId: 1, status: 'coding_running' });
  await new Promise(r => setImmediate(r));

  expect(emit.mock.calls.find(c => c[0] === 'notify:action')).toBeFalsy();
});
