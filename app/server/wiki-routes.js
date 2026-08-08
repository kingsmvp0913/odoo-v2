const { query } = require('./db');
const { verifyToken } = require('./auth');
const { initProjectWiki, refreshWikiNode } = require('./pipeline/library-agent');
const { aiEndpointGuard } = require('./lib/ai-token');
const { resolveProjectId } = require('./lib/project-ref');
const { enqueue: enqueueEmbedding, invalidate: invalidateEmbedding } = require('./lib/embedding-index');

// 語意腿的相似度下限。低於它的結果一律不算命中——不設下限的話 searchProject 只做排序取前 30，
// 索引非空就必定回傳非空，於是「搜不到」這件事再也不會發生：全目錄回退與 wiki_search_misses
// 兩條訊號同時失效，agent 把語意噪音當成命中的頁去讀。
// 0.82：e5-small 的 cosine 分佈很窄，實測（2026-08-08，28 頁真實 wiki）毫不相關的內容也有 0.80，
// 真正該中的落在 0.85–0.90。取 0.82 是「壓掉純噪音、留住弱相關」的落點。權宜值，故可用
// WIKI_SEMANTIC_MIN_SCORE 覆寫並在執行期讀取（不在載入時 snapshot，比照 lib/embedding 的 modelsDir）。
const SEMANTIC_MIN_SCORE = 0.82;
const semanticMinScore = () => Number(process.env.WIKI_SEMANTIC_MIN_SCORE ?? SEMANTIC_MIN_SCORE);

