const { newDb } = require('pg-mem');

const mockRunClaude = jest.fn().mockResolvedValue({ text: '<result>{"slug":"test-feature","title":"測試功能","content":"# 測試\\n\\n這是測試功能說明。"}</result>', usage: null, durationMs: null });

jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
jest.mock('../notify', () => ({ emitToUser: jest.fn() }));

let dbModule, runLibraryAgent, refreshWikiNode, realPool;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  realPool = new Pool();
  dbModule._setPoolForTesting(realPool);
  await dbModule.migrate();
  ({ runLibraryAgent, refreshWikiNode } = require('../pipeline/library-agent'));
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

// 讓符合 pattern 的 SQL 失敗，其餘照跑真 pg-mem。db.query 每次都重取 pool，故換 pool 即可攔截
// （library-agent 在載入時就把 query 解構出去了，spyOn 模組物件攔不到）。
function withFailingSql(pattern, fn) {
  const proxy = {
    query: (text, params) => pattern.test(String(text))
      ? Promise.reject(new Error('wiki_pages 寫入被拒'))
      : realPool.query(text, params),
    connect: (...a) => realPool.connect(...a)
  };
  dbModule._setPoolForTesting(proxy);
  return Promise.resolve().then(fn).finally(() => dbModule._setPoolForTesting(realPool));
}

let userSeq = 0;
async function createUserAndProject() {
  userSeq++;
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: [user] } = await dbModule.query(
    `INSERT INTO users (username, password_hash, display_name, role) VALUES ('libtest${userSeq}', $1, 'Lib', 'user') RETURNING id`,
    [hash]
  );
  const { rows: [proj] } = await dbModule.query(
    `INSERT INTO projects (name, odoo_version) VALUES ('LibProj${userSeq}', '17.0') RETURNING id`
  );
  return { userId: user.id, projectId: proj.id };
}

test('no project_id → sets done, no wiki created', async () => {
  const { userId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status) VALUES ($1, 'T001', 'odoo', 'Test', 'wiki_updating') RETURNING id",
    [userId]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [updated] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
  const { rows: wikiRows } = await dbModule.query('SELECT * FROM wiki_pages WHERE project_id IS NULL');
  expect(wikiRows.length).toBe(0);
});

test('with project_id → upserts wiki page and sets done', async () => {
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1, 'T002', 'odoo', 'Feature X', 'wiki_updating', $2) RETURNING id",
    [userId, projectId]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [updated] } = await dbModule.query('SELECT status, done_at FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
  expect(updated.done_at).toBeTruthy(); // 進 done 時寫入完成時間，供自動封存
  const { rows: fnRows } = await dbModule.query(
    "SELECT * FROM wiki_pages WHERE project_id=$1 AND node_type='function'", [projectId]
  );
  expect(fnRows.length).toBe(1);
  expect(fnRows[0].slug).toBe('test-feature');

  // 功能頁掛在 module 節點下，module 節點掛在 overview 下
  const { rows: [modNode] } = await dbModule.query('SELECT * FROM wiki_pages WHERE id=$1', [fnRows[0].parent_id]);
  expect(modNode.node_type).toBe('module');
  const { rows: [ovNode] } = await dbModule.query('SELECT * FROM wiki_pages WHERE id=$1', [modNode.parent_id]);
  expect(ovNode.node_type).toBe('overview');
});

test('function page is attached under the module from analysis_yaml', async () => {
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id, analysis_yaml) VALUES ($1, 'T100', 'odoo', 'Feat', 'wiki_updating', $2, $3) RETURNING id",
    [userId, projectId, "module: sale_ext\nsummary: x"]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [mod] } = await dbModule.query(
    "SELECT * FROM wiki_pages WHERE project_id=$1 AND node_type='module'", [projectId]
  );
  expect(mod.slug).toBe('module-sale_ext');
});

test('API error → still sets task done', async () => {
  mockRunClaude.mockRejectedValueOnce(new Error('API down'));
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1, 'T003', 'odoo', 'Feature Y', 'wiki_updating', $2) RETURNING id",
    [userId, projectId]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [updated] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
});

