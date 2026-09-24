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
  if (event === 'task:updated' && data?.status === 'merge_conflict') {
    _dispatchConflictToAdmins(data.taskId).catch(() => {});
    return;
  }
  // 攔截狀態更新：進入需動作狀態時，額外派送 action 通知（補查 title 供顯示）
  if (event === 'task:updated' && data && ACTION_STATUSES.has(data.status)) {
    _dispatchAction(userId, data.taskId, data.status).catch(() => {});
  }
}

async function _dispatchConflictToAdmins(taskId) {
  const { rows } = await query("SELECT id FROM users WHERE role = 'admin'");
  await Promise.all(rows.map(r => _dispatchAction(r.id, taskId, 'merge_conflict')));
}

async function notifyProjectReleaseFailure(projectId, projectName, tasks) {
  const { rows: platformAdmins } = await query("SELECT id FROM users WHERE role = 'admin'");
  const { rows: companyAdmins } = await query(
    `SELECT u.id, u.company_id FROM users u
       JOIN project_companies pc ON pc.company_id = u.company_id
      WHERE pc.project_id = $1 AND u.role = 'company_admin'`, [projectId]
  );
  const taskIds = (tasks || []).map(t => t.id);
  const { rows: taskCompanies } = taskIds.length ? await query(
    `SELECT t.id, u.company_id FROM tasks t JOIN users u ON u.id = t.user_id
      WHERE t.id IN (${taskIds.map((_, i) => `$${i + 1}`).join(',')})`, taskIds
  ) : { rows: [] };
  const taskByCompany = new Map(taskCompanies.map(t => [Number(t.company_id), t.id]));
  const summary = '客戶正式區部署失敗；請檢查程式檔案還原結果，資料庫改動不會還原。';
  const recipients = new Map(platformAdmins.map(r => [r.id, taskIds[0] || null]));
  for (const admin of companyAdmins) recipients.set(admin.id, taskByCompany.get(Number(admin.company_id)) || null);
  for (const [userId, taskId] of recipients) {
    if (taskId) await addInboxEvent(userId, taskId, 'release_failure', { status: 'release_failed', summary }).catch(() => {});
    notifyAction(userId, { taskId, status: 'release_failed', label: '正式部署失敗', title: projectName, projectId, summary, persisted: !!taskId });
  }
}

async function notifyProjectMergeFailure(projectId, projectName) {
  const { rows: admins } = await query("SELECT id FROM users WHERE role = 'admin'");
  const { rows: [pending] } = await query(
    'SELECT id FROM tasks WHERE project_id = $1 AND approved_at IS NOT NULL AND merged_to_main_at IS NULL ORDER BY approved_at LIMIT 1',
    [projectId]
  );
  const taskId = pending?.id || null;
  const summary = '上正式合併 main 失敗；任務尚未標記已上正式，請平台管理員處理。';
  for (const admin of admins) {
    if (taskId) await addInboxEvent(admin.id, taskId, 'release_failure', { status: 'merge_failed', summary }).catch(() => {});
    notifyAction(admin.id, { taskId, status: 'merge_failed', label: '上正式合併失敗', title: projectName, projectId, summary, persisted: !!taskId });
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

module.exports = { setIo, emitToUser, emitAll, notifyAction, notifyProjectReleaseFailure, notifyProjectMergeFailure, registerChannel, ACTION_STATUSES };
