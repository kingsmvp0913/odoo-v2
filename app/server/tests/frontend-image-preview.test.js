// 意圖：平台的圖原本有三種點法，沒有一種是「放大看」——
//   對話／意見回饋：window.open(objectURL) 另開分頁（離開現在這一頁）
//   任務詳情附件  ：直接觸發下載（想看一眼要先存到硬碟）
//   題庫截圖      ：只有它自己養了一個 lightbox
// 而剛貼上還沒送出的縮圖只有 34～54px，點了完全沒反應。
//
// 這支守的是「統一」這件事本身：跳窗只能有一個實作、每個縮圖都接到它、
// 而且外殼真的掛得起來（漏掛的症狀是點圖沒反應，沒有任何錯誤訊息）。
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../../public', rel), 'utf8');
const host = read('js/image-preview.js');
const indexHtml = read('index.html');
const appJs = read('js/app.js');
const shell = read('js/ui-next/UiNextApp.js');
const chat = read('js/ui-next/pages/ProjectChat.js');
const taskDetail = read('js/ui-next/pages/TaskDetail.js');
const taskList = read('js/ui-next/pages/TaskList.js');
const projectDetail = read('js/ui-next/pages/ProjectDetail.js');
const adminFeedback = read('js/ui-next/pages/AdminFeedback.js');
const examBank = read('js/ui-next/pages/ExamBank.js');

describe('圖片放大跳窗：只有一套，而且真的接得起來', () => {
  test('跳窗本體掛在全域，且 index.html 有載', () => {
    expect(host).toContain('window.previewImage');
    expect(host).toContain('window.ImagePreviewHost');
    // 載入清單漏一支的症狀是「點圖沒反應」——previewImage 是 undefined，錯誤只在 console
    expect(indexHtml).toContain('js/image-preview.js');
  });

  // 2026-09-22 舊版前端退役：外殼只剩 ui-next 一套，掛載點只剩 UiNextApp.js 的 template。
  // 註冊（app.js）與掛載（外殼 template）仍是兩邊，少任一邊都是「點圖沒反應」。
  test('外殼掛了 host，且元件有註冊（少任一邊＝點圖沒反應）', () => {
    expect(shell).toContain('<image-preview-host />');
    expect(appJs).toContain('app.component("ImagePreviewHost", window.ImagePreviewHost)');
    // template 直接叫 previewImage(...) 靠的是這一行；少了它，十幾處縮圖全部靜默失效
    expect(appJs).toContain('app.config.globalProperties.previewImage = window.previewImage');
  });

  test('Esc 關得掉、關掉之後焦點回到原本那顆按鈕', () => {
    expect(host).toContain("e.key === 'Escape'");
    expect(host).toMatch(/_trigger/);
    expect(host).toContain('trigger.focus()');
  });

  test('沒有人再用另開分頁／直接下載當作「看圖」', () => {
    for (const src of [chat, adminFeedback]) {
      const openImage = src.slice(src.indexOf('openImage('), src.indexOf('openImage(') + 400);
      expect(openImage).not.toContain('window.open');
      expect(openImage).toContain('window.previewImage');
    }
    // 任務詳情的附件圖：點了是放大，下載改由跳窗裡那顆按鈕負責（沒拿掉功能）
    expect(taskDetail).toContain('@click="previewAttachment(file)"');
    expect(taskDetail).toContain('onDownload: () => this.downloadAttachment(');
  });

  test('題庫頁不再自己養一套 lightbox', () => {
    expect(examBank).not.toContain('ui-next-exam-lightbox');
    expect(examBank).toContain('window.previewImage');
  });

  test('每一處待傳縮圖都點得開', () => {
    for (const src of [shell, chat, taskList, projectDetail, taskDetail]) {
      expect(src).toContain('previewImage({src:');
    }
  });

  test('跳窗樣式放在兩套 UI 都載得到的 app.css', () => {
    const appCss = read('css/app.css');
    expect(appCss).toContain('.img-lightbox');
    // 覆蓋整個畫面的觀圖模式：底色與文字色刻意寫死深底白字，不跟主題走
    // （跟著 var(--text) 走的話，淺色模式會變成白底白字）
    expect(appCss).toMatch(/\.img-lightbox-bar\s*\{[^}]*#fff/);
  });
});
