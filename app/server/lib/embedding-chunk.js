// 切塊：把一頁 wiki／一份 analysis.yaml 拆成語意上獨立的小段，供 embedding 索引。
//
// 為什麼要切：一頁動輒涵蓋三四個主題，整頁算一個座標等於把它們平均成一個「什麼都沾一點」
// 的位置，誰都搜不準。實測（2026-08-08，28 頁真實 wiki、整頁不切）：查「庫存沒有扣掉」，
// 前三名全是無關的 NAS 排程頁，真正的庫別頁排到第四第五。
//
// 上限取 350 字：multilingual-e5-small 的 max sequence length 是 512 token，中文一字約
// 1–1.5 token，加上前綴與標題路徑後 350 字是安全值。超過會被靜默截斷——不會報錯，只會變難用。

const MAX_CHARS = 350;
const OVERLAP = 50;
const MIN_BODY = 20;   // 正文短於此的塊（多半是只有標題、內容還沒寫）進索引只是噪音

// 每塊都接上「頁面標題 > 各層標題」當前綴：單獨一塊正文常常沒有主詞（「它會失敗」的「它」
// 是什麼？），接上路徑後語意才完整，查詢才對得上。
function withPrefix(pathParts, body) {
  return `${pathParts.join(' > ')}\n\n${body}`;
}

// 長段落再按字數切，相鄰兩塊重疊 OVERLAP 字——答案剛好跨在切點上時才不會被切爛。
function splitLong(body) {
  if (body.length <= MAX_CHARS) return [body];
  const out = [];
  const step = MAX_CHARS - OVERLAP;
  for (let i = 0; i < body.length; i += step) {
    out.push(body.slice(i, i + MAX_CHARS));
    if (i + MAX_CHARS >= body.length) break;
  }
  return out;
}

// 把 [{ pathParts, body }] 攤平成最終的塊，一併做長度切與丟棄判定。
function emit(sections) {
  const chunks = [];
  for (const { pathParts, body } of sections) {
    const trimmed = body.trim();
    if (trimmed.length < MIN_BODY) continue;
    for (const piece of splitLong(trimmed)) {
      chunks.push({ chunkIndex: chunks.length, text: withPrefix(pathParts, piece) });
    }
  }
  return chunks;
}

// markdown 標題天然是主題邊界，先按它切。標題退階時路徑要跟著收，否則第二個 h1 底下的塊
// 會揹著前一個 h1 的子標題，前綴反而變成誤導。
function chunkWikiPage({ title, content }) {
  const sections = [];
  const stack = [];            // 各層標題，index 0 = h1
  let body = [];
  const flush = () => {
    if (body.length) sections.push({ pathParts: [title, ...stack.filter(Boolean)], body: body.join('\n') });
    body = [];
  };
  for (const line of String(content || '').split('\n')) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      stack.length = level - 1;          // 退階：比本層深的一律丟掉
      stack[level - 1] = m[2].trim();
    } else {
      body.push(line);
    }
  }
  flush();
  return emit(sections);
}

// analysis.yaml 的頂層 key 就是主題邊界（models／permissions／acceptance 各自獨立），
// 同理先按它切再按字數切。用縮排判定而非 YAML parse：規格可能寫到一半或格式不完整，
// parse 失敗就整份索引不到，反而比切得不精準更糟。
function chunkAnalysisYaml({ title, yaml }) {
  const sections = [];
  let key = null;
  let body = [];
  const flush = () => {
    if (body.length) sections.push({ pathParts: key ? [title, key] : [title], body: body.join('\n') });
    body = [];
  };
  for (const line of String(yaml || '').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m) {
      flush();
      key = m[1];
      if (m[2].trim()) body.push(m[2].trim());
    } else {
      body.push(line);
    }
  }
  flush();
  return emit(sections);
}

module.exports = { chunkWikiPage, chunkAnalysisYaml, MAX_CHARS, OVERLAP, MIN_BODY };
