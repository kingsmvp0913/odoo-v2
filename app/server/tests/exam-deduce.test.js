const { propagate, buildConstraints, factKey } = require('../lib/exam/deduce');

// 這支推出來的結論會被拿去把答案永久鎖成正解（歸檔不可逆），所以每一條
// 都必須是證明。推錯一個就是把錯的答案鎖起來，而且之後再也不會被審查。

const F = (id, ans) => factKey(id, ans);

describe('propagate', () => {
  test('這章 0 題錯 → 全部是對的（現行系統唯一用到的那一種）', () => {
    const r = propagate([{ key: 'Sales', facts: ['a', 'b', 'c'], wrong: 0 }]);
    expect(r.learned.correct.sort()).toEqual(['a', 'b', 'c']);
    expect(r.learned.wrong).toEqual([]);
  });

  // 跟 k=0 一樣確定，只是方向相反。現行系統完全沒用這一種。
  test('這章全錯 → 全部是錯的', () => {
    const r = propagate([{ key: 'MRP', facts: ['a', 'b'], wrong: 2 }]);
    expect(r.learned.wrong.sort()).toEqual(['a', 'b']);
  });

  test('錯 1 題但三題都未知 → 推不出東西（不能亂猜）', () => {
    const r = propagate([{ key: 'Sales', facts: ['a', 'b', 'c'], wrong: 1 }]);
    expect(r.learned).toEqual({ correct: [], wrong: [] });
  });

  // 這是整支的價值所在：跨考次消去。
  // 第一次考 Sales{a,b,c} 錯 1；第二次考 Sales{a,b,d} 錯 0
  //   → 第二場推出 a、b、d 都對
  //   → 回頭套第一場：a、b 已知對 ⇒ 那一題錯的只可能是 c
  test('靠別場考試消去，推出單獨一題錯', () => {
    const r = propagate([
      { key: '第一場／Sales', facts: ['a', 'b', 'c'], wrong: 1 },
      { key: '第二場／Sales', facts: ['a', 'b', 'd'], wrong: 0 },
    ]);
    expect(r.learned.correct.sort()).toEqual(['a', 'b', 'd']);
    expect(r.learned.wrong).toEqual(['c']);
    expect(r.contradictions).toEqual([]);
  });

  test('反過來：已知的錯題湊滿了，剩下的全部是對的', () => {
    const r = propagate(
      [{ key: 'Project', facts: ['a', 'b', 'c', 'd'], wrong: 2 }],
      { a: 'wrong', b: 'wrong' });
    expect(r.learned.correct.sort()).toEqual(['c', 'd']);
  });

  // 一輪推完會解鎖下一輪，要一直跑到沒有新結論
  test('連鎖推導（一輪的結論餵給下一輪）', () => {
    const r = propagate([
      { key: 'S1', facts: ['a', 'b'], wrong: 0 },        // → a,b 對
      { key: 'S2', facts: ['a', 'b', 'c'], wrong: 1 },   // → c 錯
      { key: 'S3', facts: ['c', 'd'], wrong: 1 },        // c 已錯 ⇒ d 對
    ]);
    expect(r.known).toMatchObject({ a: 'correct', b: 'correct', c: 'wrong', d: 'correct' });
  });

  describe('矛盾要停下來具名回報，不能硬推', () => {
    test('已知錯的比官方說的還多', () => {
      const r = propagate([{ key: 'Sales', facts: ['a', 'b'], wrong: 1 }], { a: 'wrong', b: 'wrong' });
      expect(r.contradictions).toHaveLength(1);
      expect(r.contradictions[0]).toMatch(/Sales/);
    });

    test('剩下的題不夠湊出官方說的錯題數', () => {
      const r = propagate([{ key: 'HR', facts: ['a', 'b'], wrong: 2 }], { a: 'correct' });
      expect(r.contradictions[0]).toMatch(/HR/);
    });

    // 兩場考試互相打架時不能各推各的，會把錯的鎖成對的
    test('同一個作答被兩條約束推出相反結果', () => {
      const r = propagate([
        { key: 'A場', facts: ['x'], wrong: 0 },
        { key: 'B場', facts: ['x'], wrong: 1 },
      ]);
      expect(r.contradictions.length).toBeGreaterThan(0);
    });

    test('有矛盾時其他章節仍然推得出來', () => {
      const r = propagate([
        { key: '壞掉的', facts: ['a'], wrong: 5 },
        { key: '正常的', facts: ['b', 'c'], wrong: 0 },
      ]);
      expect(r.contradictions).toHaveLength(1);
      expect(r.learned.correct.sort()).toEqual(['b', 'c']);
    });
  });

  test('沒有約束時什麼都不做', () => {
    expect(propagate([]).learned).toEqual({ correct: [], wrong: [] });
    expect(propagate([{ key: 'x', facts: [], wrong: 0 }]).learned).toEqual({ correct: [], wrong: [] });
    expect(propagate([{ key: 'x', facts: ['a'], wrong: null }]).learned).toEqual({ correct: [], wrong: [] });
  });
});

