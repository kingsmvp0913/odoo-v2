// 意圖：收件匣的「進任務就已讀」前後端接線。
//
// ⚠ 這支原本還守著 Inbox.js 的 grouped()（同任務未讀收合成一張卡片）。2026-09-22 舊版前端
// 整個退役，js/views/Inbox.js 一併刪除，而 ui-next 沒有收件匣頁——收合那一整組斷言連對象都
// 沒有了，所以是刪掉而不是改寬。留下來的是仍然活著的這條接線。
const fs = require('fs');
const path = require('path');

// 這條線斷掉是零訊號的：TaskDetail 那邊 catch 掉所有錯誤（收件匣不是任務頁的關鍵路徑），
// 端點改名或路徑打錯只會讓「進任務就已讀」靜靜失效，畫面上什麼都看不出來。
describe('「進任務就已讀」的前後端接線', () => {
  test('TaskDetail 進頁時打 inbox/task/:id/read，且後端真的有這支', () => {
    const detail = fs.readFileSync(path.join(__dirname, '../../public/js/ui-next/pages/TaskDetail.js'), 'utf8');
    expect(detail).toMatch(/Api\.post\(`inbox\/task\/\$\{[^}]+\}\/read`\)/);
    expect(detail).toMatch(/this\.markInboxRead\(\)/);   // 有方法但沒人呼叫＝等於沒做

    const routes = fs.readFileSync(path.join(__dirname, '../inbox-routes.js'), 'utf8');
    expect(routes).toContain("app.post('/api/inbox/task/:taskId/read'");
  });

  test('清完要校正 badge，否則數字要等下次換頁才更新', () => {
    const detail = fs.readFileSync(path.join(__dirname, '../../public/js/ui-next/pages/TaskDetail.js'), 'utf8');
    const body = detail.match(/async markInboxRead\(\)\s*\{[\s\S]*?\n      \},/)[0];
    expect(body).toContain('loadInboxUnread');
  });
});
