// 意圖：pipeline 每關以 headless claude -p spawn，共用一份會被刷新改寫的互動式 OAuth 憑證檔，
// 併發時互相踩空印 "Not logged in"。改由管理員在網頁設一把長效 token，加密存 DB、
// 解密後逐行程以 CLAUDE_CODE_OAUTH_TOKEN 注入。此模組是那把 token 的載入／快取／失效出口。
//
// 快取是刻意的：runClaude 必須同步取得 token（改 async 會讓 spawn 晚一個 microtask，
// 既有「呼叫後同步對 mock child 發事件」的測試會整片失效），故非同步只發生在啟動與存檔。
const { newDb } = require('pg-mem');

process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret-for-claude-auth';

let dbModule, claudeAuth, encrypt;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ encrypt } = require('../lib/crypto'));
  claudeAuth = require('../lib/claude-auth');
  await dbModule.query('INSERT INTO teams_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
});

afterAll(() => { dbModule._setPoolForTesting(null); });

beforeEach(async () => {
  await dbModule.query('UPDATE teams_settings SET claude_oauth_token_enc = NULL WHERE id = 1');
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  claudeAuth._setForTesting(null);
});

test('未設定 token → getClaudeAuthEnv 回空物件（不得塞空字串蓋掉繼承的 env var）', async () => {
  await claudeAuth.loadClaudeToken();
  expect(claudeAuth.getClaudeAuthEnv()).toEqual({});
});

test('已設定 token → 解密後以 CLAUDE_CODE_OAUTH_TOKEN 回傳', async () => {
  await dbModule.query('UPDATE teams_settings SET claude_oauth_token_enc = $1 WHERE id = 1', [encrypt('sk-oat-abc123')]);
  await claudeAuth.loadClaudeToken();
  expect(claudeAuth.getClaudeAuthEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-oat-abc123' });
});

// 快取語意：讀取端是同步的，DB 改了但沒 reset 就不該生效；reset 後才換新值。
// 這正是「管理員存檔後不必重啟 server」的實作依據。
test('DB 換了 token 但未 reset → 維持舊值；resetClaudeTokenCache 後才換新', async () => {
  await dbModule.query('UPDATE teams_settings SET claude_oauth_token_enc = $1 WHERE id = 1', [encrypt('old-token')]);
  await claudeAuth.loadClaudeToken();
  await dbModule.query('UPDATE teams_settings SET claude_oauth_token_enc = $1 WHERE id = 1', [encrypt('new-token')]);
  expect(claudeAuth.getClaudeAuthEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'old-token' });
  await claudeAuth.resetClaudeTokenCache();
  expect(claudeAuth.getClaudeAuthEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'new-token' });
});

// APP_SECRET 換過／blob 損壞：server 不能因此起不來，退回原本的憑證檔行為即可
test('密文壞掉 → 視為未設定，不得 throw（否則啟動載入會讓整台 server 掛掉）', async () => {
  await dbModule.query("UPDATE teams_settings SET claude_oauth_token_enc = 'not-a-valid-blob' WHERE id = 1");
  await expect(claudeAuth.loadClaudeToken()).resolves.toBeUndefined();
  expect(claudeAuth.getClaudeAuthEnv()).toEqual({});
});

// 官方認證優先序：ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN。
// 環境有前兩者時，UI 設的 token 會被靜默忽略——必須偵測得出來才能在介面警告，
// 否則會變成「明明設了卻沒生效」的無解狀況。
describe('shadowingEnvVar：偵測蓋過本設定的環境變數', () => {
  test('乾淨環境 → null', () => {
    expect(claudeAuth.shadowingEnvVar()).toBe(null);
  });

  test('有 ANTHROPIC_API_KEY → 回該變數名', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    expect(claudeAuth.shadowingEnvVar()).toBe('ANTHROPIC_API_KEY');
  });

  test('兩者都有 → 回優先序較高的 ANTHROPIC_AUTH_TOKEN', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-yyy';
    expect(claudeAuth.shadowingEnvVar()).toBe('ANTHROPIC_AUTH_TOKEN');
  });

  test('空字串不算設定（誤設空值不該跳假警告）', () => {
    process.env.ANTHROPIC_API_KEY = '';
    expect(claudeAuth.shadowingEnvVar()).toBe(null);
  });
});

