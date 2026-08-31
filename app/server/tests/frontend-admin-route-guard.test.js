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
  const ADMIN_ONLY_OUTSIDE = ['/token-report'];  // 用量報表含全平台成本，僅管理員可見

  test.each(ADMIN_ONLY_OUTSIDE)('%s 仍是 admin only', (p) => {
    const block = routeBlocks.find((r) => r.path === p);
    expect(block).toBeDefined();
    expect(`${p}: ${/requiresAdmin:\s*true/.test(block.body)}`).toBe(`${p}: true`);
  });
});

describe('沒有全域 admin gate（NEXT-P0-001 不得復辟）', () => {
  // guard 本體：從 router.beforeEach 到函式結尾。
  const guard = (() => {
    const start = APP_JS.indexOf('router.beforeEach');
    expect(start).toBeGreaterThan(-1);
    return APP_JS.slice(start, start + 1200);
  })();

  test('requiresAuth 的分支只驗登入，不碰 role', () => {
    // 抓 requiresAuth 那一段（到下一個 if 為止），裡面不該出現 role。
    const m = guard.match(/if\s*\([^)]*requiresAuth[^)]*\)[\s\S]*?(?=\n\s*if\s*\(|$)/);
    expect(m).not.toBeNull();
    expect(m[0]).not.toMatch(/\brole\b/);
  });

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
