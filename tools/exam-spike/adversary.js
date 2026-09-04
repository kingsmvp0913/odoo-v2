// 對立審查 spike——規格 §13.1 的基準驗證用，不是正式程式碼。
//
// 與 judge.js 的差別只有一個：judge 不知道作答者的答案（盲判），這支知道，
// 而且任務是「找出它為什麼錯」。方向相反，所以舊的「污染實測」打不到這裡；
// 但它有自己的未知失效模式（對答對的題硬找碴），那正是本 spike 要量的東西。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TIMEOUT_MS = parseInt(process.env.EXAM_JUDGE_TIMEOUT_MS || '180000', 10);
const MODEL = process.env.EXAM_JUDGE_MODEL || 'opus';

// 空的 MCP 設定：不加 --strict-mcp-config 的話子行程會繼承環境 MCP，
// 其中可能包含 claude-in-chrome——等於放一支無人監督的 claude 去操作瀏覽器。
const MCP_DIR = path.join(__dirname, 'mcp');
const MCP_CONFIG = path.join(MCP_DIR, 'none.json');
fs.mkdirSync(MCP_DIR, { recursive: true });
if (!fs.existsSync(MCP_CONFIG)) fs.writeFileSync(MCP_CONFIG, '{"mcpServers":{}}');

// 子行程的工作目錄必須在本專案之外：claude CLI 會載入 cwd 及每一層父目錄的
// CLAUDE.md。不隔離的話平台的 CLAUDE.md 與 .claude/rules/always.md 整份進入
// 審查 context。實測踩過：子行程一字不差引用了當時檔案裡的題號清單。
const REVIEW_CWD = path.join(os.tmpdir(), 'odoo-exam-review-cwd');
fs.mkdirSync(REVIEW_CWD, { recursive: true });

// 三個判題陷阱段落與 judge.js 逐字相同。
// 拿掉它去跟盲判的 28/30 比較，比的就是兩個變數（prompt 內容 + 任務方向），
// 得不出「對立審查本身好不好」的結論。
const TRAPS = `下面三類是實測栽過的陷阱（30 題錯 4 題，全部落在這三類），審到類似題型要停一下：
   - **方向性直覺**：Customer Location 是售出商品的「目的地」，貨流**進**它，庫存為**正**；Vendor Location
     才是負。「貨離開公司所以是負」是錯的直覺。看圖判補貨方式同理要看形狀——MTS 走訂購規則補到**固定**
     Max、再由銷售**斜線**消耗；補貨水位每次不同又垂直掉回基線的**方波**是 MTO。
   - **"All of the above" 不要因為「不夠精確」就排除**：題目問「哪些會被納入」時，只要各選項各自為真，
     答案就是 All of the above。挑「機制上最精確的那一個」是在回答另一個問題。
   - **搜尋列 facet**：同一個 facet 內的多個值（顯示時用 or 連接）是 OR；**分開的兩個 facet 是 AND，
     即使欄位相同**——Add Custom Filter 每次新增都是一個新群組。`;

function buildPrompt({ imagePath, theirAnswers }) {
  const answerLines = theirAnswers
    .map((ls, i) => `第 ${i + 1} 題：${ls.join('、') || '(未作答)'}`)
    .join('\n');

  return `你是 Odoo 19 認證題目的對立審查員。

截圖路徑：${imagePath}

作答者在這一頁的答案：
${answerLines}

**一張截圖通常含有多題**（Odoo 認證的一頁是一個章節，常見 3 題，每題 4 個選項且最後一個是
"I don't know"）。要把畫面上**每一題**都審過，不是只審第一題。

## 你的任務

不是重新作答，而是**找出作答者的答案為什麼是錯的**。認真找，不要客氣。

但如果你確實找不到某一題的任何問題，就把 refuted 設為 false，並在 reason 說明那個答案
為什麼站得住腳。**不要為了完成任務而編造理由**——編造出來的反證比不審查更糟，它會讓
真正該看的題被淹沒。

截圖上可能有已勾選的選項，那與上面給你的作答者答案是同一件事，不構成額外資訊。

步驟：

1. 用 Read 讀取上面那張截圖，由上而下取出**所有**題目的完整題幹與所有選項。
2. 完整性檢查——截圖被裁切、選項不全、或讀不出任何題目時不要猜，把 readable 設為 false
   並說明缺什麼。只有部分題目被裁掉時 readable 仍為 true，讀得到的照常審，在 note 說明。
3. 逐題審查作答者的答案。注意否定詞（NOT／EXCEPT／不正確）與版本差異。

   ${TRAPS}

只輸出一個 json 區塊，前後不要有任何其他文字：

\`\`\`json
{
  "readable": true,
  "page": "3",
  "note": "",
  "questions": [
    {
      "no": 1,
      "question": "題幹一句話摘要",
      "type": "single",
      "their_answer": ["B"],
      "refuted": false,
      "correct_answer": ["B"],
      "confidence": 92,
      "reason": "找不到反證的理由，或推翻的具體依據"
    }
  ]
}
\`\`\`

欄位說明：

- their_answer：把上面告訴你的作答者答案照抄回來，用來確認題號對齊。
- refuted：true 代表你認為這個答案是錯的。
- **correct_answer 一律必填**：refuted 為 false 時填與 their_answer 相同的值；
  refuted 為 true 時填你認為的正解。一律是選項字母（A／B／C／D，最上面的是 A），
  **不可以填選項的文字內容**——回 ["No"]、["True"]、["15"] 這種形狀是錯的，
  那種答案沒辦法拿去比對，會靜靜地變成一筆對不上的資料。
- confidence：0-100 的整數，你對自己這一題判斷的信心。信心不足就給低分，不要灌水。
- reason：一句到三句。推翻時要講出具體矛盾在哪，不是「我覺得 D 比較好」。
- note（最外層）：整頁層級的問題。沒有就空字串。
- readable 為 false 時 questions 給空陣列，note 寫讀不到的原因。`;
}

