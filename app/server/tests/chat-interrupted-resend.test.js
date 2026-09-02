const fs = require('fs');
const path = require('path');

// 前端靠「訊息開頭是不是這串字」判斷該不該給重送鈕（ProjectChat.js 的 INTERRUPTED_PREFIX），
// 而那串字的真正來源在伺服器端。改了伺服器那句、前端沒跟著改的話，重送鈕就從畫面上消失——
// 沒有錯誤、沒有紅燈，只是使用者又要自己複製貼上重打一次。這條測試就是那個對不上的告警。
const serverSource = fs.readFileSync(path.join(__dirname, '../pipeline/chat-agent.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(__dirname, '../../public/js/ui-next/pages/ProjectChat.js'), 'utf8');

const serverMessage = (serverSource.match(/CHAT_INTERRUPTED_MSG\s*=\s*'([^']+)'/) || [])[1];
const clientPrefix = (clientSource.match(/INTERRUPTED_PREFIX\s*=\s*"([^"]+)"/) || [])[1];

test('伺服器的中斷訊息與前端比對的前綴仍然對得上', () => {
  expect(serverMessage).toBeTruthy();
  expect(clientPrefix).toBeTruthy();
  expect(serverMessage.startsWith(clientPrefix)).toBe(true);
});

// 前綴太短會誤判（例如只取「⚠️」會把所有警告訊息都當成中斷）。
test('前綴長到足以識別，不是一兩個符號', () => {
  expect(clientPrefix.length).toBeGreaterThanOrEqual(8);
});

// 意圖：重送鈕只能出現在最後一則。舊的中斷訊息後面通常已經有新的對話接下去，
// 在那裡重送等於把舊問題插隊到最新的討論之後。
test('canResend 綁在最後一則，且回覆進行中不給按', () => {
  expect(clientSource).toMatch(/canResend\(message,\s*index\)\s*{[^}]*index === this\.messages\.length - 1/);
  expect(clientSource).toMatch(/canResend\(message,\s*index\)\s*{[^}]*!this\.replyPending/);
});
