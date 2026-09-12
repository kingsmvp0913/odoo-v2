// 意圖：self_correct 是 chat 健檢唯一能反映「鬼打牆」的訊號，而健檢對零樣本的處置是「照實寫」
// ——漏抓到全場 0 命中時，健檢會把「AI 兩次推翻自己」報成正常（2026-09-11 使用者回報）。
// 這支釘的是第三輪加寬補進來的兩個說法家族：「推翻」與「(我|上一輪)…查得不夠仔細／不夠嚴謹」。
// 兩者都是中文裡最直白的更正措辭，前兩輪加寬卻都沒收進去。
// 同時釘「加寬不得換來誤判」：講別人的推翻、評論別人東西不夠嚴謹，都不是自我更正。
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

const find = (w, title) => w.chat_quality.worst.find(c => c.title === title);
const win = () => buildWindowSummary(new Date(Date.now() - 86400000));

// 「推翻」的更正對象可以寫在前（我上一輪的結論要推翻）也可以寫在後（這推翻了我前面的判斷），
// 兩個方向都得抓到——只收一種等於看寫法運氣。
test('self_correct：「推翻」自己前一輪結論的說法要抓得到', async () => {
  const 句子 = [
    '我要推翻我上一輪的結論：實際跑過之後不是這個原因。',
    '這推翻了我前面的判斷，正確的走法是 _inherit。',
    '上一輪的結論被推翻了，重講一次。'
  ];
  await seedChat('推翻家族', 句子, 句子.map(() => '為什麼？'));
  expect(find(await win(), '推翻家族').self_correct).toBe(句子.length);
});

// 「查得不夠仔細／不夠嚴謹」是承認上一輪做得不到位，等於自我更正，之前一句都抓不到。
test('self_correct：承認自己上一輪查得不夠仔細／不夠嚴謹要抓得到', async () => {
  const 句子 = [
    '我上一輪查得不夠仔細，漏了 depends 那一段。',
    '我剛剛看得不夠仔細。',
    '上一輪的分析不夠嚴謹，這裡補上。',
    '我剛才的檢查不夠完整。'
  ];
  await seedChat('不夠仔細家族', 句子, 句子.map(() => '真的嗎？'));
  expect(find(await win(), '不夠仔細家族').self_correct).toBe(句子.length);
});

// 加寬的代價必須守住：這兩個家族最容易誤收的就是「在講別人的事」。全都算進去的話，
// self_correct 會變成人人有份，健檢就再也分不出哪一場該去看。
test('self_correct：講別人被推翻、評論別人不夠嚴謹，都不算自我更正', async () => {
  await seedChat('他人敘述', [
    '這個設計被實測推翻過，wiki 上有記錄。',
    '我覺得這個測試不夠嚴謹，建議補一條；你給的資料不夠完整，可以再貼一次 log 嗎？'
  ], ['第一題', '第二題']);
  expect(find(await win(), '他人敘述').self_correct).toBe(0);
});
