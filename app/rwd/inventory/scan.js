// 掃出 layout 類 inline style 的精確位置，產出 Block 2／3 的工作清單。
//
//   cd app && npm run rwd:inventory
//
// 可重跑：每個 Block 遷移完就重跑一次，剩餘處數即進度。

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const PUBLIC_JS = path.join(REPO, 'app', 'public', 'js');
const OUT = path.join(__dirname, 'inline-style.md');

// 只有這四類會擋住 media query 覆寫，其餘 inline style（顏色／字級／間距）不在範圍。
const CATS = [
  { key: 'flex/grid', re: /display:\s*(flex|grid)/ },
  { key: '固定寬', re: /(?:min-|max-)?width:\s*[1-9][0-9]{2,}px/ },
  { key: 'grid-template', re: /grid-template/ },
  { key: 'nowrap', re: /white-space:\s*nowrap/ }
];

// 分批依「處數平衡」而非「檔案大小」——TaskDetail/TokenReport 的 127 處是全部 inline style，
// layout 類其實只有 14/17 處，照檔案大小分會讓兩批相差三倍。
const BLOCK2 = [
  'views/TokenReport.js', 'views/ProjectDetail.js', 'views/TaskDetail.js',
  'views/ProjectChat.js', 'views/TaskList.js', 'views/Settings.js'
];
// shell template 由 Block 1 的 drawer 改造一併處理，不要在 Block 2/3 重複動它。
const BLOCK1 = ['app.js'];

function batchOf(rel) {
  if (BLOCK1.includes(rel)) return 'Block 1';
  return BLOCK2.includes(rel) ? 'Block 2' : 'Block 3';
}

function scan(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== 'vendor') out.push(...scan(p)); continue; }
    if (!f.name.endsWith('.js')) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    const hits = [];
    lines.forEach((line, i) => {
      for (const s of line.match(/style="[^"]*"/g) || []) {
        const cats = CATS.filter(c => c.re.test(s)).map(c => c.key);
        if (cats.length) hits.push({ line: i + 1, cats, snippet: s.length > 90 ? s.slice(0, 88) + '…' : s });
      }
    });
    if (hits.length) out.push({ rel: path.relative(PUBLIC_JS, p).split(path.sep).join('/'), hits });
  }
  return out;
}

const files = scan(PUBLIC_JS).map(f => ({ ...f, batch: batchOf(f.rel) }))
  .sort((a, b) => a.batch.localeCompare(b.batch) || b.hits.length - a.hits.length);

const total = files.reduce((n, f) => n + f.hits.length, 0);
const byCat = {};
for (const f of files) for (const h of f.hits) for (const c of h.cats) byCat[c] = (byCat[c] || 0) + 1;
const byBatch = {};
for (const f of files) byBatch[f.batch] = (byBatch[f.batch] || 0) + f.hits.length;

let md = `# 盤點：layout 類 inline style 待遷移清單

> 由 \`app/rwd/inventory/scan.js\` 產生（\`cd app && npm run rwd:inventory\` 可重跑）。
> 對應規格 \`RWD-C-SPEC.md\` Block 2／3。遷移完重跑一次，剩餘處數即進度。

## 總計

**${total} 處 inline style / ${files.length} 檔**（分類命中 ${Object.values(byCat).reduce((a, b) => a + b, 0)} 次——同一處可同時屬多類）

| 類別 | 命中 |
|---|---|
${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

## 分批

| 批次 | 處數 | 範圍 |
|---|---|---|
${Object.entries(byBatch).sort().map(([k, v]) => {
  const why = k === 'Block 1' ? 'shell template，由 drawer 改造一併處理' :
              k === 'Block 2' ? '高頻頁 6 檔' : '其餘全部';
  return `| ${k} | ${v} | ${why} |`;
}).join('\n')}

依「處數平衡」分批，不是依檔案大小：\`TaskDetail.js\`／\`TokenReport.js\` 的 127 處是**全部** inline style，
layout 類其實只有 14／17 處，照檔案大小分會讓兩批相差三倍。

## 遷移規則（規格 §2.2，不可放寬）

抽出的 class 內容**與原 inline style 逐字相同**：不順手改值、不合併相似規則、不改順序。
想調整的值一律留到後續 Block、在 media query 內處理。
驗收是像素級的——桌機截圖 diff 必須為 0。

---

`;

let cur = null;
for (const f of files) {
  if (f.batch !== cur) { cur = f.batch; md += `## ${cur}\n\n`; }
  md += `### \`js/${f.rel}\` — ${f.hits.length} 處\n\n`;
  md += `| 行 | 類別 | inline style |\n|---|---|---|\n`;
  for (const h of f.hits) {
    md += `| ${h.line} | ${h.cats.join(', ')} | \`${h.snippet.replace(/\|/g, '\\|')}\` |\n`;
  }
  md += `\n`;
}

fs.writeFileSync(OUT, md);
console.log(`${total} 處 / ${files.length} 檔 → ${path.relative(process.cwd(), OUT)}`);
console.log(Object.entries(byBatch).sort().map(([k, v]) => `${k}: ${v} 處`).join(' | '));
