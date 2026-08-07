const { query } = require('./db');
const { HUMAN_STATUSES } = require('../public/js/status-labels.js');
const { addInboxEvent } = require('./lib/inbox');

let _io = null;

// 需要使用者動作的狀態——由 status registry 的 actor:'human' 推導，新增閘門狀態不必回頭補這份名單
const ACTION_STATUSES = new Set(HUMAN_STATUSES);

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
  // 收件匣＝「發生過什麼」的事件流，與導覽列 badge 的當前狀態快照互補（兩者刻意並存）。
  // fire-and-forget：這裡走在 cron tick 的通知路徑上，寫入失敗不得擋住通知派送。
  addInboxEvent(userId, taskDbId, 'action', { status, summary: title || task_id || null })
    .catch(() => {});
  notifyAction(userId, { taskId: taskDbId, task_id, title, status });
}

module.exports = { setIo, emitToUser, emitAll, notifyAction, registerChannel, ACTION_STATUSES };
