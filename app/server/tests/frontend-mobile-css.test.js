// 意圖：手機版型的三個「改對了沒人知道、改壞了也沒人知道」的地方。
// 這三條共通的失效方式都是靜默的——桌機完全正常，截圖門禁只驗桌機 1440（手機那組只報告
// 不擋），所以壞掉時沒有任何自動訊號，要等有人拿手機打開才會發現。
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '../../public');
// 註解裡出現的 class 名與範例宣告會污染比對，先剝掉。
const css = fs.readFileSync(path.join(PUBLIC, 'css/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// 內層規則（selector { decls }）；`[^{}]` 保證抓到的是最內層那一圈，@media 的外框不會混進選擇器。
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean),
  body: m[2]
}));

// 掃描全部 view 檔而不是列一份清單：列清單的守衛在下一個新增的 view 上就失效了
// （見 frontend-base-path.test.js 的 walk）。
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.js') ? [p] : []);
  });
}
const viewFiles = walk(path.join(PUBLIC, 'js'));

describe('手機全屏 modal 只套在真的需要的對象上', () => {
  // .modal 是全站共用的（dialog.js:75 的確認框、release-modal.js:41、WikiView 新增頁面、
  // ProjectChat 轉為任務）。當初只實測了「新增任務 modal」就把 height:100dvh 寫在共用選擇器上，
  // 結果手機按下「確定要刪除嗎？」看到的是兩行字撐滿整屏、按鈕貼在最上方。
  // 高度一律讓內容決定，只有內容本來就有一屏的新增任務 modal 例外。
  const fullHeight = rules
    .filter((r) => /(^|;)\s*height\s*:\s*100dvh/.test(r.body))
    .flatMap((r) => r.selectors);

  test('規則還在（選擇器被改名時不得靜默通過）', () => {
    expect(fullHeight).toContain('.tasklist-modal-panel');
  });

  test('共用的 .modal 不得被撐成整屏', () => {
    expect(fullHeight).not.toContain('.modal');
  });
});

describe('卡片化表格的每一格都要帶得出欄名', () => {
  // 手機上 .table-cards-sm 讓一列變一張卡，欄名由 td 的 data-label 經 ::before 印在左邊，
  // 並固定讓出 88px 給它。`[data-label=""]` 只匹配「屬性存在且為空」——屬性**缺席**時
  // ::before 照樣佔位，那一格的內容整條往右縮 88px（載入中／骨架列就是這樣歪掉的）。
  // 跨欄的單格列（空狀態、載入中）另有 .empty-row 規則處理，不需要 data-label。
  const cardTables = viewFiles.flatMap((file) => {
    const src = fs.readFileSync(file, 'utf8');
    const out = [];
    for (let i = src.indexOf('table-cards-sm'); i !== -1; i = src.indexOf('table-cards-sm', i + 1)) {
      const end = src.indexOf('</table>', i);
      if (end === -1) continue;
      out.push({ file: path.relative(PUBLIC, file), region: src.slice(i, end) });
    }
    return out;
  });

  test('解析到卡片化的表（選擇器改名時不得靜默通過）', () => {
    expect(cardTables.length).toBeGreaterThan(2);
  });

  test('每個 td 都有 data-label（跨欄的 .empty-row 除外）', () => {
    const bad = [];
    for (const { file, region } of cardTables) {
      for (const row of region.split(/<tr\b/).slice(1)) {
        const openTag = row.slice(0, row.indexOf('>') + 1);
        if (/empty-row/.test(openTag)) continue;
        for (const td of [...row.matchAll(/<td\b[^>]*>/g)].map((m) => m[0])) {
          if (!/\bdata-label\s*=/.test(td)) bad.push(`${file}：${td}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('浮動工具列的配色走 CSS 變數', () => {
  // 硬規則（platformDev skill）：配色一律走變數。.batch-action-bar 曾是這批版面 class 裡
  // 唯一寫死的一條（#1e293b／#fff），深色模式下等於一塊釘死的深藍板浮在頁面上。
  const bar = rules.find((r) => r.selectors.includes('.batch-action-bar'));

  test('規則還在', () => {
    expect(bar).toBeDefined();
  });

  test('background 與 color 都不是寫死的色碼', () => {
    const decls = bar.body.split(';').map((d) => d.trim())
      .filter((d) => /^(background|color)\s*:/.test(d));
    expect(decls.length).toBe(2);                       // 兩條都要在，被刪掉不算通過
    expect(decls.filter((d) => !d.includes('var('))).toEqual([]);
  });
});
