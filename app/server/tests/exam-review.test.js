const { newDb } = require('pg-mem');
const { buildPrompt, buildExtractPrompt, buildReviewQuestionsPrompt, normalize, normalizeExtract,
  saveVerdicts, checkGlossary, termsIn } = require('../lib/exam/review');

let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});

afterAll(() => { dbModule._setPoolForTesting(null); });

describe('buildPrompt', () => {
  const base = { imageName: 'shot.jpg', theirAnswers: [['B'], ['A'], ['A']] };

  test('作答者的答案逐題進 prompt', () => {
    const p = buildPrompt(base);
    expect(p).toContain('第 1 題：B');
    expect(p).toContain('第 3 題：A');
  });

  // 第 0 期的 30/30 有這三條的功勞，拿掉就不是同一支 prompt 了
  test('三個判題陷阱段落必須在', () => {
    const p = buildPrompt(base);
    expect(p).toContain('Customer Location');
    expect(p).toContain('All of the above');
    expect(p).toContain('facet');
  });

  // 任務方向是「找出它為什麼錯」，但必須留退路，否則退化成無差別找碴
  test('有 escape hatch，不逼模型硬找碴', () => {
    const p = buildPrompt(base);
    expect(p).toMatch(/找不到|站得住腳/);
    expect(p).toMatch(/不要為了完成任務而編造/);
  });

  test('要求輸出中譯欄位', () => {
    const p = buildPrompt(base);
    expect(p).toContain('question_zh');
    expect(p).toContain('text_zh');
  });

  test('術語表命中的字會鎖死官方譯法', () => {
    const p = buildPrompt({ ...base, glossary: [
      { en: 'Delivery Orders', zh: '交貨單' },
      { en: 'Reordering Rule', zh: '重訂貨規則' },
    ] });
    expect(p).toContain('Delivery Orders → 交貨單');
    expect(p).toContain('Reordering Rule → 重訂貨規則');
  });

  test('沒給術語表時不出現空的術語區塊', () => {
    const p = buildPrompt(base);
    expect(p).not.toContain('必須照這樣翻');
  });

  // 絕不可讓任何已知答案進入審查 context
  test('prompt 不含官方答案來源的字樣', () => {
    const p = buildPrompt(base);
    expect(p).not.toContain('answer-key');
    expect(p).not.toContain('official');
  });

  // --allowed-tools Read 不限制路徑。prompt 裡若出現截圖的絕對路徑，agent 就知道
  // repo 在哪，可以自己去 Read data/exam/answer-key.json——那正是這台機器最在意的
  // 失效模式。只給相對檔名，它沒有任何線索。
  test('只給相對檔名，不洩漏 repo 的絕對路徑', () => {
    const p = buildPrompt({ ...base, imageName: 'shot.jpg' });
    expect(p).toContain('shot.jpg');
    expect(p).not.toMatch(/\/home\/|C:\\|odoo-v2|data\/exam/);
  });
});

describe('normalize', () => {
  test('裸陣列（模型一頁多題時的形狀）壓成契約格式', () => {
    const v = normalize([{ no: 1, correct_answer: ['b'] }, { no: 2 }], [['B'], ['A']]);
    expect(v.readable).toBe(true);
    expect(v.questions).toHaveLength(2);
    expect(v.questions[0].correct_answer).toEqual(['B']);   // 轉大寫
  });

  test('their_answer 缺漏時用傳入的值補回', () => {
    const v = normalize({ questions: [{ no: 1 }] }, [['C']]);
    expect(v.questions[0].their_answer).toEqual(['C']);
  });

  test('readable 為 false 時 questions 是空的', () => {
    const v = normalize({ readable: false, note: '截圖被裁掉' }, [['A']]);
    expect(v.readable).toBe(false);
    expect(v.questions).toEqual([]);
  });

  test('選項的中英文都保留', () => {
    const v = normalize({ questions: [{ no: 1, options: [
      { letter: 'A', text: 'Leave it empty', text_zh: '留空' }] }] }, [['A']]);
    expect(v.questions[0].options[0]).toMatchObject(
      { letter: 'A', text: 'Leave it empty', text_zh: '留空' });
  });

  // 回選項文字而非字母是規格 §11 記載的實測坑：它會靜靜變成一筆對不上的資料
  test('correct_answer 回文字內容時標記為形狀錯誤', () => {
    const v = normalize({ questions: [{ no: 1, correct_answer: ['No'] }] }, [['A']]);
    expect(v.questions[0].correct_answer).toEqual([]);
    expect(v.questions[0].shape_error).toMatch(/字母/);
  });
});

