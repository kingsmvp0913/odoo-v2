const { loadAgent, invalidate } = require('../pipeline/agent-loader');

// 意圖（Rule 9）：SD 若沒有「要驗什麼」的 acceptance 清單，tour 作者只能從
// requirements 自由發揮寫斷言 → 品質浮動（有的驗存檔值、有的只驗一格存在）。
// 這組測試釘住「兩支 analysis agent 都必須產出 acceptance 欄位與撰寫指引」，
// 一旦有人手滑刪掉，紅燈即現。
describe('SD acceptance 驗收點導入', () => {
  beforeEach(() => invalidate()); // 清 mtime 快取，確保讀到當前檔案內容

  test.each(['analysis-project', 'analysis-basic'])(
    '%s 的 SD 格式含 acceptance 欄位與撰寫規則',
    (name) => {
      const body = loadAgent(name).body;
      expect(body).toMatch(/acceptance:/);   // schema 內有此欄
      expect(body).toContain('可觀察');       // 有「寫可觀察結果」的指引
    }
  );
});
