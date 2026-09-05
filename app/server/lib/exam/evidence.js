// 取證：信心不足時去 Odoo 原始碼找硬證據，把「模型自評」換成「找得到碼」。
//
// 使用者拍板的門檻是信心 < 90 才跑。第 0 期實測分布：120 題裡約 37% 會進這一步，
// 總成本約 ×1.37 而不是翻倍。
//
// **這支的安全前提**：agent 拿得到 Grep，而官方答案（answer-key.json、questions.json
// 的 official 欄位）就在同一個 repo 裡。所以可見範圍必須被縮到只剩 Odoo 原始碼：
//   1. cwd 是 tmpdir 下的空目錄，底下只放一個 symlink `src/` 指向 data/odoo-core/<ver>/
//      父目錄鏈是 /tmp 與 /，沒有任何我們的 CLAUDE.md（實測確認）
//   2. prompt 明確限定只查 src/ ——但那是 soft instruction，不可靠
//   3. **Node 端硬驗每一筆 ref 是否落在 src/ 底下**，不是就丟棄。這一關才是硬的。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 一次呼叫＝一題的原始碼查證。與 review 同樣拉到 1200s：Grep 在 Odoo 全量原始碼上
// 可能要翻很多輪，而逾時的代價是這題完全沒有證據（信心度就永遠停在「沒找證據」那一層）。
const TIMEOUT_MS = parseInt(process.env.EXAM_EVIDENCE_TIMEOUT_MS || '1200000', 10);
const MODEL = process.env.EXAM_JUDGE_MODEL || 'opus';

// 使用者拍板：信心低於這個數就強制找證據。
const EVIDENCE_THRESHOLD = 90;

const MCP_DIR = path.join(__dirname, 'mcp');
const MCP_CONFIG = path.join(MCP_DIR, 'none.json');
fs.mkdirSync(MCP_DIR, { recursive: true });
if (!fs.existsSync(MCP_CONFIG)) fs.writeFileSync(MCP_CONFIG, '{"mcpServers":{}}');

const GUIDE_NAME = 'evidence-guide.md';
const CHALLENGE_GUIDE = 'challenge-guide.md';

const CORE_ROOT = process.env.ODOO_CORE_SRC_DIR
  || path.join(__dirname, '..', '..', '..', '..', 'data', 'odoo-core');

// 企業版原始碼。認證考試考很多企業版才有的功能（Documents、Sign、Helpdesk、
// Planning、Appraisal、專案甘特圖…），社群版的 685 個 addons 裡一個都沒有——
// 只掛社群版等於叫 agent 去找不存在的檔案，它查不到就只能猜。
const ENTERPRISE_ROOT = process.env.ODOO_ENTERPRISE_SRC_DIR
  || path.join(__dirname, '..', '..', '..', '..', 'enterprise');

// 給 agent 查的原始碼放在 repo 外的暫存區。
//
// 為什麼要複製而不是直接指向 repo 內的目錄：--add-dir 的路徑會出現在 prompt 裡，
// 而 repo 內的路徑等於告訴 agent 「這台機器的 repo 在 /home/.../odoo-v2」——
// 它接著就能 Read data/exam/answer-key.json 把答案抄走。那正是這整套設計最想防的。
// 換成 /tmp 底下的路徑，它看到的只是一棵沒有上下文的原始碼樹。
const STAGE_ROOT = process.env.EXAM_SRC_STAGE_DIR || path.join(os.tmpdir(), 'odoo-exam-src');

// 複製一次就重用（2.1 GB，每次呼叫都複製不可行）。以「來源目錄的 mtime」判斷
// 要不要重做——原始碼解出來之後不會再變，所以幾乎永遠是命中。
function stageSource(name, srcDir, version) {
  const dest = path.join(STAGE_ROOT, String(version), name);
  const stamp = path.join(dest, '.staged');
  const want = String(fs.statSync(srcDir).mtimeMs);
  try { if (fs.readFileSync(stamp, 'utf8') === want) return dest; } catch { /* 還沒建或壞了 */ }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // dereference 一定要關：Odoo 原始碼裡有斷掉的 symlink（point_of_sale 的
  // Inconsolata.otf 字型），解析它會讓整個複製 ENOENT 中斷。當成 symlink 原樣
  // 複製就沒事——那些連結是樹內相對的，不影響 Glob/Grep 在真實目錄上的運作。
  fs.cpSync(srcDir, dest, { recursive: true, dereference: false, force: true });
  fs.writeFileSync(stamp, want);
  return dest;
}

