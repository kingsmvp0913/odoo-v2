// app/server/lib/agent-mounts.js
/**
 * agent-mounts.js — 依 agent profile 解出容器掛載清單（子專案 0 §4.2、§4.5；計畫 X7）
 *
 * 全部同構路徑（容器內外相同），來源一律由既有變數推導，不寫死。
 * 不變量：不掛 APP_DIR 本體、APP_DIR/data（config.json、ai.sock）、別專案路徑、odoo-envs 的 odoo.conf（含 DB 密碼）。
 */
const fs = require('fs');
const path = require('path');
const { gitDirMounts } = require('./agent-sandbox');
const { findAdminDir } = require('./worktree-guard');
const { objectDirFor } = require('./agent-objects');
const { chatAiOutbox } = require('./chat-ai-files');

const MAX_LOG_FILES = 50;
const LOG_RE = /^(deploy|e2e)-task(\d+)-/;

// 依 scope 掛進容器家目錄的 skill（計畫 X9）。白名單是刻意的：平台自己的 skill 教的是平台內部操作，
// 交給客戶 agent 等於把不該有的能力交出去（同 pipeline/worktree-skills.js 的理由）。
const SKILLS_BY_SCOPE = Object.freeze({
  project: Object.freeze(['getSQL', 'getLog', 'wikiQuery', 'odooGlossary', 'odooDev']),
  'internal-audit': Object.freeze(['healthCheck', 'platformDB', 'wikiQuery', 'odooGlossary']),
  'internal-fix': Object.freeze(['platformDev', 'healthCheck', 'odooGlossary']),
  none: Object.freeze([]),
});

function platformPaths(appDir) {
  return {
    skills: path.join(appDir, '.agents', 'skills'),
    hooks: path.join(appDir, 'app', 'server', 'pipeline', 'hooks'),
    mcp: path.join(appDir, 'app', 'server', 'pipeline', 'mcp'),
    gitDir: path.join(appDir, '.git'),
    nodeModules: path.join(appDir, 'app', 'node_modules'),
    fixWorktreeRoot: process.env.FIX_WORKTREE_DIR || path.join(appDir, '.claude', 'worktrees'),
  };
}

function defaults(appDir) {
  return {
    query: (...a) => require('../db').query(...a),
    getProjectInfo: (...a) => require('../pipeline/task-agent').getProjectInfo(...a),
    worktreeParent: (...a) => require('../pipeline/task-agent').worktreeParent(...a),
    majorOf: (...a) => require('./odoo-core-src').majorOf(...a),
    existsSync: fs.existsSync, readdirSync: fs.readdirSync, statSync: fs.statSync,
    mkdirSync: fs.mkdirSync,
    coreSrcRoot: require('./odoo-core-src').CORE_SRC_ROOT,
    uploadRoot: require('./attachments').uploadRoot(),
    envBase: process.env.ODOO_ENV_BASE || path.resolve(appDir, 'odoo-envs'),
    logDir: process.env.DEPLOY_LOG_DIR || path.join(appDir, 'data', 'logs'),
    fixWorktreeRoot: platformPaths(appDir).fixWorktreeRoot,
  };
}