// 意圖：agent 執行失敗（API 掛掉／逾時）與「回了東西但不是 JSON」是兩種完全不同的病。
// 現況兩者共用同一個 else 分支，一律寫「輸出無法解析為有效 JSON」——真因（API down）被抹掉，
// 排查的人會去查 prompt／契約，而不是去看服務狀態。任務又照樣標 done，wiki 缺頁沒有第二個線索。
test('F-failloud：agent 執行失敗 → task_logs 要留真因，不得謊報「無法解析為有效 JSON」', async () => {
  mockRunClaude.mockRejectedValueOnce(new Error('Claude CLI exited: ETIMEDOUT'));
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'T_apierr','odoo','Feat','wiki_updating',$2) RETURNING id",
    [userId, projectId]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [task.id]);
  const failLog = logs.find(l => l.content.includes('wiki 更新失敗'));
  expect(failLog).toBeTruthy();
  expect(failLog.content).toContain('ETIMEDOUT');
  expect(failLog.content).not.toContain('無法解析為有效 JSON');
});

// 意圖：agent 回得好好的，但寫 wiki 那段炸了（DB 錯誤／約束衝突）→ 現況只有 console.error，
// task_logs 一個字都沒有、任務照樣 done。使用者看到「完成」卻找不到新頁，平台端也查無此案。
test('F-failloud：wiki 寫入失敗 → task_logs 留痕（不得完全無痕標 done）', async () => {
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'T_upserterr','odoo','Feat','wiki_updating',$2) RETURNING id",
    [userId, projectId]
  );
  // 讓 wiki 寫入路徑上的第一個 query 失敗（_ensureNode 的 INSERT）
  await withFailingSql(/INSERT INTO wiki_pages/i, () => runLibraryAgent(task.id, userId));
  const { rows: [updated] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [task.id]);
  const failLog = logs.find(l => l.content.includes('wiki 更新失敗'));
  expect(failLog).toBeTruthy();
  expect(failLog.content).toContain('wiki_pages 寫入被拒');
});

// 意圖：`troubleshooting` 是排障／客服對話累積的容器節點（wiki-routes 明擋刪除與重生）。
// 它不在功能頁保留字清單裡：agent 只要吐 slug="troubleshooting"，_upsertNode 的 ON CONFLICT
// 就把容器頁翻成 function 並改掛到模組節點下——整包疑難排解紀錄連同子節點在樹上錯位。
test('防呆：功能頁 slug 撞 troubleshooting → 容器不被翻成功能頁，改掛 fn-troubleshooting', async () => {
  const { userId, projectId } = await createUserAndProject();
  await dbModule.query(
    "INSERT INTO wiki_pages (project_id,parent_id,node_type,slug,title,content) VALUES ($1,null,'troubleshooting','troubleshooting','疑難排解','TS-SEED')",
    [projectId]);
  mockRunClaude.mockResolvedValueOnce({ text: '<result>' + JSON.stringify({
    slug: 'troubleshooting', title: '不該蓋掉疑難排解', content: '# 功能內容'
  }) + '</result>', usage: null, durationMs: null });
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id,task_id,source,title,status,project_id,analysis_yaml) VALUES ($1,'TP5','odoo','F5','wiki_updating',$2,'module: sale') RETURNING id",
    [userId, projectId]);
  await runLibraryAgent(task.id, userId);

  const { rows: [ts] } = await dbModule.query("SELECT node_type, parent_id, content FROM wiki_pages WHERE project_id=$1 AND slug='troubleshooting'", [projectId]);
  expect(ts.node_type).toBe('troubleshooting');
  expect(ts.parent_id).toBeNull();
  expect(ts.content).toBe('TS-SEED');
  const { rows: [fn] } = await dbModule.query("SELECT node_type, content FROM wiki_pages WHERE project_id=$1 AND slug='fn-troubleshooting'", [projectId]);
  expect(fn.node_type).toBe('function');
  expect(fn.content).toBe('# 功能內容');
});

