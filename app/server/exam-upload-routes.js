/**
 * exam-upload-routes.js — 同事上傳考試截圖
 *
 * 與 exam-routes.js 分開的理由：**這條路不用平台帳號**。同事為了傳一張圖去開
 * 平台帳號沒道理，所以走 X-Token（一組共用通行碼）。認證模型不同的東西混在
 * 同一個檔裡，遲早有人把 verifyToken 加到這幾支上、或把 X-Token 漏到別支去。
 *
 * POST 收下後立刻在背景啟動佇列，但不 hold HTTP 等判題完成——判題要燒 token、
 * 跑好幾分鐘。落 exam_uploads 後先回 queued，結果由考試工作台透過 DB＋socket 取得。
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { uploadRoot } = require('./lib/attachments');
const { decodeImage, sniffImage, readUploadToken, peekUploadToken, issueUploadToken,
  isLocal, saveImage, validateItem } = require('./lib/exam/upload');
const { runQueue } = require('./lib/exam/worker');
const { listPages, archiveBank } = require('./lib/exam/archive');
const { emitAll } = require('./notify');

const MAX_IMAGE_BYTES = parseInt(process.env.EXAM_MAX_IMAGE_BYTES || String(20 * 1024 * 1024), 10);
const BATCH_BODY_LIMIT = process.env.EXAM_BATCH_BODY_LIMIT || '60mb';

// 這兩個在**執行期**讀 env，不在模組載入時 snapshot（專案規則 122）。
// snapshot 的話改了設定要重啟才生效；而且測試裡 describe 的 callback 比
// beforeAll 更早跑，snapshot 會拿到測試還沒設好的值——實測踩過，
// 症狀是「找不到通行碼」的 503 而不是預期的 401，錯誤完全不指向成因。
const dataDir = () => process.env.EXAM_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const batchLimit = () => parseInt(process.env.EXAM_BATCH_LIMIT || '50', 10);

// memoryStorage：檔案要先過 magic bytes 檢查才落地。用 diskStorage 的話
// 壞檔已經寫進磁碟了，還得回頭刪。
const shotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
});

/**
 * **必須排在 multer 之前。**
 *
 * 擋在 multer 後面時檔案已經落地，同網段任何人都能反覆上傳 20MB 圖把磁碟灌爆
 * （原專案實測踩過）。
 *
 * 只認 X-Token header 與 ?token=，**不吃 req.body.token**——body 要等 multer／
 * express.json 解析完才有，那時已經太晚了。
 */
function checkExamToken(req, res, next) {
  // 本機來的免 token：從 127.0.0.1 開儀表板的就是這台機器自己。
  // 判斷一律用 socket.remoteAddress，絕不可看 header（同網段誰都偽造得出來）。
  if (isLocal(req)) return next();

  // 平台帳號也放行。X-Token 是給「不想開平台帳號的同事」用的旁路，不是唯一的路——
  // 沒有這一段的話，作戰台頁面（瀏覽器來自區網，isLocal 為 false）明明已經登入，
  // 上傳卻一律 401，而畫面上看起來像「通行碼沒設定」。
  // 只驗簽章不查 users：這裡的授權門檻本來就低於 X-Token（那是一組共用碼），
  // 而 index.js 的未核准閘門已經先擋過未核准帳號。
  const auth = req.headers && req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      require('jsonwebtoken').verify(auth.slice(7), process.env.JWT_SECRET);
      return next();
    } catch { /* 壞 token 不放行，往下走 X-Token 那條 */ }
  }

  // 過期與從沒設定過要分得出來：同事看到「尚未設定」會去找管理員要一組全新的，
  // 而其實他只要請人在作戰台按一下重產。
  const current = peekUploadToken(dataDir());
  if (!current) {
    return res.status(503).json({ error: '尚未產生上傳通行碼（請在考試作戰台的「串接說明」產生）' });
  }
  if (current.expired) {
    return res.status(401).json({ error: '通行碼已過期（效期 3 小時），請重新產生' });
  }
  const got = req.get('X-Token') || req.query.token;
  if (got !== current.token) return res.status(401).json({ error: '通行碼不對' });
  next();
}

