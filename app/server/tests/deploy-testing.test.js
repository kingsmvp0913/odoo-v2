// 意圖：部署測試區用純程式升級。升級成功往下 E2E；升級失敗＝程式錯，退 coding 並計數，
// 滿上限改 stopped；環境起不來屬 infra 錯，直接 stopped（不退 coding、不呼叫升級）。
const { newDb } = require('pg-mem');

jest.mock('../notify', () => ({ emitToUser: jest.fn() }));
jest.mock('../pipeline/env-agent', () => ({
  upgradeModules: jest.fn(),
  installModuleRequirements: jest.fn(),
  getDeclaredPythonDeps: jest.fn(),
  installPythonPackage: jest.fn(),
  runEnvSetup: jest.fn(),
  restartEnv: jest.fn().mockResolvedValue({ ok: true }),
  assetSmokeCheck: jest.fn().mockResolvedValue({ ok: true }),
  addonsMountDrift: jest.fn().mockResolvedValue([]),
  // asset traceback 走 `docker logs`（容器 CMD 沒有 --logfile，宿主上不存在 odoo.log）
  dockerCtxFor: jest.fn().mockResolvedValue({ container: 'odoo_test_proj' })
}));
jest.mock('../lib/docker-env', () => ({
  containerExists: jest.fn().mockResolvedValue(true),
  containerLogs: jest.fn().mockResolvedValue('')
}));
jest.mock('../pipeline/claude-runner', () => ({ runClaude: jest.fn() })); // 分類器 agent fallback 用
jest.mock('../pipeline/git', () => ({
  discardPyc: jest.fn().mockResolvedValue(undefined),
  ensureTestingBranch: jest.fn().mockResolvedValue(undefined)
}));

let dbModule, runDeployTesting, envAgent;
let userId, projectId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('p', 4);
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('dt', $1, 'D') RETURNING id", [hash]
  );
  userId = u.id;
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('DP', '17.0') RETURNING id"
  );
  projectId = p.id;

  envAgent = require('../pipeline/env-agent');
  ({ runDeployTesting } = require('../pipeline/deploy-testing'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('extractOdooError：抽出結尾真正錯誤，而非開頭版本/addons paths 橫幅', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = [
    'Odoo version 17.0',
    "addons paths: ['C:\\\\odoo-v2\\\\odoo-envs\\\\cwt\\\\src\\\\odoo\\\\addons']",
    'loading module base (1/50)',
    '2026-07-06 09:31:43 ERROR test_cwt odoo.modules.loading: Failed to load module idx_sale_note_t',
    'ParseError: Invalid view definition in idx_sale_note_t/views/x.xml line 5'
  ].join('\n');
  const out = extractOdooError(log);
  expect(out).toContain('ParseError');
  expect(out).not.toContain('Odoo version 17.0');
});

// 意圖：blocker 要讓人一眼看到原因。Python traceback 原因在結尾例外行，開頭是無用呼叫堆疊；
// 舊版從開頭切 → 使用者只看到 server.py→decorator.py、真正原因被截掉、被迫翻 log。
test('extractOdooError：多層 traceback → 帶出結尾例外行（真正原因），非開頭呼叫堆疊', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = [
    'Traceback (most recent call last):',
    '  File ".../odoo/service/server.py", line 1422, in preload_registries',
    '    registry = Registry.new(dbname, update_module=update_module)',
    '  File ".../decorator.py", line 232, in fun',
    '    return caller(func, *(extras + args), **kw)',
    'odoo.exceptions.UserError: Unable to install module "alnas_xlsx" because an external dependency is not met: Python library not installed: xlsxtpl'
  ].join('\n');
  const out = extractOdooError(log);
  expect(out.startsWith('odoo.exceptions.UserError')).toBe(true); // 例外行放最前
  expect(out).toContain('xlsxtpl');                               // 真正原因帶出來
  expect(out).toContain('external dependency');
  expect(out).not.toContain('preload_registries');               // 開頭無用的呼叫堆疊不塞給人
});

// 舊意圖是「回傳整段 traceback、開頭 Traceback header」；改版後改為「原因（結尾例外行）放最前」——
// blocker 一眼可讀，不再開頭塞無用 header／banner（完整 traceback 仍在 saveDeployLog 落的 log 檔供 agent 定位）。
test('extractOdooError：traceback → 帶出結尾例外行（原因）放最前，不含 banner/header', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = 'banner\naddons paths...\nTraceback (most recent call last)\n  File "x.py", line 3\nKeyError: sale_order';
  const out = extractOdooError(log);
  expect(out.startsWith('KeyError')).toBe(true);   // 原因在最前
  expect(out).toContain('KeyError');
  expect(out).not.toContain('banner');             // 開頭 banner/header 不塞給人
});

// 意圖：Python 的 chained exception（`raise X from Y`）真因在**第一段**，結尾那段只是包裝。
// Odoo 載入 data 檔時任何例外都會被包成 ParseError，所以這是 deploy 失敗的高頻形態。
// 舊版一律取「最後一個例外行」→ 只拿到 ParseError 與被截斷的 XML，肇事的 .py 檔與行號完全消失，
// 使用者與 coding agent 都只能去翻 log 檔（task 171 實例：真因在 alnas_xlsx，卻被報成 idx_hj 的 XML 有問題）。
test('extractOdooError：chained exception → 根因（第一段）與肇事檔案行號必須帶出，不能只有外層包裝', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = [
    'Traceback (most recent call last):',
    '  File "/usr/lib/python3/dist-packages/odoo/tools/convert.py", line 610, in _tag_root',
    '    f(rec)',
    '  File "/mnt/extra-addons/repo/alnas_xlsx/models/ir_actions_report.py", line 30, in _check_report_type',
    '    and not rec.report_xlsx_jinja_template_name.endswith(".xlsx")',
    "AttributeError: 'bool' object has no attribute 'endswith'",
    '',
    'The above exception was the direct cause of the following exception:',
    '',
    'Traceback (most recent call last):',
    '  File "/usr/lib/python3/dist-packages/odoo/service/server.py", line 1392, in preload_registries',
    '    registry = Registry.new(dbname, update_module=update_module)',
    'odoo.tools.convert.ParseError: while parsing /mnt/extra-addons/repo/idx_hj/reports/idx_maintenance_report.xml:15, somewhere inside',
    '<record id="action_report_repair_maintenance" model="ir.actions.report">',
    '            <field name="name">研發報價單</field>'
  ].join('\n');
  const out = extractOdooError(log);
  expect(out).toContain('AttributeError');                              // 根因例外
  expect(out).toContain('alnas_xlsx/models/ir_actions_report.py');      // 肇事檔案——舊版完全看不到
  expect(out).toContain('30');                                          // 肇事行號
  expect(out).toContain('ParseError');                                  // 外層包裝仍保留（知道是載入誰時炸的）
  expect(out).toContain('idx_maintenance_report.xml');                  // 觸發點
});

