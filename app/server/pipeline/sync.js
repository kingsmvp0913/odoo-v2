const { query } = require('../db');

// 來源對應欄位（odoo_project_name / service_respondent_name）以「一行一個名稱」儲存，
// 比對在 JS 端做（pg-mem 不支援 string_to_array），支援一個專案綁多個來源名稱。
async function findProjectBySourceName(column, name) {
  const target = (name || '').trim();
  if (!target) return null;
  const { rows } = await query(
    `SELECT id, ${column} AS names FROM projects WHERE ${column} IS NOT NULL ORDER BY id`
  );
  for (const r of rows) {
    const list = String(r.names).split('\n').map(s => s.trim()).filter(Boolean);
    if (list.includes(target)) return r.id;
  }
  return null;
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 逐筆寫入外部聊天紀錄，以 external_id 對同一任務做 dedup（sync 增量再同步時只補新的）
async function insertTaskMessages(taskDbId, messages) {
  if (!messages.length) return;
  const { rows: existingRows } = await query(
    'SELECT external_id FROM task_messages WHERE task_id = $1 AND external_id IS NOT NULL',
    [taskDbId]
  );
  const existingIds = new Set(existingRows.map(r => r.external_id));
  for (const m of messages) {
    const extId = String(m.id);
    if (existingIds.has(extId)) continue;
    const text = stripHtml(m.body);
    if (!text) continue;
    await query(
      `INSERT INTO task_messages (task_id, source, external_id, content, occurred_at)
       VALUES ($1, 'sync', $2, $3, $4)`,
      [taskDbId, extId, text, m.date]
    );
    existingIds.add(extId);
  }
}

async function odooAuth(baseUrl, db, login, password) {
  const res = await fetch(`${baseUrl}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params: { db, login, password }
    })
  });
  const cookies = res.headers.get('set-cookie') || '';
  const data = await res.json();
  if (data.error) throw new Error(`Odoo auth failed: ${JSON.stringify(data.error)}`);
  return cookies;
}

async function odooSearchRead(baseUrl, model, domain, fields, cookies, limit = 30) {
  const res = await fetch(`${baseUrl}/web/dataset/call_kw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookies },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params: {
        model, method: 'search_read',
        args: [],
        kwargs: { domain, fields, limit }
      }
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`search_read ${model} failed: ${JSON.stringify(data.error)}`);
  return data.result || [];
}

