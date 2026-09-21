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

// 「公司現在能不能用」的判斷本體。純函式，不碰 DB，所以放在所有 pg-mem 測試之前。
describe('isCompanyUsable（純函式，全平台唯一那一份判斷）', () => {
  const { isCompanyUsable } = require('../lib/tenant-access');
  const now = new Date('2026-06-15T00:00:00Z');
  const past = '2020-01-01T00:00:00Z';
  const future = '2999-01-01T00:00:00Z';

  test('啟用且兩端都不限 → 可用', () => {
    expect(isCompanyUsable(true, null, null, now)).toBe(true);
  });
  test('is_active 為 false → 不可用（在期間內也一樣）', () => {
    expect(isCompanyUsable(false, past, future, now)).toBe(false);
  });
  test('is_active 不是布林 true 就一律不可用（NULL／undefined 不得被當成開啟）', () => {
    for (const v of [null, undefined, 1, 'true']) {
      expect(`is_active=${String(v)}: ${isCompanyUsable(v, null, null, now)}`).toBe(`is_active=${String(v)}: false`);
    }
  });
  test('使用期間還沒開始 → 不可用', () => {
    expect(isCompanyUsable(true, future, null, now)).toBe(false);
  });
  test('使用期間已過 → 不可用', () => {
    expect(isCompanyUsable(true, null, past, now)).toBe(false);
  });
  test('在期間內 → 可用', () => {
    expect(isCompanyUsable(true, past, future, now)).toBe(true);
  });
  test('邊界當天算在期間內（>= 與 <=，不是 > 與 <）', () => {
    const t = '2026-06-15T00:00:00Z';
    expect(isCompanyUsable(true, t, null, now)).toBe(true);
    expect(isCompanyUsable(true, null, t, now)).toBe(true);
  });
  test('收 Date 物件與收字串的答案一致（pg 退 Date、pg-mem 常退字串）', () => {
    expect(isCompanyUsable(true, new Date(past), new Date(future), now)).toBe(true);
    expect(isCompanyUsable(true, new Date(future), null, now)).toBe(false);
  });

  // 這條歧異是本次統一的起點：原本 buildActor 先轉 Date 再比 null（空字串 ⇒ Invalid Date
  // ⇒ 所有比較 false ⇒ 不可用），另外三份直接看 falsy（空字串 ⇒ 不限期間 ⇒ 可用），
  // 同一家公司會因為請求走到哪條路而得到相反答案。統一取後者。
  // 這個情境在正式環境到不了：active_from／active_until 是 TIMESTAMPTZ（db.js），
  // Postgres 存不進空字串。釘它是為了讓「哪一種讀法」這個決定留在測試裡，
  // 而不是下次有人看到 `!activeFrom` 覺得不夠嚴謹就順手改掉。
  test('空字串＝沒填＝不限期間（四份抄寫當初唯一不一致的地方）', () => {
    expect(isCompanyUsable(true, '', '', now)).toBe(true);
  });
});

// 統一之後，四個呼叫端都不該再自己長出一份判斷。
// 掃描型守衛：先斷言四個檔案都真的讀到了，再斷言裡面沒有那個形狀——
// 檔名寫錯讓 readFileSync 回空字串的話，「沒有符合」會永遠是綠的。
describe('沒有人再自己抄一份判斷', () => {
  const fs = require('fs');
  const path = require('path');
  // 原本四份共通的形狀：`is_active === true` 之後換行接 `&&`。
  // 不能只認 `is_active === true`——company-admin-routes.js 另有一處是把 request body
  // 正規化成布林（`is_active === true,` 後面接逗號），那不是這條規則。
  const INLINE_COPY = /is_active\s*===\s*true\s*\n\s*&&/;
  const CALLERS = ['auth.js', 'index.js', 'company-admin-routes.js', 'lib/tenant-access.js'];

  test.each(CALLERS)('%s 讀得到且夠長（讀不到就不是綠燈，是守衛失效）', (f) => {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    expect(`${f}: ${src.length > 500}`).toBe(`${f}: true`);
  });

  test.each(CALLERS)('%s 改呼叫 isCompanyUsable，沒有自己那一份', (f) => {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    expect(`${f} 有內嵌抄寫: ${INLINE_COPY.test(src)}`).toBe(`${f} 有內嵌抄寫: false`);
    expect(`${f} 有呼叫: ${src.includes('isCompanyUsable(')}`).toBe(`${f} 有呼叫: true`);
  });
});

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
