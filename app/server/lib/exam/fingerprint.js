// 題幹指紋：跨考次辨認「這是同一題」。
//
// 用最笨的正規化 + sha256，不用向量比對。實測（規格 §5.1）：120 題規模下
// 詞彙重疊的唯一命中率是題幹一字不差 100%、只有後一半 100%、隨機刪 30% 詞 100%。
// 重考是同一份文字，向量檢索解決的「語意相同但用詞不同」問題在此不存在。
const crypto = require('crypto');

// 非英數一律換成空白（不是刪除）——直接刪的話 "multi-company" 會變成
// "multicompany"，而截圖抄成 "multi company" 的那次就對不上了。
// 中文字元保留：英文題幹裡偶爾夾中文標記，抹掉會讓兩題撞成同一個指紋。
function normalizeQuestion(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function fingerprint(text) {
  const norm = normalizeQuestion(text);
  // 空題幹不可以回「空字串的指紋」：那會讓所有讀不出題幹的題合併成同一列，
  // 而症狀（題庫莫名少了很多題）離真因很遠。一律拋錯讓呼叫端處理。
  if (!norm) throw new Error('題幹正規化後是空的，無法產生指紋');
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex');
}

module.exports = { fingerprint, normalizeQuestion };
