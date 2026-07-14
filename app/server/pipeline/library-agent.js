const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { runClaude } = require('./claude-runner');
const { parseAgentResult } = require('./agent-result');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
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

// 蒐集某模組目錄下最多 limit 個 .py 檔的檔名 + 前 300 字，作為 refresh 的上下文
function _collectModuleSource(readyRepos, moduleName, limit = 8) {
  // 安全：moduleName 來自 wiki slug，僅允許安全識別字，避免 path traversal
  if (!/^[A-Za-z0-9_]+$/.test(moduleName || '')) return '';
  const out = [];
  for (const repo of readyRepos) {
    if (!repo.local_path) continue;
    const modDir = path.join(repo.local_path, moduleName);
    if (!fs.existsSync(modDir)) continue;
    const walk = dir => {
      if (out.length >= limit) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= limit) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.')) walk(full);
        else if (e.name.endsWith('.py') && e.name !== '__manifest__.py') {
          try {
            const rel = path.relative(modDir, full);
            out.push(`# ${rel}\n${fs.readFileSync(full, 'utf8').slice(0, 300)}`);
          } catch { /* skip */ }
        }
      }
    };
    walk(modDir);
  }
  return out.join('\n\n');
}

async function refreshWikiNode(projectId, slug, userId, signal) {
  const { rows: [node] } = await query(
    'SELECT id, slug, title, content, node_type, parent_id FROM wiki_pages WHERE project_id=$1 AND slug=$2',
    [projectId, slug]
  );
  if (!node) { const e = new Error('Wiki node not found'); e.status = 404; throw e; }
  if (node.node_type === 'notes') { const e = new Error('專案備註為人工維護，不支援重新生成'); e.status = 400; throw e; }

  const { rows: [project] } = await query('SELECT * FROM projects WHERE id=$1', [projectId]);
  const { rows: readyRepos } = await query(
    "SELECT local_path FROM project_repos WHERE project_id=$1 AND clone_status='done' AND local_path IS NOT NULL",
    [projectId]
  );

  const emit = (percent, message) =>
    notify.emitToUser(userId, 'wiki:progress', { projectId, slug, stage: 'refresh', percent, message: message || '' });
  emit(10, '準備重新生成');

  let context;
  if (node.node_type === 'overview') {
    const manifests = [];
    for (const r of readyRepos) _collectManifests(r.local_path, manifests, 15);
    context = `類型：重建專案概論（overview，200-400 字繁中）
回傳 {"slug":"overview","title":"專案概論","content":"<Markdown>"}
專案「${project.name}」

${manifests.map(m => `=== ${m.module} ===\n${m.content}`).join('\n\n')}`;
  } else if (node.node_type === 'module') {
    const moduleName = node.slug.replace(/^module-/, '');
    const src = _collectModuleSource(readyRepos, moduleName);
    context = `類型：重建模組頁（module，繁中 Markdown）
回傳 {"slug":"${node.slug}","title":"${moduleName}","content":"<Markdown>"}
模組「${moduleName}」原始碼節錄：
${src || '（無原始碼）'}`;
  } else {
    const { rows: [parent] } = await query('SELECT slug FROM wiki_pages WHERE id=$1', [node.parent_id]);
    const moduleName = (parent?.slug || '').replace(/^module-/, '') || 'unknown';
    const src = _collectModuleSource(readyRepos, moduleName);
    context = `類型：精修功能頁（function，繁中 Markdown），保留正確內容、補充與修正
回傳 {"slug":"${node.slug}","title":"<標題>","content":"<Markdown>"}
現有內容：
${node.content || '（空）'}

所屬模組「${moduleName}」原始碼節錄：
${src || '（無原始碼）'}`;
  }

  let title = node.title, content = node.content;
  try {
    const agent = loadAgent('library');
    const { text, usage, durationMs } = await runClaude(agent.render({ context }), { signal, userId, model: agent.model, agentType: 'wiki' });
    await logTokenUsage({ projectId }, userId, 'wiki', usage, durationMs);
    const p = await parseAgentResult(text, { parse: JSON.parse, signal, ref: { projectId }, userId });
    if (!p) throw new Error('agent 輸出無法解析為有效 JSON');
    title = p.title || title; content = p.content ?? content;
  } catch (err) {
    await logFailedUsage({ projectId }, userId, 'wiki', err);
    console.error(`[LIBRARY-AGENT] refresh error ${slug}:`, err.message);
    const e = new Error('重新生成失敗：' + err.message); e.status = 500; throw e;
  }

  await query(
    'UPDATE wiki_pages SET title=$3, content=$4, updated_at=NOW() WHERE project_id=$1 AND slug=$2',
    [projectId, slug, title, content]
  );
  emit(100, '完成');
  return { ok: true, slug };
}

