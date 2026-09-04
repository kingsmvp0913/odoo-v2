const { baseConfidence, calibrateSection } = require('../lib/exam/confidence');

const src = [{ kind: 'source', ref: 'addons/purchase/models/product.py:412' }];
const docs = [{ kind: 'docs', ref: '/websites/odoo_saas-19_1' }];

describe('baseConfidence 分層', () => {
  // 100 專屬官方，其他來源永遠達不到——否則 /api/exam/lookup 的「只回 100%」失去意義
  test('官方確認的題是 100', () => {
    expect(baseConfidence({ certain: true, evidence: [] }).confidence).toBe(100);
    expect(baseConfidence({ hasOfficial: true, evidence: [] }).confidence).toBe(100);
  });

  test('官方確認優先於任何審查結果', () => {
    const r = baseConfidence({
      certain: true, verdict: { refuted: true, confidence: 99, correct_answer: ['D'] }, evidence: src });
    expect(r.confidence).toBe(100);
  });

  // null 是「不知道」，0 是「確定會錯」，兩件事
  test('沒有審查過就沒有數字，不是 0', () => {
    const r = baseConfidence({ certain: false, verdict: null, evidence: [] });
    expect(r.confidence).toBeNull();
    expect(r.why).toMatch(/尚未審查/);
  });

  test('推不翻＋原始碼佐證 92，理由帶出檔案行號', () => {
    const r = baseConfidence({ verdict: { refuted: false, confidence: 95 }, evidence: src });
    expect(r.confidence).toBe(92);
    expect(r.why).toContain('product.py:412');
  });

  test('推不翻＋只有文件佐證 85', () => {
    expect(baseConfidence({ verdict: { refuted: false, confidence: 95 }, evidence: docs })
      .confidence).toBe(85);
  });

  test('推不翻＋沒取證 80', () => {
    expect(baseConfidence({ verdict: { refuted: false, confidence: 95 }, evidence: [] })
      .confidence).toBe(80);
  });

  // 取證後仍低信心＝兩邊都沒站穩，不能因為「沒推翻」就給 80
  test('推不翻但自評低於 70 只有 60', () => {
    expect(baseConfidence({ verdict: { refuted: false, confidence: 55 }, evidence: src })
      .confidence).toBe(60);
  });

  test('推翻＋沒證據 45，理由要講出它認為的答案', () => {
    const r = baseConfidence({
      verdict: { refuted: true, confidence: 70, correct_answer: ['D'] }, evidence: [] });
    expect(r.confidence).toBe(45);
    expect(r.why).toContain('D');
  });

  test('推翻＋原始碼佐證 30', () => {
    expect(baseConfidence({
      verdict: { refuted: true, confidence: 90, correct_answer: ['D'] }, evidence: src })
      .confidence).toBe(30);
  });

  // 同一個模型審兩次不是兩個獨立意見（實測非決定性 2-3 題/120），加分要很小氣
  test('多次審查都沒推翻最多加 3 分', () => {
    const r = baseConfidence({
      verdict: { refuted: false, confidence: 95 }, evidence: src, agreeCount: 5 });
    expect(r.confidence).toBe(95);   // 92 + 3，不是 92 + 15
  });

  test('加分後仍不得達到 100', () => {
    const r = baseConfidence({
      verdict: { refuted: false, confidence: 99 }, evidence: src, agreeCount: 99 });
    expect(r.confidence).toBeLessThanOrEqual(99);
  });

  test('被推翻的題不因為審過很多次而加分', () => {
    const r = baseConfidence({
      verdict: { refuted: true, confidence: 90, correct_answer: ['D'] }, evidence: src, agreeCount: 9 });
    expect(r.confidence).toBe(30);
  });
});

describe('calibrateSection', () => {
  // 官方說某章 n 題錯 k 題是硬事實：該章風險總和必須恰好等於 k
  test('風險總和被縮放到等於官方的錯題數', () => {
    const items = [
      { confidence: 80, certain: false, answered: true },
      { confidence: 80, certain: false, answered: true },
      { confidence: 60, certain: false, answered: true },
    ];
    calibrateSection(items, { incorrect: 1 });
    const risk = items.reduce((s, i) => s + (100 - i.confidence) / 100, 0);
    expect(risk).toBeCloseTo(1, 1);
    expect(items.every(i => i.calibrated)).toBe(true);
  });

  // certain 是硬事實，被縮放就等於承認它可能錯
  test('certain 的題不參與縮放且維持 100', () => {
    const items = [
      { confidence: 100, certain: true, answered: true },
      { confidence: 50, certain: false, answered: true },
    ];
    calibrateSection(items, { incorrect: 1 });
    expect(items[0].confidence).toBe(100);
    expect(items[0].calibrated).toBeFalsy();
    expect(items[1].confidence).toBe(0);   // 整章的 1 題錯全落在它身上
  });

  // 沒作答的題不該被算成「答對的機率」
  test('未作答的題排除在校準外', () => {
    const items = [
      { confidence: null, certain: false, answered: false },
      { confidence: 80, certain: false, answered: true },
    ];
    const r = calibrateSection(items, { incorrect: 1 });
    expect(items[0].confidence).toBeNull();
    expect(r.scaled).toBe(1);
    expect(items[1].confidence).toBe(0);
  });

  // 官方說有錯但每題都被判 100%——這是矛盾，不可以硬縮放假裝沒事
  test('可縮放風險為零但官方說有錯時不縮放並具名回報', () => {
    const items = [{ confidence: 100, certain: true, answered: true }];
    const r = calibrateSection(items, { incorrect: 2 });
    expect(r.scaled).toBe(0);
    expect(r.note).toMatch(/對不上/);
    expect(items[0].confidence).toBe(100);
  });

  test('該章全對時所有題的風險為零', () => {
    const items = [{ confidence: 80, certain: false, answered: true }];
    calibrateSection(items, { incorrect: 0 });
    expect(items[0].confidence).toBe(100);
    expect(items[0].calibrated).toBe(true);
  });

  // 沒有官方章節結果＝沒有可校準的總量，數字維持原樣並標未校準（規格 §6.6）
  test('沒有官方章節結果時不動任何數字', () => {
    const items = [{ confidence: 80, certain: false, answered: true }];
    const r = calibrateSection(items, { incorrect: null });
    expect(items[0].confidence).toBe(80);
    expect(items[0].calibrated).toBeFalsy();
    expect(r.note).toMatch(/未校準/);
  });

  // 縮放後不得跑到 0-100 之外
  test('風險放大時信心夾在 0 以上', () => {
    const items = [
      { confidence: 90, certain: false, answered: true },
      { confidence: 90, certain: false, answered: true },
    ];
    calibrateSection(items, { incorrect: 2 });   // 目標風險 2，原始只有 0.2
    expect(items.every(i => i.confidence >= 0 && i.confidence <= 100)).toBe(true);
  });

  test('整章都還沒審查時不縮放', () => {
    const items = [
      { confidence: null, certain: false, answered: true },
      { confidence: null, certain: false, answered: true },
    ];
    const r = calibrateSection(items, { incorrect: 1 });
    expect(r.scaled).toBe(0);
    expect(items.every(i => i.confidence === null)).toBe(true);
  });
});
