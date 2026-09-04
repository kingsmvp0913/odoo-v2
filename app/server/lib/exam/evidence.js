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

const TIMEOUT_MS = parseInt(process.env.EXAM_EVIDENCE_TIMEOUT_MS || '180000', 10);
const MODEL = process.env.EXAM_JUDGE_MODEL || 'opus';

// 使用者拍板：信心低於這個數就強制找證據。
const EVIDENCE_THRESHOLD = 90;

const MCP_DIR = path.join(__dirname, 'mcp');
const MCP_CONFIG = path.join(MCP_DIR, 'none.json');
fs.mkdirSync(MCP_DIR, { recursive: true });
if (!fs.existsSync(MCP_CONFIG)) fs.writeFileSync(MCP_CONFIG, '{"mcpServers":{}}');

const CORE_ROOT = process.env.ODOO_CORE_SRC_DIR
  || path.join(__dirname, '..', '..', '..', '..', 'data', 'odoo-core');

// 為每個版本準備一個隔離的工作目錄。重複呼叫時重用，symlink 指向變了就重建。
function ensureEvidenceCwd(odooVersion) {
  const cwd = path.join(os.tmpdir(), `odoo-exam-evidence-${odooVersion}`);
  const link = path.join(cwd, 'src');
  const target = path.resolve(CORE_ROOT, String(odooVersion));
  if (!fs.existsSync(target)) {
    throw new Error(`找不到 Odoo ${odooVersion} 原始碼（${target}）——先用 ensureOdooCoreSrc('${odooVersion}') 解出來`);
  }
  fs.mkdirSync(cwd, { recursive: true });
  let ok = false;
  try { ok = fs.readlinkSync(link) === target; } catch { ok = false; }
  if (!ok) {
    try { fs.unlinkSync(link); } catch { /* 本來就不存在 */ }
    fs.symlinkSync(target, link, 'dir');
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

// 路徑驗證：只收落在 src/ 底下的原始碼證據，存成相對 odoo-core 的路徑。
//
// 這一關是硬的。prompt 裡的「只能查 src/」是 soft instruction，模型不聽也不會怎樣；
// 這裡不收就是不收，agent 亂跑也帶不回任何 repo 內的東西。
function safeSourceRef(ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  const [filePart, lineNo] = raw.split(/:(?=\d+$)/);
  if (path.isAbsolute(filePart)) return null;
  const norm = path.posix.normalize(filePart.replace(/\\/g, '/'));
  if (!norm.startsWith('src/')) return null;
  const inner = norm.slice(4);
  // normalize 之後仍能往上跳＝一開始就跳出去了
  if (!inner || inner.startsWith('../') || inner.includes('/../')) return null;
  return lineNo ? `${inner}:${lineNo}` : inner;
}

function normalizeEvidence(raw) {
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
      if (e.ref) out.evidence.push({ kind: 'docs', ref: String(e.ref), excerpt: e.excerpt || null });
      continue;
    }
    const safe = safeSourceRef(e.ref);
    if (!safe) { out.rejected.push(String(e.ref || '(空)')); continue; }
    out.evidence.push({ kind: 'source', ref: safe, excerpt: e.excerpt || null });
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

function gatherEvidence({ question, options, candidate, odooVersion, onProgress, model = MODEL }) {
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

    child.stdin.write(buildEvidencePrompt({ question, options, candidate, odooVersion }));
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
        resolve({ result: normalizeEvidence(raw), usage, model });
      });
    });
  });
}

module.exports = {
  gatherEvidence, buildEvidencePrompt, normalizeEvidence, saveEvidence,
  needsEvidence, safeSourceRef, ensureEvidenceCwd, EVIDENCE_THRESHOLD,
};
