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
const ADMIN_USERS = fs.readFileSync(path.join(pub, 'js', 'ui-next', 'pages', 'AdminUsers.js'), 'utf8');
const PROJECT_LIST = fs.readFileSync(path.join(pub, 'js', 'ui-next', 'pages', 'ProjectList.js'), 'utf8');
const PROJECT_DETAIL = fs.readFileSync(path.join(pub, 'js', 'ui-next', 'pages', 'ProjectDetail.js'), 'utf8');
const LOGIN = fs.readFileSync(path.join(pub, 'js', 'ui-next', 'pages', 'Login.js'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(pub, 'js', 'ui-next', 'pages', 'Settings.js'), 'utf8');
const STORE = fs.readFileSync(path.join(pub, 'js', 'store.js'), 'utf8');

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

// frontend-admin-route-guard 只驗到 requiresAdmin 那一段（它原本的切片長度是寫死的 1200 字元，
// 而區塊實際有 1245 字元，最後一個分支的結尾根本不在它視野內；現已改成跟這裡同一個收尾錨點）。
// 這裡自己把 beforeEach 整段切乾淨，逐分支比對。
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
  // 2026-09-22：isAdmin 從 data 改成讀 UserStore.role 的 computed（真因見檔尾那個 describe），
  // 所以「清掉它」現在等於「清掉 role」。斷言跟著改到新的機制上——意圖一字未改，
  // 而且比原本更強：原本只保證 logout 指派了一次，現在保證的是那個旗標唯一的資料來源被清空。
  test('登出時把 isAdmin 的資料來源（UserStore.role）清掉', () => {
    const at = SHELL.indexOf('\n      logout() {');
    expect(at).toBeGreaterThan(-1);
    // 起點有釘、終點沒釘的話，method 的收尾縮排一改，indexOf 就回 -1，
    // slice(at, -1) 會一路切到檔尾而不是切出空字串——守衛會悄悄放大成「整個檔案裡
    // 有沒有 isAdmin = false」，那幾乎必然是綠的。兩端都要釘。
    const end = SHELL.indexOf('\n      },', at);
    expect(`logout 收尾錨點: ${end > at}`).toBe('logout 收尾錨點: true');
    const logout = SHELL.slice(at, end);
    expect(`logout 清 role: ${/window\.UserStore\.role\s*=\s*""/.test(logout)}`).toBe('logout 清 role: true');
  });
});

// ── 使用者管理頁：角色 ↔ 公司（Task 11）──────────────────────────────────
// 唯一權威是後端 lib/tenant-access.js 的 validateRoleCompany：
//   admin 必須「沒有公司」，user／company_admin 必須「有公司」。
// 前端只要漏送 company_id，平台管理員建一般使用者就是每按必 400——那正是 Task 11 之前的狀態，
// 而且它是一個「本來會動的畫面壞掉了」，不是少一個欄位。沒有 DOM 測試接得住，只能釘字面。
// 盲區同本檔開頭：這裡驗的是原始碼長什麼樣，不是瀏覽器真的送了什麼。
describe('使用者管理頁：建帳號與改角色都帶著公司', () => {
  // 掃描產生的清單一律自己先斷言筆數（本檔開頭的規矩）：切不到就不是綠燈，是守衛失效。
  const roleSelects = ADMIN_USERS.match(/<select v-model="[^"]*\.role"[\s\S]*?<\/select>/g) || [];

  test('兩個角色下拉都切得到（新增表單一個、變更角色視窗一個）', () => {
    expect(roleSelects).toHaveLength(2);
  });

  // 三個角色少列一個，客戶的第一位公司管理員就只能靠手寫 SQL 建出來。
  test.each([0, 1])('第 %i 個角色下拉剛好三個角色，且 company_admin 的字面與 CompanyUsers 一致', (i) => {
    expect(roleSelects[i].match(/<option value="(?:user|company_admin|admin)">/g) || []).toHaveLength(3);
    expect(roleSelects[i]).toContain('<option value="company_admin">公司管理員</option>');
  });

  test('建帳號：非平台管理員帶 company_id，平台管理員連這個鍵都不帶', () => {
    const addUser = ADMIN_USERS.slice(ADMIN_USERS.indexOf('async addUser()'), ADMIN_USERS.indexOf('openRoleEdit(user)'));
    expect(addUser.length).toBeGreaterThan(200);
    expect(addUser).toMatch(/role !== 'admin'/);
    expect(addUser).toMatch(/payload\.company_id\s*=\s*company_id/);
  });

  test('改角色：company_id 這個鍵一定送出，改成平台管理員時送 null', () => {
    const submit = ADMIN_USERS.slice(ADMIN_USERS.indexOf('async submitRoleEdit()'), ADMIN_USERS.indexOf('async toggleActive(user)'));
    expect(submit.length).toBeGreaterThan(200);
    expect(submit).toMatch(/company_id:\s*role === 'admin' \? null :/);
  });

  test('公司清單沿用公司管理頁的端點，沒有自己發明一個', () => {
    expect(ADMIN_USERS).toMatch(/Api\.get\('admin\/companies'\)/);
  });

  // I7：自助註冊已關閉，approved=false 只剩「被公司管理員停用」一個意思。
  // 註解要先剝掉——檔裡的註解本身就在講「不要再說待審核」，字面掃描會被它誤判。
  test('畫面上不得再出現「待審核」，也不得把重新啟用說成「核准」', () => {
    const code = ADMIN_USERS.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/.*$/gm, '');
    expect(code.length).toBeGreaterThan(4000);
    expect(code).not.toMatch(/待審核/);
    expect(code).not.toMatch(/核准/);
    expect(code).toMatch(/已停用/);
  });
});

