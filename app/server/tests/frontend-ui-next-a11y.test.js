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
// View 已全部拆進 pages/。列舉目錄而不是寫死清單：漏列一個檔的症狀是那支 View
// 不再被檢查，而測試照樣全綠——比直接漏檢更難發現。
const uiNextDir = path.join(__dirname, '../../public/js/ui-next');
const pagesDir = path.join(uiNextDir, 'pages');
// UiNextShared.js 一併讀：共用的小元件（StatusBar／WikiNode）住在那裡。
const PAGES = [
  fs.readFileSync(path.join(uiNextDir, 'UiNextShared.js'), 'utf8'),
  ...fs.readdirSync(pagesDir).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(pagesDir, f), 'utf8')),
].join('\n');

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
    // 靜態的 role="dialog" 不該出現在 sidebar 上。
    // ⚠ 原本這裡找的是 '<aside class="ui-next-sidebar"'，但 template 上 ref 排在 class 前面，
    // indexOf 回 -1 → slice(-1) 取到最後一個字元 → 這個反向斷言恆真、擋不住任何東西。
    // 改用 <aside 起點並先驗證抓得到，解析器失效時要紅而不是靜默通過。
    const asideAt = APP.indexOf('<aside ');
    expect(asideAt).toBeGreaterThan(-1);
    const asideTag = APP.slice(asideAt, APP.indexOf('>', asideAt) + 1);
    expect(asideTag).toContain('class="ui-next-sidebar"');
    expect(asideTag).not.toMatch(/\srole="dialog"/);
  });

  // 沒有展開箭頭之後，專案名稱本身就是 toggle：它必須是原生 button 並回報 aria-expanded，
  // 否則螢幕閱讀器只會聽到一個專案名，聽不出「這裡可以展開，而且現在是收合的」。
  test('專案名稱本身是展開控制，回報 aria-expanded', () => {
    expect(APP).toMatch(/<button @click="toggleProject\(project\)" :aria-expanded="!!expandedProjects\[project\.id\]">/);
    // 反向：箭頭已全面移除，不該再有第二個 toggle 控制項
    expect(APP).not.toContain('ui-next-nav-toggle');
  });

  // selected 是視覺樣式，輔助技術讀不到 class。沒有 aria-current，
  // 螢幕閱讀器使用者在一排 Chat 標題裡分不出自己正開著哪一個。
  test('目前 Chat 標記 aria-current="page"', () => {
    expect(APP).toMatch(/:aria-current="isCurrentChat\(project, chat\) \? 'page' : null"/);
    expect(APP).toMatch(/isCurrentChat\(project, chat\)\s*\{/);
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
    // 底部兩個下拉（更多工具／帳號）＋ 側欄兩個 ⋮（專案／對話），每個 trigger 都要宣告它會開出選單。
    // 不斷言總數：那會讓「多加一個合法的選單」變成假紅（實測踩過）。
    expect(APP).toMatch(/class="ui-next-tools"[^>]*aria-haspopup="menu"/);
    expect(APP).toMatch(/class="ui-next-account"[^>]*aria-haspopup="menu"/);
    expect(APP.match(/class="ui-next-row-more"[\s\S]{0,200}?aria-haspopup="menu"/g) || []).toHaveLength(2);
    expect(APP.match(/class="ui-next-account-menu" role="menu"/g) || []).toHaveLength(2);
    // 中間容許其他屬性：這兩個選單支援右鍵開在指標處，帶著 :class／:style 綁定。
    // 仍然釘住「兩個 row-menu 都宣告了 role=menu」，只是不再要求兩者相鄰。
    expect(APP.match(/class="ui-next-row-menu"[^>]*role="menu"/g) || []).toHaveLength(2);
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

  // 任務列表的篩選（需回覆／待處理／暫停中／全部／已封存）。
  //
  // §9.3 寫的是補 role="listbox"／role="option"／aria-selected，這裡刻意不照做：
  //   1. listbox 的鍵盤模型要容器可聚焦＋方向鍵＋aria-activedescendant，
  //      而這組是本來就能 Tab、能 Enter 的原生 button——改成 listbox 是把可用的東西拆掉重做。
  //   2. 只加 role 不做鍵盤模型，就是宣告了卻做不到，跟「role=dialog 但焦點不 trap」同一種錯。
  //   3. aria-selected 只在 option／tab／row 上有效，掛在 button 上不會被輔助技術採納。
  // 這組是互斥的切換按鈕，正確語意是 aria-pressed；容器用 group＋aria-label 說明用途。
  // ⚠ class="ui-next-task-tabs" 被兩處共用：TaskDetail（role="tablist"，切換同頁面板）
  // 與 TaskList（篩選清單內容）。兩者用途不同所以語意不同，靠 role 區分：
  // 前者 tablist/tab，後者 group + aria-pressed。
  test('任務篩選用 aria-pressed 表達啟用中，而不是掛無效的 aria-selected', () => {
    expect(PAGES).toMatch(/class="ui-next-task-tabs" role="group" aria-label="任務篩選"/);
    expect(PAGES).toMatch(/:aria-pressed="filter===item\[0\] \? 'true' : 'false'"/);
    // TaskDetail 那組頁籤已整組移除（需求進對話、執行歷程走跳窗），這裡只剩任務篩選那組
    expect(PAGES).not.toMatch(/role="tablist" aria-label="任務詳情"/);
    // 反向斷言：篩選那組不要掛 aria-selected（在 button 上是無效屬性）
    const at = PAGES.indexOf('class="ui-next-task-tabs" role="group"');
    expect(PAGES.slice(at, at + 700)).not.toMatch(/aria-selected/);
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
