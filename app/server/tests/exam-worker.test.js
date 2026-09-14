const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');

// 模型呼叫全部 mock：這支測的是佇列與資料流，不是審查品質。
// 審查品質有它自己的實測（docs/superpowers/specs/2026-09-04-adversary-bench-result.md）。
const mockExtract = jest.fn();
const mockChallenge = jest.fn();
jest.mock('../lib/exam/review', () => {
  const actual = jest.requireActual('../lib/exam/review');
  return { ...actual, extractPage: (...a) => mockExtract(...a) };
});
// 挑戰模式：判斷與證據在同一次呼叫產出，所以只有一支要 mock
jest.mock('../lib/exam/challenge', () => ({ challengePage: (...a) => mockChallenge(...a) }));

const { runQueue, reclaimInterrupted } = require('../lib/exam/worker');

let dbModule, bankId, uploadDir;

const verdictOf = (qs) => ({
  readable: true, page: '', note: '',
  questions: qs.map((q, i) => ({
    no: i + 1, question: q.en, question_zh: q.zh, type: 'single',
    options: [{ letter: 'A', text: 'aa', text_zh: '啊' }, { letter: 'B', text: 'bb', text_zh: '玻' }],
    their_answer: q.their || ['B'], refuted: !!q.refuted,
    correct_answer: q.correct || ['B'], confidence: q.conf ?? 95, reason: 'r',
    evidence: q.evidence || [], rejected_refs: q.rejected || [],
  })),
});
const pageOf = (qs) => ({
  readable: true, page: '', note: '',
  questions: qs.map((q, i) => ({
    no: i + 1, question: q.en, question_zh: q.zh, type: 'single', has_image: !!q.hasImage,
    options: [{ letter: 'A', text: 'aa', text_zh: '啊' }, { letter: 'B', text: 'bb', text_zh: '玻' }],
  })),
});