// 意圖：`During handling of the above exception` 是另一種串接寫法（隱式鏈），同樣要帶出根因。
test('extractOdooError：During handling 隱式鏈 → 同樣帶出根因', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = [
    'Traceback (most recent call last):',
    '  File "/mnt/extra-addons/repo/idx_hj/models/x.py", line 12, in _compute',
    'KeyError: sale_employee_id',
    '',
    'During handling of the above exception, another exception occurred:',
    '',
    'Traceback (most recent call last):',
    '  File ".../odoo/models.py", line 4918, in _create',
    'odoo.exceptions.ValidationError: 欄位設定有誤'
  ].join('\n');
  const out = extractOdooError(log);
  expect(out).toContain('KeyError');
  expect(out).toContain('idx_hj/models/x.py');
  expect(out).toContain('ValidationError');
});

beforeEach(async () => {
  envAgent.upgradeModules.mockReset();
  envAgent.installModuleRequirements.mockReset().mockResolvedValue('');
  envAgent.getDeclaredPythonDeps.mockReset().mockResolvedValue(new Set());
  envAgent.installPythonPackage.mockReset().mockResolvedValue({ ok: true, log: '[pip-fix] OK\n' });
  envAgent.runEnvSetup.mockReset();
  envAgent.restartEnv.mockReset().mockResolvedValue({ ok: true });
  envAgent.assetSmokeCheck.mockReset().mockResolvedValue({ ok: true });
  envAgent.addonsMountDrift.mockReset().mockResolvedValue([]);
  require('../pipeline/claude-runner').runClaude.mockReset(); // 分類器 agent fallback，避免測試順序相依
  const git = require('../pipeline/git');
  git.discardPyc.mockReset().mockResolvedValue(undefined);
  git.ensureTestingBranch.mockReset().mockResolvedValue(undefined);
  await dbModule.query('DELETE FROM odoo_envs WHERE project_id=$1', [projectId]);
  await dbModule.query('DELETE FROM project_repos WHERE project_id=$1', [projectId]);
});

