const emb = require('../lib/embedding');

afterAll(() => emb._resetForTesting());

// 相似度用內積：worker 那側已經 normalize，所以 cosine 等於內積。這支測的是「等於」成立，
// 以及正規化前提被破壞時不會靜默算出漂亮的錯數字。
describe('similarity', () => {
  test('同一個向量的相似度是 1，正交向量是 0', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(emb.similarity(a, a)).toBeCloseTo(1, 6);
    expect(emb.similarity(a, b)).toBeCloseTo(0, 6);
  });

  test('方向相同才算相近：夾角越大分數越低', () => {
    const q = new Float32Array([1, 0]);
    const near = new Float32Array([Math.SQRT1_2, Math.SQRT1_2]);   // 45°
    const far = new Float32Array([-1, 0]);                          // 180°
    expect(emb.similarity(q, near)).toBeGreaterThan(emb.similarity(q, far));
    expect(emb.similarity(q, far)).toBeCloseTo(-1, 6);
  });
});

// 向量存 base64 TEXT（不用 BYTEA：pg-mem 下 Buffer 往返不保證一致）。這條路徑每一個 chunk
// 都會走，錯了不會報錯、只會讓檢索結果變成噪音——而噪音看起來跟「模型效果不好」一模一樣。
describe('encodeVector / decodeVector', () => {
  test('384 維往返後逐位保真', () => {
    const v = new Float32Array(384);
    for (let i = 0; i < 384; i++) v[i] = Math.sin(i) / 20;
    const back = emb.decodeVector(emb.encodeVector(v));
    expect(back.length).toBe(384);
    for (let i = 0; i < 384; i++) expect(back[i]).toBeCloseTo(v[i], 6);
  });

  // Buffer.from(str,'base64') 會從 Node 的 buffer pool 切一段，byteOffset 不保證是 4 的倍數。
  // 直接拿 buf.buffer 建 Float32Array 會在某些 offset 上丟 RangeError，或更糟——讀到別人的
  // 位元組。連續解碼多筆才撞得到，單筆往返一路綠燈也證明不了什麼。
  test('連續解碼多筆仍正確（不受 Buffer pool 的 byteOffset 影響）', () => {
    const vs = [];
    for (let n = 0; n < 50; n++) {
      const v = new Float32Array(384);
      for (let i = 0; i < 384; i++) v[i] = (n + 1) * 0.001 + i * 0.0001;
      vs.push(v);
    }
    const encoded = vs.map(emb.encodeVector);
    encoded.forEach((b64, n) => {
      const back = emb.decodeVector(b64);
      expect(back.length).toBe(384);
      expect(back[0]).toBeCloseTo(vs[n][0], 6);
      expect(back[383]).toBeCloseTo(vs[n][383], 6);
    });
  });

  test('解碼出來的向量算相似度時仍是 1（往返不影響排序）', () => {
    const v = new Float32Array(384).fill(1 / Math.sqrt(384));
    const back = emb.decodeVector(emb.encodeVector(v));
    expect(emb.similarity(back, back)).toBeCloseTo(1, 5);
  });
});

// 測試一律用 stub，不載入真實模型（130 MB ＋ 網路相依）。這支順便確認注入機制本身有效——
// 注入失效的症狀是測試偷偷去下載模型，慢到讓人以為是 pg-mem 卡住。
describe('_setEmbedderForTesting', () => {
  test('注入後 embedQuery 走 stub、且自動視為就緒', async () => {
    emb._setEmbedderForTesting(texts => texts.map(() => new Float32Array([1, 0, 0])));
    expect(emb.isReady()).toBe(true);
    const v = await emb.embedQuery('任何字串');
    expect(Array.from(v)).toEqual([1, 0, 0]);
  });

  test('e5 前綴由門面自己加，呼叫端無從漏掉', async () => {
    const seen = [];
    emb._setEmbedderForTesting(texts => { seen.push(...texts); return texts.map(() => new Float32Array([1])); });
    await emb.embedQuery('庫存沒扣');
    await emb.embedPassages(['維修單過帳', '領料規則']);
    expect(seen).toEqual(['query: 庫存沒扣', 'passage: 維修單過帳', 'passage: 領料規則']);
  });

  test('還原後不再視為就緒（避免髒狀態外洩到別的測試）', () => {
    emb._setEmbedderForTesting(null);
    expect(emb.isReady()).toBe(false);
  });
});
