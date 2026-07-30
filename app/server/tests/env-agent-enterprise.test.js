// 意圖：企業版只是「多掛一包 addons」，但三件事錯了就會很難查：
// ①掛載順序錯 → web_enterprise 蓋不掉社群 web，UI 看起來像沒生效
// ②來源缺件卻默默跑下去 → 使用者以為在測企業版，其實是社群版（本檔最重要的一條）
// ③enterprise 目錄被當成專案 repo 去開 testing 分支 → 汙染唯讀來源
// 這三件都在此鎖死。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { newDb } = require('pg-mem');

jest.mock('../lib/docker-env', () => {
  const actual = jest.requireActual('../lib/docker-env');
  return {
    ...actual,
    ensureDockerRunning: jest.fn().mockResolvedValue(undefined),
    ensureImage: jest.fn().mockResolvedValue({ ok: true, log: '[image] ok\n' }),
    runContainer: jest.fn().mockResolvedValue({ ok: true, log: 'cid\n' }),
    removeContainer: jest.fn().mockResolvedValue(undefined),
    stopContainer: jest.fn().mockResolvedValue({ code: 0 }),
    containerRunning: jest.fn().mockResolvedValue(true),
    containerExists: jest.fn().mockResolvedValue(true),
    containerLogs: jest.fn().mockResolvedValue('log'),
    execOdoo: jest.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' }),
    execPipInstall: jest.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' }),
  };
});
jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));
jest.mock('../pipeline/git', () => ({ ensureTestingBranch: jest.fn().mockResolvedValue(undefined) }));
// runEnvSetup 尾巴會 startProjectVpns；目前 fixture 沒設 VPN 欄位所以還沒真打 docker，
// 但那是巧合——fixture 一補 vpn_config_enc 就會對本機 docker 發真指令。先鎖住。
jest.mock('../lib/project-vpn', () => ({
  startProjectVpns: jest.fn().mockResolvedValue(''),
  stopProjectVpns: jest.fn().mockResolvedValue(undefined),
}));
// env-agent.js:8 以解構匯入 leasePort，故 mock 工廠回傳的函式會被它取用；只 mock 借埠，
// 其餘（envBindHost／envPublicUrl）保留真實行為。
// 回傳值刻意選池外埠（29999，實機埠池只到 21000-21012）：waitForPort 是真函式、會做真 TCP
// 連線，選池內埠（如 21000）在開發機上若剛好有真測試區在跑會連得上，走到不同分支。
jest.mock('../port-alloc', () => {
  const actual = jest.requireActual('../port-alloc');
  return { ...actual, leasePort: jest.fn().mockResolvedValue(29999) };
});

let dbModule, envAgent, dockerEnv, gitMod, portAlloc, tmpBase, entBase, entDir, repoDir, prevEnv;
const PID = 2001; // 單一共用 fixture 專案（pg-mem 多次 INSERT projects 會踩 SERIAL quirk）

