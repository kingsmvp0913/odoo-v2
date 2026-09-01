const { newDb } = require('pg-mem');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: (...a) => mockRunClaude(...a) }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn().mockResolvedValue(undefined) }));

let dbModule, chatTitle, userId, projectId;

const reply = text => ({ text, usage: {}, durationMs: 10 });

async function makeChat(title) {
  const { rows: [chat] } = await dbModule.query(
    'INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, $2, $3) RETURNING id',
    [projectId, title, userId]
  );
  return chat.id;
}

const titleOf = async id =>
  (await dbModule.query('SELECT title FROM project_chats WHERE id = $1', [id])).rows[0].title;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: [user] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('titler', $1, 'T') RETURNING id", [hash]
  );
  userId = user.id;
  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('TitleProj', '17.0') RETURNING id"
  );
  projectId = proj.id;
  chatTitle = require('../pipeline/chat-title');
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => mockRunClaude.mockReset());

test('預設標題的對話會被改成 AI 產的標題', async () => {
  const id = await makeChat('新對話');
  mockRunClaude.mockResolvedValue(reply('報價單折扣算錯'));
  const result = await chatTitle.maybeGenerateTitle(id, '折扣怎麼算錯了', '因為稅別設定', userId);
  expect(result).toBe('報價單折扣算錯');
  expect(await titleOf(id)).toBe('報價單折扣算錯');
});

// 這是整個功能的核心約束：使用者自己取的名字絕對不能被蓋掉。
test('使用者自訂過的標題不動，也不浪費一次呼叫', async () => {
  const id = await makeChat('我自己取的名字');
  const result = await chatTitle.maybeGenerateTitle(id, '問題', '回答', userId);
  expect(result).toBeNull();
  expect(await titleOf(id)).toBe('我自己取的名字');
  expect(mockRunClaude).not.toHaveBeenCalled();
});

// 產標題要花幾秒，這期間使用者可能自己改了名。無條件寫入會把他剛打的字蓋掉且毫無痕跡。
test('產標題期間使用者自己改名 → 不覆蓋', async () => {
  const id = await makeChat('新對話');
  mockRunClaude.mockImplementation(async () => {
    await dbModule.query('UPDATE project_chats SET title = $1 WHERE id = $2', ['使用者手動改的', id]);
    return reply('AI 想取的標題');
  });
  const result = await chatTitle.maybeGenerateTitle(id, '問題', '回答', userId);
  expect(result).toBeNull();
  expect(await titleOf(id)).toBe('使用者手動改的');
});

// 自動命名失敗絕不能弄壞對話——呼叫端沒有包 try/catch。
test('AI 呼叫失敗只回 null，不丟例外、標題維持預設', async () => {
  const id = await makeChat('新對話');
  mockRunClaude.mockRejectedValue(new Error('claude 掛了'));
  await expect(chatTitle.maybeGenerateTitle(id, '問題', '回答', userId)).resolves.toBeNull();
  expect(await titleOf(id)).toBe('新對話');
});

test('AI 回空字串 → 不寫入', async () => {
  const id = await makeChat('新對話');
  mockRunClaude.mockResolvedValue(reply('   '));
  expect(await chatTitle.maybeGenerateTitle(id, '問題', '回答', userId)).toBeNull();
  expect(await titleOf(id)).toBe('新對話');
});

// AI 還沒回話時的內容通常只是一張截圖或「幫我看一下」，命不出有意義的標題。
test('AI 回覆是空的 → 不呼叫也不改名', async () => {
  const id = await makeChat('新對話');
  expect(await chatTitle.maybeGenerateTitle(id, '幫我看一下', '', userId)).toBeNull();
  expect(mockRunClaude).not.toHaveBeenCalled();
});

describe('sanitize：模型愛加的贅字要清掉，否則側欄直接顯示那些字', () => {
  test.each([
    ['標題：折扣算錯', '折扣算錯'],
    ['「折扣算錯」', '折扣算錯'],
    ['"折扣算錯"', '折扣算錯'],
    ['折扣算錯\n這個標題描述了…', '折扣算錯'],
    ['\n\n  折扣算錯  ', '折扣算錯'],
  ])('%s → %s', (raw, want) => expect(chatTitle.sanitize(raw)).toBe(want));

  test('過長會截斷到上限', () => {
    expect(chatTitle.sanitize('字'.repeat(80))).toHaveLength(chatTitle.MAX_LEN);
  });
});
