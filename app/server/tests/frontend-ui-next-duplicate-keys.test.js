// 意圖：擋「同一個 component 物件裡宣告了兩次同名頂層 key」。
//
// 2026-08-31 實際抓到：UiNextTaskDetailView 有兩個 `watch:`。JavaScript 物件字面量
// 的規則是後者整個覆蓋前者，所以第一個 watch 裡的兩個 watcher 從來沒有生效過：
//   'timeline.length' — 對話收到新訊息時自動捲到底。失效 ⇒ 使用者永遠看不到最新訊息，
//                        除非自己往下捲。這正是「舊對話怪怪的」的一個具體來源。
//   tourDemoStatus    — 教學模式狀態變化時重新整理。失效 ⇒ 教學卡在舊畫面。
//
// 為什麼現有門禁一個都攔不到：
//   - 不是語法錯，`node --check` 綠燈
//   - 不是死碼，被覆蓋掉的 watcher 內容看起來「有人用」
//   - 不是 lint 錯（此 repo 沒有跑 no-dupe-keys）
//   - 執行期零報錯、零 console warning
// 這是「程式碼看起來完全正常、功能靜默消失」的典型，跟 deadcode 那三個是同一個家族。
//
// 判準：component 物件的 depth-1 層級，同一個 key 名稱出現兩次以上即為缺陷。
const fs = require('fs');
const path = require('path');

const FILES = [
  'UiNextPages.js',
  'UiNextApp.js',
];

// ── 解析：括號配對，跳過註解與三種引號（與 frontend-ui-next-deadcode 同一套） ──
// 不用 regex：component 內含大量巢狀物件與 template 反引號字串，反引號還要追 ${} 深度，
// 否則 template 裡的 ${list.map(x => …)} 會把括號計數帶歪。
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

// component 物件的 depth-1 鍵名（含 `key:` 與 method shorthand `key(`）。
function topLevelKeys(body) {
  const keys = [];
  let depth = 0, i = 0;
  while (i < body.length) {
    const skip = skipToken(body, i);
    if (skip !== -1) { i = skip; continue; }
    const c = body[i];
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; continue; }
    if (depth === 1) {
      const m = body.slice(i).match(/^(?:async\s+)?(\w+)\s*[:(]/);
      if (m && /[\s,{]/.test(body[i - 1] || '{')) { keys.push(m[1]); i += m[0].length; continue; }
    }
    i++;
  }
  return keys;
}

const components = [];
for (const f of FILES) {
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/ui-next/', f), 'utf8');
  for (const m of src.matchAll(/window\.(UiNext\w*)\s*=\s*Vue\.defineComponent\(/g)) {
    const body = extractBlock(src, m.index);
    if (body) components.push({ file: f, name: m[1], body });
  }
}

// 解析器失效時測試不得靜默通過——這是此 repo 反覆踩過的坑。
test('解析得到 component（解析器或寫法變動時不得靜默略過）', () => {
  expect(components.length).toBeGreaterThanOrEqual(20);
  expect(components.every((c) => c.body.length > 200)).toBe(true);
  // 反向自驗：解析器真的抓得到頂層 key，而不是每次都回空陣列而讓測試全綠
  const detail = components.find((c) => c.name === 'UiNextTaskDetailView');
  expect(detail).toBeTruthy();
  expect(topLevelKeys(detail.body)).toEqual(expect.arrayContaining(['data', 'methods', 'template']));
});

describe('component 沒有重複宣告的頂層 key', () => {
  test.each(components.map((c) => c.name))('%s', (name) => {
    const { body } = components.find((c) => c.name === name);
    const seen = new Map();
    for (const k of topLevelKeys(body)) seen.set(k, (seen.get(k) || 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);

    const hint = dupes.length
      ? `\n\n【${name} 有重複的頂層 key】\n  ${dupes.join('\n  ')}\n\n`
        + '物件字面量的後一個同名 key 會整個覆蓋前一個，前面那份的內容永遠不會執行，\n'
        + '而且不會有語法錯、不會有 console 警告。修法：合併成同一個區塊。\n'
      : '';
    expect(dupes.length === 0 ? '無重複 key' : `有重複 key${hint}`).toBe('無重複 key');
  });
});
