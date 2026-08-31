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
    expect(APP).toMatch(/lockBodyScroll|document\.body\.style\.overflow/);
  });
});
