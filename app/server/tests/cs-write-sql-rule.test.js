// 意圖：chat／cs 被要求「寫一段 UPDATE／DELETE 我自己去正式區跑」時，交出去的語句等同直接改客戶
// 正式資料。實測兩場對話（chat 42／112）因為沒先查證就給語句，客戶正式區資料被誤改——而同一支
// agent 在別的輪次會自發先查（chat 3／55／71），差別在規範缺口不是能力。本檔把那條硬規則釘在
// 共用片段上：規則被刪或被稀釋掉關鍵步驟時，這裡要紅，而不是等下一次客戶資料被改壞才發現。
const { loadAgent } = require('../pipeline/agent-loader');

const renderChat = () => loadAgent('chat').render({
  project_name: '鴻久', project_slug: 'odoo17_hungjou', repo_paths: '- /repos/hj/idx_sale',
  odoo_core_src: '（略）', history: '', user_message: '幫我寫一段 UPDATE 把確認欄位清掉'
});
const renderCs = () => loadAgent('cs').render({
  title: 'T', original_text: 'x', answers: '（尚無）',
  project_name: '鴻久', project_slug: 'odoo17_hungjou', repo_paths: '- /repos/hj/idx_sale',
  odoo_core_src: '（略）'
});

describe('產出寫入型 SQL 給人執行的硬規則', () => {
  // 「改一處兩關同時生效」是 cs-capability 的設計；只有一邊拿得到＝另一邊靜默照舊自由發揮。
  test.each([['chat', renderChat], ['cs', renderCs]])('%s 拿得到規則本體', (_name, render) => {
    const out = render();
    expect(out).toContain('【寫入型 SQL');
    expect(out).toMatch(/UPDATE／DELETE/);
  });

  // 三個步驟各自對應一個真實失誤：欄位猜錯（chat 112 一查就找到 is_cus_confirm）、
  // 沒給對照用的 SELECT 讓人無從核對、沒講這是正式區所以對方直接貼上去跑。
  test.each([
    ['先查證再給語句', /先 SELECT 查證/],
    ['先附驗證 SELECT 再附寫入語句', /先附驗證用的 `SELECT`/],
    ['要標明正式區並核對筆數', /正式區資料/],
    ['要確認欄位無 ORM 副作用', /compute／inverse/],
  ], )('規則涵蓋：%s', (_label, re) => {
    expect(renderChat()).toMatch(re);
  });

  // 續接輪走 --resume，不重送 cs-capability；但寫入型 SQL 的要求多半發生在後面幾輪，
  // 所以 body 要有一句指回（摘要指回，不是整段複製——見 agentPrompt skill）。
  test('chat-retry 的 body 有指回這條硬規則', () => {
    const out = loadAgent('chat-retry').render({ user_message: '那就照你說的直接下 UPDATE' });
    expect(out).toContain('寫入型 SQL');
    expect(out).toMatch(/先用 SELECT 查證/);
  });
});
