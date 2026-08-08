// 意圖：回收機制的兩個「靜默失效」缺口。兩者的共通點是壞掉時完全沒有訊號，只會表現成
// 「沒幾個測試區卻說併發已滿」——而那個症狀不指向任何一邊。
//   1. 回收門檻的設定值打錯字（'20h'、'twenty'）→ parseInt 得 NaN → `NaN > 0` 為 false →
//      兩個條件都不進 conds → 整段查詢被跳過、永不回收（改動前 NaN 進 SQL 會當場報錯＝fail loud）。
//   2. 建置失敗（status='error'）的環境仍握著埠租約，而三條回收路徑的 WHERE 全是 status='running'。
//      _failEnv 已改成當場歸還，這裡測的是「那之前留下的既有 error 列」也要收得回。
const { newDb } = require('pg-mem');

jest.mock('../pipeline/git', () => ({ ensureTestingBranch: jest.fn() }));
jest.mock('../lib/project-vpn', () => ({ startProjectVpns: jest.fn().mockResolvedValue(), stopProjectVpns: jest.fn().mockResolvedValue() }));
jest.mock('../lib/nginx-map', () => ({
  syncNginxMap: jest.fn().mockResolvedValue({ ok: true }),
  syncNginxMapDebounced: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../lib/docker-env', () => {
  const actual = jest.requireActual('../lib/docker-env');
  return {
    ...actual,
    stopContainer: jest.fn().mockResolvedValue({ code: 0 }),
    removeContainer: jest.fn().mockResolvedValue(undefined),
    containerLogs: jest.fn().mockResolvedValue(''),
  };
});

let dbModule, envAgent;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  envAgent = require('../pipeline/env-agent');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  await dbModule.query('DELETE FROM odoo_envs');
  await dbModule.query('DELETE FROM projects');
});

async function mkEnv(name, status, port) {
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, folder_name) VALUES ($1,'17.0',$1) RETURNING id", [name]
  );
  await dbModule.query(
    "INSERT INTO odoo_envs (project_id, status, port, started_at, updated_at, last_active_at) VALUES ($1,$2,$3,NOW(),NOW(),NOW())",
    [p.id, status, port]
  );
  return p.id;
}

describe('回收門檻設定值打錯字不得靜默關掉安全閥（Rule 12）', () => {
  const prev = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const setEnv = (k, v) => { if (!(k in prev)) prev[k] = process.env[k]; process.env[k] = v; };

  test("非數字（'20h'）→ 退回預設值並吼一聲，不得回 NaN 讓整段回收被跳過", () => {
    setEnv('ENV_MAX_LIFETIME_HOURS', '20h');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const v = envAgent._envInt('ENV_MAX_LIFETIME_HOURS', 20);
      expect(Number.isNaN(v)).toBe(false);   // NaN → `NaN > 0` 為 false → 條件整個消失
      expect(v).toBe(20);
      expect(spy).toHaveBeenCalled();        // 靜默退回等於同一個 bug 換個地方發作
    } finally { spy.mockRestore(); }
  });

  test('合法數字照用（含 0＝明確停用，不可被當成打錯字吃掉）', () => {
    setEnv('ENV_IDLE_TIMEOUT_MIN', '0');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(envAgent._envInt('ENV_IDLE_TIMEOUT_MIN', 45)).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    setEnv('ENV_IDLE_TIMEOUT_MIN', '90');
    expect(envAgent._envInt('ENV_IDLE_TIMEOUT_MIN', 45)).toBe(90);
  });

  test('未設定 → 用預設值（不吼，那是正常狀態）', () => {
    setEnv('ENV_MAX_LIFETIME_HOURS', '');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(envAgent._envInt('ENV_MAX_LIFETIME_HOURS', 20)).toBe(20);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

describe('建置失敗留下的 error 列不得永久佔住埠', () => {
  test("sweepIdleEnvs 收回 status='error' 卻仍握著租約的埠", async () => {
    const pid = await mkEnv('failed', 'error', 21005);
    const r = await envAgent.sweepIdleEnvs({ idleMin: 0, maxHours: 0, externalIdleMin: 0 });
    const { rows: [env] } = await dbModule.query('SELECT status, port FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.port).toBeNull();
    expect(env.status).toBe('error');   // 只歸還租約，不改寫失敗的事實（error_msg 還要給人看）
    expect(r.orphanPortsReleased).toBe(1);
  });

  test('running 的環境不受影響（別把還在用的人一起收掉）', async () => {
    const pid = await mkEnv('alive', 'running', 21006);
    await envAgent.sweepIdleEnvs({ idleMin: 0, maxHours: 0, externalIdleMin: 0 });
    const { rows: [env] } = await dbModule.query('SELECT status, port FROM odoo_envs WHERE project_id=$1', [pid]);
    expect(env.status).toBe('running');
    expect(env.port).toBe(21006);
  });
});
