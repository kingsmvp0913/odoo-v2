// 意圖：升級前補裝模組 Python 相依（健檢 F5）——manifest 宣告的套件批次 pip，一顆名字打錯不得拖垮整批，
// 須逐一 fallback、失敗留痕；以及 getDeclaredPythonDeps（健檢 F6 的「有無宣告」判準來源）正確蒐集宣告名。
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'envdeps-'));
process.env.ODOO_ENV_BASE = TMP; // 必須在 require env-agent 前設定（ENV_BASE 於載入時定值）

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, execFile: jest.fn() };
});

const { newDb } = require('pg-mem');
let dbModule, envAgent, execFileMock, projectId;
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

  // venv python 要存在，否則 installModuleRequirements 直接回空字串（視為環境未建）
  const isWin = process.platform === 'win32';
  const venvDir = path.join(TMP, DIR, 'venv', isWin ? 'Scripts' : 'bin');
  fs.mkdirSync(venvDir, { recursive: true });
  fs.writeFileSync(path.join(venvDir, isWin ? 'python.exe' : 'python'), '');

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

  ({ execFile: execFileMock } = require('child_process'));
  envAgent = require('../pipeline/env-agent');
});

afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => execFileMock.mockReset());

// F6 判準來源：宣告名（manifest external_dependencies.python ＋ requirements.txt 頂層名）小寫、去版本/extras
test('getDeclaredPythonDeps：蒐齊 manifest 與 requirements 的宣告名（小寫、去版本）', async () => {
  const declared = await envAgent.getDeclaredPythonDeps(projectId);
  expect(declared.has('xlsxtpl')).toBe(true);       // manifest
  expect(declared.has('smbprotocol')).toBe(true);   // manifest
  expect(declared.has('qrcode')).toBe(true);        // requirements.txt，版本被去掉
  expect(declared.has('pillow')).toBe(true);        // 小寫正規化
  expect(declared.has('# comment')).toBe(false);    // 註解不算
});

// F5：manifest 批次 pip 失敗（一顆打錯）→ 逐一 fallback，好的照裝、壞的留 FAIL 痕跡，不整批全翻
test('installModuleRequirements：批次 pip 失敗 → 逐一 fallback、失敗留痕', async () => {
  execFileMock.mockImplementation((bin, args, opts, cb) => {
    const pkgArgs = args.slice(args.indexOf('--') + 1);
    if (args.includes('-r')) return cb(null, 'req ok', '');            // requirements.txt 檔
    if (pkgArgs.length > 1) return cb(Object.assign(new Error('batch fail'), { code: 1 }), '', 'batch fail'); // 批次一鑊翻
    if (pkgArgs[0] === 'smbprotocol') return cb(Object.assign(new Error('no dist'), { code: 1 }), '', 'no matching distribution'); // 這顆真的裝不動
    return cb(null, `installed ${pkgArgs[0]}`, '');                    // 其餘逐一成功
  });
  const log = await envAgent.installModuleRequirements(projectId);
  expect(log).toContain('BATCH FAIL');           // 有偵測到批次失敗並改逐一
  expect(log).toContain('[pip-manifest] OK xlsxtpl');   // 好的照裝
  expect(log).toContain('[pip-manifest] FAIL smbprotocol'); // 壞的留痕，不拖垮好的
});

// F4 針對性補裝：合法套件名 → pip install 單一套件，回 ok:true
test('installPythonPackage：合法套件名 → pip 補裝、回 ok', async () => {
  execFileMock.mockImplementation((bin, args, opts, cb) => cb(null, 'installed', ''));
  const { ok, log } = await envAgent.installPythonPackage(projectId, 'xlsxtpl');
  expect(ok).toBe(true);
  expect(log).toContain('[pip-fix] OK xlsxtpl');
  const [, args] = execFileMock.mock.calls[0];
  expect(args).toEqual(expect.arrayContaining(['-m', 'pip', 'install', '--', 'xlsxtpl']));
});

// 安全：非法套件名（會被 pip 當旗標）直接拒裝，不進 pip argv
test('installPythonPackage：非法套件名 → 不裝、回 ok:false', async () => {
  const { ok } = await envAgent.installPythonPackage(projectId, '--index-url=http://evil');
  expect(ok).toBe(false);
  expect(execFileMock).not.toHaveBeenCalled();
});
