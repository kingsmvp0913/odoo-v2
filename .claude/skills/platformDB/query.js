#!/usr/bin/env node
/**
 * query.js — 查平台自己的 PostgreSQL（aidev / claude DB）。
 *
 * 連線優先序：
 *   1. 環境變數 DATABASE_URL → 直連（互動式 session、舊的無容器 pipeline）
 *   2. 沒有 DATABASE_URL，但有 AIDEV_AI_BASE＋AIDEV_AI_TOKEN → POST $AIDEV_AI_BASE/ai/platform/query
 *      （AI 容器內：沒有 DATABASE_URL、沒有 app/node_modules；平台以唯讀帳號代查、遮蔽敏感欄位）
 *   3. <repo>/data/config.json 的 DATABASE_URL → 直連
 *
 * 用法：
 *   node .claude/skills/platformDB/query.js "SELECT status, COUNT(*) FROM tasks GROUP BY status"
 *   node .claude/skills/platformDB/query.js --file some.sql
 *   node .claude/skills/platformDB/query.js --json "SELECT ..."   # 輸出 JSON 而非表格
 *
 * 安全：預設只做唯讀查詢。這是正式營運資料，勿在此跑 UPDATE/DELETE/DROP（工具會擋非 SELECT/WITH）。
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function connString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const cfg = path.join(repoRoot, 'data', 'config.json');
  const url = JSON.parse(fs.readFileSync(cfg, 'utf8')).DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 不在 env 也不在 data/config.json');
  return url;
}

// 容器內走平台的唯讀端點：容器沒有 DATABASE_URL，也沒有 app/node_modules 可以 require pg
function viaAi(sql) {
  const http = require('http');
  const u = new URL('/ai/platform/query', process.env.AIDEV_AI_BASE);
  const body = JSON.stringify({ sql });
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-AIDEV-AI-TOKEN': process.env.AIDEV_AI_TOKEN } }, res => {
      let raw = ''; res.on('data', c => { raw += c; });
      res.on('end', () => {
        let j; try { j = JSON.parse(raw); } catch { return reject(new Error(`HTTP ${res.statusCode}：${raw.slice(0, 300)}`)); }
        if (!j.ok) return reject(new Error(j.error || `HTTP ${res.statusCode}`));
        resolve(j.rows);
      });
    });
    req.on('timeout', () => req.destroy(new Error('查詢逾時（60s）')));
    req.on('error', reject);
    req.end(body);
  });
}

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
let sql;
const fileIdx = argv.indexOf('--file');
if (fileIdx !== -1) sql = fs.readFileSync(argv[fileIdx + 1], 'utf8');
else sql = argv.filter(a => a !== '--json').join(' ');

if (!sql || !sql.trim()) {
  console.error('用法：node query.js "SELECT ..."  或  --file q.sql');
  process.exit(2);
}
// 唯讀護欄：只允許 SELECT / WITH 開頭（去掉註解與空白後判斷）
const head = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().toUpperCase();
if (!/^(SELECT|WITH|EXPLAIN|SHOW)\b/.test(head)) {
  console.error('拒絕：只允許唯讀查詢（SELECT/WITH/EXPLAIN/SHOW）。');
  process.exit(2);
}

(async () => {
  const useAi = !process.env.DATABASE_URL && process.env.AIDEV_AI_BASE && process.env.AIDEV_AI_TOKEN;
  let pool = null;
  try {
    let rows;
    if (useAi) rows = await viaAi(sql);
    else {
      // 從 app 的 node_modules 借 pg（平台未在 PATH 裝 psql）；lazy require：容器內沒有這個目錄
      const { Pool } = require(path.join(repoRoot, 'app', 'node_modules', 'pg'));
      pool = new Pool({ connectionString: connString() });
      ({ rows } = await pool.query(sql));
    }
    if (asJson) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log('(0 rows)');
    else console.table(rows);
  } catch (e) {
    console.error('查詢失敗：' + e.message);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
})();
