const { newDb } = require('pg-mem');
const { buildPrompt, normalize, saveVerdicts, checkGlossary } = require('../lib/exam/review');

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
