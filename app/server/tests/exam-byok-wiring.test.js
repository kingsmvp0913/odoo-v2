/**
 * exam-byok-wiring.test.js — 判題時用「那一頁記下的人」的憑證（規格 §3.2、§3.3）
 *
 * buildClaudeAuthEnv 本身的每條分支已有 claude-auth-per-company.test.js 逐條釘死。
 * 這支只驗接線：worker 有沒有拿那一頁的 user_id 去問、問到的憑證有沒有真的送到
 * 兩支 AI 手上、以及沒有 key 時會不會退回廠商的訂閱。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');

const mockExtract = jest.fn();
const mockChallenge = jest.fn();
const mockBuildAuth = jest.fn();
jest.mock('../lib/exam/review', () => {
  const actual = jest.requireActual('../lib/exam/review');
  return { ...actual, extractPage: (...a) => mockExtract(...a) };
});
jest.mock('../lib/exam/challenge', () => ({ challengePage: (...a) => mockChallenge(...a) }));
jest.mock('../lib/claude-auth', () => ({ buildClaudeAuthEnv: (...a) => mockBuildAuth(...a) }));

const { runQueue } = require('../lib/exam/worker');

let dbModule, bankId, uploadDir, custUserId, noKeyUserId;

const pageOf = () => ({
  readable: true, page: '', note: '',
  questions: [{
    no: 1, question: 'Q one', question_zh: '問一', type: 'single', has_image: false,
    options: [{ letter: 'A', text: 'aa', text_zh: '啊' }, { letter: 'B', text: 'bb', text_zh: '玻' }],
  }],
});
const verdictOf = () => ({
  readable: true, page: '', note: '',
  questions: [{
    no: 1, question: 'Q one', question_zh: '問一', type: 'single',
    options: [{ letter: 'A', text: 'aa', text_zh: '啊' }, { letter: 'B', text: 'bb', text_zh: '玻' }],
    their_answer: ['B'], refuted: false, correct_answer: ['B'], confidence: 95,
    reason: 'r', evidence: [], rejected_refs: [],
  }],
});

async function addUpload(page, userId) {
  const rel = path.join('exam_1', `${page}.jpg`);
  fs.mkdirSync(path.join(uploadDir, 'exam_1'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, rel), Buffer.from([0xff, 0xd8, 0xff]));
  await dbModule.query(
    `INSERT INTO exam_uploads (bank_id, page, answer_raw, image_path, user_id)
     VALUES ($1,$2,'B',$3,$4)`, [bankId, page, rel, userId]);
}
const uploadRow = async (page) => (await dbModule.query(
  `SELECT status, error FROM exam_uploads WHERE page = $1`, [page])).rows[0];

beforeAll(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-wire-up-'));
  process.env.UPLOAD_DIR = uploadDir;
  process.env.EXAM_CONCURRENCY = '1';
  process.env.EXAM_IDLE_WAIT_MS = '5';
  process.env.EXAM_IDLE_ROUNDS = '0';

  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const b = await dbModule.query(
    `INSERT INTO exam_banks (label, odoo_version) VALUES ('wire','19') RETURNING id`);
  bankId = b.rows[0].id;
  // user_id 有 FK 到 users：假 id 插不進去（而那個 FK 正是我們要的——帳號刪掉時
  // 這一欄要變 null，不該連帶刪掉考試紀錄）
  const mkUser = async (name) => (await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, role)
     VALUES ($1,'unused',$1,'user') RETURNING id`, [name])).rows[0].id;
  custUserId = await mkUser('cust-with-key');
  noKeyUserId = await mkUser('cust-without-key');
});

afterAll(() => {
  dbModule._setPoolForTesting(null);
  fs.rmSync(uploadDir, { recursive: true, force: true });
  delete process.env.UPLOAD_DIR;
  delete process.env.EXAM_CONCURRENCY;
  delete process.env.EXAM_IDLE_WAIT_MS;
  delete process.env.EXAM_IDLE_ROUNDS;
});

beforeEach(() => {
  mockExtract.mockReset();
  mockChallenge.mockReset();
  mockBuildAuth.mockReset();
  mockExtract.mockResolvedValue({ page: pageOf(), model: 'm' });
  mockChallenge.mockResolvedValue({ verdict: verdictOf(), model: 'm' });
});

test('拿那一頁記下的人去解憑證，解到的憑證送進兩支 AI', async () => {
  mockBuildAuth.mockResolvedValue({ ANTHROPIC_API_KEY: 'cust-key' });
  await addUpload('1', custUserId);

  await runQueue(dbModule, { bankId });

  expect(mockBuildAuth).toHaveBeenCalledWith(custUserId);
  expect(mockExtract.mock.calls[0][0]).toMatchObject({ authEnv: { ANTHROPIC_API_KEY: 'cust-key' } });
  expect(mockChallenge.mock.calls[0][0]).toMatchObject({ authEnv: { ANTHROPIC_API_KEY: 'cust-key' } });
  expect((await uploadRow('1')).status).toBe('done');
});

// 本機上傳沒有記下人。必須以 null 去問（buildClaudeAuthEnv 對 null 的約定是
// 「用平台訂閱且完全不查 DB」），不可以是 undefined——那會讓落點取決於巧合。
test('沒記下人 → 以 null 解憑證，等於平台訂閱', async () => {
  mockBuildAuth.mockResolvedValue({ CLAUDE_CODE_OAUTH_TOKEN: 'platform' });
  await addUpload('2', null);

  await runQueue(dbModule, { bankId });

  expect(mockBuildAuth).toHaveBeenCalledWith(null);
  expect(mockExtract.mock.calls[0][0].authEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'platform' });
});

// ⚠ 這是整支最重要的一條。靜默退回平台＝廠商替客戶付錢，不會報錯，只會出現在
// 月底帳單上。所以「沒 key」必須是**一次 AI 都沒跑**，而不是跑完再說。
test('客戶公司沒設 key → 那一頁 failed，而且一次 AI 都沒呼叫', async () => {
  mockBuildAuth.mockRejectedValue(Object.assign(
    new Error('這家公司還沒有設定 Anthropic API key，AI 無法執行。請公司管理員在設定頁填入。'),
    { code: 'NO_ANTHROPIC_KEY' }));
  await addUpload('3', noKeyUserId);

  await runQueue(dbModule, { bankId });

  expect(mockExtract).not.toHaveBeenCalled();
  expect(mockChallenge).not.toHaveBeenCalled();
  const row = await uploadRow('3');
  expect(row.status).toBe('failed');
  expect(row.error).toContain('Anthropic API key');
});
