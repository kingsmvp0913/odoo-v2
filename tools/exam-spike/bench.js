// 對立審查基準測試——規格 §13.1。
//
// 量三個數字：
//   1. 分數：correct_answer 對 answer-key.json，與盲判的 28/30 比
//   2. 假陽性率：作答者答對卻被 refuted 的題數 ÷ 作答者答對的題數
//   3. 每題平均耗時
//
// 第 2 個是本 spike 存在的理由。分數再好，假陽性高到紅燈沒人看，
// 交叉驗證等於沒有。
const fs = require('fs');
const path = require('path');
const { reviewPage } = require('./adversary');

const ROOT = path.join(__dirname, '..', '..');
const EXAM = path.join(ROOT, 'data', 'exam');
const KEY = JSON.parse(fs.readFileSync(path.join(EXAM, 'answer-key.json'), 'utf8')).pages;
const INBOX = path.join(EXAM, 'backup-20260812-inbox');

const norm = a => [...new Set((a || []).map(x => String(x).trim().toUpperCase()))].sort().join('+');

// 備份裡同一頁可能有多筆（重跑過）。取 seq 最大的那筆——它是最後一次的資料。
// 用 createdAt 排不穩定：同一批是在同一個迴圈裡建立的，毫秒精度下一堆同值。
function pickRecords() {
  const byPage = new Map();
  for (const dir of fs.readdirSync(INBOX)) {
    const f = path.join(INBOX, dir, 'record.json');
    if (!fs.existsSync(f)) continue;
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (r.test) continue;
    const page = String(r.page || '');
    if (!KEY[page]) continue;
    const prev = byPage.get(page);
    if (!prev || (r.seq || 0) > (prev.seq || 0)) byPage.set(page, { ...r, dir });
  }
  return byPage;
}

// 作答者的答案來自 record.answer（自由格式字串，如「第 1 題 B；第 2 題 A」）。
// 必須知道題數才能消歧義——"B,D" 在一題時是複選，在兩題時是兩題各一。
function parseTheirs(raw, count) {
  const out = Array.from({ length: count }, () => []);
  const text = String(raw || '');
  const re = /(?:第\s*)?(\d+)\s*(?:題|[.)、:：])\s*([A-Za-z](?:\s*[,、和及與+]\s*[A-Za-z])*)/g;
  let m, got = 0;
  while ((m = re.exec(text)) !== null) {
    const no = parseInt(m[1], 10);
    const ls = [...new Set((m[2].toUpperCase().match(/[A-Z]/g) || []))].sort();
    if (no >= 1 && no <= count && ls.length) { out[no - 1] = ls; got++; }
  }
  // 沒有顯式編號時，退用「連寫字母依序對應題號」（保留原順序，不可排序——
  // 排過的 BCA 會變成第一題 A，實測踩過）
  if (!got) {
    const seq = text.toUpperCase().match(/[A-Z]/g) || [];
    if (seq.length === count) seq.forEach((c, i) => { out[i] = [c]; });
    else if (count === 1 && seq.length) out[0] = [...new Set(seq)].sort();
  }
  return out;
}

async function main() {
  const byPage = pickRecords();
  const pages = Object.keys(KEY).sort((a, b) => Number(a) - Number(b));
  const rows = [];
  let scoreOk = 0, scoreBad = 0, unscored = 0;
  let theirRight = 0, falsePositive = 0, truePositive = 0, missed = 0;
  let totalMs = 0, judged = 0;

  for (const page of pages) {
    const rec = byPage.get(page);
    const key = KEY[page];
    if (!rec) { console.log(`P${page}  (備份裡沒有這一頁)`); unscored += key.length; continue; }

    const imagePath = path.join(INBOX, rec.dir, rec.imageFile || 'shot.jpg');
    const theirs = parseTheirs(rec.answer, key.length);
    const t0 = process.hrtime.bigint();
    let verdict;
    try {
      ({ verdict } = await reviewPage({ imagePath, theirAnswers: theirs }));
    } catch (e) {
      console.log(`P${page}  ✗ 審查失敗：${e.message}`);
      unscored += key.length;
      continue;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    totalMs += ms;

    const qs = verdict.questions || [];
    if (qs.length !== key.length) {
      console.log(`P${page}  ⚠ 審出 ${qs.length} 題、答案有 ${key.length} 題——題號沒對齊，本頁不計分`);
      unscored += key.length;
      continue;
    }
    judged += qs.length;

    const marks = [];
    for (const [i, q] of qs.entries()) {
      const want = norm([key[i]]);
      const said = norm(q.correct_answer);
      const their = norm(theirs[i]);
      const ok = said === want;
      ok ? scoreOk++ : scoreBad++;

      // 假陽性 = 作答者本來是對的，卻被推翻。這是本 spike 的核心指標。
      if (their === want) {
        theirRight++;
        if (q.refuted) falsePositive++;
      } else {
        if (q.refuted) truePositive++; else missed++;
      }
      marks.push(`Q${q.no}:${ok ? '✓' : '✗'}${q.refuted ? '(推翻)' : ''}`);
      rows.push({ page, no: q.no, want, said, their, refuted: q.refuted,
                  confidence: q.confidence, reason: q.reason, question: q.question });
    }
    console.log(`P${page}  ${marks.join('  ')}  ${Math.round(ms / 1000)}s`);
  }

  const total = scoreOk + scoreBad;
  const pct = (n, d) => (d ? (n / d * 100).toFixed(1) : '0.0');
  const summary = {
    score: `${scoreOk}/${total}`,
    scorePct: pct(scoreOk, total),
    baselineBlind: '28/30',
    theirRight,
    falsePositive,
    falsePositiveRate: pct(falsePositive, theirRight),
    truePositive,
    missed,
    unscored,
    avgSecPerQuestion: judged ? (totalMs / judged / 1000).toFixed(1) : null,
    model: process.env.EXAM_JUDGE_MODEL || 'opus',
  };

  console.log('\n=== 結論 ===');
  console.log(`分數：${summary.score}（${summary.scorePct}%）　盲判基準 28/30`);
  console.log(`假陽性：${falsePositive}/${theirRight}（${summary.falsePositiveRate}%）　← 作答者答對卻被推翻`);
  console.log(`真陽性：${truePositive}　漏抓：${missed}`);
  console.log(`每題平均：${summary.avgSecPerQuestion}s`);
  if (unscored) console.log(`未計分：${unscored} 題`);

  fs.writeFileSync(path.join(EXAM, 'bench-result.json'),
    JSON.stringify({ summary, rows }, null, 2));
  console.log('\n明細已寫入 data/exam/bench-result.json');
}

module.exports = { parseTheirs, pickRecords };

if (require.main === module) {
  main().catch(e => { console.error('失敗:', e.message); process.exit(1); });
}
