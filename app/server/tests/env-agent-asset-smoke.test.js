// 意圖：後台 asset bundle 冒煙檢查——deploy 升級+重啟後真的 SSO 登入開一次後台，抓 OWL/QWeb
// template（static/src/xml）xpath 對不到目標造成的 bundle 編譯失敗(404)。此類錯誤只在瀏覽器首次
// 請求 bundle 時 lazy 編譯才現形、失敗是 WARNING+404 不改 exit code，-u --stop-after-init 與無 tour
// 的 E2E 都驗不到（見 deploy-testing.test）。判定核心：後台頁能生成但 bundle 明確 404/500 才算真
// asset bug；連不上/registry 未就緒/拿不到 URL 一律 inconclusive，不阻斷部署（避免暫態誤報）。
const { assetSmokeCheck } = require('../pipeline/env-agent');

// deps.target 注入接縫：繞過 dockerCtxFor 的重依賴，專測拿到 host/port/secret 後的 HTTP 判斷分支。
const target = { host: '127.0.0.1', port: 21099, ssoSecret: 'a'.repeat(64) };

// 假 httpGet：依 path 回對應回應，用一組 steps 描述 SSO→/web→bundle 三步。
function makeHttp(steps) {
  return async (host, port, pathUrl) => {
    if (pathUrl.startsWith('/aidev/sso')) return steps.sso;
    if (pathUrl === '/web') return steps.web;
    return steps.bundle; // 其餘＝bundle url
  };
}
const SSO_OK = { status: 303, headers: { 'set-cookie': 'session_id=xyz; HttpOnly; Path=/' } };
const WEB_OK = { status: 200, body: '<script src="/web/assets/abc123/web.assets_web.min.js"></script>' };

test('後台頁能生成(200)但 bundle 回 404 → assetError（真 template xpath bug）', async () => {
  const res = await assetSmokeCheck(1, { target, httpGet: makeHttp({ sso: SSO_OK, web: WEB_OK, bundle: { status: 404 } }) });
  expect(res.ok).toBe(false);
  expect(res.assetError).toBe(true);
  expect(res.bundleUrl).toContain('web.assets_web');
});

test('bundle 回 200 → ok，不誤報', async () => {
  const res = await assetSmokeCheck(1, { target, httpGet: makeHttp({ sso: SSO_OK, web: WEB_OK, bundle: { status: 200 } }) });
  expect(res.ok).toBe(true);
  expect(res.assetError).toBeFalsy();
});

test('後台頁非 200（registry 未就緒等暫態）→ inconclusive，不判 asset bug', async () => {
  const res = await assetSmokeCheck(1, { target, httpGet: makeHttp({ sso: SSO_OK, web: { status: 500, body: '' }, bundle: { status: 404 } }) });
  expect(res.ok).toBe(true);
  expect(res.assetError).toBeFalsy();
  expect(res.inconclusive).toBeTruthy();
});

test('SSO 拿不到 session cookie → inconclusive（不觸及 bundle 判定）', async () => {
  const res = await assetSmokeCheck(1, { target, httpGet: makeHttp({ sso: { status: 403, headers: {} }, web: WEB_OK, bundle: { status: 200 } }) });
  expect(res.ok).toBe(true);
  expect(res.inconclusive).toBe('no_session');
});
