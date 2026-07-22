// 意圖：升級前補裝模組 Python 相依——在常駐容器內以 pip 安裝「宣告的」相依（image 未內建）；
// getDeclaredPythonDeps（F6「有無宣告」判準來源）正確蒐集宣告名；installPythonPackage 對非法套件名
// 拒裝（防 argv 旗標走私）。docker 為唯一模式，相依安裝走 dockerEnv.execPipInstall。
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'envdeps-'));
process.env.ODOO_ENV_BASE = TMP; // 必須在 require env-agent 前設定（ENV_BASE 於載入時定值）

jest.mock('../lib/docker-env', () => {
  const actual = jest.requireActual('../lib/docker-env');
  return {
    ...actual,
    containerRunning: jest.fn().mockResolvedValue(true),
    execPipInstall: jest.fn().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' }),
  };
});

const { newDb } = require('pg-mem');
let dbModule, envAgent, dockerEnv, projectId;
const DIR = 'DEPSP';
let addonsRoot;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('DepsP', '17.0', $1) RETURNING id", [DIR]
  );
  projectId = p.id;

  // 一個 addons 目錄，內含宣告 python 相依的模組 + 一個 requirements.txt
  addonsRoot = path.join(TMP, 'addons');
  const modDir = path.join(addonsRoot, 'idx_x');
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, '__manifest__.py'),
    `{ "name": "idx_x", "external_dependencies": { "python": ["xlsxtpl", "smbprotocol"] } }`);
  fs.writeFileSync(path.join(addonsRoot, 'requirements.txt'), 'qrcode==7.0\n# comment\nPillow\n');
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u',$2,true,'done')",
    [projectId, addonsRoot]
  );

  envAgent = require('../pipeline/env-agent');
  dockerEnv = require('../lib/docker-env');
});

afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => {
  dockerEnv.containerRunning.mockClear().mockResolvedValue(true);
  dockerEnv.execPipInstall.mockClear().mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
});

// F6 判準來源：宣告名（manifest external_dependencies.python ＋ requirements.txt 頂層名）小寫、去版本/extras
test('getDeclaredPythonDeps：蒐齊 manifest 與 requirements 的宣告名（小寫、去版本）', async () => {
  const declared = await envAgent.getDeclaredPythonDeps(projectId);
  expect(declared.has('xlsxtpl')).toBe(true);       // manifest
  expect(declared.has('smbprotocol')).toBe(true);   // manifest
  expect(declared.has('qrcode')).toBe(true);        // requirements.txt，版本被去掉
  expect(declared.has('pillow')).toBe(true);        // 小寫正規化
  expect(declared.has('# comment')).toBe(false);    // 註解不算
});

// docker：把「宣告的」相依（過 SAFE_PKG 白名單）在容器內以 pip 安裝
test('installModuleRequirements：容器內 pip 安裝宣告的相依（含 xlsxtpl/smbprotocol）', async () => {
  const log = await envAgent.installModuleRequirements(projectId);
  expect(dockerEnv.execPipInstall).toHaveBeenCalled();
  const [, pkgs] = dockerEnv.execPipInstall.mock.calls[0];
  expect(pkgs).toEqual(expect.arrayContaining(['xlsxtpl', 'smbprotocol']));
  expect(log).toContain('[pip-docker] OK');
});

test('installModuleRequirements：容器未運行 → 回空字串、不裝', async () => {
  dockerEnv.containerRunning.mockResolvedValueOnce(false);
  const log = await envAgent.installModuleRequirements(projectId);
  expect(log).toBe('');
  expect(dockerEnv.execPipInstall).not.toHaveBeenCalled();
});

// F4 針對性補裝：合法套件名 → 容器內 pip install 單一套件，回 ok:true
test('installPythonPackage：合法套件名 → 容器內 pip 補裝、回 ok', async () => {
  const { ok } = await envAgent.installPythonPackage(projectId, 'xlsxtpl');
  expect(ok).toBe(true);
  const [, pkgs] = dockerEnv.execPipInstall.mock.calls[0];
  expect(pkgs).toEqual(['xlsxtpl']);
});

// 安全：非法套件名（會被 pip 當旗標）在進 docker 前就被 SAFE_PKG 擋下，不進 pip
test('installPythonPackage：非法套件名 → 不裝、回 ok:false', async () => {
  const { ok } = await envAgent.installPythonPackage(projectId, '--index-url=http://evil');
  expect(ok).toBe(false);
  expect(dockerEnv.execPipInstall).not.toHaveBeenCalled();
});
