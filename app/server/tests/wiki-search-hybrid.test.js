// 意圖：/ai/wiki/search 的第二條腿（語意）與 RRF 合併。鎖四件會壞掉業務語意的事——
// (1) worker／索引未就緒時必須退回純 LIKE，且回傳形狀完全不變（這是階段 2 敢上線的唯一理由：
//     向量腿壞掉只是回到改動前的行為，不是搜尋失效）；
// (2) LIKE 完全對不上的查詢，靠語意仍要找得到——這正是本功能存在的理由（§1 的失效場景）；
// (3) 同一頁在兩條腿都命中時排更前（RRF 的本義），但同一頁的多個 chunk 不得灌票；
// (4) 向量腿不得撈到 analysis_yaml 的塊：兩者共用同一個 bucket，不分 kind 的話拿 wikiPageId
//     去查頁會查無，症狀是「命中數量對得上、內容卻少一半」。
process.env.JWT_SECRET = 'test-wiki-hybrid';
process.env.APP_SECRET = 'test-wiki-hybrid-secret';
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const { aiToken, AI_TOKEN_HEADER } = require('../lib/ai-token');

const emb = require('../lib/embedding');
const idx = require('../lib/embedding-index');

// 固定向量的假 embedder：測試絕不載入真實模型（每跑一次 130 MB ＋ 網路相依）。
// 用「一個詞一個維度」的詞袋當座標系——它有真正的鑑別力：查詢與文件共用的詞越多越接近，
// 完全不重疊就是 0，剛好能表達「LIKE 對不上但語意相近」這件事。
const VOCAB = ['庫存', '過帳', '維修', '銷售', '報價'];
function bagOfWords(text) {
  const v = new Float32Array(VOCAB.length);
  VOCAB.forEach((w, i) => { if (text.includes(w)) v[i] = 1; });
  const norm = Math.hypot(...v) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

let dbModule, app, projectId, userId;
beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  const { rows: [p] } = await dbModule.query(
    "INSERT INTO projects (name,folder_name,odoo_version) VALUES ('鴻久','hungjou','17.0') RETURNING id");
  projectId = p.id;
  // tasks.user_id 有 FK，建關聯資料前先建父列
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hybrid','x','H') RETURNING id");
  userId = u.id;
  // 刻意讓查詢詞與頁面內容「一個字都不重疊」：這樣 LIKE 必然 0 筆，命中只可能來自語意腿。
  await dbModule.query(
    `INSERT INTO wiki_pages (project_id,slug,title,node_type,content,description) VALUES
       ($1,'ts-stock','維修單過帳後庫存沒扣','troubleshooting','過帳流程漏了庫存異動','庫存異動的排障結論'),
       ($1,'mod-sale','銷售模組','module','報價與銷售流程說明','銷售模組概述')`,
    [projectId]);
  const a = express(); a.use(express.json());
  require('../wiki-routes').registerRoutes(a);
  app = a;
});
afterAll(() => { emb._resetForTesting(); idx._resetForTesting(); dbModule._setPoolForTesting(null); });

const search = (q) => request(app).get('/ai/wiki/search').query({ project: 'hungjou', q }).set(AI_TOKEN_HEADER, aiToken());

describe('索引未就緒', () => {
  beforeAll(() => { emb._resetForTesting(); idx._resetForTesting(); });

  // 這條是整個階段 2 的安全網：模型下載不到、worker 崩了、快取還沒載完，全都走這條路。
  test('worker 未就緒 → 退回純 LIKE，回傳形狀不變', async () => {
    const res = await search('庫存');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.hits.map(h => h.slug)).toEqual(['ts-stock']);
    expect(res.body.hits[0].content).toBeUndefined();          // 仍不回全文
    expect(res.body.hits[0].description).toBeTruthy();
  });

  // 未就緒時語意腿一筆都給不出來，該退回全目錄的行為（階段 0）不能被新的合併邏輯吃掉。
  test('worker 未就緒且 LIKE 也沒中 → 仍走階段 0 的全目錄回退', async () => {
    const res = await search('絕無此詞xyz');
    expect(res.body.fallback).toBe('all_pages');
    expect(res.body.hits.length).toBe(2);
  });
});

describe('語意腿就緒', () => {
  beforeAll(async () => {
    emb._setEmbedderForTesting(texts => texts.map(t => bagOfWords(t)));
    idx._resetForTesting();
    await idx.indexWikiPage((await dbModule.query(
      "SELECT id FROM wiki_pages WHERE project_id=$1 AND slug='ts-stock'", [projectId])).rows[0].id);
    await idx.indexWikiPage((await dbModule.query(
      "SELECT id FROM wiki_pages WHERE project_id=$1 AND slug='mod-sale'", [projectId])).rows[0].id);
    await idx.loadCache();
  });

  // 本功能存在的理由：agent 搜「過帳」時，wiki 那頁的標題寫的是「維修單過帳後庫存沒扣」，
  // 但這裡故意用一個 LIKE 完全對不上的詞——字對不上就是 0 筆，正是改動前的失效場景。
  test('LIKE 一筆都不中的查詢，語意腿仍找得到那一頁', async () => {
    const res = await search('維修');   // 兩頁的 content 都沒有「維修」二字，只有 ts-stock 的 title 有
    expect(res.body.ok).toBe(true);
    expect(res.body.hits.map(h => h.slug)).toContain('ts-stock');
    expect(res.body.fallback).toBeUndefined();   // 有命中就不該回退
  });

  // RRF 的本義：在兩份清單都出現的頁，分數是兩次 1/(k+rank) 相加，必然贏過只在一條腿出現的頁。
  test('兩條腿都命中的頁排在只有一條腿命中的頁之前', async () => {
    const res = await search('庫存');   // LIKE 中 ts-stock；語意上 ts-stock 也最近
    expect(res.body.hits[0].slug).toBe('ts-stock');
  });

  // 同一頁切成多塊時，塊數多的長頁面不得因此灌票（§2.6）——搜尋結果不該有重複的頁。
  test('同一頁的多個 chunk 只佔一個名次', async () => {
    const { rows } = await dbModule.query(
      'SELECT COUNT(*)::int AS n FROM embedding_chunks WHERE project_id=$1', [projectId]);
    expect(rows[0].n).toBeGreaterThan(0);
    const res = await search('庫存 過帳 維修');
    const slugs = res.body.hits.map(h => h.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  // analysis_yaml 的塊與 wiki 的塊住在同一個 bucket。不分 kind 的話，任務塊會佔掉名次，
  // 而它的 wikiPageId 是 null——查頁查無，結果被 filter 掉，症狀是「安靜地少了幾筆」。
  test('語意腿不得撈到 analysis_yaml 的塊', async () => {
    const { rows: [t] } = await dbModule.query(
      `INSERT INTO tasks (project_id, user_id, source, task_id, title, analysis_yaml, status)
       VALUES ($1,$2,'manual','T-1','庫存過帳規格','summary: 庫存過帳的規格','done') RETURNING id`,
      [projectId, userId]);
    await idx.indexTask(t.id);
    const res = await search('庫存');
    expect(res.body.hits.every(h => h.slug)).toBe(true);      // 每一筆都是真的 wiki 頁
    expect(res.body.hits.map(h => h.slug)).toContain('ts-stock');
  });
});
