const { newDb } = require('pg-mem');
const { listPages, archiveBank } = require('../lib/exam/archive');

let dbModule, bankId;

// 建一頁：page 一個章節，answers 逐題作答（null＝未作答）。
// answers 逐題「最終答案」（null＝沒拍板）。worker 建 attempt 時 answer_final
// 預設等於 answer_their，所以這裡兩欄一起寫；要測「改過答案」再單獨覆蓋 final。
async function addPage(page, answers, { section = null } = {}) {
  await dbModule.query(
    `INSERT INTO exam_uploads (bank_id,page,answer_raw,image_path,status,section_title)
     VALUES ($1,$2,'x','exam-test/x.jpg','done',$3)`, [bankId, String(page), section]);
  for (const [i, ans] of answers.entries()) {
    const it = await dbModule.query(
      `INSERT INTO exam_items (odoo_version,fingerprint,question_en,options,qtype)
       VALUES ('19',$1,'Q','[]'::jsonb,'single') RETURNING id`, [`fp-${page}-${i}`]);
    await dbModule.query(
      `INSERT INTO exam_attempts (item_id,bank_id,page,no,answer_their,answer_final)
       VALUES ($1,$2,$3,$4,$5,$5)`, [it.rows[0].id, bankId, String(page), i + 1, ans]);
  }
}

const itemsOfPage = async (page) => (await dbModule.query(`
  SELECT a.no, i.certain, i.answer_official, i.official_from, i.section_title
    FROM exam_attempts a JOIN exam_items i ON i.id = a.item_id
   WHERE a.bank_id = $1 AND a.page = $2 ORDER BY a.no`, [bankId, String(page)])).rows;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const b = await dbModule.query(
    `INSERT INTO exam_banks (label, odoo_version) VALUES ('archive-test','19') RETURNING id`);
  bankId = b.rows[0].id;

  await addPage(1, [['A'], ['B'], ['C']], { section: 'Survey' });   // 上傳時就帶了章節
  await addPage(2, [['A'], null, ['C']]);                           // 有未作答，且沒帶章節
  await addPage(3, [['A'], ['B']]);                                 // 這章有答錯
});

afterAll(() => { dbModule._setPoolForTesting(null); });

describe('listPages', () => {
  test('逐頁回報題數與已作答數，章節名沿用上傳時帶的', async () => {
    const pages = await listPages(dbModule, bankId);
    expect(pages).toEqual([
      { page: '1', section: 'Survey', total: 3, answered: 3, locked: 0 },
      { page: '2', section: null, total: 3, answered: 2, locked: 0 },
      { page: '3', section: null, total: 2, answered: 2, locked: 0 },
    ]);
  });
});

