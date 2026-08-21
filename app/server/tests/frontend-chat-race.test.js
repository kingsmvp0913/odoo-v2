// 意圖：對話頁所有 await 回來後寫回 this.messages 的地方，共用同一份 state；使用者一邊等回覆
// 一邊切到別的對話（AI 回覆常要跑數分鐘，側欄切換完全沒被擋住），慢回來的那份就會寫進「現在
// 這個」對話的畫面——實際回報的症狀是「訊息錯亂顯示到別的 chat」。
//
// 後端每個端點都用 chat_id 隔離、送出時還有 reply_pending 原子搶佔，錯亂純粹發生在前端，
// 所以這支不掃字串、直接把 ProjectChat.js 的 methods 切出來跑真的非同步交錯：
//   ① send() 等回覆期間切走 → 回覆不得 push 進新對話的 messages
//   ② send() 切走後不得拿現在的 activeChat 去標已讀（會把別的對話誤標成已讀）
//   ③ 兩個對話的 loadMessages 交錯回來 → 晚到的舊訊息不得蓋掉現在這個對話
//   ④ 沒切走的正常路徑照舊顯示（守衛不能嚴到把正常回覆也擋掉）
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../public/js/views/ProjectChat.js');

// ProjectChat.js 整支依賴 Vue 全域，無法直接 require；只取 methods 這個物件來跑。
// 收尾靠「2 空格縮排的 },」＋緊接的 template 定位（方法內部的閉合都在 4 空格以上）。
function loadMethods(deps) {
  const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');   // 這支 view 存的是 CRLF
  const from = src.indexOf('  methods: {');
  const END = '\n  },\n  template:';
  const to = src.indexOf(END, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);

  const body = src.slice(src.indexOf('{', from), to + '\n  }'.length);
  const make = new Function('Api', 'showToast', 'UnreadStore', 'window', 'URL', `return (${body});`);
  return make(deps.Api, deps.showToast, deps.UnreadStore, deps.window, deps.URL);
}

// 手動控制每個請求何時回來——錯亂只在「先發的後回來」時才發生，自動 resolve 測不到。
function makeApi() {
  const pending = new Map();
  const calls = [];
  const hold = (method, p) => {
    calls.push(`${method} ${p}`);
    // 標記已讀不是這支要驗的東西，讓它自己完成，免得後面的斷言卡在它身上
    if (p.endsWith('/read')) return Promise.resolve({ projectUnread: 0 });
    return new Promise((resolve, reject) => pending.set(`${method} ${p}`, { resolve, reject }));
  };
  return {
    calls,
    Api: {
      get: (p) => hold('get', p),
      post: (p) => hold('post', p),
      postForm: (p) => hold('postForm', p),
      delete: (p) => hold('delete', p),
      getBlob: (p) => hold('getBlob', p)
    },
    resolve(key, value) {
      const d = pending.get(key);
      if (!d) throw new Error(`沒有這個待回應的請求：${key}（已發出：${calls.join(', ')}）`);
      pending.delete(key);
      d.resolve(value);
      return new Promise(r => setImmediate(r));   // 讓 await 鏈跑完再回到測試
    }
  };
}

function makeVm(api) {
  const methods = loadMethods({
    Api: api.Api,
    showToast: () => {},
    UnreadStore: { byProject: {} },
    window: {},                                    // 沒有 TourDemo → isTourDemo() 為 false，走真的 API 路徑
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }
  });
  const vm = {
    chats: [], activeChat: null, messages: [], newInput: '', sending: false,
    loadingMsgs: false, replyPending: false, pendingFiles: [], pendingPreviews: [],
    attachUrls: {}, _pollTimer: null, _gone: false,
    $route: { params: { id: '1' } },
    $router: { replace: () => {} },
    $refs: {},
    $nextTick: (fn) => { fn && fn(); }
  };
  Object.entries(methods).forEach(([k, fn]) => { vm[k] = fn.bind(vm); });
  return vm;
}

const chatA = { id: 1, title: 'A' };
const chatB = { id: 2, title: 'B' };