// 意圖：parse 失敗不再靜默跳過卻標 done → task_logs 留痕，讓 wiki 缺頁有跡可循（健檢 F fail-loud）
test('F-failloud：library parse 失敗 → task_logs 留痕，任務仍 done', async () => {
  mockRunClaude
    .mockResolvedValueOnce({ text: '不是 JSON 也沒有 result 標記', usage: null, durationMs: null }) // 主呼叫
    .mockResolvedValueOnce({ text: '補救也還是壞的', usage: null, durationMs: null });               // haiku 補救
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, title, status, project_id) VALUES ($1,'T_badjson','odoo','Feat','wiki_updating',$2) RETURNING id",
    [userId, projectId]
  );
  await runLibraryAgent(task.id, userId);
  const { rows: [updated] } = await dbModule.query('SELECT status FROM tasks WHERE id=$1', [task.id]);
  expect(updated.status).toBe('done');
  const { rows: logs } = await dbModule.query('SELECT content FROM task_logs WHERE task_id=$1', [task.id]);
  expect(logs.some(l => l.content.includes('wiki 更新失敗'))).toBe(true);
});

// 意圖：任務完成時應「往上補」——若這次功能讓模組頁/總覽過時或不完整，agent 於 parents 附修正，
// JS 依白名單套用；不需要則父頁原封不動；白名單外的 slug 不得被誤改。
test('往上補：parents 含 overview／本模組頁 → 對應頁 content 被更新', async () => {
  mockRunClaude.mockResolvedValueOnce({ text: '<result>' + JSON.stringify({
    slug: 'feat-a', title: '功能A', content: '# 功能A',
    parents: [
      { slug: 'overview', content: '# 更新後總覽' },
      { slug: 'module-sale', content: '# 更新後模組' }
    ]
  }) + '</result>', usage: null, durationMs: null });
  const { userId, projectId } = await createUserAndProject();
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id,task_id,source,title,status,project_id,analysis_yaml) VALUES ($1,'TP1','odoo','Feat','wiki_updating',$2,$3) RETURNING id",
    [userId, projectId, 'module: sale']);
  await runLibraryAgent(task.id, userId);
  const { rows: [ov] } = await dbModule.query("SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='overview'", [projectId]);
  expect(ov.content).toBe('# 更新後總覽');
  const { rows: [mod] } = await dbModule.query("SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='module-sale'", [projectId]);
  expect(mod.content).toBe('# 更新後模組');
});

test('無 parents → 模組頁／總覽 content 原封不動', async () => {
  const { userId, projectId } = await createUserAndProject();
  // 第一次帶 parents 設定已知父頁內容
  mockRunClaude.mockResolvedValueOnce({ text: '<result>' + JSON.stringify({
    slug: 'f1', title: 'F1', content: '# F1',
    parents: [{ slug: 'overview', content: 'OV-KNOWN' }, { slug: 'module-inv', content: 'MOD-KNOWN' }]
  }) + '</result>', usage: null, durationMs: null });
  const { rows: [t1] } = await dbModule.query(
    "INSERT INTO tasks (user_id,task_id,source,title,status,project_id,analysis_yaml) VALUES ($1,'TP2a','odoo','F1','wiki_updating',$2,'module: inv') RETURNING id",
    [userId, projectId]);
  await runLibraryAgent(t1.id, userId);
  // 第二次用預設 mock（無 parents）
  const { rows: [t2] } = await dbModule.query(
    "INSERT INTO tasks (user_id,task_id,source,title,status,project_id,analysis_yaml) VALUES ($1,'TP2b','odoo','F2','wiki_updating',$2,'module: inv') RETURNING id",
    [userId, projectId]);
  await runLibraryAgent(t2.id, userId); // 預設 mock：slug test-feature、無 parents
  const { rows: [ov] } = await dbModule.query("SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='overview'", [projectId]);
  expect(ov.content).toBe('OV-KNOWN');
  const { rows: [mod] } = await dbModule.query("SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='module-inv'", [projectId]);
  expect(mod.content).toBe('MOD-KNOWN');
});