describe('archiveBank', () => {
  // 這是整套歸檔的核心推論，也是唯一會把答案永久鎖成 100% 的地方。
  test('勾了「沒答錯」的章節，該章有作答的題全部鎖成官方正解', async () => {
    const stat = await archiveBank(dbModule, {
      bankId, pages: [{ page: '1', section: 'Survey', noWrong: true }] });
    expect(stat.locked).toBe(3);
    expect(stat.sections).toBe(1);

    const items = await itemsOfPage(1);
    expect(items.map(x => x.certain)).toEqual([true, true, true]);
    expect(items.map(x => x.answer_official)).toEqual([['A'], ['B'], ['C']]);
    expect(items[0].official_from).toBe('section-all-correct');
  });

  // 舊題庫的 POS：3 題答對 2、未答 1，incorrect 仍是 0 而它確實 certain。
  // 未作答的那題沒有答案可推，必須跳過——硬填等於憑空捏造正解。
  // 11 個 incorrect=0 的章節 49 題扣掉 2 題未作答 = 47，這條就是那個 2 的來源。
  test('章節沒答錯但有未作答時，未作答的題跳過並具名回報', async () => {
    const stat = await archiveBank(dbModule, {
      bankId, pages: [{ page: '2', section: 'POS', noWrong: true }] });
    expect(stat.locked).toBe(2);
    expect(stat.skipped).toEqual(['P2-2 沒有最終答案，無法推導正解']);

    const items = await itemsOfPage(2);
    expect(items.map(x => x.certain)).toEqual([true, false, true]);
    expect(items[1].answer_official).toBeNull();
  });

  test('未作答的題不算進 correct，記進 unanswered', async () => {
    const s = await dbModule.query(
      `SELECT n, correct, incorrect, unanswered FROM exam_sections WHERE bank_id=$1 AND title='POS'`,
      [bankId]);
    expect(s.rows[0]).toMatchObject({ n: 3, correct: 2, incorrect: 0, unanswered: 0 + 1 });
  });

  // 沒勾的章節我們不知道它錯幾題，寫個猜的數字比不寫更糟——校準會拿它當硬事實。
  test('沒勾「沒答錯」時只寫章節名，不推導也不寫章節結果', async () => {
    const stat = await archiveBank(dbModule, {
      bankId, pages: [{ page: '3', section: 'Accounting', noWrong: false }] });
    expect(stat.locked).toBe(0);
    expect(stat.sections).toBe(0);

    const items = await itemsOfPage(3);
    expect(items.map(x => x.certain)).toEqual([false, false]);
    expect(items.map(x => x.section_title)).toEqual(['Accounting', 'Accounting']);
    const s = await dbModule.query(
      `SELECT COUNT(*)::int c FROM exam_sections WHERE bank_id=$1 AND title='Accounting'`, [bankId]);
    expect(s.rows[0].c).toBe(0);
  });

  // 勾了卻沒有章節名 → 寫不出 exam_sections，而且分組會塌成「(無章節)」。
  // 擋下來並說原因，不要半套寫進去。
  test('勾了「沒答錯」但沒填章節名時整頁略過', async () => {
    const stat = await archiveBank(dbModule, { bankId, pages: [{ page: '3', noWrong: true }] });
    expect(stat.locked).toBe(0);
    expect(stat.skipped).toEqual(['P3 填了錯題數但沒有章節名，略過']);
    expect((await itemsOfPage(3)).map(x => x.certain)).toEqual([false, false]);
  });

  // 「答錯的經驗」唯一的落地點。舊版對有錯的章節整段 `continue`，什麼都不寫，
  // 於是 exam_sections.incorrect 在網頁流程下恆為 0，校準永遠拿不到非零輸入。
  test('章節有答錯時不鎖任何題，但把錯題數寫進 exam_sections', async () => {
    await addPage(11, [['A'], ['B'], ['C']], { section: 'Project' });
    const stat = await archiveBank(dbModule, {
      bankId, pages: [{ page: '11', section: 'Project', wrong: 2 }] });

    expect(stat.locked).toBe(0);                       // 不知道錯哪兩題，一題都不能鎖
    expect((await itemsOfPage(11)).map(x => x.certain)).toEqual([false, false, false]);
    const s = (await dbModule.query(
      `SELECT n, correct, incorrect, unanswered FROM exam_sections
        WHERE bank_id=$1 AND title='Project'`, [bankId])).rows[0];
    expect(s).toMatchObject({ n: 3, correct: 1, incorrect: 2, unanswered: 0 });
  });

  // 錯題數比有作答的題還多＝看錯成績圖或勾錯章節。寫進去會讓 scale 把整章壓爛。
  test('錯題數超過作答數時不寫入並具名回報', async () => {
    await addPage(12, [['A'], null], { section: 'Studio' });
    const stat = await archiveBank(dbModule, {
      bankId, pages: [{ page: '12', section: 'Studio', wrong: 2 }] });
    expect(stat.sections).toBe(0);
    expect(stat.skipped).toContain('P12 官方說錯 2 題，但這章只有 1 題有作答，未寫入');
  });

  // 留白＝「我還不知道這章的結果」，與「這章 0 題錯」是兩件事，不可混為一談
  test('錯題數留白時只寫章節名，不鎖也不寫章節結果', async () => {
    await addPage(13, [['A']], { section: 'Knowledge' });
    const stat = await archiveBank(dbModule, {
      bankId, pages: [{ page: '13', section: 'Knowledge', wrong: null }] });
    expect(stat.locked).toBe(0);
    expect(stat.sections).toBe(0);
    expect((await itemsOfPage(13)).map(x => x.section_title)).toEqual(['Knowledge']);
  });

  // 同一題在不同場考試被推出不同答案＝有一場勾錯了。靜靜覆蓋會讓錯的那次贏，
  // 而且完全沒有痕跡。
  test('既有官方答案與本次作答不符時保留既有並回報衝突', async () => {
    await addPage(9, [['A']], { section: 'Sales' });
    await archiveBank(dbModule, { bankId, pages: [{ page: '9', section: 'Sales', noWrong: true }] });
    await dbModule.query(
      `UPDATE exam_attempts SET answer_final = $2 WHERE bank_id = $1 AND page = '9'`,
      [bankId, ['D']]);

    const stat = await archiveBank(dbModule, {
      bankId, pages: [{ page: '9', section: 'Sales', noWrong: true }] });
    // 用 toContain 不用 toEqual：推導（deduce.js）看到同一份資料也會回報矛盾
    // ——官方答案是 A、你填 D，卻又說這章 0 題錯，兩件事不可能同時成立。
    // 那是它該講的話，不是雜訊。
    expect(stat.conflicts).toContain('P9-1 既有官方答案 A 與本次最終答案 D 不符，保留既有');
    const items = await itemsOfPage(9);
    expect(items[0].answer_official).toEqual(['A']);
  });

  // 官方評分評的是真正提交上去的答案＝作戰台上拍板的最終答案，不是同事一開始輸入的。
  // 搞反的話：AI 說你答錯、你改成 B、官方說這章沒錯 → 卻把改之前的 A 永久鎖成正解，
  // 而且 certain 取 OR 蓋不掉。這是整支歸檔最貴的錯誤。
  test('作戰台改過答案的題，鎖的是改之後的最終答案', async () => {
    await addPage(20, [['A']], { section: 'Changed' });
    await dbModule.query(
      `UPDATE exam_attempts SET answer_final = $2 WHERE bank_id = $1 AND page = '20'`,
      [bankId, ['D']]);

    const stat = await archiveBank(dbModule, {
      bankId, pages: [{ page: '20', section: 'Changed', noWrong: true }] });
    expect(stat.locked).toBe(1);
    const items = await itemsOfPage(20);
    expect(items[0].answer_official).toEqual(['D']);   // 不是輸入的 A
  });

  // 官方正解已知之後那個人工提醒就沒意義了，留著會讓考試當下同時看到官方鎖定
  // 與紅叉警告。但只能清這一題——全表更新會掃掉別題人工標的，救不回來。
  test('被鎖成官方的題清掉大概率錯標記，其他題的標記不動', async () => {
    await addPage(21, [['A']], { section: 'Cleared' });
    const mine = (await itemsOfPage(21))[0];
    const other = await dbModule.query(
      `INSERT INTO exam_items (odoo_version,fingerprint,question_en,options,qtype,history_wrong)
       VALUES ('19','keep-my-mark','X','[]'::jsonb,'single',true) RETURNING id`);
    await dbModule.query(
      `UPDATE exam_items SET history_wrong = true WHERE id IN
        (SELECT item_id FROM exam_attempts WHERE bank_id = $1 AND page = '21')`, [bankId]);

    await archiveBank(dbModule, {
      bankId, pages: [{ page: '21', section: 'Cleared', noWrong: true }] });

    const after = await dbModule.query(`
      SELECT i.history_wrong FROM exam_attempts a JOIN exam_items i ON i.id = a.item_id
       WHERE a.bank_id = $1 AND a.page = '21'`, [bankId]);
    expect(after.rows[0].history_wrong).toBe(false);

    const untouched = await dbModule.query(
      `SELECT history_wrong FROM exam_items WHERE id = $1`, [other.rows[0].id]);
    expect(untouched.rows[0].history_wrong).toBe(true);
  });

  test('歸檔後題庫狀態轉 ready', async () => {
    const b = await dbModule.query(`SELECT status FROM exam_banks WHERE id = $1`, [bankId]);
    expect(b.rows[0].status).toBe('ready');
  });
});

