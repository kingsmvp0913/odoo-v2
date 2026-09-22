/**
 * tenant-route-guard.test.js — 防止「以後新增的路由忘記加租戶檢查」（規格 §5.4）
 *
 * 這一支不測行為，測的是「每一支碰得到專案或任務的端點，都有人在把關」這個結構性事實。
 * 為什麼需要：忘記加檢查沒有任何徵狀——測試全綠、畫面正常，只是某家客戶看得到另一家的東西。
 * 走訪全樹而不是寫死檔名清單：寫死清單只涵蓋當初改到的那幾支，之後新增的檔案不會被掃到。
 *
 * 已知盲區（守衛看不見，不在本測試範圍內修）：
 * - PUT /api/tasks/:taskDbId/project 的路徑本身含 /api/tasks/:，掃得到、也判成 OK（它有呼叫
 *   loadProjectForActor）——守衛驗的只是「本文裡出現了守衛的名字」，不驗那個呼叫傳的是不是
 *   正確的 id。這支端點的專案 id 其實來自 request body（project_id）而非路徑參數，已在前面
 *   的 Task 手動核對過傳對值；但換一支新端點，若有人把守衛呼叫接錯變數，守衛依然是綠的。
 * - 路徑用「裸變數」組成（不是字串字面值，也不是 `${base}` 樣板字串）：wiki-routes.js 的
 *   GET /api/projects/:projectId/wiki（wiki-routes.js:22，清單）與同路徑的 POST（wiki-routes.js:81，
 *   新增）都寫成 app.get(base, ...)／app.post(base, ...)——regex 要求路徑引數緊接一個引號字元，
 *   這兩支連命中都沒有，不會出現在守衛的掃描結果裡（人工核對過兩支都有呼叫
 *   loadProjectForActor，不是安全缺口，純屬守衛視野死角）。
 * - router 掛在動態 prefix 下、或透過 wrapper function 間接呼叫 loadProjectForActor 等，
 *   本掃描同樣看不到。
 * - touchesScoped 只認路徑上的 `/api/projects/:` 與 `/api/tasks/:` 兩種字面樣式——一個專案
 *   範圍的資源若是用自己的 id 定址（路徑既不是 projects 也不是 tasks），或範圍其實是從
 *   request body 的 project_id 帶進來（路徑上完全看不出跟專案有關），一律不會進入 offenders
 *   的掃描對象，等於整支端點連「有沒有守衛」都沒被問過。這不是假設性風險：
 *   PUT /api/tasks/:taskDbId/project（project-routes.js:1129）真正需要的範圍檢查，查的是
 *   body 帶進來的目標 project_id，跟路徑上的 :taskDbId 完全無關——這支端點純屬路徑字面剛好
 *   撞上 `/api/tasks/:` 才被掃到，當初是靠人工讀 code 才抓到「換專案要重新驗權限」這個漏洞，
 *   不是這支守衛揪出來的。換一支路徑不巧沒撞上這兩種樣式、但範圍一樣藏在 body 裡的端點，
 *   本守衛會直接漏看，靜默通過。
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
  let scopedCount = 0; // 掃到幾支「沾到專案／任務」的端點——見下方獨立斷言的說明
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
      scopedCount++;
      if (!GUARDS.some(g => r.body.includes(g))) {
        offenders.push(`${path.relative(serverDir, file)} ${r.method.toUpperCase()} ${effective}`);
      }
    }
  }
  // offenders 是空陣列這件事，在「collectRoutes 的 regex 壞掉、什麼端點都掃不到」時一樣成立
  // （沒東西可掃＝沒有違規）——上面「掃到的 route 檔數量合理」那支測試用的是另一份獨立 regex，
  // 救不了這裡。直接釘住「掃到幾支沾到專案／任務的端點」這個數字：collectRoutes 的 regex 壞掉、
  // touchesScoped 的判斷式壞掉，都會讓這個數字塌陷，這條才會先紅。獨立量測全庫實際數字是 82
  // （母體 84，兩支 wiki bare-variable 路由是本檔已知盲區，見檔頭註解），地板抓略低於實測值。
  expect(scopedCount).toBeGreaterThanOrEqual(75);
  expect(offenders).toEqual([]);
});
