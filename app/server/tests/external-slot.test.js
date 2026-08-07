// 意圖：對外子網域是「按需借用的檢視名額」，載體必須是獨立欄位而非由 port 推導——
// port 是 pipeline 也在用的內部資源，兩者綁在一起就回到「pipeline 吃掉對外名額」的老問題。
const { newDb } = require('pg-mem');

let dbModule, acquireExternalSlot, releaseExternalSlot, findReclaimableSlot;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ acquireExternalSlot, releaseExternalSlot, findReclaimableSlot } = require('../lib/external-slot'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });

test('migrate 後 odoo_envs 有 external_slot 欄位，預設 NULL', async () => {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('a','17.0') RETURNING id"
  );
  await dbModule.query("INSERT INTO odoo_envs (project_id, status) VALUES ($1,'idle')", [p.id]);
  const { rows: [env] } = await dbModule.query(
    'SELECT external_slot FROM odoo_envs WHERE project_id=$1', [p.id]
  );
  expect(env.external_slot).toBeNull();
});

// 意圖：migrate 走 add-if-missing，重複執行必須冪等——正式機每次啟動都會跑。
test('重複 migrate 不炸', async () => {
  await expect(dbModule.migrate()).resolves.not.toThrow();
});

beforeEach(async () => {
  await dbModule.query('DELETE FROM odoo_envs');
  await dbModule.query('DELETE FROM projects');
});

// 每個環境給不同的內部埠：pg-mem 對 partial unique index 的行為不保證，
// 全部塞同一個 port 會在「有實作」的版本上撞 23505，讓測試以無關的理由變紅。
let _portSeq = 21000;
async function mkEnv(name, status = 'running') {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ($1,'17.0') RETURNING id", [name]
  );
  await dbModule.query(
    'INSERT INTO odoo_envs (project_id, status, port, last_active_at) VALUES ($1,$2,$3,NOW())',
    [p.id, status, _portSeq++]
  );
  return p.id;
}

const C3 = { count: 3 };

test('無人持有 → 借到最低的 slot 0', async () => {
  const a = await mkEnv('a');
  expect(await acquireExternalSlot(a, C3)).toBe(0);
});

test('slot 寫進 odoo_envs.external_slot', async () => {
  const a = await mkEnv('a');
  await acquireExternalSlot(a, C3);
  const { rows: [env] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [a]);
  expect(env.external_slot).toBe(0);
});

test('0、1 已被持有 → 借到 2', async () => {
  await acquireExternalSlot(await mkEnv('a'), C3);
  await acquireExternalSlot(await mkEnv('b'), C3);
  expect(await acquireExternalSlot(await mkEnv('c'), C3)).toBe(2);
});

// 意圖：這是租約制的核心——還回去的名額必須真的能再借出，否則池子單向耗盡。
test('releaseExternalSlot 後該 slot 回到池中', async () => {
  const a = await mkEnv('a'); await acquireExternalSlot(a, C3);
  await acquireExternalSlot(await mkEnv('b'), C3);
  await releaseExternalSlot(a);
  expect(await acquireExternalSlot(await mkEnv('c'), C3)).toBe(0);
});

// 意圖：重複點「開啟測試區」不得換 slot——換了會讓使用者已經開著的分頁指向別人的環境。
test('已持有 slot 者再借 → 回同一個 slot，不換號', async () => {
  const a = await mkEnv('a');
  expect(await acquireExternalSlot(a, C3)).toBe(0);
  await acquireExternalSlot(await mkEnv('b'), C3); // 佔掉 1
  expect(await acquireExternalSlot(a, C3)).toBe(0);
});

// 意圖：剛借出的名額不得被下一輪閒置回收立刻收走。last_active_at 是「人在瀏覽」的證據，
// 借 slot 這個動作本身就是證據——不寫的話會沿用上一輪的舊值而被誤判為閒置。
test('借 slot 會把 last_active_at 推到現在', async () => {
  const a = await mkEnv('a');
  await dbModule.query("UPDATE odoo_envs SET last_active_at=NOW() - interval '90 minutes' WHERE project_id=$1", [a]);
  await acquireExternalSlot(a, C3);
  const { rows: [r] } = await dbModule.query(
    "SELECT last_active_at > NOW() - interval '1 minute' AS fresh FROM odoo_envs WHERE project_id=$1", [a]
  );
  expect(r.fresh).toBe(true);
});

