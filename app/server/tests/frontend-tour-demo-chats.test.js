// 意圖：教學示範專案的 id 是字串 'demo'（tour-demo.js 的 ID）。任何拿它去打真 API 的路徑，
// 後端都會用它比對 integer 的 project_id 而回 500——實測 SQL 直接噴
// `invalid input syntax for type integer: "demo"`。
// 使用者看到的症狀是：一進 /projects/demo 的課，右上角就跳「無法載入專案對話」。
//
// TourDemo.chats() 這份假資料一直都在，漏的是接線。tour-isolation.test.js 只掃舊的 js/views/*，
// UI Next 轉正式之後那份清單就守不到現在真正在跑的畫面了，所以這支直接把 method 切出來跑，
// 斷言「demo 時一次 API 都不許打」——字串掃描擋不住「有 TourDemo 但漏接某一條路徑」。
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '../../public/js');

// 這兩支都是瀏覽器腳本（掛全域、無 module.exports），只把 methods 物件切出來跑。
// 用「要測的 method 名」反查它所在的 methods 區塊，不用字元位移或行號——一個檔案裡有好幾個
// 元件各自帶 methods，寫死位移會靜默切到別的元件（症狀是 method 不存在，看起來像功能被刪了）。
function loadMethods(file, anchor, deps) {
  const src = fs.readFileSync(path.join(PUB, file), 'utf8').replace(/\r\n/g, '\n');
  // 找的是「定義」不是「呼叫」：同名的呼叫常出現在 watch／created 裡（比 methods 還早），
  // 拿它去 lastIndexOf('methods: {') 會回 -1，錯得像是這個檔沒有 methods。
  const at = src.search(new RegExp(`\\n\\s+(async\\s+)?${anchor}\\s*\\(`));
  expect(at).toBeGreaterThan(-1);
  const from = src.lastIndexOf('    methods: {', at);
  const to = src.indexOf('\n    },\n    template:', at);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const body = src.slice(src.indexOf('{', from), to + '\n    }'.length);
  const names = Object.keys(deps);
  return new Function(...names, `return (${body});`)(...names.map(n => deps[n]));
}

const BASE_DEPS = { showToast: () => {}, Vue: {}, confirmDialog: async () => true };

// 打了任何一次就記下來——斷言的是「一次都沒打」，不是「打了但被 catch 掉」。
function makeApi() {
  const calls = [];
  const rec = (m) => (p) => { calls.push(`${m} ${p}`); return Promise.reject(new Error('500')); };
  return { calls, Api: { get: rec('get'), post: rec('post'), delete: rec('delete') } };
}

const TOUR_DEMO = {
  active: true,
  ID: 'demo',
  isProject(id) { return this.active && String(id) === this.ID; },
  chats() { return [{ id: 'demo', title: '維修單備註填不了', unread: 0 }]; },
};

describe('側欄（UiNextApp.loadProjectChats）', () => {
  function vmFor(win, api) {
    const methods = loadMethods('ui-next/UiNextApp.js', 'loadProjectChats',
      { ...BASE_DEPS, Api: api.Api, window: win });
    return Object.assign({ projectChats: {} }, methods);
  }

  test('demo 專案 → 用假資料，一次 API 都不打', async () => {
    const api = makeApi();
    const vm = vmFor({ TourDemo: TOUR_DEMO }, api);
    await vm.loadProjectChats('demo');
    expect(api.calls).toEqual([]);
    expect(vm.projectChats.demo).toHaveLength(1);
  });

  test('真專案 → 照常打 API（守衛不能寬到把真的也攔掉）', async () => {
    const api = makeApi();
    const vm = vmFor({ TourDemo: TOUR_DEMO }, api);
    await vm.loadProjectChats(16);
    expect(api.calls).toEqual(['get projects/16/chats']);
  });

  test('教學沒開著時，連 demo 這個 id 也走真 API（active=false 不得接管）', async () => {
    const api = makeApi();
    const vm = vmFor({ TourDemo: { ...TOUR_DEMO, active: false } }, api);
    await vm.loadProjectChats('demo');
    expect(api.calls).toEqual(['get projects/demo/chats']);
  });

  test('tour-demo.js 沒載入時不得 ReferenceError（整支可刪）', async () => {
    const api = makeApi();
    const vm = vmFor({}, api);
    await expect(vm.loadProjectChats('demo')).resolves.toBeUndefined();
    expect(api.calls).toEqual(['get projects/demo/chats']);
  });
});

describe('專案頁對話分頁（ProjectDetail.loadChats）', () => {
  function vmFor(win, api) {
    const methods = loadMethods('ui-next/pages/ProjectDetail.js', 'loadChats',
      { ...BASE_DEPS, Api: api.Api, window: win });
    return Object.assign({
      chats: [], chatsLoading: false, chatsError: '',
      $route: { params: { id: 'demo' } },
    }, methods);
  }

  test('demo 專案 → 用假資料，不打 API，也不留 loading 轉圈', async () => {
    const api = makeApi();
    const vm = vmFor({ TourDemo: TOUR_DEMO }, api);
    await vm.loadChats();
    expect(api.calls).toEqual([]);
    expect(vm.chats).toHaveLength(1);
    expect(vm.chatsLoading).toBe(false);
    expect(vm.chatsError).toBe('');
  });

  test('真專案 → 照常打 API', async () => {
    const api = makeApi();
    const vm = vmFor({ TourDemo: TOUR_DEMO }, api);
    vm.$route.params.id = '16';
    await vm.loadChats();
    expect(api.calls).toEqual(['get projects/16/chats']);
  });
});
