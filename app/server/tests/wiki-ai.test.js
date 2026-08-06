process.env.JWT_SECRET = 'test-wiki-ai';
process.env.APP_SECRET = 'test-wiki-ai-secret';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const { aiToken, AI_TOKEN_HEADER, aiEndpointGuard } = require('../lib/ai-token');

// 意圖：chat 子行程（headless、cwd=odoo-v2）不預載 wiki，改按需自取。
// 這組 loopback 端點是它取 wiki 的唯一路徑——驗「索引不外洩 content」「單頁可取」「非本機擋下」。
let dbModule, app, projectId;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name,folder_name,odoo_version) VALUES ('鴻久','hungjou','17.0') RETURNING id");
  projectId = p.id;
  await dbModule.query(
    "INSERT INTO wiki_pages (project_id,slug,title,node_type,content) VALUES ($1,'overview','總覽','overview','總覽內容'),($1,'sale','銷售','module','銷售內容')",
    [projectId]);
  const a = express(); a.use(express.json());
  require('../wiki-routes').registerRoutes(a);
  app = a;
});
afterAll(() => dbModule._setPoolForTesting(null));

test('GET /ai/wiki/pages 回索引、不含 content（loopback）', async () => {
  const res = await request(app).get('/ai/wiki/pages?project=hungjou').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.pages.map(p => p.slug).sort()).toEqual(['overview', 'sale']);
  expect(res.body.pages[0].content).toBeUndefined();
});

test('GET /ai/wiki/pages 依 name 也可查（chat 執行時傳的是 projects.name，非 folder_name）', async () => {
  const res = await request(app).get('/ai/wiki/pages').set(AI_TOKEN_HEADER, aiToken()).query({ project: '鴻久' });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.pages.map(p => p.slug).sort()).toEqual(['overview', 'sale']);
});

test('GET /ai/wiki/page 回單頁 content（loopback）', async () => {
  const res = await request(app).get('/ai/wiki/page?project=hungjou&slug=sale').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.content).toBe('銷售內容');
});

test('GET /ai/wiki/page 找不到 slug 回 ok:false', async () => {
  const res = await request(app).get('/ai/wiki/page?project=hungjou&slug=nope').set(AI_TOKEN_HEADER, aiToken());
  expect(res.body.ok).toBe(false);
});

test('守衛擋非本機來源（沿用 lib/ai-token 的中介層）', () => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  aiEndpointGuard({ socket: { remoteAddress: '8.8.8.8' }, headers: {} }, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
});

// wiki 內容是 library agent 從客戶 repo 摘出來的，外洩面不輸 DB 那兩支；
// 來源檢查一旦因 nginx 搬家而失效，通行碼是唯一還站著的門。
test('本機來源但沒帶通行碼 → 仍然擋下', async () => {
  const res = await request(app).get('/ai/wiki/pages?project=hungjou');
  expect(res.status).toBe(403);
});

// --- 全文搜尋：補掉「只能按標題挑頁」的缺口 ---
// 意圖：舊行為只有 pages（回 slug/title）與 page（取單頁），agent 想找「以前遇過這問題嗎」
// 只能靠標題猜。wiki 一多就必漏，而且漏了沒有訊號——端點回 200，agent 當成「沒有相關記載」。
test('GET /ai/wiki/search 命中 content 內文（標題對不上也找得到）', async () => {
  await dbModule.query(
    `INSERT INTO wiki_pages (project_id,slug,title,node_type,content,description)
     VALUES ($1,'ts-nas','排程結論','troubleshooting','判定缺檔的條件是 attachment 為空','NAS 補寫判定缺檔的實際條件')`,
    [projectId]);
  const res = await request(app).get('/ai/wiki/search?project=hungjou&q=attachment').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.hits.map(h => h.slug)).toContain('ts-nas'); // 關鍵字只在 content 裡
  expect(res.body.hits[0].content).toBeUndefined();           // 不回全文，否則一次搜尋灌爆 context
  expect(res.body.hits[0].description).toBeTruthy();          // 但要回 description 供判斷相關性
});

// 排障結論優先排前面：agent 問「以前遇過嗎」時，前人的結論比正典文件有用。
test('GET /ai/wiki/search troubleshooting 排在一般頁之前', async () => {
  await dbModule.query(
    `INSERT INTO wiki_pages (project_id,slug,title,node_type,content)
     VALUES ($1,'mod-nas','NAS 模組','module','NAS 相關說明')`,
    [projectId]);
  const res = await request(app).get('/ai/wiki/search?project=hungjou&q=nas').set(AI_TOKEN_HEADER, aiToken());
  expect(res.body.hits.length).toBeGreaterThanOrEqual(2);
  expect(res.body.hits[0].node_type).toBe('troubleshooting');
});

