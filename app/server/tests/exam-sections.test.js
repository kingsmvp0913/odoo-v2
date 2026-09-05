const { normalizeSections, matchToPages, toInt } = require('../lib/exam/sections');

// 讀成績圖的產物會直接變成歸檔面板上的數字，而歸檔不可逆（填 0 就把題永久鎖成
// 正解）。所以「讀不確定的東西」一律略過並具名回報，絕不補一個猜的數字。

describe('數字清洗', () => {
  test.each([[10, 10], ['10', 10], ['80%', 80], ['1,024', 1024], ['  7 ', 7]])
    ('%p → %p', (input, want) => expect(toInt(input)).toBe(want));
  test.each([[null], [undefined], ['—'], [''], [{}], [NaN]])
    ('%p → null', v => expect(toInt(v)).toBeNull());
});

describe('normalizeSections', () => {
  test('正常一列全收', () => {
    const r = normalizeSections({ readable: true, sections: [{ title: 'Sales', total: 10, correct: 9, incorrect: 1 }] });
    expect(r.sections).toEqual([{ title: 'Sales', total: 10, incorrect: 1, correct: 9 }]);
  });

  test('只給 correct 時反推 incorrect', () => {
    const r = normalizeSections({ readable: true, sections: [{ title: 'MRP', total: 12, correct: 10 }] });
    expect(r.sections[0]).toMatchObject({ incorrect: 2 });
  });

  // 沒有題數就換算不出錯題數。編一個進去會被歸檔當成硬事實拿去鎖題。
  test('讀不到題數的整列略過並具名', () => {
    const r = normalizeSections({ readable: true, sections: [{ title: 'CRM', incorrect: 2 }] });
    expect(r.sections).toEqual([]);
    expect(r.skipped).toEqual(['CRM（讀不到題數）']);
  });

  test('沒有章節名的略過', () => {
    const r = normalizeSections({ readable: true, sections: [{ total: 5, incorrect: 0 }] });
    expect(r.sections).toEqual([]);
    expect(r.skipped).toEqual(['有一列沒有章節名']);
  });

  test('錯題數比總題數還多＝讀錯了，略過', () => {
    const r = normalizeSections({ readable: true, sections: [{ title: 'HR', total: 5, incorrect: 7 }] });
    expect(r.sections).toEqual([]);
    expect(r.skipped[0]).toMatch(/HR/);
  });

  test('模型說讀不出來就照實傳下去', () => {
    const r = normalizeSections({ readable: false, note: '圖太糊' });
    expect(r).toMatchObject({ readable: false, note: '圖太糊', sections: [] });
  });

  test('模型沒回 JSON 也不能當成「零章節」成功', () => {
    expect(normalizeSections(null).readable).toBe(false);
    expect(normalizeSections('oops').readable).toBe(false);
  });
});

describe('matchToPages', () => {
  const pages = [
    { page: '1', section: 'Sales', answered: 10, total: 10 },
    { page: '2', section: 'Project', answered: 8, total: 8 },
    { page: '3', section: '', answered: 3, total: 3 },      // 還沒填章節名
  ];

  test('對得上的填進去，大小寫與前後空白不影響', () => {
    const r = matchToPages([{ title: ' sales ', total: 10, incorrect: 1, correct: 9 }], pages);
    expect(r.filled).toEqual([{ page: '1', section: 'Sales', wrong: 1, overflow: false }]);
  });

  // 設計文件 §13.4：一個都對不上時要報錯，不能靜靜寫空的結果一路「成功」到底——
  // 那張圖的 token 白燒，而症狀（題庫裡沒有官方結果）離真因非常遠。
  test('對不上的兩邊都要具名回報', () => {
    const r = matchToPages([{ title: 'Inventory', total: 6, incorrect: 0, correct: 6 }], pages);
    expect(r.filled).toEqual([]);
    expect(r.unmatchedPages).toEqual(['Sales', 'Project']);   // 沒章節名的那頁不算
    expect(r.unusedTitles).toEqual(['Inventory']);
  });

  // 成績圖的題數含未作答，可能比這一場有作答的題多
  test('錯題數超過有作答題數時標 overflow 讓人自己看圖判斷', () => {
    const r = matchToPages([{ title: 'Project', total: 8, incorrect: 5, correct: 3 }],
      [{ page: '2', section: 'Project', answered: 4, total: 8 }]);
    expect(r.filled[0]).toMatchObject({ wrong: 5, overflow: true });
  });
});