let seq = 0;
async function makeTask(deployCount = 0, analysisYaml = 'module: sale') {
  seq++;
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, status, project_id, analysis_yaml, deploy_retry_count)
     VALUES ($1,$2,'odoo','T','deploy_testing',$3,$5,$4) RETURNING id`,
    [userId, `dt_${seq}`, projectId, deployCount, analysisYaml]
  );
  return t.id;
}
async function setEnvRunning() {
  await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1, 'running')", [projectId]);
}

test('env 運行 + 升級成功 → playwright_running', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
  const id = await makeTask();
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('playwright_running');
  expect(envAgent.upgradeModules).toHaveBeenCalledWith(projectId, ['sale'], undefined);
  // 升級成功必須重啟常駐容器，否則常駐 server 仍持舊 controllers，新路由開測試區報錯（手動重啟才好）
  expect(envAgent.restartEnv).toHaveBeenCalledWith(projectId);
});

// 拆模組／搬檔案的任務同時動兩個模組，只升級其中一個時：另一個的 view 改動與 migration 完全不會
// 執行，而升級照樣 exit 0＝假成功。實測 task 195：規格只寫 idx_purchase，idx_project 的 pre-migrate
// 一次都沒被執行，錯誤卻指向新模組的 xpath，真因完全看不出來。
// 用兩個模組＋逗號後帶空白，同時驗「有拆開」與「有 trim」——舊碼會原封不動傳成單一元素的陣列。
test('規格 module 列多個模組 → 一次全部升級', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
  const id = await makeTask(0, 'module: idx_project, idx_purchase');
  await runDeployTesting(id, userId);
  expect(envAgent.upgradeModules).toHaveBeenCalledWith(projectId, ['idx_project', 'idx_purchase'], undefined);
});

// 意圖：容器掛載在 docker run 那一刻定型，環境建好之後才加進專案的 repo 補掛不進去，其模組在測試區
// 根本不存在。放行只會對著殘缺的環境升級並判綠燈（實測萊峰19：容器只掛 main，純水的碼從不在測試區），
// 錯誤訊息也完全指不到成因。擋在升級之前，且不得自動重建——那會中斷使用者正在用的測試區。
test('容器缺掛新加入的 repo → stopped(env)，不升級', async () => {
  await setEnvRunning();
  envAgent.addonsMountDrift.mockResolvedValue(['純水']);
  const id = await makeTask();

  await runDeployTesting(id, userId);

  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
  expect(t.blocker_content).toContain('純水');       // 要指名是哪個 repo，否則沒人知道該修什麼
  expect(t.blocker_content).toContain('重建測試環境'); // 以及該做什麼
  expect(envAgent.upgradeModules).not.toHaveBeenCalled();
});

// 意圖：OWL/QWeb template（static/src/xml）的 xpath 錯誤只在瀏覽器首次請求 bundle 時 lazy 編譯才現形，
// 且失敗是 WARNING＋404 不改 exit code——-u --stop-after-init 與無 tour 的 E2E 都碰不到，會一路綠燈到白屏。
// 升級＋重啟後補一道 asset 冒煙檢查，明確 404/500 即判 code 失敗退 coding，不放行成 review/playwright。
test('升級+重啟成功但後台 asset bundle 404（前端 template xpath 錯）→ 判 code 失敗退回 coding', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
  envAgent.assetSmokeCheck.mockResolvedValue({ ok: false, assetError: true, reason: 'web.assets_web.min.js → 404', bundleUrl: '/web/assets/x/web.assets_web.min.js' });
  const id = await makeTask();
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  // asset 檢查必須排在重啟之後（測的是新 registry），故 restartEnv 先被呼叫
  expect(envAgent.restartEnv).toHaveBeenCalledWith(projectId);
  expect(envAgent.assetSmokeCheck).toHaveBeenCalledWith(projectId);
});

// 意圖：連續失敗觸頂改 stopped 時，失敗訊息一樣要落 retry_feedback。舊版只寫 blocker_content（給人看的
// 停下原因），而 retry_feedback 在上一輪 coding 推進時已被清成 NULL——使用者填修正指示 → 分診判 fix →
// 回 coding 時，coding 的【上一次執行的失敗訊息】欄位是空的，只能依 prompt 契約判定無事可做而空轉。
// 未觸頂的退回分支一直都有寫，偏偏「停等人工後再繼續」這條人最可能走的路沒寫（實測 task 109）。
test('asset 失敗觸頂 stopped → retry_feedback 仍帶失敗訊息，供分診／coding 讀', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
  envAgent.assetSmokeCheck.mockResolvedValue({ ok: false, assetError: true, reason: 'web.assets_web.min.js → 500' });
  const id = await makeTask(2); // 本次為第 3 次＝觸頂
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_content).toContain('asset');   // 給人看的停下原因照舊
  expect(t.retry_feedback).toContain('asset');    // 給 coding 讀的失敗訊息不得遺漏
});

// 同上，升級失敗（非 asset）那條路徑也一樣：觸頂 stopped 不能把失敗訊息只留在 blocker_content。
test('升級失敗觸頂 stopped → retry_feedback 仍帶失敗訊息', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error(
    'Traceback\nodoo.tools.convert.ParseError: External ID not found: website_sale_wishlist.product_wishlist'
  ));
  const id = await makeTask(2); // 本次為第 3 次＝觸頂
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.retry_feedback).toContain('External ID not found');
});

// 意圖：連不上／registry 未就緒／拿不到 bundle URL 一律 inconclusive，不得阻斷部署（比照重啟失敗不擋），
// 避免暫態誤報把好任務打回 coding。
test('asset 檢查 inconclusive（無法確認）→ 不阻斷，照常進 playwright_running', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
  envAgent.assetSmokeCheck.mockResolvedValue({ ok: true, inconclusive: 'registry_not_ready' });
  const id = await makeTask();
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('playwright_running');
});

test('升級成功但重啟失敗 → 不阻斷部署，仍進 playwright_running（碼已進 DB）', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
  envAgent.restartEnv.mockRejectedValue(new Error('重啟後埠未監聽'));
  const id = await makeTask();
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('playwright_running');
});

test('專案停用 E2E + 升級成功 → 跳過 tour，直接 review_pending 並留痕跡', async () => {
  await dbModule.query('UPDATE projects SET e2e_disabled=true WHERE id=$1', [projectId]);
  try {
    await setEnvRunning();
    envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
    const id = await makeTask();
    await runDeployTesting(id, userId);
    const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
    expect(t.status).toBe('review_pending');   // 純程式跳過，不進 playwright_running
    const { rows: logs } = await dbModule.query("SELECT content FROM task_logs WHERE task_id=$1", [id]);
    expect(logs.some(l => l.content.includes('E2E 已依專案設定停用，跳過'))).toBe(true);
  } finally {
    await dbModule.query('UPDATE projects SET e2e_disabled=false WHERE id=$1', [projectId]);
  }
});

// --- 分支歸位：addons-path 指主 clone 工作樹，別任務的 analysis/approve 會把 clone 留在 main，
//     不先 checkout testing 就會對錯的分支升級（假綠燈）---

test('升級前逐 repo 切回 testing 分支（先 discardPyc 再 checkout，於升級之前）', async () => {
  await setEnvRunning();
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/dp/main',true,'done')",
    [projectId]
  );
  envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
  const git = require('../pipeline/git');
  const id = await makeTask();
  await runDeployTesting(id, userId);

  expect(git.ensureTestingBranch).toHaveBeenCalledWith('/repos/dp/main');
  expect(git.discardPyc.mock.invocationCallOrder[0]).toBeLessThan(git.ensureTestingBranch.mock.invocationCallOrder[0]);
  expect(git.ensureTestingBranch.mock.invocationCallOrder[0]).toBeLessThan(envAgent.upgradeModules.mock.invocationCallOrder[0]);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('playwright_running');
});

test('checkout testing 失敗 → stopped(env)，不升級、不退 coding', async () => {
  await setEnvRunning();
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, is_primary, clone_status) VALUES ($1,'main','u','/repos/dp/main',true,'done')",
    [projectId]
  );
  require('../pipeline/git').ensureTestingBranch.mockRejectedValue(new Error('checkout blocked'));
  const id = await makeTask();
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
  expect(t.deploy_retry_count).toBe(0);
  expect(envAgent.upgradeModules).not.toHaveBeenCalled();
});

// --- 手動暫停：中止子行程屬使用者操作，不是失敗，狀態原地、不分類不計數 ---

test('升級中 abort（signal.aborted）→ 狀態停在 deploy_testing、不計數、無 blocker', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(Object.assign(new Error('killed'), { killed: true }));
  const ctrl = new AbortController();
  ctrl.abort();
  const id = await makeTask();
  await runDeployTesting(id, userId, ctrl.signal);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('deploy_testing');
  expect(t.blocker_content).toBeNull();
  expect(t.deploy_retry_count).toBe(0);
});

test('升級失敗未達上限 → coding_running、計數+1', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error('ParseError: bad view'));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.deploy_retry_count).toBe(1);
  // 升級失敗（退 coding）不該重啟——重啟只在部署成功漏斗
  expect(envAgent.restartEnv).not.toHaveBeenCalled();
});

test('升級失敗第 3 次（code 類）→ stopped', async () => {
  await setEnvRunning();
  // 測 code 路徑的重試上限：需用「明確開發者寫錯」字串（反轉舉證後模糊字串會歸 env、不佔計數）
  envAgent.upgradeModules.mockRejectedValue(new Error('ParseError: bad view'));
  const id = await makeTask(2);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.deploy_retry_count).toBe(3);
});

// 意圖：升級前自動補裝各模組宣告的 Python 相依（env 建置只裝 Odoo 核心 requirements，模組自帶的漏裝→
// 宣告 external dependency 的模組安裝時就缺）。必須在 upgradeModules 之前跑，相依才會就位。
test('deploy 升級前先補裝模組 Python 相依，且在 upgradeModules 之前', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockResolvedValue({ ok: true });
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  expect(envAgent.installModuleRequirements).toHaveBeenCalledWith(projectId, undefined);
  expect(envAgent.installModuleRequirements.mock.invocationCallOrder[0])
    .toBeLessThan(envAgent.upgradeModules.mock.invocationCallOrder[0]);   // 補裝在升級之前
});

test('環境起不來 → stopped（不退 coding、不升級）', async () => {
  // 無 odoo_envs row；runEnvSetup 不改狀態 → 仍非 running
  envAgent.runEnvSetup.mockResolvedValue(undefined);
  const id = await makeTask();
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(envAgent.upgradeModules).not.toHaveBeenCalled();
});

// --- 健檢根因 C：診斷資訊不得丟失 ---

test('extractOdooError：無 ERROR/Traceback → 明確標注疑環境層問題（而非默默回傳 banner）', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = 'Odoo version 17.0\naddons paths: [...]';  // 12 秒就死的行程，log 只有 banner
  const out = extractOdooError(log);
  expect(out).toContain('無 ERROR/Traceback');
  expect(out).toContain('環境或啟動層');
});

test('升級失敗（banner-only）→ 判 env、完整 log 落地成檔，blocker_content 附檔案路徑供事後鑑識', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  process.env.DEPLOY_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deploylog-'));
  try {
    await setEnvRunning();
    // stderr 只有 banner（無 ERROR/Traceback）＝進程在載入模組前就死，屬啟動層問題 → 反轉舉證後歸 env
    const err = new Error('short banner only');
    err.exitCode = 1; err.stdout = 'stdout 裡的線索'; err.stderr = 'short banner only';
    envAgent.upgradeModules.mockRejectedValue(err);
    const id = await makeTask(0);
    await runDeployTesting(id, userId);

    const { rows: [t] } = await dbModule.query('SELECT blocker_type, blocker_content FROM tasks WHERE id=$1', [id]);
    expect(t.blocker_type).toBe('env');
    expect(t.blocker_content).toContain('完整 log：');
    const logPath = t.blocker_content.match(/完整 log：(.+)$/m)[1].trim();
    const saved = fs.readFileSync(logPath, 'utf8');
    expect(saved).toContain('exitCode: 1');
    expect(saved).toContain('stdout 裡的線索'); // stderr 之外的輸出不得丟棄
  } finally {
    delete process.env.DEPLOY_LOG_DIR;
  }
});

// 意圖：log 檔名不得由 deploy_retry_count 單獨決定——那個計數會被分診歸零（reject-triage.js:184，
// 終點是 coding 就清空下游計數器），於是「失敗→人工填修正指示→再失敗」這條最常走的路上，第二份
// log 會用同一個編號寫回去，把第一次的完整 traceback 靜默蓋掉。事後鑑識拿到的是最後一次，前面的
// 診斷線索全沒了。同樣的問題 env 路徑早就用時間戳解掉（:394 註解），code 路徑沒跟上。
// 佐證：正式 data/logs 裡 -1 有 21 份、-3 有 5 份，-2 一份都沒有——遞增編號不可能長這樣。
test('人工介入把 deploy 計數歸零後再次失敗 → 兩次的 log 並存，不覆蓋前一份', async () => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploylog-dup-'));
  const prev = process.env.DEPLOY_LOG_DIR;
  process.env.DEPLOY_LOG_DIR = dir;
  try {
    await setEnvRunning();
    const id = await makeTask(0);

    envAgent.upgradeModules.mockRejectedValue(new Error('Traceback\nodoo.tools.convert.ParseError: FIRST-FAILURE-MARKER'));
    await runDeployTesting(id, userId);

    // 分診：使用者填修正指示 → 回 coding，下游計數器一併歸零，任務再走一次部署
    await dbModule.query("UPDATE tasks SET deploy_retry_count=0, status='deploy_testing' WHERE id=$1", [id]);

    envAgent.upgradeModules.mockRejectedValue(new Error('Traceback\nodoo.tools.convert.ParseError: SECOND-FAILURE-MARKER'));
    await runDeployTesting(id, userId);

    const bodies = fs.readdirSync(dir).filter(f => f.endsWith('.log'))
      .map(f => fs.readFileSync(path.join(dir, f), 'utf8'));
    expect(bodies).toHaveLength(2);
    expect(bodies.some(b => b.includes('FIRST-FAILURE-MARKER'))).toBe(true);
    expect(bodies.some(b => b.includes('SECOND-FAILURE-MARKER'))).toBe(true);
  } finally {
    if (prev == null) delete process.env.DEPLOY_LOG_DIR; else process.env.DEPLOY_LOG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===== 主題 A：部署失敗依分類分流（根因 B）=====

test('A-3 env 類失敗（DB 連不上）→ stopped、blocker_type=env、deploy 計數不變、不退 coding', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error('could not connect to server: Connection refused'));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');            // 不退 coding
  expect(t.blocker_type).toBe('env');
  expect(t.deploy_retry_count).toBe(0);        // 環境問題不佔計數（＝根因 B 修好）
  // 判定寫進執行歷程，人工能看出「為什麼停」（不再黑箱）。pg-mem 的 LIKE 抓不到中文子字串，改 JS 過濾
  const { rows: ev } = await dbModule.query('SELECT content FROM task_events WHERE task_id=$1', [id]);
  const verdict = ev.map(r => r.content).filter(c => c.includes('部署失敗判定'));
  expect(verdict).toHaveLength(1);
  expect(verdict[0]).toMatch(/環境問題/);
});

test('A-3 code 類失敗（ParseError）→ 退 coding、計數+1（現行不破）', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error('Traceback\nodoo.tools.convert.ParseError: bad view'));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.deploy_retry_count).toBe(1);
  // 判定寫進歷程，人工能看出「為什麼回開發、第幾次」（不再黑箱）。pg-mem LIKE 抓不到中文，改 JS 過濾
  const { rows: ev } = await dbModule.query('SELECT content FROM task_events WHERE task_id=$1', [id]);
  const verdict = ev.map(r => r.content).filter(c => c.includes('部署失敗判定'));
  expect(verdict).toHaveLength(1);
  expect(verdict[0]).toMatch(/程式問題/);
  expect(verdict[0]).toMatch(/第 1\/3/);
});

test('A-3 transient 失敗 → 自動重試一次；第二次成功 → playwright，計數不變', async () => {
  await setEnvRunning();
  envAgent.upgradeModules
    .mockRejectedValueOnce(new Error('read ECONNRESET'))
    .mockResolvedValueOnce({ ok: true, log: 'ok' });
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(envAgent.upgradeModules).toHaveBeenCalledTimes(2);  // 重試一次
  expect(t.status).toBe('playwright_running');
  expect(t.deploy_retry_count).toBe(0);                      // transient 不佔計數
});

test('A-3 unknown → 叫 deploy-fix agent；回 env → 走 env 路徑', async () => {
  const { runClaude } = require('../pipeline/claude-runner');
  runClaude.mockResolvedValue({ text: '{"type":"env"}' });
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error('some novel unrecognized failure zzz'));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
  expect(t.deploy_retry_count).toBe(0);
});

// ===== 健檢修補：F8 timeout、F9 計數歸零、F4/F6/F7 缺套件細分 =====

// F8：升級逾時被殺（err.killed，非手動 abort）→ 重試無益，直接 env 停等人工，只跑一次升級。
test('F8 升級逾時被殺（killed，非 abort）→ stopped(env)、不重試、不佔計數', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(Object.assign(new Error('killed'), { killed: true }));
  const id = await makeTask(0);
  await runDeployTesting(id, userId); // 無 signal，故非手動 abort
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
  expect(t.deploy_retry_count).toBe(0);
  expect(envAgent.upgradeModules).toHaveBeenCalledTimes(1); // 不重試再 hang
});

// P4：進程猝死（非我方 kill、非常規退出碼如 Windows 4294967295）＋ log 只到核心模組載入、無任何 Odoo
// 錯誤行 → infra／資源層死亡（改本模組救不了核心猝死），一律 env 停等人工，不被 classifier 瞎猜成 code 退 coding。
// 對應 107 事故：deploy log exitCode 4294967295、killed:no、只載到核心模組 hr(30/65) 即中止。
test('P4 進程猝死（非常規退出碼＋無 Odoo 錯誤，未達本模組）→ stopped(env)、不退 coding、不佔計數', async () => {
  await setEnvRunning();
  const err = new Error('loading module web_hierarchy (13/65)\nloading module hr (30/65)'); // 只到核心模組載入、無 ERROR/Traceback
  err.exitCode = 4294967295; err.killed = false; err.stderr = err.message;
  envAgent.upgradeModules.mockRejectedValue(err);
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
  expect(t.deploy_retry_count).toBe(0);            // infra 猝死不佔計數、不退 coding
  expect(envAgent.upgradeModules).toHaveBeenCalledTimes(1); // 不重試再猝死一次
  const { rows: ev } = await dbModule.query('SELECT content FROM task_events WHERE task_id=$1', [id]);
  expect(ev.map(r => r.content).some(c => c.includes('進程異常結束'))).toBe(true);
});

// P4-容器：容器內指令被訊號砍死時退出碼是 128+N（137=SIGKILL／OOM-kill、139=SIGSEGV），
// 不是 Windows 原生 process 那種 >=2^31 的形狀。deploy 已 docker 化，OOM 走的正是這條——
// 漏認會落到 haiku 分類器被瞎猜成 code、退 coding 重寫一整輪程式碼然後再 OOM 一次（純燒 token）。
// 鑑別力：光看 status/blocker_type 沒用（泛用 env 路徑也是 stopped+env），必須斷言
// 「沒問 haiku」＋「blocker 是猝死專屬文案」才分得出有沒有走到 stopEnvDeath。
test('P4-容器 exitCode 137（OOM-kill）＋無 Odoo 錯誤 → stopEnvDeath，不問 haiku、不退 coding', async () => {
  const { runClaude } = require('../pipeline/claude-runner');
  await setEnvRunning();
  const err = new Error('loading module base (1/65)\nloading module web (12/65)'); // 只到核心模組載入
  err.exitCode = 137; err.killed = false; err.stderr = err.message;
  envAgent.upgradeModules.mockRejectedValue(err);
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, blocker_content, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
  expect(t.deploy_retry_count).toBe(0);
  expect(t.blocker_content).toContain('進程異常結束'); // 猝死專屬文案，非泛用「環境問題（非程式碼）」
  expect(t.blocker_content).toContain('137');          // 退出碼帶進 blocker 供人鑑識
  expect(runClaude).not.toHaveBeenCalled();            // 在 classifier 之前攔下＝零 token
  expect(envAgent.upgradeModules).toHaveBeenCalledTimes(1); // 不重試再 OOM 一次
});

test('P4-容器 exitCode 139（SIGSEGV）＋無 Odoo 錯誤 → stopEnvDeath，不問 haiku、不退 coding', async () => {
  const { runClaude } = require('../pipeline/claude-runner');
  await setEnvRunning();
  const err = new Error('loading module base (1/65)');
  err.exitCode = 139; err.killed = false; err.stderr = err.message;
  envAgent.upgradeModules.mockRejectedValue(err);
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, blocker_content, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
  expect(t.deploy_retry_count).toBe(0);
  expect(t.blocker_content).toContain('進程異常結束');
  expect(runClaude).not.toHaveBeenCalled();
});

// P4-容器 邊界：128+N 這個「形狀」本身不足以判定被訊號砍死（一般工具也能正常回這區間的值）。
// 只收 137／139 這兩個資源層猝死的訊號，不整段收 129–159；143（SIGTERM）＝有秩序地被要求停止
//（docker stop／夜間關機），語意不是資源層死亡 → 仍交既有 classifier（落 env，結果一樣安全）。
test('P4-容器 邊界：exitCode 143（SIGTERM）不算猝死 → 走既有 classifier，非 stopEnvDeath 專屬文案', async () => {
  await setEnvRunning();
  const err = new Error('loading module base (1/65)');
  err.exitCode = 143; err.killed = false; err.stderr = err.message;
  envAgent.upgradeModules.mockRejectedValue(err);
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.blocker_content).not.toContain('進程異常結束'); // 沒有整段收 129–159
});

// P4 邊界：非常規退出碼但 log 有真 Odoo 錯誤（ParseError）→ 仍屬 code，退 coding（別把真程式錯誤放走）。
test('P4 邊界：非常規退出碼但 log 有 ParseError → 仍退 coding（不誤放）', async () => {
  await setEnvRunning();
  const err = new Error('Traceback (most recent call last)\nodoo.tools.convert.ParseError: bad view in idx_x');
  err.exitCode = 4294967295; err.killed = false; err.stderr = err.message;
  envAgent.upgradeModules.mockRejectedValue(err);
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.deploy_retry_count).toBe(1);
});

// F9：部署成功要歸零 deploy_retry_count——否則前輪累計會讓「E2E 退回改出的新 bug」首次部署就觸頂。
test('F9 前輪已累計 2 次、本輪升級成功 → playwright_running 且 deploy_retry_count 歸零', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
  const id = await makeTask(2);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('playwright_running');
  expect(t.deploy_retry_count).toBe(0);
});

// F7：'No module named odoo.addons.<自家 module>...' 是 coding 自己 import 打錯，非環境缺件 → 退 coding。
test('F7 自家 addon import 筆誤（odoo.addons.*）→ 退 coding、計數+1（不當 env）', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error("ModuleNotFoundError: No module named 'odoo.addons.idx_x.models.helper'"));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.deploy_retry_count).toBe(1);
  expect(t.retry_feedback).toContain('import');
});

// F6：缺第三方套件但 manifest／requirements 沒宣告 → 退 coding 補宣告（否則環境重建必復發）。
test('F6 缺套件但未宣告 → 退 coding、feedback 指示補宣告', async () => {
  await setEnvRunning();
  envAgent.getDeclaredPythonDeps.mockResolvedValue(new Set()); // 沒宣告
  envAgent.upgradeModules.mockRejectedValue(new Error("ModuleNotFoundError: No module named 'xlsxtpl'"));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.deploy_retry_count).toBe(1);
  expect(t.retry_feedback).toContain('external_dependencies');
  expect(t.retry_feedback).toContain('xlsxtpl');
  expect(envAgent.installPythonPackage).not.toHaveBeenCalled(); // 沒宣告不亂裝
});

// F4：缺套件且已宣告＝真環境缺件 → 自動 pip 補裝＋重試升級一次，成功即往下。
test('F4 缺套件已宣告 → 自動 pip 補裝＋重試升級，成功 → playwright_running', async () => {
  await setEnvRunning();
  envAgent.getDeclaredPythonDeps.mockResolvedValue(new Set(['xlsxtpl'])); // 已宣告
  envAgent.installPythonPackage.mockResolvedValue({ ok: true, log: '[pip-fix] OK xlsxtpl\n' });
  envAgent.upgradeModules
    .mockRejectedValueOnce(new Error("ModuleNotFoundError: No module named 'xlsxtpl'"))
    .mockResolvedValueOnce({ ok: true, log: 'ok' });
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(envAgent.installPythonPackage).toHaveBeenCalledWith(projectId, 'xlsxtpl', undefined);
  expect(envAgent.upgradeModules).toHaveBeenCalledTimes(2);   // 補裝後重試一次
  expect(t.status).toBe('playwright_running');
  expect(t.deploy_retry_count).toBe(0);
});

// F4 邊界：已宣告但 pip 仍裝不起來 → 維持 env 停等人工，blocker 帶 pip FAIL 痕跡。
test('F4 已宣告但 pip 裝不起來 → stopped(env)，blocker 帶 pip 補裝紀錄', async () => {
  await setEnvRunning();
  envAgent.getDeclaredPythonDeps.mockResolvedValue(new Set(['xlsxtpl']));
  envAgent.installPythonPackage.mockResolvedValue({ ok: false, log: '[pip-fix] FAIL xlsxtpl: no matching distribution\n' });
  envAgent.upgradeModules.mockRejectedValue(new Error("ModuleNotFoundError: No module named 'xlsxtpl'"));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, blocker_type, blocker_content, deploy_retry_count FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_type).toBe('env');
  expect(t.deploy_retry_count).toBe(0);
  expect(t.blocker_content).toContain('pip 補裝紀錄');
  expect(envAgent.upgradeModules).toHaveBeenCalledTimes(1); // pip 失敗就不再重試升級
});

// 意圖：套件在、版本太舊沒有該符號時，coding 手上必須有「釘版本無效」這個事實才走得下去。
// 實測 task 114：PyPDF2 1.26 無 PdfReader，agent 依規格在 requirements.txt 釘 >=2.0、QA 也放行，
// 但補裝只以套件名安裝、pip 見已安裝即略過 → 同一個錯原地重現，第二輪 agent 判「規格都已滿足」
// 零變更、撞無變更守衛停擺。斷言 feedback 帶「釘版本無效」與替代套件方向，正是那兩輪缺的東西。
test('版本不符（系統套件內缺符號）→ 退 coding，feedback 說明釘版本無效並指出替代套件方向', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error(
    "ImportError: cannot import name 'PdfReader' from 'PyPDF2' (/usr/lib/python3/dist-packages/PyPDF2/__init__.py)"
  ));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, deploy_retry_count, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');
  expect(t.deploy_retry_count).toBe(1);
  expect(t.retry_feedback).toContain('PyPDF2');
  expect(t.retry_feedback).toContain('PdfReader');
  expect(t.retry_feedback).toContain('釘版本對它無效'); // 沒這句 agent 會再釘一次版本
  expect(t.retry_feedback).toContain('替代套件');       // 指出唯一在 repo 端可行的方向
});

// 邊界：同一句 ImportError 也可能是開發者自己 import 打錯（載入路徑在 addons 內），此時 classifier
// 原本「模組在、名稱不對＝寫錯 import」的判讀就是對的。若不看載入路徑一律附上「換套件」指示，
// 會把單純的筆誤導去換第三方套件——比不給提示更糟。故此案必須維持原樣、不得混入版本不符文案。
test('版本不符 邊界：載入路徑在 addons 內（自家 import 筆誤）→ 不附加換套件指示', async () => {
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error(
    "ImportError: cannot import name 'compute_total' from 'odoo.addons.idx_x.models.helper' (/mnt/extra-addons/main/idx_x/models/helper.py)"
  ));
  const id = await makeTask(0);
  await runDeployTesting(id, userId);
  const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('coding_running');            // 仍是程式問題、仍退 coding
  expect(t.retry_feedback).not.toContain('替代套件'); // 但不得指使它去換套件
});

// 意圖：三段以上的鏈不能假設「第一段＝根因」。Odoo 的 @ormcache（_xmlid_lookup）在 cache-miss 時
// 於 except KeyError: 內重拋，於是「xmlid 指到不存在的 external id」——coding agent 最常犯、且只有
// deploy 這一關會攔到的錯——其錯誤鏈第一段永遠是 lru.py 的 KeyError，零診斷價值。
// 真正可行動的 ValueError 在後面的段。取錯段的後果不只是難讀：blocker_content 只截前 500 字，
// 開頭就被假根因佔滿，而 ↳ 會指向 Odoo core（CLAUDE.md 硬規則禁止修改的檔）。
test('extractOdooError：ormcache 假異常在前的三段鏈 → 取真正可行動的那一段，不取 KeyError', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = [
    'Traceback (most recent call last):',
    '  File "/usr/lib/python3/dist-packages/odoo/tools/lru.py", line 34, in __getitem__',
    '    return self.d[obj]',
    "KeyError: ('ir.model.data', <function IrModelData._xmlid_lookup at 0x7f00>, 'base.module_category_x')",
    '',
    'During handling of the above exception, another exception occurred:',
    '',
    'Traceback (most recent call last):',
    '  File "/usr/lib/python3/dist-packages/odoo/addons/base/models/ir_model.py", line 2208, in _xmlid_lookup',
    '    raise ValueError(...)',
    'ValueError: External ID not found in the system: base.module_category_x',
    '',
    'The above exception was the direct cause of the following exception:',
    '',
    'Traceback (most recent call last):',
    '  File "/usr/lib/python3/dist-packages/odoo/tools/convert.py", line 610, in _tag_root',
    'odoo.tools.convert.ParseError: while parsing /mnt/extra-addons/repo/idx_x/security/groups.xml:3, somewhere inside',
  ].join('\n');
  const out = extractOdooError(log);
  expect(out.startsWith('ValueError: External ID not found')).toBe(true);  // 可行動的根因放最前
  expect(out).toContain('base.module_category_x');                          // 缺的是哪個 xmlid
  expect(out).not.toContain('lru.py');                                      // 不把 ormcache 內部指成肇事點
  expect(out).toContain('groups.xml');                                      // 外層仍指出是載入哪個檔時炸的
});

// 反向守衛：只跳過「認得出的雜訊」。第一段若本來就是真根因（task 171 那種），不得被跳過。
test('extractOdooError：第一段就是真根因時不得被跳過', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = [
    'Traceback (most recent call last):',
    '  File "/mnt/extra-addons/repo/alnas_xlsx/models/ir_actions_report.py", line 30, in _check_report_type',
    "AttributeError: 'bool' object has no attribute 'endswith'",
    '',
    'The above exception was the direct cause of the following exception:',
    '',
    'Traceback (most recent call last):',
    'odoo.tools.convert.ParseError: while parsing /mnt/extra-addons/repo/idx_hj/reports/x.xml:15, somewhere inside',
  ].join('\n');
  const out = extractOdooError(log);
  expect(out.startsWith('AttributeError')).toBe(true);
  expect(out).toContain('alnas_xlsx/models/ir_actions_report.py');
});

// blameFrame 要挑「人動得了的檔」：Odoo 例外幾乎都從 core 拋出，取最內層會常態指向 core 或
// <decorator-gen-N> 這種 Python 動態產生的偽檔名（改不了也讀不了）。
test('extractOdooError：肇事點跳過 core 與 <decorator-gen> 偽路徑，指向客戶模組', () => {
  const { extractOdooError } = require('../pipeline/deploy-testing');
  const log = [
    'Traceback (most recent call last):',
    '  File "/mnt/extra-addons/repo/idx_hj/models/sale_order.py", line 88, in _compute_total',
    '  File "<decorator-gen-12>", line 2, in create',
    '  File "/usr/lib/python3/dist-packages/odoo/api.py", line 431, in _model_create_multi',
    'TypeError: unsupported operand',
    '',
    'The above exception was the direct cause of the following exception:',
    '',
    'odoo.tools.convert.ParseError: while parsing x.xml:1, somewhere inside',
  ].join('\n');
  const out = extractOdooError(log);
  expect(out).toContain('idx_hj/models/sale_order.py:88');
  expect(out).not.toContain('decorator-gen');
  expect(out).not.toContain('odoo/api.py');
});

// --- asset 失敗要附 runtime log 的真 traceback ---
// 意圖：assetSmokeCheck 只看得到 HTTP 狀態碼，reason 永遠是「bundle URL → HTTP 500」。真正的原因
// （哪個 template、哪個 xpath 對不到什麼）只在 Odoo runtime log 裡。不附這段，coding 收到的等於
// 一句「壞了」，只能猜——實測 task 109 猜了三輪都沒中，每輪燒完整條 pipeline。讀檔零 token 成本。
test('asset 失敗 → retry_feedback 附上容器 log 尾端的真 traceback', async () => {
  const dockerEnv = require('../lib/docker-env');
  dockerEnv.containerExists.mockResolvedValue(true);
  dockerEnv.containerLogs.mockResolvedValue(
    'ERROR odoo.addons.base.models.qweb Element "<xpath expr=\'//button[@id=\'add_to_cart_button\']\'>" cannot be located in parent view');
  await setEnvRunning();
  envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
  envAgent.assetSmokeCheck.mockResolvedValue({ ok: false, assetError: true, reason: 'web.assets_web.min.js → 500' });
  const id = await makeTask(0);
  await runDeployTesting(id, userId);

  const { rows: [t] } = await dbModule.query('SELECT retry_feedback FROM tasks WHERE id=$1', [id]);
  expect(t.retry_feedback).toContain('web.assets_web.min.js → 500');   // 原本的通用說明還在
  expect(t.retry_feedback).toContain('cannot be located in parent view'); // 真因也帶上了
  expect(t.retry_feedback).toContain('add_to_cart_button');              // 具體到哪個 xpath
  // 真的是問容器要的，不是讀宿主上某個檔——docker 模式的容器 CMD 沒有 --logfile，那個檔不存在
  expect(dockerEnv.containerLogs).toHaveBeenCalledWith('odoo_test_proj', expect.objectContaining({ tail: expect.any(Number) }));
});

// --- asset 失敗的完整內容必須落檔 ---
// 意圖：升級失敗有 saveDeployLog 落 data/logs（呼叫點四處），asset 失敗一次都沒呼叫過。於是那段
// traceback（實測 1177 字）的三條退路全不成立：blocker_content 只切 500 字、且只有觸頂那一輪才寫；
// retry_feedback 下一輪即被覆寫而且前端零渲染；時間軸指的「📄 查看 log」依 CLAUDE.md §6 是
// 「每次啟動清空、只留當次執行」的檔案——重啟過就沒了。等於完整內容實質遺失。
test('asset 失敗 → traceback 落檔到 data/logs，時間軸指向那個檔（不是會被清空的 runtime log）', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dockerEnv = require('../lib/docker-env');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-assetlog-'));
  const prev = process.env.DEPLOY_LOG_DIR;
  process.env.DEPLOY_LOG_DIR = dir;
  try {
    dockerEnv.containerExists.mockResolvedValue(true);
    dockerEnv.containerLogs.mockResolvedValue('ERROR odoo.addons.base.models.qweb TRACE-MARKER-9527 cannot be located in parent view');
    await setEnvRunning();
    envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
    envAgent.assetSmokeCheck.mockResolvedValue({ ok: false, assetError: true, reason: 'web.assets_web.min.js → 500' });
    const id = await makeTask(0);
    await runDeployTesting(id, userId);

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
    expect(files).toHaveLength(1);
    const body = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    expect(body).toContain('TRACE-MARKER-9527');           // 完整 traceback 真的留在磁碟上
    expect(body).toContain('web.assets_web.min.js → 500');

    // 時間軸那句「去哪看」必須指向真的找得到的位置
    const { rows: logs } = await dbModule.query(
      "SELECT content FROM task_logs WHERE task_id=$1 AND role='ai' ORDER BY id DESC LIMIT 1", [id]);
    expect(logs[0].content).toContain(files[0]);
    expect(logs[0].content).not.toContain('查看 log');      // 那個檔每次啟動就被清空
  } finally {
    if (prev == null) delete process.env.DEPLOY_LOG_DIR; else process.env.DEPLOY_LOG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 觸頂那一輪 blocker_content 只留 500 字，必然切在 traceback 中間——檔案路徑要在截斷之後補回去，
// 否則人工看到的停下原因裡沒有任何線索能通往完整內容。
test('asset 失敗觸頂 → blocker_content 截斷後仍保住 log 檔路徑', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dockerEnv = require('../lib/docker-env');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-assetlog2-'));
  const prev = process.env.DEPLOY_LOG_DIR;
  process.env.DEPLOY_LOG_DIR = dir;
  try {
    dockerEnv.containerExists.mockResolvedValue(true);
    dockerEnv.containerLogs.mockResolvedValue('X'.repeat(1200)); // 比 500 字的截斷長得多
    await setEnvRunning();
    envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
    envAgent.assetSmokeCheck.mockResolvedValue({ ok: false, assetError: true, reason: 'bundle → 500' });
    const id = await makeTask(2); // 本次為第 3 次＝觸頂
    await runDeployTesting(id, userId);

    const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [id]);
    expect(t.status).toBe('stopped');
    expect(t.blocker_content).toContain(dir);
  } finally {
    if (prev == null) delete process.env.DEPLOY_LOG_DIR; else process.env.DEPLOY_LOG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 升級失敗也要附 runtime log，分診才追得下去 ---
// 意圖：c8287fe 把 {{runtime_log_path}} 從分診 prompt 拿掉、改成告訴 agent「證據已附在上面」，
// 而分診讀得到的只有 blocker_content（reject-triage 的 stop_context 就是它）。升級失敗是最常見的
// 入口，卻從頭到尾沒附過任何 log（readAssetTraceback 原本只在 asset 分支被呼叫）——agent 依新
// prompt 判定「這次沒有可用的 runtime log」就不再追。
test('升級失敗觸頂 → blocker_content 附上容器 runtime log 尾端（分診的唯一證據來源）', async () => {
  const dockerEnv = require('../lib/docker-env');
  dockerEnv.containerExists.mockResolvedValue(true);
  dockerEnv.containerLogs.mockResolvedValue('CRITICAL test_proj odoo.modules RUNTIME-EVIDENCE-4711');
  await setEnvRunning();
  envAgent.upgradeModules.mockRejectedValue(new Error(
    'Traceback\nodoo.tools.convert.ParseError: External ID not found: website_sale_wishlist.product_wishlist'
  ));
  const id = await makeTask(2); // 本次為第 3 次＝觸頂 stopped，blocker_content 即分診的 stop_context
  await runDeployTesting(id, userId);

  const { rows: [t] } = await dbModule.query('SELECT status, blocker_content FROM tasks WHERE id=$1', [id]);
  expect(t.status).toBe('stopped');
  expect(t.blocker_content).toContain('External ID not found');  // 原本就有的摘要不能被擠掉
  expect(t.blocker_content).toContain('RUNTIME-EVIDENCE-4711');  // runtime log 真的附上了
});

// 容器不在／log 讀不到不得讓部署流程本身出錯——原本的失敗訊息照樣要落地。
test('asset 失敗但容器不存在 → 照常落 retry_feedback，不拋錯', async () => {
  const dockerEnv = require('../lib/docker-env');
  dockerEnv.containerExists.mockResolvedValue(false);
  dockerEnv.containerLogs.mockClear();
  try {
    await setEnvRunning();
    envAgent.upgradeModules.mockResolvedValue({ ok: true, log: 'ok' });
    envAgent.assetSmokeCheck.mockResolvedValue({ ok: false, assetError: true, reason: 'bundle → 500' });
    const id = await makeTask(0);
    await runDeployTesting(id, userId);

    const { rows: [t] } = await dbModule.query('SELECT status, retry_feedback FROM tasks WHERE id=$1', [id]);
    expect(t.status).toBe('coding_running');
    expect(t.retry_feedback).toContain('bundle → 500');
    expect(t.retry_feedback).not.toContain('runtime log 尾端');
    expect(dockerEnv.containerLogs).not.toHaveBeenCalled();
  } finally {
    dockerEnv.containerExists.mockResolvedValue(true);
  }
});
