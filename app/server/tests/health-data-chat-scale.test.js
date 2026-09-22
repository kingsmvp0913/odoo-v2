// 意圖：chat_quality 是目前唯一在量「chat 答得好不好」的通道，量尺方向錯會讓健檢持續看錯場次。
// 舊量尺 verbosity_ratio 的分母是**使用者提問長度**，量到的是使用者囉不囉嗦：本平台使用者多為
// 熟手、提問只有十幾字，分母一小比值就衝高，「問得精簡」被記成「AI 太囉嗦」（2026-09-21 回報）。
// 這支釘住三件事：(1) 現行量尺 ai_chars 不隨提問長度動；(2) worst 的次鍵是 ai_chars 不是比值；
// (3) 「誠實標示推論限度」不算品質缺陷。外加 (4) 換量尺必須連帶告知消費端（健檢 AI 的提示詞
// 不在本次可動範圍，唯一的告知管道就是資料裡的 scale_note）——沒有它，新數字會被拿去比舊基線。
const { newDb } = require('pg-mem');
let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});
afterAll(() => dbModule._setPoolForTesting(null));

const { buildWindowSummary } = require('../pipeline/health-data');

async function seedChat(title, aiTexts, userTexts) {
  const { rows: [p] } = await dbModule.query(
    `INSERT INTO projects (name, odoo_version) VALUES ($1,'17.0') RETURNING id`, ['P-' + title]);
  const { rows: [c] } = await dbModule.query(
    `INSERT INTO project_chats (project_id, title) VALUES ($1,$2) RETURNING id`, [p.id, title]);
  for (let i = 0; i < Math.max(aiTexts.length, userTexts.length); i++) {
    if (userTexts[i] != null) {
      await dbModule.query(
        `INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1,'user',$2)`, [c.id, userTexts[i]]);
    }
    if (aiTexts[i] != null) {
      await dbModule.query(
        `INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1,'ai',$2)`, [c.id, aiTexts[i]]);
    }
  }
  return c.id;
}

const win = () => buildWindowSummary(new Date(Date.now() - 86400000));
const find = (w, title) => w.chat_quality.worst.find(c => c.title === title);
// 純長度用的無害內容：絕不可命中 self_correct，否則量到的是別條訊號
const 字 = (n) => 'a'.repeat(n);

// 兩場 AI 回覆一模一樣長、只有使用者提問長度不同。AI 的表現完全相同，量尺就不該變——
// 舊的比值差了 60 倍，這正是「使用者問得精簡＝AI 被判囉嗦」的成因。
test('ai_chars：同樣的 AI 回覆，使用者問長問短都量到同一個數字', async () => {
  await seedChat('提問極短', [字(1200), 字(1200)], [字(10), 字(10)]);
  await seedChat('提問很長', [字(1200), 字(1200)], [字(600), 字(600)]);
  const w = await win();
  expect(find(w, '提問極短').ai_chars).toBe(1200);
  expect(find(w, '提問很長').ai_chars).toBe(1200);      // 分母換掉也不動，這才是 AI 自己的量尺
  expect(w.chat_quality.ai_chars_p50).toBe(1200);
  // 對照組：舊比值在這兩場差 60 倍，差的全是使用者那一邊
  expect(find(w, '提問極短').ratio).toBeGreaterThan(find(w, '提問很長').ratio * 10);
});

// worst 是「該去看哪一場」的清單。次鍵用比值時，排第一的會是「提問最精簡的使用者」，
// 而不是「回覆最長的 AI」——回覆長三倍的那場反而被擠下去。
test('worst：自我更正數相同時，排前面的是 AI 回覆真的長的那場，不是提問短的那場', async () => {
  await seedChat('回覆真的長', [字(3000), 字(3000)], [字(1500), 字(1500)]);   // 比值 2、字數 3000
  const w = await win();
  const 名次 = w.chat_quality.worst.map(c => c.title);
  expect(名次[0]).toBe('回覆真的長');                       // 比值只有 2，用舊次鍵會排在最後
  expect(名次.indexOf('回覆真的長')).toBeLessThan(名次.indexOf('提問極短'));
  expect(w.chat_quality.ai_chars_max).toBe(3000);
});

// chat 142 的兩次命中都是這種句子：AI 替結論加但書、或部分否定使用者的前提。這是好行為，
// 記成缺陷會把一場答得好的對話推上 worst 第一名，健檢就去看錯場次。
test('self_correct：誠實標示推論限度（「不完全是」）不算品質缺陷', async () => {
  await seedChat('標示推論限度', [
    '不完全是，這要看你用的 Odoo 版本；17.0 之後行為不同。',
    '不完全正確——以上是就程式碼推斷的結論，沒有實機驗證過。'
  ], ['是這樣嗎？', '確定嗎？']);
  const w = await win();
  // 看全窗計數而非 worst：這場字數短、排不進 worst 前三名，用 worst 檢查會變成永遠會過的空斷言。
  // 到這一步為止其餘幾場都沒有任何更正措辭，所以這兩個數字只要不是 0，就是這兩句被算進去了。
  expect(w.chat_quality.self_correct_turns).toBe(0);
  expect(w.chat_quality.self_correcting_chats).toBe(0);
});

// 但真的承認自己前面弄錯，仍然要記到——放寬誤判不得換來漏抓整個訊號。
test('self_correct：真的更正自己仍然要記到，包含同一則裡先寫「不完全是」的', async () => {
  await seedChat('真的更正', [
    '不完全是，我剛才漏查了 depends 那一段。',
    '我上一輪講錯了，正確的是 sale.order。'
  ], ['為什麼？', '真的嗎？']);
  expect(find(await win(), '真的更正').self_correct).toBe(2);
});

// 量尺換掉卻沒告知消費端，比不換更糟：健檢 AI 的提示詞裡還寫著舊基線（p50 15.1／max 44.4、
// self_correct 34 場中 10 場），它會拿定義已變的新數字去比，把「定義變嚴」讀成「品質改善」。
test('scale_note：資料本身要講明舊量尺已廢、新數字不可比舊基線', async () => {
  const note = (await win()).chat_quality.scale_note;
  expect(note).toMatch(/verbosity_ratio/);      // 指名被廢掉的那個，否則消費端不知道要停用哪個
  expect(note).toMatch(/ai_chars/);             // 指名改看哪個，否則新欄位等於不存在
  expect(note).toMatch(/self_correct/);
  expect(note).toMatch(/基線/);
});
