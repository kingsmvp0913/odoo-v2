/**
 * agent-session-migrate.js — 切換到 AI 容器那天，把續接中的 session 檔複製進各 scope 家目錄（子專案 0 §6、§9-4）
 * claude 依 cwd 找 session：~/.claude/projects/<cwd 非英數字元換成 -> /<sessionId>.jsonl。
 * 只複製不搬移、不覆寫：原檔留著，舊路徑（開關 off）照樣能續接；容器裡已續接過的新檔不會被蓋掉。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function encodeProjectDir(absPath) { return String(absPath).replace(/[^a-zA-Z0-9]/g, '-'); }

async function planSessionCopies(deps = {}) {
  const d = {
    query: (...a) => require('../db').query(...a),
    getProjectInfo: (...a) => require('../pipeline/task-agent').getProjectInfo(...a),
    worktreeParent: (...a) => require('../pipeline/task-agent').worktreeParent(...a),
    claudeHome: path.join(os.homedir(), '.claude'),
    appDir: path.resolve(__dirname, '..', '..', '..'),
    existsSync: fs.existsSync,
    ...deps,
  };
  const src = path.join(d.claudeHome, 'projects');
  const oldPlatformDir = path.join(src, encodeProjectDir(d.appDir));
  const infoCache = new Map();
  const info = async pid => { if (!infoCache.has(pid)) infoCache.set(pid, await d.getProjectInfo(pid)); return infoCache.get(pid); };
  // 這裡的路徑刻意維持無公司層：切換日要救的是當時唯一存在的那些 session，它們全是內部公司的，
  // 而內部公司的桶子就是這個舊路徑（lib/agent-home.js）。客戶公司當時還沒有任何 session 可搬。
  const scopeHome = pid => path.join(d.appDir, 'data', 'agent-home', `project-${pid}`);
  const dest = pid => path.join(scopeHome(pid), '.claude', 'projects');
  const plans = [];
  const add = (kind, from, to, reason) => { if (d.existsSync(from) && !plans.some(p => p.to === to)) plans.push({ kind, from, to, reason }); };

  const { rows: tasks } = await d.query(
    `SELECT id, task_id, project_id, analysis_session_id, qa_session_id, cs_session_id, clarify_session_id, spec_session_id
       FROM tasks
      WHERE project_id IS NOT NULL
        AND (analysis_session_id IS NOT NULL OR qa_session_id IS NOT NULL OR cs_session_id IS NOT NULL
             OR clarify_session_id IS NOT NULL OR spec_session_id IS NOT NULL)`);
  for (const t of tasks) {
    const pi = await info(t.project_id);
    if (!pi) continue;
    const wt = d.worktreeParent(pi.root, t.task_id);
    const wtExists = d.existsSync(wt);
    if (wtExists) add('dir', path.join(src, encodeProjectDir(wt)), path.join(dest(t.project_id), encodeProjectDir(wt)), `task ${t.id} worktree`);
    if (t.cs_session_id) {
      add('file', path.join(oldPlatformDir, `${t.cs_session_id}.jsonl`), path.join(dest(t.project_id), encodeProjectDir(pi.root), `${t.cs_session_id}.jsonl`), `task ${t.id} cs`);
    }
    if (!wtExists) {
      for (const sid of [t.clarify_session_id, t.spec_session_id].filter(Boolean)) {
        add('file', path.join(oldPlatformDir, `${sid}.jsonl`), path.join(dest(t.project_id), encodeProjectDir(scopeHome(t.project_id)), `${sid}.jsonl`), `task ${t.id} clarify/spec`);
      }
    }
  }

  const { rows: chats } = await d.query(
    'SELECT id, project_id, chat_session_id FROM project_chats WHERE chat_session_id IS NOT NULL AND project_id IS NOT NULL');
  for (const c of chats) {
    const pi = await info(c.project_id);
    if (!pi) continue;
    add('file', path.join(oldPlatformDir, `${c.chat_session_id}.jsonl`), path.join(dest(c.project_id), encodeProjectDir(pi.root), `${c.chat_session_id}.jsonl`), `chat ${c.id}`);
  }
  return plans;
}

function applySessionCopies(plans, deps = {}) {
  const d = { existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, cpSync: fs.cpSync, ...deps };
  let copied = 0; let skipped = 0;
  for (const p of plans) {
    if (d.existsSync(p.to)) { skipped++; continue; }
    d.mkdirSync(path.dirname(p.to), { recursive: true, mode: 0o700 });
    d.cpSync(p.from, p.to, { recursive: p.kind === 'dir', errorOnExist: true, force: false });
    copied++;
  }
  return { copied, skipped };
}

module.exports = { encodeProjectDir, planSessionCopies, applySessionCopies };