// 使用者情境（2026-09-05）：第一次考 A 區沒全對，第二次 A 區全對。
// 第二次歸檔時，第一次考過的同一題也要跟著變成「已確認」。
describe('第二次考全對，第一次的同一題也要一起確認', () => {
  let firstBank, secondBank, sharedItem, onlyInFirst;

  beforeAll(async () => {
    const a = await dbModule.query(
      `INSERT INTO exam_banks (label, odoo_version) VALUES ('第一次','22') RETURNING id`);
    firstBank = a.rows[0].id;
    const b = await dbModule.query(
      `INSERT INTO exam_banks (label, odoo_version) VALUES ('第二次','22') RETURNING id`);
    secondBank = b.rows[0].id;

    // 兩次都考到的題：第一次答 C（那次該區有錯所以沒鎖），第二次答 B
    const shared = await dbModule.query(
      `INSERT INTO exam_items (odoo_version,fingerprint,question_en,options,qtype,section_title)
       VALUES ('22','shared-q','Shared','[]'::jsonb,'single','A區') RETURNING id`);
    sharedItem = shared.rows[0].id;
    await dbModule.query(
      `INSERT INTO exam_attempts (item_id,bank_id,page,no,answer_their,answer_final)
       VALUES ($1,$2,'1',1,$3,$3)`, [sharedItem, firstBank, ['C']]);
    await dbModule.query(
      `INSERT INTO exam_attempts (item_id,bank_id,page,no,answer_their,answer_final)
       VALUES ($1,$2,'1',1,$3,$3)`, [sharedItem, secondBank, ['B']]);

    // 只有第一次考到的題：第二次沒出現，所以拿不到任何官方資訊
    const only = await dbModule.query(
      `INSERT INTO exam_items (odoo_version,fingerprint,question_en,options,qtype,section_title)
       VALUES ('22','only-first','OnlyFirst','[]'::jsonb,'single','A區') RETURNING id`);
    onlyInFirst = only.rows[0].id;
    await dbModule.query(
      `INSERT INTO exam_attempts (item_id,bank_id,page,no,answer_their,answer_final)
       VALUES ($1,$2,'1',2,$3,$3)`, [onlyInFirst, firstBank, ['A']]);
  });

  test('第二次歸檔後，第一次考過的同一題也變成官方確認', async () => {
    await archiveBank(dbModule, {
      bankId: secondBank, pages: [{ page: '1', section: 'A區', noWrong: true }] });

    const it = (await dbModule.query(
      `SELECT certain, answer_official, confidence FROM exam_items WHERE id = $1`,
      [sharedItem])).rows[0];
    expect(it.certain).toBe(true);
    expect(it.answer_official).toEqual(['B']);   // 用第二次的答案，不是第一次答錯的 C
    expect(it.confidence).toBe(100);
  });

  // 第二次沒考到的題拿不到任何官方資訊，不可以跟著被鎖——那等於憑空捏造正解
  test('只有第一次考到、第二次沒出現的題不受影響', async () => {
    const it = (await dbModule.query(
      `SELECT certain, answer_official FROM exam_items WHERE id = $1`, [onlyInFirst])).rows[0];
    expect(it.certain).toBe(false);
    expect(it.answer_official).toBeNull();
  });
});

