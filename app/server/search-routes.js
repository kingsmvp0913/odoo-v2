const { query } = require('./db');
const { verifyToken } = require('./auth');

// 每一類各回幾筆。側欄 palette 是「快速跳過去」的入口不是清單頁，
// 三類加起來超過一個螢幕高度就失去挑選的意義。
const PER_KIND = 8;

// 逸脫 LIKE 萬用字元：使用者常直接貼路徑或錯誤訊息進來搜，裡面的 _ 與 % 會被當成
// 萬用字元而搜出一堆不相干的東西。不寫 ESCAPE 子句——反斜線本來就是 PostgreSQL 的
// 預設逸脫字元，寫了反而讓 pg-mem 解析不了整句（測試環境會整組炸掉）。
// 大小寫不敏感一律 LOWER+LIKE，不用 ILIKE（pg-mem 不保證支援）。
function toLikePattern(q) {
  return `%${q.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)}%`;
}

// 標題命中排在內文命中前面，同一筆只留一次。
// 兩條腿分開查而不是用 EXISTS 子查詢：pg-mem 對子查詢與 DISTINCT 的支援有坑，
// 去重在 JS 做沒有相容性風險，代價只是多一次 round-trip。
function mergeHits(primary, secondary, limit) {
  const seen = new Map();
  for (const row of [...primary, ...secondary]) {
    if (!seen.has(row.id)) seen.set(row.id, row);
  }
  return [...seen.values()].slice(0, limit);
}

function registerRoutes(app) {
  // 側欄 ⌘K 的唯一資料來源。搜的是「使用者實際在做的東西」——任務、對話、專案，
  // 不搜頁面：頁面在側欄與帳號／更多工具選單都各有常駐入口，放進搜尋只會稀釋結果。
  app.get('/api/search', verifyToken, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ tasks: [], chats: [], projects: [] });
      const like = toLikePattern(q);

      // 任務與對話都只查自己的（比照 /api/tasks 與 /api/projects/:id/chats 的預設授權）。
      // 專案不設限：此 repo 沒有 project_members 表，專案共享是既有設計。
      const [taskTitle, taskBody, chatTitle, chatBody, projects] = await Promise.all([
        query(
          `SELECT t.id, t.task_id, t.title, t.status, t.project_id, p.name AS project_name
             FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
            WHERE t.user_id = $1 AND t.is_hidden = false AND LOWER(t.title) LIKE $2
            ORDER BY t.updated_at DESC LIMIT ${PER_KIND}`,
          [req.userId, like]
        ),
        query(
          `SELECT t.id, t.task_id, t.title, t.status, t.project_id, p.name AS project_name
             FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
            WHERE t.user_id = $1 AND t.is_hidden = false AND LOWER(t.original_text) LIKE $2
            ORDER BY t.updated_at DESC LIMIT ${PER_KIND}`,
          [req.userId, like]
        ),
        query(
          `SELECT c.id, c.title, c.project_id, p.name AS project_name
             FROM project_chats c JOIN projects p ON p.id = c.project_id
            WHERE c.user_id = $1 AND LOWER(c.title) LIKE $2
            ORDER BY c.created_at DESC LIMIT ${PER_KIND}`,
          [req.userId, like]
        ),
        // 同一場對話可能有多則訊息命中，這裡刻意多撈一些再由 mergeHits 去重，
        // 否則 LIMIT 8 可能被同一場對話的 8 則訊息吃光而只剩一個結果。
        query(
          `SELECT c.id, c.title, c.project_id, p.name AS project_name
             FROM project_chats c
             JOIN projects p ON p.id = c.project_id
             JOIN project_chat_messages m ON m.chat_id = c.id
            WHERE c.user_id = $1 AND LOWER(m.content) LIKE $2
            ORDER BY c.created_at DESC LIMIT ${PER_KIND * 5}`,
          [req.userId, like]
        ),
        query(
          `SELECT id, name FROM projects
            WHERE LOWER(name) LIKE $1 OR LOWER(COALESCE(description, '')) LIKE $1
            ORDER BY name LIMIT ${PER_KIND}`,
          [like]
        ),
      ]);

      res.json({
        tasks: mergeHits(taskTitle.rows, taskBody.rows, PER_KIND),
        chats: mergeHits(chatTitle.rows, chatBody.rows, PER_KIND),
        projects: projects.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
