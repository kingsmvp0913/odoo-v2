const { normalizeSections, matchToPages, toPct, SUM_TOLERANCE } = require('../lib/exam/sections');

// 成績單是一張**只有百分比、沒有題數**的長條圖。題數要用我們自己 DB 裡的
// （每章考幾題本來就是我們寫進去的），相乘才得到錯題數。
// 這些數字會直接變成歸檔面板上的值，而歸檔不可逆——讀不確定的一律略過並具名。

describe('百分比清洗', () => {
  test.each([[90, 90], ['90', 90], ['37.5%', 38], ['  0 ', 0], [62.5, 63]])
    ('%p → %p', (input, want) => expect(toPct(input)).toBe(want));
  test.each([[null], [undefined], ['—'], [''], [{}]])
    ('%p → null', v => expect(toPct(v)).toBeNull());
});

describe('normalizeSections', () => {
  const s = (o) => ({ readable: true, sections: [{ title: 'Sales', correct: 90, partial: 0, incorrect: 10, unanswered: 0, ...o }] });

  test('正常一列全收', () => {
    expect(normalizeSections(s()).sections)
      .toEqual([{ title: 'Sales', correct: 90, partial: 0, incorrect: 10, unanswered: 0 }]);
  });

  test('缺的那一類當 0（圖上沒那根長條）', () => {
    const r = normalizeSections({ readable: true, sections: [{ title: 'Introduction', correct: 100 }] });
    expect(r.sections[0]).toEqual({ title: 'Introduction', correct: 100, partial: 0, incorrect: 0, unanswered: 0 });
  });

  // 四類加起來不是 100 ⇒ 模型看錯欄了。硬用下去會算出錯的錯題數，而那會鎖錯題。
  test('四類加起來偏離 100 太多就整章略過', () => {
    const r = normalizeSections(s({ correct: 90, incorrect: 50 }));
    expect(r.sections).toEqual([]);
    expect(r.skipped[0]).toMatch(/Sales.*140%/);
  });

  // 長條圖只能目測，1/12 = 8.3% 這種值本來就會差一兩個百分點
  test('容差內的誤差要收下', () => {
    expect(normalizeSections(s({ correct: 58, partial: 0, incorrect: 33, unanswered: 8 })).sections)
      .toHaveLength(1);                                   // 合計 99
    expect(SUM_TOLERANCE).toBeGreaterThan(0);
  });

  test('沒有章節名的略過', () => {
    const r = normalizeSections({ readable: true, sections: [{ correct: 100 }] });
    expect(r.skipped).toEqual(['有一列沒有章節名']);
  });

  test('百分比超出範圍就略過', () => {
    expect(normalizeSections(s({ incorrect: 150, correct: 0 })).sections).toEqual([]);
  });

  test('模型說讀不出來就照實傳下去', () => {
    expect(normalizeSections({ readable: false, note: '圖太糊' }))
      .toMatchObject({ readable: false, note: '圖太糊', sections: [] });
  });

  test('模型沒回 JSON 不能當成「零章節」成功', () => {
    expect(normalizeSections(null).readable).toBe(false);
    expect(normalizeSections('oops').readable).toBe(false);
  });
});