// 題目是跨考次共用的（綁 odoo_version），章節結果卻綁在 bank 上。兩者範圍不一致時，
// 「只撈這一場的章節結果」會讓舊考次的章節全部查無官方結果而失去校準。
//
// 實測踩過：POST 進一份新題庫後，整個版本 120 題 calibrated 全變 false、
// 風險總和從 15.03 跳回 17.46——沒有錯誤訊息，信心度就這樣悄悄變了。
// 走真的 DB 驗一次跨考次推導：純函式的測試在 exam-deduce.test.js，這裡驗的是
// 「歸檔之後真的會寫進 exam_items」——SQL 對不上的話純函式再對也沒用。
describe('跨考次推導：第一場錯的是哪一題', () => {
  let b1, b2, ids;
  beforeAll(async () => {
    const mk = async (label) => (await dbModule.query(
      `INSERT INTO exam_banks (label, odoo_version) VALUES ($1,'33') RETURNING id`, [label])).rows[0].id;
    b1 = await mk('推導-第一場'); b2 = await mk('推導-第二場');
    ids = [];
    for (const i of [1, 2, 3, 4]) {
      ids.push((await dbModule.query(`
        INSERT INTO exam_items (odoo_version,fingerprint,question_en,options,qtype,section_title)
        VALUES ('33',$1,'Q','[]'::jsonb,'single','Deduce') RETURNING id`, [`ded-${i}`])).rows[0].id);
    }
    const att = async (bank, itemId, no, ans) => dbModule.query(`
      INSERT INTO exam_attempts (item_id,bank_id,page,no,answer_their,answer_final)
      VALUES ($1,$2,'1',$3,$4,$4)`, [itemId, bank, no, ans]);
    // 第一場：q1=A q2=B q3=C，官方說錯 1 題（不知道是哪題）
    await att(b1, ids[0], 1, ['A']); await att(b1, ids[1], 2, ['B']); await att(b1, ids[2], 3, ['C']);
    // 第二場：q1=A q2=B q4=D，官方說 0 題錯
    await att(b2, ids[0], 1, ['A']); await att(b2, ids[1], 2, ['B']); await att(b2, ids[3], 3, ['D']);
  });

  test('第二場全對之後，回頭推出第一場錯的是第三題', async () => {
    await archiveBank(dbModule, { bankId: b1, pages: [{ page: '1', section: 'Deduce', wrong: 1 }] });
    // 這時還推不出來：三題裡有一題錯，但沒有別的線索
    let q3 = (await dbModule.query(
      `SELECT certain, wrong_answers FROM exam_items WHERE id=$1`, [ids[2]])).rows[0];
    expect(q3.wrong_answers).toEqual([]);

    const stat = await archiveBank(dbModule, { bankId: b2, pages: [{ page: '1', section: 'Deduce', wrong: 0 }] });
    expect(stat.conflicts).toEqual([]);

    // q1／q2／q4 由「這章 0 題錯」直接鎖定
    for (const i of [0, 1, 3]) {
      const r = (await dbModule.query(`SELECT certain FROM exam_items WHERE id=$1`, [ids[i]])).rows[0];
      expect(r.certain).toBe(true);
    }
    // q3 從來沒出現在全對的章節裡，但被消去法證明答錯了
    q3 = (await dbModule.query(
      `SELECT certain, wrong_answers FROM exam_items WHERE id=$1`, [ids[2]])).rows[0];
    expect(q3.wrong_answers).toEqual([['C']]);
    expect(q3.certain).toBe(false);          // 知道 C 是錯的，不代表知道正解是什麼
    expect(stat.deduced.marked).toBeGreaterThan(0);
  });
});

