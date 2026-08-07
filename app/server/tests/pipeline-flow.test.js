const fs = require('fs');
const path = require('path');
const { STATUS_LABELS } = require('../../public/js/status-labels.js');
const {
  PF_TRACKS, PF_UNDRAWN_STATUSES, pipelineTracks, pipelineNodes, pipelineEdges
} = require('../../public/js/pipeline-spec.js');

// 這支測試守的是「流程圖上畫的關卡，真的存在於狀態機」，兩個方向都要守。
//
// 失效方式不是報錯而是靜默誤導：流程內容（pipeline-spec.js）與真正在跑的狀態機
// （server/pipeline/*）沒有任何程式上的連結，改了 pipeline 卻沒改 spec，圖照樣渲染、
// 測試照樣全綠、console 一個錯都沒有——只是它從此開始騙人。
// 實際發生過：圖上把「先寫 E2E 考題」畫成 status: 'spec_tour' 的一關，但那不是任務狀態
// （它是 branch_pending 內部的一步，spec_tour 只是 token 記帳用的 agentType），任務永遠
// 不會停在那裡。對一張「拿來對焦討論流程」的圖來說，講錯比沒有更糟。
//
// 三個開關會實際增刪節點與連線，所以結構檢查一律跑遍全部八種組合，不是只驗預設值。
const COMBOS = [];
for (let m = 0; m < 8; m++) {
  COMBOS.push({ e2eEnabled: !!(m & 1), specTour: !!(m & 2), showGit: !!(m & 4) });
}
const label = (f) => `e2e=${f.e2eEnabled ? 1 : 0} tour=${f.specTour ? 1 : 0} git=${f.showGit ? 1 : 0}`;

// 一個節點可以在 status 裡並列兩個入口狀態（分診：reject_triage / resolve_triage）
const statusesOf = (n) => (n.status || '').split('/').map((s) => s.trim()).filter(Boolean);
const drawnStatuses = () => new Set(
  COMBOS.flatMap((f) => pipelineNodes(f)).flatMap(statusesOf)
);

// 語法錯誤在 view 的後果是整頁白畫面（Vue 元件根本註冊不上），而純資料的 spec 由上面的
// require 本身就驗掉了。view 沒有 window／Vue 就載不起來，只能單獨驗語法。
// 實際發生過：改路由邏輯時多了一個 `}`，測試全綠、頁面全白。
test('PipelineFlow.js 語法有效（語法錯＝整頁白畫面，靜態比對抓不到）', () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/views/PipelineFlow.js'), 'utf8');
  expect(() => new vm.Script(src, { filename: 'PipelineFlow.js' })).not.toThrow();
});

// spec 是純資料檔，但 view 靠 <script> 全域載入——漏加 script tag 的症狀是整頁白畫面，
// 而 jest 這邊 require 得到、照樣全綠。
test('index.html 有載入 pipeline-spec.js 且排在 PipelineFlow.js 之前', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const spec = html.indexOf('js/pipeline-spec.js');
  const view = html.indexOf('js/views/PipelineFlow.js');
  expect(spec).toBeGreaterThan(-1);
  expect(view).toBeGreaterThan(-1);
  expect(spec).toBeLessThan(view);
});