async function runLibraryAgent(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, analysis_yaml, project_id, title FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task) return;

  if (!task.project_id) {
    try {
      await query("UPDATE tasks SET status='done', done_at=NOW(), updated_at=NOW() WHERE id=$1", [taskId]);
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

  // parse moduleName 前移：往上補需它定位模組頁、並作為 parents 白名單
  let moduleName = 'uncategorized';
  try { moduleName = (yaml.load(task.analysis_yaml, { schema: yaml.CORE_SCHEMA }) || {}).module || 'uncategorized'; }
  catch { /* keep default */ }
  const moduleSlug = `module-${moduleName}`;

  // 撈現有總覽＋該模組頁內容，供 agent 判斷是否需往上補
  const { rows: [ovRow] } = await query(
    "SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='overview'", [task.project_id]);
  const { rows: [modRow] } = await query(
    'SELECT content FROM wiki_pages WHERE project_id=$1 AND slug=$2', [task.project_id, moduleSlug]);

  let wikiUpdate = null;
  try {
    const agent = loadAgent('library');
    const context = `類型：任務完成紀錄（新增/更新功能頁，並視需要往上修正模組頁/總覽）
slug 規則：英文小寫+連字號，描述功能主題（如 "sales-order-flow"）。
任務標題：${task.title || '未命名'}
任務分析：
${task.analysis_yaml || '無'}

執行日誌（最後 20 筆）：
${logText || '無'}

本任務所屬模組：${moduleName}（模組頁 slug：${moduleSlug}）
現有模組頁內容：
${modRow?.content || '（尚未建立）'}

現有專案總覽內容：
${ovRow?.content || '（尚未建立）'}

若這次功能讓「模組頁」或「總覽」變得有誤或不完整，於 parents 附上修正後內容（只附需要動的頁、保留既有正確內容）；不需要則不附 parents。`;

    const { text, usage, durationMs } = await runClaude(agent.render({ context }), { signal, taskId, userId, model: agent.model, agentType: 'wiki' });
    await logTokenUsage({ taskId: task.task_id }, userId, 'wiki', usage, durationMs);
    wikiUpdate = await parseAgentResult(text, { parse: JSON.parse, signal, ref: { taskId: task.task_id }, userId });
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id }, userId, 'wiki', err);
    if (err.aborted) return; // 手動暫停：狀態留在 wiki_updating，解除暫停後重跑本關，不可直接標 done
    console.error(`[LIBRARY-AGENT] API error task ${taskId}:`, err.message);
  }

  if (wikiUpdate?.slug && wikiUpdate?.title) {
    try {
      // 確保 overview + module 節點存在（不覆寫既有內容）
      const overviewId = await _ensureNode(
        task.project_id, null, 'overview', 'overview', '專案概論',
        '# 專案概論\n\n（尚未建立，可至 Wiki 按「建立 wiki」生成骨架）'
      );
      const moduleId = await _ensureNode(
        task.project_id, overviewId, 'module', moduleSlug, moduleName, `# ${moduleName}`
      );

      // 功能頁：依主題 slug upsert，掛在模組節點下
      await _upsertNode(
        task.project_id, moduleId, 'function',
        wikiUpdate.slug, wikiUpdate.title, wikiUpdate.content || ''
      );

      // 往上補：只允許改「總覽」與本任務模組頁，其餘 slug 忽略（防亂改無關頁）
      const allowed = new Set(['overview', moduleSlug]);
      for (const parent of Array.isArray(wikiUpdate.parents) ? wikiUpdate.parents : []) {
        if (parent && allowed.has(parent.slug) && typeof parent.content === 'string' && parent.content.trim()) {
          await query(
            'UPDATE wiki_pages SET content=$3, updated_at=NOW() WHERE project_id=$1 AND slug=$2',
            [task.project_id, parent.slug, parent.content]
          );
        }
      }
    } catch (err) {
      console.error(`[LIBRARY-AGENT] wiki upsert error task ${taskId}:`, err.message);
    }
  } else {
    // parse 失敗不再靜默跳過卻標 done：留痕 task_logs，讓 wiki 缺頁有跡可循（健檢 F fail-loud）
    await query(
      "INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai',$2)",
      [taskId, '[wiki 更新失敗] library agent 輸出無法解析為有效 JSON，本次未更新 wiki']
    ).catch(() => {});
  }

  try {
    await query("UPDATE tasks SET status='done', done_at=NOW(), updated_at=NOW() WHERE id=$1", [taskId]);
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
  const agent = loadAgent('library');
  const context = `類型：建立專案概論（overview，200-400 字）
回傳 {"slug":"overview","title":"專案概論","content":"<Markdown>"}
要求：content 用繁體中文，說明專案整體用途與包含哪些模組；不要逐一複製 manifest 原文，用敘述方式。
專案：${project.name}（Odoo ${project.odoo_version}）

${manifests.map(m => `=== ${m.module} ===\n${m.content}`).join('\n\n')}`;

  let overviewTitle = '專案概論';
  let overviewContent = `# ${project.name}\n\n（概論生成失敗，可按「⟳ 更新」重試）`;
  try {
    const { text, usage, durationMs } = await runClaude(agent.render({ context }), { signal, userId, model: agent.model, agentType: 'wiki' });
    await logTokenUsage({ projectId }, userId, 'wiki', usage, durationMs);
    const p = await parseAgentResult(text, { parse: JSON.parse, signal, ref: { projectId }, userId });
    if (p) { overviewTitle = p.title || overviewTitle; overviewContent = p.content || overviewContent; }
  } catch (err) {
    await logFailedUsage({ projectId }, userId, 'wiki', err);
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

  // 專案備註：人工維護區塊，AI 不觸碰
  await _ensureNode(projectId, null, 'notes', 'project-notes', '專案備註',
    '# 專案備註\n\n在此記錄專案注意事項、部署環境、聯絡窗口等人工維護的資訊。');

  emit('done', 100, '完成');
  return { ok: true, slug: 'overview', modules: manifests.length };
}

module.exports = { runLibraryAgent, initProjectWiki, refreshWikiNode, _upsertNode, _ensureNode, _collectModuleSource };
