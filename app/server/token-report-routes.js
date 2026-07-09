const { query } = require('./db');
const { verifyToken } = require('./auth');

function registerRoutes(app) {
  app.get('/api/token-report', verifyToken, async (req, res) => {
    try {
      // Check admin role via DB (verifyToken only sets req.userId)
      const { rows: [me] } = await query('SELECT role FROM users WHERE id=$1', [req.userId]);
      const isAdmin = me?.role === 'admin';
      const showAll = isAdmin && req.query.all === 'true';

      const now = new Date();
      const defaultStart = new Date(now);
      defaultStart.setDate(defaultStart.getDate() - 30);

      const start     = req.query.start     ? new Date(req.query.start) : defaultStart;
      // end 以「當日結束」為界，才含得到當天的記錄；date-only 字串補到 23:59:59.999Z
      const end       = req.query.end
        ? new Date(/T/.test(req.query.end) ? req.query.end : req.query.end + 'T23:59:59.999Z')
        : now;
      const projectId = req.query.project_id ? parseInt(req.query.project_id, 10) : null;
      const taskId    = req.query.task_id    || null;

      // Build WHERE conditions
      const baseConditions = ['tu.recorded_at >= $1', 'tu.recorded_at <= $2'];
      const baseParams = [start, end];

      if (!showAll) {
        baseConditions.push(`tu.user_id = $${baseParams.length + 1}`);
        baseParams.push(req.userId);
      }
      if (projectId) {
        baseConditions.push(
          `(tu.project_id = $${baseParams.length + 1} OR EXISTS(SELECT 1 FROM tasks t2 WHERE t2.task_id = tu.task_id AND t2.project_id = $${baseParams.length + 1}))`
        );
        baseParams.push(projectId);
      }
      if (taskId) {
        baseConditions.push(`tu.task_id = $${baseParams.length + 1}`);
        baseParams.push(taskId);
      }

      const where = 'WHERE ' + baseConditions.join(' AND ');

      // 成本模型（對齊 ccusage）：每列依實際 model 單價算真實 USD。
      // 各 model 內比例一致（output=5×input、cache_read=0.1×、cache_create=1.25×），
      // 故成本 = input_1M_單價 × 加權 input 等效顆數 / 1e6。
      const WEIGHTED = '(tu.input_tokens + tu.output_tokens * 5 + tu.cache_read_tokens * 0.1 + tu.cache_create_tokens * 1.25)';
      // 每 1M input 的 USD 單價（未知/空 model 一律以 sonnet 計）。LOWER+LIKE 相容 pg-mem。
      const RATE = `(CASE
             WHEN LOWER(COALESCE(tu.model,'')) LIKE '%haiku%' THEN 1.0
             WHEN LOWER(COALESCE(tu.model,'')) LIKE '%opus%'  THEN 5.0
             WHEN LOWER(COALESCE(tu.model,'')) LIKE '%fable%' THEN 10.0
             ELSE 3.0
           END)`;
      const COST = `(${RATE} * ${WEIGHTED} / 1000000.0)`;

      // Summary：總 Token（原始四項相加）＋ Cache 總數（原始）＋ 實際花費（USD）
      const { rows: [summary] } = await query(
        `SELECT
           COALESCE(SUM(tu.input_tokens + tu.output_tokens + tu.cache_read_tokens + tu.cache_create_tokens), 0) AS total_tokens,
           COALESCE(SUM(tu.cache_read_tokens + tu.cache_create_tokens), 0) AS cache_tokens,
           COALESCE(SUM(${WEIGHTED}), 0) AS actual_tokens,
           COALESCE(SUM(${COST}), 0) AS cost_usd,
           COUNT(DISTINCT COALESCE(tu.task_id, tu.project_id::TEXT)) AS total_refs,
           COUNT(*) AS total_records
         FROM token_usage tu
         ${where}`,
        baseParams
      );

      // By agent（Token 數）
      const { rows: byAgent } = await query(
        `SELECT agent_type,
           SUM(tu.input_tokens + tu.output_tokens + tu.cache_read_tokens + tu.cache_create_tokens) AS tokens
         FROM token_usage tu
         ${where}
         GROUP BY agent_type ORDER BY tokens DESC`,
        baseParams
      );

      // By project（Token 數）
      const { rows: byProject } = await query(
        `SELECT p.id AS project_id, p.name AS project_name,
           SUM(tu.input_tokens + tu.output_tokens + tu.cache_read_tokens + tu.cache_create_tokens) AS tokens
         FROM token_usage tu
         LEFT JOIN tasks t ON t.task_id = tu.task_id
         LEFT JOIN projects p ON p.id = COALESCE(tu.project_id, t.project_id)
         ${where}
         GROUP BY p.id, p.name ORDER BY tokens DESC`,
        baseParams
      );

      // Daily trend（Token 數；::date cast is compatible with both pg and pg-mem）
      const { rows: daily } = await query(
        `SELECT recorded_at::date AS date,
           SUM(tu.input_tokens + tu.output_tokens + tu.cache_read_tokens + tu.cache_create_tokens) AS tokens
         FROM token_usage tu
         ${where}
         GROUP BY date ORDER BY date ASC`,
        baseParams
      );

      // Task detail (latest 500)
      const { rows: taskDetail } = await query(
        `SELECT
           tu.task_id,
           tu.chat_id,
           t.title,
           t.id    AS task_row_id,
           c.title AS chat_title,
           p.name  AS project_name,
           p.id    AS project_id,
           COALESCE(u.display_name, u.username) AS username,
           tu.user_id,
           tu.agent_type,
           tu.model,
           (tu.input_tokens + tu.output_tokens + tu.cache_read_tokens + tu.cache_create_tokens) AS tokens,
           ${COST} AS cost,
           tu.duration_ms,
           tu.recorded_at
         FROM token_usage tu
         LEFT JOIN tasks t ON t.task_id = tu.task_id
         LEFT JOIN project_chats c ON c.id = tu.chat_id
         LEFT JOIN projects p ON p.id = COALESCE(tu.project_id, t.project_id)
         LEFT JOIN users u ON u.id = tu.user_id
         ${where}
         ORDER BY tu.recorded_at DESC
         LIMIT 500`,
        baseParams
      );

      // Group task detail by task_id
      const taskMap = {};
      for (const row of taskDetail) {
        // kind：task（有 task_id）/ chat（有 chat_id 或 agent=chat）/ 其餘 agent（wiki…）依專案彙總
        let key, kind, title, deleted, linkable;
        if (row.task_id) {
          kind     = 'task';
          key      = row.task_id;
          title    = row.title;
          // task_id 有值但 tasks 已無此列 → 任務被刪除，只剩孤兒 token 記錄
          deleted  = row.task_row_id == null;
          linkable = !deleted;
        } else if (row.chat_id) {
          kind     = 'chat';
          key      = `chat_${row.chat_id}`;
          title    = row.chat_title;
          // chat_id 有值但 project_chats 已無此列 → 對話被刪除
          deleted  = row.chat_title == null;
          linkable = !deleted;
        } else {
          // wiki 等專案層級、無對話 id 的記錄（含 chat_id 未回填的舊對話）→ 依 agent 分組避免混淆
          kind     = row.agent_type;
          key      = `${row.agent_type}_p${row.project_id}`;
          title    = null;
          deleted  = false;
          linkable = false;
        }
        if (!taskMap[key]) {
          taskMap[key] = {
            ref_key:          key,
            kind,
            task_id:          row.task_id,
            task_row_id:      row.task_row_id,
            chat_id:          row.chat_id,
            deleted,
            linkable,
            title,
            project_id:       row.project_id,
            project_name:     row.project_name,
            user_id:          row.user_id,
            username:         row.username,
            total_cost:       0,
            total_tokens:     0,
            agents:           [],
            last_recorded_at: row.recorded_at
          };
        }
        const rowCost   = Number(row.cost) || 0;
        const rowTokens = Number(row.tokens) || 0;
        taskMap[key].total_cost   += rowCost;
        taskMap[key].total_tokens += rowTokens;
        taskMap[key].agents.push({
          agent_type:  row.agent_type,
          model:       row.model || null,
          tokens:      rowTokens,
          cost:        rowCost,
          duration_ms: row.duration_ms
        });
        if (new Date(row.recorded_at) > new Date(taskMap[key].last_recorded_at)) {
          taskMap[key].last_recorded_at = row.recorded_at;
        }
      }

      const totalTokens  = Number(summary.total_tokens) || 0;
      const cacheTokens  = Number(summary.cache_tokens) || 0;
      const actualTokens = Number(summary.actual_tokens) || 0;
      const costUsd      = Number(summary.cost_usd) || 0;
      const totalTasks   = Object.keys(taskMap).length;

      res.json({
        summary: {
          total_tokens:        totalTokens,
          cache_tokens:        cacheTokens,
          // 實際 Token 數：與成本計算同一套加權（output=5x、cache_read=0.1x、cache_create=1.25x）等效顆數
          actual_tokens:       actualTokens,
          cost_usd:            costUsd,
          total_tasks:         totalTasks,
          avg_tokens_per_task: totalTasks ? actualTokens / totalTasks : 0,
          // 平均每任務以「實際花費」計
          avg_cost_per_task:   totalTasks ? costUsd / totalTasks : 0
        },
        by_agent:   byAgent.map(r => ({ agent_type: r.agent_type, tokens: Number(r.tokens) })),
        by_project: byProject.filter(r => r.project_name).map(r => ({
          project_id:   r.project_id,
          project_name: r.project_name,
          tokens:       Number(r.tokens)
        })),
        daily: daily.map(r => ({ date: r.date, tokens: Number(r.tokens) })),
        tasks: Object.values(taskMap)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
