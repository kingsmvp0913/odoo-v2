const { newDb } = require('pg-mem');
const {
  buildEvidencePrompt, normalizeEvidence, saveEvidence, needsEvidence, EVIDENCE_THRESHOLD,
} = require('../lib/exam/evidence');

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});

afterAll(() => { dbModule._setPoolForTesting(null); });

describe('needsEvidence', () => {
  // 使用者拍板的門檻：信心 < 90 才強制取證。第 0 期實測約 37% 的題會進這一步，
  // 總成本約 ×1.37 而不是翻倍。
  test('門檻是 90', () => {
    expect(EVIDENCE_THRESHOLD).toBe(90);
    expect(needsEvidence({ confidence: 89 })).toBe(true);
    expect(needsEvidence({ confidence: 90 })).toBe(false);
    expect(needsEvidence({ confidence: 95 })).toBe(false);
  });

  test('沒有信心數字的一律取證', () => {
    expect(needsEvidence({ confidence: null })).toBe(true);
    expect(needsEvidence({})).toBe(true);
  });

  // 被推翻的題不管信心多高都要證據——「它說錯了但講不出根據」是 45 分，
  // 拿得出原始碼行號才是 30 分，那個差距要靠取證分辨
  test('被推翻的題一律取證', () => {
    expect(needsEvidence({ confidence: 99, refuted: true })).toBe(true);
  });
});

describe('buildEvidencePrompt', () => {
  const base = {
    question: 'Where is the Reordering Rule defined?',
    options: [{ letter: 'A', text: 'Inventory > Products' }, { letter: 'B', text: 'Inventory > Ops' }],
    candidate: ['B'],
    odooVersion: '19',
  };

  test('題幹與選項進 prompt', () => {
    const p = buildEvidencePrompt(base);
    expect(p).toContain('Reordering Rule');
    expect(p).toContain('Inventory > Products');
  });

  // agent 只能看到 src/（symlink 指向該版本的 odoo-core），不可以往外跑——
  // answer-key.json 與 questions.json 的官方答案就在同一個 repo 裡
  test('明確限定只能查 src/ 底下', () => {
    const p = buildEvidencePrompt(base);
    expect(p).toContain('src/');
    expect(p).toMatch(/只.*src|不要.*src 以外|限定/);
  });

  test('要求回報檔案與行號', () => {
    const p = buildEvidencePrompt(base);
    expect(p).toMatch(/行號|:\d+|line/i);
  });

  // 查不到就該說查不到。拿無關片段替推理背書比不查更糟（原文件實測結論）
  test('允許回報「查不到」', () => {
    const p = buildEvidencePrompt(base);
    expect(p).toMatch(/查不到|找不到/);
    expect(p).toMatch(/不要.*背書|無關片段|不要硬湊/);
  });

  test('版本寫進 prompt', () => {
    expect(buildEvidencePrompt(base)).toContain('19');
  });
});

describe('normalizeEvidence', () => {
  test('原始碼證據存相對路徑', () => {
    const r = normalizeEvidence({ evidence: [
      { kind: 'source', ref: 'src/addons/stock/models/product.py:412', excerpt: 'def _get_orderpoint' }] });
    expect(r.evidence[0]).toMatchObject(
      { kind: 'source', ref: 'addons/stock/models/product.py:412' });
  });

  // 落在 src/ 之外的一律丟棄——即使 prompt 說了不要，那是 soft instruction。
  // Node 端這一關是硬的，agent 亂跑也帶不回來。
  test('src 以外的路徑被丟棄並記錄', () => {
    const r = normalizeEvidence({ evidence: [
      { kind: 'source', ref: 'data/exam/answer-key.json:3' },
      { kind: 'source', ref: '/home/odoo/odoo-v2/.claude/CLAUDE.md:1' },
      { kind: 'source', ref: 'src/addons/sale/models/sale_order.py:88' },
    ] });
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].ref).toBe('addons/sale/models/sale_order.py:88');
    expect(r.rejected).toHaveLength(2);
  });

  test('往上跳目錄的相對路徑也被丟棄', () => {
    const r = normalizeEvidence({ evidence: [
      { kind: 'source', ref: 'src/../../../etc/passwd:1' }] });
    expect(r.evidence).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  test('文件類證據不受路徑限制', () => {
    const r = normalizeEvidence({ evidence: [
      { kind: 'docs', ref: '/websites/odoo_saas-19_1', excerpt: '…' }] });
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].kind).toBe('docs');
  });

  test('查不到證據時回空陣列而非硬湊', () => {
    const r = normalizeEvidence({ found: false, evidence: [], reason: '原始碼與文件都不描述這個情境' });
    expect(r.evidence).toEqual([]);
    expect(r.reason).toContain('不描述');
  });

  test('壞掉的輸入不拋錯', () => {
    expect(normalizeEvidence(null).evidence).toEqual([]);
    expect(normalizeEvidence({ evidence: 'not an array' }).evidence).toEqual([]);
  });

  // 沒有上限的話 agent 可以把任意檔案的內容整段塞進 excerpt，路徑檢查就白做了
  test('過長的 excerpt 被截斷', () => {
    const r = normalizeEvidence({ evidence: [
      { kind: 'source', ref: 'src/addons/sale/models/sale_order.py:1', excerpt: 'x'.repeat(5000) }] });
    expect(r.evidence[0].excerpt.length).toBeLessThan(700);
    expect(r.evidence[0].excerpt).toMatch(/已截斷/);
  });
});

describe('saveEvidence', () => {
  let verdictId;

  beforeAll(async () => {
    const it = await dbModule.query(
      `INSERT INTO exam_items (odoo_version, fingerprint, question_en, options, qtype)
       VALUES ('19', 'ev-fp', 'Q', '[]'::jsonb, 'single') RETURNING id`);
    const v = await dbModule.query(
      `INSERT INTO exam_verdicts (item_id, kind, refuted, confidence, model)
       VALUES ($1, 'adversary', false, 80, 'claude-opus-5') RETURNING id`, [it.rows[0].id]);
    verdictId = v.rows[0].id;
  });

  test('證據掛在該筆 verdict 底下', async () => {
    const n = await saveEvidence(dbModule, { verdictId, evidence: [
      { kind: 'source', ref: 'addons/stock/models/product.py:412', excerpt: 'x' },
      { kind: 'docs', ref: '/websites/odoo_saas-19_1' },
    ] });
    expect(n).toBe(2);
    const rows = await dbModule.query(
      `SELECT kind, ref FROM exam_evidence WHERE verdict_id = $1 ORDER BY kind`, [verdictId]);
    expect(rows.rows.map(r => r.kind)).toEqual(['docs', 'source']);
  });

  test('空證據不寫任何列', async () => {
    const before = await dbModule.query('SELECT COUNT(*)::int c FROM exam_evidence');
    expect(await saveEvidence(dbModule, { verdictId, evidence: [] })).toBe(0);
    const after = await dbModule.query('SELECT COUNT(*)::int c FROM exam_evidence');
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });
});