// ── Task 12：三個「後端本來就會拒、前端還看得見」的入口 ─────────────────────
// 規則來源 .claude/rules/frontend.md 38：受限入口要 nav 的 v-if ＋ router guard ＋ 後端 403 三層，
// 缺一都是破口。這三處的第 3 層本來就有（requirePlatformAdmin／固定 403），缺的是第 1 層。
// 三處的條件刻意都沿用各頁既有的 isAdmin()（window.UserStore.role === "admin"），
// 與外殼側欄的 v-if="isAdmin" 同一套判準——這個子專案的全支審查點名過「同一件事有兩種寫法」。
// 盲區同本檔開頭：驗的是原始碼字面，不是瀏覽器真的藏了。

describe('專案清單：建專案入口是平台管理員限定', () => {
  // 掃描清單一律先釘筆數（本檔開頭的規矩）。主色按鈕多一顆就是多一個主要動作，
  // 必須有人親手決定它該給誰看。數字對不上時不要直接改數字——先回答新的那一顆會不會被後端 403。
  const primaryButtons = PROJECT_LIST.match(/<button[^>]*class="ui-next-primary"[^>]*>/g) || [];

  test('主色按鈕剛好兩顆（右上「新增專案」＋表單裡「建立專案」）', () => {
    expect(primaryButtons).toHaveLength(2);
  });

  // POST /api/projects 掛 requirePlatformAdmin（project-routes.js）。Task 12 之前這顆是裸的：
  // 一般使用者看得到主色按鈕、把整張表單填完，按下去才 403。
  test('「新增專案」帶著 isAdmin() 條件', () => {
    const button = buttonWith(PROJECT_LIST, '@click="openAddForm"');
    expect(`新增專案: ${button !== null}`).toBe('新增專案: true');
    expect(`新增專案: ${button.includes('v-if="isAdmin() && !showAddForm"')}`).toBe('新增專案: true');
  });

  // 條件的來源壞掉本檔看不出來（開頭盲區 B2），但「換了一個自己發明的來源」看得出來。
  test('isAdmin() 問的是 UserStore.role', () => {
    expect(`ProjectList.isAdmin: ${/isAdmin\(\)\s*\{\s*return window\.UserStore\.role === "admin";\s*\}/.test(PROJECT_LIST)}`)
      .toBe('ProjectList.isAdmin: true');
  });
});