describe('流程圖節點對得上狀態機', () => {
  const declared = [...drawnStatuses()];

  test('解析到合理數量的 status（spec 壞掉時測試不得靜默通過）', () => {
    expect(declared.length).toBeGreaterThan(12);
  });

  test.each(declared)('%s 是真的任務狀態', (key) => {
    expect(STATUS_LABELS[key]).toBeDefined();
  });

  // 反向：後端會停下來等人的狀態，圖上必須畫得到——這幾個正是「使用者卡住時想在圖上找的那一格」。
  // 缺了不會有任何訊號，只有人看著圖說「那我現在這張任務在哪裡？」時才會發現。
  test('NEEDS_ACTION 狀態全部有畫在圖上', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../tasks-routes.js'), 'utf8');
    const block = routes.match(/const NEEDS_ACTION_STATUSES = \[([^\]]+)\]/)[1];
    const needsAction = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(needsAction.length).toBeGreaterThan(5);   // regex 失效防呆
    expect(needsAction.filter((s) => !declared.includes(s))).toEqual([]);
  });

  // 最重要的一條：runner 那邊實際會寫進 tasks.status 的每一個狀態，圖上都要找得到。
  // 只驗「圖上畫的存在於狀態機」是不夠的——那只擋得住畫錯，擋不住**漏畫**。新增一關而沒更新
  // spec，圖會安靜地少一格，而這正是「以流程圖為準」最致命的失效方式。
  // 過渡態（答完就走、不會停在那裡）不畫，但必須在 PF_UNDRAWN_STATUSES 具名並寫理由。
  test('runner 會設定的任務狀態，圖上都畫得到（或已具名列為過渡態）', () => {
    const dir = path.join(__dirname, '../pipeline');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f))
      .concat([path.join(__dirname, '../pipeline-routes.js'), path.join(__dirname, '../tasks-routes.js')]);
    const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    // 只認得出 tasks.status 的賦值形式；撈到的雜訊（clone_status／env status 等）用
    // STATUS_LABELS 過濾掉——那份表就是「什麼算任務狀態」的定義。
    const found = [...new Set([...src.matchAll(/status\s*=\s*'([a-z_]+)'/g)].map((m) => m[1]))]
      .filter((s) => STATUS_LABELS[s]);
    expect(found.length).toBeGreaterThan(15);        // regex 失效防呆
    const undrawn = new Set(PF_UNDRAWN_STATUSES.map(([s]) => s));
    const missing = found.filter((s) => !declared.includes(s) && !undrawn.has(s));
    expect(missing).toEqual([]);
  });

  test('PF_UNDRAWN_STATUSES 每一筆都是真狀態，且真的沒畫（避免名單長霉）', () => {
    for (const [s, why] of PF_UNDRAWN_STATUSES) {
      expect(STATUS_LABELS[s]).toBeDefined();
      expect(declared).not.toContain(s);
      expect(String(why).length).toBeGreaterThan(5);   // 一定要寫理由
    }
  });
});

