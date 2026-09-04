// 作答者答案的解析。
//
// 為什麼需要「先猜題數」：對立審查要在 prompt 裡帶上作答者逐題的答案，但上傳時
// 只有一個自由字串，而**題數要審查完抄下題目才知道**。原專案沒有這個問題，因為
// 它是先盲判（不需要答案）、判完知道題數再解析比對。
//
// 所以這裡反過來：從答案字串本身推題數，審查回來之後再驗證推得對不對，
// 不對就具名標記（`checkCount`）。推錯不會靜靜壞掉。

// 顯式編號：「第 1 題 B」「1. B」「1) B」「Q1: B」。
// 有編號就以編號為準——它比位置可靠，而且對方漏答中間某題時只有編號救得回來。
const NUMBERED = /(?:第\s*)?(\d+)\s*(?:題|[.)、:：])\s*([A-Za-z](?:\s*[,、和及與+]\s*[A-Za-z])*)/g;

const letters = s => [...new Set((String(s).toUpperCase().match(/[A-Z]/g) || []))].sort();

/**
 * 回 { answers: string[][], count: number, note: string }。
 *
 * 不需要事先知道題數——這正是與原專案 `parseAnswer(raw, count)` 的差別。
 */
function parseAnswers(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { answers: [], count: 0, note: '沒有提供答案' };

  // 1. 顯式編號優先
  const byNo = new Map();
  let m, maxNo = 0;
  NUMBERED.lastIndex = 0;
  while ((m = NUMBERED.exec(text)) !== null) {
    const no = parseInt(m[1], 10);
    const ls = letters(m[2]);
    if (no >= 1 && ls.length) { byNo.set(no, ls); maxNo = Math.max(maxNo, no); }
  }
  if (byNo.size) {
    const answers = Array.from({ length: maxNo }, (_, i) => byNo.get(i + 1) || []);
    const missing = answers.map((a, i) => (a.length ? null : i + 1)).filter(Boolean);
    return {
      answers,
      count: maxNo,
      note: missing.length ? `第 ${missing.join('、')} 題沒有對應到答案` : '',
    };
  }

  // 2. 沒有編號的連寫（"BAA"）：一個字母一題，**順序就是題序，不可排序**。
  //    排過的 "BCA" 會變成第一題 A，原專案實測踩過。
  const seq = text.toUpperCase().match(/[A-Z]/g) || [];
  if (!seq.length) return { answers: [], count: 0, note: '看不出任何選項字母' };
  return {
    answers: seq.map(c => [c]),
    count: seq.length,
    note: seq.length === 1 ? '' : '沒有題號，依字母順序當作逐題作答',
  };
}

/**
 * 審查回來後驗證題數推得對不對。
 *
 * 對不上時**不要硬湊**：多的補空、少的截斷都會讓答案錯位，而錯位的症狀是
 * 「某幾題莫名其妙被判不一致」，離真因很遠。一律回報讓人看得到。
 */
function checkCount(parsed, judgedCount) {
  if (!Number.isInteger(judgedCount) || judgedCount < 1) {
    return { ok: false, note: '審查沒有回報任何題目' };
  }
  if (parsed.count === judgedCount) return { ok: true, note: '' };
  return {
    ok: false,
    note: `作答看起來是 ${parsed.count} 題，審查讀出 ${judgedCount} 題——題號可能沒對齊`,
  };
}

/**
 * 把答案對齊到審查讀出的題數。長度不符時**寧可留空也不移位**。
 */
function alignAnswers(parsed, judgedCount) {
  const out = Array.from({ length: Math.max(judgedCount, 0) }, () => []);
  if (parsed.count !== judgedCount) return out;   // 對不上就全部留空，不猜
  for (let i = 0; i < judgedCount; i++) out[i] = parsed.answers[i] || [];
  return out;
}

module.exports = { parseAnswers, checkCount, alignAnswers };
