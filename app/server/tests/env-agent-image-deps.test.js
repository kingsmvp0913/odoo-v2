// 意圖：自訂模組的 Python 相依必須「內建在 image 裡」，不能只靠容器起來後才 pip 裝進可寫層——
// 容器一被 rm（夜間關機／閒置回收／刪環境）那些套件就全滅，而 DB 裡的模組仍是已安裝，重建時常駐
// 進程一啟動就 ModuleNotFoundError → registry 載入失敗 → 連 idx_aidev_sso 一起回滾 → 測試區點開
// 是 Not Found，但 run／pip／seed／健檢全部回報成功。
// 這裡鎖住的契約有二：(1) 相依清單是「全平台聯集」而非單一專案（分專案建 image 只會讓 image 數量
// 變成專案數 × 版本數，每個 3GB+，實測聯集幾乎全來自同一個專案＝分開一個都沒省到）；
// (2) 建環境時真的把這份聯集交給 ensureImage——算得出來但沒傳過去等於沒做。
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'envimgdeps-'));
process.env.ODOO_ENV_BASE = TMP; // 必須在 require env-agent 前設定（ENV_BASE 於載入時定值）

const { newDb } = require('pg-mem');

jest.mock('../lib/docker-env', () => {
  const actual = jest.requireActual('../lib/docker-env');
  return {
    ...actual,
    ensureDockerRunning: jest.fn().mockResolvedValue(undefined),
    ensureImage: jest.fn().mockResolvedValue({ ok: true, log: '[image] ok\n' }),
    runContainer: jest.fn().mockResolvedValue({ ok: true, log: 'cid\n' }),
    removeContainer: jest.fn().mockResolvedValue(undefined),
    containerRunning: jest.fn().mockResolvedValue(true),
    containerLogs: jest.fn().mockResolvedValue('log'),
    execOdoo: jest.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' }),
    execPipInstall: jest.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' }),
  };
});
jest.mock('../notify', () => ({ emitToUser: jest.fn(), emitAll: jest.fn(), setIo: jest.fn() }));
jest.mock('../pipeline/git', () => ({ ensureTestingBranch: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/project-vpn', () => ({
  startProjectVpns: jest.fn().mockResolvedValue(''),
  stopProjectVpns: jest.fn().mockResolvedValue(undefined),
}));

let dbModule, envAgent, dockerEnv;
const PID_A = 2001; // 宣告 pyodbc/xlsxtpl
const PID_B = 2002; // 宣告 qrcode（另一個專案，用來證明是「聯集」不是「單一專案」）

function mkAddons(dir, modName, pyDeps) {
  const modDir = path.join(dir, modName);
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, '__manifest__.py'),
    `{ "name": "${modName}", "external_dependencies": { "python": ${JSON.stringify(pyDeps)} } }`);
  return dir;
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  await dbModule.query("INSERT INTO teams_settings (id, env_mode) VALUES (1, 'docker')");
  await dbModule.query(
    `INSERT INTO projects (id, name, odoo_version, folder_name, port) VALUES (${PID_A}, 'P-A', '17.0', 'imgdepsa', 8090)`
  );
  await dbModule.query(
    `INSERT INTO projects (id, name, odoo_version, folder_name, port) VALUES (${PID_B}, 'P-B', '17.0', 'imgdepsb', 8091)`
  );
  const rootA = mkAddons(path.join(TMP, 'addons-a'), 'idx_a', ['pyodbc', 'xlsxtpl']);
  const rootB = mkAddons(path.join(TMP, 'addons-b'), 'idx_b', ['qrcode']);
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u',$2,true,'done')",
    [PID_A, rootA]
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u',$2,true,'done')",
    [PID_B, rootB]
  );

  envAgent = require('../pipeline/env-agent');
  dockerEnv = require('../lib/docker-env');
});
afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => { for (const f of Object.values(dockerEnv)) if (jest.isMockFunction(f)) f.mockClear(); });

test('getAllDeclaredPythonDeps：跨專案取聯集（不是只有當前專案）', async () => {
  const all = await envAgent.getAllDeclaredPythonDeps();
  expect(all).toEqual(expect.arrayContaining(['pyodbc', 'xlsxtpl', 'qrcode']));
});

// 未 clone 完成的 repo 沒有本機檔案可掃，掃它只會讓聯集隨機少東西；且全平台查詢一律
// 帶 clone_status='done'，這裡必須一致。
test('getAllDeclaredPythonDeps：未 clone 完成的 repo 不列入', async () => {
  const rootC = mkAddons(path.join(TMP, 'addons-c'), 'idx_c', ['neverdeclared']);
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'other','u',$2,false,'cloning')",
    [PID_B, rootC]
  );
  const all = await envAgent.getAllDeclaredPythonDeps();
  expect(all).not.toContain('neverdeclared');
});

// 這條是整個修法的落地點：算得出聯集但沒交給 ensureImage，image 裡就還是沒有那些套件。
test('runEnvSetup：把全平台聯集當 pipPkgs 交給 ensureImage', async () => {
  dockerEnv.ensureImage.mockResolvedValueOnce({ ok: false, log: '[image] stop here\n' }); // 驗完契約即收尾
  await envAgent.runEnvSetup(PID_A);
  expect(dockerEnv.ensureImage).toHaveBeenCalled();
  const [, , opts] = dockerEnv.ensureImage.mock.calls[0];
  expect(opts.pipPkgs).toEqual(expect.arrayContaining(['pyodbc', 'xlsxtpl', 'qrcode']));
});