describe('專案頁「設定」分頁：整頁藏起來，不是只藏按鈕', () => {
  // 決定（Task 12）：整頁藏。設定分頁裡只有兩個區塊，兩個都是平台管理員限定的寫入端點
  //（基本資料 → PUT /api/projects/:id、同步來源對應 → PATCH /api/projects/:id/mapping），
  // 只藏按鈕會留下一張填得動、存不了的空殼表單——那比藏起來更像壞掉。
  // 專案名稱與備註本來就印在本頁標題上，藏掉這一頁不會少掉一般使用者看得到的資訊。
  const settings = (() => {
    const start = PROJECT_DETAIL.indexOf(`<section v-if="detailTab==='settings'`);
    const end = PROJECT_DETAIL.indexOf('<ReleaseModal', start);
    return start < 0 || end < 0 ? '' : PROJECT_DETAIL.slice(start, end);
  })();

  // 這條同時是筆數釘子與「整頁藏」這個決定的守衛：日後有人想改成「只藏按鈕」，
  // 會先在這裡看見兩顆儲存鈕都在同一個 section 裡；多出第三顆動作也會紅。
  test('設定區塊切得到，裡面剛好兩顆按鈕且都是儲存', () => {
    expect(`設定區塊: ${settings.length > 800}`).toBe('設定區塊: true');
    expect(settings.match(/<button[^>]*>/g) || []).toHaveLength(2);
    for (const call of ['@click="saveBasics"', '@click="saveProjectMapping"']) {
      expect(`${call}: ${settings.includes(call)}`).toBe(`${call}: true`);
    }
  });

  // 縱深防禦，比照同檔 embeddedTab 的做法：分頁列藏起來只是其中一條路徑。
  test('設定區塊本身也帶著 isAdmin()', () => {
    expect(`設定區塊: ${settings.startsWith(`<section v-if="detailTab==='settings' && isAdmin()"`)}`)
      .toBe('設定區塊: true');
  });

  // 字面陣列刻意維持完整、用 filter 拿掉不該顯示的（tour-isolation 從這裡數分頁 key），
  // 所以「總共幾個分頁」與「哪幾個是管理員限定」是兩個各自要守的事實。
  const tabKeys = (() => {
    const m = PROJECT_DETAIL.match(/const all = (\[\[[\s\S]*?\]\]);/);
    return m ? [...m[1].matchAll(/\["([a-z]+)"/g)].map((x) => x[1]) : [];
  })();

  test('分頁字面清單撈得到，七個一個不少', () => {
    expect(tabKeys).toEqual(['chat', 'settings', 'repos', 'db', 'env', 'wiki', 'deploy']);
  });

  test('settings 與 repos／db 同列，過濾條件問的是 isAdmin()', () => {
    const line = PROJECT_DETAIL.match(/if \(key === "repos".*$/m);
    expect(`過濾條件: ${line !== null}`).toBe('過濾條件: true');
    for (const key of ['repos', 'db', 'settings']) {
      expect(`${key}: ${line[0].includes(`key === "${key}"`)}`).toBe(`${key}: true`);
    }
    expect(`過濾條件: ${line[0].includes('this.isAdmin()')}`).toBe('過濾條件: true');
  });

  // data() 的初始猜值跑在 created() 之前。漏掉這裡，一般使用者用 ?tab=settings 的深連結進來
  // 會先看見一拍設定內容才被 selectTab() 打回 chat。
  test('data() 的初始猜值：管理員有 settings，一般使用者沒有', () => {
    const guess = PROJECT_DETAIL.match(/detailTab:\s*\(window\.UserStore\.role === "admin" \? (\[[^\]]*\]) : (\[[^\]]*\])\)/);
    expect(`初始猜值: ${guess !== null}`).toBe('初始猜值: true');
    expect(`管理員: ${guess[1].includes('"settings"')}`).toBe('管理員: true');
    expect(`一般使用者: ${guess[2].includes('"settings"')}`).toBe('一般使用者: false');
  });

  // 藏起來之後這條路徑照理走不到，但「條件寫錯了」與「沒有 catch」是兩件事：
  // 沒有 catch 時後端一拒絕就是沒人接的 promise rejection——畫面完全沒反應，
  // 使用者只會再按一次、再一次，然後認定平台壞了。形狀與同檔 saveBasics 一致。
  test('saveProjectMapping 有 catch，形狀與 saveBasics 一致', () => {
    const fn = PROJECT_DETAIL.slice(
      PROJECT_DETAIL.indexOf('async saveProjectMapping()'),
      PROJECT_DETAIL.indexOf('async saveE2eSetting()'),
    );
    expect(`saveProjectMapping: ${fn.length > 200}`).toBe('saveProjectMapping: true');
    expect(`saveProjectMapping: ${/catch \(error\) \{ showToast\(error\.message \|\| "儲存失敗", "error"\); \}/.test(fn)}`)
      .toBe('saveProjectMapping: true');
  });
});

