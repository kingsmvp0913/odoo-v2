// 意圖：這支函式決定「這一次 AI 執行的錢算誰的」。每一條分支錯了都不會報錯，
// 只會在月底的帳單上出現——所以分支要逐條釘死，不能只測快樂路徑。
//
// 優先序與 buildGitEnv 相反是刻意的：GIT 是「個人優先、沒有才退公司」，
// 這裡是「公司自己的 key 優先」——客戶自帶 key 的意思就是那筆錢算客戶的。

let mockQuery;
let mockUsable;
jest.mock('../db', () => ({ query: (...a) => mockQuery(...a) }));
jest.mock('../lib/crypto', () => ({ decrypt: (v) => `解密(${v})` }));
jest.mock('../lib/tenant-access', () => ({ isUserCompanyUsable: (...a) => mockUsable(...a) }));

const auth = require('../lib/claude-auth');

const PLATFORM = 'platform-oauth-token';
beforeEach(() => {
  auth._setForTesting(PLATFORM);
  mockUsable = async () => true;
  mockQuery = async () => ({ rows: [] });
});

// 系統觸發（cron、夜間批次、系統自動 push）沒有發起人。落點必須是平台訂閱，
// 而且**不可以查 DB**——查了就代表落點會受 DB 狀態影響，理論上可能飄到客戶的憑證上。
test('沒有發起人 → 平台訂閱，而且完全不查 DB', async () => {
  mockQuery = async () => { throw new Error('不該查 DB'); };
  expect(await auth.buildClaudeAuthEnv(null)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: PLATFORM });
  expect(await auth.buildClaudeAuthEnv(undefined)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: PLATFORM });
});

test('平台管理員（沒有公司）→ 平台訂閱', async () => {
  mockQuery = async () => ({ rows: [{ company_id: null, is_internal: null, anthropic_key_enc: null }] });
  expect(await auth.buildClaudeAuthEnv(2)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: PLATFORM });
});

// is_internal 的欄位註解原話：內部公司記號「只管 AI 用平台的訂閱付錢」。
test('內部公司 → 平台訂閱（即使它也有 key）', async () => {
  mockQuery = async () => ({ rows: [{ company_id: 1, is_internal: true, anthropic_key_enc: 'enc-x' }] });
  expect(await auth.buildClaudeAuthEnv(5)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: PLATFORM });
});

test('客戶公司有自己的 key → 用客戶的，而且只回這一把', async () => {
  mockQuery = async () => ({ rows: [{ company_id: 2, is_internal: false, anthropic_key_enc: 'enc-cust' }] });
  const env = await auth.buildClaudeAuthEnv(9);
  expect(env).toEqual({ ANTHROPIC_API_KEY: '解密(enc-cust)' });
  // 兩把都給的話，實際生效的是哪一把要靠讀者記得官方優先序——那是留給未來的人踩的坑。
  expect(`有沒有夾帶平台那把: ${'CLAUDE_CODE_OAUTH_TOKEN' in env}`).toBe('有沒有夾帶平台那把: false');
});

// ⚠ 這是整支函式最重要的一條。靜默退回平台＝廠商替客戶付錢，而且不會報錯，
// 只會在月底帳單上出現。companies.is_internal 的註解寫明那違反 Anthropic 條款。
test('客戶公司沒有 key → 丟例外，絕不退回平台訂閱', async () => {
  mockQuery = async () => ({ rows: [{ company_id: 2, is_internal: false, anthropic_key_enc: null }] });
  await expect(auth.buildClaudeAuthEnv(9)).rejects.toMatchObject({ code: 'NO_ANTHROPIC_KEY' });
});

test('客戶公司空字串 key 也算沒有，同樣丟例外', async () => {
  mockQuery = async () => ({ rows: [{ company_id: 2, is_internal: false, anthropic_key_enc: '' }] });
  await expect(auth.buildClaudeAuthEnv(9)).rejects.toMatchObject({ code: 'NO_ANTHROPIC_KEY' });
});

// 停用／到期的公司：HTTP 那側的全域閘門擋得住網頁操作，但 cron、夜間批次、系統觸發的
// 執行不經過 HTTP——與 buildGitEnv 同一個理由。
test('客戶公司已停用／過期 → 丟例外，不用它的憑證', async () => {
  mockQuery = async () => ({ rows: [{ company_id: 2, is_internal: false, anthropic_key_enc: 'enc-cust' }] });
  mockUsable = async () => false;
  await expect(auth.buildClaudeAuthEnv(9)).rejects.toMatchObject({ code: 'NO_ANTHROPIC_KEY' });
});

// 反面：使用者列查不到（帳號剛被刪、id 是髒資料）不該讓 AI 整條停擺，
// 也不該拿某家客戶的憑證去跑——退回平台訂閱是唯一不會計錯帳的落點。
test('查不到使用者 → 平台訂閱', async () => {
  mockQuery = async () => ({ rows: [] });
  expect(await auth.buildClaudeAuthEnv(999)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: PLATFORM });
});