describe('兩階段審題 prompt', () => {
  test('第一階段只抄題並標記是否必須看圖，不要求作答', () => {
    const p = buildExtractPrompt({ imageName: 'shot.jpg' });
    expect(p).toContain('不要作答');
    expect(p).toContain('has_image');
    expect(p).not.toContain('作答者在這一頁的答案');
  });

  test('第二階段只收到未命中官方答案的題目', () => {
    const p = buildReviewQuestionsPrompt({
      questions: [{ no: 2, question: 'Q', options: [], has_image: false }],
      theirAnswers: [['B']], glossary: [],
    });
    expect(p).toContain('沒有官方確認答案');
    expect(p).toContain('"no": 2');
    expect(p).toContain('"their_answer"');
  });

  test('轉錄結果保留 has_image 且不產生答案欄位', () => {
    const page = normalizeExtract({ questions: [{ no: 1, question: 'Q', has_image: true }] });
    expect(page.questions[0]).toMatchObject({ no: 1, question: 'Q', has_image: true });
    expect(page.questions[0]).not.toHaveProperty('correct_answer');
  });
});

// 實測炸過：模型無視 prompt 寫的「0-100 整數」回了 0.95，寫進 INTEGER 欄位時
// `invalid input syntax for type integer: "0.95"` 讓整頁 4 題一起 failed，
// 而錯誤訊息完全不指向「模型格式跑掉」。
describe('normalizeConfidence', () => {
  const { normalizeConfidence } = require('../lib/exam/review');

  test('0 到 1 之間的小數當成比例換算', () => {
    expect(normalizeConfidence(0.95)).toBe(95);
    expect(normalizeConfidence(0.4)).toBe(40);
  });

  test('正常的 0-100 整數原樣保留', () => {
    expect(normalizeConfidence(92)).toBe(92);
    expect(normalizeConfidence(0)).toBe(0);
    expect(normalizeConfidence(100)).toBe(100);
  });

  // 寧可低估：低信心只會多找一次證據，高估會讓錯答案混進高信心區直接被採用
  test('剛好 1 當成 1 分，不放大成 100', () => {
    expect(normalizeConfidence(1)).toBe(1);
  });

  test('超出範圍夾回 0-100，小數四捨五入成整數', () => {
    expect(normalizeConfidence(120)).toBe(100);
    expect(normalizeConfidence(-5)).toBe(0);
    expect(normalizeConfidence(88.6)).toBe(89);
  });

  test('不是數字時回 null 而不是 0', () => {
    expect(normalizeConfidence(undefined)).toBeNull();
    expect(normalizeConfidence('高')).toBeNull();
  });

  test('normalize 走同一套，模型回小數也寫得進 INTEGER 欄位', () => {
    const v = normalize({ questions: [{ no: 1, confidence: 0.95 }] }, [['A']]);
    expect(v.questions[0].confidence).toBe(95);
  });
});

describe('checkGlossary', () => {
  test('官方譯法有出現在譯文裡就算命中', () => {
    const r = checkGlossary('請設定交貨單的重訂貨規則',
      [{ en: 'Delivery Orders', zh: '交貨單' }, { en: 'Reordering Rule', zh: '重訂貨規則' }]);
    expect(r.missed).toEqual([]);
  });

  // 沒對上不是致命錯誤，但要標出來讓人看得到
  test('官方譯法沒出現就列進 missed', () => {
    const r = checkGlossary('請設定出貨單的補貨規則',
      [{ en: 'Delivery Orders', zh: '交貨單' }]);
    expect(r.missed).toEqual([{ en: 'Delivery Orders', zh: '交貨單' }]);
  });

  test('沒有術語表時不報任何 missed', () => {
    expect(checkGlossary('任何文字', []).missed).toEqual([]);
  });
});

