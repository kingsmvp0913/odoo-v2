// 意圖：掛載清單就是 AI 在容器裡看得到的整個世界。這裡用真的暫存目錄樹驗：
//  - 客戶 agent 只看得到自己的專案（別專案 repo、平台 repo 本體、data/config.json 一律不在清單）
//  - 任務 worktree 可寫；主 clone 的 .git 唯讀（共用 objects 也唯讀，D2），只開本 worktree 的 admin 目錄、refs/heads/task 可寫；
//    commit 寫進任務自己的物件庫 repos/<專案>/.agent-objects/<task_id>
//    （09-17 裁決 R8：testing／main 指標從掛載層就改不動，不靠事後還原）
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
  mk('repos', 'p7', 'main', '.git', 'objects'); mk('repos', 'p7', 'main', '.git', 'worktrees', 'main1');
  fs.writeFileSync(path.join(R, 'repos', 'p7', '.worktrees', 'task_7', 'main', '.git'),
    `gitdir: ${path.join(R, 'repos', 'p7', 'main', '.git', 'worktrees', 'main1')}\n`);
  // admin 目錄比照 git worktree add 的產物（lib/worktree-guard.js 以 gitdir 找出認領者）
  fs.writeFileSync(path.join(R, 'repos', 'p7', 'main', '.git', 'worktrees', 'main1', 'commondir'), '../..\n');
  fs.writeFileSync(path.join(R, 'repos', 'p7', 'main', '.git', 'worktrees', 'main1', 'gitdir'),
    `${path.join(R, 'repos', 'p7', '.worktrees', 'task_7', 'main', '.git')}\n`);
  fs.writeFileSync(path.join(R, 'repos', 'p7', 'main', '.git', 'worktrees', 'main1', 'HEAD'), 'ref: refs/heads/task/task_7\n');
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
  const G = path.join(R, 'repos', 'p7', 'main', '.git');
  expect(m.mounts.filter(x => x.source.startsWith(G))).toEqual([
    { source: G, readonly: true },
    { source: path.join(G, 'worktrees', 'main1'), readonly: false },
    { source: path.join(G, 'refs', 'heads', 'task'), readonly: false },
    { source: path.join(G, 'logs', 'refs', 'heads', 'task'), readonly: false },
    { source: path.join(G, 'config'), readonly: true },
    { source: path.join(G, 'hooks'), readonly: true },
  ]);
  const objDir = path.join(R, 'repos', 'p7', '.agent-objects', 'task_7');
  expect(find(m, objDir).readonly).toBe(false);
  expect(fs.statSync(objDir).isDirectory()).toBe(true);
  expect(m.env).toEqual({ GIT_OBJECT_DIRECTORY: objDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(G, 'objects') });
  expect(m.taskObjects).toEqual({ repoPaths: [path.join(R, 'repos', 'p7', 'main')], branch: 'task/task_7' });
  // bind mount 的來源必須存在：分支可能全被 pack 掉，refs/heads/task 目錄不一定在
  expect(fs.statSync(path.join(G, 'refs', 'heads', 'task')).isDirectory()).toBe(true);
  expect(fs.statSync(path.join(G, 'logs', 'refs', 'heads', 'task')).isDirectory()).toBe(true);
  expect(find(m, path.join(R, 'core', '17')).readonly).toBe(true);
  expect(find(m, path.join(R, 'uploads', 'task_70')).readonly).toBe(true);
  expect(sources(m)).not.toContain(path.join(R, 'uploads', 'task_71'));
  expect(find(m, path.join(appDir, '.agents', 'skills')).readonly).toBe(true);
  expectNoPlatformSecrets(m);
});

// admin 目錄會被開成可寫：一定要由主 clone 自己的 .git/worktrees 找，不能照 worktree 的 .git 檔（容器寫得到）
test('worktree 的 .git 檔被改成指向別處 → 仍掛主 clone 認領它的那個 admin 目錄', async () => {
  const wt = path.join(R, 'repos', 'p7', '.worktrees', 'task_7');
  const gitFile = path.join(wt, 'main', '.git');
  const orig = fs.readFileSync(gitFile, 'utf8');
  fs.writeFileSync(gitFile, `gitdir: ${path.join(R, 'repos', 'p8', 'main', '.git')}\n`);
  try {
    const m = await resolveSandboxMounts(base({ profile: profileFor('coding'), cwd: wt }), deps);
    const rw = m.mounts.filter(x => !x.readonly).map(x => x.source);
    expect(rw).toContain(path.join(R, 'repos', 'p7', 'main', '.git', 'worktrees', 'main1'));
    expect(rw.some(x => x.startsWith(path.join(R, 'repos', 'p8')))).toBe(false);
  } finally { fs.writeFileSync(gitFile, orig); }
});

test('主 clone 沒有 admin 目錄認領這個 worktree → 丟例外，不開可寫掛載', async () => {
  const wt = path.join(R, 'repos', 'p7', '.worktrees', 'task_7');
  const adminGitdir = path.join(R, 'repos', 'p7', 'main', '.git', 'worktrees', 'main1', 'gitdir');
  const orig = fs.readFileSync(adminGitdir, 'utf8');
  fs.writeFileSync(adminGitdir, `${path.join(R, 'elsewhere', '.git')}\n`);
  try {
    await expect(resolveSandboxMounts(base({ profile: profileFor('coding'), cwd: wt }), deps)).rejects.toThrow(/worktree/);
  } finally { fs.writeFileSync(adminGitdir, orig); }
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
  // 唯一可寫的是出貨箱：AI 交檔案給使用者只能往這裡寫，連同一層的已交付附件都動不到
  const outbox = path.join(R, 'uploads', 'chat_5', 'ai', 'outbox');
  expect(find(m, outbox).readonly).toBe(false);
  expect(m.mounts.filter(x => x.source !== outbox).every(x => x.readonly)).toBe(true);
  expectNoPlatformSecrets(m);
});

