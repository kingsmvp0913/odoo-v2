// 意圖：截圖用貼的是這個平台最常見的送圖方式，但它在畫面上完全沒有入口提示——
// 沒綁 @paste 的輸入框按 Ctrl+V 是「什麼都沒發生」，沒有錯誤、沒有提示，
// 使用者只會以為不支援（2026-09-08 的回報就是「chat 可以貼，新對話跟任務不行」）。
//
// 守的是三個入口都接得起來，以及兩件會靜默壞掉的事：
//   ① 貼上要有畫面回饋（縮圖／檔名 chip），否則貼了跟沒貼一樣
//   ② 建出來的 objectURL 要有人 revoke，不然每開一次視窗漏一次記憶體
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../../public', rel), 'utf8');
const shell = read('js/ui-next/UiNextApp.js');
const chat = read('js/ui-next/pages/ProjectChat.js');
const taskList = read('js/ui-next/pages/TaskList.js');
const projectDetail = read('js/ui-next/pages/ProjectDetail.js');
const taskDetail = read('js/ui-next/pages/TaskDetail.js');

describe('貼上截圖：各個上傳入口', () => {
  test('首頁輸入框：貼上進得來，而且貼完看得到縮圖', () => {
    expect(shell).toContain('@paste="onPasteFiles"');
    expect(shell).toContain('syncFilePreviews');
    // 只顯示檔名（剪貼簿一律叫 image.png）看起來像沒生效，所以縮圖是這條的重點
    expect(shell).toMatch(/:src="filePreviews\[index\]"/);
    expect(shell).toContain('URL.revokeObjectURL');
  });

  // ⚠ 專案頁「對話」分頁那顆才是按得到的新對話入口：對話頁的小視窗掛在「對話紀錄」抽屜裡，
  // 而 toggleHistory 沒有綁在任何按鈕上（既有問題），沒帶 chatId 的網址又會被重導回這一頁。
  test('專案頁「新對話」：先展開輸入框，能打第一句話也能貼圖', () => {
    expect(projectDetail).toContain('@paste="onNewChatPaste"');
    expect(projectDetail).toContain('v-model="newChatText"');
    expect(projectDetail).toContain('openNewChat');
    const createChat = projectDetail.slice(projectDetail.indexOf('async createChat()'), projectDetail.indexOf('openChat(chat)'));
    // 有圖一定要走 multipart：走 JSON 的話圖直接消失，後端只收到文字
    expect(createChat).toContain('FormData');
    expect(createChat).toContain('Api.postForm');
    // 訊息端點會 await 整輪 AI 回覆：等它回來才換頁＝按下去像當掉好幾分鐘
    expect(createChat).toContain('pending=1');
    expect(createChat).not.toMatch(/await\s+Api\.postForm/);
    expect(projectDetail).toMatch(/beforeUnmount\(\)[^\n]*revokeNewChatUrls\(\)/);
  });

  test('對話頁小視窗：同一組入口也接上（等抽屜修好就是現成的）', () => {
    expect(chat).toContain('@paste="onNewChatPaste"');
    expect(chat).toContain('v-model="newChatText"');
    expect(chat).toMatch(/:src="url"/);
    // 有圖一定要走 multipart：走 JSON 的話圖直接消失，後端只收到文字
    const createChat = chat.slice(chat.indexOf('async createChat()'), chat.indexOf('resetNewChat()'));
    expect(createChat).toContain('FormData');
    expect(createChat).toContain('Api.postForm');
    // 訊息端點會 await 整輪 AI 回覆：等它回來才換頁＝視窗卡住好幾分鐘
    expect(createChat).toContain('pending=1');
    expect(createChat).not.toMatch(/await\s+Api\.postForm/);
  });

  test('建立任務視窗：需求描述吃得下貼上，附件列顯示縮圖', () => {
    expect(taskList).toContain('@paste="onAddPaste"');
    expect(taskList).toContain('syncAddPreviews');
    expect(taskList).toMatch(/:src="newPreviews\[index\]"/);
  });

  test('提意見視窗：貼上進得來，而且貼完看得到縮圖', () => {
    expect(shell).toContain('@paste="onFeedbackPaste"');
    expect(shell).toContain('syncFeedbackPreviews');
    expect(shell).toMatch(/:src="feedbackPreviews\[index\]"/);
  });

  // ⚠ 這一格的送出讀的是 answerFiles（submitAnswer），貼上原本卻寫進 newMessageFiles，
  // 於是在「回答 AI 提問」貼的截圖被靜默丟掉：畫面沒有任何徵狀，送出也照樣成功。
  test('任務詳情的回答面板：貼上的圖進得去真正會被送出的那個清單', () => {
    expect(taskDetail).toContain("@paste=\"onPasteFiles($event,'answerFiles')\"");
    const submitAnswer = taskDetail.slice(taskDetail.indexOf('async submitAnswer('), taskDetail.indexOf('async approve('));
    expect(submitAnswer).toContain('this.answerFiles.forEach');
  });

  test('任務詳情的留言框：placeholder 說得出口的，實際上要做得到', () => {
    // placeholder 寫「可直接貼上截圖」卻沒綁 @paste ⇒ 按 Ctrl+V 什麼都不會發生
    const composer = taskDetail.slice(taskDetail.indexOf('placeholder="新增留言…可直接貼上截圖"'));
    expect(composer.slice(0, 400)).toContain("onPasteFiles($event,'newMessageFiles')");
  });

  test('任務詳情四個輸入框都看得到自己貼了什麼，也拿得掉', () => {
    for (const key of ['askFiles', 'answerFiles', 'rejectFiles', 'newMessageFiles']) {
      expect(taskDetail).toContain(`${key}Previews: []`);
      expect(taskDetail).toContain(`:src="${key}Previews[index]"`);
      expect(taskDetail).toContain(`removeFileAt('${key}',index)`);
    }
    // 卸載時要收回 objectURL，否則每開一張任務漏一次
    expect(taskDetail).toMatch(/beforeUnmount\(\)[\s\S]{0,900}?Previews[\s\S]{0,120}?revokeObjectURL/);
  });

  test('三處建出來的 objectURL 都有回收', () => {
    for (const src of [shell, chat, taskList]) expect(src).toContain('URL.revokeObjectURL');
    expect(chat).toContain('revokeNewChatUrls()');
    // 元件卸載時也要收：關視窗以外還有「直接切走」這條路
    expect(chat).toMatch(/beforeUnmount\(\)[^\n]*revokeNewChatUrls\(\)/);
    expect(taskList).toMatch(/beforeUnmount\(\)[^\n]*revokeObjectURL/);
  });

  // 對話的三個入口（首頁 composer／對話輸入列／專案頁新對話小視窗）限制必須同一組，而且那一組
  // 只能來自 window.CHAT_FILE_TYPES——後端 lib/attachments.js 的鏡像。各自寫死自己那份的話，
  // 症狀是「這個入口傳得上、那個入口傳不上」，而畫面完全看不出差別。
  test('對話的三個入口都吃共用清單，不自己寫死上限或型別', () => {
    for (const src of [shell, chat, projectDetail]) {
      expect(src).toContain('window.CHAT_FILE_TYPES');
      expect(src).toMatch(/CHAT_FILE_TYPES\.maxBytes|types\.maxBytes/);
    }
    // 逐個 handler 檢查而不是整檔掃：UiNextApp 裡還有「意見回饋」那條路，它刻意維持
    // 只收圖、10MB 的另一組限制，整檔掃會把它誤判成漏改。
    // 錨點要帶 ' {'：不帶的話 indexOf 會先撞到 onNewChatPaste 裡的呼叫端而不是定義。
    const fn = (src, name) => {
      const at = src.indexOf(name + ' {');
      expect(at).toBeGreaterThan(-1);
      return src.slice(at, at + 500);
    };
    const chatHandlers = [
      fn(shell, 'chooseFiles(e)'),
      fn(chat, 'addPendingFiles(files)'),
      fn(chat, 'addNewChatFiles(files)'),
      fn(projectDetail, 'addNewChatFiles(files)')
    ];
    for (const handler of chatHandlers) {
      expect(handler).toMatch(/maxBytes/);
      expect(handler).not.toMatch(/10 \* 1024 \* 1024/);   // 舊的寫死上限要真的被拿掉
    }
  });

  // 任務附件走的是另一條端點（uploadAttachmentFiles），限制刻意與對話分開，維持自己那份 10MB。
  test('任務清單的附件入口維持自己的限制（不跟著對話一起放寬）', () => {
    expect(taskList).toMatch(/10 \* 1024 \* 1024/);
    // ⚠ 判圖片用 startsWith('image/') 而不是 /^image\//：後者的 \// 會被
    // frontend-ui-next-deadcode／duplicate-keys 那兩支守衛的解析器當成行註解，
    // 整行被吃掉、大括號失衡，那支 View 就靜默退出檢查範圍（實際發生過）。
    expect(taskList).toMatch(/startsWith\("image\/"\)/);
  });
});