// 回寫「記錄備註」（mail.mt_note，非公開訊息、不通知客戶、不建活動）
async function odooMessagePost(baseUrl, model, resId, body, cookies) {
  const res = await fetch(`${baseUrl}/web/dataset/call_kw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookies },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params: {
        model, method: 'message_post',
        args: [resId],
        kwargs: { body, subtype_xmlid: 'mail.mt_note' }
      }
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`message_post ${model} failed: ${JSON.stringify(data.error)}`);
  return data.result;
}

// 使用者在詳情頁新增的留言，best-effort 回寫來源系統。呼叫端負責判斷管理者開關是否開啟；
// 這裡只負責「開了就真的呼叫」與「憑證/來源不符就安靜跳過」，錯誤往上拋由呼叫端 catch。
async function writebackTaskMessage(userId, task, content) {
  if (task.source !== 'odoo' && task.source !== 'service') return null;
  const sourceNumId = (task.task_id || '').match(/(\d+)$/)?.[1];
  if (!sourceNumId) return null;

  const settings = await resolveUserOdooSettings(userId);
  if (!settings) return null;

  if (task.source === 'odoo') {
    if (!settings.odoo_url || !settings.odoo_db || !settings.odoo_username || !settings.odoo_password) return null;
    const cookies = await odooAuth(settings.odoo_url, settings.odoo_db, settings.odoo_username, settings.odoo_password);
    return odooMessagePost(settings.odoo_url, 'project.task', parseInt(sourceNumId, 10), content, cookies);
  }

  if (!settings.service_url || !settings.service_db || !settings.service_username || !settings.service_password) return null;
  const cookies = await odooAuth(settings.service_url, settings.service_db, settings.service_username, settings.service_password);
  return odooMessagePost(settings.service_url, 'service.question.feedback', parseInt(sourceNumId, 10), content, cookies);
}

async function syncOdooUser(userId, settings) {
  const { odoo_url, odoo_db, odoo_username, odoo_password, odoo_user_id } = settings;
  if (!odoo_url || !odoo_db || !odoo_username || !odoo_password) return { added: 0 };

  const cookies = await odooAuth(odoo_url, odoo_db, odoo_username, odoo_password);
  const uid = parseInt(odoo_user_id, 10) || 1;

  // user_id works on all Odoo versions; user_ids (Many2many) is for Odoo 16+ only as fallback
  let tasks;
  try {
    tasks = await odooSearchRead(
      odoo_url, 'project.task',
      [['user_id', '=', uid], ['stage_id.fold', '=', false]],
      ['id', 'name', 'project_id', 'stage_id', 'description'],
      cookies
    );
  } catch {
    tasks = await odooSearchRead(
      odoo_url, 'project.task',
      [['user_ids', 'in', [uid]], ['stage_id.fold', '=', false]],
      ['id', 'name', 'project_id', 'stage_id', 'description'],
      cookies
    );
  }

  let added = 0;
  const found = tasks.length;
  for (const task of tasks) {
    const messages = await odooSearchRead(
      odoo_url, 'mail.message',
      [['model', '=', 'project.task'], ['res_id', '=', task.id]],
      ['id', 'date', 'body'],
      cookies, 20
    );

    const original_text = [
      `---id---\n${task.id}`,
      `---title---\n${task.name}`,
      `---project---\n${task.project_id ? task.project_id[1] : '未知專案'}`,
      `---stage---\n${task.stage_id ? task.stage_id[1] : '未知階段'}`,
      `---description---\n${stripHtml(task.description)}`
    ].join('\n');

    const taskKey = `task_odoo_${task.id}`;
    const existing = await query(
      'SELECT id, status, is_hidden FROM tasks WHERE user_id = $1 AND task_id = $2',
      [userId, taskKey]
    );
    if (existing.rows.length === 0) {
      const { rows: [inserted] } = await query(
        `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
         VALUES ($1, $2, 'odoo', $3, $4, 'new')
         ON CONFLICT (user_id, task_id) DO NOTHING
         RETURNING id`,
        [userId, taskKey, task.name, original_text]
      );
      if (inserted) await insertTaskMessages(inserted.id, messages);
      added++;
    } else {
      const t = existing.rows[0];
      // 已完成或已封存的任務不再增量拉聊天紀錄，避免無謂 API 呼叫、也避免已完成任務被新訊息重新攪動
      if (t.status !== 'done' && !t.is_hidden) {
        await insertTaskMessages(t.id, messages);
      }
    }

    // 自動綁定專案（對新任務與既有未綁定任務都生效；project_id IS NULL 保證不動到已綁定者）
    const odooProjectName = task.project_id ? task.project_id[1] : null;
    const projId = await findProjectBySourceName('odoo_project_name', odooProjectName);
    if (projId) {
      await query(
        'UPDATE tasks SET project_id = $1 WHERE user_id = $2 AND task_id = $3 AND project_id IS NULL',
        [projId, userId, taskKey]
      );
    }
  }
  return { added, found };
}

async function syncServiceUser(userId, settings) {
  const { service_url, service_db, service_username, service_password, service_user_id } = settings;
  if (!service_url || !service_db || !service_username || !service_password) return { added: 0 };

  const cookies = await odooAuth(service_url, service_db, service_username, service_password);
  const tasks = await odooSearchRead(
    service_url, 'service.question.feedback',
    [['processing_staff', 'in', [service_user_id || 1]], ['state', 'in', ['draft', 'open']]],
    ['id', 'name_seq', 'subject', 'system', 'state', 'question_description', 'classification', 'respondent', 'file'],
    cookies
  );

  let added = 0;
  for (const task of tasks) {
    const messages = await odooSearchRead(
      service_url, 'mail.message',
      [['model', '=', 'service.question.feedback'], ['res_id', '=', task.id]],
      ['id', 'date', 'body', 'attachment_ids'],
      cookies, 20
    );

    const title = task.name_seq ? `${task.name_seq}: ${task.subject}` : task.subject;
    const original_text = [
      `---id---\n${task.id}`,
      `---title---\n${title}`,
      `---project---\n${task.respondent ? task.respondent[1] : '未知帳號'}`,
      `---stage---\n${task.state === 'draft' ? '未處理' : '處理中'}`,
      `---classification---\n${task.classification ? task.classification[1] : '未分類'}`,
      `---description---\n${stripHtml(task.question_description)}`
    ].join('\n');

    const taskKey = `task_service_${task.id}`;
    const existing = await query(
      'SELECT id, status, is_hidden FROM tasks WHERE user_id = $1 AND task_id = $2',
      [userId, taskKey]
    );
    if (existing.rows.length === 0) {
      const { rows: [inserted] } = await query(
        `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, task_type)
         VALUES ($1, $2, 'service', $3, $4, 'cs_running', 'service')
         ON CONFLICT (user_id, task_id) DO NOTHING
         RETURNING id`,
        [userId, taskKey, title, original_text]
      );
      if (inserted) await insertTaskMessages(inserted.id, messages);
      added++;
    } else {
      const t = existing.rows[0];
      if (t.status !== 'done' && !t.is_hidden) {
        await insertTaskMessages(t.id, messages);
      }
    }

    // 自動綁定專案（對新任務與既有未綁定任務都生效；project_id IS NULL 保證不動到已綁定者）
    const respondentName = task.respondent ? task.respondent[1] : null;
    const projId = await findProjectBySourceName('service_respondent_name', respondentName);
    if (projId) {
      await query(
        'UPDATE tasks SET project_id = $1 WHERE user_id = $2 AND task_id = $3 AND project_id IS NULL',
        [projId, userId, taskKey]
      );
    }
  }
  return { added, found: tasks.length };
}

async function assembleTaskContext(taskId) {
  const { rows: [task] } = await query('SELECT original_text FROM tasks WHERE id = $1', [taskId]);
  if (!task) return '';
  const { rows: messages } = await query(
    'SELECT content, occurred_at FROM task_messages WHERE task_id = $1 ORDER BY occurred_at ASC',
    [taskId]
  );
  const msgLines = messages.map(m => `[${new Date(m.occurred_at).toISOString()}] ${m.content}`).join('\n');
  return `${task.original_text || ''}\n---message---\n${msgLines || '無訊息內容'}`;
}

async function resolveUserOdooSettings(userId) {
  const [{ rows: userRows }, { rows: sysRows }] = await Promise.all([
    query('SELECT odoo_settings FROM users WHERE id = $1', [userId]),
    query('SELECT odoo_url, odoo_db, service_url, service_db FROM teams_settings WHERE id = 1')
  ]);
  if (!userRows.length) return null;

  const rawSettings = userRows[0].odoo_settings;
  const userSettings = typeof rawSettings === 'string' ? JSON.parse(rawSettings) : (rawSettings || {});
  const sys = sysRows[0] || {};

  // Global URL+DB from Admin; personal credentials from user settings
  return {
    odoo_url:          sys.odoo_url     || userSettings.odoo_url,
    odoo_db:           sys.odoo_db      || userSettings.odoo_db,
    service_url:       sys.service_url  || userSettings.service_url,
    service_db:        sys.service_db   || userSettings.service_db,
    odoo_username:     userSettings.odoo_username,
    odoo_password:     userSettings.odoo_password,
    odoo_user_id:      userSettings.odoo_user_id,
    service_username:  userSettings.service_username,
    service_password:  userSettings.service_password,
    service_user_id:   userSettings.service_user_id
  };
}

async function syncUser(userId) {
  const settings = await resolveUserOdooSettings(userId);
  if (!settings) return { odoo: { added: 0 }, service: { added: 0 } };
  if (!settings.odoo_url && !settings.service_url) return { odoo: { added: 0 }, service: { added: 0 } };

  const odoo = await syncOdooUser(userId, settings).catch(err => {
    console.error(`[SYNC] Odoo user ${userId}:`, err.message);
    return { added: 0, error: err.message };
  });
  const service = await syncServiceUser(userId, settings).catch(err => {
    console.error(`[SYNC] Service user ${userId}:`, err.message);
    return { added: 0, error: err.message };
  });
  return { odoo, service };
}

module.exports = { syncUser, stripHtml, resolveUserOdooSettings, assembleTaskContext, writebackTaskMessage };
