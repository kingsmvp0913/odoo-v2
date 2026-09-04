// 對立審查：拿作答者的答案去找反證，而不是重新盲判一次。
//
// 第 0 期實測（30 題，data/exam/answer-key.json）：
//   對立審查 30/30、假陽性 0/27、每題 10.4s
//   盲判基準 28/30、每頁約 16s
// 三項全贏，所以第一輪盲判退役。詳見 docs/superpowers/specs/2026-09-04-adversary-bench-result.md
//
// 但那個 30/30 有事後諸葛成分：下面 TRAPS 的三條是從那批題的官方錯題反推寫出來的。
// **不可移除**——移掉就不是跑出 30/30 的那支 prompt 了。
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

// 子行程的工作目錄必須在本專案之外，而且**截圖要複製進去、prompt 只給相對檔名**。
//
// 兩個不同的洩漏通道，兩個都要堵：
//   1. claude CLI 會載入 cwd 及每一層父目錄的 CLAUDE.md。不隔離的話平台的
//      CLAUDE.md 與 .claude/rules/always.md 整份進入審查 context。原專案實測：
//      子行程一字不差引用了當時檔案裡的題號清單，整輪作廢。
//   2. `--allowed-tools Read` **不限制 Read 的路徑**。prompt 裡若出現截圖的絕對
//      路徑，agent 就知道 repo 在哪，可以直接 Read data/exam/answer-key.json 或
//      questions.json 的 official 欄位——那正是這台機器最在意的失效模式。
//      給相對檔名，它沒有任何線索指向 repo。
//
// 已知殘留風險：`--dangerously-skip-permissions` 是無人監督自動化的必要條件
// （不加的話每次工具呼叫都停下來等人按同意），所以 Read 在檔案系統層面仍然
// 不受限。要真正的隔離得把子行程放進容器或 chroot，那是另一個層級的工程。
// 目前靠「不給線索」把風險降到可接受，不宣稱它是密不透風的。
function makeRunCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-exam-review-'));
}

const TRAPS = `下面三類是實測栽過的陷阱（30 題錯 4 題，全部落在這三類），審到類似題型要停一下：
   - **方向性直覺**：Customer Location 是售出商品的「目的地」，貨流**進**它，庫存為**正**；Vendor Location
     才是負。「貨離開公司所以是負」是錯的直覺。看圖判補貨方式同理要看形狀——MTS 走訂購規則補到**固定**
     Max、再由銷售**斜線**消耗；補貨水位每次不同又垂直掉回基線的**方波**是 MTO。
   - **"All of the above" 不要因為「不夠精確」就排除**：題目問「哪些會被納入」時，只要各選項各自為真，
     答案就是 All of the above。挑「機制上最精確的那一個」是在回答另一個問題。
   - **搜尋列 facet**：同一個 facet 內的多個值（顯示時用 or 連接）是 OR；**分開的兩個 facet 是 AND，
     即使欄位相同**——Add Custom Filter 每次新增都是一個新群組。`;

// 術語表只塞「這一頁用得到的」。全表塞不進 prompt（Odoo 19 有 32,288 條），
// 而且已知題幹時才查得到——全新題庫第一次讀圖時還不知道題目內容，那時
// glossary 傳空陣列，改由 checkGlossary 事後比對標記。
function glossaryBlock(glossary) {
  const list = (glossary || []).filter(g => g && g.en && g.zh);
  if (!list.length) return '';
  return `
## 這一頁涉及的 Odoo 官方繁中譯法

下面這些詞在翻譯時**必須照這樣翻**，不要自己另外想說法——使用者考試時看到的
Odoo 畫面上印的就是這些字，換個說法就對不上畫面了。

${list.map(g => `- ${g.en} → ${g.zh}`).join('\n')}
`;
}

