// 意圖：擋「字面路徑被更早註冊的參數路徑吃掉」。
//
// 2026-08-31 實際抓到：`GET /api/projects/env-summaries` 回 500
// （`invalid input syntax for type integer: "env-summaries"`）。
// 因為 index.js 先 registerProjectRoutes 再 registerEnvRoutes，而 project-routes
// 有一條 `/api/projects/:id`——Express 依註冊順序匹配，於是 `env-summaries`
// 被當成 id 塞進 SQL。
//
// 為什麼既有的 25 個 env-routes 測試沒抓到：那支測試只 `registerRoutes(expressApp)`
// 註冊 env-routes 一個檔，測試環境裡根本沒有那條競爭路由。
// **單檔測試綠 ≠ 真實 app 可用**——遮蔽只在多個 route 檔組起來時才出現。
//
// 前端對這個 API 是 `.catch(() => [])`，所以畫面上不報錯，只是專案下拉選項的
// 「測試環境／資料庫連線」狀態全部變成「狀態未知」。靜默失敗，沒人會發現。
//
// 判準：依 index.js 的真實註冊順序展開所有 GET 路徑，若某條字面路徑
// 在它之前已有同段數、同前綴、對應位置為參數的路徑，即為被遮蔽。
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');

// index.js 呼叫 registerXxxRoutes 的順序，就是 Express 的匹配順序。
function registrationOrder() {
  const index = fs.readFileSync(path.join(SERVER, 'index.js'), 'utf8');
  const requires = new Map();
  for (const m of index.matchAll(/const \{ registerRoutes: (\w+) \} = require\('\.\/([\w-]+)'\)/g)) {
    requires.set(m[1], m[2]);
  }
  const order = [];
  for (const m of index.matchAll(/^\s*(\w+)\(app[,)]/gm)) {
    const file = requires.get(m[1]);
    if (file && !order.includes(file)) order.push(file);
  }
  return order;
}

function routesOf(file) {
  const full = path.join(SERVER, `${file}.js`);
  if (!fs.existsSync(full)) return [];
  const src = fs.readFileSync(full, 'utf8');
  return [...src.matchAll(/app\.get\(\s*'([^']+)'/g)].map((m) => m[1]);
}

const isParam = (seg) => seg.startsWith(':');
// :id(\d+) 這種帶約束的參數不會吃掉非數字字面路徑，所以不算遮蔽來源
const isUnconstrainedParam = (seg) => isParam(seg) && !seg.includes('(');

const ordered = [];
for (const file of registrationOrder()) {
  for (const route of routesOf(file)) ordered.push({ file, route });
}

test('解析得到路由（index.js 或 route 檔寫法變動時不得靜默略過）', () => {
  expect(ordered.length).toBeGreaterThan(30);
  expect(ordered.some((r) => r.route === '/api/projects')).toBe(true);
  // 反向自驗：解析器真的看得到 env-summaries 這條，否則下面的檢查等於沒跑
  expect(ordered.some((r) => r.route === '/api/projects/env-summaries')).toBe(true);
});

test('沒有字面路徑被更早註冊的參數路徑遮蔽', () => {
  const shadowed = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const later = ordered[i].route.split('/');
    for (let j = 0; j < i; j += 1) {
      const earlier = ordered[j].route.split('/');
      if (earlier.length !== later.length) continue;
      let blocking = null;
      let ok = true;
      for (let k = 0; k < later.length; k += 1) {
        if (earlier[k] === later[k]) continue;
        // 後者是字面、前者是無約束參數 → 前者會先吃掉它
        if (isUnconstrainedParam(earlier[k]) && !isParam(later[k])) {
          if (blocking) { ok = false; break; }
          blocking = { at: k, seg: later[k] };
          continue;
        }
        ok = false;
        break;
      }
      if (ok && blocking) {
        shadowed.push(
          `${ordered[i].route}（${ordered[i].file}）被 ${ordered[j].route}（${ordered[j].file}）遮蔽`,
        );
      }
    }
  }

  const hint = shadowed.length
    ? `\n\n【有路徑永遠到不了它的 handler】\n  ${shadowed.join('\n  ')}\n\n`
      + 'Express 依註冊順序匹配。修法二選一：\n'
      + '  (a) 給前面那條參數加約束，例如 :id(\\d+)——專案／任務 id 都是整數，這是首選；\n'
      + '  (b) 調整 index.js 的 register 順序讓字面路徑先註冊（脆弱，之後再加一條又會撞）。\n'
      + '注意：單獨測某個 route 檔不會重現這個問題，遮蔽只在多檔組起來時出現。\n'
    : '';
  expect(shadowed.length === 0 ? '無遮蔽' : `有遮蔽${hint}`).toBe('無遮蔽');
});
