const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'js', 'views', 'ProjectDbQuery.js'), 'utf8');

const LOG_FIELDS = ['log_mode', 'log_container', 'log_unit', 'log_path', 'log_tz_offset'];

// form 物件在 data() 與 resetForm() 兩處各定義一次，漏改一處的症狀是
// 「新增時正常、按過重置後欄位消失」——手動測很容易漏掉這條路徑。
//
// 必須分別檢查兩個區塊，不能只數全檔出現次數：log_mode 在模板裡還會出現數次
// （v-if、清單 badge），只漏 resetForm() 的話全檔計數照樣過關＝測了等於沒測。
function formBlock(re) {
  const m = re.exec(SRC);
  if (!m) throw new Error(`找不到 form 定義區塊：${re}`);
  return m[1];
}

test('data() 的 form 含全部 log 欄位', () => {
  const block = formBlock(/\bform:\s*\{([^}]*)\}/);
  for (const f of LOG_FIELDS) expect(block).toContain(f);
});

test('resetForm() 的 form 含全部 log 欄位', () => {
  const block = formBlock(/this\.form\s*=\s*\{([^}]*)\}/);
  for (const f of LOG_FIELDS) expect(block).toContain(f);
});

test('有偵測按鈕與對應 method', () => {
  expect(SRC).toContain('probeLog');
  expect(SRC).toContain('probe-log');
});

// 沒存過的連線沒有 id，探測端點吃 :cid，必須先擋住而不是送出 undefined。
test('未儲存的連線不可觸發偵測', () => {
  expect(SRC).toMatch(/probeLog[\s\S]{0,400}form\.id/);
});

// dark-mode 硬規則：寫死淺色背景而未同時寫死文字色，深色模式下文字吃 var(--text) 翻白＝隱形。
// 掃全檔而非只掃新增段落——既有碼目前無違規，任何命中都是本次帶進來的。
test('全檔沒有「寫死淺色背景卻未寫死文字色」的樣式', () => {
  const badBg = /background:\s*#(fff|ffffff|f8fafc|fef2f2|f1f5f9)\b/gi;
  for (const m of SRC.matchAll(badBg)) {
    const seg = SRC.slice(m.index, m.index + 120);
    expect(seg).toMatch(/color:\s*(#|var\()/);
  }
});
