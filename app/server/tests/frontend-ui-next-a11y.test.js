// 意圖：把 ROUND2-SPEC §9.3「缺的無障礙／鍵盤契約」變成擋得住回歸的守衛。
//
// 那份清單是靜態掃描的結果（實測 16/20 未達成），但清單本身不會擋任何東西——
// 下次有人重寫 template，補好的契約會靜默消失，而畫面看起來完全正常。
//
// 為什麼優先做 Toast：§9.3 自己點名的。本輪稍早才修好「錯誤訊息 0ms 就消失」
// （§5.7 的 duration 參數把行為反轉），但沒有 aria-live 的話，對螢幕閱讀器使用者
// 而言那些錯誤訊息仍然是**看不到也聽不到**——修了等於沒修。
//
// 判準：契約以 template 字串的靜態檢查為準。這裡不模擬 DOM，因為 ui-next 的
// component 是 Vue.defineComponent 的巨大 template 字串，靜態掃描已足夠擋回歸，
// 且與同目錄其他 frontend-ui-next-* 守衛的做法一致。
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(
  path.join(__dirname, '../../public/js/ui-next/UiNextApp.js'),
  'utf8',
);
const PAGES = fs.readFileSync(
  path.join(__dirname, '../../public/js/ui-next/UiNextPages.js'),
  'utf8',
);

// 取出某個 class 起始的那個開標籤（含全部屬性），用於檢查屬性有沒有掛上。
function openTagWithClass(src, className) {
  const at = src.indexOf(`class="${className}"`);
  if (at === -1) return null;
  const start = src.lastIndexOf('<', at);
  const end = src.indexOf('>', at);
  if (start === -1 || end === -1) return null;
  return src.slice(start, end + 1);
}