describe('factKey', () => {
  test('答案順序不影響（複選題 AB 與 BA 是同一個答案）', () => {
    expect(factKey(1, ['B', 'A'])).toBe(factKey(1, ['A', 'B']));
  });
  // 同一題填不同答案是兩件要分別判定的事，混在一起會讓改過答案的題整批推錯
  test('同一題不同答案是不同的事實', () => {
    expect(factKey(1, ['A'])).not.toBe(factKey(1, ['B']));
  });
});

describe('buildConstraints', () => {
  const row = (o) => ({ bank_id: 1, bank_label: '第一場', title: 'Sales', incorrect: 1, ...o });

  test('未作答的題不進方程式（沒答不算對也不算錯）', () => {
    const { constraints } = buildConstraints([
      row({ item_id: 1, answer_final: ['A'] }),
      row({ item_id: 2, answer_final: null }),
    ]);
    expect(constraints[0].facts).toEqual([F(1, ['A'])]);
  });

  test('依 (題庫, 章節) 分組，每組帶自己的錯題數', () => {
    const { constraints } = buildConstraints([
      row({ item_id: 1, answer_final: ['A'] }),
      row({ bank_id: 2, bank_label: '第二場', title: 'Sales', incorrect: 0, item_id: 1, answer_final: ['A'] }),
    ]);
    expect(constraints).toHaveLength(2);
    expect(constraints.map(c => c.wrong)).toEqual([1, 0]);
    // 同一個事實出現在兩組裡——跨考次消去正是靠這個
    expect(constraints[0].facts).toEqual(constraints[1].facts);
  });

  // 已有官方答案時免費送一批已知事實：填對的是 correct、填錯的是 wrong
  test('已知官方答案的題直接判定，填錯的算 wrong', () => {
    const { known } = buildConstraints([
      row({ item_id: 1, answer_final: ['A'], answer_official: ['A'], certain: true }),
      row({ item_id: 2, answer_final: ['B'], answer_official: ['C'], certain: true }),
      row({ item_id: 3, answer_final: ['D'], answer_official: null, certain: false }),
    ]);
    expect(known[F(1, ['A'])]).toBe('correct');
    expect(known[F(2, ['B'])]).toBe('wrong');
    expect(known[F(3, ['D'])]).toBeUndefined();
  });

  test('同一題重複上傳只算一個事實', () => {
    const { constraints } = buildConstraints([
      row({ item_id: 1, answer_final: ['A'] }),
      row({ item_id: 1, answer_final: ['A'] }),
    ]);
    expect(constraints[0].facts).toHaveLength(1);
  });
});

// 端到端：走一次「第一次錯一題不知道是哪題 → 第二次全對 → 推出來」
test('整條劇本：兩場考試推出第一場錯的是哪一題', () => {
  const rows = [
    // 第一場 Sales 三題，官方說錯 1 題
    { bank_id: 1, bank_label: '第一場', title: 'Sales', incorrect: 1, item_id: 10, answer_final: ['A'] },
    { bank_id: 1, bank_label: '第一場', title: 'Sales', incorrect: 1, item_id: 11, answer_final: ['B'] },
    { bank_id: 1, bank_label: '第一場', title: 'Sales', incorrect: 1, item_id: 12, answer_final: ['C'] },
    // 第二場 Sales 三題（其中兩題與第一場同題同答案），官方說 0 題錯
    { bank_id: 2, bank_label: '第二場', title: 'Sales', incorrect: 0, item_id: 10, answer_final: ['A'] },
    { bank_id: 2, bank_label: '第二場', title: 'Sales', incorrect: 0, item_id: 11, answer_final: ['B'] },
    { bank_id: 2, bank_label: '第二場', title: 'Sales', incorrect: 0, item_id: 13, answer_final: ['D'] },
  ];
  const { constraints, known } = buildConstraints(rows);
  const r = propagate(constraints, known);
  expect(r.known[F(12, ['C'])]).toBe('wrong');     // ← 從來沒出現在全對的章節裡
  expect(r.known[F(10, ['A'])]).toBe('correct');
  expect(r.known[F(13, ['D'])]).toBe('correct');
  expect(r.contradictions).toEqual([]);
});
