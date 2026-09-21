/**
 * tenant-company-usable.test.js — 公司停用／到期之後，不經過 HTTP 的那幾條路也要停（規格 §7）
 *
 * 第 1 部的全域閘門只擋 HTTP。AI 執行、cron 自動推進、系統觸發的 git 推送都不經過它，
 * 所以客戶停繳之後，平台還會繼續替他燒 AI 的錢、繼續替他推 code。
 * 「沒有公司」一律算可用——平台管理員沒有公司，這一點寫反會把管理員自己鎖死。
 */
const { newDb } = require('pg-mem');

// 這支測試只驗證守衛（是否擋在「還沒跑」那一步），不是真的要跑 Codex／Claude——
// 比照 agent-runner.test.js 的既有慣例 mock 掉兩個 runner，避免在有真憑證的環境
// 誤觸真正的 CLI（燒 token、拖到 timeout）。
jest.mock('../pipeline/claude-runner', () => ({
  runClaude: jest.fn(() => Promise.reject(new Error('mock: claude-runner 不應在此測試被真的呼叫'))),
  abortError: jest.fn(), stopReason: jest.fn(),
}));
jest.mock('../pipeline/codex-runner', () => ({
  runCodex: jest.fn(() => Promise.reject(new Error('mock: codex-runner 不應在此測試被真的呼叫'))),
}));

process.env.JWT_SECRET = 'test-usable-jwt';
process.env.APP_SECRET = 'test-usable-secret';

let dbModule, uOk, uOff, uExpired, uInternal, uNoCompany, uAdmin;

const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const mkCo = async (name, opts = {}) => (await one(
    `INSERT INTO companies (name, is_active, is_internal, active_from, active_until)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [name, opts.active !== false, !!opts.internal, opts.from || null, opts.until || null]
  )).id;
  const mkUser = async (username, companyId, role = 'user') => (await one(
    'INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ($1,$2,$1,$3,$4) RETURNING id',
    [username, 'x', role, companyId]
  )).id;

  uOk = await mkUser('ok', await mkCo('正常公司'));
  uOff = await mkUser('off', await mkCo('停用公司', { active: false }));
  uExpired = await mkUser('expired', await mkCo('過期公司', { until: '2020-01-01T00:00:00Z' }));
  uInternal = await mkUser('inside', await mkCo('內部', { internal: true }));
  uNoCompany = await mkUser('nocompany', null);
  uAdmin = await mkUser('platadmin', null, 'admin');
});

afterAll(() => dbModule._setPoolForTesting(null));

describe('isUserCompanyUsable', () => {
  const { isUserCompanyUsable } = require('../lib/tenant-access');

  test('公司正常 → true', async () => expect(await isUserCompanyUsable(uOk)).toBe(true));
  test('公司停用 → false', async () => expect(await isUserCompanyUsable(uOff)).toBe(false));
  test('使用期間已過 → false', async () => expect(await isUserCompanyUsable(uExpired)).toBe(false));
  test('沒有公司 → true（平台管理員沒有公司，寫反會把管理員鎖死）', async () => {
    expect(await isUserCompanyUsable(uNoCompany)).toBe(true);
    expect(await isUserCompanyUsable(uAdmin)).toBe(true);
  });
  test('不存在的 user → true（不認識的人不歸這支管，交給上游的授權擋）', async () => {
    expect(await isUserCompanyUsable(999999)).toBe(true);
  });
});

describe('isUserCompanyInternal', () => {
  const { isUserCompanyInternal } = require('../lib/tenant-access');

  test('內部公司成員 → true', async () => expect(await isUserCompanyInternal(uInternal)).toBe(true));
  test('客戶公司成員 → false', async () => expect(await isUserCompanyInternal(uOk)).toBe(false));
  test('沒有公司（平台管理員）→ true（他們本來就是內部人員）', async () => {
    expect(await isUserCompanyInternal(uAdmin)).toBe(true);
  });
});

describe('canRun：公司不可用就不發通行證、不開容器', () => {
  const { canRun } = require('../lib/agent-run-token');

  test('公司正常 → 准跑', async () => expect(await canRun('project-1', uOk)).toBe(true));
  test('公司停用 → 不准（客戶停繳之後平台不該繼續替他燒 AI 的錢）', async () => {
    expect(await canRun('project-1', uOff)).toBe(false);
  });
  test('內部工作（沒有發起人）→ 准跑', async () => {
    expect(await canRun('internal-audit', null)).toBe(true);
  });
});

describe('Codex 只給內部人員（規格 §7、子專案 0 Q3）', () => {
  const { runAgent } = require('../pipeline/agent-runner');

  test('客戶公司的人觸發 Codex → 丟例外（Codex 沒有容器保護，等於繞過整個隔離）', async () => {
    await expect(runAgent('x', { provider: 'codex', userId: uOk })).rejects.toThrow(/只能用 Claude/);
  });

  test('內部公司的人照常可以用 Codex', async () => {
    // 不真的跑 Codex，只驗它沒有在守衛這一關被擋下來
    await expect(runAgent('x', { provider: 'codex', userId: uInternal }))
      .rejects.not.toThrow(/只能用 Claude/);
  });

  test('Claude 不受影響', async () => {
    await expect(runAgent('x', { provider: 'claude', userId: uOk }))
      .rejects.not.toThrow(/只能用 Claude/);
  });
});

describe('buildGitEnv：停用公司的憑證不可用', () => {
  const { buildGitEnv, NoGitCredentialError } = require('../lib/git-identity');
  const { encrypt } = require('../lib/crypto');

  test('公司停用時不退回它的 PAT', async () => {
    await dbModule.query(
      'UPDATE companies SET git_pat_enc = $1 WHERE id = (SELECT company_id FROM users WHERE id = $2)',
      [encrypt('OFF_COMPANY_PAT'), uOff]
    );
    await expect(buildGitEnv(uOff)).rejects.toThrow(NoGitCredentialError);
  });

  test('公司正常時照常退回', async () => {
    await dbModule.query(
      'UPDATE companies SET git_pat_enc = $1 WHERE id = (SELECT company_id FROM users WHERE id = $2)',
      [encrypt('OK_COMPANY_PAT'), uOk]
    );
    const env = await buildGitEnv(uOk);
    expect(env.GIT_PAT).toBe('OK_COMPANY_PAT');
    expect(env.source).toBe('company');
  });
});
