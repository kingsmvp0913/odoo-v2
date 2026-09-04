// gettext .po 檔解析。只做這件事——不碰檔案系統、不碰 DB，所以測得快也測得準。
//
// 不引第三方套件：需求單純（msgid/msgstr 成對 + 續行 + 跳脫），加依賴不划算。

const HEAD = /^(msgid|msgid_plural|msgstr(?:\[\d+\])?)\s+"(.*)"$/;
const CONT = /^"(.*)"$/;

function unescapePo(s) {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
          .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// 狀態機的關鍵：遇到新的 msgid/msgstr 開頭時**先結算上一段**。
// 只在空行結算的版本會漏掉 msgid 直接接 msgstr 的情況（po 檔的常態），
// 結果是抽出 0 條而且完全不報錯——這種靜默失敗最難發現。
function parsePo(content) {
  const out = [];
  let cur = null, buf = [], msgid = null;

  const flush = () => {
    if (cur === null) return;
    const val = unescapePo(buf.join(''));
    if (cur === 'msgid') msgid = val;
    // msgid 或 msgstr 任一為空都不收：前者是檔頭的 metadata 區塊，
    // 後者是尚未翻譯的條目，都不是有效的對照。
    else if (cur.startsWith('msgstr') && msgid && val) out.push({ msgid, msgstr: val });
    cur = null; buf = [];
  };

  for (const raw of String(content || '').split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    const h = HEAD.exec(line);
    if (h) { flush(); cur = h[1]; buf = [h[2]]; continue; }
    const c = CONT.exec(line);
    if (c && cur !== null) { buf.push(c[1]); continue; }
    flush();
  }
  flush();
  return out;
}

// 只要術語不要整句翻譯，也不要虛詞。
//
// 第一版只擋長度與標點，結果收進 `the→於`、`can→罐`、`g→克`、`in→:`、`A→A`
// 這類垃圾。實跑一頁時它們塞爆了 prompt（75 個「術語」大半是虛詞），還讓
// 「譯文有沒有用官方譯法」的檢查報出一長串假的沒對上。
//
// 四條加嚴，每條都對應一類實際看到的垃圾：
function isTerm(msgid, msgstr) {
  const k = String(msgid == null ? '' : msgid).trim();
  const v = String(msgstr == null ? '' : msgstr).trim();
  if (!k || !v) return false;
  if (k.length > 60) return false;
  if (k.includes('\n') || v.includes('\n')) return false;
  if (k.includes('.')) return false;   // 句號 = 整句話
  if (k.includes('%')) return false;   // 格式化字串，不是術語

  // 1. 太短的不是術語：擋掉 A／B／g／in／an
  if (k.length < 3) return false;

  // 2. 首字必須是大寫英文字母。Odoo 的 UI 術語是 Title Case（Sales Order、
  //    Delivery Orders），畫面上印的也是那個形。全小寫的 the／can／create
  //    是句子裡的字，不是使用者看得到的標籤。
  if (!/^[A-Z]/.test(k)) return false;

  // 3. 譯文必須含中文。擋掉 Dashboard→Dashboard、odoo→odoo 這種「翻了等於沒翻」，
  //    以及 in→: 這種譯成標點的壞資料。
  if (!/[一-鿿]/.test(v)) return false;

  // 4. 譯文與原文相同的不算對照，沒有任何資訊量。
  if (k === v) return false;

  return true;
}

module.exports = { parsePo, isTerm };