describe('matchToPages：百分比 × 我們自己的題數', () => {
  const pages = [
    { page: '1', section: 'Sales', total: 10, answered: 10 },
    { page: '2', section: 'Project', total: 8, answered: 8 },
    { page: '3', section: '', total: 3, answered: 3 },       // 還沒填章節名
  ];

  test('算得出錯題數，大小寫與前後空白不影響', () => {
    const r = matchToPages([{ title: ' sales ', correct: 90, partial: 0, incorrect: 10, unanswered: 0 }], pages);
    expect(r.filled).toEqual([{ page: '1', section: 'Sales', wrong: 1, pct: 10, overflow: false }]);
  });

  // 8 題 × 37.5% = 3。模型讀成 37／38／40 都要得到 3——四捨五入本來就寬容
  test('模型的百分比差幾個點不影響結果', () => {
    for (const pct of [37, 38, 40]) {
      const r = matchToPages([{ title: 'Project', correct: 100 - pct, partial: 0, incorrect: pct, unanswered: 0 }], pages);
      expect(r.filled[0].wrong).toBe(3);
    }
  });

  // 部分給分的題既不算全對也不算全錯，硬歸到任一邊都會讓歸檔鎖錯題
  test('有部分給分的章節不填，交給人自己看', () => {
    const r = matchToPages([{ title: 'Sales', correct: 80, partial: 10, incorrect: 10, unanswered: 0 }], pages);
    expect(r.filled).toEqual([]);
    expect(r.skipped[0]).toMatch(/Sales.*部分給分/);
  });

  // 設計文件 §13.4：一個都對不上時要報錯，不能靜靜寫空的結果一路「成功」到底
  test('對不上的兩邊都要具名回報', () => {
    const r = matchToPages([{ title: 'Inventory', correct: 100, partial: 0, incorrect: 0, unanswered: 0 }], pages);
    expect(r.filled).toEqual([]);
    expect(r.unmatchedPages).toEqual(['Sales', 'Project']);   // 沒章節名的那頁不算
    expect(r.unusedTitles).toEqual(['Inventory']);
  });

  test('算出來的錯題數超過有作答的題數時標 overflow', () => {
    const r = matchToPages([{ title: 'Project', correct: 0, partial: 0, incorrect: 100, unanswered: 0 }],
      [{ page: '2', section: 'Project', total: 8, answered: 4 }]);
    expect(r.filled[0]).toMatchObject({ wrong: 8, overflow: true });
  });
});

// 拿 2026-08-14 那張真實成績單的百分比（由匯入時的標準答案反推）跑一次，
// 逐章比對算出來的錯題數。這是整支的驗收：讀圖的數字對，算出來的題數才會對。
test('真實成績單的 19 章逐章算對，錯題合計 15', () => {
  const truth = [
    ['Introduction', 6, 100, 0, 0, 0], ['Sales', 10, 90, 0, 10, 0],
    ['Survey', 3, 100, 0, 0, 0], ['CRM', 10, 80, 0, 20, 0],
    ['AI', 5, 100, 0, 0, 0], ['Marketing', 3, 100, 0, 0, 0],
    ['Website', 4, 100, 0, 0, 0], ['eCommerce', 4, 75, 0, 25, 0],
    ['Knowledge', 3, 100, 0, 0, 0], ['Project', 8, 63, 0, 38, 0],
    ['Timesheets', 5, 80, 0, 0, 20], ['Accounting', 12, 58, 0, 33, 8],
    ['Spreadsheet', 3, 100, 0, 0, 0], ['HR', 5, 80, 0, 20, 0],
    ['POS', 3, 67, 0, 0, 33], ['Purchase', 8, 100, 0, 0, 0],
    ['Inventory', 10, 90, 0, 10, 0], ['MRP', 12, 83, 0, 17, 0],
    ['Studio', 6, 100, 0, 0, 0],
  ];
  const want = { Sales: 1, CRM: 2, eCommerce: 1, Project: 3, Accounting: 4, HR: 1, Inventory: 1, MRP: 2 };
  const read = truth.map(([title, , correct, partial, incorrect, unanswered]) =>
    ({ title, correct, partial, incorrect, unanswered }));
  const pages = truth.map(([title, n], i) =>
    ({ page: String(i + 1), section: title, total: n, answered: n }));

  const r = matchToPages(read, pages);
  expect(r.filled).toHaveLength(19);
  expect(r.unmatchedPages).toEqual([]);
  for (const f of r.filled) expect(f.wrong).toBe(want[f.section] || 0);
  expect(r.filled.reduce((s, f) => s + f.wrong, 0)).toBe(15);
});