beforeAll(async () => {
  // ENTERPRISE_BASE_DIR（enterprise 共用來源根）與 ODOO_ENV_BASE（測試區 env 目錄根）語意無關，
  // 各用各的 tmp 根，避免只靠 folder_name='entx' vs 版本目錄名 '17' 僥倖不撞。
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-envbase-'));
  entBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-srcbase-'));
  // 保存呼叫本檔前 process.env 可能已有的原始值，afterAll 照原樣還原（而非直接 delete）——
  // 同一 jest worker 若接著跑其他測試檔，不該被本檔留下的空值／殘值污染。
  prevEnv = {
    ENTERPRISE_BASE_DIR: process.env.ENTERPRISE_BASE_DIR,
    ODOO_ENV_BASE: process.env.ODOO_ENV_BASE,
    ENV_HEALTH_TIMEOUT_MS: process.env.ENV_HEALTH_TIMEOUT_MS,
  };
  process.env.ENTERPRISE_BASE_DIR = entBase;
  // ODOO_ENV_BASE 改指向 tmp 目錄——否則最後一個測試會在真實 repo 樹下寫入 odoo-envs/entx。
  process.env.ODOO_ENV_BASE = tmpBase;
  // env-agent.js 對「首次建置」的健康檢查有 Math.max(...,300000) 的硬下限（既有健康檢查設計，
  // 非本功能引入）；最後一個測試會走完整 runEnvSetup，調小逾時＋下面預放 .docker-ready 才不用真等 300 秒。
  process.env.ENV_HEALTH_TIMEOUT_MS = '300';
  entDir = path.join(entBase, '17');
  fs.mkdirSync(entDir, { recursive: true });
  // 專案自己的 repo（非 enterprise）：唯有 mounts 裡真的有「專案 repo + enterprise」兩筆，
  // 「順序即覆蓋權」的斷言才有意義（否則 mounts 永遠只有 enterprise 一筆，push/unshift 測不出差異）。
  repoDir = path.join(tmpBase, 'repo-main');
  fs.mkdirSync(repoDir, { recursive: true });
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query(
    `INSERT INTO projects (id, name, odoo_version, folder_name, edition) VALUES (${PID}, 'P-ent', '17.0', 'entx', 'community')`
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','https://x/main.git',$2,true,'done')",
    [PID, repoDir]
  );
  envAgent = require('../pipeline/env-agent');
  dockerEnv = require('../lib/docker-env');
  gitMod = require('../pipeline/git');
  portAlloc = require('../port-alloc');
}, 30000);

afterAll(() => {
  dbModule._setPoolForTesting(null);
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(entBase, { recursive: true, force: true }); } catch {}
});

beforeEach(async () => {
  for (const f of Object.values(dockerEnv)) if (jest.isMockFunction(f)) f.mockClear();
  gitMod.ensureTestingBranch.mockClear();
  portAlloc.leasePort.mockClear().mockResolvedValue(29999);
  await dbModule.query('DELETE FROM enterprise_sources');
  await dbModule.query('DELETE FROM odoo_envs');
  await dbModule.query("UPDATE projects SET edition='community' WHERE id=$1", [PID]);
});

const registerSource = () => dbModule.query(
  "INSERT INTO enterprise_sources (odoo_version, repo_url, local_path, clone_status) VALUES ('17','https://x/e.git',$1,'done')",
  [entDir]
);

test('社群版專案：mounts 不含 enterprise（不誤掛）', async () => {
  const ctx = await envAgent.dockerCtxFor(PID);
  expect(ctx.mounts.some(m => m.container === dockerEnv.ENTERPRISE_CONTAINER_DIR)).toBe(false);
  expect(ctx.enterpriseError).toBeNull();
});

test('企業版專案：mounts 末端加入 enterprise，容器路徑固定 /mnt/enterprise', async () => {
  await registerSource();
  await dbModule.query("UPDATE projects SET edition='enterprise' WHERE id=$1", [PID]);
  const ctx = await envAgent.dockerCtxFor(PID);
  const last = ctx.mounts[ctx.mounts.length - 1];
  expect(last.container).toBe('/mnt/enterprise');
  expect(last.host).toBe(entDir);
  expect(last.enterprise).toBe(true);
});

// 意圖：順序就是覆蓋權。專案自訂模組要能覆蓋 enterprise，enterprise 要能覆蓋核心（web_enterprise 蓋 web）。
// fixture 已有一筆真正的 project_repos，故 mounts 此時是 [專案 repo, enterprise] 兩筆——
// 若 dockerCtxFor 把 push 誤植成 unshift（enterprise 排到專案 repo 前面），此斷言會抓到。
test('addons-path 順序：專案 repos 在前、/mnt/enterprise 居中、核心在最後', async () => {
  await registerSource();
  await dbModule.query("UPDATE projects SET edition='enterprise' WHERE id=$1", [PID]);
  const ctx = await envAgent.dockerCtxFor(PID);
  const p = dockerEnv.containerAddonsPath(ctx.mounts).split(',');
  expect(p[p.length - 1]).toBe(dockerEnv.CORE_ADDONS);
  expect(p[p.length - 2]).toBe('/mnt/enterprise');
  expect(p[0]).toBe(dockerEnv.PLATFORM_ADDONS_CONTAINER);
});

