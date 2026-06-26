const { spawn } = require('child_process');
const { query } = require('../db');
const notify = require('../notify');

function buildCommitMessage(task) {
  const title = (task.title || '').trim() || task.task_id;
  if (task.source === 'service') {
    // Title stored as "IDX-2026060098: 修正發票計算問題" → "修正發票計算問題 (IDX-2026060098)"
    const colonIdx = title.indexOf(': ');
    if (colonIdx > 0) {
      const idx = title.slice(0, colonIdx);
      const subject = title.slice(colonIdx + 2);
      return `${subject} (${idx})`;
    }
    return title;
  }
  return title;
}

function parseResult(text) {
  const OPEN = '---RESULT-JSON---';
  const CLOSE = '---END-RESULT---';
  const start = text.lastIndexOf(OPEN);
  if (start === -1) return null;
  const end = text.lastIndexOf(CLOSE);
  const jsonStr = (end !== -1 ? text.slice(start + OPEN.length, end) : text.slice(start + OPEN.length)).trim();
  try { return JSON.parse(jsonStr); } catch { return null; }
}

async function getProjectInfo(projectId) {
  const { rows } = await query(
    `SELECT p.name, p.odoo_version, pr.local_path
     FROM projects p
     JOIN project_repos pr ON pr.project_id = p.id AND pr.is_primary = true
     WHERE p.id = $1`,
    [projectId]
  );
  return rows[0] || null;
}

function spawnClaude(prompt, { cwd, taskId, userId, timeoutMs = 600000, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--print'], { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    let stdout = '', stderr = '', done = false;

    const timer = setTimeout(() => {
      if (!done) { child.kill(); reject(new Error('claude subprocess timed out')); }
    }, timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => {
        if (!done) { clearTimeout(timer); done = true; child.kill('SIGTERM'); reject(new Error('aborted')); }
      }, { once: true });
    }

    child.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      if (taskId && userId) notify.emitToUser(userId, 'terminal:output', { taskId, data: chunk });
    });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.stdin.write(prompt);
    child.stdin.end();

    child.on('close', code => {
      clearTimeout(timer);
      done = true;
      if (taskId && userId) notify.emitToUser(userId, 'terminal:done', { taskId, exitCode: code });
      if (code !== 0 && code !== null) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      else resolve(stdout);
    });
    child.on('error', err => { clearTimeout(timer); done = true; reject(err); });
  });
}

function buildAnalysisPrompt(task, info) {
  return `你是 Odoo 開發需求分析師，請閱讀現有程式碼後生成精確的分析規格。
Think in English internally; output Traditional Chinese. 保留英文術語：Variable/Function/Hook/Class/Field/Model/Method/Controller/View。

【知識查詢】
A. Odoo 核心 API（欄位型別、decorator、method signature、原生方法用法）
   → 優先使用 Context7 MCP（最多 5 次；失敗則靜默跳過）
B. 本地程式碼（現有模組結構、欄位定義、業務邏輯）
   1. 先讀 ./graphify-out/wiki/index.md，有記載則優先參考（若不存在則跳過）
   2. 用 Glob/Grep/Read 直接探索檔案

【Odoo 開發規則】
- 只能修改當前目錄內的檔案，禁止修改 Odoo 原生程式碼；禁止動 custom_addons/
- Models: _inherit。Views: inherit_id + xpath。Controllers: super()
- 禁用 round()，改用 Decimal + ROUND_HALF_UP
- 原生 SQL 執行前呼叫 self.flush_model()，執行後呼叫 self.invalidate_model()
- Views XML 命名：<model>_views.xml；同一 Model 只能有一個 view 檔案
- View 繼承：同一 addons 若已繼承某原生 view，新增直接寫入現有繼承 view，禁止另建第二個繼承
- View 放置：依 view 所屬 Model 放入對應 XML（例：sale.order.line 的 view → sale_order_line_views.xml）
- 一個 Model 一個 .py 檔；單頭＋明細單據合併，以單頭為檔名（如 sale_order.py）
- 樣板文件（xls/docx）一律放 <module>/static/<type>/（例：hr/static/xls/abc.xlsx）
- 嚴禁新增 analysis.yaml 規格書以外的欄位、Model 或邏輯

【專案資訊】
- 名稱：${info.name}
- Odoo 版本：${info.odoo_version}

【任務內容】
${task.original_text || '（無內容）'}

【步驟】
1. 依知識查詢流程了解現有模組結構
2. 找出與需求相關的模組和欄位
3. 依據現有程式碼生成 analysis.yaml

【analysis.yaml 格式】
case_id: "${task.task_id}"
module: ""
odoo_version: "${info.odoo_version}"
project_name: "${info.name}"
execution_mode: "MODE_A"
summary: ""
requirements:
  - ""
low_confidence: false
clarification_channel:
  questions: []
  user_answer: ""

【輸出】分析完成後輸出：
---RESULT-JSON---
{"status":"branch_pending","analysis_yaml":"<yaml 字串，換行用 \\n>"}
---END-RESULT---

若需使用者確認（MODE_B 或有問題）則輸出 "confirm_pending"。
若規格不清楚無法繼續：
---RESULT-JSON---
{"status":"stopped","error":"詳細原因（使用者看得懂的說明）"}
---END-RESULT---`.trim();
}

