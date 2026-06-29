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

// 為專案初始化「專案總覽」wiki：掃 __manifest__.py → 交給 claude CLI 產生（與其他 agent 一致，免 API key）
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

  // 掃所有 done repo 的 __manifest__.py，最多取 15 個模組
  const manifests = [];
  for (const repo of readyRepos) _collectManifests(repo.local_path, manifests, 15);

  const prompt = `你是 Library Agent，負責為 Odoo 專案建立 wiki。
根據以下模組的 __manifest__.py 內容，產生一個「專案總覽」wiki 頁面。
回傳 JSON（不要其他文字）：{"slug":"overview","title":"專案總覽","content":"<Markdown 內容>"}

要求：
- content 用繁體中文說明各模組功能與用途
- 以 Markdown 格式，每個模組一個小節
- 只描述功能，不要複製原始程式碼

專案：${project.name}（Odoo ${project.odoo_version}）

${manifests.map(m => `=== ${m.module} ===\n${m.content}`).join('\n\n')}`;

  const { text, usage, durationMs } = await callClaude(prompt, signal, { userId, notify });
  await logTokenUsage({ projectId }, userId, 'wiki', usage, durationMs);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) { const e = new Error('Failed to parse Library Agent response'); e.status = 500; throw e; }
  const page = JSON.parse(jsonMatch[0]);

  await query(
    `INSERT INTO wiki_pages (project_id, slug, title, content, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (project_id, slug) DO UPDATE SET title=$3, content=$4, updated_at=NOW()`,
    [projectId, page.slug, page.title, page.content || '']
  );
  return { slug: page.slug };
}

module.exports = { runLibraryAgent, initProjectWiki };
