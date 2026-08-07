const fs = require('fs');
const path = require('path');
const { STATUS_LABELS } = require('../../public/js/status-labels.js');

const SRC = fs.readFileSync(
  path.join(__dirname, '../../public/js/views/PipelineFlow.js'), 'utf8'
);

// 這支測試守的是「流程圖上畫的關卡，真的存在於狀態機」。
//
// 失效方式不是報錯而是靜默誤導：流程圖的節點資料整包寫死在 view 裡，與後端狀態機沒有任何連結，
// 改了 pipeline 卻沒改這頁，圖照樣渲染、測試照樣全綠、console 一個錯都沒有——只是它從此開始騙人。
// 實際發生過：圖上把「先寫 E2E 考題」畫成 status: 'spec_tour' 的一關，但那不是任務狀態（它是
// branch_pending 內部的一步，spec_tour 只是 token 記帳用的 agentType），任務永遠不會停在那裡。
// 對一張「拿來對焦討論流程」的圖來說，講錯比沒有更糟。
//
// 解析原始碼而不是 require：這個檔是 window.X = Vue.defineComponent({...})，沒有 window 與 Vue
// 就載不起來，為了測試去補 stub 反而讓測試離真實載入路徑更遠。
// 語法錯誤在這個檔案的後果是整頁白畫面（Vue 元件根本註冊不上），而現有測試全是「讀原始碼字串」
// 的靜態比對，語法再爛也照樣通過。實際發生過：改路由邏輯時多了一個 `}`，測試全綠、頁面全白。
test('PipelineFlow.js 語法有效（語法錯＝整頁白畫面，靜態比對抓不到）', () => {
  const vm = require('vm');
  expect(() => new vm.Script(SRC, { filename: 'PipelineFlow.js' })).not.toThrow();
});

describe('流程圖節點對得上狀態機', () => {
  // status 只放真的任務狀態；Git 分支名與「不是狀態」的說明放 ref（view 內同名欄位分工）。
  const statusValues = [...SRC.matchAll(/^\s*status:\s*'([^']+)'/gm)].map((m) => m[1]);
  // 分診一格畫兩個入口狀態（reject_triage / resolve_triage），拆開逐一比對
  const declared = [...new Set(statusValues.flatMap((v) => v.split('/').map((s) => s.trim())))];

  test('解析到合理數量的 status（regex 失效時測試不得靜默通過）', () => {
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
});

// 版面用「泳道 × step」定位，兩個節點撞同一格會直接疊在一起（後畫的蓋住先畫的）。
// 條件式節點（spec tour、E2E）平常不渲染，撞格了要等某個開關被打開才看得見，所以一律全域檢查。
describe('流程圖版面不重疊', () => {
  const placed = [...SRC.matchAll(/track:\s*'(\w+)',\s*step:\s*(\d+)/g)]
    .map((m) => ({ track: m[1], step: Number(m[2]) }));

  test('解析到合理數量的節點（regex 失效時測試不得靜默通過）', () => {
    expect(placed.length).toBeGreaterThan(15);
  });

  test('同一泳道內沒有兩個節點共用同一 step', () => {
    const seen = new Map();
    const clashes = [];
    for (const { track, step } of placed) {
      const key = `${track}#${step}`;
      if (seen.has(key)) clashes.push(key);
      seen.set(key, true);
    }
    expect(clashes).toEqual([]);
  });

  test('每個節點的 track 都是已定義的泳道', () => {
    const trackBlock = SRC.match(/const PF_TRACKS = \[([\s\S]*?)\];/)[1];
    const trackIds = [...trackBlock.matchAll(/id:\s*'(\w+)'/g)].map((m) => m[1]);
    expect(trackIds.length).toBeGreaterThan(2);      // regex 失效防呆
    expect([...new Set(placed.map((p) => p.track))].filter((t) => !trackIds.includes(t))).toEqual([]);
  });
});
