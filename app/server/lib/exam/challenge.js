// 挑戰模式：一次呼叫同時做「挑戰作答者的答案」與「拿原始碼佐證」。
//
// 取代原本「審查 → 取證」兩步。拆兩步的代價實測過（Project 8 題）：
//   抄題 33 秒｜審查 6.5 分｜取證 5.1 分  = 12.2 分
// 而審查那 6.5 分**幾乎都在等網路**——它手上沒有原始碼，只好去 WebSearch／WebFetch
// 抓 odoo.com 文件，17 次網路請求，中間單筆空檔就有 96 秒。
// 一開始就給它原始碼，它沒有理由上網，而且結論與證據是同一次推理產出的，
// 不會出現「審查說 B、取證卻只找到支持 C 的碼」這種兩步各說各話。
//
// **工具限制靠 --disallowed-tools，不是 --allowed-tools。**
// 實測：--allowed-tools 是「這些不用問就放行」的白名單，不是「只准用這些」；
// 給了 'Read' 它照樣跑 Bash。--disallowed-tools 才真的擋得住（實測回 BOTH_BLOCKED）。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ensureEvidenceCwd, sourceDirs, normalizeEvidence, MCP_CONFIG } = require('./evidence');
const { extractJson, normalizeConfidence, glossaryBlock, TRAPS, cleanAnswer } = require('./review');

const TIMEOUT_MS = parseInt(process.env.EXAM_CHALLENGE_TIMEOUT_MS
  || process.env.EXAM_JUDGE_TIMEOUT_MS || '1200000', 10);
const MODEL = process.env.EXAM_JUDGE_MODEL || 'opus';

// 這一步不該碰的東西。Bash 讓它能 cat 沙箱外的任何檔案（官方答案就在這台機器上）；
// Web* 讓它跑去查網路文件而不是看手上的原始碼——那正是舊版慢的主因。
// Task／ToolSearch 會讓它繞過這份清單再長出別的能力。
const DISALLOWED = ['Bash', 'WebSearch', 'WebFetch', 'Task', 'ToolSearch',
  'Write', 'Edit', 'NotebookEdit'];

// 行為規範走 system prompt 而不是 user prompt：使用者的話可以被後面的內容稀釋，
// 系統層的不會。硬性限制仍然只有 --disallowed-tools 與 Node 端驗證算數，
// 這一段是講「該怎麼做」，不是指望它自律。
const SYSTEM = `你是 Odoo 官方認證考題的挑戰者。工作目錄是一個沙箱，裡面放著這次考題
對應版本的 Odoo 原始碼。

行為規範：
1. 你的任務是**挑戰**作答者的答案——主動尋找它為什麼錯。但找不到問題就明說找不到，
   不要為了完成任務而編造理由。
2. 結論要有根據，而根據只認**沙箱內的原始碼行號**，不認你對 Odoo 的印象。
   你記得的可能是別的版本；眼前這份碼才是這次考的版本。
3. 可讀範圍只有下面會告訴你的那兩個原始碼目錄（社群版與企業版）。**兩邊都要查**
   ——認證考試大量涵蓋企業版功能，只看社群版會把「在企業版裡」誤判成
   「Odoo 沒有這個功能」。其餘路徑讀了也會被丟棄。
4. 沒有網路可用，也不要試。查不到就照實說查不到，不要用猜的填空。
5. **動手前先讀工作目錄下的 challenge-guide.md**，那裡寫了這場考試的性質、
   社群版與企業版怎麼分、以及各種題型該去翻哪個檔案。`;

