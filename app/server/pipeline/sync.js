const { query } = require('../db');

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
      ['date', 'body'],
      cookies, 20
    );

    const msgLines = messages
      .map(m => { const t = stripHtml(m.body); return t ? `[${m.date}] ${t}` : null; })
      .filter(Boolean).join('\n');

    const original_text = [
      `---id---\n${task.id}`,
      `---title---\n${task.name}`,
      `---project---\n${task.project_id ? task.project_id[1] : '未知專案'}`,
      `---stage---\n${task.stage_id ? task.stage_id[1] : '未知階段'}`,
      `---description---\n${stripHtml(task.description)}`,
      `---message---\n${msgLines || '無訊息內容'}`
    ].join('\n');

    const taskKey = `task_odoo_${task.id}`;
    const existing = await query(
      'SELECT id FROM tasks WHERE user_id = $1 AND task_id = $2',
      [userId, taskKey]
    );
    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO tasks (user_id, task_id, source, title, original_text, status)
         VALUES ($1, $2, 'odoo', $3, $4, 'new')
         ON CONFLICT (user_id, task_id) DO NOTHING`,
        [userId, taskKey, task.name, original_text]
      );
      added++;

      // 自動綁定專案
      const odooProjectName = task.project_id ? task.project_id[1] : null;
      if (odooProjectName) {
        const { rows: [proj] } = await query(
          'SELECT id FROM projects WHERE odoo_project_name = $1 LIMIT 1',
          [odooProjectName]
        );
        if (proj) {
          await query(
            'UPDATE tasks SET project_id = $1 WHERE user_id = $2 AND task_id = $3 AND project_id IS NULL',
            [proj.id, userId, taskKey]
          );
        }
      }
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
      ['date', 'body', 'attachment_ids'],
      cookies, 20
    );

    const msgLines = messages
      .map(m => { const t = stripHtml(m.body); return t ? `[${m.date}] ${t}` : null; })
      .filter(Boolean).join('\n');

    const title = task.name_seq ? `${task.name_seq}: ${task.subject}` : task.subject;
    const original_text = [
      `---id---\n${task.id}`,
      `---title---\n${title}`,
      `---project---\n${task.respondent ? task.respondent[1] : '未知帳號'}`,
      `---stage---\n${task.state === 'draft' ? '未處理' : '處理中'}`,
      `---classification---\n${task.classification ? task.classification[1] : '未分類'}`,
      `---description---\n${stripHtml(task.question_description)}`,
      `---message---\n${msgLines || '無訊息內容'}`
    ].join('\n');

    const taskKey = `task_service_${task.id}`;
    const existing = await query(
      'SELECT id FROM tasks WHERE user_id = $1 AND task_id = $2',
      [userId, taskKey]
    );
    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO tasks (user_id, task_id, source, title, original_text, status, task_type)
         VALUES ($1, $2, 'service', $3, $4, 'cs_running', 'service')
         ON CONFLICT (user_id, task_id) DO NOTHING`,
        [userId, taskKey, title, original_text]
      );
      added++;

      // 自動綁定專案
      const respondentName = task.respondent ? task.respondent[1] : null;
      if (respondentName) {
        const { rows: [proj] } = await query(
          'SELECT id FROM projects WHERE service_respondent_name = $1 LIMIT 1',
          [respondentName]
        );
        if (proj) {
          await query(
            'UPDATE tasks SET project_id = $1 WHERE user_id = $2 AND task_id = $3 AND project_id IS NULL',
            [proj.id, userId, taskKey]
          );
        }
      }
    }
  }
  return { added, found: tasks.length };
}

async function syncUser(userId) {
  const [{ rows: userRows }, { rows: sysRows }] = await Promise.all([
    query('SELECT odoo_settings FROM users WHERE id = $1', [userId]),
    query('SELECT odoo_url, odoo_db, service_url, service_db FROM teams_settings WHERE id = 1')
  ]);
  if (!userRows.length) return { odoo: { added: 0 }, service: { added: 0 } };

  const rawSettings = userRows[0].odoo_settings;
  const userSettings = typeof rawSettings === 'string' ? JSON.parse(rawSettings) : (rawSettings || {});
  const sys = sysRows[0] || {};

  // Global URL+DB from Admin; personal credentials from user settings
  const settings = {
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

module.exports = { syncUser, stripHtml };
