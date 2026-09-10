// 意圖（Rule 9）：部署第一步是 `git fetch origin <branch>`，抓的是客戶的**私有** repo。
// 這一步沒帶 PAT 的話 git 會轉去要互動輸入，在無 tty 的伺服器上直接死成
// "could not read Username for 'https://github.com'"，整個部署在還沒連上客戶機之前就失敗。
// 平台其餘 4 個 git fetch 都帶憑證，只有部署這支曾經漏掉。
const { newDb } = require('pg-mem');

const mockExecFile = jest.fn();
jest.mock('child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));

process.env.JWT_SECRET = 'test-deploy-fetch-auth';
process.env.APP_SECRET = 'test-app-secret';

let dbModule, defaultGit, userId;

// promisify(execFile) 走的是 callback 形式，所以假的也要照 callback 回。
function respond(stdout = '') {
  return (...args) => { args[args.length - 1](null, { stdout, stderr: '' }); };
}

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { encrypt } = require('../lib/crypto');
  const { rows: [u] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, github_pat_enc, github_login)
     VALUES ('u','h','U',$1,'u') RETURNING id`,
    [encrypt('ghp_secret')]
  );
  userId = u.id;
  await dbModule.query("INSERT INTO projects (name, odoo_version) VALUES ('p','17.0')");
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path) VALUES (1,'main','https://github.com/x/y.git','/repos/y')"
  );
  ({ defaultGit } = require('../lib/deploy-run'));
});

afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => mockExecFile.mockReset());

test('fetch 帶著該使用者的 PAT，rev-parse 不需要', async () => {
  mockExecFile.mockImplementation(respond('abc123\n'));
  const sha = await defaultGit({ repo_id: 1 }, userId).headSha('ai-dev');

  expect(sha).toBe('abc123');
  const fetchCall = mockExecFile.mock.calls.find(c => c[1].includes('fetch'));
  expect(fetchCall[2].env.GIT_PAT).toBe('ghp_secret');
  expect(fetchCall[2].env.GIT_ASKPASS).toBeTruthy();
});

test('沒有 gitUserId 時照舊直跑（公開 repo 不需要憑證）', async () => {
  mockExecFile.mockImplementation(respond('abc123\n'));
  await defaultGit({ repo_id: 1 }, null).headSha('ai-dev');

  const fetchCall = mockExecFile.mock.calls.find(c => c[1].includes('fetch'));
  expect(fetchCall[2].env.GIT_PAT).toBeUndefined();
});

// 原訊息只說「讀不到 Username」，看的人不會聯想到要去設定填 PAT。
test('認證失敗翻成看得懂的一句', async () => {
  mockExecFile.mockImplementation((...args) => {
    const cb = args[args.length - 1];
    cb(new Error("Command failed: git fetch\nfatal: could not read Username for 'https://github.com': No such device or address"));
  });

  await expect(defaultGit({ repo_id: 1 }, userId).headSha('ai-dev'))
    .rejects.toThrow('GitHub 認證失敗，請到設定填個人 GitHub PAT');
});
