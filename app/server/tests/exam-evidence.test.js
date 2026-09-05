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
  // 企業版證據保留 ent/ 前綴，社群版不留——既有 150 筆存的都是去前綴的社群版路徑，
  // 全部改格式等於動到舊資料。所以「沒前綴」繼續代表社群版。
  test('企業版路徑保留 ent/ 前綴，社群版維持去前綴', () => {
    const { safeSourceRef } = require('../lib/exam/evidence');
    expect(safeSourceRef('ent/project_enterprise/models/project_task.py:41'))
      .toBe('ent/project_enterprise/models/project_task.py:41');
    expect(safeSourceRef('src/addons/sale/models/sale_order.py:88'))
      .toBe('addons/sale/models/sale_order.py:88');
    expect(safeSourceRef('ent/../../etc/passwd')).toBeNull();
  });

  // agent 拿到的是 --add-dir 的真實目錄（`…/19/community`、`…/19/enterprise`），
  // 它回引用時**會自己把共同的上層砍掉**，剩下 `community/…`／`enterprise/…`。
  // 實跑一頁 8 題，15 筆引用全長這樣、全被丟掉，DB 一筆證據都沒進——
  // 而且畫面上只顯示「證據路徑不合法」，看不出是格式沒對上。
  test('引用相對暫存區根目錄時（community/…、enterprise/…）也收', () => {
    const { safeSourceRef } = require('../lib/exam/evidence');
    const dirs = [
      { name: 'src', path: '/tmp/odoo-exam-src/19/community' },
      { name: 'ent', path: '/tmp/odoo-exam-src/19/enterprise' },
    ];
    expect(safeSourceRef('community/addons/project/models/project_task.py:371', dirs))
      .toBe('addons/project/models/project_task.py:371');
    expect(safeSourceRef('enterprise/project_enterprise/models/project_task.py:1151', dirs))
      .toBe('ent/project_enterprise/models/project_task.py:1151');
    // 絕對路徑那條原本就要收，不能因為加了這條而壞掉
    expect(safeSourceRef('/tmp/odoo-exam-src/19/community/addons/sale/models/sale_order.py:88', dirs))
      .toBe('addons/sale/models/sale_order.py:88');
    // 逃逸照樣擋
    expect(safeSourceRef('community/../../../etc/passwd', dirs)).toBeNull();
  });

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

// 查證方法抽成獨立檔案，靠「複製進沙箱」而不是 Claude Code 的 skill 機制。
// 實測：子行程的 cwd 是暫存目錄，專案的 .claude/skills/ 在那裡載不到，
// 只載得到 ~/.claude/skills/ 的 user scope——而那份不進版控又全平台共用。
describe('查證指引檔', () => {
  const fs = require('fs');
  const path = require('path');
  const { ensureEvidenceCwd, buildBatchEvidencePrompt } = require('../lib/exam/evidence');

  test('指引檔會被複製進沙箱，agent 讀得到', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'core-'));
    fs.mkdirSync(path.join(dir, '19'), { recursive: true });
    const prev = process.env.ODOO_CORE_SRC_DIR;
    process.env.ODOO_CORE_SRC_DIR = dir;
    jest.resetModules();
    const { ensureEvidenceCwd: fresh } = require('../lib/exam/evidence');
    const cwd = fresh('19');
    expect(fs.existsSync(path.join(cwd, 'evidence-guide.md'))).toBe(true);
    expect(fs.readFileSync(path.join(cwd, 'evidence-guide.md'), 'utf8')).toContain('只有 `src/` 底下');
    if (prev === undefined) delete process.env.ODOO_CORE_SRC_DIR;
    else process.env.ODOO_CORE_SRC_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('批次 prompt 叫 agent 先讀指引，並要求逐題回報', () => {
    const p = buildBatchEvidencePrompt({
      questions: [
        { no: 1, question: 'Q1', options: [{ letter: 'A', text: 'a' }], candidate: ['A'] },
        { no: 5, question: 'Q5', options: [], candidate: [] },
      ],
      odooVersion: '19',
    });
    expect(p).toContain('evidence-guide.md');
    expect(p).toContain('第 1 題');
    expect(p).toContain('第 5 題');
    expect(p).toContain('"results"');
    // 漏回整題的話下游分不出「查過查不到」與「漏查」
    expect(p).toMatch(/每一題都要有一筆/);
  });
});

// 併行時 5 個 worker 共用一個沙箱會爆兩種：一個在重建 symlink 的瞬間另一個看到
// 空目錄（實測 P4 失敗，訊息「工作目錄下沒有 src/ 或 ent/」），以及兩頁的截圖
// 都叫 shot.jpg 互相蓋掉——後者不會報錯，抄出來的題目是別頁的。
describe('併行沙箱', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  test('unique 模式每次給不同目錄，各自掛好原始碼', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-'));
    fs.mkdirSync(path.join(dir, '19'), { recursive: true });
    const prev = process.env.ODOO_CORE_SRC_DIR;
    process.env.ODOO_CORE_SRC_DIR = dir;
    jest.resetModules();
    const { ensureEvidenceCwd: fresh } = require('../lib/exam/evidence');

    const a = fresh('19', { unique: true });
    const b = fresh('19', { unique: true });
    expect(a).not.toBe(b);
    for (const d of [a, b]) {
      expect(fs.existsSync(path.join(d, 'src'))).toBe(true);
      expect(fs.existsSync(path.join(d, 'challenge-guide.md'))).toBe(true);
    }
    for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
    if (prev === undefined) delete process.env.ODOO_CORE_SRC_DIR;
    else process.env.ODOO_CORE_SRC_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
