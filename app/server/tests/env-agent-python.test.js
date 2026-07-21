// 意圖：自動部署測試區需涵蓋 Odoo 13→未來 20+，各版本相容的 Python 不同。
// resolveSystemPython 要能「全自動」為每個版本挑對直譯器，免逐版本人工設定：
// override 最優先、依相容表探測、未知未來版走當代 Python、都探不到才回退且不 throw。
const { resolveSystemPython, ODOO_PYTHON_PREFS } = require('../pipeline/env-agent');

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k === 'PYTHON_BIN' || k.startsWith('PYTHON_BIN_')) delete process.env[k];
  }
});

test('override PYTHON_BIN_<major> 最優先（逃生艙）', async () => {
  process.env.PYTHON_BIN_13 = '/custom/py38';
  const r = await resolveSystemPython('13');
  expect(r.python).toBe('/custom/py38');
});

test('全域 PYTHON_BIN 作為 override fallback', async () => {
  process.env.PYTHON_BIN = '/global/py';
  const r = await resolveSystemPython('17');
  expect(r.python).toBe('/global/py');
});

// Rule 9：這條驗「版本→Python」的對應意圖——舊版綁舊 Python、新版綁新 Python。
// 若有人把 13 的偏好改成新 Python（會讓舊 gevent 編譯失敗）此測試就該紅。
test('相容表：舊版綁舊 Python、新版綁新 Python', () => {
  expect(ODOO_PYTHON_PREFS[13]).toContain('3.8');
  expect(ODOO_PYTHON_PREFS[13]).not.toContain('3.12');
  expect(ODOO_PYTHON_PREFS[14]).toContain('3.8');
  expect(ODOO_PYTHON_PREFS[19]).toContain('3.12');
  expect(ODOO_PYTHON_PREFS[19]).not.toContain('3.6');
});

test('未知未來版本（20）無 override → 不 throw，回退可用直譯器並附警告 note', async () => {
  const r = await resolveSystemPython('20');
  expect(typeof r.python).toBe('string');
  expect(r.python.length).toBeGreaterThan(0);
  expect(typeof r.note).toBe('string');
});