describe('登入頁：自助註冊入口已移除（精靈程式碼刻意保留）', () => {
  // 註解要先剝掉：Task 12 在原處留下的註解本身就在講「入口已移除」並點名 startRegister，
  // 字面掃描會被它誤判成入口還在。
  const template = (() => {
    const start = LOGIN.indexOf('template: `');
    return start < 0 ? '' : LOGIN.slice(start).replace(/<!--[\s\S]*?-->/g, '');
  })();

  test('template 切得到（切不到的話下面幾條全是假綠）', () => {
    expect(`Login template: ${template.length > 2000}`).toBe('Login template: true');
    expect(`Login template: ${template.includes(`v-if="mode !== 'register'"`)}`).toBe('Login template: true');
  });

  // 筆數釘子：登入頁的文字連結就是這一頁的次要入口。多一顆＝多一條路，
  // 數字對不上時先回答新的那一顆會不會被後端拒絕，不要直接改數字。
  test('文字連結剛好兩顆（略過設定精靈、返回登入）', () => {
    expect(template.match(/<button[^>]*class="ui-next-login-link"[^>]*>/g) || []).toHaveLength(2);
  });

  // POST /api/auth/register 自 Task 8 起一律回固定 403（server/auth.js）。
  test('登入頁不得再有「註冊新帳號」入口', () => {
    expect(`註冊新帳號: ${template.includes('註冊新帳號')}`).toBe('註冊新帳號: false');
    expect(`startRegister callsite: ${template.includes('@click="startRegister"')}`).toBe('startRegister callsite: false');
  });

  // 3b 計畫「刻意不做」第 41 行：只隱藏入口。有人順手把五步精靈清掉的話這裡會紅——
  // 刪流程是另一個決定（要不要永久關掉自助註冊），要重開一次，不該夾在隱藏入口裡順手做掉。
  test('五步註冊精靈的程式碼仍在（只藏入口，沒刪流程）', () => {
    for (const marker of ['startRegister()', 'async registerAccount()', 'auth/register']) {
      expect(`${marker}: ${LOGIN.includes(marker)}`).toBe(`${marker}: true`);
    }
  });
});

// ── Task 13：三處「後端做完了、前端沒接」的破口 ─────────────────────────────
// 共通形狀：後端早就擋了／早就回了，但前端沒有任何一行讀它。這種洞不會以紅燈出現，
// 只會以「畫面說謊」出現——所以更需要釘住。盲區同本檔開頭（驗字面，不驗值）。

