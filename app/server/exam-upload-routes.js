/**
 * exam-upload-routes.js — 同事上傳考試截圖
 *
 * 與 exam-routes.js 分開的理由：**這條路不用平台帳號**。同事為了傳一張圖去開
 * 平台帳號沒道理，所以走 X-Token（一組共用通行碼）。認證模型不同的東西混在
 * 同一個檔裡，遲早有人把 verifyToken 加到這幾支上、或把 X-Token 漏到別支去。
 *
 * 上傳只負責「收下並排隊」，不當場判題——判題要燒 token、跑好幾分鐘，綁在
 * HTTP 請求上兩邊都難用。落 exam_uploads 後回 {id}，實際執行由佇列處理。
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { uploadRoot } = require('./lib/attachments');
const { decodeImage, sniffImage, readUploadToken, isLocal, saveImage, validateItem } = require('./lib/exam/upload');
const { runQueue } = require('./lib/exam/worker');
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

  const want = readUploadToken(dataDir());
  if (!want) {
    return res.status(503).json({ error: '尚未設定上傳通行碼（data/exam/upload-token.txt）' });
  }
  const got = req.get('X-Token') || req.query.token;
  if (got !== want) return res.status(401).json({ error: '通行碼不對' });
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

async function insertUpload({ bankId, page, answer, responder, imagePath, isTest }) {
  const { rows } = await query(
    `INSERT INTO exam_uploads (bank_id, page, answer_raw, responder, image_path, is_test)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [bankId, String(page), answer, responder || null, imagePath, !!isTest]
  );
  return rows[0].id;
}

// '1' / 'true' / 'yes' / 'on' 為測試資料，其餘與未帶一律正式。
// 統計數字若把測試混進去，「不一致 N 筆」這個唯一要看的數字就沒用了。
const asTest = v => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

function registerRoutes(app) {
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
        bankId: bank.id, page, answer, responder: req.body.name,
        imagePath, isTest: asTest(req.body.test),
      });
      res.json({ id, bank: bank.label, page });
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
      for (const [i, it] of items.entries()) {
        const bad = validateItem(it, i);
        if (bad) { rejected.push(bad); continue; }
        const buf = decodeImage(it.image);
        const ext = sniffImage(buf);
        const imagePath = saveImage({ uploadRoot: uploadRoot(), bankId: bank.id, buf, ext });
        const id = await insertUpload({
          bankId: bank.id, page: it.page, answer: it.answer,
          responder: it.name || req.body.name, imagePath,
          isTest: asTest(it.test ?? req.body.test),
        });
        accepted.push({ id, page: String(it.page) });
      }
      res.json({ bank: bank.label, accepted, rejected });
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
    runQueue(require('./db'), {
      bankId,
      onEvent: (e) => { try { emitAll('exam-progress', e); } catch (_) { /* 廣播失敗不影響工作 */ } },
    }).catch((e) => console.error('[EXAM-WORKER]', e.message));
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
      SELECT id, bank_id, page, responder, status, error, is_test, created_at, updated_at
        FROM exam_uploads
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT 200`, params);
    res.json(rows);
  });
}

module.exports = { registerRoutes, checkExamToken };