// 從 assistant 全文抓「最後一組」json 區塊：agent 可能先講解再給結果，
// 取最後一組最接近最終結論。
function extractJson(text) {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates = fences.map(m => m[1]);
  if (!candidates.length) {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { return JSON.parse(candidates[i]); } catch { /* 試下一組 */ }
  }
  return null;
}

// 模型回傳的形狀會漂（實測拿到過單一物件、裸陣列、契約格式三種），
// 一律壓成同一種再往下傳。
function normalize(raw, theirAnswers) {
  const one = (q, i) => ({
    no: Number(q?.no) || i + 1,
    question: q?.question || '',
    type: q?.type === 'multi' ? 'multi' : 'single',
    their_answer: Array.isArray(q?.their_answer)
      ? q.their_answer.map(a => String(a).trim().toUpperCase())
      : (theirAnswers[i] || []),
    refuted: q?.refuted === true,
    correct_answer: Array.isArray(q?.correct_answer)
      ? q.correct_answer.map(a => String(a).trim().toUpperCase())
      : [],
    confidence: Number.isFinite(Number(q?.confidence)) ? Number(q.confidence) : null,
    reason: q?.reason || '',
  });

  if (Array.isArray(raw)) {
    return { readable: true, page: '', note: '', questions: raw.map(one) };
  }
  if (Array.isArray(raw?.questions)) {
    return {
      readable: raw.readable !== false,
      page: (raw.page || '').toString(),
      note: raw.note || '',
      questions: raw.questions.map(one),
    };
  }
  return {
    readable: raw?.readable !== false,
    page: (raw?.page || '').toString(),
    note: raw?.note || '',
    questions: raw?.readable === false ? [] : [one(raw, 0)],
  };
}

function reviewPage({ imagePath, theirAnswers, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      // 只給 Read：審查階段不取證（取證是規格 §6.4 的第二次呼叫，額外給 Grep）。
      '--allowed-tools', 'Read',
      '--strict-mcp-config', '--mcp-config', MCP_CONFIG,
      '--model', MODEL,
    ];

    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: REVIEW_CWD });
    // 子行程提早死掉時對已關閉的 stdin 寫入會發 EPIPE；無 handler 會變 uncaughtException。
    child.stdin.on('error', () => {});

    let assistantText = '', lineBuffer = '', stderr = '', usage = null, settled = false;

    const finish = fn => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      finish(() => reject(new Error(`審查逾時（${Math.round(TIMEOUT_MS / 1000)}s）`)));
    }, TIMEOUT_MS);

    child.stdout.on('data', d => {
      lineBuffer += d.toString();
      let nl;
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, nl).trim();
        lineBuffer = lineBuffer.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const blk of ev.message.content) {
            if (blk.type === 'text' && blk.text) assistantText += blk.text;
            if (blk.type === 'tool_use') onProgress?.('讀取截圖…');
          }
        }
        if (ev.type === 'result') usage = ev.usage || null;
      }
    });

    child.stderr.on('data', d => { stderr += d.toString(); });

    child.stdin.write(buildPrompt({ imagePath, theirAnswers }));
    child.stdin.end();

    child.on('error', err => {
      if (err.code === 'ENOENT') err.message = '找不到 claude 執行檔（PATH 未含 claude 安裝目錄）';
      finish(() => reject(err));
    });

    child.on('close', code => {
      finish(() => {
        if (code !== 0) return reject(new Error(stderr.trim() || `claude 結束於 exit code ${code}`));
        const raw = extractJson(assistantText);
        if (!raw) return reject(new Error(`審查輸出無法解析：${assistantText.slice(0, 200) || '(空輸出)'}`));
        resolve({ verdict: normalize(raw, theirAnswers), usage });
      });
    });
  });
}

module.exports = { reviewPage, extractJson, buildPrompt, normalize, MODEL };
