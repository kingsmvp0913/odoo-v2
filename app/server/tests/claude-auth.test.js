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
