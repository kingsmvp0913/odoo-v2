// 意圖：掛載清單就是 AI 在容器裡看得到的整個世界。這裡用真的暫存目錄樹驗：
//  - 客戶 agent 只看得到自己的專案（別專案 repo、平台 repo 本體、data/config.json 一律不在清單）
//  - 任務 worktree 可寫，但主 clone 的 .git/config 與 hooks 唯讀（總覽 D5）
//  - 內部 AI 只掛乾淨 worktree，絕不掛正在運作的平台資料夾（總覽 D7）
//  - agent 合法要讀的附件與 log 有掛、而且只掛本任務／本專案的（X7）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveSandboxMounts } = require('../lib/agent-mounts');
const { profileFor } = require('../lib/agent-profiles');

let R, deps, appDir;
const mk = (...p) => { const d = path.join(R, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const touch = (...p) => { const f = path.join(R, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };

beforeAll(() => {
  R = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mounts-'));
  appDir = mk('app-root');
  mk('app-root', '.agents', 'skills'); mk('app-root', 'app', 'server', 'pipeline', 'hooks'); mk('app-root', 'app', 'server', 'pipeline', 'mcp');
  touch('app-root', 'data', 'config.json'); mk('app-root', '.git', 'hooks'); touch('app-root', '.git', 'config');
  mk('app-root', 'app', 'node_modules');
  mk('repos', 'p7', 'main', '.git', 'hooks'); touch('repos', 'p7', 'main', '.git', 'config');
  mk('repos', 'p7', '.worktrees', 'task_7', 'main');
  mk('repos', 'p8', 'main', '.git');
  mk('core', '17');
  mk('uploads', 'task_70'); mk('uploads', 'task_71'); mk('uploads', 'chat_5'); mk('uploads', 'feedback_3');
  touch('logs', 'deploy-task70-1.log'); touch('logs', 'e2e-task70-1712.log'); touch('logs', 'deploy-task99-1.log');
  touch('envs', 'odoo17_p7', 'odoo.log'); touch('envs', 'odoo17_p7', 'odoo.conf');
  mk('app-root', '.claude', 'worktrees', 'fix-12'); mk('app-root', '.git', 'worktrees', 'fix-12');
  mk('app-root', '.claude', 'worktrees', 'ro-abc');

  deps = {
    query: async (sql, params) => {
      if (/FROM tasks WHERE id/.test(sql)) return { rows: params[0] === 70 ? [{ task_id: 'task_7', project_id: 7 }] : [] };
      if (/FROM tasks WHERE project_id/.test(sql)) return { rows: params[0] === 7 ? [{ id: 70 }, { id: 71 }] : [] };
      throw new Error(`unexpected sql ${sql}`);
    },
    getProjectInfo: async (id) => id === 7 ? {
      name: 'P7', folder_name: 'odoo17_p7', odoo_version: '17.0', enterprise_src: null,
      root: path.join(R, 'repos', 'p7'),
      repos: [{ label: 'main', local_path: path.join(R, 'repos', 'p7', 'main'), subdir: 'main' }],
    } : null,
    worktreeParent: (root, taskId) => path.join(root, '.worktrees', taskId),
    majorOf: v => String(parseInt(v, 10)),
    coreSrcRoot: path.join(R, 'core'),
    uploadRoot: path.join(R, 'uploads'),
    envBase: path.join(R, 'envs'),
    logDir: path.join(R, 'logs'),
    fixWorktreeRoot: path.join(appDir, '.claude', 'worktrees'),
  };
});
afterAll(() => fs.rmSync(R, { recursive: true, force: true }));

const base = over => ({ projectId: 7, taskDbId: 70, cwd: undefined, chatId: null, feedbackIds: [], home: path.join(appDir, 'data', 'agent-home', 'project-7'), platformWorktree: null, appDir, ...over });
const sources = m => m.mounts.map(x => x.source);
const find = (m, src) => m.mounts.find(x => x.source === src);

function expectNoPlatformSecrets(m) {
  for (const src of sources(m)) {
    expect(src).not.toBe(appDir);
    expect(src.startsWith(path.join(appDir, 'data'))).toBe(false);
    expect(src.startsWith(path.join(R, 'repos', 'p8'))).toBe(false);
    expect(src).not.toMatch(/odoo\.conf$/);
  }
}

test('task-worktree：worktree 可寫、.git 可寫但 config／hooks 唯讀、核心原始碼與本任務附件唯讀', async () => {
  const wt = path.join(R, 'repos', 'p7', '.worktrees', 'task_7');
  const m = await resolveSandboxMounts(base({ profile: profileFor('coding'), cwd: wt }), deps);
  expect(m.workdir).toBe(wt);
  expect(find(m, wt).readonly).toBe(false);
  expect(find(m, path.join(R, 'repos', 'p7', 'main', '.git')).readonly).toBe(false);
  expect(find(m, path.join(R, 'repos', 'p7', 'main', '.git', 'config')).readonly).toBe(true);
  expect(find(m, path.join(R, 'repos', 'p7', 'main', '.git', 'hooks')).readonly).toBe(true);
  expect(find(m, path.join(R, 'core', '17')).readonly).toBe(true);
  expect(find(m, path.join(R, 'uploads', 'task_70')).readonly).toBe(true);
  expect(sources(m)).not.toContain(path.join(R, 'uploads', 'task_71'));
  expect(find(m, path.join(appDir, '.agents', 'skills')).readonly).toBe(true);
  expectNoPlatformSecrets(m);
});

test('呼叫端給的 cwd 與任務 worktree 不符 → 丟例外（表對不上就停，不猜）', async () => {
  await expect(resolveSandboxMounts(base({ profile: profileFor('qa'), cwd: path.join(R, 'repos', 'p8', 'main') }), deps)).rejects.toThrow(/cwd/);
});

test('worktree 不存在 → 丟例外', async () => {
  await expect(resolveSandboxMounts(base({ profile: profileFor('qa'), taskDbId: 71, cwd: undefined }), {
    ...deps, query: async (sql) => /WHERE id/.test(sql) ? { rows: [{ task_id: 'task_missing', project_id: 7 }] } : { rows: [] },
  })).rejects.toThrow(/worktree/);
});

test('project-clone（chat）：專案根唯讀、只掛本專案任務的 log 與本專案 odoo.log、對話附件', async () => {
  const m = await resolveSandboxMounts(base({ profile: profileFor('chat'), taskDbId: null, chatId: 5 }), deps);
  expect(m.workdir).toBe(path.join(R, 'repos', 'p7'));
  expect(find(m, path.join(R, 'repos', 'p7')).readonly).toBe(true);
  expect(find(m, path.join(R, 'envs', 'odoo17_p7', 'odoo.log')).readonly).toBe(true);
  expect(sources(m)).toContain(path.join(R, 'logs', 'deploy-task70-1.log'));
  expect(sources(m)).toContain(path.join(R, 'logs', 'e2e-task70-1712.log'));
  expect(sources(m)).not.toContain(path.join(R, 'logs', 'deploy-task99-1.log'));
  expect(find(m, path.join(R, 'uploads', 'chat_5')).readonly).toBe(true);
  expect(m.mounts.every(x => x.readonly)).toBe(true);
  expectNoPlatformSecrets(m);
});

test('task-worktree-or-clone（reject_triage）：cwd 是專案根時退成唯讀主 clone', async () => {
  const m = await resolveSandboxMounts(base({ profile: profileFor('reject_triage'), cwd: path.join(R, 'repos', 'p7') }), deps);
  expect(m.workdir).toBe(path.join(R, 'repos', 'p7'));
  expect(m.mounts.every(x => x.readonly)).toBe(true);
});

test('task-worktree-or-none（respec）：沒有 cwd 就只有基本掛載＋附件，workdir 是家目錄', async () => {
  const m = await resolveSandboxMounts(base({ profile: profileFor('respec') }), deps);
  expect(m.workdir).toBe(base({}).home);
  expect(sources(m).some(s => s.startsWith(path.join(R, 'repos')))).toBe(false);
  expect(sources(m)).toContain(path.join(R, 'uploads', 'task_70'));
});

test('none（deploy_fix）：只有 skills／hooks／mcp，全部唯讀', async () => {
  const m = await resolveSandboxMounts(base({ profile: profileFor('deploy_fix'), projectId: null, taskDbId: null }), deps);
  expect(sources(m).sort()).toEqual([
    path.join(appDir, '.agents', 'skills'),
    path.join(appDir, 'app', 'server', 'pipeline', 'hooks'),
    path.join(appDir, 'app', 'server', 'pipeline', 'mcp'),
  ].sort());
  expect(m.mounts.every(x => x.readonly)).toBe(true);
});

test('project 類但沒有 projectId（未綁專案的 cs）→ 與 none 相同，不掛任何 repo', async () => {
  const m = await resolveSandboxMounts(base({ profile: profileFor('cs'), projectId: null, taskDbId: null }), deps);
  expect(sources(m).some(s => s.startsWith(path.join(R, 'repos')))).toBe(false);
});

test('platform-clean（健檢）：只掛乾淨 worktree 與平台 .git，全部唯讀', async () => {
  const wt = path.join(appDir, '.claude', 'worktrees', 'ro-abc');
  const m = await resolveSandboxMounts(base({ profile: profileFor('workflow_health'), projectId: null, taskDbId: null, platformWorktree: wt }), deps);
  expect(m.workdir).toBe(wt);
  expect(m.mounts.every(x => x.readonly)).toBe(true);
  expect(sources(m)).toContain(path.join(appDir, '.git'));
  expectNoPlatformSecrets(m);
});

test('platform-clean 沒給 worktree、或 worktree 不在允許的目錄 → 丟例外', async () => {
  await expect(resolveSandboxMounts(base({ profile: profileFor('fix_review'), projectId: null, taskDbId: null }), deps)).rejects.toThrow();
  await expect(resolveSandboxMounts(base({ profile: profileFor('fix_review'), projectId: null, taskDbId: null, platformWorktree: appDir }), deps)).rejects.toThrow();
});

// 修正工作區要能改檔、跑 jest，但不能改平台 repo 的 refs（否則可以直接改寫 master 指標、繞過審核）
test('platform-fix：工作區可寫、node_modules 唯讀、平台 .git 唯讀只開自己的 worktree admin 目錄', async () => {
  const wt = path.join(appDir, '.claude', 'worktrees', 'fix-12');
  const m = await resolveSandboxMounts(base({ profile: profileFor('platform_fix'), projectId: null, taskDbId: null, cwd: wt, feedbackIds: [3] }), deps);
  expect(m.workdir).toBe(wt);
  expect(find(m, wt).readonly).toBe(false);
  expect(find(m, path.join(appDir, '.git')).readonly).toBe(true);
  expect(find(m, path.join(appDir, '.git', 'worktrees', 'fix-12')).readonly).toBe(false);
  expect(find(m, path.join(appDir, 'app', 'node_modules')).readonly).toBe(true);
  expect(find(m, path.join(R, 'uploads', 'feedback_3')).readonly).toBe(true);
  expectNoPlatformSecrets(m);
});

test('platform-fix 的 cwd 不在修正工作區根目錄底下 → 丟例外', async () => {
  await expect(resolveSandboxMounts(base({ profile: profileFor('fix_verify'), projectId: null, taskDbId: null, cwd: appDir }), deps)).rejects.toThrow();
});