/**
 * 這個版本有哪些原始碼樹可以查。回絕對路徑，交給 --add-dir。
 *
 * 不做成 symlink：實測 Glob 與 Grep 都不跟隨 symlink（沙箱裡放 src -> odoo-core
 * 之後兩個工具都回 0 筆），agent 只能靠猜完整路徑去 Read，等於沒有查證能力。
 */
function sourceDirs(odooVersion) {
  const out = [];
  const core = path.resolve(CORE_ROOT, String(odooVersion));
  if (!fs.existsSync(core)) {
    throw new Error(`找不到 Odoo ${odooVersion} 原始碼（${core}）——先用 ensureOdooCoreSrc('${odooVersion}') 解出來`);
  }
  out.push({ name: 'src', path: stageSource('community', core, odooVersion) });
  // 企業版是選配：沒有就只給社群版，不要因此讓整件事失敗
  const ent = path.resolve(ENTERPRISE_ROOT, String(odooVersion));
  if (fs.existsSync(ent)) out.push({ name: 'ent', path: stageSource('enterprise', ent, odooVersion) });
  return out;
}

function linkTo(link, target) {
  let ok = false;
  try { ok = fs.readlinkSync(link) === target; } catch { ok = false; }
  if (!ok) {
    try { fs.unlinkSync(link); } catch { /* 本來就不存在 */ }
    fs.symlinkSync(target, link, 'dir');
  }
}

/**
 * 準備一個掛好原始碼的工作目錄。
 *
 * @param unique 為 true 時每次呼叫給一個全新目錄。**併行時必須用這個。**
 *
 * 共用同一個目錄在併行下會爆兩種：
 *   1. 一個 worker 在重建 symlink（unlink 再 symlink）的瞬間，另一個進去看到空的
 *      ——實測 P4 直接失敗，訊息是「工作目錄下沒有 src/ 或 ent/」。
 *   2. 兩頁同時把各自的截圖複製成 shot.jpg，其中一頁會讀到別頁的圖，
 *      而且完全不會報錯——抄出來的題目是別頁的，事後從結果看不出來。
 */
function ensureEvidenceCwd(odooVersion, { unique = false } = {}) {
  const cwd = unique
    ? fs.mkdtempSync(path.join(os.tmpdir(), `odoo-exam-run-${odooVersion}-`))
    : path.join(os.tmpdir(), `odoo-exam-evidence-${odooVersion}`);
  const link = path.join(cwd, 'src');
  const target = path.resolve(CORE_ROOT, String(odooVersion));
  if (!fs.existsSync(target)) {
    throw new Error(`找不到 Odoo ${odooVersion} 原始碼（${target}）——先用 ensureOdooCoreSrc('${odooVersion}') 解出來`);
  }
  fs.mkdirSync(cwd, { recursive: true });
  linkTo(link, target);

  // 企業版是選配：沒有就只掛社群版，不要因此讓整個取證失敗。
  const ent = path.resolve(ENTERPRISE_ROOT, String(odooVersion));
  const entLink = path.join(cwd, 'ent');
  if (fs.existsSync(ent)) linkTo(entLink, ent);
  else { try { fs.unlinkSync(entLink); } catch { /* 本來就沒有 */ } }
  // 查證方法寫在獨立檔案，複製進沙箱讓 agent 自己讀，不塞進每次呼叫的 prompt。
  //
  // 為什麼不做成 Claude Code 的 skill：這裡的 cwd 是暫存目錄，專案的
  // .claude/skills/ 在那裡載不到（實測：只載得到 ~/.claude/skills/ 的 user scope）。
  // 而 user scope 不進版控、又全平台共用，等於破壞這支刻意做出來的隔離。
  for (const g of [GUIDE_NAME, CHALLENGE_GUIDE]) {
    fs.copyFileSync(path.join(__dirname, g), path.join(cwd, g));
  }
  return cwd;
}