// 意圖：撞 partial UNIQUE 時要自動換下一個，而不是把 23505 丟給使用者。
// pg-mem 不支援 partial index，故注入「第一次寫入必撞」的 stub 驗重取路徑。
test('寫入撞 UNIQUE（23505）→ 自動換下一個 slot', async () => {
  const a = await mkEnv('a');
  let first = true;
  const slot = await acquireExternalSlot(a, {
    count: 3,
    claim: async (projectId, s) => {
      if (first) { first = false; const e = new Error('dup'); e.code = '23505'; throw e; }
      await dbModule.query('UPDATE odoo_envs SET external_slot=$2 WHERE project_id=$1', [projectId, s]);
      return true;
    },
  });
  expect(slot).toBe(1);
});

test('池滿且無閒置可徵收 → 拋錯，訊息含名額數', async () => {
  await acquireExternalSlot(await mkEnv('a'), { count: 1 });
  await expect(acquireExternalSlot(await mkEnv('b'), { count: 1 })).rejects.toThrow(/名額已滿（1 個）/);
});

// 意圖：對外名額只有「人在看」時才被持有，pipeline 不持有，故徵收不需要像內部埠那樣
// 排除進行中的任務——被徵收的只是「沒人在看的那個分頁」，環境本身不受影響。
test('池滿 + 有對外閒置者 → 徵收讓位，環境本身不停', async () => {
  const a = await mkEnv('a');
  await acquireExternalSlot(a, { count: 1 });
  await dbModule.query("UPDATE odoo_envs SET last_active_at=NOW() - interval '60 minutes' WHERE project_id=$1", [a]);

  const b = await mkEnv('b');
  expect(await acquireExternalSlot(b, { count: 1, idleMin: 20 })).toBe(0);

  const { rows: [old] } = await dbModule.query('SELECT external_slot, status FROM odoo_envs WHERE project_id=$1', [a]);
  expect(old.external_slot).toBeNull();
  expect(old.status).toBe('running');   // 只收名額，不停環境
});

test('池滿 + 對外都還活躍 → 拋錯，不徵收任何人', async () => {
  const a = await mkEnv('a');
  await acquireExternalSlot(a, { count: 1 });
  await expect(acquireExternalSlot(await mkEnv('b'), { count: 1, idleMin: 20 })).rejects.toThrow(/名額已滿/);
  const { rows: [old] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [a]);
  expect(old.external_slot).toBe(0);
});

// 意圖：背景回收（EXTERNAL_IDLE_MIN，2026-08-07 起預設 0＝停用）與池滿徵收是兩條路徑，
// 門檻不可共用。共用的話，把背景回收設成 0 會讓徵收條件退化成「閒置 > 0 分鐘」＝幾乎恆真，
// 池滿時連正在操作的人都被踢掉——想減少中斷反而製造更多中斷。徵收門檻獨立取自
// ENV_IDLE_TIMEOUT_PRESSURE_MIN（預設 15），與內部埠的 port-reclaim 同步。
// 這兩支刻意不傳 idleMin，走的正是正式環境的預設路徑。
test('走預設門檻：池滿時不徵收 5 分鐘前還在操作的人', async () => {
  const a = await mkEnv('a');
  await acquireExternalSlot(a, { count: 1 });
  await dbModule.query("UPDATE odoo_envs SET last_active_at=NOW() - interval '5 minutes' WHERE project_id=$1", [a]);

  await expect(acquireExternalSlot(await mkEnv('b'), { count: 1 })).rejects.toThrow(/名額已滿/);
  const { rows: [old] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [a]);
  expect(old.external_slot).toBe(0);   // 沒被踢
});

test('走預設門檻：池滿時仍徵收閒置逾 15 分的（徵收沒有整個失效）', async () => {
  const a = await mkEnv('a');
  await acquireExternalSlot(a, { count: 1 });
  await dbModule.query("UPDATE odoo_envs SET last_active_at=NOW() - interval '30 minutes' WHERE project_id=$1", [a]);

  expect(await acquireExternalSlot(await mkEnv('b'), { count: 1 })).toBe(0);
  const { rows: [old] } = await dbModule.query('SELECT external_slot FROM odoo_envs WHERE project_id=$1', [a]);
  expect(old.external_slot).toBeNull();
});

test('findReclaimableSlot 挑閒最久的那個', async () => {
  const a = await mkEnv('a'); await acquireExternalSlot(a, C3);
  const b = await mkEnv('b'); await acquireExternalSlot(b, C3);
  await dbModule.query("UPDATE odoo_envs SET last_active_at=NOW() - interval '30 minutes' WHERE project_id=$1", [a]);
  await dbModule.query("UPDATE odoo_envs SET last_active_at=NOW() - interval '99 minutes' WHERE project_id=$1", [b]);
  const v = await findReclaimableSlot({ idleMin: 20 });
  expect(v.project_id).toBe(b);
});