function buildChallengePrompt({ questions, theirAnswers, glossary, odooVersion, imageName = null, dirs = [] }) {
  const rows = (questions || []).map((q, i) => ({
    no: q.no || i + 1,
    question: q.question,
    question_zh: q.question_zh,
    type: q.type,
    options: q.options,
    their_answer: (theirAnswers[i] || []),
    has_image: q.has_image === true,
  }));

  const dirLines = (dirs || []).map(d =>
    `- ${d.name === 'ent' ? '企業版' : '社群版'}：\`${d.path}\``).join('\n');

  return `這是 **Odoo ${odooVersion}** 官方認證考題，以及作答者選的答案。
這些題在題庫裡**沒有**官方確認答案，所以要靠你判斷。

## 原始碼在這裡（就是 Odoo ${odooVersion} 這一版）

${dirLines}

查到什麼就是什麼，不要用「我記得某版是這樣」去覆蓋眼前的碼。
**這些是絕對路徑，Glob 與 Grep 都要用完整路徑**，不要用相對路徑或代號。

${imageName ? `需要看圖的題（has_image 為 true）可以 Read ${imageName}。` : '這批題全部可由文字回答，沒有附圖。'}

待挑戰的題目：
${JSON.stringify(rows, null, 2)}
${glossaryBlock(glossary)}
注意否定詞（NOT／EXCEPT／不正確）、版本差異，以及這三類已知陷阱：
${TRAPS}

## 怎麼做

同一頁的題目幾乎都在問同一個 Odoo 模組。**先把那個模組的目錄結構摸清楚一次**，
後面每一題重用，不要每題從頭掃整個原始碼樹。

定位模組時**社群版與企業版都要掃**（用上面給的絕對路徑）：

${(dirs || []).map(d => `    Glob  ${d.path}/${d.name === 'ent' ? '' : 'addons/'}*<關鍵字>*/`).join('\n')}

企業版模組常是「社群版模組名 ＋ 後綴」（project_enterprise、account_accountant、
sale_subscription），覆寫社群版行為。Documents／Sign／Helpdesk／Planning／
Appraisal／Studio 這些**只在 ent/**。

對每一題：先找作答者答案的反證，再決定 refuted。無論推翻與否，都盡量附上
原始碼行號——支持與反駁都算證據。查不到就給空陣列並在 reason 說明。

## 輸出

只輸出一個 json 區塊，前後不要有其他文字。**每題一筆，不可漏也不可改題號。**

\`\`\`json
{"readable": true, "note": "", "questions": [
  {
    "no": 1,
    "refuted": false,
    "correct_answer": ["B"],
    "confidence": 88,
    "reason": "一到三句，講清楚根據",
    "evidence": [
      { "kind": "source", "ref": "src/addons/project/models/project_task.py:154", "excerpt": "關鍵那幾行" }
    ]
  }
]}
\`\`\`

- correct_answer：**選項字母**陣列。refuted=false 時填作答者的答案。
- confidence：0-100 的**整數**，你對這個結論的把握。
- ref：上面那兩個目錄底下的**完整路徑＋行號**。其他路徑會被丟棄。
- **不要重抄題幹、選項或翻譯**，上面已經給你了，我們用 no 對回去。`;
}

// 模型回的每題結果 → 判斷欄位 ＋ 已驗證的證據。
// 證據沿用 evidence.js 的 normalizeEvidence，路徑驗證那道硬關卡完全一樣。
function normalizeChallenge(raw, theirAnswers = [], source = null, dirs = null) {
  const byNo = new Map((source || []).map((q, i) => [Number(q?.no) || i + 1, q]));
  const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.questions) ? raw.questions : []);
  const readable = (Array.isArray(raw) ? true : raw?.readable !== false);
  if (!readable) return { readable: false, note: raw?.note || '', questions: [] };

  const order = [...byNo.keys()];
  const questions = rows.map((q, i) => {
    const no = Number(q?.no) || order[i] || i + 1;
    const src = byNo.get(no) || {};
    const { ok, bad } = cleanAnswer(q?.correct_answer);
    const idx = order.indexOf(no);
    const ev = normalizeEvidence({ found: true, evidence: q?.evidence }, dirs);
    return {
      no,
      question: src.question || '',
      question_zh: src.question_zh || '',
      type: src.type === 'multi' ? 'multi' : 'single',
      options: Array.isArray(src.options) ? src.options : [],
      their_answer: theirAnswers[idx >= 0 ? idx : i] || [],
      refuted: q?.refuted === true,
      correct_answer: ok,
      confidence: normalizeConfidence(q?.confidence),
      reason: q?.reason || '',
      evidence: ev.evidence,
      rejected_refs: ev.rejected,
      ...(bad.length ? { shape_error: `correct_answer 回的是選項文字不是字母：${bad.join('、')}` } : {}),
    };
  });
  return { readable: true, note: raw?.note || '', questions };
}