// imageName 是**相對於子行程 cwd 的檔名**，不是絕對路徑。見上方 makeRunCwd 的說明：
// 絕對路徑會告訴 agent repo 在哪，它就有辦法自己去讀官方答案。
function buildPrompt({ imageName = 'shot.jpg', theirAnswers, glossary }) {
  const answerLines = (theirAnswers || [])
    .map((ls, i) => `第 ${i + 1} 題：${(ls || []).join('、') || '(未作答)'}`)
    .join('\n');

  return `你是 Odoo 19 認證題目的對立審查員。

截圖檔名：${imageName}（就在你的工作目錄下，直接用這個檔名讀）

作答者在這一頁的答案：
${answerLines}

**一張截圖通常含有多題**（Odoo 認證的一頁是一個章節，常見 3 題）。要把畫面上**每一題**都審過。

## 你的任務

不是重新作答，而是**找出作答者的答案為什麼是錯的**。認真找，不要客氣。

但如果你確實找不到某一題的任何問題，就把 refuted 設為 false，並在 reason 說明那個答案
為什麼站得住腳。**不要為了完成任務而編造理由**——編造出來的反證比不審查更糟，它會讓
真正該看的題被淹沒。

截圖上可能有已勾選的選項，那與上面給你的作答者答案是同一件事，不構成額外資訊。

## 順便做的事：逐字抄下題目並翻譯

題幹與**每一個選項**的英文原文要一字不差抄下來，並各給一份繁體中文翻譯。
「答案是 B」在題庫裡沒有意義，因為沒人知道 B 印的是什麼。
${glossaryBlock(glossary)}
## 步驟

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
      "question": "英文題幹一字不差",
      "question_zh": "繁體中文翻譯",
      "type": "single",
      "options": [{ "letter": "A", "text": "英文原文", "text_zh": "繁中翻譯" }],
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

// 只認 A-Z 單一字母。模型在選項印 Yes／No、True／False 時會直接回那個字而不是
// 字母——那不是「兩邊答案不同」，是形狀不對，但它會靜靜變成一筆對不上的資料，
// 錯誤浮現在離真因最遠的地方（原專案實測踩過）。這裡當場擋掉並標記。
function cleanAnswer(arr) {
  const raw = Array.isArray(arr) ? arr.map(a => String(a).trim().toUpperCase()) : [];
  const ok = raw.filter(a => /^[A-Z]$/.test(a));
  const bad = raw.filter(a => !/^[A-Z]$/.test(a));
  return { ok: [...new Set(ok)], bad };
}

// 模型回傳的形狀會漂（實測拿到過單一物件、裸陣列、契約格式三種），
// 一律壓成同一種再往下傳。前端若直接吃原始輸出，遇到裸陣列時 readable 是
// undefined，會掉進「讀不出題目」分支——審查明明成功，真正的問題卻被藏起來。
function normalize(raw, theirAnswers = []) {
  const one = (q, i) => {
    const { ok, bad } = cleanAnswer(q?.correct_answer);
    return {
      no: Number(q?.no) || i + 1,
      question: q?.question || '',
      question_zh: q?.question_zh || '',
      type: q?.type === 'multi' ? 'multi' : 'single',
      options: Array.isArray(q?.options) ? q.options.map(o => ({
        letter: String(o?.letter || '').trim().toUpperCase(),
        text: o?.text || '',
        text_zh: o?.text_zh || '',
      })) : [],
      their_answer: Array.isArray(q?.their_answer) && q.their_answer.length
        ? q.their_answer.map(a => String(a).trim().toUpperCase())
        : (theirAnswers[i] || []),
      refuted: q?.refuted === true,
      correct_answer: ok,
      confidence: Number.isFinite(Number(q?.confidence)) ? Number(q.confidence) : null,
      reason: q?.reason || '',
      ...(bad.length ? { shape_error: `correct_answer 回的是選項文字不是字母：${bad.join('、')}` } : {}),
    };
  };

  if (Array.isArray(raw)) {
    return { readable: true, page: '', note: '', questions: raw.map(one) };
  }
  if (Array.isArray(raw?.questions)) {
    return {
      readable: raw.readable !== false,
      page: (raw.page || '').toString(),
      note: raw.note || '',
      questions: raw.readable === false ? [] : raw.questions.map(one),
    };
  }
  return {
    readable: raw?.readable !== false,
    page: (raw?.page || '').toString(),
    note: raw?.note || '',
    questions: raw?.readable === false ? [] : [one(raw, 0)],
  };
}

// 翻完之後驗一次：官方譯法有沒有真的出現在譯文裡。
// 沒對上不是致命錯誤（模型可能改寫了句式），但要標出來讓人看得到——
// 「中譯跟畫面上的字對不起來」正是需求 2 要解決的問題本身。
function checkGlossary(zhText, glossary) {
  const hay = String(zhText || '');
  const missed = (glossary || [])
    .filter(g => g && g.zh && !hay.includes(g.zh))
    .map(g => ({ en: g.en, zh: g.zh }));
  return { missed };
}

function reviewPage({ imagePath, theirAnswers, glossary, onProgress, model = MODEL }) {
  return new Promise((resolve, reject) => {
    // 每次呼叫一個獨立的暫存目錄：截圖複製進去，agent 只看得到那一個檔案。
    // 獨立目錄同時讓並行審查不會互相蓋掉截圖。
    let runCwd;
    try {
      runCwd = makeRunCwd();
      fs.copyFileSync(imagePath, path.join(runCwd, 'shot.jpg'));
    } catch (e) {
      return reject(new Error(`準備審查工作目錄失敗：${e.message}`));
    }
    const cleanup = () => { try { fs.rmSync(runCwd, { recursive: true, force: true }); } catch { /* 清不掉不影響結果 */ } };

    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      // 只給 Read：審查階段不取證（取證是另一次呼叫，額外給 Grep）。
      // 這同時是成本閘門——agent 沒有工具可以繞去做別的事。
      '--allowed-tools', 'Read',
      '--strict-mcp-config', '--mcp-config', MCP_CONFIG,
      '--model', model,
    ];

    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: runCwd });
    // 子行程提早死掉時對已關閉的 stdin 寫入會發 EPIPE；無 handler 會變 uncaughtException。
    child.stdin.on('error', () => {});

    let assistantText = '', lineBuffer = '', stderr = '', usage = null, settled = false;

    // 每條退出路徑都要清掉暫存目錄，否則 /tmp 會被截圖堆滿
    const finish = fn => { if (!settled) { settled = true; clearTimeout(timer); cleanup(); fn(); } };
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

    child.stdin.write(buildPrompt({ imageName: 'shot.jpg', theirAnswers, glossary }));
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
        resolve({ verdict: normalize(raw, theirAnswers), usage, model });
      });
    });
  });
}

// 寫入 exam_verdicts，並順便補上中譯。
//
// 對應用 (bank_id, page, no) 而不是題幹指紋：模型從截圖抄的題幹與 questions.json
// 裡的可能有細微差異（原專案實測「選項文字少抄一個 tab 字」「題幹 1 題不同」），
// 靠指紋對會靜靜對不上，而症狀是「審查跑了但題庫沒變」。
async function saveVerdicts(db, { bankId, page, verdict, model }) {
  const out = { saved: 0, unmatched: [], translated: 0 };
  if (!verdict || verdict.readable === false) return out;

  for (const q of (verdict.questions || [])) {
    const hit = await db.query(
      `SELECT a.id AS attempt_id, a.item_id
         FROM exam_attempts a
        WHERE a.bank_id = $1 AND a.page = $2 AND a.no = $3`,
      [bankId, String(page), q.no]
    );
    if (!hit.rows.length) {
      // 具名回報，不靜靜丟掉——題數對不上時人只會看到「少了幾題」，離真因很遠
      out.unmatched.push(`P${page}-${q.no}`);
      continue;
    }
    const { attempt_id: attemptId, item_id: itemId } = hit.rows[0];

    await db.query(
      `INSERT INTO exam_verdicts
         (item_id, attempt_id, kind, refuted, correct_answer, confidence, reason, model)
       VALUES ($1,$2,'adversary',$3,$4,$5,$6,$7)`,
      [itemId, attemptId, q.refuted === true, q.correct_answer,
       q.confidence, q.reason || null, model]
    );
    out.saved++;

    // 中譯：只補、不覆蓋既有的非空值。重審一次不該把上次翻好的洗掉。
    //
    // 判斷寫在 JS 不寫在 SQL：pg-mem 不支援 NULLIF（實測），而「測試環境跑不動
    // 正式環境的 SQL」會逼人在測試裡加特例。SQL 保持最笨的 UPDATE，邏輯留在
    // 這裡，兩邊行為必然一致，也比 CASE WHEN 好讀。
    const hasOptZh = (q.options || []).some(o => o.text_zh);
    if (q.question_zh || hasOptZh) {
      const cur = await db.query(
        `SELECT question_zh, options FROM exam_items WHERE id = $1`, [itemId]);
      const row = cur.rows[0] || {};
      const keepZh = row.question_zh && row.question_zh.trim()
        ? row.question_zh
        : (q.question_zh || null);

      const curOpts = typeof row.options === 'string'
        ? JSON.parse(row.options || '[]') : (row.options || []);
      const curHasZh = Array.isArray(curOpts) && curOpts.some(o => o && o.text_zh);
      const nextOpts = (hasOptZh && !curHasZh) ? q.options : curOpts;

      await db.query(
        `UPDATE exam_items SET question_zh = $2, options = $3, updated_at = NOW() WHERE id = $1`,
        [itemId, keepZh, JSON.stringify(nextOpts)]
      );
      out.translated++;
    }
  }
  return out;
}

module.exports = {
  reviewPage, buildPrompt, normalize, extractJson, checkGlossary, saveVerdicts, MODEL,
};
