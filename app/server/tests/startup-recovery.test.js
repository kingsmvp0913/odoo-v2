// 意圖：平台重啟時，容器內那支 `odoo -u` 不會跟著死（docker exec 無 TTY，父死子活——2026-08-21
// 實測），而 cron 待會就會把停在 deploy_testing 的任務重派，於是兩個 odoo -u 併行寫同一個 DB。
// 實測兩個都死在 psycopg2 SerializationFailure，錯誤文字經 classifyFailure 回 'unknown' → 交 haiku
// 猜 → 判 env 是叫人來看不存在的問題、判 code 是退開發空轉，兩條都白燒一輪。
//
// 本檔鎖住的是「該重啟誰、不該重啟誰」這條界線——重啟範圍一錯，代價是打斷正在被使用的測試區
// （正式機還同機跑著其他服務）。以及「清理再重要也不能擋住平台啟動」。
const { newDb } = require('pg-mem');

let dbModule, clearInterruptedUpgrades, releaseInterruptedSetups, restartEnv, stopEnv;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ clearInterruptedUpgrades, releaseInterruptedSetups } = require('../pipeline/startup-recovery'));

  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('u','h','U','user')"
  );
  for (const [name, ver] of [['proj-a', '17.0'], ['proj-b', '17.0']]) {
    await dbModule.query('INSERT INTO projects (name, odoo_version) VALUES ($1,$2)', [name, ver]);
  }
});
afterAll(() => dbModule._setPoolForTesting(null));

beforeEach(async () => {
  await dbModule.query('DELETE FROM tasks');
  await dbModule.query('DELETE FROM odoo_envs');
  restartEnv = jest.fn().mockResolvedValue({ ok: true });
  stopEnv = jest.fn().mockResolvedValue(undefined);
});

