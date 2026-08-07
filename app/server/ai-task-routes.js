// 歷史任務規格的語意檢索。這是整套 embedding 基礎建設真正的主要使用者：
// wiki 的候選集是「單一專案的頁」（實測最大 28 頁、整份目錄才 671 字），列給 agent 挑就夠了；
// 但歷史任務會長到破千張，而且**沒有「列目錄」這個替代方案**——任務標題不足以判斷相似度。
// Odoo 客製高度重複，一張新任務常常跟三個月前某張很像，這件事只能靠語意檢索。
//
// 兩階段設計，比照既有的 wiki 端點：similar 只回標題與摘要，要細節才用 spec 取單張全文。
// 否則一次查詢就把三份完整規格灌進 agent 的 context，省下的思考時間全賠在 token 上。
const yaml = require('js-yaml');
const { query } = require('./db');
const { aiEndpointGuard } = require('./lib/ai-token');
const { resolveProjectId } = require('./lib/project-ref');

const SUMMARY_MAX = 200;

// analysis.yaml 有 summary 這個頂層欄位（見 .claude/agents/analysis-project.md 的格式段），
// 但規格是 AI 產出的，欄位缺漏或整份解析不了都可能發生。解不出來就退回取前幾行——
// 這裡的用途只是讓 agent 判斷「要不要打開這一張」，一個近似的摘要遠好過空字串。
function specSummary(analysisYaml) {
  const raw = String(analysisYaml || '');
  try {
    const spec = yaml.load(raw);
    if (spec && typeof spec.summary === 'string' && spec.summary.trim()) {
      return spec.summary.trim().slice(0, SUMMARY_MAX);
    }
  } catch { /* AI 產的 YAML 壞掉不是這個端點該處理的事，退回純文字摘要 */ }
  return raw.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX);
}

function registerRoutes(app) {
  // 相似的歷史任務。索引沒就緒時回空清單＋ready:false——不能假裝「沒有相似任務」，
  // 那會讓 agent 得出「這是全新需求」的錯誤結論（跟 /ai/wiki/search 回空陣列一樣的坑）。
  app.get('/ai/tasks/similar', aiEndpointGuard, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ ok: false, error: '缺 q 參數（要比對的需求描述）' });
      const pid = await resolveProjectId(req.query.project);
      if (!pid) return res.json({ ok: true, tasks: [] });

      const emb = require('./lib/embedding');
      const idx = require('./lib/embedding-index');
      if (!emb.isReady() || !idx.isCacheLoaded()) {
        return res.json({
          ok: true, tasks: [], ready: false,
          note: '語意索引尚未就緒，這不代表沒有相似的歷史任務——請照常自行分析',
        });
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);
      const qv = await emb.embedQuery(q);
      const hits = idx.searchProject(pid, qv, { limit, kind: 'task' });
      if (!hits.length) return res.json({ ok: true, tasks: [] });

      // 動態 IN 而非 ANY(陣列)：pg-mem 對 SERIAL 主鍵跑 ANY 永遠查不到列（testing.md 第 12 條）。
      const ids = hits.map(h => h.taskId);
      const ph = ids.map((_, i) => `$${i + 2}`).join(',');
      const { rows } = await query(
        `SELECT id, task_id, title, analysis_yaml FROM tasks
          WHERE project_id=$1 AND id IN (${ph})`, [pid, ...ids]);
      const byId = new Map(rows.map(r => [r.id, r]));
      // 依相似度名次還原順序：SQL 回來的順序無意義。
      const tasks = hits.map(h => byId.get(h.taskId)).filter(Boolean).map(t => ({
        id: t.id, task_id: t.task_id, title: t.title, summary: specSummary(t.analysis_yaml),
      }));
      res.json({ ok: true, tasks });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });

  // 取單張規格全文。一律帶 project 並以 project_id 過濾：agent 拿到的 id 來自上一個端點，
  // 但端點本身不能假設呼叫端沒換過 id——跨專案讀規格會直接打破資料邊界。
  app.get('/ai/tasks/spec', aiEndpointGuard, async (req, res) => {
    try {
      const pid = await resolveProjectId(req.query.project);
      if (!pid) return res.json({ ok: false, error: '找不到該任務' });
      const { rows: [task] } = await query(
        'SELECT id, task_id, title, analysis_yaml FROM tasks WHERE project_id=$1 AND id=$2',
        [pid, parseInt(req.query.task, 10) || 0]);
      if (!task || !task.analysis_yaml) return res.json({ ok: false, error: '找不到該任務' });
      res.json({ ok: true, ...task });
    } catch (err) { res.json({ ok: false, error: err.message }); }
  });
}

module.exports = { registerRoutes };
