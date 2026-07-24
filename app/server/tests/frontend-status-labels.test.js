const fs = require('fs');
const path = require('path');
const { STATUS_LABELS } = require('../../public/js/status-labels.js');

const publicDir = path.join(__dirname, '../../public');
const readPublic = (f) => fs.readFileSync(path.join(publicDir, f), 'utf8');

// 走訪全樹而非寫死清單：漏標的成因就是「view 各存一份」，寫死清單只擋得住當初改到的那幾支，
// 下一支新 view 照樣能複製一份進來。vendor/ 是第三方 bundle，排除。
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.name === 'vendor' ? [] :
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const publicJsFiles = walk(publicDir)
  .map((f) => path.relative(publicDir, f))
  .filter((f) => f.endsWith('.js') && f !== path.join('js', 'status-labels.js'));

// 這支測試守的是「任務狀態的中文標籤只有一份」。三份並存時的失效方式不是報錯而是靜默不一致：
// 同一狀態在列表與詳情顯示不同文字（等待回覆確認／等待確認回覆），新增的關卡漏補某一份就顯示
// 英文 status。兩者都不會有任何 console 錯誤，只能靠人工比對三個檔案才看得出來。
describe('狀態標籤單一來源', () => {
  test.each(publicJsFiles)('%s 不得自帶第二份狀態標籤表', (file) => {
    const offenders = readPublic(file).match(/[A-Z_]*STATUS_LABELS\s*=\s*\{/g) || [];
    expect(offenders).toEqual([]);
  });

  test('index.html 載入 status-labels.js（漏載入＝全站狀態顯示英文）', () => {
    expect(readPublic('index.html')).toContain('<script src="js/status-labels.js"></script>');
  });
});

// runner.js 的 STAGE_LABELS 是後端「執行歷程」用的階段標記，文案刻意與前端不同（客服處理中／
// 已回覆澄清），故兩份並存、不合併。但它的 key 集合＝後端流程實際會走到的狀態，前端缺任何一個
// 就會在畫面上顯示英文 status——respec_running 就是這樣只存在於詳情頁、列表漏掉。
// 這裡斷言涵蓋關係而非相等：前端多出 pending 類狀態（review_pending、cs_data_needed…）是正常的，
// 那些狀態不派工、不會出現在後端的執行歷程裡。
describe('前端標籤涵蓋後端所有流程狀態', () => {
  const runnerSrc = fs.readFileSync(path.join(__dirname, '../pipeline/runner.js'), 'utf8');
  const stageBlock = runnerSrc.match(/const STAGE_LABELS = \{([\s\S]*?)\};/)[1];
  const stageKeys = [...stageBlock.matchAll(/(\w+):/g)].map((m) => m[1]);

  test('STAGE_LABELS 解析到合理數量的 key（regex 失效時測試不得靜默通過）', () => {
    expect(stageKeys.length).toBeGreaterThan(10);
  });

  test.each(stageKeys)('%s 在前端有中文標籤', (key) => {
    expect(STATUS_LABELS[key]).toBeDefined();
  });
});