describe('校準跨考次撈章節結果', () => {
  const { recomputeConfidence } = require('../lib/exam/worker');
  let oldBank, newBank;

  beforeAll(async () => {
    const a = await dbModule.query(
      `INSERT INTO exam_banks (label, odoo_version) VALUES ('舊考次','21') RETURNING id`);
    oldBank = a.rows[0].id;
    const b = await dbModule.query(
      `INSERT INTO exam_banks (label, odoo_version) VALUES ('新考次','21') RETURNING id`);
    newBank = b.rows[0].id;

    // 舊考次：一個有官方結果的章節，兩題都被審查過且沒被推翻
    await dbModule.query(`
      INSERT INTO exam_sections (bank_id,title,n,correct,incorrect,unanswered,partial)
      VALUES ($1,'Legacy',2,1,1,0,0)`, [oldBank]);
    for (const i of [1, 2]) {
      const it = await dbModule.query(
        `INSERT INTO exam_items (odoo_version,fingerprint,question_en,options,qtype,section_title)
         VALUES ('21',$1,'Q','[]'::jsonb,'single','Legacy') RETURNING id`, [`legacy-${i}`]);
      const at = await dbModule.query(
        `INSERT INTO exam_attempts (item_id,bank_id,page,no,answer_their,answer_final)
         VALUES ($1,$2,'1',$3,$4,$4) RETURNING id`, [it.rows[0].id, oldBank, i, ['A']]);
      await dbModule.query(`
        INSERT INTO exam_verdicts (item_id,attempt_id,kind,refuted,correct_answer,confidence,model)
        VALUES ($1,$2,'adversary',false,$3,80,'m')`, [it.rows[0].id, at.rows[0].id, ['A']]);
    }
  });

  // 這是「越考越假」那個洩漏。舊寫法按章節名跨 bank 共用 incorrect，於是舊考次
  // 某章全對（incorrect=0）會讓新考次同名章節的**新題目** scale = 0/rawRisk = 0，
  // 風險歸零被寫成 confidence=100 且 calibrated=true——那些題從沒有人確認過，
  // 但題庫頁對 confidence===100 畫鎖頭、算進「官方確定 N」，人眼分不出來。
  test('舊考次某章全對，不得把新考次同名章節的新題目拉成 100', async () => {
    // 舊考次的 Purchase 官方說 0 題錯
    await dbModule.query(`
      INSERT INTO exam_sections (bank_id,title,n,correct,incorrect,unanswered,partial)
      VALUES ($1,'Purchase',1,1,0,0,0)`, [oldBank]);
    // 新考次冒出一題同章節的新題，審查過沒被推翻、無證據 ⇒ base 80，且尚未歸檔
    const it = await dbModule.query(`
      INSERT INTO exam_items (odoo_version,fingerprint,question_en,options,qtype,section_title)
      VALUES ('21','fresh-purchase','Q','[]'::jsonb,'single','Purchase') RETURNING id`);
    const at = await dbModule.query(`
      INSERT INTO exam_attempts (item_id,bank_id,page,no,answer_their,answer_final)
      VALUES ($1,$2,'9',1,$3,$3) RETURNING id`, [it.rows[0].id, newBank, ['A']]);
    await dbModule.query(`
      INSERT INTO exam_verdicts (item_id,attempt_id,kind,refuted,correct_answer,confidence,model)
      VALUES ($1,$2,'adversary',false,$3,80,'m')`, [it.rows[0].id, at.rows[0].id, ['A']]);

    const bank = (await dbModule.query(
      `SELECT id, label, odoo_version FROM exam_banks WHERE id = $1`, [newBank])).rows[0];
    await recomputeConfidence(dbModule, bank);

    const row = (await dbModule.query(
      `SELECT confidence, calibrated, certain FROM exam_items WHERE fingerprint='fresh-purchase'`)).rows[0];
    expect(row.confidence).toBe(80);      // 舊寫法是 100
    expect(row.calibrated).toBe(false);   // 舊寫法是 true
    expect(row.certain).toBe(false);      // 兩邊都是 false——所以 lookup 沒被污染，只有畫面會騙人
  });

  test('對新考次重算時，舊考次的章節仍然校準得到', async () => {
    const bank = (await dbModule.query(
      `SELECT id, label, odoo_version FROM exam_banks WHERE id = $1`, [newBank])).rows[0];
    const { notes } = await recomputeConfidence(dbModule, bank);

    expect(notes.join('|')).not.toMatch(/Legacy.*沒有官方章節結果/);
    const rows = await dbModule.query(
      `SELECT calibrated FROM exam_items WHERE odoo_version='21' AND section_title='Legacy'`);
    expect(rows.rows.map(r => r.calibrated)).toEqual([true, true]);
  });
});
