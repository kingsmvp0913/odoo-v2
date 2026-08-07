const { chunkWikiPage, chunkAnalysisYaml } = require('../lib/embedding-chunk');

// 意圖：一頁 wiki 動輒涵蓋三四個主題。整頁算一個座標＝把不同主題平均成一個「什麼都沾一點」
// 的位置，誰都搜不準（實測：整頁不切時，查「庫存沒有扣掉」前三名全是無關的 NAS 排程頁）。
// 這支測的是切塊的四條規則——它們直接決定檢索品質，而品質本身沒有單元測試測得到。

describe('chunkWikiPage', () => {
  test('按 markdown 標題切開：不同主題不得落進同一塊', () => {
    const chunks = chunkWikiPage({
      title: '維修管理',
      content: '# 過帳流程\n先確認庫別再過帳，過帳後才會產生 stock move 這筆異動。\n# 領料規則\n領料單一定要綁工單，否則不會扣掉庫存數量。',
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toContain('過帳後才會產生');
    expect(chunks[0].text).not.toContain('領料單一定要綁工單'); // 兩個主題不得混在一起
    expect(chunks[1].text).toContain('領料單一定要綁工單');
  });

  // 單獨一塊正文常常沒有主詞（「它會失敗」的「它」是什麼？），接上路徑後語意才完整。
  test('每塊前面接上頁面標題與所屬標題路徑', () => {
    const chunks = chunkWikiPage({
      title: '維修管理',
      content: '# 過帳流程\n## 庫別卡控\n卡控規則是來源庫別必須與工單站別一致才放行。',
    });
    expect(chunks[0].text.startsWith('維修管理 > 過帳流程 > 庫別卡控\n\n')).toBe(true);
  });

  // 標題退階時路徑要跟著收，否則第二個 h1 底下的塊會揹著前一個 h1 的子標題。
  test('標題退階時路徑跟著收回', () => {
    const chunks = chunkWikiPage({
      title: '維修管理',
      content: '# 甲\n## 甲一\n甲一底下的內容要夠長，才不會被當成純標題塊丟掉。\n# 乙\n乙底下的內容也要夠長，一樣不能被當成純標題塊丟掉。',
    });
    expect(chunks[1].text.startsWith('維修管理 > 乙\n\n')).toBe(true);
    expect(chunks[1].text).not.toContain('甲一');
  });

  test('超過 350 字的段落再按字數切，且相鄰兩塊重疊 50 字', () => {
    const body = '甲'.repeat(300) + '乙'.repeat(300);   // 600 字，必須切成兩塊
    const chunks = chunkWikiPage({ title: '長頁', content: `# 大段\n${body}` });
    expect(chunks.length).toBe(2);
    const strip = t => t.split('\n\n')[1];              // 去掉標題路徑前綴，只看正文
    expect(strip(chunks[0].text).length).toBe(350);
    // 重疊：第二塊的開頭 50 字，必須等於第一塊的結尾 50 字——答案剛好跨在切點上時才不會被切爛
    expect(strip(chunks[1].text).slice(0, 50)).toBe(strip(chunks[0].text).slice(-50));
  });

  // 純標題塊（底下還沒寫內容）進索引只會變成噪音——它沒有可檢索的資訊，卻會佔一個座標。
  test('空白塊與正文少於 20 字的純標題塊一律丟棄', () => {
    const chunks = chunkWikiPage({
      title: '頁',
      content: '# 只有標題沒內容\n\n# 待補\n短\n# 有內容\n這一段的正文夠長，應該要被保留下來當成一塊。',
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('這一段的正文夠長');
  });

  test('chunkIndex 從 0 連號，供「先刪後插」時比對', () => {
    const chunks = chunkWikiPage({
      title: '頁',
      content: '# 甲\n甲底下的內容要夠長，才不會被當成純標題塊丟掉。\n# 乙\n乙底下的內容也要夠長，一樣不能被當成純標題塊丟掉。',
    });
    expect(chunks.map(c => c.chunkIndex)).toEqual([0, 1]);
  });

  // 沒有任何標題的頁不能整頁丟掉——早期的 wiki 頁與人工註記常常就是一段純文字。
  test('沒有標題的內容仍切得出塊，前綴只有頁面標題', () => {
    const chunks = chunkWikiPage({ title: '專案備註', content: '這個專案的驗收窗口是王先生，出貨前要先發信給他確認。' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text.startsWith('專案備註\n\n')).toBe(true);
  });

  test('空內容回空陣列，不得回一塊只有前綴的垃圾', () => {
    expect(chunkWikiPage({ title: '空頁', content: '' })).toEqual([]);
    expect(chunkWikiPage({ title: '空頁', content: '   \n\n  ' })).toEqual([]);
  });
});

describe('chunkAnalysisYaml', () => {
  // 規格 yaml 的頂層 key 就是主題邊界（models / permissions / acceptance 各自獨立）。
  test('按 YAML 頂層 key 切，巢狀內容跟著所屬的 key', () => {
    const chunks = chunkAnalysisYaml({
      title: '任務 42：維修單加欄位',
      yaml: 'summary:\n  這張任務要在維修單上加一個保固到期日欄位喔。\nmodels:\n  - name: idx.hj.order\n    fields: 保固到期日 date 欄位一枚\n',
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toContain('保固到期日欄位');
    expect(chunks[0].text).not.toContain('idx.hj.order');
    expect(chunks[1].text).toContain('idx.hj.order');
  });

  test('每塊接上任務標題與所屬 key', () => {
    const chunks = chunkAnalysisYaml({
      title: '任務 42：維修單加欄位',
      yaml: 'permissions:\n  維修人員可以讀寫，其他人只能讀取這張單據的內容。\n',
    });
    expect(chunks[0].text.startsWith('任務 42：維修單加欄位 > permissions\n\n')).toBe(true);
  });
});
