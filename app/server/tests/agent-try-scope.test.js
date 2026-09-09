const { loadAgent, invalidate } = require('../pipeline/agent-loader');

// 意圖（Rule 9）：try 區塊包進不屬於該 except 語意的呼叫，會產生兩種只有使用者才踩得到的缺陷——
// 訊息張冠李戴（錯誤指向錯的操作，無法定位真因）與例外被上層 except 吞成成功回覆。
// 這兩種缺陷 deploy 一定綠燈（程式跑得起來），QA 看 diff 也覺得 try/except 形狀正常，
// 已有三張任務被人工以同一根因退回。coding 要自檢、QA 要照 diff 對照，兩份缺一，那一關就再度全盲。
// 純 prompt 契約、無可執行分支，用靜態守衛釘住三條判準都在。
describe('try/except 涵蓋範圍自查（coding 與 QA 兩關都要有）', () => {
  beforeEach(() => invalidate()); // 清 mtime 快取，確保讀到當前檔案內容

  // 三條判準：try 邊界／訊息歸屬／不得吞成成功。少一條就退化成「形狀對就好」。
  test.each(['coding-project', 'qa'])('%s 帶 try/except 涵蓋範圍的三條判準', (name) => {
    const body = loadAgent(name).body;
    expect(body).toMatch(/try\/except\s*(的)?涵蓋範圍/);   // 有這個檢查項本身
    expect(body).toMatch(/except\s*語意/);                 // ① 邊界＝以 except 語意界定
    expect(body).toMatch(/UserError|_logger/);             // ② 訊息歸屬＝檢查訊息文字
    expect(body).toContain('吞成成功');                     // ③ 不得吞成成功
  });
});
