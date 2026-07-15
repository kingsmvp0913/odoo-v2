const { query } = require('./db');

let _io = null;

// 需要使用者動作的狀態（單一真相）——進入這些狀態時發出 action 通知
const ACTION_STATUSES = new Set([
  'confirm_pending', 'stopped', 'cs_data_needed', 'cs_reply_pending',
  'merge_conflict', 'spec_review', 'review_pending'
]);

// 可插拔通知 channel（供之後串接 Teams / Discord）：fn(userId, payload)
const _channels = [];
function registerChannel(fn) { if (typeof fn === 'function') _channels.push(fn); }

function setIo(io) { _io = io; }

function emitToUser(userId, event, data) {
  if (_io) _io.to(`user:${userId}`).emit(event, data);
  // 攔截狀態更新：進入需動作狀態時，額外派送 action 通知（補查 title 供顯示）
  if (event === 'task:updated' && data && ACTION_STATUSES.has(data.status)) {
    _dispatchAction(userId, data.taskId, data.status).catch(() => {});
  }
}

function emitAll(event, data) {
  if (_io) _io.emit(event, data);
}

// 派送 action 通知：瀏覽器經 socket、其餘經已註冊 channel
function notifyAction(userId, payload) {
  if (_io) _io.to(`user:${userId}`).emit('notify:action', payload);
  for (const ch of _channels) {
    try { ch(userId, payload); } catch { /* channel 失敗不影響其他 */ }
  }
}

// 補查任務 task_id + title，組出通知 payload
async function _dispatchAction(userId, taskDbId, status) {
  let task_id = null, title = null;
  try {
    if (taskDbId != null) {
      const { rows } = await query('SELECT task_id, title FROM tasks WHERE id = $1', [taskDbId]);
      if (rows[0]) { task_id = rows[0].task_id; title = rows[0].title; }
    }
  } catch { /* best-effort：查不到仍發送 */ }
  notifyAction(userId, { taskId: taskDbId, task_id, title, status });
}

module.exports = { setIo, emitToUser, emitAll, notifyAction, registerChannel, ACTION_STATUSES };