describe('對話頁：等回覆時切換對話不得把內容寫到別的對話', () => {
  test('等 A 的回覆時切到 B → 回覆不進 B 的畫面（這就是回報的錯亂）', async () => {
    const api = makeApi();
    const vm = makeVm(api);
    vm.chats = [chatA, chatB];
    vm.activeChat = chatA;
    vm.newInput = '幫我查一下這個錯誤';

    const sending = vm.send();
    expect(vm.messages).toHaveLength(1);   // 樂觀顯示的使用者訊息，還在 A

    // 使用者不等了，切去 B（側欄沒有 disabled，這是可以做到的）
    const switching = vm.selectChat(chatB);
    await api.resolve('get projects/1/chats/2/messages', [{ id: 99, role: 'user', content: 'B 原有的訊息' }]);
    await switching;
    expect(vm.messages.map(m => m.content)).toEqual(['B 原有的訊息']);

    // A 的回覆這時才回來
    await api.resolve('post projects/1/chats/1/messages', { reply: 'A 的回覆' });
    await sending;

    expect(vm.messages.map(m => m.content)).toEqual(['B 原有的訊息']);
    expect(vm.messages.some(m => m.content === 'A 的回覆')).toBe(false);
  });

  test('切走後不得拿現在的對話去標已讀（B 會被誤標成已讀）', async () => {
    const api = makeApi();
    const vm = makeVm(api);
    vm.chats = [chatA, chatB];
    vm.activeChat = chatA;
    vm.newInput = '嗨';

    const sending = vm.send();
    const switching = vm.selectChat(chatB);
    await api.resolve('get projects/1/chats/2/messages', []);
    await switching;
    const readsAfterSwitch = api.calls.filter(c => c === 'post projects/1/chats/2/read').length;

    await api.resolve('post projects/1/chats/1/messages', { reply: 'A 的回覆' });
    await sending;

    // 切過去時本來就會標一次已讀；A 的回覆落地不該再替 B 標一次
    expect(api.calls.filter(c => c === 'post projects/1/chats/2/read').length).toBe(readsAfterSwitch);
  });

  test('連點兩個對話、先發的後回來 → 舊訊息不得蓋掉現在這個對話', async () => {
    const api = makeApi();
    const vm = makeVm(api);
    vm.chats = [chatA, chatB];
    vm.activeChat = chatA;

    const first = vm.loadMessages();               // A 的請求（會慢）
    const second = vm.selectChat(chatB);           // 使用者馬上改點 B

    await api.resolve('get projects/1/chats/2/messages', [{ id: 20, role: 'ai', content: 'B 的內容' }]);
    await second;
    await api.resolve('get projects/1/chats/1/messages', [{ id: 10, role: 'ai', content: 'A 的內容' }]);
    await first;

    expect(vm.activeChat.id).toBe(2);
    expect(vm.messages.map(m => m.content)).toEqual(['B 的內容']);
  });

  test('沒有切走的正常路徑照舊：回覆進得了畫面（守衛不能連正常的也擋掉）', async () => {
    const api = makeApi();
    const vm = makeVm(api);
    vm.chats = [chatA];
    vm.activeChat = chatA;
    vm.newInput = '正常送一則';

    const sending = vm.send();
    await api.resolve('post projects/1/chats/1/messages', { reply: '這是 AI 的回覆' });
    await sending;

    expect(vm.messages.map(m => m.content)).toEqual(['正常送一則', '這是 AI 的回覆']);
    expect(vm.sending).toBe(false);
  });

  test('離開頁面後回來的回覆也不寫回（元件已卸載）', async () => {
    const api = makeApi();
    const vm = makeVm(api);
    vm.chats = [chatA];
    vm.activeChat = chatA;
    vm.newInput = '送出後就離開這頁';

    const sending = vm.send();
    vm._gone = true;                                // beforeUnmount 做的事
    await api.resolve('post projects/1/chats/1/messages', { reply: '回來得太晚' });
    await sending;

    expect(vm.messages.some(m => m.content === '回來得太晚')).toBe(false);
  });
});
