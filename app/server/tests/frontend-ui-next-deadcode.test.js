// 意圖：擋「宣告了但沒有任何地方用得到」的 method 與 data。
//
// 2026-08-31 一次稽核挖到三個缺陷，形狀完全相同，而且三個都是使用者看得到、
// 測試看不到的那種壞法：
//   attachUrls  — data 宣告了、template 也綁了，但沒有任何寫入路徑。
//                 結果是 Chat 的圖片附件永久不顯示，畫面上什麼錯都沒有。
//   loadError   — data 宣告了、load() 也賦值了，但 template 0 次引用。
//                 結果是專案載入失敗時畫面顯示「專案不存在」，把網路錯誤誤報成資料不存在。
//   提問頁籤     — method 全都在（script 是 Legacy 的逐字複製），但 template 0 次引用。
//                 結果是整個功能永久不可達，而從程式碼上看「功能明明做了」。
//
// 共同教訓：**method 存在不代表使用者按得到**。逐字複製 script 但只搬一部分 template，
// 就會系統性地長出這種東西，而既有的門禁（禁止委派 Legacy View）完全不會響。
//
// 判準：一個 method／data key 若在 template、其他 method、以及 component 其餘部分
// （computed/watch/生命週期）中都找不到引用，就是死碼。
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '../../public/js/ui-next/UiNextPages.js'),
  'utf8',
);

// 已知且刻意保留的死碼。每一筆都要寫清楚為什麼不修，不接受只寫「既有問題」。
const ALLOWED = new Map([
  // UiNextAdminSettingsView 是 views/Admin.js 的逐字複製（見 frontend-ui-next-frozen-copies）。
  // stepPipeline 在 Legacy Admin.js 裡就已經是死碼——整份檔案只出現一次，就是它自己的定義，
  // template 從未呼叫（真正在用的是 views/TaskList.js 的同名 method）。
  // 這裡修掉它會讓凍結比對紅，而那個比對擋的是更重要的東西（兩份靜默漂移）。
  // 要清的話得連 Legacy 一起清，屬於另一件事。
  ['UiNextAdminSettingsView', new Set(['method stepPipeline'])],
]);

// ── 解析：括號配對，跳過註解與三種引號 ──────────────────────────
// 不用 regex：這些 component 內含大量巢狀物件與 template 反引號字串，
// 反引號還要追 ${} 深度，否則 template 裡的 ${list.map(x => …)} 會把括號計數帶歪。
function skipToken(s, i) {
  const c = s[i];
  if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); return e === -1 ? s.length : e + 2; }
  if (c === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); return e === -1 ? s.length : e + 1; }
  if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1; return j + 1; }
  if (c === '`') {
    let j = i + 1, td = 0;
    while (j < s.length) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === '$' && s[j + 1] === '{') { td++; j += 2; continue; }
      if (s[j] === '}' && td > 0) { td--; j++; continue; }
      if (s[j] === '`' && td === 0) break;
      j++;
    }
    return j + 1;
  }
  return -1;
}

function extractBlock(s, start) {
  let i = s.indexOf('{', start);
  const from = i;
  let depth = 0;
  while (i < s.length) {
    const skip = skipToken(s, i);
    if (skip !== -1) { i = skip; continue; }
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return s.slice(from, i + 1); }
    i++;
  }
  return null;
}

function sectionOf(body, key) {
  const m = body.match(new RegExp(`(^|[\\s,{])${key}\\s*[:(]`, 'm'));
  if (!m) return null;
  const at = m.index + m[0].length - 1;
  if (key !== 'template') return extractBlock(body, at);
  const tick = body.indexOf('`', at);
  if (tick === -1) return null;
  const end = skipToken(body, tick);
  return body.slice(tick + 1, end - 1);
}

function topLevelMethodNames(methodsBlock) {
  const names = [];
  let depth = 0, i = 0;
  while (i < methodsBlock.length) {
    const skip = skipToken(methodsBlock, i);
    if (skip !== -1) { i = skip; continue; }
    const c = methodsBlock[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 1) {
      const mm = methodsBlock.slice(i).match(/^(?:async\s+)?(\w+)\s*\(/);
      if (mm && /[\s,{]/.test(methodsBlock[i - 1] || '{')) { names.push(mm[1]); i += mm[0].length; continue; }
    }
    i++;
  }
  return [...new Set(names)];
}

const components = [...SRC.matchAll(/window\.(UiNext\w*View)\s*=\s*Vue\.defineComponent\(/g)]
  .map((m) => ({ name: m[1], body: extractBlock(SRC, m.index) }))
  .filter((c) => c.body);

// 解析器失效時測試不得靜默通過——這是此 repo 反覆踩過的坑。
test('解析得到 component（解析器或寫法變動時不得靜默略過）', () => {
  expect(components.length).toBeGreaterThanOrEqual(20);
  expect(components.every((c) => c.body.length > 200)).toBe(true);
});

describe('沒有宣告了卻用不到的 method / data', () => {
  test.each(components.map((c) => c.name))('%s', (name) => {
    const { body } = components.find((c) => c.name === name);
    const tpl = sectionOf(body, 'template') || '';
    const methodsBlock = sectionOf(body, 'methods') || '';
    const dataBlock = sectionOf(body, 'data') || '';
    const allowed = ALLOWED.get(name) || new Set();

    const dead = [];
    const restOf = (block) => body.replace(block, '').replace(tpl, '');

    for (const n of topLevelMethodNames(methodsBlock)) {
      const re = new RegExp(`\\b${n}\\b`);
      const usedInTemplate = re.test(tpl);
      // this.foo( 或在 computed/watch/生命週期裡出現都算有人用
      const usedElsewhere = new RegExp(`this\\.${n}\\b`).test(methodsBlock) || re.test(restOf(methodsBlock));
      if (!usedInTemplate && !usedElsewhere) dead.push('method ' + n);
    }
    for (const k of [...new Set([...dataBlock.matchAll(/[{,]\s*(\w+)\s*:/g)].map((d) => d[1]))]) {
      const re = new RegExp(`\\b${k}\\b`);
      if (!re.test(tpl) && !re.test(restOf(dataBlock))) dead.push('data ' + k);
    }

    const offenders = dead.filter((d) => !allowed.has(d));
    const hint = offenders.length
      ? `\n\n【${name} 有 ${offenders.length} 項宣告了卻沒有任何地方用得到】\n  ` +
        offenders.join('\n  ') +
        '\n\n這通常不是「多寫了沒用的東西」，而是**功能少了入口**：\n' +
        '  method 沒人呼叫 → 那個功能使用者永遠按不到（即使程式碼看起來寫好了）\n' +
        '  data 沒人讀    → 那個狀態永遠不顯示（錯誤訊息、載入中、附件網址都中過招）\n\n' +
        '修法：補上 template 的入口／綁定。真的要留著不修，就加進本檔的 ALLOWED 並寫清楚為什麼。\n'
      : '';
    expect(offenders.length === 0 ? '無死碼' : `有死碼${hint}`).toBe('無死碼');
  });
});