describe('身分旗標：每次導覽都重寫（表單登入不重新整理也要正確）', () => {
  const afterEachBlock = (() => {
    const start = APP_JS.indexOf('router.afterEach');
    const end = APP_JS.indexOf('\n});', start);
    return start < 0 || end < 0 ? '' : APP_JS.slice(start, end + 4);
  })();

  // 切片失敗時下面每一條都會變成「什麼都沒比對到」的假綠。
  test('afterEach 整段切得到', () => {
    expect(afterEachBlock.length).toBeGreaterThan(600);
    expect(afterEachBlock.trimEnd().endsWith('});')).toBe(true);
    expect(`auth/me: ${afterEachBlock.includes('Api.get("auth/me")')}`).toBe('auth/me: true');
  });

  // I5：ui-next 外殼的 mounted() 是根元件、整場只掛載一次。這六個旗標若只有它在寫，
  // 表單登入（登出後或 token 過期後重登）不重新整理就會整場 session 停在預設值——
  // features 停在 {} ⇒ 內部同事的「ODOO認證輔助」入口被藏死，而且畫面上毫無徵狀。
  // role 當年就是為了同一個坑搬來 afterEach 的（app.js isAdmin 的註解寫著「免重新整理」）。
  // 有人把哪一條搬回 mounted 獨占時，這裡要紅。
  const STORE_WRITES = [
    ['role', 'me.role || ""'],
    ['isInternal', 'me.is_internal === true'],
    ['companyId', 'me.company_id ?? null'],
    ['companyName', 'me.company_name || ""'],
    ['features', 'me.features || {}'],
    ['companyUsable', 'me.company_usable !== false'],
  ];

  test.each(STORE_WRITES)('afterEach 從 auth/me 寫入 UserStore.%s', (field, expr) => {
    expect(`${field}: ${afterEachBlock.includes(`window.UserStore.${field} = ${expr}`)}`).toBe(`${field}: true`);
  });

  // 寫入與清除要成對：少清一個，token 過期被踢回登入頁的人畫面上還留著上一個帳號的公司與開關。
  const loginReset = (() => {
    const at = afterEachBlock.indexOf('if (to.path === "/login")');
    return at < 0 ? '' : afterEachBlock.slice(at);
  })();

  test('/login 分支切得到，六個旗標全部清回預設值', () => {
    expect(`/login 分支: ${loginReset.length > 200}`).toBe('/login 分支: true');
    const DEFAULTS = [['role', '""'], ['isInternal', 'false'], ['companyId', 'null'], ['companyName', '""'], ['features', '{}'], ['companyUsable', 'true']];
    expect(DEFAULTS).toHaveLength(STORE_WRITES.length);
    for (const [field, value] of DEFAULTS) {
      expect(`${field}: ${loginReset.includes(`window.UserStore.${field} = ${value}`)}`).toBe(`${field}: true`);
    }
  });

  // store.js 的註解：「新加的旗標一律只在這裡有一份」。欄位沒宣告在這裡＝下一個人找不到它。
  const userStoreBlock = (() => {
    const start = STORE.indexOf('window.UserStore = Vue.reactive({');
    const end = STORE.indexOf('});', start);
    return start < 0 || end < 0 ? '' : STORE.slice(start, end);
  })();

  test('store.js 宣告了這六個欄位', () => {
    expect(`UserStore 宣告: ${userStoreBlock.length > 100}`).toBe('UserStore 宣告: true');
    for (const [field] of STORE_WRITES) {
      expect(`${field}: ${new RegExp(`^\\s*${field}:`, 'm').test(userStoreBlock)}`).toBe(`${field}: true`);
    }
  });

  // 登出也是寫入點之一（外殼的 logout()），同樣要成對清乾淨。
  test('外殼 logout() 把六個旗標一起清掉', () => {
    const at = SHELL.indexOf('\n      logout() {');
    expect(`logout(): ${at > -1}`).toBe('logout(): true');
    const logout = SHELL.slice(at, SHELL.indexOf('\n      },', at));
    for (const [field] of STORE_WRITES) {
      expect(`${field}: ${logout.includes(`window.UserStore.${field} =`)}`).toBe(`${field}: true`);
    }
  });
});

