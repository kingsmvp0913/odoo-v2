// 意圖：tour 測試＝deploy 的 odoo-bin 指令＋--test-enable --test-tags /<module>，對 test_<dir> DB 跑。
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'envtour-'));
process.env.ODOO_ENV_BASE = TMP; // 必須在 require env-agent 前設定（ENV_BASE 於載入時定值）

let execFileMock;
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, execFile: jest.fn() };
});

const { newDb } = require('pg-mem');
let dbModule, envAgent, projectId;
const DIR = 'TOURP';

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  await dbModule.query("INSERT INTO users (username, password_hash, display_name) VALUES ('t', $1, 'T')", [hash]);
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ('TourP', '17.0', $1) RETURNING id", [DIR]
  );
  projectId = p.id;
  // 讓 fs.existsSync(venvPython) 為真（否則 runTourTests 會先 throw「環境尚未建立」）
  const isWin = process.platform === 'win32';
  const venvDir = path.join(TMP, DIR, 'venv', isWin ? 'Scripts' : 'bin');
  fs.mkdirSync(venvDir, { recursive: true });
  fs.writeFileSync(path.join(venvDir, isWin ? 'python.exe' : 'python'), '');
  fs.mkdirSync(path.join(TMP, DIR, 'src'), { recursive: true });
  fs.writeFileSync(path.join(TMP, DIR, 'src', 'odoo-bin'), '');

  ({ execFile: execFileMock } = require('child_process'));
  envAgent = require('../pipeline/env-agent');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('runTourTests：odoo-bin 帶 --test-enable 與 --test-tags /<module>，對 test_<dir> 跑', async () => {
  execFileMock.mockImplementation((bin, args, opts, cb) => cb(null, 'idx_x tests: 1 passed, 0 failed', ''));
  const { ok, log } = await envAgent.runTourTests(projectId, 'idx_x');
  expect(ok).toBe(true);
  expect(log).toContain('1 passed');
  const [, args] = execFileMock.mock.calls[0];
  expect(args).toContain('--test-enable');
  const i = args.indexOf('--test-tags');
  expect(args[i + 1]).toBe('/idx_x');
  // 項4：HttpCase 必須綁自取的空閒埠，不落預設 8069（撞常駐 server）
  const hp = args.indexOf('--http-port');
  expect(hp).toBeGreaterThan(-1);
  expect(Number(args[hp + 1])).toBeGreaterThan(0);
  expect(args).toEqual(expect.arrayContaining(['-i', 'idx_x', '-u', 'idx_x', '-d', `test_${DIR}`, '--stop-after-init']));
});

test('runTourTests：未給 module 直接 throw', async () => {
  await expect(envAgent.runTourTests(projectId, '')).rejects.toThrow(/module/);
});
