// 意圖：開新對話時，畫面先用瀏覽器暫存的文字畫一則「樂觀」訊息，伺服器那則回來後比對內容、相同就丟掉暫時那則。
// 帶附件時訊息走 multipart 上傳，瀏覽器會把換行 \n 改成 \r\n，DB 存的是 \r\n；暫存的仍是 \n。
// 只做字串全等比對的話兩邊永遠對不上，使用者就會看到同一句話出現兩次（實際回報：project 3 chat 126）。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../public/js/ui-next/pages/ProjectChat.js'), 'utf8');

function loadApplyOptimisticPending() {
  const start = src.indexOf('applyOptimisticPending() {');
  const end = src.indexOf('\n      },', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start + 'applyOptimisticPending() {'.length, end);
  return new Function(body);
}

function makeVm(messages, optimisticText) {
  return { messages, optimisticText, activeChat: { id: 126 } };
}

describe('UI Next 對話：新對話的樂觀訊息', () => {
  const apply = loadApplyOptimisticPending();

  test('伺服器存的是 \\r\\n（multipart 上傳）、暫存的是 \\n → 視為同一則，不畫第二份', () => {
    const vm = makeVm([{ id: 1070, role: 'user', content: '第一行\r\n第二行' }], '第一行\n第二行');
    apply.call(vm);
    expect(vm.messages).toHaveLength(1);
    expect(vm.optimisticText).toBe('');
  });

  test('伺服器那則還沒進 DB → 照樣先畫暫時那則', () => {
    const vm = makeVm([], '第一行\n第二行');
    apply.call(vm);
    expect(vm.messages.map((m) => m.id)).toEqual(['optimistic-126']);
  });

  test('內容真的不同 → 不可誤判成同一則', () => {
    const vm = makeVm([{ id: 1, role: 'user', content: '舊問題' }], '第一行\n第二行');
    apply.call(vm);
    expect(vm.messages).toHaveLength(2);
  });
});
