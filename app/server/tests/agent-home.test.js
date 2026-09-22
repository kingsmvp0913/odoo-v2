/**
 * agent-home.test.js — AI 容器家目錄的租戶隔離（lib/agent-home.js）
 *
 * 要鎖住的意圖，不是「字串長得不一樣」：
 *  1. **內部公司不受影響**：算出來的路徑必須與改動前那一行（path.join(appDir,'data','agent-home',scope)）
 *     逐字相同。這是本次裁決唯一的硬驗收點——內部那些目錄裡有續接中的 claude session，
 *     路徑一換，內部所有 --resume 關卡當場從零重跑。
 *  2. **同一個專案、兩家公司拿到不同目錄**：這是外洩本身。專案 3 實際同時綁了內部與客戶。
 *  3. **系統觸發（cron／夜間改善／系統 git push）落點確定**：沒有發起人時連 DB 都不該查，
 *     才不會因為 DB 抖一下就換落點，也絕不會落進客戶的桶子。
 *  4. **查不到公司不等於可以裝作是內部**：查詢炸掉時要往外丟，不能靜默把客戶指回內部桶子
 *     （那就是把剛修好的洞再打開一次）。
 */
const path = require('path');
const { resolveHomeBucket, agentHomeDir } = require('../lib/agent-home');

const appDir = '/srv/app';
// 改動前 pipeline/sandbox-run.js 就是這一行組出家目錄的。刻意逐字抄在測試裡當基準，
// 而不是呼叫 agentHomeDir 自己跟自己比——那樣兩邊一起改壞也不會紅。
const legacyHome = (scope) => path.join(appDir, 'data', 'agent-home', scope);

describe('resolveHomeBucket：這次執行算誰的', () => {
  test('沒有發起人（cron／夜間改善／系統 git push）→ 內部桶子，而且完全不查 DB', async () => {
    const calls = [];
    const query = async (...a) => { calls.push(a); return { rows: [] }; };
    for (const actor of [null, undefined, 0, '']) {
      await expect(resolveHomeBucket(actor, { query })).resolves.toBeNull();
    }
    expect(calls).toEqual([]);
  });

  test('客戶公司的使用者 → company-<公司id>', async () => {
    const query = async () => ({ rows: [{ id: 2, is_internal: false }] });
    await expect(resolveHomeBucket(31, { query })).resolves.toBe('company-2');
  });

  test('內部公司的使用者 → 內部桶子（null）', async () => {
    const query = async () => ({ rows: [{ id: 1, is_internal: true }] });
    await expect(resolveHomeBucket(7, { query })).resolves.toBeNull();
  });

  test('查不到公司（平台管理員沒有公司、遷移前的舊帳號）→ 內部桶子', async () => {
    const query = async () => ({ rows: [] });
    await expect(resolveHomeBucket(1, { query })).resolves.toBeNull();
  });

  test('查詢炸掉 → 往外丟，不得靜默退回內部桶子', async () => {
    const query = async () => { throw new Error('DB 斷線'); };
    await expect(resolveHomeBucket(31, { query })).rejects.toThrow('DB 斷線');
  });

  test('只用 users JOIN companies 的 company_id 判斷，帶的參數是這個人的 id', async () => {
    const calls = [];
    const query = async (sql, params) => { calls.push([sql, params]); return { rows: [{ id: 2, is_internal: false }] }; };
    await resolveHomeBucket(31, { query });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatch(/FROM users u JOIN companies c ON c\.id = u\.company_id/);
    expect(calls[0][1]).toEqual([31]);
  });
});

describe('agentHomeDir：路徑形狀', () => {
  test('內部（bucket=null）與改動前那一行逐字相同——四種 scope 全部比對', () => {
    for (const scope of ['project-3', 'project-11', 'none', 'internal-audit', 'internal-fix']) {
      expect(agentHomeDir(appDir, scope, null)).toBe(legacyHome(scope));
    }
  });

  test('同一個專案、兩家公司 → 不同目錄，且客戶的目錄不在內部目錄底下', () => {
    const internal = agentHomeDir(appDir, 'project-3', null);
    const customer = agentHomeDir(appDir, 'project-3', 'company-2');
    expect(customer).not.toBe(internal);
    expect(customer).toBe(path.join(appDir, 'data', 'agent-home', 'company-2', 'project-3'));
    // 客戶的家目錄不能是內部家目錄的子路徑：掛載掛的是家目錄本身，
    // 落在內部底下等於把內部那一整包又送回客戶眼前。
    expect(path.relative(internal, customer).startsWith('..')).toBe(true);
    // 兩家客戶之間同理
    expect(agentHomeDir(appDir, 'project-3', 'company-5')).not.toBe(customer);
  });

  test('桶子名稱不合法 → 丟例外（擋路徑穿越）', () => {
    for (const bad of ['company-0', 'company-2/../company-1', '../x', 'company', 'company-2a', '']) {
      expect(() => agentHomeDir(appDir, 'project-3', bad)).toThrow(/桶子名稱不合法/);
    }
  });

  test('scope 不合法 → 丟例外（與通行證簽發共用 scopeKind 那一套判法）', () => {
    expect(() => agentHomeDir(appDir, 'project-0', null)).toThrow(/scope/);
    expect(() => agentHomeDir(appDir, '../../etc', 'company-2')).toThrow(/scope/);
  });
});

test('sandbox-run.js 不得自己再組一次家目錄路徑（只能經 agentHomeDir）', () => {
  // 這條守的是回歸：只要有人把 path.join(...,'agent-home',scope) 貼回 sandbox-run.js，
  // 公司那一層就被繞過，而且不會有任何行為測試變紅（路徑照樣存在、容器照樣跑起來）。
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'pipeline', 'sandbox-run.js'), 'utf8');
  expect(src).not.toMatch(/['"]agent-home['"]/);   // 路徑字面量（require 的模組名不算）
  expect(src).toMatch(/agentHomeDir\(APP_DIR, scope, homeBucket\)/);
});