function registerRoutes(app) {
  const base = '/api/projects/:projectId/wiki';

  app.get(base, verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, slug, title, parent_id, node_type, updated_at
         FROM wiki_pages WHERE project_id = $1
         ORDER BY (node_type <> 'overview'), node_type, title ASC`,
        [req.params.projectId]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post(`${base}/init`, verifyToken, async (req, res) => {
    try {
      // 已經有 wiki 就擋在這裡。initProjectWiki 走 _upsertNode 的 ON CONFLICT DO UPDATE，
      // 誤觸一次就用骨架把累積下來的內容整個覆寫掉（排障結論、人工補的段落全沒，且無備份）。
      // 這是防禦縱深：前端不該讓使用者按到，但這條路徑的破壞是不可逆的，值得在端點再擋一次。
      const { rows: [{ n }] } = await query(
        'SELECT COUNT(*) AS n FROM wiki_pages WHERE project_id=$1', [req.params.projectId]);
      if (Number(n) > 0) {
        return res.status(409).json({ error: '本專案已有 wiki，重新建立會覆蓋既有內容；如需更新請用單頁的「⟳ 更新」' });
      }
      const { slug } = await initProjectWiki(req.params.projectId, req.userId);
      res.json({ ok: true, slug });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post(`${base}/:slug/refresh`, verifyToken, async (req, res) => {
    try {
      const { rows: [node] } = await query(
        'SELECT node_type FROM wiki_pages WHERE project_id=$1 AND slug=$2',
        [req.params.projectId, req.params.slug]
      );
      if (node?.node_type === 'notes') return res.status(400).json({ error: '專案備註為人工維護，不支援重新生成' });
      if (node?.node_type === 'troubleshooting') return res.status(400).json({ error: '疑難排解由排障／客服對話累積，無原始碼可重生' });
      const result = await refreshWikiNode(req.params.projectId, req.params.slug, req.userId);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post(base, verifyToken, async (req, res) => {
    try {
      const { slug, title, content } = req.body;
      if (!slug || !title) return res.status(400).json({ error: 'slug and title required' });
      const { rows } = await query(
        `INSERT INTO wiki_pages (project_id, slug, title, content) VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.params.projectId, slug, title, content || '']
      );
      // 人工在平台 UI 上新增／編輯的頁也要進語意索引：九個 enqueue 觸發點全在 pipeline 內，
      // 這兩條人工路徑漏掛的話，手寫的內容只有等夜間 sweep 才搜得到（fire-and-forget，
      // 比照 pipeline 的寫法——索引失敗不該讓存檔失敗）。
      enqueueEmbedding({ wikiPageId: rows[0].id });
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'slug already exists in this project' });
      res.status(500).json({ error: err.message });
    }
  });

  app.get(`${base}/:slug/raw`, verifyToken, async (req, res) => {
    try {
      const { rows: [page] } = await query(
        'SELECT content FROM wiki_pages WHERE project_id = $1 AND slug = $2',
        [req.params.projectId, req.params.slug]
      );
      if (!page) return res.status(404).send('Not found');
      res.type('text/plain').send(page.content);
    } catch (err) { res.status(500).send(err.message); }
  });

  app.get(`${base}/:slug`, verifyToken, async (req, res) => {
    try {
      const { rows: [page] } = await query(
        'SELECT * FROM wiki_pages WHERE project_id = $1 AND slug = $2',
        [req.params.projectId, req.params.slug]
      );
      if (!page) return res.status(404).json({ error: 'Not found' });
      res.json(page);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put(`${base}/:slug`, verifyToken, async (req, res) => {
    try {
      const { title, content } = req.body;
      const { rows } = await query(
        `UPDATE wiki_pages SET
           title = COALESCE($3, title),
           content = COALESCE($4, content),
           updated_at = NOW()
         WHERE project_id = $1 AND slug = $2 RETURNING *`,
        [req.params.projectId, req.params.slug, title || null, content ?? null]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      enqueueEmbedding({ wikiPageId: rows[0].id });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete(`${base}/:slug`, verifyToken, async (req, res) => {
    try {
      const { rows: [node] } = await query(
        'SELECT node_type FROM wiki_pages WHERE project_id=$1 AND slug=$2',
        [req.params.projectId, req.params.slug]
      );
      if (node?.node_type === 'notes') return res.status(400).json({ error: '專案備註不可刪除' });
      if (req.params.slug === 'troubleshooting') return res.status(400).json({ error: '疑難排解容器不可刪除（會連帶清空所有排障紀錄）；如需清理請刪除個別條目' });
      const { rows } = await query(
        'DELETE FROM wiki_pages WHERE project_id = $1 AND slug = $2 RETURNING id',
        [req.params.projectId, req.params.slug]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      // DB 那側靠 FK CASCADE 清乾淨，但記憶體快取沒有任何移除路徑——不清的話這頁的塊還在
      // 參與排序、佔著語意腿的名額，而回頭查頁已經查無（見 invalidate 的註解）。
      invalidateEmbedding({ wikiPageId: rows[0].id });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // description 一併回傳：只給 title 的話，agent 只能靠標題猜哪一頁相關，wiki 一多就必漏——
  // 而且漏掉沒有任何訊號（端點回 200＋清單，agent 當成「沒有相關記載」就不查了）。
  app.get('/ai/wiki/pages', aiEndpointGuard, async (req, res) => {
    try {
      const pid = await resolveProjectId(req.query.project);
      if (!pid) return res.json({ ok: true, pages: [] });
      const { rows } = await query(
        `SELECT slug, title, node_type, description FROM wiki_pages
          WHERE project_id=$1
          ORDER BY (node_type <> 'overview'), node_type, title ASC`,
        [pid]);
      res.json({ ok: true, pages: rows });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });

  // 全文搜尋：補掉「只能按標題挑頁」的缺口。回 slug/title/description（不回 content 全文，
  // 否則一次搜尋就把整個 wiki 灌進 agent 的 context——分兩階段才是省 token 的關鍵）。
  // 大小寫不敏感用 LOWER+LIKE（pg-mem 相容，ILIKE 在測試環境不保證可用）。
  app.get('/ai/wiki/search', aiEndpointGuard, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ ok: false, error: '缺 q 參數（要搜尋的關鍵字）' });
      const pid = await resolveProjectId(req.query.project);
      if (!pid) return res.json({ ok: true, hits: [] });
      // 逸脫 LIKE 萬用字元：agent 常直接把錯誤訊息或路徑丟進來搜，裡面的 _ 與 % 會被當成萬用字元
      //（`_` 比對任一字元、`%` 比對任意長度），搜出一堆不相干的頁，或反過來把該中的搜不到。
      // 不寫 ESCAPE 子句：反斜線本來就是 PostgreSQL 的 LIKE 預設逸脫字元，寫了反而讓 pg-mem 解析
      // 不了整句（它不支援該子句），測試環境會整組炸掉。
      const like = `%${q.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;
      // 兩條腿各取 30 名再合併，最終仍只回 20 筆。取 20 就合併會讓「LIKE 排 25、向量排 1」
      // 這種頁根本進不了候選集——RRF 只能對它看得到的名次動作。
      const { rows } = await query(
        `SELECT slug, title, node_type, description FROM wiki_pages
          WHERE project_id=$1
            AND (LOWER(title) LIKE $2 OR LOWER(content) LIKE $2
                 OR LOWER(COALESCE(description,'')) LIKE $2)
          ORDER BY (node_type <> 'troubleshooting'), title ASC
          LIMIT 30`,
        [pid, like]);
      const semantic = await semanticLeg(pid, q);
      const hits = fuseRRF(rows, semantic).slice(0, 20);
      if (hits.length) return res.json({ ok: true, hits });

      // 搜不到時不回空陣列。空 hits 沒有任何訊號，agent 會讀成「wiki 沒有記載這件事」就不再追，
      // 然後自己瞎猜——這比搜不到本身傷得更重。單一專案的目錄很小（實測最大的專案 28 頁、
      // title＋description 合計 671 字），與其回空，不如把整份目錄交出去讓它自己挑。
      // 刻意不加 LIMIT，與 /ai/wiki/pages 完全一致：回退的契約就是「等同呼叫 pages」，
      // 截斷會讓 agent 以為看到的是全部。目錄真的大到不能整包給的時候，該做的是語意檢索。
      await recordSearchMiss(pid, q);
      const { rows: all } = await query(
        `SELECT slug, title, node_type, description FROM wiki_pages
          WHERE project_id=$1
          ORDER BY (node_type <> 'overview'), node_type, title ASC`,
        [pid]);
      res.json({ ok: true, hits: all, fallback: 'all_pages' });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });

  // 語意檢索那條腿。索引還沒載完、worker 沒就緒、算 embedding 途中出錯——一律回空陣列，
  // 讓 LIKE 單獨作數。這是加法不是取代（規格 §2.1 決策③）：純語意對「確切的 model 名或錯誤碼」
  // 反而不準，而 LIKE 對那類查詢精準無比。所以這條腿壞掉時，搜尋只是回到改動前的行為，不是失效。
  async function semanticLeg(projectId, q) {
    try {
      const emb = require('./lib/embedding');
      const idx = require('./lib/embedding-index');
      if (!emb.isReady() || !idx.isCacheLoaded()) return [];
      const qv = await emb.embedQuery(q);
      const min = semanticMinScore();
      const hits = idx.searchProject(projectId, qv, { limit: 30, kind: 'wiki' })
        .filter(h => h.score >= min);
      if (!hits.length) return [];
      // 動態 IN 而非 `id = ANY($2::int[])`：pg-mem 對 SERIAL 主鍵跑 ANY(陣列) 永遠查不到列，
      // 測試會全綠但這條腿是死的（見 .claude/rules/testing.md 第 12 條與本檔 /ai/wiki/page 的註解）。
      const ids = hits.map(h => h.wikiPageId);
      const ph = ids.map((_, i) => `$${i + 2}`).join(',');
      const { rows } = await query(
        `SELECT id, slug, title, node_type, description FROM wiki_pages
          WHERE project_id=$1 AND id IN (${ph})`, [projectId, ...ids]);
      const byId = new Map(rows.map(r => [r.id, r]));
      // 依相似度名次還原順序：SQL 回來的順序無意義，而 RRF 吃的就是名次。
      return hits.map(h => byId.get(h.wikiPageId)).filter(Boolean)
        .map(({ slug, title, node_type, description }) => ({ slug, title, node_type, description }));
    } catch (err) {
      console.error('[wiki] 語意檢索失敗，退回純 LIKE：', err.message);
      return [];
    }
  }

  // Reciprocal Rank Fusion：兩條腿的分數不同量綱（LIKE 根本沒有分數，cosine 是 0–1），
  // 直接加權相加沒有意義。RRF 只看名次：score = Σ 1/(k + rank)，k=60 是業界慣用值。
  // ⚠ 這是刻意的行為改變：改動前 troubleshooting 是主要排序鍵（永遠排最前），現在 RRF 分數才是，
  // troubleshooting 退成同分時的次要鍵。回傳欄位與筆數不變，但同一個查詢的排序會變。
  const RRF_K = 60;
  function fuseRRF(...lists) {
    const score = new Map();
    const page = new Map();
    for (const list of lists) {
      list.forEach((row, i) => {
        score.set(row.slug, (score.get(row.slug) || 0) + 1 / (RRF_K + i + 1));
        if (!page.has(row.slug)) page.set(row.slug, row);
      });
    }
    return [...score.entries()]
      .sort((a, b) => b[1] - a[1]
        || (page.get(a[0]).node_type !== 'troubleshooting') - (page.get(b[0]).node_type !== 'troubleshooting')
        || String(page.get(a[0]).title).localeCompare(String(page.get(b[0]).title)))
      .map(([slug]) => page.get(slug));
  }

  // 搜不到的查詢留樣本：這是事後分辨「關鍵字猜不中」與「wiki 根本沒寫」的唯一依據
  //（前者靠改進檢索能救，後者只能補內容），也是語意檢索上線後的對照組來源。
  // 寫失敗不影響搜尋結果——這是觀測資料，不該讓 agent 的查詢跟著失敗；但也不無聲吞掉。
  async function recordSearchMiss(projectId, q) {
    try {
      await query('INSERT INTO wiki_search_misses (project_id, q) VALUES ($1, $2)', [projectId, q]);
    } catch (err) {
      console.error('[wiki] 記錄搜尋未命中失敗：', err.message);
    }
  }

  // content 裡的 [[slug]] 一併解出對方的 title/description。搜尋解決的是「我知道關鍵字，找得到嗎」，
  // 這個解決的是「我根本不知道有這個東西存在」——排障結論常是成串的（同一個現象牽三四則），
  // 靠關鍵字撞不出來。只回摘要不回對方全文：要不要真的去讀，由讀的人決定。
  // 用動態 IN 而非 `slug = ANY($2::text[])`：pg-mem 對「有索引的欄位」跑 ANY(陣列) 會靜默回 0 列
  //（wiki_pages 的 (project_id, slug) 正好有 unique index），測試會全綠但功能是死的。
  app.get('/ai/wiki/page', aiEndpointGuard, async (req, res) => {
    try {
      const pid = await resolveProjectId(req.query.project);
      if (!pid) return res.json({ ok: false, error: '找不到該 wiki 頁' });
      const { rows: [page] } = await query(
        'SELECT slug, title, content FROM wiki_pages WHERE project_id=$1 AND slug=$2',
        [pid, req.query.slug]);
      if (!page) return res.json({ ok: false, error: '找不到該 wiki 頁' });

      const refs = [...new Set(
        (String(page.content || '').match(/\[\[[a-zA-Z0-9_-]+\]\]/g) || []).map(m => m.slice(2, -2))
      )].filter(s => s !== page.slug);
      let links = [];
      if (refs.length) {
        const ph = refs.map((_, i) => `$${i + 2}`).join(',');
        const { rows } = await query(
          `SELECT slug, title, description, node_type FROM wiki_pages
            WHERE project_id=$1 AND slug IN (${ph})`,
          [pid, ...refs]);
        links = rows;
      }
      // 連到還不存在的 slug 不是錯誤——那是「這裡該有一則但還沒寫」的記號，照樣回報讓人看得到缺口。
      const missing = refs.filter(s => !links.some(l => l.slug === s));
      res.json({ ok: true, ...page, links, missing_links: missing });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });
}

module.exports = { registerRoutes };