// 每張任務都要有 user/project；status 是本模組唯一的判準來源
async function mkTask(taskId, status, projectId, extra = {}) {
  await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, status, project_id, is_paused, is_hidden)
     VALUES (1, $1, 'test', $2, $3, $4, $5)`,
    [taskId, status, projectId, extra.paused ?? false, extra.hidden ?? false]
  );
}

test('停在 deploy_testing 的任務 → 重啟該專案容器（否則殘留進程會與重派的升級併行）', async () => {
  await mkTask('T1', 'deploy_testing', 1);
  const stats = await clearInterruptedUpgrades({ restartEnv });
  expect(restartEnv).toHaveBeenCalledTimes(1);
  expect(restartEnv).toHaveBeenCalledWith(1);
  expect(stats.restarted).toBe(1);
});

test('停在 playwright_running 的任務同樣要清 — E2E 的 tour 也是 docker exec 起的一次性進程', async () => {
  await mkTask('T1', 'playwright_running', 2);
  await clearInterruptedUpgrades({ restartEnv });
  expect(restartEnv).toHaveBeenCalledWith(2);
});

test('同專案多張中斷任務只重啟一次 — 重啟第二次是白白多停一次測試區', async () => {
  await mkTask('T1', 'deploy_testing', 1);
  await mkTask('T2', 'playwright_running', 1);
  const stats = await clearInterruptedUpgrades({ restartEnv });
  expect(restartEnv).toHaveBeenCalledTimes(1);
  expect(stats.restarted).toBe(1);
});

// 這條是界線的核心：不是所有跑到一半的任務都會在容器裡留東西。coding/QA 跑的是 claude 子進程，
// 死在宿主上；把它們的專案也重啟等於無故打斷可能正在被人使用的測試區。
test('其他關卡中斷不重啟 — claude 子進程死在宿主，容器內沒有殘留可清', async () => {
  await mkTask('T1', 'coding_running', 1);
  await mkTask('T2', 'qa_running', 2);
  const stats = await clearInterruptedUpgrades({ restartEnv });
  expect(restartEnv).not.toHaveBeenCalled();
  expect(stats.restarted).toBe(0);
});

// cron 的派工查詢帶 is_paused=false AND is_hidden=false（runner.js），這兩種任務不會被重派，
// 就沒有併行競態——重啟它們的環境是純粹的傷害。
test('暫停／隱藏的任務不重啟 — cron 不會重派它們，沒有併行競態', async () => {
  await mkTask('T1', 'deploy_testing', 1, { paused: true });
  await mkTask('T2', 'deploy_testing', 2, { hidden: true });
  await clearInterruptedUpgrades({ restartEnv });
  expect(restartEnv).not.toHaveBeenCalled();
});

test('容器沒在跑算略過不算重啟 — 進程隨容器一起沒了，本來就無殘留', async () => {
  await mkTask('T1', 'deploy_testing', 1);
  restartEnv.mockResolvedValue({ ok: false, skipped: 'not_running' });
  const stats = await clearInterruptedUpgrades({ restartEnv });
  expect(stats).toMatchObject({ restarted: 0, skipped: 1, failed: 0 });
});

// 清理失敗的正確行為是退回現況（殘留照舊），不是讓平台起不來——後者是全平台停擺。
test('單一專案重啟失敗不擴散，其餘專案照清', async () => {
  await mkTask('T1', 'deploy_testing', 1);
  await mkTask('T2', 'deploy_testing', 2);
  restartEnv.mockImplementation(pid =>
    pid === 1 ? Promise.reject(new Error('docker unreachable')) : Promise.resolve({ ok: true })
  );
  const stats = await clearInterruptedUpgrades({ restartEnv });
  expect(stats).toMatchObject({ restarted: 1, failed: 1 });
  expect(restartEnv).toHaveBeenCalledTimes(2);
});

// restartEnv 內含 90s 的 waitForPort，逐專案序列做最壞會把啟動拖住好幾分鐘，而那段期間
// 平台還沒 listen＝對所有人停擺。超出預算就停手，且必須留下訊號（跳過的專案殘留還在）。
test('超出啟動預算就停手，且計入 overBudget 而非靜默截斷', async () => {
  await mkTask('T1', 'deploy_testing', 1);
  await mkTask('T2', 'deploy_testing', 2);
  let t = 0;
  const now = () => (t += 1000); // 每次讀秒都前進 1 秒
  const stats = await clearInterruptedUpgrades({ restartEnv, now, budgetMs: 1500 });
  expect(stats.restarted).toBe(1);
  expect(stats.overBudget).toBe(1);
});

test('沒有中斷任務時完全不碰 docker', async () => {
  const stats = await clearInterruptedUpgrades({ restartEnv });
  expect(restartEnv).not.toHaveBeenCalled();
  expect(stats).toMatchObject({ restarted: 0, skipped: 0, failed: 0, overBudget: 0 });
});

// ——— 建立中被打斷的環境（releaseInterruptedSetups）———
// 舊版一律標 error，而 error 在 /env/sso 是死路（刻意不自動重試）→ 使用者只能自己回專案頁重按。
// 「環境有毛病建不起來」與「平台自己把它打斷了」是兩回事，後者重跑多半就成功。

async function mkEnv(projectId, status, port = null) {
  await dbModule.query(
    'INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,$2,$3)',
    [projectId, status, port]
  );
}

test('建立中被打斷 → 走 stopEnv 收乾淨（連容器與埠一起還，不是只改狀態）', async () => {
  await mkEnv(1, 'setting_up', 21005);
  const stats = await releaseInterruptedSetups({ stopEnv });
  expect(stopEnv).toHaveBeenCalledTimes(1);
  expect(stopEnv).toHaveBeenCalledWith(1);
  expect(stats).toMatchObject({ released: 1, failed: 0 });
});

// 這條擋住的是「順手把別人也收了」：running 的環境正被人使用，idle/error 沒有資源待收。
test('只收 setting_up，不碰 running／idle／error 的環境', async () => {
  await mkEnv(1, 'running', 21005);
  await mkEnv(2, 'idle');
  const stats = await releaseInterruptedSetups({ stopEnv });
  expect(stopEnv).not.toHaveBeenCalled();
  expect(stats).toMatchObject({ released: 0, failed: 0 });
});

// stopEnv 失敗多半是 docker 不通，此時容器去留未知：照樣標 idle 並歸還埠，就是親手製造
// 「DB 說埠是空的、容器還綁著」的撞埠情境。退回舊行為標 error 交人工才是安全的一邊。
test('收拾失敗 → 退回標 error 交人工，而不是歸還埠', async () => {
  await mkEnv(1, 'setting_up', 21005);
  stopEnv.mockRejectedValue(new Error('docker daemon unreachable'));
  const stats = await releaseInterruptedSetups({ stopEnv });
  expect(stats).toMatchObject({ released: 0, failed: 1 });
  const { rows: [env] } = await dbModule.query('SELECT status, error_msg, port FROM odoo_envs WHERE project_id=1');
  expect(env.status).toBe('error');
  expect(env.error_msg).toContain('docker daemon unreachable');
  expect(env.port).toBe(21005); // 埠不得在容器去留未知時歸還
});

// 留在 setting_up 是最糟的結局：前端會一直顯示「建立中」轉圈，而沒有任何路徑會再推進它。
test('無論成功失敗，都不得把環境留在 setting_up', async () => {
  await mkEnv(1, 'setting_up');
  stopEnv.mockRejectedValue(new Error('boom'));
  await releaseInterruptedSetups({ stopEnv });
  const { rows: [env] } = await dbModule.query('SELECT status FROM odoo_envs WHERE project_id=1');
  expect(env.status).not.toBe('setting_up');
});

test('沒有建立中的環境時完全不碰 docker', async () => {
  const stats = await releaseInterruptedSetups({ stopEnv });
  expect(stopEnv).not.toHaveBeenCalled();
  expect(stats).toMatchObject({ released: 0, failed: 0 });
});
