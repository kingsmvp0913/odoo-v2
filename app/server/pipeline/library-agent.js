const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { runAgent } = require('./agent-runner');
const { parseAgentResult } = require('./agent-result');
const { loadAgent } = require('./agent-loader');
const { logTokenUsage, logFailedUsage } = require('./token-logger');
const { query } = require('../db');
const notify = require('../notify');
const { enqueue: enqueueEmbedding } = require('../lib/embedding-index');

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

// description 是頁面清單與搜尋結果**唯一**會回傳的說明欄位（content 不會），agent 靠它決定
// 「要不要打開這一頁」——wikiQuery/SKILL.md 與 cs-capability.md 都把它寫成這組端點省 token 的關鍵。
// 但先前只有排障頁（troubleshooting.js）寫得進去，library agent 產的 overview／module／function
// 三種頁一律是 NULL，等於那條省 token 的路對 95% 的內容根本沒生效，agent 只能退回逐頁抓全文。
// 截斷到 200 字：不截的話清單端點會退化成「小一號的全文」，反而更耗 token。
// 沒帶就不動既有值（COALESCE）：骨架節點與舊資料本來就沒有摘要，不該被洗掉。
const DESC_MAX = 200;
const trimDesc = (d) => {
  const t = String(d || '').trim().replace(/\s+/g, ' ');
  return t ? t.slice(0, DESC_MAX) : null;
};

// ⟳ 精修的長度規則。module／function 頁先前完全沒有閘：`${node.content}` 全文無截斷塞進 prompt、
// 指令又是「保留正確內容、補充與修正」，於是頁面內容與每輪 input token 一起單調成長；撞到模型
// 輸出上限時是靜默截斷，再整份寫回 DB（＝慢性刪內容，而 wiki 沒有版本表可還原）。
// BUDGET：寫進 prompt 的目標長度。概論沿用 library.md 既有的 400 字；模組／功能頁要交代
//   「使用者能做什麼、怎麼一步步操作」，寬一級取 1200 字，與同函式其他上下文同數量級
//   （manifest slice(0,2000)、原始碼 8 檔×300 字）。
// PAGE_MAX_CHARS：現有內容的硬上限，取預算的 5 倍當緩衝。到頂是擋下重生（丟 400 請人工精簡），
//   **不是**截斷後照送——截斷等於把尾段交給 AI 重寫成「不存在」，那正是本次要修的資料流失。
const OVERVIEW_BUDGET_CHARS = 400;
const PAGE_BUDGET_CHARS = 1200;
const PAGE_MAX_CHARS = 6000;

// 「保留既有正確內容」與硬字數上限本質互斥：內容一旦超過上限，兩者不可能同時成立，模型只能自行
// 取捨，而它的取捨是刪字——那一頁的「保留」指示在超過上限後等於無效（overview 原本正是「200-400 字」
// 與「保留正確內容」並列）。故字數一律寫成「目標＋衝突時的裁決順序」而非硬上限。
const lengthRule = (budget) =>
  `長度：目標 ${budget} 字以內。若現有內容已超過，不得為了字數刪除仍然正確的資訊，`
  + `改以合併重複敘述、刪去贅詞的方式收斂；收斂後仍超過就照實超出。`;

