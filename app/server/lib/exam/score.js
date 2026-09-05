// 每個選項一個推薦分數，一題加起來剛好 100。
//
// 為什麼放後端：這是邏輯不是排版。放在 View 檔裡就只能靠正則把函式挖出來測
// （或乾脆不測），而這個公式最容易寫反——反了之後畫面照樣顯示得好好的，
// 只是每一題都推薦錯的那個選項。
//
// ── 唯一可信的輸入 ───────────────────────────────────────────────────
// c = 該題的信心度（官方題固定 100，其餘取 exam_items.confidence，
//     那個數字已被過去考試的官方章節成績校準過，見 confidence.js）。
//
// ⚠ c 的定義是「**你填的那個答案**正確的機率」，不是「審查有多確定」。
//   分層表：推翻＋原始碼佐證 = 30／推翻但講不出根據 = 45／
//           沒推翻＋原始碼 = 92／沒推翻＋文件 = 85／沒推翻＋無證據 = 80。
//   所以 c 越低代表審查越有把握你錯了。把 c 直接掛到審查主張的選項上會整個反過來。
//
// ── 為什麼其餘選項是 3 分而不是 0 ────────────────────────────────────
// 「你錯 ＋ 審查也錯」真的會發生：實測那 120 題，官方說錯 15 題但審查只推翻 8 題，
// 剩下 7 題是兩邊一起錯、正解是沒人提到的第三個選項。給 0 分等於宣稱那些選項
// 不可能，而沒有任何人驗證過——更糟的是看到 0 就完全不會再去看它。
//
// 底座是常數而不是可調參數，所以「審查越有把握、它主張的那個分數越高」是自動的：
//   c=30 → 審查主張的拿 64；c=45 → 只拿 49（正確反映「這題真的難講」）。
const SCORE_FLOOR = 3;

const has = (arr, letter) => Array.isArray(arr) && arr.includes(letter);

// 分數是機率分佈，一題必須剛好加起來 100。四捨五入的餘數補給最高的那個，
// 不然畫面上會出現 99 或 101，看起來像算錯。
function normalize100(raw) {
  const keys = Object.keys(raw);
  const total = keys.reduce((s, k) => s + raw[k], 0);
  if (!(total > 0)) return null;
  const out = {};
  let sum = 0, top = keys[0];
  for (const k of keys) {
    out[k] = Math.round(raw[k] * 100 / total);
    sum += out[k];
    if (out[k] > out[top]) top = k;
  }
  out[top] += 100 - sum;
  return out;
}

/**
 * @param {object}   a
 * @param {string[]} a.letters        這題的選項字母
 * @param {string}   a.qtype          'single' / 'multi'
 * @param {string}   a.reviewSource   'official' / 'review' / null
 * @param {string[]} a.reviewAnswer   官方答案或審查主張的答案
 * @param {number}   a.confidence     見上方 c 的說明
 * @param {string[]} a.mine           你這次的最終作答（沒拍板就是輸入答案）
 * @param {Array}    a.wrongAnswers  已**證明**答錯的作答（deduce.js 解聯立推出來的）
 * @returns {object|null} { 字母: 分數 }，算不出來回 null
 */
function optionScores({
  letters = [], qtype = 'single', reviewSource = null, reviewAnswer = null,
  confidence = null, mine = null, wrongAnswers = null,
} = {}) {
  if (!Array.isArray(letters) || !letters.length) return null;
  // 複選題可以同時對兩個，機率分佈的語意不成立，硬套單選的算法會誤導
  if (qtype === 'multi') return null;
  const ans = Array.isArray(reviewAnswer) ? reviewAnswer.filter(Boolean) : [];
  if (!reviewSource || !ans.length) return null;

  const out = {};

  // 官方確認是硬事實，不參與任何分配
  if (reviewSource === 'official') {
    for (const L of letters) out[L] = has(ans, L) ? 100 : 0;
    return out;
  }

  if (!Number.isFinite(confidence)) return null;
  const c = Math.max(0, Math.min(100, confidence));
  const A = Array.isArray(mine) && mine.length ? mine[0] : null;
  const R = ans[0];
  const n = letters.length;
  const floorFor = k => SCORE_FLOOR * Math.max(k, 0);

  if (A && letters.includes(A) && R === A) {
    // 審查同意你：剩下的平分——沒有任何線索指向其餘哪一個
    const rest = n > 1 ? (100 - c) / (n - 1) : 0;
    for (const L of letters) out[L] = L === A ? c : rest;
  } else if (A && letters.includes(A)) {
    // 審查推翻你：你的答案拿 c，審查主張的拿剩下扣掉底座的部分
    for (const L of letters) out[L] = SCORE_FLOOR;
    out[A] = c;
    if (letters.includes(R)) out[R] = Math.max(SCORE_FLOOR, 100 - c - floorFor(n - 2));
  } else {
    // 沒作答（或作答的字母不在選項裡）：c 沒有對應的選項可掛，只認得審查主張的那個
    for (const L of letters) out[L] = SCORE_FLOOR;
    if (letters.includes(R)) out[R] = Math.max(SCORE_FLOOR, 100 - floorFor(n - 1));
  }

  // 已**證明**答錯的選項歸零，分數讓給其他選項。
  //
  // 這批是 deduce.js 從各場考試的官方章節錯題數解聯立推出來的，不是猜的：
  // 「第二場 Sales 全對 ⇒ q1 q2 對 ⇒ 第一場那一題錯的只能是 q3」。
  // 所以這裡敢給 0——與下面那個被拿掉的人工勾選是完全不同等級的證據。
  for (const w of (Array.isArray(wrongAnswers) ? wrongAnswers : [])) {
    if (Array.isArray(w) && w.length === 1 && out[w[0]] != null) out[w[0]] = 0;
  }

  // ⚠ 這裡**刻意不使用** history_wrong（人工勾的「上次答案大概率錯」）。
  //
  // 那個勾長在題庫頁的詳情裡，而詳情顯示的就是審查的意見與信心度——人是看著
  // 審查勾的，所以它沒有帶進任何新資訊，只是審查意見的複述。拿它去改分數等於
  // 把同一個 AI 判斷算兩次：數字看起來更確定，但沒有變得更準。
  //
  // 它只有在來源是「審查以外」時才可信（例如拿到成績單後自己推出是哪一題），
  // 但兩種勾法存進 DB 長得一模一樣，系統分不出來。使用者 2026-09-05 拍板拿掉。
  //
  // 真正獨立的舊經驗有兩條，都已經在公式裡：
  //   1. answer_official／certain——來自官方成績單「這章全對」，AI 沒有參與
  //   2. c 本身被章節結果校準過（官方說某章錯 k 題，整章風險被拉回 k）
  return normalize100(out);
}

module.exports = { optionScores, normalize100, SCORE_FLOOR };
