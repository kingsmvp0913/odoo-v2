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