// agent 還沒起跑就確定組不出掛載的設定錯誤——與「跑到一半被中斷」不同，重跑同一份輸入永遠是同一個
// 結果。標記讓呼叫端認得出來（chat-agent.js 據此改寫使用者看到的收尾訊息，不再叫人重新發送）。
// userAction＝使用者自己做得到的下一步，只有丟錯的這裡知道是什麼。
function setupError(message, userAction) {
  return Object.assign(new Error(message), { agentSetupError: true, userAction });
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function resolveSandboxMounts(ctx, deps = {}) {
  const d = { ...defaults(ctx.appDir), ...deps };
  const pp = platformPaths(ctx.appDir);
  const mounts = [];
  const ro = src => { if (d.existsSync(src)) mounts.push({ source: src, readonly: true }); };

  ro(pp.skills); ro(pp.hooks); ro(pp.mcp);

  const { profile } = ctx;
  let kind = profile.mount;
  if (profile.scope === 'project' && ctx.projectId == null) kind = 'none';
  const skillScope = kind === 'none' && profile.scope === 'project' ? 'none' : profile.scope;
  const mountSkill = (name) => {
    const src = path.join(pp.skills, name);
    if (!d.existsSync(src)) return;
    const target = path.join(ctx.home, '.claude', 'skills', name);
    d.mkdirSync(target, { recursive: true });
    mounts.push({ source: src, target, readonly: true });
  };
  for (const name of SKILLS_BY_SCOPE[skillScope] || []) mountSkill(name);
  let workdir = ctx.home;

  const attach = () => {
    if (profile.attachments === 'task' && ctx.taskDbId != null) ro(path.join(d.uploadRoot, `task_${ctx.taskDbId}`));
    if (profile.attachments === 'chat' && ctx.chatId != null) ro(path.join(d.uploadRoot, `chat_${ctx.chatId}`));
    if (profile.outbox && ctx.chatId != null) {
      // 對話 AI 交檔案給使用者的出貨箱：唯讀的附件目錄底下開一個可寫的子掛載（父先子後已排序）。
      // 來源目錄必須先在宿主建好——交給 docker 自動建會是 root 擁有，容器以宿主 uid 跑就寫不進去。
      // chatFiles skill 只在這裡掛：它教的是往出貨箱寫檔，沒有出貨箱的 agent 拿到只會是誤導。
      const outbox = chatAiOutbox(ctx.chatId, d.uploadRoot);
      d.mkdirSync(outbox, { recursive: true });
      mounts.push({ source: outbox, readonly: false });
      mountSkill('chatFiles');
    }
    if (profile.attachments === 'feedback') for (const id of ctx.feedbackIds || []) ro(path.join(d.uploadRoot, `feedback_${id}`));
  };

  if (kind === 'platform-clean') {
    const wt = ctx.platformWorktree;
    if (!wt || !isInside(wt, d.fixWorktreeRoot) || !path.basename(wt).startsWith('ro-') || !d.existsSync(wt)) {
      throw new Error(`內部 AI 的乾淨 worktree 不存在或不在 ${d.fixWorktreeRoot}/ro-*：${wt}`);
    }
    mounts.push({ source: wt, readonly: true }, { source: pp.gitDir, readonly: true });
    return { mounts, workdir: wt };
  }

  if (kind === 'platform-fix') {
    const wt = ctx.cwd;
    if (!wt || !isInside(wt, d.fixWorktreeRoot) || !path.basename(wt).startsWith('fix-') || !d.existsSync(wt)) {
      throw new Error(`修正工作區 cwd 不在 ${d.fixWorktreeRoot}/fix-*：${wt}`);
    }
    const admin = path.join(pp.gitDir, 'worktrees', path.basename(wt));
    if (!d.existsSync(admin)) throw new Error(`找不到修正工作區的 git admin 目錄：${admin}`);
    mounts.push({ source: wt, readonly: false }, { source: pp.gitDir, readonly: true }, { source: admin, readonly: false });
    ro(pp.nodeModules);
    attach();
    return { mounts, workdir: wt };
  }

  if (kind === 'none') { attach(); return { mounts, workdir }; }

  const info = await d.getProjectInfo(ctx.projectId);
  if (!info) throw setupError(`專案 ${ctx.projectId} 沒有 clone 完成的 repo，無法組容器掛載`, '請到專案頁的「Git Repositories」確認 repo 已 clone 完成（還在 clone 就等它跑完；顯示失敗的話按 ↺ 重新 clone），完成後再發一次。');

  const projectData = () => {
    const major = d.majorOf(info.odoo_version);
    if (major) ro(path.join(d.coreSrcRoot, major));
    if (info.enterprise_src) ro(info.enterprise_src);
  };

  let wt = null;
  let taskTaskId = null;
  if (ctx.taskDbId != null && (kind === 'task-worktree' || kind === 'task-worktree-or-none' || kind === 'task-worktree-or-clone')) {
    const { rows: [t] } = await d.query('SELECT task_id, project_id FROM tasks WHERE id=$1', [ctx.taskDbId]);
    if (!t || Number(t.project_id) !== Number(ctx.projectId)) throw new Error(`任務 ${ctx.taskDbId} 不屬於專案 ${ctx.projectId}`);
    wt = d.worktreeParent(info.root, t.task_id);
    taskTaskId = t.task_id;
  }

  const useWorktree = () => {
    if (!wt || !d.existsSync(wt)) throw new Error(`任務 worktree 不存在：${wt}`);
    if (ctx.cwd !== undefined && ctx.cwd !== wt) throw new Error(`呼叫端 cwd（${ctx.cwd}）與任務 worktree（${wt}）不符`);
    mounts.push({ source: wt, readonly: false });
    // D2：共用物件庫唯讀，commit 寫進這張任務自己的物件庫（同專案 repo 共用一個，見 lib/agent-objects.js）
    const branch = `task/${taskTaskId}`;
    const objDir = objectDirFor(info.repos[0].local_path, branch);
    d.mkdirSync(objDir, { recursive: true, mode: 0o700 });
    mounts.push({ source: objDir, readonly: false });
    const env = {
      GIT_OBJECT_DIRECTORY: objDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: info.repos.map(r => path.join(r.local_path, '.git', 'objects')).join(':'),
    };
    const taskObjects = { repoPaths: info.repos.map(r => r.local_path), branch };
    for (const r of info.repos) {
      const repoWt = path.join(wt, r.subdir || path.basename(r.local_path));
      // 任務開跑後才加進專案的 repo 沒有 worktree（見 merge-agent.js）：沒東西可 commit，.git 全唯讀
      if (!d.existsSync(repoWt)) { mounts.push(...gitDirMounts(r.local_path, 'ro')); continue; }
      // admin 目錄會被開成可寫：由主 clone 自己的 .git/worktrees 找（lib/worktree-guard.js），不信 worktree 的 .git 檔
      const admin = findAdminDir(r.local_path, repoWt);
      // gitDirMounts 比對的是字面路徑；admin 是 realpath（local_path 經過 symlink 時兩者字面不同、指的是同一處）
      mounts.push(...gitDirMounts(r.local_path, 'rw', path.join(r.local_path, '.git', 'worktrees', path.basename(admin))));
      // bind mount 來源必須存在；分支全被 pack 掉時這兩個目錄不一定在
      for (const sub of [['refs', 'heads', 'task'], ['logs', 'refs', 'heads', 'task']]) {
        d.mkdirSync(path.join(r.local_path, '.git', ...sub), { recursive: true });
      }
    }
    projectData(); attach();
    return { mounts, workdir: wt, env, taskObjects };
  };

  const useClone = async () => {
    mounts.push({ source: info.root, readonly: true });
    projectData(); attach();
    if (profile.logs) {
      ro(path.join(d.envBase, info.folder_name || info.name, 'odoo.log'));
      const { rows } = await d.query('SELECT id FROM tasks WHERE project_id=$1', [ctx.projectId]);
      const ids = new Set(rows.map(r => String(r.id)));
      let files = [];
      try { files = d.readdirSync(d.logDir); } catch { files = []; }
      files
        .filter(f => { const mm = LOG_RE.exec(f); return mm && ids.has(mm[2]); })
        .map(f => path.join(d.logDir, f))
        .sort((a, b) => d.statSync(b).mtimeMs - d.statSync(a).mtimeMs)
        .slice(0, MAX_LOG_FILES)
        .forEach(ro);
    }
    return { mounts, workdir: info.root };
  };

  if (kind === 'task-worktree') return useWorktree();
  if (kind === 'task-worktree-or-none') {
    if (ctx.cwd === undefined) { attach(); return { mounts, workdir }; }
    return useWorktree();
  }
  if (kind === 'task-worktree-or-clone') {
    if (ctx.cwd === info.root) return useClone();
    return useWorktree();
  }
  if (kind === 'project-clone') return useClone();
  throw new Error(`未知的掛載種類：${kind}`);
}

module.exports = { resolveSandboxMounts, platformPaths, MAX_LOG_FILES, SKILLS_BY_SCOPE };
