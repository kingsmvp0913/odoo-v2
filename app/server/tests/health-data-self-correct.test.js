// 意圖：chat 健檢的 self_correct 是「鬼打牆」唯一留得下痕跡的訊號，而 worst 排序的第一鍵就是它
// ——漏抓一次，那場對話就少一分；全漏抓，一場連續四輪自我更正的鬼打牆會被記成 0 次、排不進
// worst 前三名，健檢對這條通道報平安（2026-09-07 使用者回報）。
// 舊實作有兩個獨立的漏抓來源：(1) 樣式只涵蓋少數主謂句型；(2) 比對前先 slice(0,120)，
// 寫在解釋之後的更正句一律掃不到。這支把兩者各釘一條，外加「放寬不得換來誤判」與排序後果。
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

// aiTexts／userTexts 是各輪的完整內容（不是長度）——這支釘的是「內容比對」，長度由 health-data.test.js 管。
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

const find = (w, title) => w.chat_quality.worst.find(c => c.title === title);
const win = () => buildWindowSummary(new Date(Date.now() - 86400000));

// 使用者回報裡逐字列出的口語更正句。這些在實際對話中比「我判斷錯」常見得多，
// 舊樣式一句都抓不到——這條漏掉，self_correct 就只反映 AI 的正式措辭，不反映真實的繞圈。
test('self_correct：口語的自我更正說法要抓得到，不能只認少數主謂句型', async () => {
  const 口語 = [
    '我剛剛的答案講錯了，正確的是 sale.order。',
    '我剛才確實只看了 PURTA，沒看另一張。',
    '不完全是，加上我剛剛的清單漏查了一件事。',
    '沒有，之前都沒排除這種情況。',
    '你抓到重點了，這裡確實有問題。',
    '你這個顧慮是對的。',
    '先更正一個關鍵認知：這個欄位不是 store 的。'
  ];
  await seedChat('口語更正', 口語, 口語.map(() => '為什麼？'));
  const hit = find(await win(), '口語更正');
  // 每一句都必須各記一次；少一次就代表某個句型還在漏
  expect(hit.self_correct).toBe(口語.length);
});

// 第二個獨立的漏抓來源：更正句常寫在一段解釋之後。舊實作只掃前 120 字，這種一律算 0。
test('self_correct：更正句寫在長篇解釋之後也要算到，不得只掃開頭', async () => {
  const 前言 = '這個模組的相依關係我先說明一下，'.repeat(12);   // 遠超過舊的 120 字上限
  expect(前言.length).toBeGreaterThan(120);
  await seedChat('中段更正', [
    前言 + '結論是走 _inherit。',
    前言 + '不過我剛剛講錯了，其實要改的是 view。'
  ], ['第一題', '第二題']);
  const hit = find(await win(), '中段更正');
  expect(hit.self_correct).toBe(1);
});

// 放寬涵蓋面不得換來誤判：舊實作靠「只掃開頭」擋掉長文中段的正常引述，取消截斷後，
// 改由樣式自己帶足語境（主詞＋更正動詞）來擋。這條掉了，self_correct 會被技術長文洗成人人有份。
test('self_correct：長文中段的正常引述與技術用語不算自我更正', async () => {
  const 前言 = '這個模組的相依關係我先說明一下，'.repeat(12);
  await seedChat('正常引述', [
    前言 + '我上一輪說的那個檔案在 app/server/db.js，可以直接看。',
    前言 + '這支測試會抓錯誤訊息裡的關鍵字，欄位不能填錯。'
  ], ['第一題', '第二題']);
  const hit = find(await win(), '正常引述');
  expect(hit.self_correct).toBe(0);
});

// 兩個漏抓疊加的真正後果：worst 第一鍵是 self_correct，次鍵才是 ratio。全部漏抓時
// 鬼打牆那場的第一鍵是 0，只能跟話多的對話比 ratio，於是被擠出前三名——健檢報平安。
test('worst：連續自我更正的對話要排在只是話多的對話前面', async () => {
  await seedChat('連續鬼打牆', [
    '你說的對，我剛剛的判斷講錯了。',
    '不完全是，我剛才漏查了 depends。',
    '先更正一下：這個欄位不是 store 的。',
    '你這個顧慮是對的，我前面的結論要收回。'
  ], ['一', '二', '三', '四']);
  // 三場只是話多、完全沒有自我更正的對話——ratio 遠高於上面那場，足以在只比 ratio 時佔滿前三名
  for (const t of ['話多1', '話多2', '話多3']) {
    await seedChat(t, ['說明'.repeat(200), '說明'.repeat(200)], ['問', '問']);
  }
  const w = await win();
  expect(find(w, '連續鬼打牆').self_correct).toBe(4);        // 四輪一輪不漏，否則第一鍵就贏不了
  // 話多但沒繞圈的那三場 ratio 遠高於它，卻一場都不該擠進來——self_correct 是第一鍵
  expect(w.chat_quality.worst.every(c => c.self_correct > 0)).toBe(true);
  expect(w.chat_quality.worst.some(c => c.title.startsWith('話多'))).toBe(false);
});
