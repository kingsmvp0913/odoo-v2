const { loadAgent, invalidate } = require('../pipeline/agent-loader');

// 意圖（Rule 9）：SD 若沒有「要驗什麼」的 acceptance 清單，tour 作者只能從
// requirements 自由發揮寫斷言 → 品質浮動（有的驗存檔值、有的只驗一格存在）。
// 這組測試釘住「analysis agent 必須產出 acceptance 欄位與撰寫指引」，
// 一旦有人手滑刪掉，紅燈即現。
describe('SD acceptance 驗收點導入', () => {
  beforeEach(() => invalidate()); // 清 mtime 快取，確保讀到當前檔案內容

  test.each(['analysis-project'])(
    '%s 的 SD 格式含 acceptance 欄位與撰寫規則',
    (name) => {
      const body = loadAgent(name).body;
      expect(body).toMatch(/acceptance:/);   // schema 內有此欄
      expect(body).toContain('可觀察');       // 有「寫可觀察結果」的指引
    }
  );

  // 意圖（Rule 9）：出考題的 agent 必須把每條 acceptance 變成一個斷言（缺一不可），
  // 否則「弱 tour」（只驗某元素存在、不驗值/數字）會重現。
  // 對象從 playwright 改為 playwright-spec：2026-08-11 砍掉「實作完才產 tour」那條路之後，
  // 全平台只剩這一支在出考題。原本還斷言「無 acceptance 時的 fallback」，那條隨之失效——
  // writeSpecTour 在 `if (!task.analysis_yaml) return` 就擋掉了，這支 agent 不可能拿到無規格的輸入。
  test('playwright-spec 要求逐條覆蓋 acceptance（不得只驗元素存在）', () => {
    const body = loadAgent('playwright-spec').body;
    expect(body).toMatch(/acceptance/);        // 有引用 acceptance
    expect(body).toContain('缺一不可');          // 強制逐條覆蓋
    // 涵蓋不到的必須明講，不能假裝測了——這才是「弱 tour」真正的防線
    expect(body).toContain('不要假裝測了');
  });
});

// 意圖：`issues[].category` 是退回根因統計（rejection_items.category）的唯一來源。
// qa.md 明列三選一並在範例裡示範物件形狀；qa-retry.md 的輸出契約卻只寫 `"issues":["…"]`，
// resume 輪照契約回純字串 → parseQaIssues 一律套 DEFAULT_CATEGORY(impl_miss)。
// 後果不是「少一個欄位」而是資料靜默失真：所有 resume 輪的退回都被記成「實作寫錯」，
// spec_unclear／env_flaky 在統計上永遠掛零，健檢據此得出「規格沒問題」的錯誤結論。
// 這是 prompt 契約，沒有可執行分支能驗——用靜態守衛釘住。
describe('qa-retry 輸出契約含 issues[].category', () => {
  beforeEach(() => invalidate());

  const CATEGORIES = require('../pipeline/qa-rejection').QA_CATEGORIES;

  test('qa-retry 的 issues 是帶 category 的物件、且列出與 JS 端一致的三個合法值', () => {
    const body = loadAgent('qa-retry').body;
    // 契約範例必須是物件形狀（desc + category），不是裸字串陣列
    expect(body).toMatch(/"issues"\s*:\s*\[\s*\{/);
    expect(body).toContain('"desc"');
    expect(body).toContain('"category"');
    // 三個合法值逐一列出——少列一個，模型就永遠不會產出那一類
    for (const c of CATEGORIES) expect(body).toContain(c);
  });

  test('qa-retry 與 qa 用同一組 category 值（兩份契約不得分岔）', () => {
    const retry = loadAgent('qa-retry').body;
    const first = loadAgent('qa').body;
    const pick = b => [...CATEGORIES].filter(c => b.includes(c)).sort();
    expect(pick(retry)).toEqual(pick(first));
  });
});
