// 意圖：Odoo 安裝模組時，缺的相依「一次只報第一個」（`您要安裝的模組 'idx_kjco' 依賴於
// 'l10n_tw_city'，但後者在您系統中不可用`）。缺三個就要來回三輪，每輪都得等一次完整升級才知道
// 下一個是誰。這裡驗證平台在建立環境時就把缺的**全部**掃出來，一次列進建立記錄。
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockDbQuery = jest.fn();
jest.mock('../db', () => ({ query: (...a) => mockDbQuery(...a) }));
jest.mock('../lib/docker-env', () => {
  const actual = jest.requireActual('../lib/docker-env');
  return {
    ...actual,
    listContainerModules: jest.fn(),
    containerRunning: jest.fn().mockResolvedValue(true),
    containerNameFor: actual.containerNameFor,
  };
});

const dockerEnv = require('../lib/docker-env');
const {
  moduleDependsFrom, scanProjectModules, missingModuleDepends, formatMissingDepends,
} = require('../pipeline/env-agent');

let base;
beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-depends-')); });
afterAll(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 清不掉不影響判定 */ } });
beforeEach(() => { mockDbQuery.mockReset(); dockerEnv.listContainerModules.mockReset(); });

function writeModule(dir, name, depends) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '__manifest__.py'),
    `{\n 'name': '${name}',\n 'depends': [${depends.map(d => `'${d}'`).join(', ')}],\n}\n`);
}

// projectAddonsPaths 與 dockerCtxFor 都只走 query，依 SQL 內容分派即可。
function mockDb({ repos, version = '17.0', edition = 'community' }) {
  mockDbQuery.mockImplementation((sql) => {
    if (/FROM projects p/.test(sql)) {
      return Promise.resolve({ rows: [{ name: 'p', folder_name: 'p', odoo_version: version, edition, port: 8070 }] });
    }
    if (/local_path, repo_url/.test(sql)) return Promise.resolve({ rows: repos });
    if (/FROM project_repos/.test(sql)) {
      return Promise.resolve({ rows: repos.map(r => ({ label: 'main', clone_status: 'done', local_path: r.local_path })) });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('moduleDependsFrom', () => {
  test('多行 depends → 全數抽出', () => {
    expect(moduleDependsFrom("{\n 'depends': [\n 'base',\n 'sale',\n 'l10n_tw_city',\n ],\n}")).
      toEqual(['base', 'sale', 'l10n_tw_city']);
  });
  test('無 depends／空輸入 → 空陣列，不炸', () => {
    expect(moduleDependsFrom("{ 'name': 'x' }")).toEqual([]);
    expect(moduleDependsFrom(null)).toEqual([]);
  });
  test('非模組名的畸形項丟棄（depends 會被當 Python 套件名 import）', () => {
    expect(moduleDependsFrom("{ 'depends': ['base', '../evil', 'a b', 'ok_1'] }")).toEqual(['base', 'ok_1']);
  });
});

describe('scanProjectModules', () => {
  test('一般 repo：模組是第一層子資料夾', async () => {
    const repo = path.join(base, 'normal');
    writeModule(path.join(repo, 'idx_a'), 'A', ['base', 'sale']);
    writeModule(path.join(repo, 'idx_b'), 'B', ['idx_a']);
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true }); // 不是模組，不得誤收
    mockDb({ repos: [{ local_path: repo, repo_url: 'https://x/normal.git' }] });
    const got = await scanProjectModules(1);
    expect([...got.keys()].sort()).toEqual(['idx_a', 'idx_b']);
    expect(got.get('idx_a')).toEqual(['base', 'sale']);
  });

  test('repo 根自己就是模組（冠今形狀）：模組名取 repo 名，不是目錄名', async () => {
    // 掃不到這種形狀＝整個 repo 的相依靜默漏檢，而漏檢的症狀跟「沒有缺件」長得一模一樣。
    const repo = path.join(base, 'rootmod', 'main');
    writeModule(repo, 'kjco', ['base', 'l10n_tw_city']);
    fs.mkdirSync(path.join(repo, 'models'), { recursive: true });
    mockDb({ repos: [{ local_path: repo, repo_url: 'https://github.com/x/idx_kjco.git' }] });
    const got = await scanProjectModules(1);
    expect([...got.keys()]).toEqual(['idx_kjco']);
    expect(got.get('idx_kjco')).toEqual(['base', 'l10n_tw_city']);
  });
});

describe('missingModuleDepends', () => {
  test('一次列出全部缺的，並帶出「誰要它」', async () => {
    const repo = path.join(base, 'missing');
    writeModule(path.join(repo, 'idx_a'), 'A', ['base', 'l10n_tw_city', 'web_gantt']);
    writeModule(path.join(repo, 'idx_b'), 'B', ['base', 'l10n_tw_city']);
    mockDb({ repos: [{ local_path: repo, repo_url: 'https://x/r.git' }] });
    dockerEnv.listContainerModules.mockResolvedValue(['base', 'sale']);
    const { missing, checked } = await missingModuleDepends(1);
    expect(checked).toBe(true);
    expect([...missing.keys()].sort()).toEqual(['l10n_tw_city', 'web_gantt']);
    expect(missing.get('l10n_tw_city')).toEqual(['idx_a', 'idx_b']);
  });

  test('專案內模組互相 depends 不算缺（它跟著一起被掛進去）', async () => {
    const repo = path.join(base, 'internal');
    writeModule(path.join(repo, 'idx_a'), 'A', ['base']);
    writeModule(path.join(repo, 'idx_b'), 'B', ['idx_a']);
    mockDb({ repos: [{ local_path: repo, repo_url: 'https://x/r.git' }] });
    dockerEnv.listContainerModules.mockResolvedValue(['base']);
    const { missing } = await missingModuleDepends(1);
    expect(missing.size).toBe(0);
  });

  test('查不到容器模組清單 → checked=false，不得回報成「沒有缺件」', async () => {
    // 這兩者的差別就是「真的都在」與「根本沒檢查」，混為一談等於在沒查的情況下印一句都沒問題。
    mockDb({ repos: [{ local_path: path.join(base, 'internal'), repo_url: 'https://x/r.git' }] });
    dockerEnv.listContainerModules.mockResolvedValue(null);
    expect((await missingModuleDepends(1)).checked).toBe(false);
  });
});

describe('formatMissingDepends', () => {
  test('有缺件 → 列出全部並說明 Odoo 只報第一個', () => {
    const out = formatMissingDepends({ checked: true, missing: new Map([['l10n_tw_city', ['idx_kjco']]]) });
    expect(out).toContain('l10n_tw_city');
    expect(out).toContain('idx_kjco');
    expect(out).toContain('缺 1 個');
  });
  test('沒查成 → 明說未檢查，不得寫成 OK', () => {
    const out = formatMissingDepends({ checked: false, missing: new Map() });
    expect(out).toContain('未檢查');
    expect(out).not.toContain('OK');
  });
  test('真的沒缺 → OK', () => {
    expect(formatMissingDepends({ checked: true, missing: new Map() })).toContain('OK');
  });
});