// 意圖：功能頁 slug 若撞到骨架保留字（overview／module-*／project-notes），不得覆寫骨架節點的
// node_type/parent_id（否則會造成父子環路、整棵樹在前端斷開全隱形）；改綴 fn- 前綴保留內容。
test('防呆：功能頁 slug 撞 overview → 骨架不被覆寫，改掛 fn-overview', async () => {
  const { userId, projectId } = await createUserAndProject();
  // 先鋪一顆正常 overview 骨架（parent_id=NULL）
  await dbModule.query(
    "INSERT INTO wiki_pages (project_id,parent_id,node_type,slug,title,content) VALUES ($1,null,'overview','overview','總覽','OV-SEED')",
    [projectId]);
  mockRunClaude.mockResolvedValueOnce({ text: '<result>' + JSON.stringify({
    slug: 'overview', title: '不該蓋掉總覽', content: '# 功能內容'
  }) + '</result>', usage: null, durationMs: null });
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id,task_id,source,title,status,project_id,analysis_yaml) VALUES ($1,'TP4','odoo','F4','wiki_updating',$2,'module: sale') RETURNING id",
    [userId, projectId]);
  await runLibraryAgent(task.id, userId);
  // overview 仍是 overview root，未被翻成 function
  const { rows: [ov] } = await dbModule.query("SELECT node_type, parent_id, content FROM wiki_pages WHERE project_id=$1 AND slug='overview'", [projectId]);
  expect(ov.node_type).toBe('overview');
  expect(ov.parent_id).toBeNull();
  // 功能內容改掛在 fn-overview（function），內容保留
  const { rows: [fn] } = await dbModule.query("SELECT node_type, content FROM wiki_pages WHERE project_id=$1 AND slug='fn-overview'", [projectId]);
  expect(fn.node_type).toBe('function');
  expect(fn.content).toBe('# 功能內容');
});

test('白名單：parents 含非 overview／非本任務模組 slug → 忽略、不誤改', async () => {
  const { userId, projectId } = await createUserAndProject();
  await dbModule.query(
    "INSERT INTO wiki_pages (project_id,parent_id,node_type,slug,title,content) VALUES ($1,null,'overview','overview','總覽','OVSEED'),($1,null,'module','module-other','other','OTHER-KEEP')",
    [projectId]);
  mockRunClaude.mockResolvedValueOnce({ text: '<result>' + JSON.stringify({
    slug: 'f3', title: 'F3', content: '# F3',
    parents: [{ slug: 'module-other', content: 'HACKED' }] // 本任務模組是 sale，非 other
  }) + '</result>', usage: null, durationMs: null });
  const { rows: [task] } = await dbModule.query(
    "INSERT INTO tasks (user_id,task_id,source,title,status,project_id,analysis_yaml) VALUES ($1,'TP3','odoo','F3','wiki_updating',$2,'module: sale') RETURNING id",
    [userId, projectId]);
  await runLibraryAgent(task.id, userId);
  const { rows: [other] } = await dbModule.query("SELECT content FROM wiki_pages WHERE project_id=$1 AND slug='module-other'", [projectId]);
  expect(other.content).toBe('OTHER-KEEP'); // 未被誤改
});

// 意圖：不同任務改同一功能（相同標題）時，即使 agent 生成不同 slug，也應更新既有功能頁而非重複新增。
test('同功能去重：同模組相同標題功能頁 → 沿用既有 slug 更新，不重複新增', async () => {
  const { userId, projectId } = await createUserAndProject();
  // 任務一：建立功能頁 slug=feat-a、title=共用功能
  mockRunClaude.mockResolvedValueOnce({ text: '<result>' + JSON.stringify({
    slug: 'feat-a', title: '共用功能', content: 'v1'
  }) + '</result>', usage: null, durationMs: null });
  const { rows: [t1] } = await dbModule.query(
    "INSERT INTO tasks (user_id,task_id,source,title,status,project_id,analysis_yaml) VALUES ($1,'DUP1','odoo','A','wiki_updating',$2,'module: sale') RETURNING id",
    [userId, projectId]);
  await runLibraryAgent(t1.id, userId);
  // 任務二：改同一功能，agent 卻給不同 slug，但 title 相同
  mockRunClaude.mockResolvedValueOnce({ text: '<result>' + JSON.stringify({
    slug: 'feat-a-again', title: '共用功能', content: 'v2'
  }) + '</result>', usage: null, durationMs: null });
  const { rows: [t2] } = await dbModule.query(
    "INSERT INTO tasks (user_id,task_id,source,title,status,project_id,analysis_yaml) VALUES ($1,'DUP2','odoo','A2','wiki_updating',$2,'module: sale') RETURNING id",
    [userId, projectId]);
  await runLibraryAgent(t2.id, userId);

  const { rows: fnRows } = await dbModule.query(
    "SELECT slug, content FROM wiki_pages WHERE project_id=$1 AND node_type='function' AND title='共用功能'", [projectId]);
  expect(fnRows.length).toBe(1);           // 沒有重複新增
  expect(fnRows[0].slug).toBe('feat-a');   // 沿用既有 slug
  expect(fnRows[0].content).toBe('v2');    // 內容已更新
});

