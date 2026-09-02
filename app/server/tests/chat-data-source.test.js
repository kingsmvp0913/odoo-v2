const fs = require('fs');
const path = require('path');

// 使用者在開新對話時可以指定「優先查測試區還是正式區」。這條路徑跨了四個檔
// （前端送出 → 建立對話的端點 → chat-agent 組 prompt → chat.md 的 placeholder），
// 任何一段對不上都是靜默失效：對話照跑、AI 照答，只是那個選擇從來沒被讀到。
const routes = fs.readFileSync(path.join(__dirname, '../chat-routes.js'), 'utf8');
const agent = fs.readFileSync(path.join(__dirname, '../pipeline/chat-agent.js'), 'utf8');
const promptMd = fs.readFileSync(path.join(__dirname, '../../../.claude/agents/chat.md'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '../../public/js/ui-next/UiNextApp.js'), 'utf8');

// 這個值會被組進 prompt。照收任意字串等於讓呼叫端替我們寫 prompt。
test('建立對話只收 test_env 與 db:<id>，其餘一律當成沒選', () => {
  expect(routes).toMatch(/let dataSource = null;/);
  expect(routes).toMatch(/raw === 'test_env'/);
  expect(routes).toMatch(/\^db:\\d\+\$/);
});

// 連線 id 是全域遞增的，不驗歸屬的話等於可以拿別的專案的庫名去問——而那個名字會被寫進 prompt。
test('db:<id> 必須確認該連線屬於這個專案', () => {
  expect(routes).toMatch(/SELECT id FROM db_connections WHERE id = \$1 AND project_id = \$2/);
});

test('chat.md 有 data_source_hint 這個 placeholder，且 chat-agent 有傳', () => {
  expect(promptMd).toContain('{{data_source_hint}}');
  expect(agent).toMatch(/data_source_hint:/);
});

// 意圖：使用者裁決是「沒選就自行決定，有選才加提示」——提示措辭必須留得住退路，
// 寫成「只准查 X」會讓「測試區壞了想比對正式區」這種問題直接卡死。
test('提示是軟性的：兩條路徑都保留「仍可查其他來源」', () => {
  const hints = agent.match(/dataSourceHintFor = async[\s\S]*?\n  \};/)[0];
  expect(hints.match(/仍可查其他來源/g) || []).toHaveLength(2);
});

// 一個專案可以掛好幾個庫（實測鴻久有六個）。提示只說「正式區」它不知道是哪一個。
test('選了某個連線時，提示要帶出那個連線的名稱', () => {
  const hints = agent.match(/dataSourceHintFor = async[\s\S]*?\n  \};/)[0];
  expect(hints).toMatch(/SELECT name, db_name FROM db_connections/);
  expect(hints).toMatch(/優先查連線/);
});

test('前端把選擇帶進「建立對話」而不是每則訊息（整場沿用）', () => {
  expect(client).toMatch(/chats`, \{ title: chatTitle\(this\.prompt\), data_source:/);
});
