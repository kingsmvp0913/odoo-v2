const { newDb } = require('pg-mem');
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
});
