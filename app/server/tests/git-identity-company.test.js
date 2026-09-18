/**
 * git-identity-company.test.js — GIT 憑證的「個人 → 公司」退回（規格 §6）
 *
 * 順序本身就是規格：個人優先是為了「推上去看得出是誰」，
 * 平台管理員刻意不退回（09-14 裁決 P4）是因為他沒有公司可退，
 * 而悄悄退到某家公司的憑證會讓 commit 掛上錯誤的身分。
 */
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.APP_SECRET = 'test-app-secret';

let dbModule, buildGitEnv, NoGitCredentialError, encrypt;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ buildGitEnv, NoGitCredentialError } = require('../lib/git-identity'));
  ({ encrypt } = require('../lib/crypto'));

  const one = async (sql, params) => (await dbModule.query(sql, params)).rows[0];

  const coId = (await one(
    `INSERT INTO companies (name, is_active, git_pat_enc, git_login, git_name, git_email)
     VALUES ('甲公司', true, $1, 'company-bot', '甲公司機器人', 'bot@jia.example') RETURNING id`,
    [encrypt('COMPANY_PAT')]
  )).id;
  const noPatCoId = (await one(
    "INSERT INTO companies (name, is_active) VALUES ('沒設PAT公司', true) RETURNING id"
  )).id;

  // 有個人 PAT、也屬於有 PAT 的公司
  await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, role, company_id, github_pat_enc, github_login, git_name, git_email)
     VALUES ('both','x','兩者都有','user',$1,$2,'me','我','me@example.com')`,
    [coId, encrypt('PERSONAL_PAT')]
  );
  // 沒個人 PAT、屬於有 PAT 的公司
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('onlyco','x','只有公司','user',$1)",
    [coId]
  );
  // 沒個人 PAT、公司也沒 PAT
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role, company_id) VALUES ('neither','x','都沒有','user',$1)",
    [noPatCoId]
  );
  // 平台管理員：沒個人 PAT、沒公司
  await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name, role) VALUES ('plat','x','平台管理員','admin')"
  );
});

afterAll(() => dbModule._setPoolForTesting(null));

const idOf = async (username) =>
  (await dbModule.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;

test('有個人 PAT → 用個人的，source=personal（與現行行為相同）', async () => {
  const env = await buildGitEnv(await idOf('both'));
  expect(env.GIT_PAT).toBe('PERSONAL_PAT');
  expect(env.GIT_AUTHOR_NAME).toBe('我');
  expect(env.source).toBe('personal');
});

test('沒個人 PAT 但公司有 → 退回公司的，source=company，身分掛公司', async () => {
  const env = await buildGitEnv(await idOf('onlyco'));
  expect(env.GIT_PAT).toBe('COMPANY_PAT');
  expect(env.GIT_AUTHOR_NAME).toBe('甲公司機器人');
  expect(env.GIT_AUTHOR_EMAIL).toBe('bot@jia.example');
  expect(env.source).toBe('company');
});

test('個人與公司都沒有 → 丟 NoGitCredentialError', async () => {
  await expect(buildGitEnv(await idOf('neither'))).rejects.toThrow(NoGitCredentialError);
});

test('平台管理員沒有公司可退，一律擋下（09-14 裁決 P4）', async () => {
  await expect(buildGitEnv(await idOf('plat'))).rejects.toThrow(NoGitCredentialError);
});

test('不存在的 user 一樣擋下', async () => {
  await expect(buildGitEnv(999999)).rejects.toThrow(NoGitCredentialError);
});

test('source 不可列舉：整包展開進子行程 env 時不會多出一個 source 變數', async () => {
  const env = await buildGitEnv(await idOf('both'));
  expect(env.source).toBe('personal');              // 讀得到
  expect(Object.keys(env)).not.toContain('source');  // 但展開拿不到
  expect({ ...env }.source).toBeUndefined();
});