test('docker run 參數含唯讀掛載 -v <host>:/mnt/enterprise:ro', async () => {
  await registerSource();
  await dbModule.query("UPDATE projects SET edition='enterprise' WHERE id=$1", [PID]);
  const ctx = await envAgent.dockerCtxFor(PID);
  const args = dockerEnv.buildRunArgs({
    name: 'c', image: 'i', host: '127.0.0.1', port: 21000, dbName: 'test_entx', mounts: ctx.mounts,
  });
  expect(args).toContain(`${entDir}:/mnt/enterprise:ro`);
});

// 意圖：這是本功能最容易靜默出錯的地方——沒登記來源卻照跑，使用者會拿到社群版還以為是企業版。
test('企業版但來源未登記 → setup 直接失敗、訊息指名版本，且不借埠（不白佔併發槽）', async () => {
  await dbModule.query("UPDATE projects SET edition='enterprise' WHERE id=$1", [PID]);
  await envAgent.runEnvSetup(PID);
  const { rows: [env] } = await dbModule.query('SELECT status, error_msg FROM odoo_envs WHERE project_id=$1', [PID]);
  expect(env.status).toBe('error');
  expect(env.error_msg).toContain('17');
  expect(env.error_msg).toContain('企業版');
  expect(portAlloc.leasePort).not.toHaveBeenCalled();
  expect(dockerEnv.runContainer).not.toHaveBeenCalled();
});

// 意圖：enterprise 是唯讀共用來源，絕不能被當成專案 repo 去開／切 testing 分支——但排除邏輯要跟
// 「迴圈根本沒跑」區分開，故同時正面驗證一般專案 repo（repoDir）仍會被呼叫 ensureTestingBranch。
test('啟動時不對 enterprise 目錄呼叫 ensureTestingBranch，但一般專案 repo 仍會', async () => {
  await registerSource();
  await dbModule.query("UPDATE projects SET edition='enterprise' WHERE id=$1", [PID]);
  // 預先放 .docker-ready，讓本次視為非首次建置（firstBuild=false）：健康檢查改用上面調小的
  // ENV_HEALTH_TIMEOUT_MS，不用真的等 300000ms 下限。本測試只驗 ensureTestingBranch 有沒有被
  // enterprise 目錄呼叫，健康檢查本身是否過關與此斷言無關。
  fs.mkdirSync(path.join(tmpBase, 'entx'), { recursive: true });
  fs.writeFileSync(path.join(tmpBase, 'entx', '.docker-ready'), 'x');
  await envAgent.runEnvSetup(PID);
  const touched = gitMod.ensureTestingBranch.mock.calls.map(c => c[0]);
  expect(touched).not.toContain(entDir);
  expect(touched).toContain(repoDir);
});

// 意圖：企業版來源可能在建置成功「之後」才失效（管理員刪掉來源列、或目錄被清）。此時 upgradeModules
// 若照跑 exec，缺 /mnt/enterprise 的 addons-path 會讓 Odoo 因相依模組找不到而非 0 結束——那會以
// 「模組相依缺失」的面貌出現，容易被誤判成 code 問題退回 coding。故 dockerCtxFor 一旦標了
// enterpriseError，upgradeModules 要先擋、報明確指名版本的錯誤，且完全不去碰 docker exec。
test('企業版來源事後失效（未登記/已被移除）→ upgradeModules 直接拋錯，不呼叫 execOdoo', async () => {
  await dbModule.query("UPDATE projects SET edition='enterprise' WHERE id=$1", [PID]);
  // 刻意不 registerSource：等同來源列已被管理員移除，dockerCtxFor 會把 enterpriseError 設上
  await expect(envAgent.upgradeModules(PID, ['m'])).rejects.toThrow(/17/);
  expect(dockerEnv.execOdoo).not.toHaveBeenCalled();
});