function challengePage({ questions, theirAnswers, glossary, odooVersion,
  imagePath = null, onProgress, model = MODEL }) {
  return new Promise((resolve, reject) => {
    // 每次呼叫一個獨立目錄。併行 5 個 worker 共用一個沙箱時，一個在重建 symlink
    // 的瞬間另一個會看到空目錄（實測 P4 因此失敗），而且兩頁的截圖會互相蓋掉。
    let cwd;
    try { cwd = ensureEvidenceCwd(odooVersion, { unique: true }); } catch (e) { return reject(e); }
    const cleanup = () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) { /* 清不掉就留著 */ } };

    // 需要看圖的題才把截圖複製進沙箱，而且只給檔名不給絕對路徑——prompt 裡出現
    // 絕對路徑等於告訴它 repo 在哪。
    const needsImage = (questions || []).some(q => q.has_image === true) && imagePath;
    let imageName = null;
    if (needsImage) {
      imageName = 'shot.jpg';
      try { fs.copyFileSync(imagePath, path.join(cwd, imageName)); }
      catch { imageName = null; }
    }

    // 原始碼靠 --add-dir 加進可讀範圍，**不能用 symlink**。
    // 實測：sandbox 裡放 src -> odoo-core 的 symlink 之後，Glob 與 Grep 都回 0 筆
    // ——兩個都不跟隨 symlink。結果是 7 頁裡只有 3 頁有證據，而那 3 頁是模型直接
    // Read 猜對完整路徑碰運氣來的，ent/ 更是從頭到尾一筆都沒用到。
    // 最糟的是失敗只發生在「比較誠實」的那幾頁：其餘頁靠印象答完，系統卻記成
    // 「查過查不到」。
    const dirs = sourceDirs(odooVersion);
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      ...dirs.flatMap(d => ['--add-dir', d.path]),
      // 白名單不是限制（實測給 'Read' 它照樣跑 Bash），拒絕清單才是
      '--disallowed-tools', ...DISALLOWED,
      '--append-system-prompt', SYSTEM,
      '--strict-mcp-config', '--mcp-config', MCP_CONFIG,
      '--model', model,
    ];

    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    child.stdin.on('error', () => {});

    let assistantText = '', lineBuffer = '', stderr = '', usage = null, settled = false;
    const finish = fn => { if (!settled) { settled = true; clearTimeout(timer); cleanup(); fn(); } };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      finish(() => reject(new Error(`挑戰逾時（${Math.round(TIMEOUT_MS / 1000)}s）`)));
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
            if (blk.type === 'tool_use') onProgress?.('查原始碼…');
          }
        }
        if (ev.type === 'result') usage = ev.usage || null;
      }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.stdin.write(buildChallengePrompt({
      questions, theirAnswers, glossary, odooVersion, imageName, dirs }));
    child.stdin.end();

    child.on('error', err => {
      if (err.code === 'ENOENT') err.message = '找不到 claude 執行檔（PATH 未含 claude 安裝目錄）';
      finish(() => reject(err));
    });
    child.on('close', code => {
      finish(() => {
        if (code !== 0) return reject(new Error(stderr.trim() || `claude 結束於 exit code ${code}`));
        const raw = extractJson(assistantText);
        if (!raw) return reject(new Error(`挑戰輸出無法解析：${assistantText.slice(0, 200) || '(空輸出)'}`));
        resolve({ verdict: normalizeChallenge(raw, theirAnswers, questions, dirs), usage, model });
      });
    });
  });
}

module.exports = { challengePage, buildChallengePrompt, normalizeChallenge, SYSTEM, DISALLOWED };