// chatFiles 的出貨箱：唯讀附件目錄底下的可寫子掛載。漏了任何一半，AI 都只會回「寫不進去」。
test('對話出貨箱：宿主先建好目錄、掛成可寫，已交付的 msg_* 留在唯讀的上一層', async () => {
  const m = await resolveSandboxMounts(base({ profile: profileFor('chat'), taskDbId: null, chatId: 5 }), deps);
  const outbox = path.join(R, 'uploads', 'chat_5', 'ai', 'outbox');
  // 來源先建：交給 dockerd 自動建會是 root 擁有，容器以宿主 uid 跑就寫不進去
  expect(fs.existsSync(outbox)).toBe(true);
  expect(find(m, outbox)).toEqual({ source: outbox, readonly: false });
  // 父先子後，否則唯讀的父層會蓋掉可寫的出貨箱（buildAgentRunArgs 依 target 深度排序）
  expect(sources(m)).toContain(path.join(R, 'uploads', 'chat_5'));
  // 已交付的檔在 ai/ 這一層，沒有被掛成可寫 → AI 改不掉舊回覆的下載檔
  expect(sources(m)).not.toContain(path.join(R, 'uploads', 'chat_5', 'ai'));
});

test('只讀對話附件、不交檔案的 agent（chat-to-task）拿不到可寫的出貨箱', async () => {
  const m = await resolveSandboxMounts(base({ profile: profileFor('chat-to-task'), taskDbId: null, chatId: 5 }), deps);
  expect(find(m, path.join(R, 'uploads', 'chat_5')).readonly).toBe(true);
  expect(sources(m).some(x => x.includes(`${path.sep}ai${path.sep}outbox`))).toBe(false);
  expect(m.mounts.every(x => x.readonly)).toBe(true);
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

// 進容器後 workdir 換掉，原本從平台根目錄載得到的 skill 會整批消失；補掛時只掛該 scope 該有的那幾支
describe('白名單 skill 掛進家目錄（計畫 X9）', () => {
  const { SKILLS_BY_SCOPE } = require('../lib/agent-mounts');
  beforeAll(() => {
    for (const n of ['getSQL', 'getLog', 'wikiQuery', 'odooGlossary', 'odooDev', 'healthCheck', 'platformDB', 'platformDev', 'pushRepo', 'chatFiles']) {
      fs.mkdirSync(path.join(appDir, '.agents', 'skills', n), { recursive: true });
    }
  });
  const skillTargets = (m, home) => m.mounts.filter(x => (x.target || '').startsWith(path.join(home, '.claude', 'skills'))).map(x => path.basename(x.target)).sort();

  test('客戶 agent：只有查客戶資料用的 skill，沒有 platformDB／pushRepo', async () => {
    const ctx = base({ profile: profileFor('chat'), taskDbId: null, chatId: 5 });
    const m = await resolveSandboxMounts(ctx, deps);
    // chat 多一支 chatFiles：它教的是往出貨箱寫檔，只掛給真的有出貨箱的 agent
    expect(skillTargets(m, ctx.home)).toEqual([...SKILLS_BY_SCOPE.project, 'chatFiles'].sort());
    expect(m.mounts.filter(x => x.target && x.target.startsWith(ctx.home)).every(x => x.readonly)).toBe(true);
    // 掛載點由平台先建（避免 dockerd 建成 root 擁有、容器內寫不進 .claude）
    expect(fs.existsSync(path.join(ctx.home, '.claude', 'skills', 'getSQL'))).toBe(true);
  });

  test('修正級內部 AI 拿不到 platformDB（R6-A）', async () => {
    const wt = path.join(appDir, '.claude', 'worktrees', 'fix-12');
    const ctx = base({ profile: profileFor('platform_fix'), projectId: null, taskDbId: null, cwd: wt, home: path.join(appDir, 'data', 'agent-home', 'internal-fix') });
    const m = await resolveSandboxMounts(ctx, deps);
    expect(skillTargets(m, ctx.home)).not.toContain('platformDB');
    expect(skillTargets(m, ctx.home)).toEqual([...SKILLS_BY_SCOPE['internal-fix']].sort());
  });

  test('沒有出貨箱的客戶 agent（coding）拿不到 chatFiles', async () => {
    const ctx = base({ profile: profileFor('coding') });
    // 同理 chat-to-task：它有對話附件但沒有 outbox（見 agent-profiles.js）
    const m = await resolveSandboxMounts(ctx, deps);
    expect(skillTargets(m, ctx.home)).toEqual([...SKILLS_BY_SCOPE.project].sort());
  });

  test('none：不掛任何 skill', async () => {
    const ctx = base({ profile: profileFor('deploy_fix'), projectId: null, taskDbId: null, home: path.join(appDir, 'data', 'agent-home', 'none') });
    const m = await resolveSandboxMounts(ctx, deps);
    expect(skillTargets(m, ctx.home)).toEqual([]);
  });
});