async function _upsertNode(projectId, parentId, nodeType, slug, title, content, description) {
  const { rows: [row] } = await query(
    `INSERT INTO wiki_pages (project_id, parent_id, node_type, slug, title, content, description, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (project_id, slug)
     DO UPDATE SET parent_id=$2, node_type=$3, title=$5, content=$6,
                   description=COALESCE($7, wiki_pages.description), updated_at=NOW()
     RETURNING id`,
    [projectId, parentId, nodeType, slug, title, content, trimDesc(description)]
  );
  enqueueEmbedding({ wikiPageId: row.id });
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
  // DO NOTHING 這條路徑上，頁可能是這次新建的、也可能是早就存在的。一律入佇列即可：
  // 內容沒變時 source_hash 會對得上，indexWikiPage 直接跳過，不會白算一次推論。
  enqueueEmbedding({ wikiPageId: row.id });
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
  if (node.node_type === 'troubleshooting') { const e = new Error('疑難排解由排障／客服對話累積，無原始碼可重生'); e.status = 400; throw e; }
  if ((node.content || '').length > PAGE_MAX_CHARS) {
    const e = new Error(`本頁現有內容 ${node.content.length} 字，超過 ${PAGE_MAX_CHARS} 字上限，無法重新生成；請先人工精簡後再試`);
    e.status = 400; throw e;
  }

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
    context = `類型：精修專案概論（overview，繁中），保留正確內容、補充與修正
${lengthRule(OVERVIEW_BUDGET_CHARS)}
回傳 {"slug":"overview","title":"專案概論","content":"<Markdown>"}
專案「${project.name}」

現有內容：
${node.content || '（空）'}

各模組 manifest：
${manifests.map(m => `=== ${m.module} ===\n${m.content}`).join('\n\n')}`;
  } else if (node.node_type === 'module') {
    const moduleName = node.slug.replace(/^module-/, '');
    const src = _collectModuleSource(readyRepos, moduleName);
    context = `類型：精修模組頁（module，繁中 Markdown），保留正確內容、補充與修正
${lengthRule(PAGE_BUDGET_CHARS)}
回傳 {"slug":"${node.slug}","title":"${moduleName}","content":"<Markdown>"}
現有內容：
${node.content || '（空）'}

模組「${moduleName}」原始碼節錄：
${src || '（無原始碼）'}`;
  } else {
    const { rows: [parent] } = await query('SELECT slug FROM wiki_pages WHERE id=$1', [node.parent_id]);
    const moduleName = (parent?.slug || '').replace(/^module-/, '') || 'unknown';
    const src = _collectModuleSource(readyRepos, moduleName);
    context = `類型：精修功能頁（function，繁中 Markdown），保留正確內容、補充與修正
${lengthRule(PAGE_BUDGET_CHARS)}
回傳 {"slug":"${node.slug}","title":"<標題>","content":"<Markdown>"}
現有內容：
${node.content || '（空）'}

所屬模組「${moduleName}」原始碼節錄：
${src || '（無原始碼）'}`;
  }

  let title = node.title, content = node.content, description = null;
  try {
    const agent = loadAgent('library');
    const { text, usage, durationMs } = await runAgent(agent.render({ context }), { signal, userId, model: agent.model, provider: agent.provider, effort: agent.effort, agentType: 'wiki' });
    await logTokenUsage({ projectId }, userId, 'wiki', usage, durationMs);
    const p = await parseAgentResult(text, { parse: JSON.parse, signal, ref: { projectId }, userId });
    if (!p) throw new Error('agent 輸出無法解析為有效 JSON');
    // 空字串是合法 JSON，parseAgentResult 會放行；`??` 只擋 null/undefined，於是 agent 一句
    // {"content":""} 就讓下面那條 UPDATE 把整頁寫空——wiki 沒有版本表也沒有備份，寫空即不可還原。
    // 同檔 initProjectWiki 用的是安全寫法（`p.content || overviewContent`），這裡沿用其判斷並加 trim。
    // 空白內容不是「使用者要清空這一頁」而是這次重生失敗，故 throw 而非默默保留舊內容：
    // 靜默保留再回「已重新生成」，使用者會以為精修過了，下次也不會再按。
    if (typeof p.content !== 'string' || !p.content.trim()) throw new Error('agent 未回有效 content，已保留原內容未覆蓋');
    title = p.title || title; content = p.content; description = p.description || null;
  } catch (err) {
    await logFailedUsage({ projectId }, userId, 'wiki', err);
    console.error(`[LIBRARY-AGENT] refresh error ${slug}:`, err.message);
    const e = new Error('重新生成失敗：' + err.message); e.status = 500; throw e;
  }

  const { rows: [refreshed] } = await query(
    `UPDATE wiki_pages SET title=$3, content=$4,
            description=COALESCE($5, description), updated_at=NOW()
      WHERE project_id=$1 AND slug=$2
      RETURNING id`,
    [projectId, slug, title, content, trimDesc(description)]
  );
  if (refreshed) enqueueEmbedding({ wikiPageId: refreshed.id });
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

  // 撈該模組下現有功能頁（slug + title），供 agent 判斷這次是否為既有功能的更新，
  // 避免同一功能因不同任務生成不同 slug 而被重複新增成多頁
  const { rows: existingFns } = await query(
    `SELECT w.slug, w.title FROM wiki_pages w
       JOIN wiki_pages m ON m.id = w.parent_id
      WHERE w.project_id=$1 AND m.slug=$2 AND w.node_type='function'
      ORDER BY w.title`,
    [task.project_id, moduleSlug]
  );

  let wikiUpdate = null;
  let agentError = null; // agent 執行失敗的真因；與「回了東西但解析不出」是兩種病，訊息不可共用
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
本模組現有功能頁（若這次任務是修改其中某個既有功能，請沿用該頁 slug 以「更新」它，不要用新 slug 重複新增；確實是新功能才給新 slug）：
${existingFns.length ? existingFns.map(f => `- ${f.slug}：${f.title}`).join('\n') : '（尚無）'}

