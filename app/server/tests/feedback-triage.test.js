// 意圖：feedback-triage 是夜間自動修正通道唯一的人工把關前哨（見 .claude/agents/feedback-triage.md）。
// 半夜無人監督時，這一步的判斷會直接決定要不要把一則意見送去改 production 程式碼——
// 判不出來卻硬編，下游沒有任何人會發現。這一支釘住「看不懂就退回 new，不卡在中間狀態」。
const path = require('path');
const { newDb } = require('pg-mem');
const { uploadRoot } = require('../lib/attachments');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: (...args) => mockRunClaude(...args) }));
const mockLogTokenUsage = jest.fn();
const mockLogFailedUsage = jest.fn();
jest.mock('../pipeline/token-logger', () => ({
  logTokenUsage: (...args) => mockLogTokenUsage(...args),
  logFailedUsage: (...args) => mockLogFailedUsage(...args),
}));

let dbModule, triageOne, mergeCandidates;
let fbId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  ({ triageOne, mergeCandidates } = require('../pipeline/feedback-triage'));
});

beforeEach(async () => {
  mockRunClaude.mockReset();
  mockLogTokenUsage.mockReset();
  mockLogFailedUsage.mockReset();
  const { rows: [fb] } = await dbModule.query(
    "INSERT INTO feedback (user_id, content, status) VALUES (NULL, '按鈕怪怪的', 'approved') RETURNING id");
  fbId = fb.id;
});

test('回 understandable:false → 剔除且 status 退回 new，triage_note 寫原因', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<notes>看不出是哪一頁</notes>\n<result>{"understandable":false,"note":"看不出是哪一頁"}</result>',
    usage: {}, durationMs: 1
  });
  const r = await triageOne(fbId);
  expect(r.understandable).toBe(false);
  const { rows } = await dbModule.query('SELECT status, triage_note FROM feedback WHERE id=$1', [fbId]);
  expect(rows[0].status).toBe('new');
  expect(rows[0].triage_note).toContain('看不出是哪一頁');
});

test('回不出 JSON → 同樣退回 new，不卡在中間狀態', async () => {
  mockRunClaude.mockResolvedValue({ text: '我覺得這個嘛……', usage: {}, durationMs: 1 });
  const r = await triageOne(fbId);
  expect(r.ok).toBe(false);
  const { rows } = await dbModule.query('SELECT status FROM feedback WHERE id=$1', [fbId]);
  expect(rows[0].status).toBe('new');
});

test('看得懂 → 寫回四個 triage 欄位與 verify_route', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<notes>是任務列表的留白問題</notes>\n<result>'
      + '{"title":"任務列表留白過大","detail":"卡片間距異常","layer":"code",'
      + '"action":"調整 CSS gap","understandable":true,"note":"","verify_route":"#/tasks"}'
      + '</result>',
    usage: {}, durationMs: 1
  });
  const r = await triageOne(fbId);
  expect(r.ok).toBe(true);
  expect(r.understandable).toBe(true);
  const { rows } = await dbModule.query(
    `SELECT triage_title, triage_detail, triage_layer, triage_action, verify_route, status, triage_note
       FROM feedback WHERE id=$1`, [fbId]);
  expect(rows[0].triage_title).toBe('任務列表留白過大');
  expect(rows[0].triage_detail).toBe('卡片間距異常');
  expect(rows[0].triage_layer).toBe('code');
  expect(rows[0].triage_action).toBe('調整 CSS gap');
  expect(rows[0].verify_route).toBe('#/tasks');
  // <notes> 是夜間無人監督時，人事後唯一讀得到的推理過程。成功路徑也要落地，
  // 只在失敗時寫等於「順利跑完的那些永遠查不到當初怎麼判的」。
  expect(rows[0].triage_note).toContain('是任務列表的留白問題');
  expect(mockLogTokenUsage).toHaveBeenCalled();
});

// ⚠ file_path 存的是「相對 uploadRoot()」的路徑（lib/attachments.js）。原樣塞進 prompt 的話
// agent 打不開圖 → 依 prompt 自己的規則回 understandable:false → 意見退回 new。
// 外面看起來只會是「AI 老是說看不懂」：沒有紅燈、沒有 log、沒人歸因得到路徑。
// 上面四支只斷言「mock 吐什麼 → DB 出什麼」，這個缺陷正好躲在那個縫裡，所以要驗 prompt 本身。
test('附件餵絕對路徑＋唯讀授權＋檔名與 mimetype（相對路徑 agent 打不開，而且靜默）', async () => {
  const rel = path.join('feedback_1', '1700000000000_screen.png');
  await dbModule.query(
    `INSERT INTO feedback_attachments (feedback_id, filename, mimetype, file_path)
     VALUES ($1, 'screen.png', 'image/png', $2)`, [fbId, rel]);
  mockRunClaude.mockResolvedValue({
    text: '<notes>n</notes>\n<result>{"understandable":true,"title":"t","detail":"d",'
      + '"layer":"code","action":"a","note":"","verify_route":""}</result>',
    usage: {}, durationMs: 1
  });
  await triageOne(fbId);

  const prompt = mockRunClaude.mock.calls[0][0];
  expect(prompt).toContain(path.resolve(uploadRoot(), rel));
  expect(prompt).toContain('screen.png');
  expect(prompt).toContain('image/png');
  // 沒有這段授權宣告，agent 會因「不得存取工作目錄外路徑」規則跳過不讀（同 sync.js 的 taskAttachmentNote）
  expect(prompt).toContain('唯讀');
});

