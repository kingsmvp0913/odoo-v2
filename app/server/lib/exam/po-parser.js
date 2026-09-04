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

// 只要術語不要整句翻譯。門檻是實測調出來的（Odoo 19 全量掃過 409 個檔，
// 這組條件留下約 32,800 條，"Delivery Orders"／"Bill of Materials" 都在裡面）。
function isTerm(msgid, msgstr) {
  const k = String(msgid == null ? '' : msgid).trim();
  const v = String(msgstr == null ? '' : msgstr).trim();
  if (!k || !v) return false;
  if (k.length > 60) return false;
  if (k.includes('\n') || v.includes('\n')) return false;
  if (k.includes('.')) return false;   // 句號 = 整句話
  if (k.includes('%')) return false;   // 格式化字串，不是術語
  return true;
}

module.exports = { parsePo, isTerm };
