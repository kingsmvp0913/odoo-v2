// 信心度＝「最終作答是正確的」的機率。
//
// 不是「模型有多確定」，也不是「兩輪一致與否」——是這題會不會拿到分數。
//
// 兩層：
//   1. baseConfidence  分層，每一層說得出理由
//   2. calibrateSection 用官方章節結果把整章的風險總和拉回官方講的錯題數
//
// 刻意**不做**「訊號 × 權重相加」的公式。沒有校準資料時那種數字是假的——看起來
// 像機率，其實是拍腦袋。原專案的風險倍數自己就承認「是啟發式，不是校準出來的，
// 而且已知會誤報」。分層至少每一格都答得出「為什麼是這個數字」。

// 多次審查都沒推翻，最多加這麼多。刻意小氣：同一個模型審兩次不是兩個獨立意見
// （實測模型非決定性約 2–3 題／120 題，它會重複自己的錯誤），把「審兩次都沒
// 推翻」當強證據是自己騙自己。
const AGREE_BONUS_MAX = 3;

// 非官方來源的上限。100 專屬於官方確認，否則 /api/exam/lookup 的「只回 100%」
// 就失去意義——那條規則是使用者拍板的，唯一能走捷徑直接回答的門檻。
const NON_OFFICIAL_CAP = 99;

// 取證後自評仍低於這個數＝兩邊都沒站穩，不能因為「沒推翻」就當成有把握。
const SHAKY_BELOW = 70;

function firstRef(evidence, kind) {
  const hit = (evidence || []).find(e => e && e.kind === kind);
  return hit ? hit.ref : null;
}

function baseConfidence({ certain, hasOfficial, verdict, evidence, agreeCount = 0 } = {}) {
  // 官方確認是硬事實，優先於任何審查結果。審查在官方確定的題上也錯過
  // （原文件實測：47 題確定的題目裡判題自己錯 2 題），不該讓它蓋掉官方。
  if (certain || hasOfficial) return { confidence: 100, why: '官方確認正確' };

  if (!verdict) return { confidence: null, why: '尚未審查' };

  const srcRef = firstRef(evidence, 'source');
  const docRef = firstRef(evidence, 'docs');
  const said = Array.isArray(verdict.correct_answer) ? verdict.correct_answer.join('、') : '';

  if (verdict.refuted) {
    // 被推翻的題不因為審過很多次而加分——重複的懷疑不是新證據
    return srcRef
      ? { confidence: 30, why: `審查認為應該選 ${said}，${srcRef} 佐證` }
      : { confidence: 45, why: `審查認為應該選 ${said}，但講不出根據` };
  }

  let base, why;
  if (Number.isFinite(verdict.confidence) && verdict.confidence < SHAKY_BELOW) {
    base = 60; why = '審查沒推翻，但它自己也沒把握';
  } else if (srcRef) {
    base = 92; why = `審查推不翻，${srcRef} 佐證`;
  } else if (docRef) {
    base = 85; why = '審查推不翻，官方文件佐證';
  } else {
    base = 80; why = '審查推不翻，但沒找證據';
  }

  const bonus = Math.min(Math.max(agreeCount - 1, 0), AGREE_BONUS_MAX);
  const confidence = Math.min(base + bonus, NON_OFFICIAL_CAP);
  return { confidence, why: bonus ? `${why}（審過 ${agreeCount} 次都沒推翻）` : why };
}

// 官方說某章 n 題錯 k 題是硬事實，所以該章所有題的風險（＝100 減信心）加起來
// 必須恰好等於 k。分層算完之後等比縮放到對上這個數字。
//
// 好處：不管分層表準不準，整份題庫的預期錯題數永遠等於官方講的數字
// （原專案實測有效：風險總和 15.0 = 官方說的 15 題）。
//
// items 就地修改。回傳 {scaled, note}——scaled 是實際參與縮放的題數。
function calibrateSection(items, { incorrect } = {}) {
  const list = Array.isArray(items) ? items : [];

  // 沒有官方章節結果＝沒有可校準的總量。硬給一個縮放係數只會讓人以為
  // 那是機率。數字維持原樣，介面上標「未校準」（規格 §6.6）。
  if (incorrect == null) {
    return { scaled: 0, note: '未校準（沒有官方章節結果）' };
  }

  // certain 不參與縮放：它是硬事實，被縮放等於承認它可能錯。
  // 未作答的題也排除：它沒有「答對的機率」可言。
  // 還沒審查（confidence 為 null）的同樣排除，沒有數字可縮放。
  const scalable = list.filter(i =>
    i && !i.certain && i.answered !== false && Number.isFinite(i.confidence));

  const rawRisk = scalable.reduce((s, i) => s + (100 - i.confidence) / 100, 0);

  // 兩種情況語意相同，都是「官方說有錯，但找不到任何風險可以分配給誰」：
  //   a. 整章的題不是 certain 就是未作答／未審查（scalable 為空）
  //   b. 有可縮放的題，但每一題都被判滿分（rawRisk 為 0）
  // 硬縮放會除以零，給個假數字則等於假裝沒事。一律具名回報讓人去看。
  if (!scalable.length || rawRisk === 0) {
    if (incorrect > 0) {
      return { scaled: 0, note: `官方說錯 ${incorrect} 題，但這章找不到可分配風險的題——對不上，未校準` };
    }
    for (const i of scalable) i.calibrated = true;
    return { scaled: scalable.length, note: '' };
  }

  const scale = incorrect / rawRisk;
  for (const i of scalable) {
    const risk = ((100 - i.confidence) / 100) * scale;
    i.confidence = Math.round(Math.max(0, Math.min(100, 100 - risk * 100)));
    i.calibrated = true;
  }
  return { scaled: scalable.length, note: '' };
}

module.exports = { baseConfidence, calibrateSection, AGREE_BONUS_MAX, NON_OFFICIAL_CAP };
