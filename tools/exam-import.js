// 一次性匯入 CLI。第 2 期會有 HTTP 端點取代它，但那時這支仍可用來重建。
//
//   node tools/exam-import.js data/exam/banks/2026-08-14-1 2026-08-14-1 19
const path = require('path');
const fs = require('fs');

const [dir, label, version] = process.argv.slice(2);
if (!dir || !label || !version) {
  console.error('用法: node tools/exam-import.js <題庫目錄> <label> <odoo版本>');
  process.exit(1);
}

// DATABASE_URL 在 data/config.json 不在 .env（此 repo 的既有配置）
const cfgPath = path.join(__dirname, '..', 'data', 'config.json');
if (!process.env.DATABASE_URL && fs.existsSync(cfgPath)) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (cfg.DATABASE_URL) process.env.DATABASE_URL = cfg.DATABASE_URL;
}

const db = require('../app/server/db');
const { importBank } = require('../app/server/lib/exam/import-bank');
const { syncGlossary } = require('../app/server/lib/exam/glossary');

(async () => {
  await db.migrate();

  const questions = JSON.parse(fs.readFileSync(path.join(dir, 'questions.json'), 'utf8'));
  const secPath = path.join(dir, 'section-results.json');
  const sections = fs.existsSync(secPath)
    ? JSON.parse(fs.readFileSync(secPath, 'utf8'))
    : { sections: {} };

  const r = await importBank(db, { label, odooVersion: version, questions, sections });
  console.log('匯入:', JSON.stringify({ ...r, skipped: r.skipped.length }));
  if (r.skipped.length) console.log('跳過:', r.skipped.join('、'));

  const coreDir = path.join(__dirname, '..', 'data', 'odoo-core', version);
  if (fs.existsSync(coreDir)) {
    const g = await syncGlossary(db, version, coreDir);
    console.log('術語表:', g.upserted, '條');
  } else {
    console.log(`⚠ ${coreDir} 不存在，跳過術語表。用 ensureOdooCoreSrc('${version}') 解出來後再跑。`);
  }
  process.exit(0);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
