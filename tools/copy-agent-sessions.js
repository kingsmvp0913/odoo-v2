#!/usr/bin/env node
// tools/copy-agent-sessions.js — 子專案 0 切換日：把續接中的 claude session 複製進 data/agent-home/<scope>/
// 用法：DATABASE_URL=... node tools/copy-agent-sessions.js          （只列計畫）
//       DATABASE_URL=... node tools/copy-agent-sessions.js --apply  （真的複製；不覆寫）
const m = require('../app/server/lib/agent-session-migrate');
const db = require('../app/server/db');

(async () => {
  const plans = await m.planSessionCopies();
  const byReason = {};
  for (const p of plans) { const k = p.reason.split(' ').slice(-1)[0]; byReason[k] = (byReason[k] || 0) + 1; }
  console.log(`計畫複製 ${plans.length} 項：`, byReason);
  for (const p of plans.slice(0, 10)) console.log(`  ${p.kind} ${p.from}\n    → ${p.to}`);
  if (process.argv.includes('--apply')) console.log('結果：', m.applySessionCopies(plans));
  else console.log('（未加 --apply，沒有複製任何檔案）');
  await db.getPool().end();
})().catch(e => { console.error(e.message); process.exit(1); });