// ── 備用憑證（另一份訂閱）──────────────────────────────────────────────
// 意圖：主帳號用量撞閘門時，pipeline 改用備用憑證繼續跑，而不是整條停下等視窗重置。
// 「目前該用哪一把」由 usage-gate 評估後設定；本模組只負責照旗標交出對應的 token，
// 且必須維持同步（runClaude 在 spawn 當下呼叫，改 async 會讓既有測試整片失效）。
describe('備用憑證切換', () => {
  beforeEach(async () => {
    await dbModule.query('UPDATE teams_settings SET claude_oauth_token_backup_enc = NULL WHERE id = 1');
    claudeAuth._setForTesting(null, null, 'primary');
  });

  test('預設用主憑證——沒人切換過就不該動到備用', async () => {
    await dbModule.query('UPDATE teams_settings SET claude_oauth_token_enc = $1, claude_oauth_token_backup_enc = $2 WHERE id = 1',
      [encrypt('primary-tok'), encrypt('backup-tok')]);
    await claudeAuth.loadClaudeToken();
    expect(claudeAuth.getActiveCredential()).toBe('primary');
    expect(claudeAuth.getClaudeAuthEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'primary-tok' });
  });

  test('切到 backup → 注入備用 token', async () => {
    await dbModule.query('UPDATE teams_settings SET claude_oauth_token_enc = $1, claude_oauth_token_backup_enc = $2 WHERE id = 1',
      [encrypt('primary-tok'), encrypt('backup-tok')]);
    await claudeAuth.loadClaudeToken();
    claudeAuth.setActiveCredential('backup');
    expect(claudeAuth.getActiveCredential()).toBe('backup');
    expect(claudeAuth.getClaudeAuthEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'backup-tok' });
  });

  // 沒貼備用卻被切過去（設定被清掉、或閘門判斷與存檔競態）時若回空物件，
  // 等於讓所有 pipeline 子行程失去憑證——比「繼續用已超標的主憑證」嚴重得多。
  test('切到 backup 但沒設備用憑證 → 退回主憑證，不得交出空物件', async () => {
    await dbModule.query('UPDATE teams_settings SET claude_oauth_token_enc = $1 WHERE id = 1', [encrypt('primary-tok')]);
    await claudeAuth.loadClaudeToken();
    claudeAuth.setActiveCredential('backup');
    expect(claudeAuth.getClaudeAuthEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'primary-tok' });
  });

  test('備用密文壞掉 → 當成沒有備用，主憑證不受影響', async () => {
    await dbModule.query("UPDATE teams_settings SET claude_oauth_token_enc = $1, claude_oauth_token_backup_enc = 'broken-blob' WHERE id = 1",
      [encrypt('primary-tok')]);
    await expect(claudeAuth.loadClaudeToken()).resolves.toBeUndefined();
    expect(claudeAuth.getClaudeAuthEnv()).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'primary-tok' });
    expect(claudeAuth.hasBackupToken()).toBe(false);
  });

  // 用量量測要拿「那一把」去打 API（不是永遠打本機憑證檔），故需要具名取用出口。
  test('getTokenFor 依名稱交出對應 token，未設定回 null', async () => {
    await dbModule.query('UPDATE teams_settings SET claude_oauth_token_enc = $1 WHERE id = 1', [encrypt('primary-tok')]);
    await claudeAuth.loadClaudeToken();
    expect(claudeAuth.getTokenFor('primary')).toBe('primary-tok');
    expect(claudeAuth.getTokenFor('backup')).toBe(null);
  });
});
