// 意圖：runEnvSetup spawn Odoo 後必須實測埠真的 listen 才算啟動成功。
// 死埠（process 未 listen／崩潰）一律回 false → 上層標 error 而非 running，
// 避免 stale running 把死掉的 URL 交給 E2E，讓 E2E 連不上卻被兜底成永遠好不了的 env blocker。
const net = require('net');
const { waitForPort } = require('../pipeline/env-agent');

test('埠有服務監聽 → true（啟動成功才算 running）', async () => {
  const server = net.createServer();
  const port = await new Promise((res) =>
    server.listen(0, '127.0.0.1', () => res(server.address().port))
  );
  try {
    await expect(waitForPort(port, 3000, 100)).resolves.toBe(true);
  } finally {
    await new Promise((res) => server.close(res));
  }
});

test('死埠（無人監聽）→ 逾時內回 false，不誤判成 running', async () => {
  // 開一個埠取得號碼後立即關閉，保證該埠沒有任何服務在聽。
  const tmp = net.createServer();
  const port = await new Promise((res) =>
    tmp.listen(0, '127.0.0.1', () => res(tmp.address().port))
  );
  await new Promise((res) => tmp.close(res));
  await expect(waitForPort(port, 600, 100)).resolves.toBe(false);
});
