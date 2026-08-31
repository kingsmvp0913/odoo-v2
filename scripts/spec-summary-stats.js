#!/usr/bin/env node
// 量 analysis.yaml 的 summary 寫得怎樣（契約見 analysis-project.md【summary 撰寫規則】）。
//
// 300 字是**觀察線不是上限**：需求大、牽涉多個畫面時本來就該寫長。長本身不是缺陷，
// 「長且塞滿技術詞」才是——那代表查證細節倒進了給人看的欄位（該搬去 findings）。
// 所以下面真正該看的是「長且有技術詞」那一格，不是「超過 300 字」的比例。
//
// 為什麼是獨立腳本而不是 pipeline 裡的 console.warn：pipeline 的 console 輸出不會進容器 log
// （實測 0 筆），寫在那裡等於死碼。summary 全存在 tasks.analysis_yaml，隨時可重算，不需要即時攔截。
//
// 用法：node scripts/spec-summary-stats.js [樣本數，預設 120]
//   改完 agent prompt 之後跑一次，跟改之前的數字比，才知道契約有沒有真的生效——不要靠觀感判斷。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Client } = require(path.join(ROOT, 'app', 'node_modules', 'pg'));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));

const SUMMARY_MAX = 300;
const LIMIT = Number(process.argv[2]) || 120;

// 識別字、dotted path、檔名——契約明文禁止出現在 summary 的東西
const TECH = [
  /\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*\b/g,
  /\b[a-z][a-z0-9]*_[a-z][a-z0-9_]*\b/g,
  /\b\w+\.(py|xml|csv|js|yaml)\b/g,
];

// 以行首鍵切頂層 section：規格常有未跳脫的冒號，走 YAML parser 會炸在無關的地方
function sections(yaml) {
  const out = {};
  let cur = null;
  for (const ln of yaml.split('\n')) {
    const m = ln.match(/^([a-z_]+):(.*)$/);
    if (m) { cur = m[1]; out[cur] = [m[2]]; }
    else if (cur) out[cur].push(ln);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  return out;
}

function techHits(s) {
  const hits = new Set();
  for (const re of TECH) for (const m of s.matchAll(re)) hits.add(m[0]);
  return hits;
}

(async () => {
  const c = new Client({ connectionString: cfg.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(
    `SELECT id, analysis_yaml FROM tasks
     WHERE analysis_yaml IS NOT NULL AND length(analysis_yaml) > 100
     ORDER BY id DESC LIMIT $1`, [LIMIT]);
  await c.end();

  const recs = [];
  for (const r of rows) {
    const s = sections(r.analysis_yaml);
    if (!s.summary) continue;
    recs.push({
      id: r.id,
      len: s.summary.length,
      tech: techHits(s.summary),
      hasFindings: Boolean(s.findings),
    });
  }
  if (!recs.length) { console.log('沒有可分析的規格'); return; }

  const n = recs.length;
  const lens = recs.map(r => r.len).sort((a, b) => a - b);
  const long = recs.filter(r => r.len > SUMMARY_MAX);
  const hasTech = recs.filter(r => r.tech.size > 0);
  // 真正的病徵：長 **且** 塞技術詞。單純長（大需求）不算，單純有一兩個技術詞也不算。
  const bad = recs.filter(r => r.len > SUMMARY_MAX && r.tech.size > 0);
  const pct = (x) => `${Math.round(x / n * 100)}%`;

  console.log(`樣本 ${n} 份規格（最近 ${LIMIT} 張任務）\n`);
  console.log(`summary 長度      中位 ${lens[Math.floor(n / 2)]} / 最大 ${lens[n - 1]}（${SUMMARY_MAX} 是觀察線，不是上限）`);
  console.log(`超過觀察線        ${long.length} (${pct(long.length)})   ← 大需求本來就會長，這格高不等於壞`);
  console.log(`含技術詞          ${hasTech.length} (${pct(hasTech.length)})`);
  console.log(`長且塞技術詞      ${bad.length} (${pct(bad.length)})   ★ 這格才是病徵：查證細節倒進了給人看的欄位`);
  console.log(`有寫 findings     ${recs.filter(r => r.hasFindings).length} (${pct(recs.filter(r => r.hasFindings).length)})   ★ 洩壓閥有沒有被用`);

  const worst = [...recs].sort((a, b) => (b.len - a.len) || (b.tech.size - a.tech.size)).slice(0, 8);
  if (worst.some(r => r.len > SUMMARY_MAX || r.tech.size)) {
    console.log('\n最需要看的幾筆：');
    for (const r of worst) {
      if (r.len <= SUMMARY_MAX && !r.tech.size) continue;
      const sample = [...r.tech].slice(0, 4).join(', ');
      console.log(`  task#${r.id}  ${r.len} 字  技術詞 ${r.tech.size}${sample ? ` (${sample})` : ''}${r.hasFindings ? '' : '  ※無 findings'}`);
    }
  }
})().catch(e => { console.error('失敗：', e.message); process.exit(1); });
