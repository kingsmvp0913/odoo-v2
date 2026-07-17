#!/usr/bin/env node
/**
 * query.js — 查平台自己的 PostgreSQL（aidev / claude DB）。
 *
 * 連線字串優先序：
 *   1. 環境變數 DATABASE_URL
 *   2. <repo>/data/config.json 的 DATABASE_URL 欄位
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

// 從 app 的 node_modules 借 pg（平台未在 PATH 裝 psql）
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
  const pool = new Pool({ connectionString: connString() });
  try {
    const { rows } = await pool.query(sql);
    if (asJson) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log('(0 rows)');
    else console.table(rows);
  } catch (e) {
    console.error('查詢失敗：' + e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
