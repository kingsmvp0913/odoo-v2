const { newDb } = require('pg-mem');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.APP_SECRET = 'test-app-secret';
const { encrypt } = require('../lib/crypto');

let dbModule, gitId;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  gitId = require('../lib/git-identity');
});
afterAll(() => dbModule._setPoolForTesting(null));

test('askpassAnswer：Username 提示回 x-access-token、其餘回 token', () => {
  expect(gitId.askpassAnswer("Username for 'https://github.com': ", 'TK')).toBe('x-access-token');
  expect(gitId.askpassAnswer("Password for 'https://x@github.com': ", 'TK')).toBe('TK');
});

test('git-askpass.sh 在 git 追蹤為可執行（100755）——POSIX 的 git 直接 exec GIT_ASKPASS，缺執行位元會 Permission denied', () => {
  // 檢查 git index/tree 的 mode（跨平台不受 Windows 檔案系統無執行位元影響）
  const out = execFileSync('git', ['ls-files', '-s', 'app/server/lib/git-askpass.sh'], {
    cwd: path.resolve(__dirname, '..', '..', '..'), encoding: 'utf8',
  });
  expect(out.split(/\s+/)[0]).toBe('100755');
});

test('buildGitEnv：無 PAT → throw NoGitCredentialError', async () => {
  const { rows } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ('u1','h','U1') RETURNING id`
  );
  await expect(gitId.buildGitEnv(rows[0].id)).rejects.toMatchObject({ code: 'NO_GIT_CRED' });
});

test('buildGitEnv：有 PAT → 回注入 env（token 解密、身分帶入）', async () => {
  const { rows } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, github_pat_enc, github_login, git_name, git_email)
     VALUES ('u2','h','U2',$1,'bob','Bob','bob@corp.com') RETURNING id`, [encrypt('secrettoken')]
  );
  const env = await gitId.buildGitEnv(rows[0].id);
  expect(env.GIT_PAT).toBe('secrettoken');
  expect(env.GIT_AUTHOR_NAME).toBe('Bob');
  expect(env.GIT_AUTHOR_EMAIL).toBe('bob@corp.com');
  expect(env.GIT_COMMITTER_NAME).toBe('Bob');
  expect(env.GIT_COMMITTER_EMAIL).toBe('bob@corp.com');
  expect(env.GIT_ASKPASS).toMatch(/git-askpass\.(cmd|sh)$/);
  expect(env.GIT_CONFIG_COUNT).toBe('1');
  expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
  expect(env.GIT_CONFIG_VALUE_0).toBe('');
  expect(env.GIT_TERMINAL_PROMPT).toBe('0');
});
