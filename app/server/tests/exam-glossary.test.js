const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');
const { collectTerms, syncGlossary, lookupTerms, variants } = require('../lib/exam/glossary');

let dbModule, tmpCore;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  // 造一個迷你的 odoo-core 目錄：兩個模組，其中 Sales Order 有兩種譯法
  tmpCore = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-core-'));
  const mk = (mod, body) => {
    const d = path.join(tmpCore, 'addons', mod, 'i18n');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'zh_TW.po'), body);
  };
  mk('sale', [
    'msgid "Sales Order"', 'msgstr "銷售訂單"', '',
    'msgid "Delivery Orders"', 'msgstr "交貨單"', '',
    'msgid "This order cannot be cancelled."', 'msgstr "此訂單無法取消。"',
  ].join('\n'));
  mk('stock', [
    'msgid "Sales Order"', 'msgstr "銷售訂單"', '',
    'msgid "Sales Order"', 'msgstr "銷售單"', '',
    'msgid "Reordering Rule"', 'msgstr "重訂貨規則"',
  ].join('\n'));
});

afterAll(() => {
  dbModule._setPoolForTesting(null);
  fs.rmSync(tmpCore, { recursive: true, force: true });
});

test('掃目錄抽出術語，整句話被濾掉', () => {
  const terms = collectTerms(tmpCore);
  expect(terms.has('Sales Order')).toBe(true);
  expect(terms.has('Delivery Orders')).toBe(true);
  expect(terms.has('This order cannot be cancelled.')).toBe(false);
});

// 實測有 473 個英文對到多個中文，取出現次數最高的那個
test('一個英文多個中文時取出現最多的', () => {
  const terms = collectTerms(tmpCore);
  expect(terms.get('Sales Order').zh).toBe('銷售訂單');   // 2 次 vs 銷售單 1 次
  expect(terms.get('Sales Order').hits).toBe(2);
});

test('記錄來自哪些模組', () => {
  const terms = collectTerms(tmpCore);
  expect([...terms.get('Sales Order').modules].sort()).toEqual(['sale', 'stock']);
});

describe('variants', () => {
  test('單數要試複數', () => {
    expect(variants('Delivery Order')).toContain('Delivery Orders');
  });
  test('複數要試單數', () => {
    expect(variants('Delivery Orders')).toContain('Delivery Order');
  });
  test('y 結尾的複數形', () => {
    expect(variants('Company')).toContain('Companies');
  });
  test('原字一定排第一', () => {
    expect(variants('Vendor')[0]).toBe('Vendor');
  });
  test('空字串回空陣列', () => {
    expect(variants('')).toEqual([]);
  });
});

test('syncGlossary 寫進 DB 且可重跑不重複', async () => {
  const a = await syncGlossary(dbModule, '19', tmpCore);
  expect(a.upserted).toBeGreaterThan(0);
  const before = await dbModule.query('SELECT COUNT(*)::int AS c FROM exam_glossary');
  await syncGlossary(dbModule, '19', tmpCore);
  const after = await dbModule.query('SELECT COUNT(*)::int AS c FROM exam_glossary');
  expect(after.rows[0].c).toBe(before.rows[0].c);
});

// 這是需求 2 的核心：實測 "Delivery Order" 直接查是 MISS，因為 po 裡是複數。
test('單數形的 Delivery Order 也查得到交貨單', async () => {
  await syncGlossary(dbModule, '19', tmpCore);
  const hits = await lookupTerms(dbModule, '19', 'Where do you find the Delivery Order?');
  expect(hits.find(h => h.zh === '交貨單')).toBeTruthy();
});

test('查詢只回該版本的術語', async () => {
  await syncGlossary(dbModule, '19', tmpCore);
  const hits = await lookupTerms(dbModule, '17', 'What is a Sales Order?');
  expect(hits).toEqual([]);
});

// 長的排前面，prompt 裡才不會被短的蓋掉
test('多個術語命中時長的排前面', async () => {
  await syncGlossary(dbModule, '19', tmpCore);
  const hits = await lookupTerms(dbModule, '19', 'A Sales Order and a Reordering Rule');
  expect(hits.length).toBeGreaterThanOrEqual(2);
  expect(hits[0].en.length).toBeGreaterThanOrEqual(hits[hits.length - 1].en.length);
});

test('空白文字不查詢', async () => {
  expect(await lookupTerms(dbModule, '19', '   ')).toEqual([]);
});