// 意圖：⟳ 重新生成不是「重寫」而是「精修」——library.md 明寫「保留既有正確內容，只補充與修正」，
// 但概論／模組頁若不把現有內容送進 prompt，AI 手上根本沒有可保留的東西，這條指示無從執行，
// 使用者手動潤過的字與歷次累積的內容會被整份沖掉且無警告。功能頁那支（else 分支）本來就有送，
// 是這兩支的參照樣板。斷言只看「舊內容有沒有進到 prompt」，不驗整段 context 格式——那種測試
// 改個換行就紅，卻抓不到真正的退化。
test('重生概論頁：現有內容必須送進 AI（否則累積的知識會被沖掉）', async () => {
  const { userId, projectId } = await createUserAndProject();
  await dbModule.query(
    "INSERT INTO wiki_pages (project_id,parent_id,node_type,slug,title,content) VALUES ($1,null,'overview','overview','專案概論','OV-累積內容')",
    [projectId]);
  mockRunClaude.mockClear();
  await refreshWikiNode(projectId, 'overview', userId);
  expect(mockRunClaude.mock.calls[0][0]).toContain('OV-累積內容');
});

test('重生模組頁：現有內容必須送進 AI（否則累積的知識會被沖掉）', async () => {
  const { userId, projectId } = await createUserAndProject();
  await dbModule.query(
    "INSERT INTO wiki_pages (project_id,parent_id,node_type,slug,title,content) VALUES ($1,null,'module','module-sale','sale','MOD-累積內容')",
    [projectId]);
  mockRunClaude.mockClear();
  await refreshWikiNode(projectId, 'module-sale', userId);
  expect(mockRunClaude.mock.calls[0][0]).toContain('MOD-累積內容');
});

const seedPage = (projectId, nodeType, slug, title, content) => dbModule.query(
  'INSERT INTO wiki_pages (project_id,parent_id,node_type,slug,title,content) VALUES ($1,null,$2,$3,$4,$5)',
  [projectId, nodeType, slug, title, content]);
const pageContent = async (projectId, slug) => (await dbModule.query(
  'SELECT content FROM wiki_pages WHERE project_id=$1 AND slug=$2', [projectId, slug])).rows[0].content;
const agentReplies = (obj) => mockRunClaude.mockResolvedValueOnce(
  { text: '<result>' + JSON.stringify(obj) + '</result>', usage: null, durationMs: null });

// 意圖：`{"content":""}` 是合法 JSON，parseAgentResult 會放行；原本的 `p.content ?? content` 只擋
// null/undefined，所以 agent 一句空字串就讓後面那條 UPDATE 把整頁寫成空白。wiki_pages 沒有版本表、
// 沒有備份表，寫空之後任何人都救不回來——這比「重生結果不夠好」嚴重一個量級。
// 同一支檔的 initProjectWiki 用的就是安全寫法（`p.content || overviewContent`），兩種寫法並存而
// 安全那個沒被沿用，這條測試就是把「哪一種才算數」釘住。
describe('重生：agent 回空內容不得清空既有頁面', () => {
  test.each([
    ['空字串', ''],
    ['只有空白與換行', '   \n\t  '],
  ])('content 是%s → 舊內容原封不動，且回報失敗', async (_name, bad) => {
    const { userId, projectId } = await createUserAndProject();
    await seedPage(projectId, 'module', 'module-blank', 'blank', 'MOD-不可被清空的累積內容');
    agentReplies({ slug: 'module-blank', title: 'blank', content: bad });
    // 靜默保留舊內容卻回「已重新生成」，使用者會以為精修過了、也不會再按一次 → 一律 fail loud
    await expect(refreshWikiNode(projectId, 'module-blank', userId)).rejects.toThrow(/未回有效 content/);
    expect(await pageContent(projectId, 'module-blank')).toBe('MOD-不可被清空的累積內容');
  });

  // 對照組：修法不可以退化成「永遠不寫入」——那樣重生功能整個失效，上面兩條卻照樣全綠。
  test('content 有內容 → 照常覆寫（修法不得變成永不寫入）', async () => {
    const { userId, projectId } = await createUserAndProject();
    await seedPage(projectId, 'module', 'module-ok', 'ok', '舊內容');
    agentReplies({ slug: 'module-ok', title: 'ok', content: '# 新內容' });
    await refreshWikiNode(projectId, 'module-ok', userId);
    expect(await pageContent(projectId, 'module-ok')).toBe('# 新內容');
  });
});