describe('ROUND2-SPEC §9.3 無障礙契約', () => {
  // 解析器失效時測試不得靜默通過——這個 repo 反覆踩過的坑。
  test('找得到 ui-next 的 toast host（寫法變動時不得靜默略過）', () => {
    const tag = openTagWithClass(APP, 'toast-container');
    expect(tag).toBeTruthy();
    expect(tag).toMatch(/^<div/);
  });

  test('Toast host 有 aria-live，否則錯誤訊息對螢幕閱讀器等於不存在', () => {
    const tag = openTagWithClass(APP, 'toast-container');
    // polite 而非 assertive：toast 是輔助訊息，不該打斷使用者當下正在聽的內容。
    expect(tag).toMatch(/aria-live="polite"/);
    // 逐則播報而非整區重念——同時出現多則時才不會把舊的也重念一遍。
    expect(tag).toMatch(/aria-atomic="false"/);
    // role=status 讓沒實作 aria-live 的舊版輔助技術也拿得到語意。
    expect(tag).toMatch(/role="status"/);
  });

  // Command Palette 已有 role="dialog"／aria-modal／Escape（§9.3 標為 ✅），
  // 缺的是這兩項。它們不是屬性而是行為：沒有方向鍵就等於只能用滑鼠點，
  // 而 ⌘K 這種入口的使用者幾乎都是鍵盤操作。
  test('Command Palette 有 ↑↓ 導航', () => {
    expect(APP).toMatch(/@keydown\.down\.prevent="moveCommand\(1\)"/);
    expect(APP).toMatch(/@keydown\.up\.prevent="moveCommand\(-1\)"/);
    // 有綁定還不夠，method 真的要存在——綁到不存在的 method 在 Vue 是靜默失敗。
    expect(APP).toMatch(/moveCommand\(\s*step\s*\)\s*\{/);
    // 選中項要讓輔助技術知道是哪一個，否則方向鍵移動了但螢幕閱讀器不會報。
    expect(APP).toMatch(/aria-activedescendant/);
    expect(APP).toMatch(/role="listbox"/);
    expect(APP).toMatch(/role="option"/);
  });

  test('Command Palette 開啟時鎖背景捲動', () => {
    // 不鎖的話，在 palette 內捲動會穿透到背後的頁面（overlay 的典型缺陷）。
    expect(APP).toMatch(/document\.body\.style\.overflow/);
  });

  // §9.3 的 Drawer 就是行動版側欄（§9.4 分工寫「Drawer／側欄」）。
  test('行動版側欄開啟時才是 dialog，桌機的永久導覽不是', () => {
    // 無條件加 role="dialog" 會讓桌機使用者的永久側欄被輔助技術誤報成對話框，
    // 所以必須是條件綁定而不是靜態屬性。
    expect(APP).toMatch(/:role="mobileSidebarOpen \? 'dialog' : null"/);
    expect(APP).toMatch(/:aria-modal="mobileSidebarOpen \? 'true' : null"/);
    // 靜態的 role="dialog" 不該出現在 sidebar 上
    const aside = APP.slice(APP.indexOf('<aside class="ui-next-sidebar"'));
    expect(aside.slice(0, aside.indexOf('>'))).not.toMatch(/\srole="dialog"/);
  });

  // role="dialog" 卻不 trap 焦點是半套，而且比不加還糟：輔助技術宣告「這是對話框」，
  // 使用者一按 Tab 卻跑到背景內容去，完全對不上。
  test('行動版抽屜有焦點管理（trap＋開啟移入＋關閉還原）', () => {
    // 共用的 trap，palette 與抽屜都用它
    expect(APP).toMatch(/trapFocus\(event,\s*container\)/);
    expect(APP).toMatch(/ref="mobileSidebar"/);
    expect(APP).toMatch(/@keydown="trapSidebarFocus"/);
    // 開啟時焦點要移進抽屜，否則螢幕閱讀器仍停在背景
    expect(APP).toMatch(/openMobileSidebar\(/);
    // 關閉後焦點還原到觸發鈕（Escape／點遮罩這種「取消」動作）
    expect(APP).toMatch(/mobileSidebarTrigger/);
  });

  // 側欄底部兩個下拉（更多工具／帳號）。原本只有 aria-expanded，
  // 對輔助技術而言那只說明「展開了」，沒說明「展開的是一份選單」。
  test('下拉選單有 menu 語意', () => {
    // 兩個 trigger 都要宣告它會開出選單
    expect(APP.match(/aria-haspopup="menu"/g) || []).toHaveLength(2);
    expect(APP.match(/class="ui-next-account-menu" role="menu"/g) || []).toHaveLength(2);
    // 選單項要是 menuitem，不能只是裸 button
    expect(APP).toMatch(/role="menuitem"/);
  });

  test('下拉選單有方向鍵導航', () => {
    expect(APP).toMatch(/@keydown\.down\.prevent="moveMenu\(\$event, 1\)"/);
    expect(APP).toMatch(/@keydown\.up\.prevent="moveMenu\(\$event, -1\)"/);
    expect(APP).toMatch(/moveMenu\(event, step\)/);
    // 項目數會隨 isAdmin 動態增減，所以用 DOM 查詢而不是維護索引
    expect(APP).toMatch(/focusMenuItem\(menu, step\)/);
    expect(APP).toMatch(/querySelectorAll\('\[role="menuitem"\]'\)/);
  });

  // 任務進度列（UiNextStatusBar）。只有 aria-label 說得出「這是進度」，
  // 但說不出「現在走到哪一步」——那正是這個元件唯一要傳達的資訊。
  // UiNextStatusBar 不在 FROZEN_COPIES 的 13 個 View 內，所以動它不會踩到凍結比對。
  test('Stepper 標出目前步驟（aria-current）', () => {
    expect(PAGES).toMatch(/class="stepper"/);
    // 停止／衝突時沒有「目前步驟」（整列都是錯誤態），所以要連 isStopped 一起判斷
    expect(PAGES).toMatch(/:aria-current="[^"]*!isStopped&&index===activeIdx[^"]*'step'[^"]*"/);
  });

  // 兩個 overlay 共用 document.body.style.overflow，若各自在開關處自行加解鎖，
  // 「開 A → 開 B → 關 A」就會在 B 還開著時把捲動解掉。改由狀態集中推導。
  test('背景捲動由 watch 集中同步，不散落在各個開關處', () => {
    expect(APP).toMatch(/watch:\s*\{/);
    expect(APP).toMatch(/commandOpen\(\)\s*\{\s*this\.syncBodyScroll\(\)/);
    expect(APP).toMatch(/mobileSidebarOpen\(\)\s*\{\s*this\.syncBodyScroll\(\)/);
    // 推導自「有沒有任何 overlay 開著」，而不是各自 true/false
    expect(APP).toMatch(/syncBodyScroll\(\)\s*\{[\s\S]{0,200}commandOpen \|\| this\.mobileSidebarOpen/);
  });
});