describe('公司停用／過期：外殼講出原因，而不是變成壞掉的工作區', () => {
  // I4：後端 index.js 的公司不可用閘門對每一支 /api 回 403，白名單只有 GET /auth/me，
  // 註解寫明「前端要靠它顯示為什麼不能用，擋掉會變成一片空白而不是一句說明」。
  // Task 13 之前沒有任何一行讀 company_usable／companyUnusable：客戶登入得進來（login 不帶
  // Bearer，不受閘門管），然後外殼的 Promise.all 被 projects 的 403 打斷、整包被 catch 吃掉，
  // 結果是空側欄＋使用者名稱停在「使用者」＋每頁各自一句不相干的錯誤。
  const blocked = (() => {
    // 錨點是 <main>：這一層沿用登入頁的版面，而登入頁的根元素就是 <main class="ui-next-login"
    // data-ui="next">。整頁阻斷時它是畫面上唯一的內容，用 div 會讓這一頁沒有任何 landmark。
    const start = SHELL.indexOf('<main v-else-if="userStore.companyUsable === false"');
    const end = SHELL.indexOf('<div v-else class="ui-next-shell"', start);
    return start < 0 || end < 0 ? '' : SHELL.slice(start, end);
  })();

  test('阻斷畫面切得到（切不到的話下面幾條全是假綠）', () => {
    expect(`阻斷畫面: ${blocked.length > 300}`).toBe('阻斷畫面: true');
  });

  test('說得出原因，不是一句通用錯誤', () => {
    for (const marker of ['公司帳號已停用', 'userStore.companyName', 'role="alert"']) {
      expect(`${marker}: ${blocked.includes(marker)}`).toBe(`${marker}: true`);
    }
  });

  // 這一層蓋掉整個外殼（含側欄的帳號選單，登出平常掛在那裡），沒有登出就是把人鎖在
  // 一個走不出去的死畫面。筆數釘子：多一顆按鈕＝多一個入口，而這頁能用的動作只有登出一個。
  test('畫面上剛好一顆按鈕，而且是登出', () => {
    const buttons = blocked.match(/<button[^>]*>/g) || [];
    expect(buttons).toHaveLength(1);
    // 斷言掛在「那一顆」按鈕的標籤上，不是「這段裡某處有 @click="logout"」——
    // 後者在 handler 被搬到 <a> 而按鈕換成別的東西時照樣綠。
    expect(`登出: ${buttons[0].includes('@click="logout"')}`).toBe('登出: true');
  });

  // ui-next.css 有一條 [data-ui="next"].ui-next-login 的覆寫，box-sizing:border-box 與
  // min-height:100dvh 都在那條裡。只抄 class 不抄屬性，base 規則的 padding:24px 會加在
  // 100vh 之外而多出一條捲軸，手機上還會被網址列吃掉一截——看起來像版面壞了。
  test('沿用登入頁版面就要連 data-ui="next" 一起沿用', () => {
    const tag = blocked.match(/<main[^>]*>/);
    expect(`阻斷層標籤: ${tag !== null}`).toBe('阻斷層標籤: true');
    expect(tag[0]).toContain('data-ui="next"');
  });

  // 條件的「值」本檔驗不到（開頭盲區 B2），但「來源被換掉」驗得到。
  test('旗標來源是 auth/me 的 company_usable，不是前端自己猜的', () => {
    expect(`company_usable: ${APP_JS.includes('me.company_usable !== false')}`).toBe('company_usable: true');
  });

  // 配色硬規則（platformDev skill）：這一層只能吃 CSS 變數，寫死淺色底在深色模式會變隱形字。
  // 版面刻意沿用登入頁那組 class，所以這裡不該出現任何自備色碼。
  test('沒有寫死色碼，版面沿用登入頁既有 class', () => {
    expect(`色碼: ${/#[0-9a-fA-F]{3,8}\b/.test(blocked)}`).toBe('色碼: false');
    expect(`ui-next-login-card: ${blocked.includes('ui-next-login-card')}`).toBe('ui-next-login-card: true');
  });
});

