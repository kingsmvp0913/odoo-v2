// 意圖：clarify 閘門停在畫面上時，留言框與人工退回框都被閘門面板取代——面板裡沒有附件入口，
// 使用者就完全沒有地方傳圖（task 150 的實況：AI 開口要圖，整頁 input[type=file] 數量為 0）。
//
// 這支守的是「**每一條**送出回答的路徑都有附件入口」，而不是「有一個就好」。面板有兩種回覆型態：
// 有解析出題目時逐題作答、沒題目時單一回覆框，兩者都呼叫 submitAnswer。2026-08-18 補入口時
// 只補了後者，而 AI 要圖多半是出成一道題——走的正是前者。漏掉的那半年零訊號：後端 /answer 的
// multipart 測試照樣全綠（它本來就吃得下 answers + files），前端沒有任何測試會看畫面。
//
// 斷言不寫死數量：兩邊都由同一份原始碼數出來，之後新增第三種回覆型態時會自動要求它也補上。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../public/js/views/TaskDetail.js'), 'utf8');

describe('clarify 閘門的每條回答路徑都有附件入口', () => {
  const submitButtons = src.match(/@click="submitAnswer"/g) || [];
  const fileInputs = src.match(/ref="answerFileInput"\s+type="file"/g) || [];

  test('解析得到送出按鈕（選擇器改名時不得靜默通過）', () => {
    expect(submitButtons.length).toBeGreaterThan(1);
  });

  test('每個送出回答的按鈕都配一個附件入口', () => {
    expect(fileInputs).toHaveLength(submitButtons.length);
  });

  // 入口存在但送出時不帶走檔案，等於畫面上有個裝飾品。
  test('送出時真的把選到的檔案帶進 multipart', () => {
    expect(src).toContain("this.answerFiles.forEach(f => fd.append('files', f))");
    expect(src).toMatch(/Api\.postForm\(`tasks\/\$\{this\.task\.id\}\/answer`/);
  });

  // answers（題目型）與 user_answer（單一回覆框）兩種 payload 都要能跟檔案一起送。
  // 少一種的症狀是那條路徑靜默落到另一個分支，必答檢查被繞過。
  test('multipart 分支對兩種 payload 都有處理', () => {
    expect(src).toContain("fd.append('answers', JSON.stringify(payload.answers))");
    expect(src).toContain("fd.append('user_answer', payload.user_answer)");
  });
});

// 提問（submitAsk）走的是另一個端點 /clarify-ask，與送出回答完全分開——「我不懂，你指的是哪裡？」
// 這種反問最需要配一張截圖，卻是三條路徑裡最後才補的一條。
describe('clarify 閘門的提問路徑同樣能附圖', () => {
  test('提問框有附件入口，且送出時帶進 multipart', () => {
    expect(src).toMatch(/ref="askFileInput"\s+type="file"/);
    expect(src).toContain("this.askFiles.forEach(f => fd.append('files', f))");
    expect(src).toMatch(/Api\.postForm\(`tasks\/\$\{this\.task\.id\}\/clarify-ask`/);
  });

  // 選了檔案卻沒清空，下一次提問會把上一輪的圖再傳一次（同一個面板不會重新掛載）。
  test('送出後清空已選檔案與 input', () => {
    expect(src).toContain('this.askFiles = []');
    expect(src).toContain("this.$refs.askFileInput.value = ''");
  });
});
