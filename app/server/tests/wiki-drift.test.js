// 意圖：chat／cs 回報「wiki 頁與程式碼漂移」→ 入佇列（status='new'）→ cron 慢慢分類補 category、標 classified，
// 供健檢像讀 rejection_items 一樣彙整。三件會壞掉語意的事：側通道須乾淨抽離主回覆；只回報不自動改文件；
// 解析失敗標 error 不無限重試（比照退回分類）。
const { newDb } = require('pg-mem');

const mockRunClaude = jest.fn();
jest.mock('../pipeline/claude-runner', () => ({ runClaude: mockRunClaude }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));

let dbModule, wd, projectId, userId;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [u] } = await dbModule.query("INSERT INTO users (username,password_hash,display_name) VALUES ('c','h','C') RETURNING id");
  userId = u.id;
  const { rows: [p] } = await dbModule.query("INSERT INTO projects (name,odoo_version) VALUES ('CP','17.0') RETURNING id");
  projectId = p.id;
  wd = require('../pipeline/wiki-drift');
});
afterAll(() => dbModule._setPoolForTesting(null));
beforeEach(() => mockRunClaude.mockReset());

describe('extractDriftBlock', () => {
  test('抽出 { slug, reason } 並從顯示文字剝除 <wiki-drift>', () => {
    const raw = '這是我查到的答案。\n<wiki-drift>{"slug":"sale-flow","reason":"頁面說自動確認，但程式其實要手動按"}</wiki-drift>';
    const { entry, cleaned } = wd.extractDriftBlock(raw);
    expect(entry).toEqual({ slug: 'sale-flow', reason: '頁面說自動確認，但程式其實要手動按' });
    expect(cleaned).toBe('這是我查到的答案。');
    expect(cleaned).not.toContain('<wiki-drift>');
  });

  test('reason 缺失 → 不算有效回報', () => {
    expect(wd.extractDriftBlock('x\n<wiki-drift>{"slug":"a"}</wiki-drift>').entry).toBeNull();
  });

  test('slug 可空、reason 必填', () => {
    const { entry } = wd.extractDriftBlock('x\n<wiki-drift>{"reason":"某模組描述不符"}</wiki-drift>');
    expect(entry).toEqual({ slug: null, reason: '某模組描述不符' });
  });

  test('無側通道 → entry 為 null、原文原樣', () => {
    expect(wd.extractDriftBlock('純回答沒有回報').entry).toBeNull();
  });
});

describe('enqueue + classify', () => {
  async function enqueue(slug, reason) {
    return wd.enqueueWikiDrift({ projectId, userId, source: 'chat', slug, reason });
  }

  test('入列缺專案或缺 reason → 回 null、不寫', async () => {
    expect(await wd.enqueueWikiDrift({ projectId: null, reason: 'x' })).toBeNull();
    expect(await wd.enqueueWikiDrift({ projectId, reason: '' })).toBeNull();
  });

  test('new 回報 → 分類 agent 補 category、status=classified；未知分類歸「其他」', async () => {
    mockRunClaude.mockResolvedValue({ text: '<result>{"category":"過時"}</result>', usage: null, durationMs: null });
    const id = await enqueue('sale-flow', '頁面說自動確認，程式要手動');
    await wd.classifyPendingWikiDrift();
    let { rows: [r] } = await dbModule.query('SELECT status, category FROM wiki_drift WHERE id=$1', [id]);
    expect(r.status).toBe('classified');
    expect(r.category).toBe('過時');

    mockRunClaude.mockResolvedValue({ text: '<result>{"category":"亂給的類"}</result>', usage: null, durationMs: null });
    const id2 = await enqueue('m', '某處不符');
    await wd.classifyPendingWikiDrift();
    ({ rows: [r] } = await dbModule.query('SELECT category FROM wiki_drift WHERE id=$1', [id2]));
    expect(r.category).toBe('其他'); // 不在固定集合 → 歸其他
  });

  test('分類輸出無法解析 → status=error、不無限重試', async () => {
    mockRunClaude.mockResolvedValue({ text: '不是 JSON 也沒有標記', usage: null, durationMs: null });
    const id = await enqueue('x', '壞掉的回報');
    await wd.classifyPendingWikiDrift();
    const { rows: [r] } = await dbModule.query('SELECT status, category FROM wiki_drift WHERE id=$1', [id]);
    expect(r.status).toBe('error');
    expect(r.category).toBeNull();
  });

  test('無 new → 不呼叫 runClaude（零成本早退）', async () => {
    await wd.classifyPendingWikiDrift();
    expect(mockRunClaude).not.toHaveBeenCalled();
  });
});
