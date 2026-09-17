// app/server/tests/frontend-code-zip-toast.test.js
// 意圖（子專案 0 Task 3.14 fix round 1，IMPORTANT-1）：pipeline-routes.js 的 code-zip 端點會把
// worktree 內偵測到的符號連結等不安全路徑擋下，透過 X-Zip-Skipped header 回報，但前端原本只讀
// X-Zip-Entries／X-Zip-Deleted／X-Zip-Stale——使用者下載後完全看不到「有檔案被擋下沒打包」，
// 會誤以為 zip 內容是完整的。這支測試把 downloadTaskCodeZip 從原始碼挖出來真的跑一次
//（跟 frontend-toast-id.test.js 同一套「string 切片 + new Function」手法，本檔案沒有 Vue／DOM 全域可 require）。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../public/js/ui-next/UiNextShared.js');

function loadDownloadTaskCodeZip(Api, showToast, document, URL) {
  const src = fs.readFileSync(SRC, 'utf8');
  const from = src.indexOf('async function downloadTaskCodeZip(task) {');
  const to = src.indexOf('window.UiNextShared = {');
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const factory = new Function('Api', 'showToast', 'document', 'URL', 'setTimeout',
    `${src.slice(from, to)}\nreturn downloadTaskCodeZip;`);
  // 第五個參數頂掉 downloadTaskCodeZip 內對全域 setTimeout 的呼叫（撤銷 blob URL 用，10 秒後才觸發），
  // 測試不需要它真的排程，give no-op 避免留下懸掛計時器。
  return factory(Api, showToast, document, URL, () => {});
}

function fakeHeaders(map) {
  // Api.getBlob 回傳的是真實 fetch 的 Headers 物件，這裡只需要 .get()，Map 剛好同介面。
  return new Map(Object.entries(map).map(([k, v]) => [k, encodeURIComponent(JSON.stringify(v))]));
}

function fakeDocument() {
  const a = { click: jest.fn(), remove: jest.fn() };
  return { createElement: () => a, body: { appendChild: jest.fn() } };
}

const fakeURL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };

test('worktree 內被擋下的符號連結要有獨立 toast，不能讓使用者以為 zip 是完整的', async () => {
  const toasts = [];
  const showToast = (msg, kind) => toasts.push({ msg, kind });
  const Api = {
    getBlob: jest.fn().mockResolvedValue({
      blob: {},
      headers: fakeHeaders({
        'X-Zip-Entries': ['idx_demo/models/sale_order.py'],
        'X-Zip-Deleted': [],
        'X-Zip-Stale': [],
        'X-Zip-Skipped': [{ path: 'idx_demo/models/evil.py', reason: '符號連結，不打包' }],
      }),
    }),
  };
  const download = loadDownloadTaskCodeZip(Api, showToast, fakeDocument(), fakeURL);
  await download({ id: 1, task_id: 'T1' });

  const skipToast = toasts.find((t) => t.msg.includes('因安全原因未打包'));
  expect(skipToast).toBeTruthy();
  expect(skipToast.kind).toBe('error'); // 比照 stale／deleted，不能自動消失
  expect(skipToast.msg).toContain('idx_demo/models/evil.py');
  expect(skipToast.msg).toContain('符號連結，不打包'); // MINOR-3：要帶實際原因，不是空泛提醒
});

test('沒有檔案被擋下時不顯示這則 toast', async () => {
  const toasts = [];
  const showToast = (msg, kind) => toasts.push({ msg, kind });
  const Api = {
    getBlob: jest.fn().mockResolvedValue({
      blob: {},
      headers: fakeHeaders({ 'X-Zip-Entries': ['idx_demo/models/sale_order.py'] }),
    }),
  };
  const download = loadDownloadTaskCodeZip(Api, showToast, fakeDocument(), fakeURL);
  await download({ id: 1, task_id: 'T1' });

  expect(toasts.some((t) => t.msg.includes('因安全原因未打包'))).toBe(false);
});