// 什麼時候該取證。
function needsEvidence({ confidence, refuted } = {}) {
  // 被推翻的題一律取證：「它說錯了但講不出根據」是 45 分，拿得出原始碼行號
  // 才是 30 分，那個差距只有取證分辨得出來。
  if (refuted) return true;
  if (!Number.isFinite(confidence)) return true;
  return confidence < EVIDENCE_THRESHOLD;
}

function buildEvidencePrompt({ question, options, candidate, odooVersion }) {
  const optLines = (options || [])
    .map(o => `  ${o.letter}. ${o.text}`)
    .join('\n');

  return `你是 Odoo ${odooVersion} 的原始碼查證員。

## 題目

${question}

${optLines}

目前的候選答案：${(candidate || []).join('、') || '(無)'}

## 你的任務

去 Odoo ${odooVersion} 的原始碼裡找出**能支持或推翻這個候選答案的硬證據**，
並回報是**哪個檔案的第幾行**。

**只能查 \`src/\` 底下**（那是 Odoo ${odooVersion} 的原始碼）。不要讀 src/ 以外的
任何路徑，也不要往上跳目錄——src/ 以外的東西與這題無關，而且回報上來也會被丟棄。

## 三種題型，用不同的方法

| 題型 | 怎麼查 |
| --- | --- |
| 機制題——欄位定義在哪個 model、預設排序、演算法、domain 限制 | Grep \`src/\`，這是本機原始碼，精準而且版本正確 |
| 操作題——某設定在哪個選單、功能概念敘述 | 原始碼要先猜對檔名才找得到，通常查不到，就說查不到 |
| 情境推算題——看圖、算價、算日期 | 原始碼不回答「這張圖像什麼」，一律回查不到 |

## 最重要的一條

**查不到就說查不到，不要硬湊。** 拿無關片段替推理背書比不查更糟——那會讓一個
純粹靠推理的結論看起來像有證據支撐，而下游會照著這個假象給它高信心。
found 設為 false，reason 寫清楚為什麼查不到。

只輸出一個 json 區塊，前後不要有任何其他文字：

\`\`\`json
{
  "found": true,
  "evidence": [
    {
      "kind": "source",
      "ref": "src/addons/stock/models/product.py:412",
      "excerpt": "關鍵的那幾行，不要貼整個函式"
    }
  ],
  "supports": "B",
  "confidence": 92,
  "reason": "這段碼為什麼支持（或推翻）候選答案，一到三句"
}
\`\`\`

- kind：\`source\`（原始碼）。ref 一律是 \`src/…:行號\` 的形式。
- supports：這些證據支持哪個選項字母。證據指向候選答案以外的選項時就填那個。
- found 為 false 時 evidence 給空陣列。`;
}

/**
 * 批次版：同一頁的題目一起查。
 *
 * 一次收到的題目來自考卷的同一頁，而同一頁幾乎都在問同一個 Odoo 模組
 * （Project 那頁全是 project/、eCommerce 那頁全是 website_sale/）。分開查的話
 * 每個 agent 都要重新摸索一次那個模組的目錄結構——那份成本乘以題數。
 */
function buildBatchEvidencePrompt({ questions, odooVersion }) {
  const blocks = (questions || []).map(q => {
    const opts = (q.options || []).map(o => `  ${o.letter}. ${o.text}`).join('\n');
    return `### 第 ${q.no} 題\n\n${q.question}\n\n${opts}\n\n候選答案：${(q.candidate || []).join('、') || '(無)'}`;
  }).join('\n\n');

  return `你是 Odoo ${odooVersion} 的原始碼查證員。

**動手前先讀 \`${GUIDE_NAME}\`**（就在你的工作目錄下），那裡寫了可查範圍、
題型怎麼分、以及證據要長什麼樣。

## 這一批題目（同一頁，通常屬於同一個模組）

${blocks}

## 你的任務

對**每一題**去原始碼裡找能支持或推翻其候選答案的硬證據，回報哪個檔案第幾行。

先把這一批共同的模組摸清楚一次，後面每題重用，不要每題從頭 Grep 整個 src/。

只輸出一個 json 區塊，前後不要有任何其他文字：

\`\`\`json
{
  "results": [
    {
      "no": 1,
      "found": true,
      "evidence": [
        { "kind": "source", "ref": "src/addons/stock/models/product.py:412", "excerpt": "關鍵的那幾行" }
      ],
      "supports": "B",
      "confidence": 92,
      "reason": "這段碼為什麼支持（或推翻）候選答案，一到三句"
    }
  ]
}
\`\`\`

**每一題都要有一筆**，查不到的那題 found 給 false、evidence 給空陣列，
不要整題省略——省略的話下游分不出「查過查不到」與「漏查」。`;
}

