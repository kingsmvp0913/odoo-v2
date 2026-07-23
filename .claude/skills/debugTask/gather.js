#!/usr/bin/env node
/**
 * gather.js — 一鍵拉齊單一任務的除錯資訊（唯讀，不寫入任何東西）。
 *
 * 用法：
 *   node .claude/skills/debugTask/gather.js <taskId> [--events N] [--json]
 *   <taskId> 可為 tasks.id（整數）或業務 task_id（TEXT）。
 *
 * 輸出區塊：任務狀態與彈跳計數 → 專案/環境（含 setup_log 尾端）→ token_usage 最近執行
 *          → task_events 尾端 → deploy log → e2e log → odoo runtime log。
 * 路徑真相來源：CLAUDE.md §6（env var 可覆寫：DEPLOY_LOG_DIR / E2E_LOG_DIR / ODOO_ENV_BASE）。
 * 各區塊獨立 try/catch：單一來源缺漏（log 檔不存在等）不影響其餘輸出。
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const { Pool } = require(path.join(repoRoot, 'app', 'node_modules', 'pg'));

function connString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const cfg = path.join(repoRoot, 'data', 'config.json');
  const url = JSON.parse(fs.readFileSync(cfg, 'utf8')).DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 不在 env 也不在 data/config.json');
  return url;
}

const argv = process.argv.slice(2);
const key = argv.find(a => !a.startsWith('--'));
const evIdx = argv.indexOf('--events');
const EVENTS_N = evIdx !== -1 ? parseInt(argv[evIdx + 1], 10) || 30 : 30;
const TAIL_BYTES = 16 * 1024;

if (!key) {
  console.error('用法：node gather.js <taskId>（tasks.id 整數或業務 task_id）[--events N]');
  process.exit(2);
}

function section(title) { console.log(`\n===== ${title} =====`); }

function tailFile(p, maxBytes = TAIL_BYTES) {
  const stat = fs.statSync(p);
  const fd = fs.openSync(p, 'r');
  try {
    const start = Math.max(0, stat.size - maxBytes);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return (start > 0 ? `…（僅尾端 ${buf.length} bytes，全檔 ${stat.size} bytes）\n` : '') + text;
  } finally { fs.closeSync(fd); }
}

// 目錄下符合 prefix 的最新一個 log 檔（依 mtime）
function latestLog(dir, prefix) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.log'));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}

(async () => {
  const pool = new Pool({ connectionString: connString() });
  try {
    // 1. 任務主資料（id 整數與業務 task_id 都試；task_id 跨使用者可能重複 → 多筆時全列並取最新）
    const conds = [];
    const params = [];
    if (/^\d+$/.test(key)) { params.push(parseInt(key, 10)); conds.push(`id = $${params.length}`); }
    params.push(key); conds.push(`task_id = $${params.length}`);
    const { rows: tasks } = await pool.query(
      `SELECT id, task_id, title, status, is_paused, blocker_content, git_branch, project_id,
              reentry_count, qa_retry_count, pw_retry_count, deploy_retry_count, coding_resume_count, updated_at
       FROM tasks WHERE ${conds.join(' OR ')} ORDER BY updated_at DESC`, params);
    if (!tasks.length) { console.error(`找不到任務：${key}`); process.exitCode = 1; return; }
    if (tasks.length > 1) console.log(`⚠ 命中 ${tasks.length} 筆（task_id 跨使用者重複），以最近更新的一筆為準。`);
    const t = tasks[0];

    section(`任務 #${t.id}（task_id=${t.task_id}）`);
    console.log(`標題：${t.title || '（無）'}`);
    console.log(`狀態：${t.status}${t.is_paused ? '（已暫停）' : ''}　分支：${t.git_branch || '（無）'}`);
    console.log(`彈跳計數：reentry=${t.reentry_count} qa=${t.qa_retry_count} e2e(pw)=${t.pw_retry_count} deploy=${t.deploy_retry_count} coding_resume=${t.coding_resume_count}`);
    if (t.blocker_content) console.log(`blocker：${t.blocker_content}`);

    // 2. 專案與環境
    let folder = null;
    if (t.project_id) {
      const { rows: [p] } = await pool.query(
        'SELECT name, folder_name, odoo_version FROM projects WHERE id=$1', [t.project_id]);
      if (p) {
        folder = p.folder_name || p.name;
        section(`專案：${p.name}（folder=${folder}，Odoo ${p.odoo_version}，DB=test_${folder}）`);
        try {
          const { rows: [env] } = await pool.query(
            'SELECT status, port, url, error_msg, setup_log, updated_at FROM odoo_envs WHERE project_id=$1', [t.project_id]);
          if (env) {
            console.log(`環境：status=${env.status} port=${env.port || '-'} url=${env.url || '-'}（更新 ${env.updated_at}）`);
            if (env.error_msg) console.log(`error_msg：${env.error_msg}`);
            if (env.setup_log) console.log(`--- setup_log 尾端 ---\n${String(env.setup_log).slice(-2000)}`);
          } else console.log('（此專案尚無 odoo_envs 記錄）');
        } catch (e) { console.log(`（讀 odoo_envs 失敗：${e.message}）`); }
      }
    } else { section('專案'); console.log('（任務未綁定專案）'); }

    // 3. 各關最近執行（token_usage 以業務 task_id 關聯）
    section('最近執行（token_usage，新→舊）');
    try {
      const { rows } = await pool.query(
        `SELECT agent_type, model, status, duration_ms, output_tokens, recorded_at
         FROM token_usage WHERE task_id=$1 ORDER BY id DESC LIMIT 12`, [t.task_id]);
      if (!rows.length) console.log('（無）');
      for (const r of rows) {
        console.log(`${String(r.recorded_at).slice(0, 19)}  ${r.agent_type}(${r.model || '-'})  ${r.status}  ${((r.duration_ms || 0) / 1000).toFixed(1)}s  out=${r.output_tokens}`);
      }
    } catch (e) { console.log(`（查詢失敗：${e.message}）`); }

    // 4. 終端輸出尾端（task_events 以整數 tasks.id 關聯）
    section(`task_events 尾端（最後 ${EVENTS_N} 筆）`);
    try {
      const { rows } = await pool.query(
        'SELECT content FROM task_events WHERE task_id=$1 ORDER BY id DESC LIMIT $2', [t.id, EVENTS_N]);
      if (!rows.length) console.log('（無）');
      else console.log(rows.reverse().map(r => r.content).join('\n'));
    } catch (e) { console.log(`（查詢失敗：${e.message}）`); }

    // 5. 檔案 log（路徑規則見 CLAUDE.md §6）
    const logsDefault = path.join(repoRoot, 'data', 'logs');
    for (const [title, dir, prefix] of [
      ['Deploy 升級失敗 log', process.env.DEPLOY_LOG_DIR || logsDefault, `deploy-task${t.id}-`],
      ['E2E tour 失敗 log', process.env.E2E_LOG_DIR || logsDefault, `e2e-task${t.id}-`],
    ]) {
      section(title);
      try {
        const f = latestLog(dir, prefix);
        if (!f) console.log(`（無：${dir}/${prefix}*.log）`);
        else { console.log(`檔案：${f}`); console.log(tailFile(f)); }
      } catch (e) { console.log(`（讀取失敗：${e.message}）`); }
    }

    section('Odoo runtime log（每次啟動清空，只留當次執行）');
    try {
      if (!folder) console.log('（任務未綁定專案，無法定位 odoo-envs/<folder>/odoo.log）');
      else {
        const f = path.join(process.env.ODOO_ENV_BASE || path.join(repoRoot, 'odoo-envs'), folder, 'odoo.log');
        if (!fs.existsSync(f)) console.log(`（無：${f}）`);
        else { console.log(`檔案：${f}`); console.log(tailFile(f)); }
      }
    } catch (e) { console.log(`（讀取失敗：${e.message}）`); }
  } catch (e) {
    console.error('gather 失敗：' + e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