test('GET /ai/wiki/search 缺 q → ok:false（不回整包 wiki）', async () => {
  const res = await request(app).get('/ai/wiki/search?project=hungjou').set(AI_TOKEN_HEADER, aiToken());
  expect(res.body.ok).toBe(false);
});

test('GET /ai/wiki/search 沒帶通行碼 → 擋下（與其他 /ai/* 一致）', async () => {
  const res = await request(app).get('/ai/wiki/search?project=hungjou&q=nas');
  expect(res.status).toBe(403);
});

// description 是 agent「決定要不要打開這一頁」的依據，必須跟著清單一起回。
test('GET /ai/wiki/pages 一併回 description', async () => {
  const res = await request(app).get('/ai/wiki/pages?project=hungjou').set(AI_TOKEN_HEADER, aiToken());
  const ts = res.body.pages.find(p => p.slug === 'ts-nas');
  expect(ts.description).toBe('NAS 補寫判定缺檔的實際條件');
});

// --- [[slug]] 互連 ---
// 意圖：搜尋解決「我知道關鍵字，找得到嗎」；連結解決「我根本不知道有這東西存在」。排障結論常是
// 成串的（同一現象牽三四則），靠關鍵字撞不出彼此。取單頁時附上被連結那幾則的標題與 description，
// 讓讀的人自己決定要不要追下去——只給摘要不給全文，否則一頁就把整串灌進 context。
test('GET /ai/wiki/page 解出 content 裡的 [[slug]]，附上對方標題與 description', async () => {
  await dbModule.query(
    `INSERT INTO wiki_pages (project_id,slug,title,node_type,content,description)
     VALUES ($1,'ts-a','A 結論','troubleshooting','起因見 [[ts-b]]，另可參考 [[ts-b]]','A 的一句話'),
            ($1,'ts-b','B 結論','troubleshooting','B 的內容','B 的一句話')`,
    [projectId]);
  const res = await request(app).get('/ai/wiki/page?project=hungjou&slug=ts-a').set(AI_TOKEN_HEADER, aiToken());
  expect(res.body.ok).toBe(true);
  expect(res.body.links).toHaveLength(1);            // 同一 slug 出現兩次只算一則
  expect(res.body.links[0].slug).toBe('ts-b');
  expect(res.body.links[0].description).toBe('B 的一句話');
  expect(res.body.links[0].content).toBeUndefined(); // 不回對方全文
});

// 連到不存在的 slug 是「這裡該有一則但還沒寫」的記號，不是錯誤——要照樣回報，缺口才看得見。
test('GET /ai/wiki/page 連到不存在的 slug → 進 missing_links，不報錯', async () => {
  await dbModule.query(
    `INSERT INTO wiki_pages (project_id,slug,title,node_type,content)
     VALUES ($1,'ts-c','C 結論','troubleshooting','待補：[[ts-not-written-yet]]')`,
    [projectId]);
  const res = await request(app).get('/ai/wiki/page?project=hungjou&slug=ts-c').set(AI_TOKEN_HEADER, aiToken());
  expect(res.body.ok).toBe(true);
  expect(res.body.links).toHaveLength(0);
  expect(res.body.missing_links).toEqual(['ts-not-written-yet']);
});

// 自我連結不該出現在 links（否則每頁都連自己，純噪音）。
test('GET /ai/wiki/page 自我連結被濾掉', async () => {
  await dbModule.query(
    `INSERT INTO wiki_pages (project_id,slug,title,node_type,content)
     VALUES ($1,'ts-self','自連','troubleshooting','見 [[ts-self]]')`,
    [projectId]);
  const res = await request(app).get('/ai/wiki/page?project=hungjou&slug=ts-self').set(AI_TOKEN_HEADER, aiToken());
  expect(res.body.links).toHaveLength(0);
  expect(res.body.missing_links).toHaveLength(0);
});

// 無連結的頁面不得因此變形：links/missing_links 一律是陣列，呼叫端不必判斷 undefined。
test('GET /ai/wiki/page 無 [[]] 的頁 → links 為空陣列而非 undefined', async () => {
  const res = await request(app).get('/ai/wiki/page?project=hungjou&slug=sale').set(AI_TOKEN_HEADER, aiToken());
  expect(res.body.content).toBe('銷售內容');
  expect(res.body.links).toEqual([]);
  expect(res.body.missing_links).toEqual([]);
});

