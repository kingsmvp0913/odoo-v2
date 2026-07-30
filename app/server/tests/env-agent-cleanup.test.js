// 意圖：專案硬刪除的實體清理。各 repo clone 與所有任務 worktree 同住一個「專案根」
//（clone = <REPOS_BASE>/<專案目錄>/<label>、工作樹 = <專案根>/.worktrees/<task_id>/<label>），
// 只逐一刪 local_path 會把整棵 .worktrees 與專案根目錄留在磁碟上——那才是佔空間的大宗
//（每張任務一份完整工作樹），而且專案已經不存在，沒有任何路徑會再回收它們。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');

jest.mock('../lib/docker-env', () => {
  const actual = jest.requireActual('../lib/docker-env');
  return {
    ...actual,
    stopContainer: jest.fn().mockResolvedValue({ code: 0 }),
    removeContainer: jest.fn().mockResolvedValue(undefined),
    containerExists: jest.fn().mockResolvedValue(false),
    containerRunning: jest.fn().mockResolvedValue(false),
  };
});
// stopEnv 會去 docker stop 真的 vpn 容器；本檔不碰實機 docker。
jest.mock('../lib/project-vpn', () => ({
  startProjectVpns: jest.fn().mockResolvedValue(''),
  stopProjectVpns: jest.fn().mockResolvedValue(undefined),
}));

let dbModule, envAgent, reposBase, outsideBase, prevEnv;
const PID = 3201;
const PID_OUTSIDE = 3202;

beforeAll(async () => {
  reposBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-repos-'));
  outsideBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-outside-'));
  prevEnv = { REPOS_BASE_DIR: process.env.REPOS_BASE_DIR, ODOO_ENV_BASE: process.env.ODOO_ENV_BASE };
  process.env.REPOS_BASE_DIR = reposBase;
  process.env.ODOO_ENV_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-envbase-'));

  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query(
    `INSERT INTO projects (id, name, odoo_version, folder_name) VALUES (${PID}, 'P-cleanup', '17.0', 'cleanx')`
  );
  await dbModule.query(
    `INSERT INTO projects (id, name, odoo_version, folder_name) VALUES (${PID_OUTSIDE}, 'P-outside', '17.0', 'outx')`
  );
  envAgent = require('../pipeline/env-agent'); // 必須在設好 REPOS_BASE_DIR 之後
}, 30000);

afterAll(() => {
  dbModule._setPoolForTesting(null);
  try { fs.rmSync(process.env.ODOO_ENV_BASE, { recursive: true, force: true }); } catch {}
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fs.rmSync(reposBase, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(outsideBase, { recursive: true, force: true }); } catch {}
});

const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });

test('刪除專案要連整棵 .worktrees 與專案根目錄一起清掉，不是只刪各 repo clone', async () => {
  const projRoot = path.join(reposBase, 'cleanx');
  const mainRepo = path.join(projRoot, 'main');
  const secondRepo = path.join(projRoot, 'addons2');
  // 兩張任務各一份完整工作樹：只刪 local_path 的話這兩份會整個留下來
  const wtA = path.join(projRoot, '.worktrees', 'task_1', 'main');
  const wtB = path.join(projRoot, '.worktrees', 'task_2', 'main');
  [mainRepo, secondRepo, wtA, wtB].forEach(mkdirp);
  fs.writeFileSync(path.join(wtA, 'f.py'), 'x');

  await dbModule.query(
    `INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status)
     VALUES ($1,'main','https://x/main.git',$2,true,'done'), ($1,'addons2','https://x/a2.git',$3,false,'done')`,
    [PID, mainRepo, secondRepo]
  );

  await envAgent.cleanupProjectEnv(PID);

  expect(fs.existsSync(mainRepo)).toBe(false);
  expect(fs.existsSync(secondRepo)).toBe(false);
  expect(fs.existsSync(path.join(projRoot, '.worktrees'))).toBe(false);
  expect(fs.existsSync(projRoot)).toBe(false);
  // 只往上刪一層：REPOS_BASE 本身（底下還有別的專案）不得被牽連
  expect(fs.existsSync(reposBase)).toBe(true);
});

// 意圖：往上刪一層比刪 local_path 本身危險——local_path 是 DB 內容。萬一被寫成 REPOS_BASE 以外
// 的路徑（手動改過、舊資料、搬遷殘留），dirname 可能指到某個共用目錄甚至磁碟根。此時只准刪
// 那個 repo 目錄本身。
test('local_path 不在 REPOS_BASE 底下時只刪該 repo 目錄，不得往上刪父層', async () => {
  const strayParent = path.join(outsideBase, 'shared');
  const strayRepo = path.join(strayParent, 'repo');
  const sibling = path.join(strayParent, '別人的東西');
  [strayRepo, sibling].forEach(mkdirp);

  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','https://x/m.git',$2,true,'done')",
    [PID_OUTSIDE, strayRepo]
  );

  await envAgent.cleanupProjectEnv(PID_OUTSIDE);

  expect(fs.existsSync(strayRepo)).toBe(false);
  expect(fs.existsSync(sibling)).toBe(true);
  expect(fs.existsSync(strayParent)).toBe(true);
});
