// 意圖：排障結論寫回 wiki 的共用 helper。鎖三件會壞掉業務語意的事——
// (1) <memory> 側通道必須跟主回覆乾淨分離（解析出結論、且從顯示文字剝除，使用者不該看到機器區塊）；
// (2) slug 一律 ts- 前綴且不得撞骨架保留節點（overview／module-*／project-notes／容器本身），
//     撞名會讓 upsert 的 ON CONFLICT 覆寫骨架、翻爛整棵 wiki 樹；
// (3) 同 slug＝更新同一主題（upsert），非每次新增 → 累積記憶而非灌爆。

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...a) => mockQuery(...a) }));

const { recordTroubleshooting, extractMemoryBlock } = require('../pipeline/troubleshooting');

beforeEach(() => {
  mockQuery.mockReset();
  // _ensureContainer 的 SELECT id 回容器 id；其餘（INSERT 容器／INSERT 條目）回空
  mockQuery.mockImplementation((sql) => {
    if (/SELECT id FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [{ id: 7 }] });
    return Promise.resolve({ rows: [] });
  });
});

describe('extractMemoryBlock', () => {
  test('抽出結論並從顯示文字剝除 <memory> 區塊', () => {
    const raw = '這張單金額算錯是因為稅率沒帶到。\n<memory>{"slug":"tax","title":"稅率漏帶","content":"# 原因\\n稅率欄空"}</memory>';
    const { entry, cleaned } = extractMemoryBlock(raw);
    expect(entry).toEqual({ slug: 'tax', title: '稅率漏帶', content: '# 原因\n稅率欄空' });
    expect(cleaned).toBe('這張單金額算錯是因為稅率沒帶到。');
    expect(cleaned).not.toContain('<memory>');
  });

  test('無 <memory> → entry 為 null、原文原樣（僅 trim）', () => {
    const { entry, cleaned } = extractMemoryBlock('  純聊天沒有結論  ');
    expect(entry).toBeNull();
    expect(cleaned).toBe('純聊天沒有結論');
  });

  test('JSON 壞掉 → 當作沒帶結論（不炸主回覆），仍剝除殘塊', () => {
    const { entry, cleaned } = extractMemoryBlock('答覆\n<memory>{壞掉的 json}</memory>');
    expect(entry).toBeNull();
    expect(cleaned).toBe('答覆');
  });

  test('缺 title/content 的物件不算有效結論', () => {
    const { entry } = extractMemoryBlock('x\n<memory>{"slug":"a","title":"只有標題"}</memory>');
    expect(entry).toBeNull();
  });
});

describe('recordTroubleshooting', () => {
  test('slug 加 ts- 前綴並正規化，upsert 掛在容器節點下', async () => {
    const slug = await recordTroubleshooting(3, { slug: 'Tax Rate 漏帶!', title: 'T', content: 'C' });
    expect(slug).toBe('ts-tax-rate');
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO wiki_pages[\s\S]*ON CONFLICT/.test(c[0]) && /DO UPDATE/.test(c[0]));
    expect(insert).toBeTruthy();
    // params: [projectId, containerId, slug, title, content, description]
    expect(insert[1]).toEqual([3, 7, 'ts-tax-rate', 'T', 'C', null]); // 沒給 description → 存 null
    expect(insert[0]).toContain("node_type='troubleshooting'");
  });

  // 意圖：description 是「日後決定要不要打開這一則」的唯一依據——它會隨頁面清單／搜尋結果一起
  // 回給 agent，content 不會。沒有它，agent 只能靠標題猜，wiki 一多就必漏且毫無訊號。
  test('帶 description → 一併寫入（供頁面清單與搜尋結果判斷相關性）', async () => {
    await recordTroubleshooting(3, {
      slug: 'nas-refill', title: 'NAS 補寫', content: 'C',
      description: 'NAS 補寫排程判定缺檔的實際條件與常見誤解'
    });
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO wiki_pages[\s\S]*ON CONFLICT/.test(c[0]) && /DO UPDATE/.test(c[0]));
    expect(insert[1][5]).toBe('NAS 補寫排程判定缺檔的實際條件與常見誤解');
    expect(insert[0]).toContain('description');
  });

  // 側通道是「選用」的：舊格式（只有 title/content）仍須照常留存。為了缺一個新欄位就丟掉整則
  // 結論，等於用「格式更完整」換掉「知識有留存」，方向相反。
  test('舊格式（無 description）仍算有效結論，不因缺欄位被丟棄', () => {
    const { entry } = extractMemoryBlock('x\n<memory>{"slug":"a","title":"T","content":"C"}</memory>');
    expect(entry).toBeTruthy();
    expect(entry.description).toBeUndefined();
  });

  test('slug 撞容器保留字 → 改名，不覆寫容器節點', async () => {
    const slug = await recordTroubleshooting(3, { slug: 'troubleshooting', title: 'T', content: 'C' });
    expect(slug).toBe('ts-note');
  });

  test('已帶 ts- 前綴不重複疊加', async () => {
    const slug = await recordTroubleshooting(3, { slug: 'ts-existing-topic', title: 'T', content: 'C' });
    expect(slug).toBe('ts-existing-topic');
  });

  test('缺專案或缺必要欄位 → 不寫、回 null', async () => {
    expect(await recordTroubleshooting(null, { title: 'T', content: 'C' })).toBeNull();
    expect(await recordTroubleshooting(3, { title: 'T' })).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