describe('termsIn', () => {
  const all = [
    { en: 'Sales Order', zh: '銷售訂單' },
    { en: 'Reordering Rule', zh: '重訂貨規則' },
    { en: 'Fiscal Position', zh: '財務規則' },
  ];

  // 術語表是對整頁的英文查的，譯文檢查卻是逐題做的。不先篩出「這一題用到的」，
  // Q1 會被報「沒對上 Q2、Q3 的術語」——實跑時每題吐出十幾條假的沒對上。
  test('只回這段英文真的用到的術語', () => {
    const hit = termsIn('Where do you confirm a Sales Order?', all);
    expect(hit.map(t => t.en)).toEqual(['Sales Order']);
  });

  test('大小寫不影響比對', () => {
    expect(termsIn('the sales order line', all).map(t => t.en)).toEqual(['Sales Order']);
  });

  // \b 邊界：避免 "Order" 命中 "Orders" 之外的東西，也避免子字串誤判
  test('部分字詞不算命中', () => {
    expect(termsIn('Reordering', all).map(t => t.en)).toEqual([]);
  });

  test('空輸入回空陣列', () => {
    expect(termsIn('', all)).toEqual([]);
    expect(termsIn('anything', [])).toEqual([]);
  });
});

describe('saveVerdicts', () => {
  let bankId, itemId;

  beforeAll(async () => {
    const b = await dbModule.query(
      `INSERT INTO exam_banks (label, odoo_version) VALUES ('rv', '19') RETURNING id`);
    bankId = b.rows[0].id;
    const it = await dbModule.query(
      `INSERT INTO exam_items (odoo_version, fingerprint, question_en, options, qtype)
       VALUES ('19', 'rv-fp', 'Q', '[]'::jsonb, 'single') RETURNING id`);
    itemId = it.rows[0].id;
    await dbModule.query(
      `INSERT INTO exam_attempts (item_id, bank_id, page, no) VALUES ($1, $2, '7', 1)`,
      [itemId, bankId]);
  });

  // 用 (bank_id, page, no) 對應而不是 fingerprint：模型從截圖抄的題幹與
  // questions.json 的可能有細微差異（原文件實測「少抄一個 tab 字」），
  // 靠指紋對會靜靜對不上。
  test('依頁碼題號對應到既有題目並寫入 adversary', async () => {
    const r = await saveVerdicts(dbModule, {
      bankId, page: '7', model: 'claude-opus-5',
      verdict: { readable: true, questions: [
        { no: 1, refuted: false, correct_answer: ['B'], confidence: 92, reason: '站得住腳',
          question_zh: '中譯', options: [{ letter: 'A', text: 'x', text_zh: '中' }] }] },
    });
    expect(r.saved).toBe(1);
    expect(r.unmatched).toEqual([]);

    const v = await dbModule.query(
      `SELECT kind, refuted, correct_answer, confidence, model FROM exam_verdicts WHERE item_id = $1`,
      [itemId]);
    expect(v.rows[0]).toMatchObject(
      { kind: 'adversary', refuted: false, correct_answer: ['B'], confidence: 92, model: 'claude-opus-5' });
  });

  test('順便補上中譯與選項中譯', async () => {
    const it = await dbModule.query(
      `SELECT question_zh, options FROM exam_items WHERE id = $1`, [itemId]);
    expect(it.rows[0].question_zh).toBe('中譯');
    const opts = typeof it.rows[0].options === 'string'
      ? JSON.parse(it.rows[0].options) : it.rows[0].options;
    expect(opts[0].text_zh).toBe('中');
  });

  // 對不上的題要具名回報，不可以靜靜丟掉——題數對不上時人只會看到「少了幾題」
  test('對應不到的題號具名回報且不中斷', async () => {
    const r = await saveVerdicts(dbModule, {
      bankId, page: '7', model: 'claude-opus-5',
      verdict: { readable: true, questions: [
        { no: 1, refuted: false, correct_answer: ['B'], confidence: 90 },
        { no: 99, refuted: true, correct_answer: ['C'], confidence: 70 }] },
    });
    expect(r.saved).toBe(1);
    expect(r.unmatched).toEqual(['P7-99']);
  });

  test('readable 為 false 時不寫任何 verdict', async () => {
    const before = await dbModule.query('SELECT COUNT(*)::int c FROM exam_verdicts');
    const r = await saveVerdicts(dbModule, {
      bankId, page: '7', model: 'claude-opus-5',
      verdict: { readable: false, note: '讀不到', questions: [] },
    });
    expect(r.saved).toBe(0);
    const after = await dbModule.query('SELECT COUNT(*)::int c FROM exam_verdicts');
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });
});
