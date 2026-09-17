// 意圖（D2）：AI 在容器裡改程式時，物件還沒搬進共用庫，/api/tasks/:id/diff 回 pending 而不是 missing。
// 審核頁要把「AI 還在改」「檢查未通過」與「分支已清理」分開講，否則使用者會以為任務已經核准或不見了。
const fs = require('fs');
const path = require('path');

const tpl = fs.readFileSync(path.join(__dirname, '../../public/js/ui-next/pages/TaskDetail.js'), 'utf8');

test('pending 兩種狀態各有自己的說明，且排在「分支已清理」之前判斷', () => {
  const running = tpl.indexOf(`repo.pending==='running'`);
  const error = tpl.indexOf(`repo.pending==='error'`);
  const missing = tpl.indexOf('v-else-if="repo.missing"');
  expect(running).toBeGreaterThan(-1);
  expect(error).toBeGreaterThan(running);
  expect(missing).toBeGreaterThan(error);
  expect(tpl).toMatch(/AI 還在修改中/);
});
