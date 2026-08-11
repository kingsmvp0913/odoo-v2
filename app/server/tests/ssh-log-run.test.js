const { runLogTail } = require('../lib/ssh-log');

const CONN = { log_mode: 'docker', log_container: 'odoo-app', log_tz_offset: 0 };
const AT = '2026-08-10T06:23:00Z';

const mkLine = (i, lv = 'ERROR') =>
  `2026-08-10 06:2${i % 10}:00,000 1 ${lv} db odoo.x: msg${i}`;

test('參數不合法時直接回錯，不連線', async () => {
  const exec = jest.fn();
  const r = await runLogTail(CONN, { level: 'ERROR' }, exec);
  expect(r.ok).toBe(false);
  expect(exec).not.toHaveBeenCalled();
});

test('時間範圍為 at ± window', async () => {
  let seen = '';
  const exec = async (c, cmd) => { seen = cmd; return { stdout: mkLine(1), stderr: '', code: 0 }; };
  const r = await runLogTail(CONN, { at: AT, window: 30 }, exec);
  expect(r.ok).toBe(true);
  expect(seen).toContain('--since 2026-08-10T05:53:00Z');
  expect(seen).toContain('--until 2026-08-10T06:53:00Z');
  expect(r.range.from).toBe('2026-08-10T05:53:00Z');
});

test('級別與關鍵字在平台側過濾', async () => {
  const text = [mkLine(1, 'INFO'), mkLine(2, 'ERROR'), mkLine(3, 'ERROR') + '\n  詳細：庫存不足'].join('\n');
  const exec = async () => ({ stdout: text, stderr: '', code: 0 });
  const all = await runLogTail(CONN, { at: AT, level: 'ERROR' }, exec);
  expect(all.total_matched).toBe(2);
  const kw = await runLogTail(CONN, { at: AT, level: 'ERROR', keyword: '庫存不足' }, exec);
  expect(kw.total_matched).toBe(1);
});

test('超過上限時截斷並明確標記與附說明', async () => {
  const text = Array.from({ length: 500 }, (_, i) => mkLine(i)).join('\n');
  const exec = async () => ({ stdout: text, stderr: '', code: 0 });
  const r = await runLogTail(CONN, { at: AT }, exec);
  expect(r.truncated).toBe(true);
  expect(r.returned).toBe(200);
  expect(r.total_matched).toBe(500);
  expect(r.note).toBeTruthy();
});

// 「查無資料」與「查詢失敗」必須可區分——runSelect 已有此教訓。
test('範圍內確實無記錄回 ok:true 與空陣列', async () => {
  const exec = async () => ({ stdout: '', stderr: '', code: 0 });
  const r = await runLogTail(CONN, { at: AT }, exec);
  expect(r.ok).toBe(true);
  expect(r.entries).toEqual([]);
  expect(r.total_matched).toBe(0);
});

test('指令失敗回 ok:false 並帶 [LOG] 前綴與原始 stderr', async () => {
  const exec = async () => ({ stdout: '', stderr: 'No such container: odoo-app', code: 1 });
  const r = await runLogTail(CONN, { at: AT }, exec);
  expect(r.ok).toBe(false);
  expect(r.error).toContain('[LOG]');
  expect(r.error).toContain('No such container');
});

test('回傳內容已套用遮罩', async () => {
  const exec = async () => ({ stdout: mkLine(1) + ' password=hunter2', stderr: '', code: 0 });
  const r = await runLogTail(CONN, { at: AT }, exec);
  expect(JSON.stringify(r.entries)).not.toContain('hunter2');
});

// file 模式讀不到已被輪替的檔案，此時空結果會被誤讀為「該時段無異常」。
test('file 模式範圍早於檔案起點時明講可能已輪替', async () => {
  const conn = { log_mode: 'file', log_path: '/var/log/odoo/odoo.log', log_tz_offset: 0 };
  const exec = async (c, cmd) => {
    if (cmd.includes('head -n')) return { stdout: '2026-08-10 06:20:00,000 1 INFO db odoo.x: first', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const r = await runLogTail(conn, { at: '2026-08-09T06:23:00Z' }, exec);
  expect(r.ok).toBe(false);
  expect(r.error).toContain('輪替');
});

// rotatedOut 只是輔助判斷，它自己失敗（如 SSH 連線在探測輪替時中斷）不該讓整個
// 查詢以 reject 的方式冒泡出去——呼叫端預期的是 { ok:false, error } 物件。
test('rotatedOut 探測時 execFn 拋例外，仍回傳 ok:false 物件而非 reject', async () => {
  const conn = { log_mode: 'file', log_path: '/var/log/odoo/odoo.log', log_tz_offset: 0 };
  const exec = async (c, cmd) => {
    if (cmd.includes('head -n')) throw new Error('SSH 連線中斷');
    return { stdout: mkLine(1), stderr: '', code: 0 };
  };
  await expect(runLogTail(conn, { at: AT }, exec)).resolves.toEqual(expect.objectContaining({ ok: expect.any(Boolean) }));
});