// 路徑驗證：只收落在 src/ 底下的原始碼證據，存成相對 odoo-core 的路徑。
//
// 這一關是硬的。prompt 裡的「只能查 src/」是 soft instruction，模型不聽也不會怎樣；
// 這裡不收就是不收，agent 亂跑也帶不回任何 repo 內的東西。
function safeSourceRef(ref, dirs = null) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  const [filePart, lineNo] = raw.split(/:(?=\d+$)/);
  const norm = path.posix.normalize(filePart.replace(/\\/g, '/'));

  // 三種寫法都收：
  //   1. 暫存區的**絕對路徑**——agent 拿到的是 --add-dir 的真實目錄。
  //   2. 暫存區目錄的**末層名**（`community/…`、`enterprise/…`）——兩個 --add-dir
  //      有共同上層時，模型會自己把那段砍掉只留末層。實跑一頁 8 題，15 筆引用
  //      全長這樣、於是全被丟掉，DB 一筆證據都沒進。
  //   3. `src/…`／`ent/…` 的相對寫法——舊 prompt 的格式，留著才不會因為
  //      模型偶爾照舊寫而整批證據被丟掉。
  //
  // **存進 DB 的一律是去掉根之後的相對路徑，企業版多留 ent/ 前綴**。
  // 既有 150 筆存的都是去前綴的社群版路徑，換格式等於動到舊資料；
  // 所以「沒有前綴」繼續代表社群版，只有企業版才標出來。
  const roots = [];
  for (const d of (dirs || [])) {
    const abs = path.posix.normalize(d.path);
    roots.push({ prefix: `${abs}/`, name: d.name });
    roots.push({ prefix: `${path.posix.basename(abs)}/`, name: d.name });
  }
  roots.push({ prefix: 'src/', name: 'src' }, { prefix: 'ent/', name: 'ent' });

  const hit = roots.find(r => norm.startsWith(r.prefix));
  if (!hit) return null;
  const inner = norm.slice(hit.prefix.length);
  // normalize 之後仍能往上跳＝一開始就跳出去了
  if (!inner || inner.startsWith('../') || inner.includes('/../')) return null;
  const rel = hit.name === 'ent' ? `ent/${inner}` : inner;
  return lineNo ? `${rel}:${lineNo}` : rel;
}

// excerpt 上限：證據是「哪個檔案第幾行」，不是貼整個函式。
// 沒有上限的話 agent 可以把任意檔案的內容整段塞進 DB，路徑檢查就白做了。
const MAX_EXCERPT = 600;

function trimExcerpt(s) {
  const t = String(s == null ? '' : s);
  return t.length > MAX_EXCERPT ? `${t.slice(0, MAX_EXCERPT)}…（已截斷）` : (t || null);
}

function normalizeEvidence(raw, dirs = null) {
  const out = { found: false, evidence: [], rejected: [], supports: null, confidence: null, reason: '' };
  if (!raw || typeof raw !== 'object') return out;

  out.found = raw.found === true;
  out.supports = raw.supports ? String(raw.supports).trim().toUpperCase() : null;
  out.confidence = Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : null;
  out.reason = raw.reason || '';

  const list = Array.isArray(raw.evidence) ? raw.evidence : [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (e.kind === 'docs') {
      // 文件類不受路徑限制（它不是本機檔案，是 Context7 的 library id）
      if (e.ref) out.evidence.push({ kind: 'docs', ref: String(e.ref), excerpt: trimExcerpt(e.excerpt) });
      continue;
    }
    const safe = safeSourceRef(e.ref, dirs);
    if (!safe) { out.rejected.push(String(e.ref || '(空)')); continue; }
    out.evidence.push({ kind: 'source', ref: safe, excerpt: trimExcerpt(e.excerpt) });
  }
  return out;
}