// 意圖：module／function 頁把 `${node.content}` 全文塞回 prompt、指令又是「保留正確內容、補充與修正」，
// 沒有任何長度閘＝每按一次 ⟳ 內容與 input token 就單調成長，最後撞模型輸出上限被靜默截斷再寫回。
// 這裡斷言的是「prompt 裡確實存在長度預算」這件事本身（prompt 就是這關的行為），不驗整段格式。
describe('重生：module／function 頁必須有長度預算（否則每按一次 ⟳ 就膨脹）', () => {
  test.each([
    ['module', 'module-budget', 'budget'],
    ['function', 'fn-budget', '功能'],
  ])('%s 頁的 prompt 帶明確字數目標', async (nodeType, slug, title) => {
    const { userId, projectId } = await createUserAndProject();
    await seedPage(projectId, nodeType, slug, title, '內容');
    mockRunClaude.mockClear();
    await refreshWikiNode(projectId, slug, userId);
    expect(mockRunClaude.mock.calls[0][0]).toMatch(/長度：目標 \d+ 字/);
  });
});

// 意圖：上限不能用「截斷後照送」來做——AI 拿到的是被切掉尾巴的版本，回來的整份內容會蓋掉原頁，
// 尾段等於被刪掉，那就是第 1 項同一種資料流失。所以到頂的正確行為是擋下並要求人工精簡：
// 不呼叫 AI（不燒 token）、不動內容（不流失），且錯誤要浮上來讓使用者知道要做什麼。
test('重生：現有內容超過硬上限 → 擋下不送 AI，內容一字不動', async () => {
  const { userId, projectId } = await createUserAndProject();
  const huge = 'X'.repeat(6001);
  await seedPage(projectId, 'module', 'module-huge', 'huge', huge);
  mockRunClaude.mockClear();
  await expect(refreshWikiNode(projectId, 'module-huge', userId)).rejects.toThrow(/精簡/);
  expect(mockRunClaude).not.toHaveBeenCalled();
  expect(await pageContent(projectId, 'module-huge')).toBe(huge);
});

// 意圖：概論原本同時寫著「保留正確內容」與硬上限「200-400 字」。內容一旦累積超過 400 字，這兩條
// 不可能同時成立，模型只能自己取捨、而它會選擇刪字——等於這一頁的「保留」指示在超過上限後失效。
// 修法是把字數改寫成「目標＋衝突時的裁決順序」（正確性優先於字數），而不是拿掉其中一條。
describe('重生概論：字數規則不得與「保留現有內容」互斥', () => {
  let prompt;
  beforeAll(async () => {
    const { userId, projectId } = await createUserAndProject();
    await seedPage(projectId, 'overview', 'overview', '專案概論', 'A'.repeat(1500)); // 刻意超過字數目標
    mockRunClaude.mockClear();
    await refreshWikiNode(projectId, 'overview', userId);
    prompt = mockRunClaude.mock.calls[0][0];
  });

  test('仍要求保留既有正確內容', () => { expect(prompt).toContain('保留正確內容'); });
  test('不得再出現無裁決順序的硬上限', () => { expect(prompt).not.toMatch(/200-400 字/); });
  test('明講衝突時正確性優先於字數', () => { expect(prompt).toMatch(/不得為了字數刪除/); });
  // 字數規則不可以偷偷變成截斷：超過目標的既有內容仍要整份送進去，否則超出的那段會被 AI 重寫成
  // 「不存在」，回頭覆蓋原頁＝又一次靜默資料流失。
  test('超過字數目標的既有內容仍整份送進 AI', () => { expect(prompt).toContain('A'.repeat(1500)); });
});