現有模組頁內容：
${modRow?.content || '（尚未建立）'}

現有專案總覽內容：
${ovRow?.content || '（尚未建立）'}

若這次功能讓「模組頁」或「總覽」變得有誤或不完整，於 parents 附上修正後內容（只附需要動的頁、保留既有正確內容）；不需要則不附 parents。`;

    const { text, usage, durationMs } = await runAgent(agent.render({ context }), { signal, taskId, userId, model: agent.model, provider: agent.provider, effort: agent.effort, agentType: 'wiki' });
    await logTokenUsage({ taskId: task.task_id }, userId, 'wiki', usage, durationMs);
    wikiUpdate = await parseAgentResult(text, { parse: JSON.parse, signal, ref: { taskId: task.task_id }, userId });
  } catch (err) {
    await logFailedUsage({ taskId: task.task_id }, userId, 'wiki', err);
    if (err.aborted) return; // 手動暫停：狀態留在 wiki_updating，解除暫停後重跑本關，不可直接標 done
    console.error(`[LIBRARY-AGENT] API error task ${taskId}:`, err.message);
    agentError = err.message;
  }

  // 任務照樣會標 done，所以 wiki 沒更新時的唯一線索就是這條 log——訊息必須是真因，
  // 謊報成「無法解析為有效 JSON」會把排查的人導去查 prompt／契約而不是去看服務狀態。
  const logWikiFailure = msg => query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1,'ai',$2)", [taskId, msg]
  ).catch(() => {});

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
      // 防呆：功能頁 slug 不得撞到骨架保留節點（overview / module-* / project-notes）。
      // _upsertNode 的 ON CONFLICT 會覆寫 node_type/parent_id，撞名時會把骨架節點翻成 function、
      // 重新掛到別的 parent，造成父子環路→整棵樹在前端斷開全隱形（曾實際發生於 overview）。
      // troubleshooting 是排障／客服對話累積的容器頁（wiki-routes 明擋刪除與重生），
      // 撞名會把它翻成 function 並改掛到模組節點下，整包排障紀錄連子節點在樹上錯位。
      let fnSlug = wikiUpdate.slug;
      if (fnSlug === 'overview' || fnSlug === 'project-notes' || fnSlug === 'troubleshooting' || fnSlug.startsWith('module-')) {
        fnSlug = `fn-${fnSlug}`;
        console.warn(`[LIBRARY-AGENT] task ${taskId}: 功能頁 slug 撞保留字「${wikiUpdate.slug}」，改用「${fnSlug}」避免覆寫骨架節點`);
      }
      // 同功能去重：同模組下若已有相同標題的功能頁，沿用既有 slug 改為更新，
      // 避免 agent 生成新 slug 導致同一功能被重複新增（agent 未重用時的最後防線）
      const { rows: [dup] } = await query(
        "SELECT slug FROM wiki_pages WHERE project_id=$1 AND parent_id=$2 AND node_type='function' AND title=$3 LIMIT 1",
        [task.project_id, moduleId, wikiUpdate.title]
      );
      if (dup && dup.slug !== fnSlug) {
        console.warn(`[LIBRARY-AGENT] task ${taskId}: 已有同標題功能頁「${wikiUpdate.title}」(slug=${dup.slug})，改為更新既有頁，不以新 slug「${fnSlug}」新增`);
        fnSlug = dup.slug;
      }
      await _upsertNode(
        task.project_id, moduleId, 'function',
        fnSlug, wikiUpdate.title, wikiUpdate.content || '', wikiUpdate.description
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
      // 寫入炸掉不能只有 console.error：任務仍會標 done，使用者看到「完成」卻找不到新頁，
      // 平台端也查無此案（健檢 F fail-loud）
      console.error(`[LIBRARY-AGENT] wiki upsert error task ${taskId}:`, err.message);
      await logWikiFailure(`[wiki 更新失敗] 寫入 wiki 時發生錯誤：${err.message}`);
    }
  } else if (agentError) {
    await logWikiFailure(`[wiki 更新失敗] library agent 執行失敗：${agentError}，本次未更新 wiki`);
  } else {
    // parse 失敗不再靜默跳過卻標 done：留痕 task_logs，讓 wiki 缺頁有跡可循（健檢 F fail-loud）
    await logWikiFailure('[wiki 更新失敗] library agent 輸出無法解析為有效 JSON，本次未更新 wiki');
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
  let overviewDesc = null;
  try {
    const { text, usage, durationMs } = await runAgent(agent.render({ context }), { signal, userId, model: agent.model, provider: agent.provider, effort: agent.effort, agentType: 'wiki' });
    await logTokenUsage({ projectId }, userId, 'wiki', usage, durationMs);
    const p = await parseAgentResult(text, { parse: JSON.parse, signal, ref: { projectId }, userId });
    if (p) { overviewTitle = p.title || overviewTitle; overviewContent = p.content || overviewContent; overviewDesc = p.description || overviewDesc; }
  } catch (err) {
    await logFailedUsage({ projectId }, userId, 'wiki', err);
    console.error(`[LIBRARY-AGENT] init overview error project ${projectId}:`, err.message);
  }
  const overviewId = await _upsertNode(projectId, null, 'overview', 'overview', overviewTitle, overviewContent, overviewDesc);

  // 2) 模組分類骨架（無 AI）
  const total = manifests.length || 1;
  for (let i = 0; i < manifests.length; i++) {
    const mod = manifests[i];
    // 骨架頁沒有 AI 參與，用 manifest 抓到的摘要當 description——比 NULL 有用，之後 refresh 會蓋掉
    await _upsertNode(projectId, overviewId, 'module', `module-${mod.module}`, mod.module,
      _manifestSummary(mod), _manifestSummary(mod));
    emit('modules', 40 + Math.round(((i + 1) / total) * 55), `建立 ${mod.module}`);
  }

  // 專案備註：人工維護區塊，AI 不觸碰。預設空白——有內容（trim 非空）才會注入各開發關卡（吃 cache），
  // 說明文字改放 Wiki UI 的灰字提示，不寫進 content 以免被當「有備註」注入。
  await _ensureNode(projectId, null, 'notes', 'project-notes', '專案備註', '');

  emit('done', 100, '完成');
  return { ok: true, slug: 'overview', modules: manifests.length };
}

module.exports = { runLibraryAgent, initProjectWiki, refreshWikiNode, _upsertNode, _ensureNode, _collectModuleSource };
