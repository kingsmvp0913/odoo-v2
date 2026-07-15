/**
 * teams.js — Microsoft Teams Graph API integration
 *
 * Pipeline isolation: all notifications go through an in-memory queue.
 * enqueue() returns immediately; the queue drains in the background.
 * Teams errors never reach the pipeline.
 */
const https = require('https');
const { query } = require('./db');

const STATUS_DISPLAY = {
  new: '⚪ 新任務', analysis_running: '🔵 分析中', confirm_pending: '🟡 等待確認',
  confirm_answered: '🔵 已回覆', branch_pending: '🔵 準備分支',
  coding_running: '🔵 開發中', qa_running: '🔵 QA', merge_running: '🔵 併入測試',
  deploy_testing: '🔵 部署測試區', playwright_running: '🔵 E2E 測試',
  spec_review: '🟠 等待規格確認',
  review_pending: '🟢 等待審核', wiki_updating: '🔵 更新文件',
  done: '✅ 完成', stopped: '🔴 失敗待確認', merge_conflict: '🔴 合併衝突',
  cs_running: '🔵 客服分析', cs_reply_pending: '🟡 等候送出', cs_data_needed: '🟡 需補充資料'
};

let _tokenCache = { token: null, expiresAt: 0 };

function resetTokenCache() { _tokenCache = { token: null, expiresAt: 0 }; }

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isConfigured(s) {
  return !!(s?.tenant_id && s?.client_id && s?.client_secret && s?.team_id && s?.channel_id);
}

async function getSettings() {
  try {
    const { rows } = await query('SELECT * FROM teams_settings WHERE id = 1');
    return rows[0] || null;
  } catch { return null; }
}

function httpPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'POST', headers: { 'Content-Length': Buffer.byteLength(body), ...headers } },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, data: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpPatch(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'PATCH', headers: { 'Content-Length': Buffer.byteLength(body), ...headers } },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          if (res.statusCode === 204) return resolve({ status: 204, data: null });
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, data: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getAccessToken(settings) {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
  const body = `grant_type=client_credentials&client_id=${encodeURIComponent(settings.client_id)}&client_secret=${encodeURIComponent(settings.client_secret)}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default`;
  const { status, data } = await httpPost(
    'login.microsoftonline.com',
    `/${settings.tenant_id}/oauth2/v2.0/token`,
    body,
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  if (status >= 400 || !data.access_token) {
    throw new Error(data.error_description || data.error || `Token fetch failed (${status})`);
  }
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

async function graphPost(apiPath, body, token) {
  const bodyStr = JSON.stringify(body);
  const { status, data } = await httpPost(
    'graph.microsoft.com',
    `/v1.0${apiPath}`,
    bodyStr,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  );
  if (status >= 400) throw Object.assign(new Error(`Graph ${status}: ${data?.error?.message || JSON.stringify(data)}`), { statusCode: status });
  return data;
}

async function graphPatch(apiPath, body, token) {
  const bodyStr = JSON.stringify(body);
  const { status, data } = await httpPatch(
    'graph.microsoft.com',
    `/v1.0${apiPath}`,
    bodyStr,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  );
  if (status >= 400) throw Object.assign(new Error(`Graph PATCH ${status}: ${data?.error?.message || JSON.stringify(data)}`), { statusCode: status });
  return data;
}

function buildTaskUrl(task, settings) {
  const taskId = task.task_id || '';
  if (taskId.startsWith('task_odoo_') && settings.odoo_base_url) {
    const id = taskId.replace('task_odoo_', '');
    return `${settings.odoo_base_url}/web#id=${id}&model=project.task`;
  }
  if (taskId.startsWith('task_service_') && settings.eservice_base_url) {
    const id = taskId.replace('task_service_', '');
    return `${settings.eservice_base_url}/task/${id}`;
  }
  return null;
}

function buildMentions(mentionUsers) {
  if (!mentionUsers?.length) return { html: '', mentions: [] };
  const mentions = mentionUsers.map((u, i) => ({
    id: i,
    mentionText: u.name,
    mentioned: {
      user: { displayName: u.name, id: u.id, '@odata.type': '#microsoft.graph.teamworkUserIdentity', userIdentityType: 'aadUser' }
    }
  }));
  const html = mentionUsers.map(u => `<at>${esc(u.name)}</at>`).join(' ') + ' ';
  return { html, mentions };
}

function buildMessageContent(task, settings, mentionUsers) {
  const statusLabel = STATUS_DISPLAY[task.status] || task.status;
  const url = buildTaskUrl(task, settings);
  const urlHtml = url ? `<a href="${url}">在系統查看 ↗</a>` : '';
  const source = task.source === 'service' ? 'eService' : 'Odoo';
  const summary = (task.original_text || '').substring(0, 400).replace(/\n/g, '<br/>');

  const { html: mentionHtml, mentions } = buildMentions(mentionUsers || []);

  const content = [
    mentionHtml,
    `<h3>${esc(task.task_id || '')} &nbsp;${esc(task.title || '（無標題）')}</h3>`,
    `<p><strong>狀態：</strong>${statusLabel} &nbsp;|&nbsp; <strong>來源：</strong>${source}</p>`,
    summary ? `<p><strong>摘要：</strong>${summary}</p>` : '',
    urlHtml ? `<p>${urlHtml}</p>` : ''
  ].filter(Boolean).join('\n');

  const body = { body: { contentType: 'html', content } };
  if (mentions.length) body.mentions = mentions;
  return body;
}

async function notifyTask(taskId) {
  const settings = await getSettings();
  if (!isConfigured(settings)) return;

  const { rows: [task] } = await query(
    'SELECT id, task_id, title, original_text, status, source, teams_message_id, user_id FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task) return;

  // Fetch task owner's personal Teams mention info from their settings
  let mentionUsers = [];
  if (task.user_id) {
    const { rows: [owner] } = await query(
      `SELECT display_name, odoo_settings->>'teams_user_id' AS teams_user_id
       FROM users WHERE id = $1`,
      [task.user_id]
    );
    if (owner?.teams_user_id && owner?.display_name) {
      mentionUsers = [{ id: owner.teams_user_id, name: owner.display_name }];
    }
  }

  const token = await getAccessToken(settings);
  const channelPath = `/teams/${settings.team_id}/channels/${settings.channel_id}/messages`;

  if (!task.teams_message_id) {
    const msgBody = buildMessageContent(task, settings, mentionUsers);
    const result = await graphPost(channelPath, msgBody, token);
    if (result?.id) {
      await query('UPDATE tasks SET teams_message_id = $2 WHERE id = $1', [taskId, result.id]);
    }
  } else {
    const msgBody = buildMessageContent(task, settings, []);
    const msgPath = `${channelPath}/${task.teams_message_id}`;
    try {
      await graphPatch(msgPath, msgBody, token);
    } catch {
      const label = STATUS_DISPLAY[task.status] || task.status;
      await graphPost(`${msgPath}/replies`, {
        body: { contentType: 'html', content: `<p>狀態更新：<strong>${label}</strong></p>` }
      }, token);
    }
  }
}

async function notifyQuestion(taskId) {
  const settings = await getSettings();
  if (!isConfigured(settings)) return;

  const { rows: [task] } = await query(
    'SELECT id, teams_message_id, analysis_yaml FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task?.teams_message_id) return;

  let questions = [];
  if (task.analysis_yaml) {
    try {
      const yaml = require('js-yaml');
      // js-yaml v4: load() uses CORE_SCHEMA by default (no arbitrary code execution)
      const parsed = yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA });
      if (parsed && typeof parsed === 'object') {
        // Nested format (CLAUDE.md standard): clarification_channel.questions: []
        if (Array.isArray(parsed.clarification_channel?.questions)) {
          questions = parsed.clarification_channel.questions.filter(q => typeof q === 'string');
        // Flat array format (legacy)
        } else if (Array.isArray(parsed.clarification_channel)) {
          questions = parsed.clarification_channel.filter(q => typeof q === 'string');
        }
      }
    } catch {}
  }
  if (!questions.length) return;

  const token = await getAccessToken(settings);
  const qHtml = questions.map((q, i) => `<p>${i + 1}. ${esc(String(q))}</p>`).join('');
  const msgPath = `/teams/${settings.team_id}/channels/${settings.channel_id}/messages/${task.teams_message_id}/replies`;
  await graphPost(msgPath, {
    body: { contentType: 'html', content: `<p><strong>❓ 需要確認以下問題：</strong></p>${qHtml}` }
  }, token);
}

async function sendTestMessage(settings) {
  const token = await getAccessToken(settings);
  const path = `/teams/${settings.team_id}/channels/${settings.channel_id}/messages`;
  const result = await graphPost(path, {
    body: { contentType: 'html', content: '<p><strong>✅ Teams 整合測試成功！</strong></p><p>odoo-v2 已成功連線至此頻道。</p>' }
  }, token);
  return result?.id;
}

// --- Notification Queue ---
// Items: { type: 'task' | 'question', taskId: number }
const _queue = [];
let _draining = false;

async function _drain() {
  if (_draining) return;
  _draining = true;
  while (_queue.length > 0) {
    const { type, taskId } = _queue.shift();
    try {
      if (type === 'task') await notifyTask(taskId);
      else if (type === 'question') await notifyQuestion(taskId);
    } catch (e) {
      console.error(`[TEAMS-QUEUE] ${type} taskId=${taskId}:`, e.message);
    }
  }
  _draining = false;
}

function enqueue(type, taskId) {
  _queue.push({ type, taskId });
  setImmediate(_drain); // returns immediately; pipeline never waits
}

module.exports = { enqueue, sendTestMessage, resetTokenCache, isConfigured, getSettings };
