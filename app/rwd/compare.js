// 基線比對。桌機（gate）有差異即失敗，平板／手機只報告不擋。
//
//   node rwd/compare.js              比對 snapshots/ 與 baseline/
//   node rwd/compare.js --gate-only  只判桌機那組
//
// 退出碼：0 = 門禁通過；1 = 桌機出現回歸或基線缺漏。

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { DIFF, shotPlan } = require('./routes');

const GATE_ONLY = process.argv.slice(2).includes('--gate-only');
const BASE_DIR = path.join(__dirname, 'baseline');
const SNAP_DIR = path.join(__dirname, 'snapshots');
const DIFF_DIR = path.join(__dirname, 'diff');

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

async function main() {
  // pixelmatch 7 是 ESM。用 dynamic import 而非 require——require(ESM) 只在 Node 22+ 可用，
  // 而 DEPLOY.md 要求的是 Node 20 LTS，寫成 require 會在部署機上炸。
  const pixelmatch = (await import('pixelmatch')).default;

  if (!fs.existsSync(BASE_DIR)) {
    console.error(`找不到基線目錄：${path.relative(process.cwd(), BASE_DIR)}\n先跑 npm run rwd:baseline`);
    process.exit(1);
  }
  fs.mkdirSync(DIFF_DIR, { recursive: true });

  const plan = shotPlan({ gateOnly: GATE_ONLY });
  const regressions = [];   // 桌機差異 → 擋
  const changes = [];       // 平板／手機差異 → 只報告
  const missing = [];
  let identical = 0;

  for (const shot of plan) {
    const basePath = path.join(BASE_DIR, `${shot.name}.png`);
    const snapPath = path.join(SNAP_DIR, `${shot.name}.png`);
    const isGate = shot.viewport.gate;

    if (!fs.existsSync(basePath) || !fs.existsSync(snapPath)) {
      missing.push({ name: shot.name, isGate, why: !fs.existsSync(basePath) ? '缺基線' : '缺當前截圖' });
      continue;
    }

    const a = readPng(basePath);
    const b = readPng(snapPath);

    // 尺寸不同無法逐點比，直接判為差異——版面高度變了本來就是要抓的東西。
    if (a.width !== b.width || a.height !== b.height) {
      const item = { name: shot.name, diff: -1, why: `尺寸 ${a.width}x${a.height} → ${b.width}x${b.height}` };
      (isGate ? regressions : changes).push(item);
      continue;
    }

    const out = new PNG({ width: a.width, height: a.height });
    const n = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: DIFF.threshold });

    if (n > DIFF.maxDiffPixels) {
      fs.writeFileSync(path.join(DIFF_DIR, `${shot.name}.png`), PNG.sync.write(out));
      (isGate ? regressions : changes).push({ name: shot.name, diff: n });
    } else {
      identical++;
    }
  }

  console.log(`比對 ${plan.length} 組｜相同 ${identical}｜桌機回歸 ${regressions.length}｜小螢幕變動 ${changes.length}｜缺圖 ${missing.length}`);

  if (changes.length) {
    console.log(`\n小螢幕變動（預期中，不擋）：`);
    for (const c of changes) console.log(`  ~ ${c.name}${c.why ? `：${c.why}` : `：${c.diff} px`}`);
  }
  if (missing.length) {
    console.log(`\n缺圖：`);
    for (const m of missing) console.log(`  ? ${m.name}：${m.why}`);
  }
  if (regressions.length) {
    console.log(`\n桌機回歸（門禁失敗，差異圖在 rwd/diff/）：`);
    for (const r of regressions) console.log(`  ✗ ${r.name}${r.why ? `：${r.why}` : `：${r.diff} px`}`);
  }

  // 桌機缺圖也算失敗：少比一張不等於通過。
  const gateMissing = missing.filter(m => m.isGate);
  const failed = regressions.length > 0 || gateMissing.length > 0;
  console.log(`\n門禁：${failed ? '失敗' : '通過'}`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
