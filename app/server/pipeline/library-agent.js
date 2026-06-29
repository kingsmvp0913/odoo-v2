const fs = require('fs');
const path = require('path');
const { callClaude } = require('./claude-runner');
const { logTokenUsage } = require('./token-logger');
const { query } = require('../db');
const notify = require('../notify');

function _collectManifests(dir, results, limit) {
  if (results.length >= limit || !fs.existsSync(dir)) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (results.length >= limit) return;
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const manifestPath = path.join(dir, entry.name, '__manifest__.py');
      if (fs.existsSync(manifestPath)) {
        try {
          const content = fs.readFileSync(manifestPath, 'utf8').slice(0, 2000);
          results.push({ module: entry.name, content });
        } catch { /* skip unreadable */ }
      } else {
        _collectManifests(path.join(dir, entry.name), results, limit);
      }
    }
  }
}

async function _upsertNode(projectId, parentId, nodeType, slug, title, content) {
  const { rows: [row] } = await query(
    `INSERT INTO wiki_pages (project_id, parent_id, node_type, slug, title, content, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (project_id, slug)
     DO UPDATE SET parent_id=$2, node_type=$3, title=$5, content=$6, updated_at=NOW()
     RETURNING id`,
    [projectId, parentId, nodeType, slug, title, content]
  );
  return row.id;
}

async function _ensureNode(projectId, parentId, nodeType, slug, title, content) {
  await query(
    `INSERT INTO wiki_pages (project_id, parent_id, node_type, slug, title, content)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (project_id, slug) DO NOTHING`,
    [projectId, parentId, nodeType, slug, title, content]
  );
  const { rows: [row] } = await query(
    'SELECT id FROM wiki_pages WHERE project_id=$1 AND slug=$2', [projectId, slug]
  );
  return row.id;
}

function _manifestSummary(mod) {
  const grab = key => {
    const m = mod.content.match(new RegExp(`['"]${key}['"]\\s*:\\s*['"]([^'"]*)['"]`));
    return m ? m[1] : '';
  };
  const name = grab('name') || mod.module;
  const version = grab('version');
  const summary = grab('summary');
  return `# ${name}\n\n`
    + (version ? `**版本：** ${version}\n\n` : '')
    + (summary ? `${summary}\n\n` : '')
    + `> 模組目錄：\`${mod.module}\`。功能頁將於相關任務完成時自動補齊，或按「⟳ 更新」手動生成。`;
}

async function runLibraryAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, analysis_yaml, project_id, title FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task) return;

  if (!task.project_id) {
    try {
      await query("UPDATE tasks SET status='done', updated_at=NOW() WHERE id=$1", [taskId]);
      notify.emitToUser(userId, 'task:updated', { taskId, status: 'done' });
    } catch (err) {
      console.error(`[LIBRARY-AGENT] status update error task ${taskId}:`, err.message);
    }
    return;
  }

  const { rows: logs } = await query(
    'SELECT role, content FROM task_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 20',
    [taskId]
  );
  const logText = logs.reverse().map(l => `[${l.role}] ${l.content}`).join('\n');

  let wikiUpdate = null;
  try {
    const prompt = `你是 Library Agent，負責維護專案 wiki。

根據以下任務資訊，產生一筆 wiki 更新。回傳 JSON 格式（不要其他文字）：
{"slug":"<slug>","title":"<標題>","content":"<Markdown 內容>"}

slug 規則：英文小寫+連字號，描述功能主題（如 "sales-order-flow"）。

任務標題：${task.title || '未命名'}
任務分析：
${task.analysis_yaml || '無'}

執行日誌（最後 20 筆）：
${logText || '無'}`;

    const { text, usage, durationMs } = await callClaude(prompt, signal, { taskId, userId, notify });
    await logTokenUsage({ taskId: task.task_id }, userId, 'wiki', usage, durationMs);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) wikiUpdate = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`[LIBRARY-AGENT] API error task ${taskId}:`, err.message);
  }

  if (wikiUpdate?.slug && wikiUpdate?.title) {
    try {
      await query(
        `INSERT INTO wiki_pages (project_id, slug, title, content, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (project_id, slug)
         DO UPDATE SET title=$3, content=$4, updated_at=NOW()`,
        [task.project_id, wikiUpdate.slug, wikiUpdate.title, wikiUpdate.content || '']
      );
    } catch (err) {
      console.error(`[LIBRARY-AGENT] wiki upsert error task ${taskId}:`, err.message);
    }
  }

  try {
    await query("UPDATE tasks SET status='done', updated_at=NOW() WHERE id=$1", [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'done' });
  } catch (err) {
    console.error(`[LIBRARY-AGENT] status update error task ${taskId}:`, err.message);
  }
}

async function initProjectWiki(projectId, userId, signal) {
  const { rows: [project] } = await query('SELECT * FROM projects WHERE id=$1', [projectId]);
  if (!project) { const e = new Error('Project not found'); e.status = 404; throw e; }

  const { rows: readyRepos } = await query(
    "SELECT id, label, local_path FROM project_repos WHERE project_id=$1 AND clone_status='done' AND local_path IS NOT NULL",
    [projectId]
  );
  if (!readyRepos.length) {
    const e = new Error('尚未有已 clone 完成的 Repo，請先新增並等待 clone 完成'); e.status = 400; throw e;
  }

  const emit = (stage, percent, message) =>
    notify.emitToUser(userId, 'wiki:progress', { projectId, stage, percent, message: message || '' });

  emit('scanning', 10, '掃描模組');
  const manifests = [];
  for (const repo of readyRepos) _collectManifests(repo.local_path, manifests, 15);

  // 1) 專案概論（CLI 一次）
  emit('overview', 40, '產生專案概論');
  const prompt = `你是 Library Agent，負責為 Odoo 專案建立 wiki 的「專案概論」。
根據以下模組的 __manifest__.py，產生一段精簡的專案概論（200-400 字）。
回傳 JSON（不要其他文字）：{"slug":"overview","title":"專案概論","content":"<Markdown>"}

要求：
- content 用繁體中文，說明專案整體用途與包含哪些模組
- 不要逐一複製 manifest 原文，用敘述方式

專案：${project.name}（Odoo ${project.odoo_version}）

${manifests.map(m => `=== ${m.module} ===\n${m.content}`).join('\n\n')}`;

  let overviewTitle = '專案概論';
  let overviewContent = `# ${project.name}\n\n（概論生成失敗，可按「⟳ 更新」重試）`;
  try {
    const { text, usage, durationMs } = await callClaude(prompt, signal, { userId, notify });
    await logTokenUsage({ projectId }, userId, 'wiki', usage, durationMs);
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { const p = JSON.parse(m[0]); overviewTitle = p.title || overviewTitle; overviewContent = p.content || overviewContent; }
  } catch (err) {
    console.error(`[LIBRARY-AGENT] init overview error project ${projectId}:`, err.message);
  }
  const overviewId = await _upsertNode(projectId, null, 'overview', 'overview', overviewTitle, overviewContent);

  // 2) 模組分類骨架（無 AI）
  const total = manifests.length || 1;
  for (let i = 0; i < manifests.length; i++) {
    const mod = manifests[i];
    await _upsertNode(projectId, overviewId, 'module', `module-${mod.module}`, mod.module, _manifestSummary(mod));
    emit('modules', 40 + Math.round(((i + 1) / total) * 55), `建立 ${mod.module}`);
  }

  emit('done', 100, '完成');
  return { ok: true, slug: 'overview', modules: manifests.length };
}

module.exports = { runLibraryAgent, initProjectWiki, _upsertNode, _ensureNode };