// 版面用「泳道 × step」定位，兩個節點撞同一格會直接疊在一起（後畫的蓋住先畫的）。
// 條件式節點（spec tour、E2E）平常不渲染，撞格了要等某個開關被打開才看得見，所以逐組合檢查。
describe('流程圖結構完整（八種開關組合）', () => {
  test('解析到合理數量的節點（spec 壞掉時測試不得靜默通過）', () => {
    expect(pipelineNodes({ e2eEnabled: true, specTour: true, showGit: true }).length).toBeGreaterThan(15);
    expect(PF_TRACKS.length).toBeGreaterThan(2);
  });

  test.each(COMBOS.map((f) => [label(f), f]))('%s：同一泳道內沒有兩個節點共用同一 step', (_, f) => {
    const seen = new Set(), clashes = [];
    for (const n of pipelineNodes(f)) {
      const key = `${n.track}#${n.step}`;
      if (seen.has(key)) clashes.push(key);
      seen.add(key);
    }
    expect(clashes).toEqual([]);
  });

  test.each(COMBOS.map((f) => [label(f), f]))('%s：節點 id 不重複', (_, f) => {
    const ids = pipelineNodes(f).map((n) => n.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test.each(COMBOS.map((f) => [label(f), f]))('%s：每個節點的 track 都是當下顯示中的泳道', (_, f) => {
    const shown = pipelineTracks(f).map((t) => t.id);
    expect([...new Set(pipelineNodes(f).map((n) => n.track))].filter((t) => !shown.includes(t))).toEqual([]);
  });

  // 連線指到不存在的節點不會報錯，只會靜默不畫——關掉某個開關後少一條線，肉眼很難發現。
  test.each(COMBOS.map((f) => [label(f), f]))('%s：每條連線的兩端都存在', (_, f) => {
    const ids = new Set(pipelineNodes(f).map((n) => n.id));
    expect(pipelineEdges(f).filter(([a, b]) => !ids.has(a) || !ids.has(b))).toEqual([]);
  });

  // 孤兒節點＝畫了一個框卻沒有任何線連到它，通常是改流程時只刪了線忘了刪節點。
  test.each(COMBOS.map((f) => [label(f), f]))('%s：沒有連不到任何線的孤兒節點', (_, f) => {
    const touched = new Set(pipelineEdges(f).flatMap(([a, b]) => [a, b]));
    expect(pipelineNodes(f).map((n) => n.id).filter((id) => !touched.has(id))).toEqual([]);
  });

  // 每一格都要走得到。孤兒檢查只看「有沒有連到線」，擋不住「拿掉一條轉移，整段變成走不到的
  // 半島」——實測過：刪掉 更新 Wiki→完成 之後，兩個節點都還各自連著別的線，孤兒檢查照樣全綠。
  // 對一張要當流程依據的圖來說，走不到的格子跟畫錯一樣糟。
  // link 是 Git 對應線、不是轉移，所以當無向邊看待（Git 泳道就是靠它掛到主線上的）。
  test.each(COMBOS.map((f) => [label(f), f]))('%s：每個節點都從入口走得到', (_, f) => {
    const nodes = pipelineNodes(f);
    const entries = nodes.filter((n) => n.kind === 'start').map((n) => n.id);
    expect(entries.length).toBe(1);                  // 入口不只一個＝有獨立島，下面的檢查會失去意義
    const adj = {};
    const link = (a, b) => { (adj[a] = adj[a] || []).push(b); };
    for (const [a, b, kind] of pipelineEdges(f)) {
      link(a, b);
      if (kind === 'link') link(b, a);
    }
    const seen = new Set(entries), stack = [...entries];
    while (stack.length) for (const nx of adj[stack.pop()] || []) if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
    expect(nodes.map((n) => n.id).filter((id) => !seen.has(id))).toEqual([]);
  });

  test.each(COMBOS.map((f) => [label(f), f]))('%s：連線類型只有四種', (_, f) => {
    const bad = pipelineEdges(f).filter(([, , kind]) => !['main', 'alt', 'back', 'link'].includes(kind));
    expect(bad).toEqual([]);
  });

  // link 是 Git 對應線，不是流程轉移：它一定橫跨 git 泳道與別的泳道。畫錯邊會讓「這一關在
  // Git 上做了什麼」被讀成「流程會走到那裡」。
  test('link 線一定是 git 泳道連到別的泳道', () => {
    const f = { e2eEnabled: true, specTour: true, showGit: true };
    const byId = Object.fromEntries(pipelineNodes(f).map((n) => [n.id, n]));
    const links = pipelineEdges(f).filter(([, , k]) => k === 'link');
    expect(links.length).toBeGreaterThan(3);
    for (const [a, b] of links) {
      expect(byId[a].track).toBe('git');
      expect(byId[b].track).not.toBe('git');
    }
  });

  // detail 是這頁真正的價值（hover 才看得到的邏輯摘要），空的節點等於只畫了個框。
  test.each(COMBOS.map((f) => [label(f), f]))('%s：每個節點都有 detail 且每列是 [標題, 內容]', (_, f) => {
    for (const n of pipelineNodes(f)) {
      const rows = (n.detail || []).filter(Boolean);
      expect(rows.length).toBeGreaterThan(1);
      for (const r of rows) {
        expect(Array.isArray(r)).toBe(true);
        expect(r).toHaveLength(2);
        expect(String(r[1]).length).toBeGreaterThan(0);
      }
    }
  });

  // status 與 ref 分工：status 只放真狀態，其他一律 ref。混用就擋不住把不存在的狀態畫成一關。
  test.each(COMBOS.map((f) => [label(f), f]))('%s：每個節點至少有 status 或 ref 其中之一', (_, f) => {
    expect(pipelineNodes(f).filter((n) => !n.status && !n.ref).map((n) => n.id)).toEqual([]);
  });
});
