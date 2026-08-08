// 前端沒有 Vue mount 測試基礎設施，但 TaskList 的這幾條是純邏輯（篩選持久化、套用具名 view、
// 狀態分類），不需要 DOM——把檔案丟進 vm sandbox、用假的 Vue.defineComponent 收下 options 物件，
// 就能直接呼叫 methods／watch 驗真實行為。比對字串的靜態守門弱在「改寫法就繞過」，這裡驗的是結果。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TASK_STATUSES, STATUS_LABELS, HUMAN_STATUSES, RUNNABLE_STATUSES } =
  require('../../public/js/status-labels.js');

const SRC = fs.readFileSync(path.join(__dirname, '../../public/js/views/TaskList.js'), 'utf8');

// store 是這台瀏覽器的 localStorage 內容，測試可預先塞入「上次存下來的篩選」
function loadTaskList(store = {}) {
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    STATUS_LABELS, HUMAN_STATUSES, RUNNABLE_STATUSES,
    Vue: { defineComponent: (o) => o },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { opts: sandbox.window.TaskListView, sandbox, store };
}

test('sandbox 真的載到了 view（harness 壞掉時測試不得靜默通過）', () => {
  const { opts } = loadTaskList();
  expect(typeof opts.data).toBe('function');
  expect(typeof opts.methods.isProcessing).toBe('function');
  expect(typeof opts.watch.needsActionCount).toBe('function');
});

// 側欄「輪到你」badge 的三個寫入點都被 `if (!this.showAllUsers)` 擋著（開著時列表是全體任務，
// 數字會灌水）。showAllUsers 因此絕對不能跨 session 存活：管理員按過一次「顯示全部使用者」，
// badge 就永遠停在舊值；同一台瀏覽器換非管理員登入時切換鈕是 v-if="isAdmin"，那個人連關掉的
// UI 都沒有 → badge 永遠 0。具名 view（存 DB）仍要帶著它走，所以只排除 localStorage 這條路。
describe('showAllUsers 不得寫進 localStorage', () => {
  test('storage 裡就算有 showAllUsers:true，開頁也回到 false', () => {
    const { opts } = loadTaskList({
      tasklist_filters: JSON.stringify({ filter: 'all', showAllUsers: true }),
    });
    const d = opts.data();
    expect(d.filter).toBe('all');          // 其餘欄位照樣記住（沒記住的話這條測試沒有鑑別力）
    expect(d.showAllUsers).toBe(false);
  });

  test('存檔時不把 showAllUsers 寫出去', () => {
    const { opts, store } = loadTaskList();
    opts.watch.filterSnapshot({ filter: 'pending', sort: 'title_asc', showAllUsers: true });
    const saved = JSON.parse(store.tasklist_filters);
    expect(saved.sort).toBe('title_asc');  // 該存的還是有存
    expect('showAllUsers' in saved).toBe(false);
  });

  test('重開頁後 badge 恢復更新（本條才是這個 bug 的症狀）', () => {
    const { opts, sandbox } = loadTaskList({
      tasklist_filters: JSON.stringify({ showAllUsers: true }),
    });
    sandbox.window.needsActionCount = { value: 0 };
    opts.watch.needsActionCount.call({ showAllUsers: opts.data().showAllUsers }, 7);
    expect(sandbox.window.needsActionCount.value).toBe(7);
  });
});

// filter 常常沒變（預設就是 needs_action）→ 只設欄位的話 filter watcher 不觸發、沒人重抓資料，
// 而 showAllUsers 決定打的是 tasks 還是 tasks?all=true：套「全部使用者＋某人」會變空列表，
// 反向套用則殘留別人的任務。對照組 toggleAllUsers 一直都有 load。
test('applyView 套完篩選要重新取資料，且順序是「先設欄位再取」', async () => {
  const { opts } = loadTaskList();
  const calls = [];
  const ctx = {
    savedViews: [{ name: '全部使用者的待審', filters: { showAllUsers: true, ownerFilter: '3' } }],
    filter: 'needs_action', showAllUsers: false, ownerFilter: '',
    load() { calls.push({ showAllUsers: this.showAllUsers, ownerFilter: this.ownerFilter }); },
  };
  await opts.methods.applyView.call(ctx, 0);
  expect(calls).toEqual([{ showAllUsers: true, ownerFilter: '3' }]);
});

test('applyView 套不存在的 view 不打 API', async () => {
  const { opts } = loadTaskList();
  let called = false;
  const ctx = { savedViews: [], load() { called = true; } };
  await opts.methods.applyView.call(ctx, 5);
  expect(called).toBe(false);
});

// isProcessing 決定卡片上有沒有 spinner。它原本是第五份手寫名單（10 個狀態），已經漏了四個
// actor:'agent' 的狀態——AI 正在跑卻沒有 spinner，畫面看起來像沒在動。改由 registry 推導後
// 「新增一關漏補這份」在結構上不可能發生（3b78a7f 的作法）。
describe('isProcessing 由 status registry 推導', () => {
  const { opts } = loadTaskList();

  test.each(Object.keys(TASK_STATUSES))('%s 的 spinner 與 registry 的 actor 一致', (status) => {
    const actor = TASK_STATUSES[status].actor;
    expect(opts.methods.isProcessing({ status })).toBe(actor !== 'human' && actor !== 'terminal');
  });

  // 上面那條會隨 registry 一起動；這四個是實際漏掉的，單獨釘住當迴歸案例
  test.each(['respec_running', 'reject_triage', 'resolve_triage', 'clarify_chat_running'])(
    '%s（AI 在跑）有 spinner', (status) => {
      expect(opts.methods.isProcessing({ status })).toBe(true);
    });

  test('等人的狀態沒有 spinner（有的話會讓人以為系統在跑，不去理它）', () => {
    HUMAN_STATUSES.forEach((s) => expect(opts.methods.isProcessing({ status: s })).toBe(false));
  });
});
