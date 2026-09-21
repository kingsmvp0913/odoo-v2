// 意圖：「測試區」這顆按鈕在六個地方出現（側欄專案 ⋮、側欄任務 ⋮、專案卡 ⋮、專案頁標題列、
// 專案頁環境區、任務頁），而開啟動作原本是四份逐字複製的程式碼。複製的後果在 2026-09-21
// 被使用者撞到：只有任務頁那份會在新開的空白分頁裡寫「建立中」，其餘三處按下去是一個永遠
// 空白的分頁——看起來就是「按了沒反應」，而畫面上沒有任何錯誤。
//
// 這支測試守兩件事：
//   1. openEnvTab（唯一來源）的等待回饋確實存在，且只在「真的要等」時才出現；
//   2. 所有入口都走這支，沒有人再自己 window.open——那正是行為漂移的來源。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../public/js/env-sso.js');

// env-sso.js 是瀏覽器腳本（靠全域 Api／showToast）。以 stub 過的全域載出函式。
// setTimeout 立刻執行：輪詢間隔是 5 秒，照實等會讓測試跑五秒起跳。
function loadEnvSso({ responses, popup }) {
  const src = fs.readFileSync(SRC, 'utf8');
  const calls = { toasts: [], dismissed: [], writes: [] };
  const windowStub = {
    open: () => popup,
    location: {},
  };
  let n = 0;
  const Api = { get: () => { const r = responses[Math.min(n++, responses.length - 1)]; return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); } };
  let toastSeq = 0;
  const showToast = (message, level, duration) => { const id = ++toastSeq; calls.toasts.push({ id, message, level, duration }); return id; };
  const dismissToast = (id) => calls.dismissed.push(id);
  const factory = new Function('window', 'Api', 'showToast', 'dismissToast', 'console', 'setTimeout',
    `${src}\nreturn { openEnvTab, ENV_SSO_POLL_TIMEOUT_MS };`);
  const mod = factory(windowStub, Api, showToast, dismissToast, { debug() {} }, (fn) => fn());
  return { ...mod, calls, windowStub };
}

const mkPopup = () => {
  const writes = [];
  return { location: null, closed: false, writes, document: { write: (html) => writes.push(html) }, close() { this.closed = true; } };
};

describe('openEnvTab：按下「測試區」之後使用者看得到什麼', () => {
  // 環境本來就跑著時整趟只要一次請求。此時跳「建立中」是雜訊——會在 200ms 內閃一下就被收掉。
  test('環境已就緒 → 直接導向，不跳「建立中」也不在分頁寫字', async () => {
    const popup = mkPopup();
    const { openEnvTab, calls } = loadEnvSso({ responses: [{ url: 'https://env.example.com/aidev/sso?token=x' }], popup });
    await openEnvTab(7);
    expect(popup.location).toBe('https://env.example.com/aidev/sso?token=x');
    expect(calls.toasts).toHaveLength(0);
    expect(popup.writes).toHaveLength(0);
  });

  // 這是本次缺陷的正面：後端回 202 代表要等（首建可達數分鐘）。使用者多半留在原視窗，
  // 新分頁在背景，所以「分頁裡寫字」與「原視窗跳提示」兩者缺一都會變成沒反應。
  test('後端回 202 要等 → 分頁寫字且原視窗跳提示，完成後收掉提示並導向', async () => {
    const popup = mkPopup();
    const { openEnvTab, calls, ENV_SSO_POLL_TIMEOUT_MS } = loadEnvSso({
      responses: [{ starting: true }, { starting: true }, { url: 'https://env.example.com/go' }], popup,
    });
    await openEnvTab(7);
    expect(popup.writes.join('')).toContain('建立中');
    expect(calls.toasts).toHaveLength(1);
    expect(calls.toasts[0].message).toContain('建立中');
    // 壽命必須撐過整段輪詢：用一般錯誤 toast 的黏著秒數，訊息會在還在建的時候先消失。
    expect(calls.toasts[0].duration).toBe(ENV_SSO_POLL_TIMEOUT_MS);
    expect(calls.dismissed).toEqual([calls.toasts[0].id]);
    expect(popup.location).toBe('https://env.example.com/go');
  });

  // 等待提示只跳一次：輪詢每 5 秒問一次，每次都跳的話 10 分鐘會疊出 120 則。
  test('輪詢多輪只跳一次等待提示', async () => {
    const popup = mkPopup();
    const { openEnvTab, calls } = loadEnvSso({
      responses: [{ starting: true }, { starting: true }, { starting: true }, { url: 'https://x/go' }], popup,
    });
    await openEnvTab(7);
    expect(calls.toasts).toHaveLength(1);
  });

  // 失敗時空白分頁必須收掉，否則使用者手上多一個永遠空白的分頁而不知道發生什麼事；
  // 錯誤訊息走 duration 0（＝停留較久那一檔），不能用一般 4 秒。
  test('失敗 → 關掉空白分頁並留下錯誤訊息', async () => {
    const popup = mkPopup();
    const { openEnvTab, calls } = loadEnvSso({ responses: [new Error('測試區建立失敗：磁碟已滿')], popup });
    await openEnvTab(7);
    expect(popup.closed).toBe(true);
    const err = calls.toasts.find((t) => t.level === 'error');
    expect(err.message).toContain('磁碟已滿');
    expect(err.duration).toBe(0);
  });

  // popup-blocker 擋下時 window.open 回 null。整趟不得丟例外，並改為原視窗導向。
  test('popup 被擋下 → 改用原視窗導向，不丟例外', async () => {
    const { openEnvTab, windowStub } = loadEnvSso({ responses: [{ url: 'https://x/go' }], popup: null });
    await openEnvTab(7);
    expect(windowStub.location.href).toBe('https://x/go');
  });
});

// 守衛：再有人複製一份 openEnv 出來，行為就會再漂一次。入口一律走 openEnvTab。
describe('所有測試區入口共用同一支實作', () => {
  const FILES = [
    'js/ui-next/UiNextApp.js',        // 側欄：專案 ⋮ 與任務 ⋮
    'js/ui-next/pages/ProjectList.js', // 專案卡 ⋮
    'js/ui-next/pages/ProjectDetail.js', // 專案頁標題列＋環境區
    'js/ui-next/pages/TaskDetail.js',  // 任務頁 🖥
  ];
  test.each(FILES)('%s 走 openEnvTab，且不自己開空白分頁', (rel) => {
    const src = fs.readFileSync(path.join(__dirname, '../../public', rel), 'utf8');
    expect(src).toContain('openEnvTab(');
    expect(src).not.toContain('about:blank');
  });

  // 專案頁標題列那顆原本 :disabled="!envActive"：環境沒建過就整顆灰掉，而側欄同名按鈕按得下去
  // ——同一件事兩種答案。後端現在會自動建，這顆不該再被擋。
  test('專案頁標題列的「測試區」不得被 envActive 擋住', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../public/js/ui-next/pages/ProjectDetail.js'), 'utf8');
    expect(src).toContain('<button @click="openEnv">測試區</button>');
  });
});