// 安全閘門只認明確的 true：LLM 回字串 "false" 時 `!parsed.understandable` 是 false（非空字串為真），
// 會被判成「看得懂」直接送進夜間改 production。缺欄位（undefined）方向是 fail-safe，唯獨字串反向。
test('understandable 回字串 "false" 也要當成看不懂（不可 fail-open）', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<notes>n</notes>\n<result>{"understandable":"false","note":"字串型別"}</result>',
    usage: {}, durationMs: 1
  });
  const r = await triageOne(fbId);
  expect(r.understandable).toBe(false);
  const { rows } = await dbModule.query('SELECT status FROM feedback WHERE id=$1', [fbId]);
  expect(rows[0].status).toBe('new');
});

// understandable:false 只覆寫 triage_note 的話，前一輪成功留下的欄位會殘留成過期資料，
// 管理頁上看起來像「這條已經翻譯好了」，但它其實已經被退回。
test('退回 new 時一併清掉上一輪殘留的 triage 欄位', async () => {
  await dbModule.query(
    `UPDATE feedback SET triage_title='舊標題', triage_detail='舊內容', triage_layer='code',
            triage_action='舊做法', verify_route='#/old' WHERE id=$1`, [fbId]);
  mockRunClaude.mockResolvedValue({
    text: '<notes>n</notes>\n<result>{"understandable":false,"note":"這輪看不懂"}</result>',
    usage: {}, durationMs: 1
  });
  await triageOne(fbId);
  const { rows } = await dbModule.query(
    `SELECT triage_title, triage_detail, triage_layer, triage_action, verify_route
       FROM feedback WHERE id=$1`, [fbId]);
  expect(rows[0].triage_title).toBeNull();
  expect(rows[0].triage_detail).toBeNull();
  expect(rows[0].triage_layer).toBeNull();
  expect(rows[0].triage_action).toBeNull();
  expect(rows[0].verify_route).toBeNull();
});

test('layer 回五值以外 → 當成 unclear（不可原樣寫進 DB 讓下游拿去分流）', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<notes>n</notes>\n<result>{"understandable":true,"title":"t","detail":"d",'
      + '"layer":"frontend","action":"a","note":"","verify_route":""}</result>',
    usage: {}, durationMs: 1
  });
  await triageOne(fbId);
  const { rows } = await dbModule.query('SELECT triage_layer FROM feedback WHERE id=$1', [fbId]);
  expect(rows[0].triage_layer).toBe('unclear');
});

// timeout 最可能走的就是這條路，而它原本零測試覆蓋。
test('runClaude 拋錯 → 退回 new，triage_note 寫「執行失敗」', async () => {
  mockRunClaude.mockRejectedValue(new Error('timeout'));
  const r = await triageOne(fbId);
  expect(r.ok).toBe(false);
  const { rows } = await dbModule.query('SELECT status, triage_note FROM feedback WHERE id=$1', [fbId]);
  expect(rows[0].status).toBe('new');
  expect(rows[0].triage_note).toContain('執行失敗');
  expect(mockLogFailedUsage).toHaveBeenCalled();
});

// ⚠ 兩筆以上才證明得了合併真的發生（一筆時「合併」與「原樣回傳」看不出差別，rules/testing.md #19）
test('三筆講同一件事 → 合併成一組', async () => {
  mockRunClaude.mockResolvedValue({
    text: '<notes>三條都是任務列表留白問題</notes>\n<result>'
      + '{"groups":[{"member_ids":[1,2,3],"title":"版面留白","detail":"三則意見皆指同一版位",'
      + '"action":"調整間距","layer":"code","verify_route":"#/tasks"}]}'
      + '</result>',
    usage: {}, durationMs: 1
  });
  const groups = await mergeCandidates([
    { id: 1, source: 'feedback', title: '按鈕貼太緊', detail: '第一則' },
    { id: 2, source: 'feedback', title: '留白太擠', detail: '第二則' },
    { id: 3, source: 'finding', title: '版面密度過高', detail: '健檢提案' },
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0].member_ids).toEqual([1, 2, 3]);
  expect(mockLogTokenUsage).toHaveBeenCalled();

  // 「一次看完全部才判得出這三條是同一件事」是這支 agent 的存在理由——送進去的清單真的要有三筆。
  const prompt = mockRunClaude.mock.calls[0][0];
  ['1', '2', '3'].forEach(id => expect(prompt).toContain(`[${id}]`));
  expect(prompt).toContain('按鈕貼太緊');
  expect(prompt).toContain('版面密度過高');
});

// 解析失敗回 [] 與「今晚沒候選」長得一模一樣：整晚候選集體蒸發不能零訊號。
test('merge 解析不出 groups → 回 [] 但要留 console.error', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockRunClaude.mockResolvedValue({ text: '我想想喔……', usage: {}, durationMs: 1 });
  const groups = await mergeCandidates([{ id: 1, source: 'feedback', title: 'a', detail: 'b' }]);
  expect(groups).toEqual([]);
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});

test('沒有候選 → 直接回 []，不叫 agent', async () => {
  expect(await mergeCandidates([])).toEqual([]);
  expect(mockRunClaude).not.toHaveBeenCalled();
});
