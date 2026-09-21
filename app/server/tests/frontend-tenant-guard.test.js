// 意圖：第 3 部 b「把後端本來就會拒絕的入口，從一般使用者與客戶眼前藏起來」——
// 八關的成果全是前端條件（route meta 旗標、nav 的 v-if），而這個 repo 沒有任何 DOM 測試，
// 驗收靠的是人工開瀏覽器看。人工驗收不會在半年後有人改 nav 或 route 表時重跑，
// 所以這一支把當時每一個「藏起來」的決定釘成靜態斷言：忘記了會直接紅燈，而不是無聲放回去。
//
// 手法沿用 frontend-admin-route-guard.test.js 與 frontend-saas-specs.test.js：
// 讀原始碼字面、用正則切片比對。不 require app.js／UiNextApp.js——它們依賴 Vue、VueRouter
// 等瀏覽器全域，在 node 環境載不起來。
//
// ⚠ 這支守衛的盲區（打算相信它之前先讀完這一段）
// 它比對的是原始碼的「字面」，所以兩個方向都會判錯：
//
// A. 有擋卻報成沒擋（假警報，紅燈但程式是對的）
//    條件換成等價但不同字面的寫法就抓不到：meta 改用展開（`meta: { ...ADMIN_META }`）、
//    route 表改成迴圈／map 產生、`v-if="isAdmin"` 換成 computed（`v-if="canSeeArchitecture"`）
//    或只是多打一個空格。這種紅燈該修的是這支守衛（把新寫法教給它），
//    不是把程式改回舊字面來討好測試。
//
// B. 沒擋卻報成有擋（假安全，綠燈但入口是開的——這個方向危險得多）
//    1. 它只認清單上那幾個入口。新增的 nav 項目若不在清單裡就完全看不見；
//       本檔用「選單項目數量」釘住四個選單來補這個洞，但也只補到那四個——
//       專案頁的分頁、各頁面內部的按鈕、動態產生的項目一律不在範圍內。
//    2. 它驗「條件的字面」，不驗「條件的值」。`v-if="isAdmin"` 好端端寫著，
//       但 isAdmin 的來源壞掉（後端不再回 role、登入流程沒設、登出沒清）時，
//       字面沒變，本檔照樣全綠。同理 `userStore.features.exam` 若永遠是 undefined，
//       入口等於被藏死，這裡也看不出來。
//    3. route meta 對、但 guard 本體被短路（beforeEach 開頭插一行 `return true`）也是綠的。
//    4. legacy 前端（app/public/js/views/）完全不在掃描範圍。
//    5. 最重要的一條：前端隱藏只是體驗層，擋不住任何人直接打 API。
//       真正的防線是後端 403（tenant-route-guard.test.js、company-routes.test.js 那一批）。
//       這支全綠只代表「該藏的還藏著」，不代表「資料擋得住」。
//
// 每一份靠掃描產生的清單都自己先斷言筆數：掃不到東西的守衛會永遠靜默通過，
// 那比沒有守衛更糟（既有 frontend-admin-route-guard 的 requiresInternal 盲點就是這樣來的）。
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', '..', 'public');
const APP_JS = fs.readFileSync(path.join(pub, 'js', 'app.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(pub, 'js', 'ui-next', 'UiNextApp.js'), 'utf8');

// routes 陣列裡每個物件以 path: "…" 開頭，切到下一個 path: 為止（同 frontend-admin-route-guard）。
const routeBlocks = (() => {
  const marks = [...APP_JS.matchAll(/path:\s*["'`]([^"'`]+)["'`]/g)];
  return marks.map((m, i) => ({
    path: m[1],
    body: APP_JS.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : APP_JS.length),
  }));
})();

const blockOf = (p) => routeBlocks.find((r) => r.path === p);

describe('route 表：3b 收斂掉的路由旗標', () => {
  // 平台管理員限定（2026-09-21 裁決 D2「兩個都收」＋規格 §5.5）。
  // 這幾條都不是 /admin 前綴，自動推導看不出來，只能列名。
  // 與 frontend-admin-route-guard 的 ADMIN_ONLY_OUTSIDE 重疊是刻意的：那支是全站 admin-only
  // 路由的總表，這支是 3b 分租隱藏的完整圖（旗標＋requiresInternal＋nav 條件一起看）。
  // 兩支一起紅，好過兩支都以為對方會管。
  const ADMIN_ROUTES = [
    '/architecture',      // 架構圖：平台內部實作細節
    '/pipeline-flow',     // 流程圖：同上
    '/task/:id/terminal', // 終端機：能直接對任務容器下指令
    '/companies',         // 公司管理（Task 8）：建立／停用客戶公司、設定 GIT 憑證
  ];
  // 內部人員限定。用 requiresInternal 而非 requiresAdmin 是刻意的裁決：
  // 鎖成管理員限定會把考試從 7 個內部同事手上收走（見 app.js /exam-bank 的註解）。
  const INTERNAL_ROUTES = ['/exam-bank', '/exam-run'];

  test('route 表解析得到（寫法改變時不得靜默略過）', () => {
    expect(routeBlocks.length).toBeGreaterThanOrEqual(25);
    const missing = [...ADMIN_ROUTES, ...INTERNAL_ROUTES].filter((p) => !blockOf(p));
    expect(missing).toEqual([]);
  });

  test.each(ADMIN_ROUTES)('%s 掛著 requiresAdmin', (p) => {
    expect(`${p}: ${/requiresAdmin:\s*true/.test(blockOf(p).body)}`).toBe(`${p}: true`);
  });

  test.each(INTERNAL_ROUTES)('%s 掛著 requiresInternal', (p) => {
    expect(`${p}: ${/requiresInternal:\s*true/.test(blockOf(p).body)}`).toBe(`${p}: true`);
  });

  // 反向釘住那個裁決：改回 requiresAdmin 不會有人抱怨（內部同事只會以為考試沒了），
  // 所以要由測試來喊。
  test.each(INTERNAL_ROUTES)('%s 不得被改回 requiresAdmin', (p) => {
    expect(`${p}: ${/requiresAdmin:\s*true/.test(blockOf(p).body)}`).toBe(`${p}: false`);
  });
});

// frontend-admin-route-guard 只驗到 requiresAdmin 那一段（它的切片長度是寫死的 1200 字元，
// requiresInternal 這個後加的分支剛好還在裡面，但再多幾行註解就會掉出去）。
// 這裡自己把 beforeEach 整段切乾淨再驗。
describe('router guard：requiresInternal 分支', () => {
  const guard = (() => {
    const start = APP_JS.indexOf('router.beforeEach');
    const end = APP_JS.indexOf('\n});', start);
    return start < 0 || end < 0 ? '' : APP_JS.slice(start, end + 4);
  })();

  // 切片失敗（找不到起點或結尾）時整個 describe 都會變成「什麼都沒比對到」的假綠。
  test('beforeEach 整段切得到，且四個分支都在切片內', () => {
    expect(guard.length).toBeGreaterThan(400);
    expect(guard.trimEnd().endsWith('});')).toBe(true);
    for (const key of ['requiresAuth', 'requiresAdmin', 'requiresInternal', '/company-users']) {
      expect(`${key}: ${guard.includes(key)}`).toBe(`${key}: true`);
    }
  });

  // 註解先剝掉：這個分支的註解本身就在講「不要再補 role 特判」，字面掃描會被它誤判。
  const stripComments = (src) => src.replace(/\/\/.*$/gm, '');
  const internalBranch = guard.match(/if\s*\([^)]*requiresInternal[^)]*\)\s*\{[\s\S]*?\n\s{2}\}/);

  test('requiresInternal 分支問的是 is_internal', () => {
    expect(internalBranch).not.toBeNull();
    expect(internalBranch[0]).toMatch(/is_internal/);
    expect(internalBranch[0]).toMatch(/forbidden/);
  });

  // 「平台管理員沒有公司、後端一律視為內部人員」這件事只能由後端定義。
  // 前端一旦補 role === 'admin' 的特判，兩邊的「誰是內部人員」就開始各自演化。
  test('requiresInternal 分支不得自己補 role 特判', () => {
    expect(internalBranch).not.toBeNull();
    expect(stripComments(internalBranch[0])).not.toMatch(/\brole\b/);
  });
});

// 按鈕標籤的屬性順序不固定（v-if 有時在 @click 前、有時在後），
// 所以從 callsite 往回找最近的 <button 再切到 '>'，而不是寫一條涵蓋所有順序的正則。
// callsite 一律連 @click=" 一起比對：同名的 method 定義在檔案裡更早的位置，
// 只找函式名會抓到宣告那一行，往回找 <button 就跑到八竿子打不著的另一顆按鈕上。
const buttonWith = (src, needle) => {
  const at = src.indexOf(needle);
  if (at < 0) return null;
  const open = src.lastIndexOf('<button', at);
  const close = src.indexOf('>', at);
  return open < 0 || close < 0 ? null : src.slice(open, close + 1);
};

describe('ui-next 外殼：受限入口都帶著條件（不是裸露的）', () => {
  const toolsMenu = (() => {
    const start = SHELL.indexOf('ref="toolsMenu"');
    // 結尾切在「更多工具」那顆觸發鈕之前，否則會把它也算成選單項目。
    const end = SHELL.indexOf('<button ref="toolsTrigger"', start);
    return start < 0 || end < 0 ? '' : SHELL.slice(start, end);
  })();

  // 這裡刻意用「剛好幾顆」而不是「至少幾顆」：選單多一顆就是多一個入口，
  // 必須有人親手決定它要不要條件。數字對不上時不要直接改數字——先回答新的那顆該給誰看。
  test('「更多工具」選單切得到，項目數量沒變', () => {
    expect(toolsMenu).not.toBe('');
    expect(toolsMenu.match(/<button[^>]*>/g) || []).toHaveLength(9);
  });

  // Task 1 之前這三顆是裸露的：一般使用者看得到、按下去必定 403。
  const TOOL_BUTTONS = [
    ['@click="go(\'/architecture\')"', 'v-if="isAdmin"'],
    ['@click="go(\'/pipeline-flow\')"', 'v-if="isAdmin"'],
    // 考試走公司功能開關，不是 isAdmin——見 app.js /exam-bank 的裁決註解。
    ['@click="go(\'/exam-run\')"', 'v-if="userStore.features.exam"'],
  ];

  test.each(TOOL_BUTTONS)('更多工具的 %s 帶著條件', (callsite, cond) => {
    const button = buttonWith(toolsMenu, callsite);
    expect(`${callsite}: ${button !== null}`).toBe(`${callsite}: true`);
    expect(`${callsite}: ${button.includes(cond)}`).toBe(`${callsite}: true`);
  });

  // 側欄（專案列 ⋮、任務列 ⋮、帳號選單）裡按下去會 403 的項目。
  // 條件各不相同是刻意的，不是還沒統一：
  //  - 上正式的判準是後端的 canReleaseProject（平台管理員 or 綁定勾了可上正式的公司管理員），
  //    光看 role 算不出來，掛 isAdmin 會把有權限的公司管理員也擋掉。
  //  - 公司帳號頁公司管理員與平台管理員都能進。
  const SIDEBAR_ITEMS = [
    ['@click="goProjectTab(project.id, \'repos\')"', 'v-if="isAdmin"'],
    ['@click="goProjectTab(project.id, \'db\')"', 'v-if="isAdmin"'],
    ['@click="goProjectTab(project.id, \'settings\')"', 'v-if="isAdmin"'],
    ['@click="openRelease(project.id)"', 'v-if="project.can_release"'],
    ['@click="downloadTaskZip(task)"', 'v-if="isAdmin && task.git_branch"'],
    ['@click="go(\'/company-users\')"', `v-if="userStore.role === 'company_admin' || isAdmin"`],
  ];

  test.each(SIDEBAR_ITEMS)('側欄的 %s 帶著條件', (callsite, cond) => {
    const button = buttonWith(SHELL, callsite);
    expect(`${callsite}: ${button !== null}`).toBe(`${callsite}: true`);
    expect(`${callsite}: ${button.includes(cond)}`).toBe(`${callsite}: true`);
  });

  // 清單式斷言只回答得了「清單上那幾顆有沒有條件」，回答不了「有人多加了一顆裸露的」。
  // 數量釘子補的就是這個洞：選單多一顆就是多一個入口，必須有人親手決定它要給誰看。
  // 數字對不上時不要直接改數字——先回答新的那一顆該不該掛條件。
  const MENUS = [
    ['專案列 ⋮', 'v-if="menuProjectId === project.id"', '</teleport>', 5],
    ['任務列 ⋮', 'v-if="menuTaskId === task.id"', '</teleport>', 5],
    ['帳號選單', 'ref="accountMenu"', '<button ref="accountTrigger"', 5],
  ];

  test.each(MENUS)('%s 的項目數量沒變', (name, from, to, count) => {
    const start = SHELL.indexOf(from);
    const end = SHELL.indexOf(to, start);
    expect(`${name}: ${start > -1 && end > start}`).toBe(`${name}: true`);
    expect(SHELL.slice(start, end).match(/<button[^>]*>/g) || []).toHaveLength(count);
  });

  // 登出沒清乾淨＝下一個人登入前畫面短暫沿用上一個使用者的管理員身分，
  // 而這正是所有 isAdmin 條件的資料來源。
  test('登出時把殼層自算的 isAdmin 也清掉', () => {
    const at = SHELL.indexOf('\n      logout() {');
    expect(at).toBeGreaterThan(-1);
    const logout = SHELL.slice(at, SHELL.indexOf('\n      },', at));
    expect(logout).toMatch(/this\.isAdmin\s*=\s*false/);
  });
});
