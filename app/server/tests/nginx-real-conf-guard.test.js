// 這支測的不是某個函式，而是「測試環境本身不得有能力去動真的共用 nginx」。
// 沒有它的話，jest.setup.js 被誰拿掉都不會有徵狀——直到某天有人跑測試，
// 正在用測試區的真人當場斷線（2026-09-10 已實際發生過一次）。
describe('測試進程不得握有真 nginx 的設定', () => {
  test('NGINX_SYNC_CONF_FILE／NGINX_CONTAINER 在測試中必須是未設定', () => {
    // 兩者任一存在，syncNginxMap 的 gate 就會放行，接著寫真檔＋docker exec 真容器。
    expect(process.env.NGINX_SYNC_CONF_FILE).toBeUndefined();
    expect(process.env.NGINX_CONTAINER).toBeUndefined();
  });
});