async function resolveBank(bankRef) {
  if (!bankRef) return null;
  const asId = parseInt(bankRef, 10);
  const sql = Number.isInteger(asId) && String(asId) === String(bankRef)
    ? `SELECT id, label, odoo_version FROM exam_banks WHERE id = $1`
    : `SELECT id, label, odoo_version FROM exam_banks WHERE label = $1 ORDER BY id DESC LIMIT 1`;
  const { rows } = await query(sql, [Number.isInteger(asId) && String(asId) === String(bankRef) ? asId : bankRef]);
  return rows[0] || null;
}

async function insertUpload({ bankId, batchKey, batchLabel, page, answer, responder, imagePath, isTest, section }) {
  const { rows } = await query(
    `INSERT INTO exam_uploads
       (bank_id, batch_key, batch_label, page, answer_raw, responder, image_path, is_test, section_title)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [bankId, batchKey || null, batchLabel || null, String(page), answer,
     responder || null, imagePath, !!isTest, sectionValue(section)]
  );
  return rows[0].id;
}

// 章節名前後空白會讓「同一章」變成兩章（'Sales ' ≠ 'Sales'），而畫面上看不出差別。
const sectionValue = v => (v == null ? null : String(v).trim() || null);

// '1' / 'true' / 'yes' / 'on' 為測試資料，其餘與未帶一律正式。
// 統計數字若把測試混進去，「不一致 N 筆」這個唯一要看的數字就沒用了。
const asTest = v => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

// 同一題庫只留一支 drain。POST 發生在既有 job 執行期間時，該 job 的 snapshot 不會
// 吃到新列，所以跑完後必須再看一次 pending，直到真正清空為止。
const scheduled = new Map();
function scheduleQueue(bankId) {
  const active = scheduled.get(bankId);
  if (active) {
    // runQueue 只處理呼叫當下的 pending snapshot；記下執行期間又有 POST 進來，
    // 讓現有 drain 跑完後再掃一次。這個旗標不需查 DB，也不會在 Jest teardown
    // 後留下背景 query。
    active.dirty = true;
    return active.task;
  }
  const state = { dirty: false, task: null };
  state.task = (async () => {
    do {
      state.dirty = false;
      await runQueue(require('./db'), {
        bankId,
        onEvent: (e) => { try { emitAll('exam-progress', e); } catch (_) { /* DB 才是真相 */ } },
      });
    } while (state.dirty);
  })().catch(e => console.error('[EXAM-WORKER]', e.message)).finally(() => {
    scheduled.delete(bankId);
  });
  scheduled.set(bankId, state);
  return state.task;
}

function answerValue(value, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error('答案不可空白');
    return null;
  }
  const raw = Array.isArray(value) ? value : String(value).split(/[,，、\s]+/);
  const out = [...new Set(raw.map(x => String(x).trim().toUpperCase()).filter(Boolean))];
  if (!out.length) {
    if (required) throw new Error('答案不可空白');
    return null;
  }
  if (out.some(x => !/^[A-Z]$/.test(x))) throw new Error('答案只能是選項字母');
  return out;
}

function registerRoutes(app) {
  // 通行碼的查詢與重產。**走 verifyToken，不走 checkExamToken**——拿舊碼換新碼
  // 等於永不過期，3 小時效期就白設了。要新的一律得有平台帳號。
  app.get('/api/exam/upload-token', verifyToken, (req, res) => {
    const t = peekUploadToken(dataDir());
    if (!t) return res.json({ exists: false });
    // 過期的不吐值：貼出去也用不了，只會讓人以為還能用
    res.json({ exists: true, expired: t.expired, expires_at: t.expiresAt, token: t.expired ? null : t.token });
  });

  app.post('/api/exam/upload-token', verifyToken, (req, res) => {
    const t = issueUploadToken(dataDir());
    res.json({ token: t.token, expires_at: t.expiresAt });
  });

  // 單筆上傳（multipart）。checkExamToken 在 shotUpload 之前——順序是安全的一部分。
  app.post('/api/exam/submit', checkExamToken, shotUpload.single('screenshot'), async (req, res) => {
    try {
      const bank = await resolveBank(req.body.bank);
      if (!bank) return res.status(400).json({ error: '找不到題庫（bank 給 id 或 label）' });
      if (!req.file) return res.status(400).json({ error: '缺少 screenshot' });

      const page = String(req.body.page ?? '').trim();
      if (!page) return res.status(400).json({ error: '缺少 page' });
      const answer = String(req.body.answer ?? '').trim();
      if (!answer) return res.status(400).json({ error: '缺少 answer' });

      // mimetype 可偽造，一律以檔頭為準
      const ext = sniffImage(req.file.buffer);
      if (!ext) {
        return res.status(400).json({ error: '不是圖片檔（檔頭認不出已知的圖片格式）' });
      }

      const imagePath = saveImage({ uploadRoot: uploadRoot(), bankId: bank.id, buf: req.file.buffer, ext });
      const id = await insertUpload({
        bankId: bank.id, batchKey: req.body.batch, batchLabel: req.body.label,
        page, answer, responder: req.body.name, section: req.body.section,
        imagePath, isTest: asTest(req.body.test),
      });
      res.json({ id, bank: bank.label, page, status: 'queued' });
      scheduleQueue(bank.id);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 批次上傳（JSON + base64）。
  //
  // express.json 掛在**這條路由上**且排在 checkExamToken 之後，不是全域 app.use——
  // 全域掛等於未認證就能塞 60MB 進記憶體（與 multer 同一個道理）。
  app.post('/api/exam/batch', checkExamToken, express.json({ limit: BATCH_BODY_LIMIT }), async (req, res) => {
    try {
      const bank = await resolveBank(req.body.bank);
      if (!bank) return res.status(400).json({ error: '找不到題庫（bank 給 id 或 label）' });

      const items = Array.isArray(req.body.items) ? req.body.items : [];
      if (!items.length) return res.status(400).json({ error: 'items 是空的' });
      if (items.length > batchLimit()) {
        return res.status(400).json({ error: `一次最多 ${batchLimit()} 筆，這批有 ${items.length} 筆` });
      }

      // 單筆壞掉不讓整批失敗：好的收下，壞的具名回報。同事一次丟 20 題，
      // 不該因為第 13 題漏填答案就得整批重送、重燒一次 token。
      const accepted = [], rejected = [];
      const batchKey = String(req.body.batch || crypto.randomUUID());
      const batchLabel = String(req.body.label || '').trim() || null;
      for (const [i, it] of items.entries()) {
        const bad = validateItem(it, i);
        if (bad) { rejected.push(bad); continue; }
        const buf = decodeImage(it.image);
        const ext = sniffImage(buf);
        const imagePath = saveImage({ uploadRoot: uploadRoot(), bankId: bank.id, buf, ext });
        const id = await insertUpload({
          bankId: bank.id, batchKey, batchLabel, page: it.page, answer: it.answer,
          responder: it.name || req.body.name, imagePath,
          section: it.section ?? req.body.section,
          isTest: asTest(it.test ?? req.body.test),
        });
        accepted.push({ id, page: String(it.page) });
      }
      res.json({ bank: bank.label, batch: batchKey, accepted, rejected, status: 'queued' });
      if (accepted.length) scheduleQueue(bank.id);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 觸發佇列。**立刻回 {jobId} 再背景跑**——判題要燒 token、跑好幾分鐘，
  // hold 住 HTTP 連線兩邊都難用（呼叫端逾時，server 還在寫）。
  //
  // 同一個題庫只允許一個工作在跑；第二個回 409 而且**要講得出在跑什麼、
  // 多久、進度到哪**——只說「還在跑」等於沒說（原專案實測的使用者回饋）。
  app.post('/api/exam/run', verifyToken, express.json(), async (req, res) => {
    const bankId = parseInt(req.body.bank, 10);
    if (!Number.isInteger(bankId)) return res.status(400).json({ error: '缺少 bank' });

    const busy = (await query(
      `SELECT id, phase, pages_done, pages_total, started_at FROM exam_jobs
        WHERE bank_id = $1 AND status = 'running' ORDER BY id DESC LIMIT 1`, [bankId])).rows[0];
    if (busy) {
      const mins = Math.round((Date.now() - new Date(busy.started_at).getTime()) / 60000);
      return res.status(409).json({
        error: `這份題庫已經有工作在跑：${busy.phase || '處理中'}，` +
               `已跑 ${mins} 分鐘，進度 ${busy.pages_done}/${busy.pages_total}`,
        jobId: busy.id,
      });
    }

    const pending = (await query(
      `SELECT COUNT(*)::int c FROM exam_uploads WHERE bank_id = $1 AND status = 'pending'`,
      [bankId])).rows[0].c;
    if (!pending) return res.status(400).json({ error: '沒有待處理的上傳' });

    res.json({ started: true, pending });

    // 回應之後才開跑。失敗只能記在 DB 與 log——這時連線已經關了。
    //
    // 廣播走平台既有的 notify.emitAll，不自己接 io：socket 實例只在 index.js
    // 的 listen 之後才有，模組層拿不到，而 notify.js 已經處理好那個時序。
    scheduleQueue(bankId);
  });

  // 工作歷程。進度的真相在這裡，socket 廣播只是讓開著頁面的人即時看到——
  // 廣播錯過了就沒了，重整一次前端記憶體就空的。
  app.get('/api/exam/jobs', verifyToken, async (req, res) => {
    const bankId = parseInt(req.query.bank, 10);
    const params = [], where = [];
    if (Number.isInteger(bankId)) { params.push(bankId); where.push(`bank_id = $${params.length}`); }
    const { rows } = await query(`
      SELECT id, bank_id, status, phase, pages_done, pages_total, started_at, updated_at
        FROM exam_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT 50`, params);
    res.json(rows);
  });

  // 佇列現況。這支給平台使用者看，所以用 JWT 而不是 X-Token。
  app.get('/api/exam/uploads', verifyToken, async (req, res) => {
    const bankId = parseInt(req.query.bank, 10);
    const params = [], where = [];
    if (Number.isInteger(bankId)) { params.push(bankId); where.push(`bank_id = $${params.length}`); }
    const { rows } = await query(`
      SELECT id, bank_id, batch_key, batch_label, page, responder, status, error,
             is_test, created_at, updated_at
        FROM exam_uploads
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT 200`, params);
    res.json(rows);
  });

  // 考試工作台一次取得上傳與逐題結果。官方答案優先；沒有官方答案才使用最新 adversary。
  app.get('/api/exam/dashboard', verifyToken, async (req, res) => {
    const bankId = parseInt(req.query.bank, 10);
    if (!Number.isInteger(bankId)) return res.status(400).json({ error: '缺少 bank' });
    const bank = (await query(
      `SELECT id, label, odoo_version FROM exam_banks WHERE id=$1`, [bankId])).rows[0];
    if (!bank) return res.status(404).json({ error: '找不到題庫' });

    const uploads = (await query(`
      SELECT id, batch_key, batch_label, page, responder, status, error, is_test, created_at, updated_at
        FROM exam_uploads WHERE bank_id=$1 ORDER BY id DESC`, [bankId])).rows;
    const attempts = (await query(`
      SELECT a.id AS attempt_id, a.upload_id, a.page, a.no, a.answer_their, a.answer_final,
             a.responder, a.created_at, i.id AS item_id, i.question_en, i.question_zh,
             i.options, i.qtype, i.answer_official, i.official_from, i.confidence, i.history_wrong
        FROM exam_attempts a JOIN exam_items i ON i.id=a.item_id
       WHERE a.bank_id=$1 ORDER BY a.id`, [bankId])).rows;

    // 歷史答案＝同一題在**別場考試**裡我當時勾的最終答案。
    //
    // 排除本場（a.bank_id <> $2）：拿這一場自己的答案當「歷史」等於自問自答。
    // 全撈出來在 Node 端取最新，不用相關子查詢或 DISTINCT ON——pg-mem 兩者都不支援，
    // 而那種落差會偽裝成「測試卡住」。
    const itemIds = [...new Set(attempts.map(a => a.item_id))];
    const history = itemIds.length ? (await query(`
      SELECT h.item_id, h.answer_final, b.label, b.taken_at, h.id
        FROM exam_attempts h JOIN exam_banks b ON b.id = h.bank_id
       WHERE h.item_id = ANY($1::int[]) AND h.bank_id <> $2 AND h.answer_final IS NOT NULL
       ORDER BY h.id`, [itemIds, bankId])).rows : [];
    const lastHistory = new Map();
    for (const h of history) lastHistory.set(h.item_id, h);

    const verdicts = attempts.length ? (await query(`
      SELECT id, attempt_id, correct_answer, confidence, reason
        FROM exam_verdicts
       WHERE attempt_id = ANY($1::int[]) AND kind='adversary' ORDER BY id`,
      [attempts.map(a => a.attempt_id)])).rows : [];
    const latest = new Map();
    for (const v of verdicts) latest.set(v.attempt_id, v);

    const votes = attempts.length ? (await query(`
      SELECT attempt_id, voter_key, answer FROM exam_votes
       WHERE attempt_id = ANY($1::int[]) ORDER BY id`,
      [attempts.map(a => a.attempt_id)])).rows : [];
    const byAttempt = new Map();
    for (const v of votes) {
      if (!byAttempt.has(v.attempt_id)) byAttempt.set(v.attempt_id, []);
      byAttempt.get(v.attempt_id).push(v);
    }
    for (const a of attempts) {
      if (typeof a.options === 'string') {
        try { a.options = JSON.parse(a.options); } catch { a.options = []; }
      }
      const official = a.official_from && Array.isArray(a.answer_official) && a.answer_official.length;
      const verdict = latest.get(a.attempt_id) || null;
      a.review_answer = official ? a.answer_official : (verdict && verdict.correct_answer);
      a.review_source = official ? 'official' : (verdict ? 'review' : null);
      // 用 exam_items.confidence（系統算出來的單一信心度）而不是 verdict.confidence
      // （模型自報的數字）。模型自報的只是 baseConfidence 的其中一個輸入，而且
      // **它常常根本不回**——實測 eCommerce 那一頁四題全是 null，畫面上「一致且
      // 有把握」的勾勾因此一個都沒出現，看起來像功能壞了。
      a.review_confidence = official ? 100 : a.confidence;

      // 歷史答案只在「有把握」或「已知大概率錯」時才給前端。中間地帶（信心不高
      // 又沒被標錯）顯示出來只會多一個沒有判準的數字，考試當下反而干擾。
      // 被標大概率錯的一律顯示——那正是要提醒「別再選一次」的情況。
      const past = lastHistory.get(a.item_id) || null;
      const trusted = Number.isFinite(a.confidence) && a.confidence > 80;
      a.history_answer = past && (trusted || a.history_wrong) ? past.answer_final : null;
      a.history_bank = a.history_answer ? past.label : null;
      delete a.confidence;
      a.review_reason = official ? '官方確認正確' : (verdict && verdict.reason);

      const rows = byAttempt.get(a.attempt_id) || [];
      const counts = {};
      for (const row of rows) for (const letter of (row.answer || [])) counts[letter] = (counts[letter] || 0) + 1;
      a.vote_total = rows.length;
      a.vote_options = counts;
      a.has_voted = rows.some(row => row.voter_key === `user:${req.userId}`);
      delete a.answer_official;
      delete a.official_from;
    }
    res.json({ bank, uploads, attempts });
  });

  // 重跑某一頁。中斷（重啟、逾時、模型格式跑掉）之後靠這支救回來，不必重新上傳。
  //
  // 一定要先清掉那一頁已建的作答：attempts 建在審查之前，中途失敗會留下一批沒有
  // verdict 的孤兒，不清就重跑等於再建一份重複的（實測踩過，8 題的頁變成 16 筆）。
  app.post('/api/exam/uploads/:id/retry', verifyToken, express.json(), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 不合法' });
      const up = (await query(
        `SELECT id, bank_id, page, status FROM exam_uploads WHERE id = $1`, [id])).rows[0];
      if (!up) return res.status(404).json({ error: '找不到這一頁' });
      if (up.status === 'running') {
        return res.status(409).json({ error: '這一頁正在跑，等它結束或先停掉再重試' });
      }

      await query(`DELETE FROM exam_attempts WHERE upload_id = $1`, [id]);
      await query(
        `UPDATE exam_uploads SET status='pending', error=NULL, updated_at=NOW() WHERE id=$1`, [id]);
      emitAll('exam-progress', { bankId: up.bank_id, page: up.page, status: 'pending' });
      res.json({ ok: true, page: up.page });
      scheduleQueue(up.bank_id);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 把「上次那個答案大概率錯」的旗標掛在題目上（題庫頁手動勾）。
  //
  // 官方確認過的題不給改：它的答案是硬事實，標它「大概率錯」只會讓考試當下看到
  // 兩個互相矛盾的訊號。
  app.patch('/api/exam/items/:id/history-wrong', verifyToken, express.json(), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 不合法' });
      const item = (await query(
        `SELECT id, certain, official_from FROM exam_items WHERE id = $1`, [id])).rows[0];
      if (!item) return res.status(404).json({ error: '找不到題目' });
      if (item.certain || item.official_from) {
        return res.status(409).json({ error: '官方確認題不需要標記' });
      }
      const wrong = req.body.wrong === true;
      await query(
        `UPDATE exam_items SET history_wrong = $2, updated_at = NOW() WHERE id = $1`, [id, wrong]);
      emitAll('exam-progress', { itemId: id, status: 'history-wrong' });
      res.json({ ok: true, wrong });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 歸檔前的現況：每一頁的章節名、題數、已作答數。畫面靠這支列出可勾選的區塊。
  app.get('/api/exam/banks/:id/archive', verifyToken, async (req, res) => {
    try {
      const bankId = parseInt(req.params.id, 10);
      if (!Number.isInteger(bankId)) return res.status(400).json({ error: 'id 不合法' });
      const bank = (await query(
        `SELECT id, label, odoo_version, status FROM exam_banks WHERE id = $1`, [bankId])).rows[0];
      if (!bank) return res.status(404).json({ error: '找不到題庫' });
      res.json({ bank, pages: await listPages(require('./db'), bankId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 歸檔：寫章節名，並把勾了「這章沒答錯」的章節推導成官方正解。
  //
  // **這一步不可逆**（certain 取 OR，蓋不掉），所以跳過與衝突一律具名回傳給畫面顯示，
  // 不做「靜靜成功」。
  app.post('/api/exam/banks/:id/archive', verifyToken, express.json(), async (req, res) => {
    try {
      const bankId = parseInt(req.params.id, 10);
      if (!Number.isInteger(bankId)) return res.status(400).json({ error: 'id 不合法' });
      const bank = (await query(`SELECT id FROM exam_banks WHERE id = $1`, [bankId])).rows[0];
      if (!bank) return res.status(404).json({ error: '找不到題庫' });

      const busy = (await query(
        `SELECT id FROM exam_jobs WHERE bank_id = $1 AND status = 'running' LIMIT 1`,
        [bankId])).rows[0];
      if (busy) return res.status(409).json({ error: '這份題庫還有工作在跑，跑完再歸檔' });

      const pages = Array.isArray(req.body.pages) ? req.body.pages : [];
      if (!pages.length) return res.status(400).json({ error: 'pages 是空的' });

      const stat = await archiveBank(require('./db'), { bankId, pages });
      emitAll('exam-progress', { bankId, status: 'archived' });
      res.json({ ok: true, ...stat });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 清空這份題庫「這一場」的作答：uploads 與 attempts（投票隨 attempts 級聯）。
  //
  // **不刪 exam_items 與 exam_verdicts**——那是跨考次累積的題庫知識，砍掉等於把
  // 花 token 審出來的結果丟了。這支清的是「這次考試的紀錄」，不是題庫本身。
  //
  // 有工作在跑時拒絕：worker 正在對這些列寫入，中途抽掉會讓它撞 FK 而整批 failed，
  // 而畫面上只看得到「失敗」查不出原因。
  app.delete('/api/exam/banks/:id/attempts', verifyToken, async (req, res) => {
    try {
      const bankId = parseInt(req.params.id, 10);
      if (!Number.isInteger(bankId)) return res.status(400).json({ error: 'id 不合法' });
      const bank = (await query(`SELECT id FROM exam_banks WHERE id = $1`, [bankId])).rows[0];
      if (!bank) return res.status(404).json({ error: '找不到題庫' });

      const busy = (await query(
        `SELECT id FROM exam_jobs WHERE bank_id = $1 AND status = 'running' LIMIT 1`,
        [bankId])).rows[0];
      if (busy) return res.status(409).json({ error: '這份題庫還有工作在跑，跑完再清空' });

      // attempts 先於 uploads：attempts.upload_id 是 ON DELETE SET NULL，先刪 uploads
      // 的話 attempts 會變成孤兒留在畫面上，看起來像「清了但沒清乾淨」。
      const att = await query(`DELETE FROM exam_attempts WHERE bank_id = $1 RETURNING id`, [bankId]);
      const ups = await query(`DELETE FROM exam_uploads WHERE bank_id = $1 RETURNING id`, [bankId]);
      emitAll('exam-progress', { bankId, status: 'cleared' });
      res.json({ ok: true, attempts: att.rows.length, uploads: ups.rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/exam/attempts/:id/vote', verifyToken, express.json(), async (req, res) => {
    try {
      const attemptId = parseInt(req.params.id, 10);
      if (!Number.isInteger(attemptId)) return res.status(400).json({ error: 'id 不合法' });
      const answer = answerValue(req.body.answer, { required: true });
      const attempt = (await query(
        `SELECT i.official_from, i.answer_official
           FROM exam_attempts a JOIN exam_items i ON i.id=a.item_id WHERE a.id=$1`,
        [attemptId])).rows[0];
      if (!attempt) return res.status(404).json({ error: '找不到這題' });
      if (attempt.official_from && attempt.answer_official && attempt.answer_official.length) {
        return res.status(409).json({ error: '官方確認題已鎖定' });
      }
      const voterKey = `user:${req.userId}`;
      const voted = (await query(
        `SELECT 1 FROM exam_votes WHERE attempt_id=$1 AND voter_key=$2`, [attemptId, voterKey])).rows.length;
      if (voted) return res.status(409).json({ error: '這題已經投過票' });
      // 畫面不公開姓名，但以平台 user id 保證同一人、同一題只能投一次。
      await query(`INSERT INTO exam_votes (attempt_id,voter_key,answer) VALUES ($1,$2,$3)`,
        [attemptId, voterKey, answer]);
      emitAll('exam-progress', { attemptId, status: 'vote' });
      res.json({ ok: true, answer });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.patch('/api/exam/attempts/:id/final', verifyToken, express.json(), async (req, res) => {
    try {
      const attemptId = parseInt(req.params.id, 10);
      if (!Number.isInteger(attemptId)) return res.status(400).json({ error: 'id 不合法' });
      const answer = answerValue(req.body.answer);
      const attempt = (await query(
        `SELECT i.official_from, i.answer_official
           FROM exam_attempts a JOIN exam_items i ON i.id=a.item_id WHERE a.id=$1`,
        [attemptId])).rows[0];
      if (!attempt) return res.status(404).json({ error: '找不到這題' });
      if (attempt.official_from && attempt.answer_official && attempt.answer_official.length) {
        return res.status(409).json({ error: '官方確認題已鎖定' });
      }
      const out = await query(
        `UPDATE exam_attempts SET answer_final=$2 WHERE id=$1 RETURNING id`, [attemptId, answer]);
      emitAll('exam-progress', { attemptId, status: 'final' });
      res.json({ ok: true, answer });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

module.exports = { registerRoutes, checkExamToken, scheduleQueue, answerValue };