async function saveEvidence(db, { verdictId, evidence }) {
  const list = Array.isArray(evidence) ? evidence : [];
  let n = 0;
  for (const e of list) {
    if (!e || !e.ref) continue;
    await db.query(
      `INSERT INTO exam_evidence (verdict_id, kind, ref, excerpt) VALUES ($1,$2,$3,$4)`,
      [verdictId, e.kind === 'docs' ? 'docs' : 'source', e.ref, e.excerpt || null]
    );
    n++;
  }
  return n;
}

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

// 單題與批次共用同一支 spawn。差別只在 prompt 與怎麼解讀輸出。
function runEvidence({ prompt, odooVersion, onProgress, model = MODEL }) {
  return new Promise((resolve, reject) => {
    let cwd;
    try { cwd = ensureEvidenceCwd(odooVersion); } catch (e) { return reject(e); }

    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      // Grep 是這一步的重點；Read 讓它能看命中行的上下文。
      '--allowed-tools', 'Read,Grep',
      '--strict-mcp-config', '--mcp-config', MCP_CONFIG,
      '--model', model,
    ];

    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    child.stdin.on('error', () => {});

    let assistantText = '', lineBuffer = '', stderr = '', usage = null, settled = false;

    const finish = fn => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      finish(() => reject(new Error(`取證逾時（${Math.round(TIMEOUT_MS / 1000)}s）`)));
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

    child.stdin.write(prompt);
    child.stdin.end();

    child.on('error', err => {
      if (err.code === 'ENOENT') err.message = '找不到 claude 執行檔（PATH 未含 claude 安裝目錄）';
      finish(() => reject(err));
    });

    child.on('close', code => {
      finish(() => {
        if (code !== 0) return reject(new Error(stderr.trim() || `claude 結束於 exit code ${code}`));
        const raw = extractJson(assistantText);
        if (!raw) return reject(new Error(`取證輸出無法解析：${assistantText.slice(0, 200) || '(空輸出)'}`));
        resolve({ raw, usage, model });
      });
    });
  });
}

async function gatherEvidence({ question, options, candidate, odooVersion, onProgress, model = MODEL }) {
  const { raw, usage } = await runEvidence({
    prompt: buildEvidencePrompt({ question, options, candidate, odooVersion }),
    odooVersion, onProgress, model,
  });
  return { result: normalizeEvidence(raw), usage, model };
}

/**
 * 批次取證。回傳 Map<題號, 正規化後的證據>。
 *
 * 模型漏掉某幾題時**不補空殼**——回傳的 Map 就是少那幾個 key，呼叫端才分得出
 * 「查過查不到」（found:false）與「根本沒回」（key 不存在）。兩者的處置不同：
 * 前者信心度該停在「沒找證據」那層，後者應該退回單題重跑。
 */
async function gatherEvidenceBatch({ questions, odooVersion, onProgress, model = MODEL }) {
  const list = Array.isArray(questions) ? questions : [];
  if (!list.length) return { results: new Map(), usage: null, model };

  const { raw, usage } = await runEvidence({
    prompt: buildBatchEvidencePrompt({ questions: list, odooVersion }),
    odooVersion, onProgress, model,
  });

  const rows = raw && Array.isArray(raw.results) ? raw.results : [];
  const results = new Map();
  for (const r of rows) {
    const no = Number(r && r.no);
    if (!Number.isFinite(no)) continue;
    results.set(no, normalizeEvidence(r));
  }
  return { results, usage, model };
}

module.exports = {
  gatherEvidence, gatherEvidenceBatch, buildEvidencePrompt, buildBatchEvidencePrompt,
  normalizeEvidence, saveEvidence, needsEvidence, safeSourceRef, ensureEvidenceCwd,
  EVIDENCE_THRESHOLD, MCP_CONFIG, sourceDirs, STAGE_ROOT,
};
