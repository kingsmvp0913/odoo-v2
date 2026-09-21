// 意圖：admin 專屬頁面的防線有三層（前端 nav v-if、router guard、後端 403），
// 這一支守的是中間那層——router guard 的 meta 旗標。
//
// 為什麼要獨立一支：NEXT-P0-001 的原始症狀是「Next 對所有 requiresAuth 路由額外檢查
// me.role !== 'admin'，非管理員被整批退回 Legacy」。那個全域 gate 已經拆掉了，
// 但既有測試擋的是 `window.location.replace(` 這個字串，並沒有逐 route 驗證旗標——
// 也就是說「某條 /admin 路由忘了掛 requiresAdmin」與「全域 gate 復辟」這兩種相反的錯，
// 現有防線一種都攔不到。
//
// 分辨兩者的關鍵：requiresAuth 只該問「登入了沒」，requiresAdmin 才問「是不是 admin」。
// guard 裡只要出現「requiresAuth 成立就查 role」的形狀，就是 P0-001 的復辟。
const fs = require('fs');
const path = require('path');

const APP_JS = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');

// routes 陣列裡每個物件以 path: "…" 開頭，切到下一個 path: 為止。
// 不用 JSON.parse／require：app.js 依賴 Vue、VueRouter 等全域，在 node 環境載不起來。
const routeBlocks = (() => {
  const marks = [...APP_JS.matchAll(/path:\s*["'`]([^"'`]+)["'`]/g)];
  return marks.map((m, i) => ({
    path: m[1],
    body: APP_JS.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : APP_JS.length),
  }));
})();

// 解析器失效時不得靜默通過。
test('解析得到路由（route 寫法改變時不得靜默略過）', () => {
  expect(routeBlocks.length).toBeGreaterThanOrEqual(20);
  expect(routeBlocks.some((r) => r.path === '/admin')).toBe(true);
});

describe('admin 專屬路由都掛了 requiresAdmin', () => {
  const adminRoutes = routeBlocks.filter((r) => r.path.startsWith('/admin'));

  test('/admin 底下的路由被掃到（不只有一條）', () => {
    expect(adminRoutes.length).toBeGreaterThanOrEqual(10);
  });

  test.each(adminRoutes.map((r) => r.path))('%s 有 requiresAdmin', (p) => {
    const block = adminRoutes.find((r) => r.path === p);
    expect(`${p}: ${/requiresAdmin:\s*true/.test(block.body)}`).toBe(`${p}: true`);
  });

  // requiresAdmin 不含「已登入」的語意，guard 是兩段獨立的 if。少了 requiresAuth，
  // 未登入的人會直接進到查 role 那段而不是被導去登入頁。
  test.each(adminRoutes.map((r) => r.path))('%s 同時有 requiresAuth', (p) => {
    const block = adminRoutes.find((r) => r.path === p);
    expect(`${p}: ${/requiresAuth:\s*true/.test(block.body)}`).toBe(`${p}: true`);
  });
});

// 不是 /admin 開頭、但只給管理員的頁面。放白名單管理而不是自動推導：
// 這種頁面每多一個都該有人明確想過「為什麼它是 admin only」。
describe('非 /admin 前綴的 admin-only 頁面', () => {
  const ADMIN_ONLY_OUTSIDE = [
    '/token-report',  // 用量報表含全平台成本，僅管理員可見
    '/companies',     // 公司管理（3b Task 8）：建立／停用客戶公司、設定 GIT 憑證，僅平台管理員可見
    '/architecture',  // 架構圖（3b Task 1）：平台內部實作細節
    '/pipeline-flow', // 流程圖（3b Task 1）：同上
    '/task/:id/terminal', // 終端機（3b Task 1）：能直接對任務所在容器下指令
  ];

  test.each(ADMIN_ONLY_OUTSIDE)('%s 仍是 admin only', (p) => {
    const block = routeBlocks.find((r) => r.path === p);
    expect(block).toBeDefined();
    expect(`${p}: ${/requiresAdmin:\s*true/.test(block.body)}`).toBe(`${p}: true`);
  });
});

describe('沒有全域 admin gate（NEXT-P0-001 不得復辟）', () => {
  // guard 本體：從 router.beforeEach 切到它自己的收尾 `\n});`。
  // 原本這裡寫死 `start + 1200`，而區塊當下實際是 1245 字元——最後 45 字元
  // （/company-users 分支的結尾）根本不在下面任何一條斷言的視野內。
  // 那不是「總有一天會截到」，是當下就已經截掉了。
  // 改用 frontend-tenant-guard.test.js 切同一個區塊的作法（收尾錨點），不另創第三種寫法。
  const guard = (() => {
    const start = APP_JS.indexOf('router.beforeEach');
    const end = APP_JS.indexOf('\n});', start);
    return start < 0 || end < 0 ? '' : APP_JS.slice(start, end + 4);
  })();

  // 切片失敗時整個 describe 會退化成「什麼都沒比對到」的假綠，所以先釘住切片本身。
  test('guard 整段切得到（切不到就不是綠燈，是守衛失效）', () => {
    expect(guard.length).toBeGreaterThan(400);
    expect(guard.trimEnd().endsWith('});')).toBe(true);
    // 寫死長度的年代，這一段是掉在視野外的；釘住它確保切片涵蓋到最後一個分支。
    expect(`/company-users 在切片內: ${guard.includes('/company-users')}`)
      .toBe('/company-users 在切片內: true');
  });

  test('requiresAuth 的分支只驗登入，不碰 role', () => {
    // 抓 requiresAuth 那一段（到下一個 if 為止），裡面不該出現 role。
    const m = guard.match(/if\s*\([^)]*requiresAuth[^)]*\)[\s\S]*?(?=\n\s*if\s*\(|$)/);
    expect(m).not.toBeNull();
    expect(m[0]).not.toMatch(/\brole\b/);
  });

  // ⚠ 這個標題比它實際驗到的東西大：下面的正則從 requiresAdmin 抓到該區塊自己的收尾大括號為止，
  // 驗的是「requiresAdmin 分支裡有 role」，不是「別的分支裡沒有 role」。
  // 後加的 requiresInternal 分支（不得出現 role）由 frontend-tenant-guard.test.js 驗，
  // 它把整段 beforeEach 切乾淨再逐分支比對。
  test('role 檢查只出現在 requiresAdmin 分支內', () => {
    const m = guard.match(/if\s*\([^)]*requiresAdmin[^)]*\)\s*\{[\s\S]*?\n\s{2}\}/);
    expect(m).not.toBeNull();
    expect(m[0]).toMatch(/\brole\b/);
  });

  // 被擋下時要停在站內的 403，而不是把網址改寫回 Legacy——後者正是 P0-001 的症狀，
  // 使用者看到的是網址無聲變了、頁面換了一套 UI，完全不知道發生什麼事。
  test('無權限時導向站內 403，不改寫 window.location', () => {
    expect(guard).toMatch(/forbidden/);
    expect(guard).not.toMatch(/window\.location\.(replace|href|assign)/);
  });
});
