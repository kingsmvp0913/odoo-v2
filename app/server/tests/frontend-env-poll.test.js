// 意圖：專案頁的測試區「建立中」是靠每 5 秒輪詢 loadEnv() 更新的，而 env.status 的 watcher
// 只要看到值不是 setting_up 就會 _stopPoll()。所以 loadEnv 的 catch 若無條件把狀態寫成 idle，
// 任何一次暫時性失敗（server 重啟、網路抖動、逾時）都會演變成永久性錯誤畫面：
// 狀態被改成 idle → watcher 立刻殺掉輪詢 → 之後再也沒有人去問真實狀態 → 畫面永遠停在「未建立」，
// 但環境其實正在背景建置。使用者看到的是「按了沒反應」，重新整理才會恢復。
//
// 後端 GET /api/projects/:id/env 對「這專案根本沒有環境」是回 200 + { status: 'idle' }（見
// env-routes.js），不是丟錯。也就是說 catch 分支只會在真正的傳輸／伺服器錯誤時走到，
// 保留舊狀態不會讓「已刪除的環境」留下殘影——刪除後的正常回應仍然會把狀態帶成 idle。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../public/js/views/ProjectDetail.js');

// ProjectDetail.js 是瀏覽器腳本（掛全域、無 module.exports），以 stub 過的全域載出 options 物件。
function loadComponent(Api) {
  const src = fs.readFileSync(SRC, 'utf8');
  const win = {};
  const factory = new Function(
    'Vue', 'window', 'Api', 'showToast', 'confirmDialog', 'UnreadStore', 'pollEnvSso',
    `${src}\nreturn window.ProjectDetailView;`
  );
  return factory(
    { defineComponent: (o) => o },
    win,
    Api,
    () => {},
    () => {},
    { byProject: {} },
    () => {}
  );
}

const ctxWith = (env) => ({ env, $route: { params: { id: '1' } } });

describe('測試區輪詢：單次 loadEnv 失敗不得變成永久錯誤狀態', () => {
  test('建立中途一次查詢失敗，狀態維持 setting_up（改成 idle 會被 watcher 殺掉輪詢）', async () => {
    const comp = loadComponent({ get: () => Promise.reject(new Error('network down')) });
    const ctx = ctxWith({ status: 'setting_up' });
    await comp.methods.loadEnv.call(ctx);
    expect(ctx.env.status).toBe('setting_up');
  });

  test('running 中一次查詢失敗也不得被改寫', async () => {
    const comp = loadComponent({ get: () => Promise.reject(new Error('boom')) });
    const ctx = ctxWith({ status: 'running', port: 21000 });
    await comp.methods.loadEnv.call(ctx);
    expect(ctx.env.status).toBe('running');
  });

  // 首次載入還沒有任何狀態可保留，此時仍需要一個預設值，否則 template 會對 null 取屬性。
  test('首次載入就失敗時給預設 idle（畫面尚無狀態可保留）', async () => {
    const comp = loadComponent({ get: () => Promise.reject(new Error('boom')) });
    const ctx = ctxWith(null);
    await comp.methods.loadEnv.call(ctx);
    expect(ctx.env).toEqual({ status: 'idle' });
  });

  // 成功路徑必須照常整包換掉，否則刪除環境後畫面不會更新。
  test('查詢成功時以後端回應為準', async () => {
    const comp = loadComponent({ get: () => Promise.resolve({ status: 'idle' }) });
    const ctx = ctxWith({ status: 'running' });
    await comp.methods.loadEnv.call(ctx);
    expect(ctx.env.status).toBe('idle');
  });
});