async function addUpload(page, answer, name) {
  const rel = path.join('exam_1', `${page}.jpg`);
  fs.mkdirSync(path.join(uploadDir, 'exam_1'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, rel), Buffer.from([0xff, 0xd8, 0xff]));
  const r = await dbModule.query(
    `INSERT INTO exam_uploads (bank_id, page, answer_raw, responder, image_path)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [bankId, page, answer, name || null, rel]);
  return r.rows[0].id;
}

beforeAll(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-worker-'));
  process.env.UPLOAD_DIR = uploadDir;
  process.env.EXAM_CONCURRENCY = '2';
  // 正式環境是 6 輪 × 2 秒＝收工前最多等 12 秒；測試把它壓到毫秒級，
  // 否則每支測試都會撞 jest 預設的 5 秒逾時。
  process.env.EXAM_IDLE_WAIT_MS = '5';
  process.env.EXAM_IDLE_ROUNDS = '2';

  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const b = await dbModule.query(
    `INSERT INTO exam_banks (label, odoo_version) VALUES ('W','19') RETURNING id`);
  bankId = b.rows[0].id;
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
});

test('沒有待處理時不建 job', async () => {
  const r = await runQueue(dbModule, { bankId });
  expect(r).toMatchObject({ jobId: null, total: 0 });
  const jobs = await dbModule.query('SELECT COUNT(*)::int c FROM exam_jobs');
  expect(jobs.rows[0].c).toBe(0);
});

test('跑完一筆會建題目、作答與判斷', async () => {
  await addUpload('1', '第 1 題 B；第 2 題 A', '小王');
  const qs = [
    { en: 'What is a delivery order?', zh: '什麼是交貨單？', their: ['B'] },
    { en: 'Where is the reordering rule?', zh: '重訂貨規則在哪？', their: ['A'], correct: ['A'] },
  ];
  mockExtract.mockResolvedValue({ page: pageOf(qs), model: 'claude-opus-5' });
  mockChallenge.mockResolvedValue({
    verdict: verdictOf(qs),
    model: 'claude-opus-5',
  });

  const r = await runQueue(dbModule, { bankId });
  expect(r).toMatchObject({ total: 1, done: 1, failed: 0 });

  const items = await dbModule.query(`SELECT COUNT(*)::int c FROM exam_items WHERE odoo_version='19'`);
  expect(items.rows[0].c).toBe(2);
  const att = await dbModule.query(
    `SELECT no, answer_their, answer_final, responder FROM exam_attempts ORDER BY no`);
  expect(att.rows[0]).toMatchObject({ no: 1, answer_their: ['B'], answer_final: ['B'], responder: '小王' });
  const v = await dbModule.query(`SELECT COUNT(*)::int c FROM exam_verdicts WHERE kind='adversary'`);
  expect(v.rows[0].c).toBe(2);

  const up = await dbModule.query(`SELECT status FROM exam_uploads WHERE page='1'`);
  expect(up.rows[0].status).toBe('done');
});

// 同一題再考一次不可以建成新的一列，否則累積的證據散在兩列上
test('第二次遇到同一題是合併不是新增', async () => {
  await addUpload('2', 'B', null);
  const qs = [{ en: 'What is a delivery order?', zh: '什麼是交貨單？' }];
  mockExtract.mockResolvedValue({ page: pageOf(qs), model: 'claude-opus-5' });
  mockChallenge.mockResolvedValue({
    verdict: verdictOf(qs),
    model: 'claude-opus-5',
  });
  await runQueue(dbModule, { bankId });

  const items = await dbModule.query(`SELECT seen_count FROM exam_items WHERE question_en LIKE 'What is a delivery%'`);
  expect(items.rows).toHaveLength(1);
  expect(items.rows[0].seen_count).toBe(2);
});

test('只有官方確認答案命中才短路，且不寫假的 adversary', async () => {
  const { fingerprint } = require('../lib/exam/fingerprint');
  const q = 'Which answer is officially confirmed for this question?';
  const item = await dbModule.query(
    `INSERT INTO exam_items
       (odoo_version,fingerprint,question_en,options,qtype,answer_official,official_from,confidence)
     VALUES ('19',$1,$2,'[]'::jsonb,'single',$3,'manual',100) RETURNING id`,
    [fingerprint(q), q, ['A']]);
  await addUpload('3', 'B', null);
  mockExtract.mockResolvedValue({ page: pageOf([{ en: q, zh: '官方題' }]), model: 'm' });

  await runQueue(dbModule, { bankId });

  expect(mockChallenge).not.toHaveBeenCalled();
  const attempt = (await dbModule.query(
    `SELECT answer_their,answer_final FROM exam_attempts WHERE item_id=$1 ORDER BY id DESC LIMIT 1`,
    [item.rows[0].id])).rows[0];
  expect(attempt).toEqual({ answer_their: ['B'], answer_final: ['B'] });
  const verdicts = await dbModule.query(
    `SELECT id FROM exam_verdicts WHERE item_id=$1`, [item.rows[0].id]);
  expect(verdicts.rows).toEqual([]);
});

// 單筆失敗不中斷整批：實測踩過一頁逾時讓整個腳本 exit，前面的結果留在 DB
// 看起來像跑完了
test('一筆失敗不影響其他筆，且具名留下錯誤', async () => {
  await addUpload('7', 'B', null);
  await addUpload('8', 'B', null);
  mockExtract
    .mockRejectedValueOnce(new Error('審查逾時（1200s）'))
    .mockResolvedValue({ page: pageOf([{ en: 'Q8 unique question', zh: '第八題' }]), model: 'm' });
  mockChallenge.mockResolvedValue({ verdict: verdictOf([{ en: 'Q8 unique question', zh: '第八題' }]), model: 'm' });

  const r = await runQueue(dbModule, { bankId });
  expect(r.done + r.failed).toBe(2);
  expect(r.failed).toBe(1);

  const failed = await dbModule.query(`SELECT page, error FROM exam_uploads WHERE status='failed'`);
  expect(failed.rows).toHaveLength(1);
  expect(failed.rows[0].error).toMatch(/逾時/);
});

// attempts 建在審查之前（saveVerdicts 要靠它們對應題號），所以審查炸掉會留下
// 一批沒有 verdict 的孤兒：畫面上永遠「等待中」，重跑還會再建一份重複的。
// 實測踩過——模型把信心度回成 0.95 撞爛 INTEGER 欄位，整頁 4 題卡死。
test('審查中途失敗時，那一頁已建的作答要清乾淨', async () => {
  await addUpload('40', 'B,A', null);
  mockExtract.mockResolvedValue({
    page: pageOf([{ en: 'Rollback question one' }, { en: 'Rollback question two' }]), model: 'm' });
  mockChallenge.mockRejectedValue(new Error('invalid input syntax for type integer: "0.95"'));

  const r = await runQueue(dbModule, { bankId });
  expect(r.failed).toBe(1);

  const left = await dbModule.query(
    `SELECT COUNT(*)::int c FROM exam_attempts a
       JOIN exam_uploads u ON u.id = a.upload_id WHERE u.page = '40'`);
  expect(left.rows[0].c).toBe(0);

  const up = await dbModule.query(`SELECT status, error FROM exam_uploads WHERE page='40'`);
  expect(up.rows[0].status).toBe('failed');
  expect(up.rows[0].error).toMatch(/0\.95/);
});

// 同事是一頁一頁傳的（主流程，不是例外）。用開頭那份快照當全部的話，第二頁
// 得等整批跑完才開新的一批——實測兩次 POST 相差 31ms，結果是兩個各只有 1 頁的
// job，併行上限 3 完全沒有機會生效。
test('執行期間新進的頁會加入同一批，不必等整批跑完', async () => {
  await addUpload('50', 'B', null);
  let injected = false;
  mockExtract.mockImplementation(async () => {
    // 第一頁開始處理後才插入第二頁，模擬「跑到一半又有人傳圖進來」
    if (!injected) { injected = true; await addUpload('51', 'B', null); }
    return { page: pageOf([{ en: `Q for page ${injected}` }]), model: 'm' };
  });
  mockChallenge.mockResolvedValue({ verdict: verdictOf([{ en: 'Q' }]), model: 'm' });

  const r = await runQueue(dbModule, { bankId });
  expect(r.total).toBe(2);          // 開頭只看得到 1 頁，跑的時候補進第 2 頁
  expect(r.done).toBe(2);

  const left = await dbModule.query(
    `SELECT COUNT(*)::int c FROM exam_uploads WHERE page IN ('50','51') AND status <> 'done'`);
  expect(left.rows[0].c).toBe(0);

  const job = await dbModule.query(
    `SELECT pages_total FROM exam_jobs ORDER BY id DESC LIMIT 1`);
  expect(job.rows[0].pages_total).toBe(2);   // 進度分母要跟著長，不然永遠顯示 1/1
  mockExtract.mockReset();
});

// 「先從佇列取出、再標記 running」中間隔著一個 await，那個空隙足夠讓另一個 worker
// 查到同一筆還是 pending 而重複拿走。實測炸過：8 題的頁跑出 16 筆作答，同一頁判了
// 兩次、token 白燒一份，而畫面上只看得到「怎麼有兩個 8 題」。
test('同一頁不會被兩個 worker 同時認領', async () => {
  await addUpload('60', 'B', null);
  let extracts = 0;
  mockExtract.mockImplementation(async () => {
    extracts++;
    await new Promise(r => setTimeout(r, 30));   // 拉長空窗期讓競態有機會發生
    return { page: pageOf([{ en: 'Claim race question here' }]), model: 'm' };
  });
  mockChallenge.mockResolvedValue({ verdict: verdictOf([{ en: 'Claim race question here' }]), model: 'm' });

  const r = await runQueue(dbModule, { bankId });
  expect(extracts).toBe(1);      // 只跑一次判題，不是每個 worker 各跑一次
  expect(r.total).toBe(1);

  const att = await dbModule.query(`
    SELECT COUNT(*)::int c FROM exam_attempts a
      JOIN exam_uploads u ON u.id = a.upload_id WHERE u.page = '60'`);
  expect(att.rows[0].c).toBe(1);  // 一題就是一筆，不會變兩筆
  mockExtract.mockReset();
});

// 一次丟一整份考卷時，那些 POST 是在幾百毫秒內陸續落地的。worker 全部同時啟動，
// 開場撲空的那幾個若立刻結束，就只剩一個在序列跑——實測 19 頁的 job pages_total
// 是 2，併行上限 5 完全沒有機會生效。
test('開場查不到的 worker 要等一下，晚到的頁才有人接', async () => {
  await addUpload('70', 'B', null);
  mockExtract.mockImplementation(async () => {
    await new Promise(r => setTimeout(r, 40));
    return { page: pageOf([{ en: 'Late arrival question here' }]), model: 'm' };
  });
  mockChallenge.mockResolvedValue({
    verdict: verdictOf([{ en: 'Late arrival question here' }]), model: 'm' });

  // 第一頁開跑之後才進來的第二頁，要被同一批的閒置 worker 接走
  const run = runQueue(dbModule, { bankId });
  await new Promise(r => setTimeout(r, 30));
  await addUpload('71', 'B', null);
  const r = await run;

  expect(r.total).toBe(2);
  const left = await dbModule.query(
    `SELECT COUNT(*)::int c FROM exam_uploads WHERE page IN ('70','71') AND status <> 'done'`);
  expect(left.rows[0].c).toBe(0);
  mockExtract.mockReset();
});

test('讀不出題目算失敗並寫下原因', async () => {
  await addUpload('9', 'B', null);
  mockExtract.mockResolvedValue({
    page: { readable: false, note: '截圖被裁掉一半', questions: [] }, model: 'm' });
  const r = await runQueue(dbModule, { bankId });
  expect(r.failed).toBe(1);
  const row = await dbModule.query(`SELECT error FROM exam_uploads WHERE page='9'`);
  expect(row.rows[0].error).toMatch(/截圖被裁掉一半/);
});

// 題數對不上時寧可留空也不移位——補空或截斷會讓答案錯位，
// 而錯位的症狀是「某幾題莫名被判不一致」，離真因很遠
test('作答題數與審查讀出的題數不符時不硬湊', async () => {
  await addUpload('11', 'BAA', null);   // 看起來 3 題
  mockExtract.mockResolvedValue({ page: pageOf([{ en: 'Only one question here', zh: '只有一題' }]), model: 'm' });
  mockChallenge.mockResolvedValue({
    verdict: verdictOf([{ en: 'Only one question here', zh: '只有一題' }]), model: 'm' });
  await runQueue(dbModule, { bankId });

  const att = await dbModule.query(`SELECT answer_their FROM exam_attempts WHERE page='11'`);
  expect(att.rows[0].answer_their).toBeNull();
  const up = await dbModule.query(`SELECT status, error FROM exam_uploads WHERE page='11'`);
  expect(up.rows[0].status).toBe('done');
  expect(up.rows[0].error).toMatch(/沒對齊|3 題.*1 題/);
});

// 挑戰模式一次呼叫就把判斷與證據一起產出，所以只送一次、而且只送真的要判的題。
// 拆成審查→取證兩步時實測 Project 一頁＝6.5 分＋5.1 分，而審查那 6.5 分幾乎都在
// 等網路（它手上沒原始碼只好去 WebSearch）。
test('未命中官方的題整批送一次挑戰，證據跟著同一次寫入', async () => {
  await addUpload('12', '第 1 題 B；第 2 題 B', null);
  const qs = [
    { en: 'Challenge question one here', zh: '一', conf: 95,
      evidence: [{ kind: 'source', ref: 'addons/project/models/project_task.py:154', excerpt: 'x' }] },
    { en: 'Challenge question two here', zh: '二', conf: 60,
      evidence: [{ kind: 'source', ref: 'ent/project_enterprise/models/project_task.py:41', excerpt: 'y' }] },
  ];
  mockExtract.mockResolvedValue({ page: pageOf(qs), model: 'm' });
  mockChallenge.mockResolvedValue({ verdict: verdictOf(qs), model: 'm' });

  await runQueue(dbModule, { bankId });

  expect(mockChallenge).toHaveBeenCalledTimes(1);
  expect(mockChallenge.mock.calls[0][0].questions).toHaveLength(2);
  // 企業版證據要進得去：認證考很多 ent/ 才有的功能
  const ev = await dbModule.query(
    `SELECT ref FROM exam_evidence WHERE ref LIKE 'ent/%'`);
  expect(ev.rows.length).toBeGreaterThan(0);
});

// 路徑不合法的證據在 challenge 那層就被丟掉，但要留下痕跡讓人看得到
test('證據路徑被丟棄時具名記在該頁的 note', async () => {
  await addUpload('15', 'B', null);
  const qs = [{ en: 'Rejected ref question here', zh: '丟棄', rejected: ['/etc/passwd'] }];
  mockExtract.mockResolvedValue({ page: pageOf(qs), model: 'm' });
  mockChallenge.mockResolvedValue({ verdict: verdictOf(qs), model: 'm' });

  await runQueue(dbModule, { bankId });
  const up = await dbModule.query(`SELECT error FROM exam_uploads WHERE page='15'`);
  expect(up.rows[0].error).toMatch(/證據路徑不合法/);
});

// 一次丟一整份考卷時，那些 POST 是在幾百毫秒內陸續落地的。worker 全部同時啟動，
// 開場撲空的那幾個若立刻結束，就只剩一個在序列跑——實測 19 頁的 job pages_total
// 是 2，併行上限 5 完全沒有機會生效。
test('開場查不到的 worker 要等一下，晚到的頁才有人接', async () => {
  await addUpload('70', 'B', null);
  mockExtract.mockImplementation(async () => {
    await new Promise(r => setTimeout(r, 40));
    return { page: pageOf([{ en: 'Late arrival question here' }]), model: 'm' };
  });
  mockChallenge.mockResolvedValue({
    verdict: verdictOf([{ en: 'Late arrival question here' }]), model: 'm' });

  // 第一頁開跑之後才進來的第二頁，要被同一批的閒置 worker 接走
  const run = runQueue(dbModule, { bankId });
  await new Promise(r => setTimeout(r, 30));
  await addUpload('71', 'B', null);
  const r = await run;

  expect(r.total).toBe(2);
  const left = await dbModule.query(
    `SELECT COUNT(*)::int c FROM exam_uploads WHERE page IN ('70','71') AND status <> 'done'`);
  expect(left.rows[0].c).toBe(0);
  mockExtract.mockReset();
});

test('讀不出題目算失敗並寫下原因', async () => {
  await addUpload('9', 'B', null);
  mockExtract.mockResolvedValue({
    page: { readable: false, note: '截圖被裁掉一半', questions: [] }, model: 'm' });
  const r = await runQueue(dbModule, { bankId });
  expect(r.failed).toBe(1);
  const row = await dbModule.query(`SELECT error FROM exam_uploads WHERE page='9'`);
  expect(row.rows[0].error).toMatch(/截圖被裁掉一半/);
});

// 題數對不上時寧可留空也不移位——補空或截斷會讓答案錯位，
// 而錯位的症狀是「某幾題莫名被判不一致」，離真因很遠
test('作答題數與審查讀出的題數不符時不硬湊', async () => {
  await addUpload('11', 'BAA', null);   // 看起來 3 題
  mockExtract.mockResolvedValue({ page: pageOf([{ en: 'Only one question here', zh: '只有一題' }]), model: 'm' });
  mockChallenge.mockResolvedValue({
    verdict: verdictOf([{ en: 'Only one question here', zh: '只有一題' }]), model: 'm' });
  await runQueue(dbModule, { bankId });

  const att = await dbModule.query(`SELECT answer_their FROM exam_attempts WHERE page='11'`);
  expect(att.rows[0].answer_their).toBeNull();
  const up = await dbModule.query(`SELECT status, error FROM exam_uploads WHERE page='11'`);
  expect(up.rows[0].status).toBe('done');
  expect(up.rows[0].error).toMatch(/沒對齊|3 題.*1 題/);
});

test('job 記錄進度且結束時標 done', async () => {
  const jobs = await dbModule.query(`SELECT status, pages_total, pages_done FROM exam_jobs ORDER BY id DESC LIMIT 1`);
  expect(jobs.rows[0].status).toBe('done');
  expect(jobs.rows[0].pages_done).toBe(jobs.rows[0].pages_total);
});

// 沒有這一步，重啟後 job 永遠停在 running，畫面看起來像「還在跑」，
// 但跑它的行程早就不在了
describe('reclaimInterrupted', () => {
  test('把上次被殺掉的工作標 interrupted，upload 退回 pending', async () => {
    const j = await dbModule.query(
      `INSERT INTO exam_jobs (bank_id, status, phase) VALUES ($1,'running','審查中') RETURNING id`, [bankId]);
    await addUpload('30', 'B', null);
    await dbModule.query(`UPDATE exam_uploads SET status='running' WHERE page='30'`);

    const r = await reclaimInterrupted(dbModule);
    expect(r.jobs).toBe(1);
    expect(r.uploads).toBe(1);

    const job = await dbModule.query(`SELECT status FROM exam_jobs WHERE id=$1`, [j.rows[0].id]);
    expect(job.rows[0].status).toBe('interrupted');
    const up = await dbModule.query(`SELECT status FROM exam_uploads WHERE page='30'`);
    expect(up.rows[0].status).toBe('pending');
  });

  test('已完成的不受影響', async () => {
    const done = await dbModule.query(`SELECT COUNT(*)::int c FROM exam_uploads WHERE status='done'`);
    expect(done.rows[0].c).toBeGreaterThan(0);
  });

  // processUpload 是「先建 attempt 再送審」，重啟打斷在中間時 attempts 已經在 DB。
  // 只退回 pending 不刪的話，續跑會再建一份重複的作答，而 saveVerdicts 用
  // (bank_id, page, no) 查、取 rows[0]，審查結果掛到哪一份看運氣。
  // 失敗路徑與「重試」端點都特地刪過，唯獨開機回收漏了。
  test('退回 pending 時要刪掉已建的孤兒作答，否則續跑會建出重複', async () => {
    const up = await dbModule.query(`
      INSERT INTO exam_uploads (bank_id,page,answer_raw,image_path,status)
      VALUES ($1,'31','B','exam-test/x.jpg','running') RETURNING id`, [bankId]);
    const it = await dbModule.query(`
      INSERT INTO exam_items (odoo_version,fingerprint,question_en,options,qtype)
      VALUES ('19','orphan-fp','Q','[]'::jsonb,'single') RETURNING id`);
    await dbModule.query(`
      INSERT INTO exam_attempts (item_id,bank_id,upload_id,page,no,answer_their,answer_final)
      VALUES ($1,$2,$3,'31',1,$4,$4)`, [it.rows[0].id, bankId, up.rows[0].id, ['B']]);

    await reclaimInterrupted(dbModule);

    const left = await dbModule.query(
      `SELECT COUNT(*)::int c FROM exam_attempts WHERE upload_id=$1`, [up.rows[0].id]);
    expect(left.rows[0].c).toBe(0);
    // 題目本身留著——那是跨考次累積的知識，不該因為一次重啟就丟掉
    const item = await dbModule.query(
      `SELECT COUNT(*)::int c FROM exam_items WHERE fingerprint='orphan-fp'`);
    expect(item.rows[0].c).toBe(1);
  });

  // scheduleQueue 的其餘呼叫點全在 HTTP handler 內。沒有這個清單，開機後那些頁
  // 會停在「等待審題」轉圈，直到有人手動按重試——而畫面上看不出它已經不動了。
  test('回報還有待處理頁的題庫，讓開機流程把佇列推起來', async () => {
    const r = await reclaimInterrupted(dbModule);
    expect(r.resumeBanks).toContain(bankId);
  });
});

// 人是一邊考一邊傳的：下一頁在數十秒後才進 DB，而一頁要跑 1~2 分鐘。空手的工人
// 若照「查不到就等 12 秒下班」，其他工人會在第一頁跑完前全退光，只剩一個在序列跑
// （實測 bank 19：8 頁陸續進來只有 3 頁被認領，其餘全排隊，而畫面上看起來像沒在動）。
test('有工人在審時，空手的工人要留下來待命，接住晚到的頁', async () => {
  // 用獨立題庫：本檔的表在測試之間不清空，共用題庫會撈到前面留下的 pending，
  // 讓「第二個工人是不是還在」這件事測不出來。
  const b = await dbModule.query(
    `INSERT INTO exam_banks (label, odoo_version) VALUES ('W-late','19') RETURNING id`);
  const lateBank = b.rows[0].id;
  const add = async (page) => {
    const rel = path.join('exam_late', `${page}.jpg`);
    fs.mkdirSync(path.join(uploadDir, 'exam_late'), { recursive: true });
    fs.writeFileSync(path.join(uploadDir, rel), Buffer.from([0xff, 0xd8, 0xff]));
    await dbModule.query(
      `INSERT INTO exam_uploads (bank_id, page, answer_raw, image_path) VALUES ($1,$2,'B',$3)`,
      [lateBank, page, rel]);
  };

  let inFlight = 0, peak = 0, n = 0;
  mockExtract.mockImplementation(async () => {
    const qs = [{ en: `late question ${++n}`, zh: `晚到的題 ${n}` }];
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 60));
    inFlight--;
    return { page: pageOf(qs), model: 'claude-opus-5' };
  });
  mockChallenge.mockResolvedValue({
    verdict: verdictOf([{ en: 'late question', zh: '晚到的題' }]), model: 'claude-opus-5',
  });

  await add('90');
  const run = runQueue(dbModule, { bankId: lateBank });
  // 30ms 遠大於空手工人的收工線（2 輪 × 5ms），第二頁是在他「本來早就下班」之後才到
  await new Promise(r => setTimeout(r, 30));
  await add('91');

  const r = await run;
  expect(r).toMatchObject({ total: 2, done: 2, failed: 0 });
  // 峰值 1 代表退化成序列：第二個工人在第二頁進來之前就走了
  expect(peak).toBe(2);
});

// 一場考試要傳十幾頁。信心度原本只在整場收工時統一算一次，前面判完的頁在那之前
// 全是 null ⇒ 推薦分數算不出來，畫面上只有「需確認」（它不看信心度）先冒出來。
// 考試當下要的是「這頁判完就有分數」，不是等最後一頁。
test('一頁判完當下就有信心度，不等同一場其他頁跑完', async () => {
  const b = await dbModule.query(
    `INSERT INTO exam_banks (label, odoo_version) VALUES ('per-page','19') RETURNING id`);
  const pageBank = b.rows[0].id;
  const add = async (page) => {
    const rel = path.join('exam_perpage', `${page}.jpg`);
    fs.mkdirSync(path.join(uploadDir, 'exam_perpage'), { recursive: true });
    fs.writeFileSync(path.join(uploadDir, rel), Buffer.from([0xff, 0xd8, 0xff]));
    await dbModule.query(
      `INSERT INTO exam_uploads (bank_id, page, answer_raw, image_path) VALUES ($1,$2,'B',$3)`,
      [pageBank, page, rel]);
  };

  // 第二頁卡在閘門，直到第一頁的檢查做完才放行 ⇒ 檢查時整場一定還沒收工
  let open;
  const gate = new Promise(r => { open = r; });
  mockExtract.mockImplementation(async ({ imagePath }) => {
    if (imagePath.endsWith('P2.jpg')) await gate;
    const en = imagePath.endsWith('P2.jpg') ? 'per page second question' : 'per page first question';
    return { page: pageOf([{ en }]), model: 'm' };
  });
  mockChallenge.mockImplementation(async ({ questions }) => ({
    verdict: verdictOf([{ en: questions[0].question }]), model: 'm',
  }));

  await add('P1');
  await add('P2');
  let seen;
  const run = runQueue(dbModule, {
    bankId: pageBank,
    onEvent: (ev) => {
      if (ev.page !== 'P1' || ev.status !== 'done') return;
      dbModule.query(`
        SELECT i.confidence FROM exam_attempts a JOIN exam_items i ON i.id = a.item_id
         WHERE a.bank_id = $1 AND a.page = 'P1'`, [pageBank])
        .then(r => { seen = r.rows; })
        .finally(open);
    },
  });
  await run;

  expect(seen).toHaveLength(1);
  expect(seen[0].confidence).not.toBeNull();
});

// 實測 bank 20：11 頁上傳時全沒帶章節名，歸檔讀成績單一章都對不上——
// 而每頁截圖上明明印著章節標題。
test('上傳沒帶章節名就用截圖上讀到的，帶了的不蓋掉', async () => {
  const b = await dbModule.query(
    `INSERT INTO exam_banks (label, odoo_version) VALUES ('section','19') RETURNING id`);
  const secBank = b.rows[0].id;
  const add = async (page, section) => {
    const rel = path.join('exam_section', `${page}.jpg`);
    fs.mkdirSync(path.join(uploadDir, 'exam_section'), { recursive: true });
    fs.writeFileSync(path.join(uploadDir, rel), Buffer.from([0xff, 0xd8, 0xff]));
    await dbModule.query(
      `INSERT INTO exam_uploads (bank_id, page, answer_raw, image_path, section_title)
       VALUES ($1,$2,'B',$3,$4)`, [secBank, page, rel, section]);
  };
  mockExtract.mockImplementation(async ({ imagePath }) => {
    const en = imagePath.endsWith('S1.jpg') ? 'section read from shot' : 'section given at upload';
    return { page: { ...pageOf([{ en }]), section: 'Sales' }, model: 'm' };
  });
  mockChallenge.mockImplementation(async ({ questions }) => ({
    verdict: verdictOf([{ en: questions[0].question }]), model: 'm',
  }));

  await add('S1', null);
  await add('S2', 'CRM');
  await runQueue(dbModule, { bankId: secBank });

  const ups = (await dbModule.query(
    `SELECT page, section_title FROM exam_uploads WHERE bank_id = $1 ORDER BY page`, [secBank])).rows;
  expect(ups).toEqual([{ page: 'S1', section_title: 'Sales' }, { page: 'S2', section_title: 'CRM' }]);
  const items = (await dbModule.query(
    `SELECT question_en, section_title FROM exam_items WHERE question_en LIKE 'section %' ORDER BY question_en`)).rows;
  expect(items).toEqual([
    { question_en: 'section given at upload', section_title: 'CRM' },
    { question_en: 'section read from shot', section_title: 'Sales' },
  ]);
});