// 意圖：專案參數可以是 folder_name 或 name，原本用 `folder_name=$1 OR name=$1` 直接 join——
// A 的 folder_name 撞到 B 的 name 時（中文專案名＋英文資料夾名的慣例下很容易發生），一次查詢會
// 同時撈到兩個專案的頁。單頁的 rows[0] 因此不確定，而 links 會把別的專案的排障結論摘要一起餵給 agent。
describe('跨專案隔離（folder_name 與 name 撞號）', () => {
  let otherId;
  beforeAll(async () => {
    // 另一個專案，它的 name 正好等於本專案的 folder_name
    const { rows: [p] } = await dbModule.query(
      "INSERT INTO projects (name,folder_name,odoo_version) VALUES ('hungjou','other-folder','17.0') RETURNING id");
    otherId = p.id;
    await dbModule.query(
      `INSERT INTO wiki_pages (project_id,slug,title,node_type,content,description)
       VALUES ($1,'ts-secret','別家的機密結論','troubleshooting','不該被看到','別家的摘要')`,
      [otherId]);
  });

  test('pages 不得混入另一個專案的頁', async () => {
    const res = await request(app).get('/ai/wiki/pages?project=hungjou').set(AI_TOKEN_HEADER, aiToken());
    expect(res.body.pages.map(p => p.slug)).not.toContain('ts-secret');
  });

  test('search 不得搜到另一個專案的頁', async () => {
    const res = await request(app).get('/ai/wiki/search?project=hungjou&q=機密').set(AI_TOKEN_HEADER, aiToken());
    expect(res.body.hits.map(h => h.slug)).not.toContain('ts-secret');
  });

  test('page 的 links 不得解出另一個專案的同名 slug', async () => {
    await dbModule.query(
      `INSERT INTO wiki_pages (project_id,slug,title,node_type,content)
       VALUES ($1,'ts-ref','引用','troubleshooting','見 [[ts-secret]]')`,
      [projectId]);
    const res = await request(app).get('/ai/wiki/page?project=hungjou&slug=ts-ref').set(AI_TOKEN_HEADER, aiToken());
    expect(res.body.links).toEqual([]);              // 對方在別的專案 → 這裡查無
    expect(res.body.missing_links).toContain('ts-secret'); // 但要回報「這裡該有一則卻沒有」
  });
});

// 意圖：agent 常直接把錯誤訊息或檔案路徑丟進來搜，裡面的 _ 與 % 是 LIKE 的萬用字元。
// 不逸脫的話 `a_c` 會比對到 abc，搜出一堆不相干的頁；反過來真的要找 `a_c` 也找不準。
// pg-mem 不支援 LIKE 的逸脫（實測：pattern `%a\_c%` 回 0 列，真 PG 回 a_c 那列；而未逸脫的
// `%a_c%` 在 pg-mem 兩列都中＝正是本修正要擋的行為）。也不支援 ESCAPE 子句，寫了整句解析不了。
// 依既有慣例，pg-mem 的限制不改寫正式 SQL，跳過該測試並註解——正式環境用反斜線（PostgreSQL 的
// LIKE 預設逸脫字元）是正確的。
test.skip('GET /ai/wiki/search 的關鍵字含 _ 時當字面比對，不當萬用字元（pg-mem 不支援 LIKE 逸脫）', async () => {
  // 兩頁分開放才有鑑別力：同一頁同時含 abc 與 a_c 的話，_ 當不當萬用字元結果都一樣
  await dbModule.query(
    `INSERT INTO wiki_pages (project_id,slug,title,node_type,content)
     VALUES ($1,'ts-underscore','底線','troubleshooting','欄位 a_c 的定義'),
            ($1,'ts-wildcard','非底線','troubleshooting','欄位 abc 的定義')`,
    [projectId]);
  const res = await request(app).get('/ai/wiki/search?project=hungjou&q=a_c').set(AI_TOKEN_HEADER, aiToken());
  expect(res.body.ok).toBe(true);
  expect(res.body.hits.map(h => h.slug)).toContain('ts-underscore');
  expect(res.body.hits.map(h => h.slug)).not.toContain('ts-wildcard'); // _ 被當萬用字元的話這頁會一起中
});
