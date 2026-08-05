const { query } = require('./db');
const { verifyToken } = require('./auth');

function registerRoutes(app) {
  app.get('/api/token-report', verifyToken, async (req, res) => {
    try {
      // Check admin role via DB (verifyToken only sets req.userId)
      const { rows: [me] } = await query('SELECT role FROM users WHERE id=$1', [req.userId]);
      const isAdmin = me?.role === 'admin';
      if (!isAdmin) return res.status(403).json({ error: '用量報表僅管理員可見' });
      const showAll = req.query.all === 'true';

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

      // By agent（實際 Token 數＋成本＋失敗率，與成本同一套加權）。
      // 失敗＝status 為 timeout／error（真正的執行失敗）。以下兩種是刻意／外部中斷、非執行失敗，
      // 一律排除在「呼叫數」與「失敗數」之外，否則會把失敗率灌爆（cs 曾因此顯示 60%）：
      //   aborted     ＝使用者手動暫停（abortTask，cs-agent 等對 abort 直接 return、不留 blocker）
      //   interrupted ＝claude 行程被外部信號終止（伺服器重開／OOM kill；見 claude-runner.js 外部終止分支）
      // 失敗率高的關卡＝重跑成本集中處，是省 token 的第一優先目標。
      const { rows: byAgent } = await query(
        `SELECT agent_type,
           SUM(${WEIGHTED}) AS tokens,
           SUM(${COST}) AS cost_usd,
           SUM(CASE WHEN COALESCE(tu.status,'completed') NOT IN ('aborted','interrupted') THEN 1 ELSE 0 END) AS calls,
           COUNT(DISTINCT tu.task_id) AS tasks,
           SUM(CASE WHEN COALESCE(tu.status,'completed') NOT IN ('completed','aborted','interrupted') THEN 1 ELSE 0 END) AS failed_calls
         FROM token_usage tu
         ${where}
         GROUP BY agent_type ORDER BY tokens DESC`,
        baseParams
      );

      // By project（實際 Token 數，與成本同一套加權）
      const { rows: byProject } = await query(
        `SELECT p.id AS project_id, p.name AS project_name,
           SUM(${WEIGHTED}) AS tokens
         FROM token_usage tu
         LEFT JOIN tasks t ON t.task_id = tu.task_id
         LEFT JOIN projects p ON p.id = COALESCE(tu.project_id, t.project_id)
         ${where}
         GROUP BY p.id, p.name ORDER BY tokens DESC`,
        baseParams
      );

      // By user（實際 Token 數，與成本同一套加權）
      const { rows: byUser } = await query(
        `SELECT u.id AS user_id, COALESCE(u.display_name, u.username) AS username,
           SUM(${WEIGHTED}) AS tokens
         FROM token_usage tu
         LEFT JOIN users u ON u.id = tu.user_id
         ${where}
         GROUP BY u.id, u.display_name, u.username ORDER BY tokens DESC`,
        baseParams
      );

      // 專案品質統計：母體是「本期間完成的任務」（done_at 落在區間）。
      // 重跑次數一律由 token_usage 的列數推算，不讀 tasks 的 *_retry_count／reentry_count——
      // 那些欄位在分診 goto（reject-triage）與 resolve-blocker 續跑時會被歸零，是「本次嘗試」的計數器，
      // 不是生涯總數，拿來算彈跳率會嚴重低估。token_usage 每次呼叫一列且不可重置，才是可靠的重跑紀錄。
      const taskConditions = ["t.status = 'done'", 't.done_at >= $1', 't.done_at <= $2'];
      const taskParams = [start, end];
      if (!showAll) {
        taskConditions.push(`t.user_id = $${taskParams.length + 1}`);
        taskParams.push(req.userId);
      }
      if (projectId) {
        taskConditions.push(`t.project_id = $${taskParams.length + 1}`);
        taskParams.push(projectId);
      }
      if (taskId) {
        taskConditions.push(`t.task_id = $${taskParams.length + 1}`);
        taskParams.push(taskId);
      }
      const taskWhere = 'WHERE ' + taskConditions.join(' AND ');

      // 拆多段查再於 JS 合併：相關子查詢與 LATERAL 在 pg-mem（測試用）不保證可用
      const PIPELINE_STAGES = ['analysis', 'coding', 'qa', 'playwright'];
      const [{ rows: doneTaskRows }, { rows: stageCallRows }, { rows: rejectRows }, { rows: rejectCatRows }] = await Promise.all([
        query(
          `SELECT t.task_id, t.project_id, p.name AS project_name
             FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
             ${taskWhere}`,
          taskParams
        ),
        query(
          `SELECT tu.task_id, tu.agent_type, COUNT(*) AS n
             FROM token_usage tu JOIN tasks t ON t.task_id = tu.task_id
             ${taskWhere} AND tu.agent_type = ANY($${taskParams.length + 1}::text[])
            GROUP BY tu.task_id, tu.agent_type`,
          [...taskParams, PIPELINE_STAGES]
        ),
        // 退回率／主要退回原因只算「人工退回」（source='human'）。QA 自動退回落同一張表但屬
        // pipeline 內部來回，且用另一套分類詞彙（impl_miss／spec_unclear／env_flaky）——混算會
        // 同時把退回率灌水（人工其實沒退）與讓主要退回原因被 QA 的詞彙洗掉。比照 health-data.js。
        query(
          `SELECT tr.task_id, COUNT(*) AS n
             FROM task_rejections tr JOIN tasks t ON t.task_id = tr.task_id
             ${taskWhere} AND tr.source = 'human'
            GROUP BY tr.task_id`,
          taskParams
        ),
        query(
          `SELECT t.project_id, ri.category, COUNT(*) AS n
             FROM rejection_items ri
             JOIN task_rejections tr ON tr.id = ri.rejection_id
             JOIN tasks t ON t.task_id = tr.task_id
             ${taskWhere} AND tr.source = 'human'
            GROUP BY t.project_id, ri.category`,
          taskParams
        )
      ]);

      // Daily trend（實際 Token 數，與成本同一套加權；::date cast is compatible with both pg and pg-mem）
      const { rows: daily } = await query(
        `SELECT recorded_at::date AS date,
           SUM(${WEIGHTED}) AS tokens
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
           ${WEIGHTED} AS tokens,
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

      // 每任務每關的呼叫次數；> 1 即該關重跑過
      const stageCalls = {};
      for (const r of stageCallRows) {
        (stageCalls[r.task_id] || (stageCalls[r.task_id] = {}))[r.agent_type] = Number(r.n) || 0;
      }
      const rejectCount = {};
      for (const r of rejectRows) rejectCount[r.task_id] = Number(r.n) || 0;

      const projAgg = new Map();
      for (const t of doneTaskRows) {
        const key = t.project_id == null ? 'none' : t.project_id;
        if (!projAgg.has(key)) {
          projAgg.set(key, {
            project_id:   t.project_id,
            project_name: t.project_name || '（未綁專案）',
            done_tasks:   0,
            first_pass:   0,
            rejected:     0,
            stageTotals:  {},
            categories:   {}
          });
        }
        const a = projAgg.get(key);
        a.done_tasks++;
        const calls = stageCalls[t.task_id] || {};
        // 一次過關＝四個 agent 關卡都沒有第二次呼叫。沒跑到的關（如無 tour）計 0，不算失敗。
        if (PIPELINE_STAGES.every(s => (calls[s] || 0) <= 1)) a.first_pass++;
        for (const s of PIPELINE_STAGES) a.stageTotals[s] = (a.stageTotals[s] || 0) + (calls[s] || 0);
        if (rejectCount[t.task_id]) a.rejected++;
      }
      for (const r of rejectCatRows) {
        const a = projAgg.get(r.project_id == null ? 'none' : r.project_id);
        if (a) a.categories[r.category] = (a.categories[r.category] || 0) + (Number(r.n) || 0);
      }

      // 依一次過關率由低到高：最需要處理的專案排最前面
      const projectStats = [...projAgg.values()].map(a => {
        const topCat = Object.entries(a.categories).sort((x, y) => y[1] - x[1])[0];
        return {
          project_id:        a.project_id,
          project_name:      a.project_name,
          done_tasks:        a.done_tasks,
          first_pass_rate:   a.done_tasks ? a.first_pass / a.done_tasks : 0,
          reject_rate:       a.done_tasks ? a.rejected / a.done_tasks : 0,
          avg_stage_calls:   Object.fromEntries(
            PIPELINE_STAGES.map(s => [s, a.done_tasks ? a.stageTotals[s] / a.done_tasks : 0])
          ),
          top_reject_category: topCat ? topCat[0] : null,
          top_reject_count:    topCat ? topCat[1] : 0
        };
      }).sort((a, b) => a.first_pass_rate - b.first_pass_rate);

      const doneTaskCount = doneTaskRows.length;
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
          // 本期間完成的任務數，是下面「每張交付成本」的分母
          done_tasks:          doneTaskCount,
          // 每張「交付」任務的成本：分母用完成數，不用 total_tasks——後者含跑到一半、
          // 被砍掉、還沒完成的任務，除出來的數字會低於真實單位成本
          avg_cost_per_task:   doneTaskCount ? costUsd / doneTaskCount : 0
        },
        by_agent:   byAgent.map(r => {
          const calls = Number(r.calls) || 0;
          const failed = Number(r.failed_calls) || 0;
          const tasks = Number(r.tasks) || 0;
          return {
            agent_type: r.agent_type,
            tokens: Number(r.tokens),
            cost_usd: Number(r.cost_usd) || 0,
            calls,
            failed_calls: failed,
            fail_rate: calls ? failed / calls : 0,
            // 平均每任務呼叫幾次：1.0＝從不重跑。比 fail_rate 準——fail_rate 只算 timeout/error，
            // 漏掉「跑完了但結果被打回重來」，而後者才是重跑成本的主要來源。
            avg_calls_per_task: tasks ? calls / tasks : 0
          };
        }),
        by_project: byProject.filter(r => r.project_name).map(r => ({
          project_id:   r.project_id,
          project_name: r.project_name,
          tokens:       Number(r.tokens)
        })),
        by_user: byUser.filter(r => r.username).map(r => ({
          user_id:  r.user_id,
          username: r.username,
          tokens:   Number(r.tokens)
        })),
        project_stats: projectStats,
        daily: daily.map(r => ({ date: r.date, tokens: Number(r.tokens) })),
        tasks: Object.values(taskMap)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes };
