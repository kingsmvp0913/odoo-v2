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
      const end       = req.query.end       ? new Date(req.query.end)   : now;
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

      // Summary
      const { rows: [summary] } = await query(
        `SELECT
           COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens), 0) AS total_tokens,
           COUNT(DISTINCT COALESCE(tu.task_id, tu.project_id::TEXT)) AS total_refs,
           COUNT(*) AS total_records
         FROM token_usage tu
         ${where}`,
        baseParams
      );

      // By agent
      const { rows: byAgent } = await query(
        `SELECT agent_type,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS tokens
         FROM token_usage tu
         ${where}
         GROUP BY agent_type ORDER BY tokens DESC`,
        baseParams
      );

      // By project
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

      // Daily trend (::date cast is compatible with both pg and pg-mem)
      const { rows: daily } = await query(
        `SELECT recorded_at::date AS date,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS tokens
         FROM token_usage tu
         ${where}
         GROUP BY date ORDER BY date ASC`,
        baseParams
      );

      // Task detail (latest 500)
      const { rows: taskDetail } = await query(
        `SELECT
           tu.task_id,
           t.title,
           p.name  AS project_name,
           p.id    AS project_id,
           COALESCE(u.display_name, u.username) AS username,
           tu.user_id,
           tu.agent_type,
           tu.input_tokens + tu.output_tokens + tu.cache_read_tokens + tu.cache_create_tokens AS tokens,
           tu.duration_ms,
           tu.recorded_at
         FROM token_usage tu
         LEFT JOIN tasks t ON t.task_id = tu.task_id
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
        const key = row.task_id || `_chat_${row.project_id}`;
        if (!taskMap[key]) {
          taskMap[key] = {
            task_id:          row.task_id,
            title:            row.title,
            project_id:       row.project_id,
            project_name:     row.project_name,
            user_id:          row.user_id,
            username:         row.username,
            total_tokens:     0,
            agents:           [],
            last_recorded_at: row.recorded_at
          };
        }
        taskMap[key].total_tokens += Number(row.tokens) || 0;
        taskMap[key].agents.push({
          agent_type:  row.agent_type,
          tokens:      Number(row.tokens) || 0,
          duration_ms: row.duration_ms
        });
        if (new Date(row.recorded_at) > new Date(taskMap[key].last_recorded_at)) {
          taskMap[key].last_recorded_at = row.recorded_at;
        }
      }

      const totalTokens = Number(summary.total_tokens) || 0;
      const totalTasks  = Object.keys(taskMap).length;

      res.json({
        summary: {
          total_tokens:        totalTokens,
          total_tasks:         totalTasks,
          avg_tokens_per_task: totalTasks ? Math.round(totalTokens / totalTasks) : 0
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
