// 意圖：任務對話按下送出後，畫面要停在最新訊息，不能跳回最上面的舊留言。
// 使用者原話（2026-09-10）：「按下送出的時候有時候會跳到留言最上方，然後我要再一直往下滾到最新留言」。
// 2026-09-11 真瀏覽器（任務 243，.ui-next-main）實測兩個成因：
//   ① 退回／審核通過／規格修改意見／客服追問／中斷處理…這些送出鈕送完呼叫 load()，load 會把 loading
//      切 true＝整個內容區換成「載入任務中…」再重建，瀏覽器把捲軸歸零 → 送出前在最底，送出後 scrollTop=0。
//      同頁「回答 AI 問題」走的是 refresh()＋釘住，同一個量法送完仍在最底——那就是正確寫法。
//   ② 捲在對話中段按「送出留言」：釘住旗標是 false，重抓留言後的貼底整個跳過，停在中段不跟到最新。
// 刻意沒有動「算不算在底部」的門檻，也沒加連續多幀貼底：實測沒有需要，且 2026-09-10 自動修正版本就是
// 因為那兩手會在使用者往上看舊訊息時搶走畫面而被審核退回兩次。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../public/js/ui-next/pages/TaskDetail.js');

// 瀏覽器腳本（掛全域、無 module.exports），只把 methods 物件整塊切出來跑。
// 用字面錨點定位不用行號——這個檔常被改，寫死位置會靜默切到別處。
function loadMethods(deps) {
  const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  const from = src.indexOf('\n    methods: {');
  const to = src.indexOf('\n    },\n    template:', from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const body = src.slice(src.indexOf('{', from), to + '\n    }'.length);
  const names = Object.keys(deps);
  return new Function(...names, `return (${body});`)(...names.map((n) => deps[n]));
}

function makeVm() {
  const deps = {
    Api: { post: async () => ({ done: true }), postForm: async () => ({}), get: async () => [] },
    showToast: () => {},
    confirmDialog: async () => true,
    FormData: function FormDataStub() { this.append = () => {}; },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    window: {},
    document: {},
    EVENTS_PAGE: 30,
  };
  const vm = Object.assign({}, loadMethods(deps));
  vm.task = { id: 7 };
  vm.$refs = {};
  vm.$nextTick = (fn) => fn();
  // 使用者先往上捲過：釘住旗標是 false。送出後要被明確補回來，否則這一值證明不了什麼。
  vm._convPinBottom = false;
  const seen = { load: 0, refresh: 0, pinAtRefresh: null, loadingTrue: false };
  vm.load = async () => { seen.load += 1; };
  vm.refresh = async () => { seen.refresh += 1; seen.pinAtRefresh = vm._convPinBottom; };
  let loading = false;
  Object.defineProperty(vm, 'loading', {
    get: () => loading,
    set: (v) => { if (v) seen.loadingTrue = true; loading = v; },
  });
  return { vm, seen };
}

// 每顆送出鈕要先滿足自己的前置條件（有填內容、全部選好…），否則函式一開頭就 return，測不到收尾那段。
const SEND_BUTTONS = [
  ['approve（審核通過）', 'approve', () => {}],
  ['reject（退回）', 'reject', (vm) => { vm.rejectReason = '欄位不對'; vm.rejectFiles = []; vm.rejectFilesPreviews = []; }],
  ['specApprove（規格審核通過）', 'specApprove', () => {}],
  ['specRevise（規格修改意見）', 'specRevise', (vm) => { vm.specFeedback = '改一下欄位'; }],
  ['submitConflictResolutions（衝突裁決）', 'submitConflictResolutions',
    (vm) => { vm.conflictAllChosen = true; vm.conflictItems = []; vm.conflictChoices = {}; }],
  ['markConflictResolved（已手動解決）', 'markConflictResolved', () => {}],
  ['csConfirm（客服回覆確認）', 'csConfirm', () => {}],
  ['csDataSubmit（補充資料）', 'csDataSubmit', (vm) => { vm.csAllAnswered = true; vm.csQuestions = []; vm.csAnswers = {}; }],
  ['csFollowupSubmit（客服追問）', 'csFollowupSubmit', (vm) => { vm.csFollowup = '再問一次'; }],
  ['resolveBlocker（中斷處理）', 'resolveBlocker', (vm) => { vm.resolution = '從中斷處重試'; }],
];

describe('送出鈕送完不能清空整頁重建，要靜默重抓並釘在最新訊息（成因①）', () => {
  test.each(SEND_BUTTONS)('%s', async (_label, method, prepare) => {
    const { vm, seen } = makeVm();
    prepare(vm);
    await vm[method]();
    expect(seen.loadingTrue).toBe(false);   // 切 loading＝內容區被換掉＝捲軸歸零
    expect(seen.load).toBe(0);
    expect(seen.refresh).toBe(1);
    expect(seen.pinAtRefresh).toBe(true);   // 重抓之前就要釘住，新訊息進來時 watch 才會貼底
  });
});

describe('捲在中段按「送出留言」也要跟到最新（成因②）', () => {
  test('重抓留言之前先把釘住補回來', async () => {
    const { vm } = makeVm();
    let pinWhenReloading = null;
    vm.newMessageText = ' 這是一則留言 ';
    vm.newMessageFiles = [];
    vm.newMessageFilesPreviews = [];
    vm.messageWriteback = false;
    vm.loadTaskMessages = async () => { pinWhenReloading = vm._convPinBottom; };
    await vm.sendTaskMessage();
    expect(pinWhenReloading).toBe(true);
  });
});