describe('個人設定「連線設定」：Odoo／eService 憑證區走 odoo_sync 功能開關', () => {
  const template = (() => {
    const start = SETTINGS.indexOf('template: `');
    return start < 0 ? '' : SETTINGS.slice(start);
  })();

  // 掃描清單先釘筆數（本檔開頭的規矩）。區塊多一塊＝連線設定分頁多一組欄位，
  // 必須有人親手決定它要給誰看。數字對不上時不要直接改數字。
  const sections = template.match(/<section v-(?:if|show)="[^"]*"[^>]*>/g) || [];

  test('template 切得到，條件區塊剛好六塊', () => {
    expect(`Settings template: ${template.length > 3000}`).toBe('Settings template: true');
    expect(sections).toHaveLength(6);
  });

  const sectionTagOf = (heading) => {
    const at = template.indexOf(heading);
    if (at < 0) return null;
    const open = template.lastIndexOf('<section', at);
    const close = template.indexOf('>', open);
    return open < 0 || close < 0 ? null : template.slice(open, close + 1);
  };

  // I3（規格 §8 P2）：後端三道都擋了——GET 濾掉憑證欄（settings.js:60-71）、
  // PUT 只收 theme／saved_views／teams_user_id 白名單（:17、:79-108）、
  // 兩支驗證端點掛 requireFeature('odoo_sync')（:182、:213）直接回 404。
  // 前端不擋的話，客戶看到的是一份填得動、按「驗證」跳「找不到這個功能」、
  // 按「儲存」卻回報「設定已儲存」的表單——畫面確認了一件沒發生的事。
  test('外部系統連線區塊帶著 odoo_sync 條件', () => {
    const tag = sectionTagOf('<h2>外部系統連線</h2>');
    expect(`外部系統連線: ${tag !== null}`).toBe('外部系統連線: true');
    expect(`外部系統連線: ${tag}`)
      .toBe(`外部系統連線: <section v-if="tab==='connection' && userStore.features.odoo_sync" class="ui-next-panel ui-next-settings-wide">`);
  });

  // GitHub PAT 是個人 GIT 憑證，與 odoo_sync 無關，每個角色都要用（沒設定任務會被擋下）。
  // 一起藏掉＝把客戶鎖在「任務永遠推不上去、又找不到能設定的地方」。反向釘死。
  test('GitHub PAT 與 Teams 兩塊不得被一起藏掉', () => {
    for (const heading of ['<h2>GitHub 認證</h2>', '<h2>Teams 通知</h2>']) {
      const tag = sectionTagOf(heading);
      expect(`${heading}: ${tag !== null}`).toBe(`${heading}: true`);
      expect(`${heading}: ${tag.includes('odoo_sync')}`).toBe(`${heading}: false`);
      expect(`${heading}: ${tag.includes(`v-show="tab==='connection'"`)}`).toBe(`${heading}: true`);
    }
  });

  // 藏起來還不夠：Teams 那塊共用同一個 save()，不排除 creds 的話照樣會送出一份
  // 後端註定丟掉的內容，然後回報「設定已儲存」。
  test('save() 在沒有 odoo_sync 時不送憑證鍵', () => {
    const save = SETTINGS.slice(SETTINGS.indexOf('async save()'), SETTINGS.indexOf('async savePw()'));
    expect(`save(): ${save.length > 200}`).toBe('save(): true');
    expect(`save(): ${save.includes('...(this.userStore.features.odoo_sync ? this.creds : {})')}`).toBe('save(): true');
  });

  // 旗標來源與外殼的 features.exam 同一套（window.UserStore）。這頁自己在 load() 裡打過
  // auth/me，從那份回應另存一份 features 也會動——但那就是同一件事的第二個來源。
  test('旗標來源是 UserStore，沒有自己另存一份', () => {
    expect(`Settings.userStore: ${/userStore\(\)\s*\{\s*return window\.UserStore;\s*\}/.test(SETTINGS)}`)
      .toBe('Settings.userStore: true');
  });
});

// 2026-09-22 正式環境實測踩到：kingsmvp2 是 role='admin'，登入後所有管理員功能全部消失。
// 真因是外殼的 isAdmin 曾是 data，只在 mounted() 指派一次，而 mounted() 未登入時直接 return、
// 外殼又是一次性掛載的根元件——從登入頁用表單登入且沒重新整理，它整場停在 false。
// 這個坑 role 在 app.js 踩過一次（見 app.js 的 afterEach），3b 把大部分管理員入口都掛到
// 這個旗標上之後，原本只影響少數項目的潛伏問題放大成「管理員功能全滅」。
describe('外殼的 isAdmin 必須是讀 UserStore 的 computed，不能是自存一份的 data', () => {
  test('外殼原始碼讀得到（讀不到的話下面幾條全是假綠）', () => {
    expect(`UiNextApp: ${SHELL.length > 20000}`).toBe('UiNextApp: true');
  });

  test('isAdmin 是 computed，判斷式與 app.js 逐字相同', () => {
    const fn = SHELL.match(/isAdmin\(\)\s*\{\s*return window\.UserStore\.role === "admin";\s*\}/);
    expect(`isAdmin computed: ${fn !== null}`).toBe('isAdmin computed: true');
  });

  // 反向釘住真因本身：只要它回到 data 或在任何地方被指派，就是同一個 bug 又長回來了。
  test('isAdmin 不得是 data，也不得被指派', () => {
    expect(`data 欄位: ${/\n\s*isAdmin:\s*(false|true)\s*,/.test(SHELL)}`).toBe('data 欄位: false');
    expect(`被指派: ${/this\.isAdmin\s*=/.test(SHELL)}`).toBe('被指派: false');
  });
});
