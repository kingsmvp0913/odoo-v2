// 側欄收件匣 badge 的數字來源必須是後端的 COUNT 端點，不能由「取回的清單」推算。
// 兩種「用清單算」的寫法都已經實際壞過，而且壞得沒有訊號（數字看起來就只是不太對）：
//   1) app.js 用 `(await Api.get('inbox')).length`，但清單有 LIMIT 100 → 未讀破百後靜默封頂，
//      socket 的樂觀 +1 又把它推過 100，數字在 100 與 100+n 之間來回跳。
//   2) Inbox.js 的 syncBadge 從本頁 items 數未讀，但 showAll=true 時 items 是「最近 100 筆」
//      （含已讀）→ 按一下「顯示全部」切換鈕，badge 就變成另一個數字。
// 前端無 Vue mount 測試基礎設施，故以來源掃描擋在 commit 前。
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8');

describe('收件匣未讀 badge 只認 COUNT 端點', () => {
  const appJs = read('js/app.js');
  const inboxJs = read('js/views/Inbox.js');

  test('loadInboxUnread 打 inbox/unread-count', () => {
    const body = appJs.match(/async function loadInboxUnread\(\)\s*\{[\s\S]*?\n\}/)[0];
    // 引號風格不敏感：app.js 過 prettier 後單引號變雙引號，呼叫本身沒變。
    expect(body).toMatch(/Api\.get\(\s*['"]inbox\/unread-count['"]\s*\)/);
    expect(body).not.toMatch(/Api\.get\(\s*['"]inbox['"]\s*\)/);   // 清單有 LIMIT 100，不可拿來算數量
    expect(body).not.toMatch(/\.length/);
  });

  test('Inbox 的 syncBadge 不自行從 items 推算', () => {
    const body = inboxJs.match(/syncBadge\(\)\s*\{[^}]*\}/)[0];
    expect(body).not.toContain('unreadCount');
    expect(body).toContain('loadInboxUnread');
  });

  // 後端存在對應端點才有意義；端點被改名時這裡要一起紅
  test('後端有 /api/inbox/unread-count', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../inbox-routes.js'), 'utf8');
    expect(routes).toContain("app.get('/api/inbox/unread-count'");
  });

  test('收件匣暫不顯示於側欄，但保留路由與未讀同步供既有連結使用', () => {
    expect(appJs).not.toContain('data-tour="nav-inbox"');
    // route 定義過 prettier 後拆成多行、引號也換了；斷言的是「這條 route 仍指向 InboxView」，
    // 不是它排版長什麼樣。
    expect(appJs).toMatch(
      /path:\s*['"]\/inbox['"]\s*,\s*component:\s*window\.InboxView/,
    );
    expect(appJs).toMatch(/Api\.get\(\s*['"]inbox\/unread-count['"]\s*\)/);
  });
});