function buildCodingPrompt(task, info) {
  return `你是 Odoo 開發工程師，請根據 analysis.yaml 規格書實作功能。
Think in English internally; output Traditional Chinese. 保留英文術語：Variable/Function/Hook/Class/Field/Model/Method/Controller/View。

【知識查詢】
A. Odoo 核心 API（欄位型別、decorator、method signature、原生方法用法）
   → 優先使用 Context7 MCP（最多 5 次；失敗則靜默跳過）
B. 本地程式碼（符號定義、call chain、模組結構、業務邏輯）
   1. 先讀 ./graphify-out/wiki/index.md，有記載則優先參考（若不存在則跳過）
   2. 使用 Serena MCP 查詢符號和 call chain（最多 3 次不同查詢）
      - 回傳 tool_use_error → 立即停止並回報 blocker
   3. 用 Glob/Grep/Read 直接探索檔案

【Odoo 開發規則（全部適用）】
- 只能修改當前目錄內的檔案，禁止修改 Odoo 原生程式碼；禁止動 custom_addons/
- Models: _inherit。Views: inherit_id + xpath。Controllers: super()
- 禁用 round()，改用 Decimal + ROUND_HALF_UP（銀行家捨入問題）
- 原生 SQL 執行前呼叫 self.flush_model()，執行後呼叫 self.invalidate_model()
- Views XML 命名：<model>_views.xml；同一 Model 只能有一個 view 檔案
- View 繼承：同一 addons 若已繼承某原生 view，新增直接寫入現有繼承 view，禁止另建第二個繼承
- View 放置：依 view 所屬 Model 放入對應 XML（例：sale.order.line 的 view → sale_order_line_views.xml）
- 一個 Model 一個 .py 檔；單頭＋明細單據合併，以單頭為檔名（如 sale_order.py）
- 樣板文件（xls/docx）一律放 <module>/static/<type>/（例：hr/static/xls/abc.xlsx）
- 嚴禁新增 analysis.yaml 規格書以外的欄位、Model 或邏輯

【驗證流程（每個檔案完成後立即執行，[Step] → [Verify]）】
- Python：python -m py_compile <file>（語法有誤立即修正再繼續）
- XML：xmllint --noout <file>（語法有誤立即修正再繼續）

【Commit 格式】（只 commit，不 push）
git add -A && git commit -m "${buildCommitMessage(task)}"
（訊息固定，不可修改）

【專案資訊】
- 名稱：${info.name}
- Odoo 版本：${info.odoo_version}
- Branch：${task.git_branch || '（未設定）'}

【分析規格】
${task.analysis_yaml || '（無規格）'}

【執行步驟】
1. 依知識查詢流程了解現有程式碼結構
2. 逐條實作 requirements；每個檔案完成後立即 py_compile / xmllint 驗證
3. git add -A && git commit

【輸出】完成後輸出：
---RESULT-JSON---
{"status":"qa_running"}
---END-RESULT---

若遇到無法繼續的情況（需求無法實作、規格不清楚等）：
---RESULT-JSON---
{"status":"stopped","error":"詳細原因（使用者看得懂的說明，例如：sale.order 尚未繼承，需先建立繼承才能新增欄位）"}
---END-RESULT---`.trim();
}

async function runTaskAnalysis(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, original_text, project_id FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  const info = await getProjectInfo(task.project_id);
  if (!info?.local_path) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content='專案未設定主要 Repo 路徑，請至專案設定填寫 local_path', updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  let raw;
  try {
    raw = await spawnClaude(buildAnalysisPrompt(task, info), { cwd: info.local_path, taskId, userId, signal });
  } catch (err) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, `分析 Agent 執行失敗：${err.message}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const result = parseResult(raw);

  if (result?.status === 'stopped') {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, result.error || '分析 Agent 停止，未回傳原因']
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  if (!result?.status || !result?.analysis_yaml) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content='分析 Agent 未回傳有效結果，請檢查 terminal 輸出', updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const nextStatus = ['branch_pending', 'confirm_pending'].includes(result.status) ? result.status : 'branch_pending';
  await query(
    `UPDATE tasks SET status=$2, analysis_yaml=$3, updated_at=NOW() WHERE id=$1`,
    [taskId, nextStatus, result.analysis_yaml]
  );
  notify.emitToUser(userId, 'task:updated', { taskId, status: nextStatus });
  return true;
}

async function runTaskCoding(taskId, userId, signal) {
  const { rows: [task] } = await query(
    'SELECT id, task_id, title, source, analysis_yaml, git_branch, project_id FROM tasks WHERE id = $1',
    [taskId]
  );
  if (!task || !task.project_id) return false;

  const info = await getProjectInfo(task.project_id);
  if (!info?.local_path) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content='專案未設定主要 Repo 路徑，請至專案設定填寫 local_path', updated_at=NOW() WHERE id=$1`,
      [taskId]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  let raw;
  try {
    raw = await spawnClaude(buildCodingPrompt(task, info), { cwd: info.local_path, taskId, userId, signal });
  } catch (err) {
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, `實作 Agent 執行失敗：${err.message}`]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
    return true;
  }

  const result = parseResult(raw);
  if (result?.status === 'qa_running') {
    await query(`UPDATE tasks SET status='qa_running', updated_at=NOW() WHERE id=$1`, [taskId]);
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'qa_running' });
  } else {
    const errorMsg = result?.error || '實作 Agent 未回傳有效結果，請檢查 terminal 輸出';
    await query(
      `UPDATE tasks SET status='stopped', blocker_content=$2, updated_at=NOW() WHERE id=$1`,
      [taskId, errorMsg]
    );
    notify.emitToUser(userId, 'task:updated', { taskId, status: 'stopped' });
  }
  return true;
}

module.exports = { runTaskAnalysis, runTaskCoding };
