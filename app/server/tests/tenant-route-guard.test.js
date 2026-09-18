/**
 * tenant-route-guard.test.js — 防止「以後新增的路由忘記加租戶檢查」（規格 §5.4）
 *
 * 這一支不測行為，測的是「每一支碰得到專案或任務的端點，都有人在把關」這個結構性事實。
 * 為什麼需要：忘記加檢查沒有任何徵狀——測試全綠、畫面正常，只是某家客戶看得到另一家的東西。
 * 走訪全樹而不是寫死檔名清單：寫死清單只涵蓋當初改到的那幾支，之後新增的檔案不會被掃到。
 *
 * 已知盲區（守衛看不見，不在本測試範圍內修）：
 * - PUT /api/tasks/:taskDbId/project 的專案 id 是從 request body 帶進來，不是路徑參數，
 *   路徑守衛看不到它；此端點已在前面的 Task 手動補上檢查，這裡只是記錄「守衛不是完整的網」。
 * - 路徑用變數組成（非 `${base}` 樣式）、router 掛在動態 prefix 下、或透過 wrapper function
 *   間接呼叫 loadProjectForActor 等，本掃描一律看不到。
 */
const fs = require('fs');
const path = require('path');

const serverDir = path.join(__dirname, '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  if (e.name === 'node_modules' || e.name === 'tests') return [];
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
});

// 身分由每次執行通行證決定，不是 req.actor——那是容器經閘道走的通道
const EXEMPT_PREFIXES = ['/ai/'];
const GUARDS = ['loadProjectForActor', 'loadTaskForActor', 'requirePlatformAdmin'];

// 取出一支 app.<method>('<path>', ...) 註冊，以及它到下一支註冊為止的原始碼
function collectRoutes(src) {
  const re = /app\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  const hits = [];
  let m;
  while ((m = re.exec(src))) hits.push({ method: m[1], routePath: m[3], at: m.index });
  return hits.map((h, i) => ({
    ...h,
    body: src.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : src.length),
  }));
}

const files = walk(serverDir);

test('掃到的 route 檔數量合理（走訪壞掉時這一支會先紅，而不是讓守衛靜默空轉）', () => {
  const routeFiles = files.filter(f => /app\.(get|post|put|patch|delete)\(/.test(fs.readFileSync(f, 'utf8')));
  expect(routeFiles.length).toBeGreaterThanOrEqual(10);
});

test('每一支碰得到專案或任務的端點都有租戶守衛', () => {
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    // wiki-routes 之類用 `${base}` 組路徑的，把 base 展開後再比對
    const baseMatch = src.match(/const base = ['"`]([^'"`]+)['"`]/);
    const base = baseMatch ? baseMatch[1] : '';
    for (const r of collectRoutes(src)) {
      const full = r.routePath.startsWith('$') || r.routePath.startsWith('/') ? r.routePath : base + r.routePath;
      const effective = r.routePath.includes('${base}') ? r.routePath.replace('${base}', base) : full;
      if (EXEMPT_PREFIXES.some(p => effective.startsWith(p))) continue;
      const touchesScoped = /\/api\/projects\/:/.test(effective) || /\/api\/tasks\/:/.test(effective);
      if (!touchesScoped) continue;
      if (!GUARDS.some(g => r.body.includes(g))) {
        offenders.push(`${path.relative(serverDir, file)} ${r.method.toUpperCase()} ${effective}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
