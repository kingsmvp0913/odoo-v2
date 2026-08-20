/**
 * agent-loader.js — 從 .claude/agents/<name>.md 載入 agent 定義（model + prompt）
 *
 * 每個 agent 檔為 Markdown + YAML frontmatter：
 *   ---
 *   name / role / label / description / model / stage
 *   ---
 *   <system prompt body，動態資料以 {{placeholder}} 標記>
 *
 * Exports:
 *   loadAgent(name)  → { name, role, label, description, model, stage, body, render(vars) }
 *   listAgents()     → [{ name, role, label, description, model, stage }]（不含 body）
 *   getLabels()      → { <stage>: <label> }（依 stage 去重）
 *   agentPath(name)  → 檔案絕對路徑（白名單用）
 *   invalidate(name?) → 清除快取
 *   ALLOWED_MODELS
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const crypto = require('crypto');

const AGENTS_DIR = path.join(__dirname, '..', '..', '..', '.claude', 'agents');
const CLAUDE_MD_PATH = path.join(__dirname, '..', '..', '..', '.claude', 'CLAUDE.md');
const ALLOWED_MODELS = ['haiku', 'sonnet', 'opus', 'fable'];

// 會實際碰客戶 Odoo repo（讀/寫程式碼、審查 diff）的 agent：CLAUDE.md 的 Odoo 開發規則對它們是唯一真相來源，
// 呼叫時自動 prepend；其餘 agent（分類器、merge、wiki、chat...）跟 Odoo 開發規範無關，不注入。
// 注入模式：'full'＝整份過濾後 CLAUDE.md；'qa'＝只注入審查相關段落（§1 Odoo Constraints＋Rule 12）——
// QA 只讀不寫，整份注入（Hard Rules 的寫入規範、前端配色、log 路徑等）是每輪固定的 token 浪費。
// qa-retry 不注入：只走 --resume，session 上下文已含 fresh 輪帶入的規則，
// 重複前置會佔掉 resume prompt 八成以上、抵銷「resume 只送短 feedback」的省 token 設計（健檢 U3）。
// （coding 已改無狀態單一 agent，無 coding-retry；coding-project 每輪 fresh、靠 prompt cache 省重送的規則。）
const CLAUDE_MD_AGENTS = new Map([
  ['analysis-project', 'full'], ['analysis-reject', 'full'],
  ['coding-project', 'full'], ['qa', 'qa'],
  ['playwright-spec', 'full'],
  ['spec-review', 'full'], ['clarify-chat', 'full']
]);

// 診斷／修復型關卡：注入濃縮版 systematic-debugging（headless-safe），遇失敗先找 root cause 再改。
const DEBUG_AGENTS = new Set(['analysis-reject', 'coding-project']);
const DEBUG_MD_PATH = path.join(__dirname, 'systematic-debugging.md');
let _debugCache = null;

// 在客戶 worktree 內作業、會碰程式碼／git 的關卡：注入「資料來源守則」（source-routing.md），
// 把平台已解析好的 repo 絕對路徑、base／任務分支直接填進 prompt——根治歷程實測的亂跑
// （猜 base 分支打成 main→fatal、pwd/ls 探路、猜子目錄名、掃硬碟找 Odoo 核心）。
// 片段用 {{repo_paths}}／{{main_branch}}／{{git_branch}} 佔位，呼叫端須一併傳入這三個真值。
const SOURCE_ROUTING_AGENTS = new Set([
  'analysis-project', 'coding-project', 'qa', 'qa-retry', 'analysis-reject',
  // playwright-spec 原本兩張名單都漏掉（只有 E2E 關的 playwright 在內），它的 prompt 只拿得到
  // 模組「名」拿不到路徑，於是實測跑出 `find / -maxdepth 6 -iname "idx_hj"` 全根掃碟——
  // 它自己 prompt 裡那條「不要掃碟」的禁令攔不住，因為缺的是路徑真值不是禁令（rules/agent-prompt 100）。
  'playwright-spec'
]);
const SOURCE_ROUTING_MD_PATH = path.join(__dirname, 'source-routing.md');
let _sourceRoutingCache = null;

// 會吃「使用者手寫專案備註」的關卡：開發五關（同吃 CLAUDE.md 那組）＋兩個對話關（chat／chat-to-task）。
// 備註是 per-project 動態值，由呼叫端 await getProjectNotes 後以 {{的姊妹}} project_notes var 傳入 render；
// 注入位置固定在「規則之後、debug 之前」——同專案跨任務前綴不變＝吃 prompt cache（空備註不注入以免破壞前綴）。
const NOTES_AGENTS = new Set([
  'analysis-project', 'analysis-reject', 'coding-project', 'qa', 'playwright-spec',
  'chat', 'chat-to-task', 'spec-review', 'clarify-chat'
]);

// 三個「跟使用者對話、又會動規格」的關卡（clarify-chat／spec-review／respec-patch）共用的查碼守則。
// 它們原本手上只有 analysis_yaml＋對話，連「使用者說的『客戶代號』是哪個 Field」都得回頭問人——
// 實測一輪澄清 8 個來回、6 分鐘、$1.4 還沒推進，比讓它自己 grep 一次貴得多。
// 片段用 {{repo_paths}} 佔位，呼叫端須傳入真值，並把 runClaude 的 cwd 指到同一個 worktree。
const SPEC_LOOKUP_AGENTS = new Set(['clarify-chat', 'spec-review', 'respec-patch']);
const SPEC_LOOKUP_MD_PATH = path.join(__dirname, 'spec-lookup.md');
let _specLookupCache = null;

function loadSpecLookup() {
  const stat = fs.statSync(SPEC_LOOKUP_MD_PATH);
  if (_specLookupCache && _specLookupCache.mtimeMs === stat.mtimeMs) return _specLookupCache.text;
  const text = fs.readFileSync(SPEC_LOOKUP_MD_PATH, 'utf8').trim();
  _specLookupCache = { mtimeMs: stat.mtimeMs, text };
  return text;
}

// 以下三個片段是 2026-08-20 第二輪去重的產物。抽取判準不是「重複幾次」而是「會不會漂移」：
// 這三組在各 body 的措辭都已各自演化（例外條款有的有有的沒有、例子不同、第三條的問法提示只有兩份有），
// 於是同一件事在不同關拿到不同強度的指示。反之「Think in English…保留英文術語」那句雖然也重複 5 份，
// 卻是逐字相同且內容穩定到不會漂移，抽出來只是多一個檔要維護——刻意不抽。

// 「這三種一律要問」：走完發問守則的決策樹後不准剪掉的底線。四關共用。
const MUST_ASK_AGENTS = new Set(['analysis-project', 'clarify-chat', 'respec-patch', 'spec-review']);
const MUST_ASK_MD_PATH = path.join(__dirname, 'must-ask.md');
let _mustAskCache = null;

function loadMustAsk() {
  const stat = fs.statSync(MUST_ASK_MD_PATH);
  if (_mustAskCache && _mustAskCache.mtimeMs === stat.mtimeMs) return _mustAskCache.text;
  const text = fs.readFileSync(MUST_ASK_MD_PATH, 'utf8').trim();
  _mustAskCache = { mtimeMs: stat.mtimeMs, text };
  return text;
}

// 「平台讀不到 Figma」：共同核心抽出來，各關拿到細節後走哪個出口仍留在自己 body。
// 含 chat／cs——這兩關原本從 cs-capability.md 拿到同一段，改由本片段供應（搬家，非新增）。
const FIGMA_AGENTS = new Set(['analysis-project', 'clarify-chat', 'respec-patch', 'spec-review', 'chat', 'cs']);
const FIGMA_MD_PATH = path.join(__dirname, 'figma-unavailable.md');
let _figmaCache = null;

function loadFigma() {
  const stat = fs.statSync(FIGMA_MD_PATH);
  if (_figmaCache && _figmaCache.mtimeMs === stat.mtimeMs) return _figmaCache.text;
  const text = fs.readFileSync(FIGMA_MD_PATH, 'utf8').trim();
  _figmaCache = { mtimeMs: stat.mtimeMs, text };
  return text;
}

// 「既有視覺值不准憑印象改」：規格的保護端兩關。產生端（analysis-project 量截圖）規則不同，不吃這片段；
// spec-review-retry 走 --resume 繼承上一輪，body 只留一句摘要（rules/agent-prompt 104）。
const VISUAL_VALUES_AGENTS = new Set(['spec-review', 'respec-patch']);
const VISUAL_VALUES_MD_PATH = path.join(__dirname, 'visual-values.md');
let _visualValuesCache = null;

function loadVisualValues() {
  const stat = fs.statSync(VISUAL_VALUES_MD_PATH);
  if (_visualValuesCache && _visualValuesCache.mtimeMs === stat.mtimeMs) return _visualValuesCache.text;
  const text = fs.readFileSync(VISUAL_VALUES_MD_PATH, 'utf8').trim();
  _visualValuesCache = { mtimeMs: stat.mtimeMs, text };
  return text;
}

// 會輸出 clarification_channel.questions 結構化題目的三關共用的「題目撰寫契約」（questions-contract.md）。
// 原本三份各自手抄、且已經漂移（analysis-project 有 `depends_on` 的完整語法，clarify-chat 只寫「用 depends_on 表達」）。
// clarify-chat-retry 刻意不注入：它靠 --resume 繼承上一輪對話，重送等於重複佔 context（rules/agent-prompt 104）。
const QUESTIONS_CONTRACT_AGENTS = new Set(['analysis-project', 'clarify-chat', 'respec-patch']);
const QUESTIONS_CONTRACT_MD_PATH = path.join(__dirname, 'questions-contract.md');
let _questionsContractCache = null;

function loadQuestionsContract() {
  const stat = fs.statSync(QUESTIONS_CONTRACT_MD_PATH);
  if (_questionsContractCache && _questionsContractCache.mtimeMs === stat.mtimeMs) return _questionsContractCache.text;
  const text = fs.readFileSync(QUESTIONS_CONTRACT_MD_PATH, 'utf8').trim();
  _questionsContractCache = { mtimeMs: stat.mtimeMs, text };
  return text;
}

// chat 與 cs 共用的「技術客服調查能力」片段（cs-capability.md）：唯一真相來源，改一處兩邊生效。
// 片段用 {{project_name}}／{{repo_paths}} 佔位，呼叫端 render 時須一併傳入這兩個真值。
const CS_CAPABILITY_AGENTS = new Set(['chat', 'cs']);
const CS_CAPABILITY_MD_PATH = path.join(__dirname, 'cs-capability.md');
let _csCapabilityCache = null;

function loadCsCapability() {
  const stat = fs.statSync(CS_CAPABILITY_MD_PATH);
  if (_csCapabilityCache && _csCapabilityCache.mtimeMs === stat.mtimeMs) return _csCapabilityCache.text;
  const text = fs.readFileSync(CS_CAPABILITY_MD_PATH, 'utf8').trim();
  _csCapabilityCache = { mtimeMs: stat.mtimeMs, text };
  return text;
}

// 會產出「給人看的文字」的關卡：注入說人話守則（plain-language.md）。刻意不走 CLAUDE.md——
// CLAUDE.md 只餵得到 7 關，漏掉 cs／merge-explain／merge-clarify／chat／chat-to-task／library，
// 而這些正是最需要白話的地方；反之 playwright／coding-project 產的是碼，沒人讀，注入純屬浪費。
// 片段無 placeholder（全平台不變的靜態文字），故排在「規則之後、專案備註之前」——
// 靜態的排前面才能讓 prompt cache 前綴儘量長。
const PLAIN_LANGUAGE_AGENTS = new Set([
  'analysis-project', 'analysis-reject', 'clarify-chat', 'spec-review', 'qa',
  'merge-explain', 'merge-clarify', 'cs', 'chat', 'chat-to-task', 'library'
]);
const PLAIN_LANGUAGE_MD_PATH = path.join(__dirname, 'plain-language.md');
let _plainLanguageCache = null;

function loadPlainLanguage() {
  const stat = fs.statSync(PLAIN_LANGUAGE_MD_PATH);
  if (_plainLanguageCache && _plainLanguageCache.mtimeMs === stat.mtimeMs) return _plainLanguageCache.text;
  const text = fs.readFileSync(PLAIN_LANGUAGE_MD_PATH, 'utf8').trim();
  _plainLanguageCache = { mtimeMs: stat.mtimeMs, text };
  return text;
}

// 會產出「要使用者回答的問題」的四關：注入發問守則（asking-well.md）。同樣刻意不走 CLAUDE.md——
// CLAUDE.md `full` 那 7 關裡 coding-project／playwright 根本不產題目，注入是每輪固定浪費；
// 反過來 cs 拿不到 CLAUDE.md，卻是最常直接問客戶問題的關。qa 的 spec_questions 屬低頻出口，
// 暫不納入（它每輪必跑，是最貴的注入點）。
// spec-review／respec-patch 也不在此列，但**理由與上面那句不同**：兩者 body 都有完整的「什麼情況一定要反問」
// 規則（不是「不提問」——那個說法是錯的，2026-08-20 更正），只是各自寫在 body 裡；它們吃的是
// QUESTIONS_CONTRACT_AGENTS 的格式契約。要不要連發問守則也一併注入，取決於願不願意為兩個低頻關各加 2.4KB。
// 片段無 placeholder（全平台不變的靜態文字），排在說人話之後、專案備註之前——靜態的排前面保 prompt cache 前綴。
const ASKING_WELL_AGENTS = new Set([
  'analysis-project', 'clarify-chat', 'analysis-reject', 'cs'
]);
const ASKING_WELL_MD_PATH = path.join(__dirname, 'asking-well.md');
let _askingWellCache = null;

function loadAskingWell() {
  const stat = fs.statSync(ASKING_WELL_MD_PATH);
  if (_askingWellCache && _askingWellCache.mtimeMs === stat.mtimeMs) return _askingWellCache.text;
  const text = fs.readFileSync(ASKING_WELL_MD_PATH, 'utf8').trim();
  _askingWellCache = { mtimeMs: stat.mtimeMs, text };
  return text;
}

// name → { mtimeMs, agent }
const _cache = new Map();
// CLAUDE.md 過濾後內容快取（mtime-based，同 agent 快取手法）
let _rulesCache = null;

// 只切「裸 --- 行」作為 frontmatter 邊界，避免誤切 body 內的 ---RESULT-JSON--- 等標記
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parse(raw) {
  const m = raw.match(FM_RE);
  if (!m) throw new Error('agent 檔缺少 frontmatter');
  const meta = yaml.load(m[1], { schema: yaml.CORE_SCHEMA }) || {};
  return { meta, body: m[2] };
}

// CLAUDE.md 中夾在 <!-- platform-only --> ... <!-- /platform-only --> 之間的段落是本平台自己
// 開發用（Skills、app/public 前端規範），跟客戶 Odoo repo 無關，過濾掉才 prepend 給 pipeline agent。
function loadPipelineRules() {
  const stat = fs.statSync(CLAUDE_MD_PATH);
  if (_rulesCache && _rulesCache.mtimeMs === stat.mtimeMs) return _rulesCache.text;
  const raw = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
  const text = raw
    .replace(/<!-- platform-only -->[\s\S]*?<!-- \/platform-only -->\n?/g, '')
    .replace(/(\r?\n){3,}/g, '\n\n')
    .trim();
  _rulesCache = { mtimeMs: stat.mtimeMs, text };
  return text;
}

// QA 精簡規則：只取「§1 Odoo Constraints」＋「§2 Python Constraints」全文＋「Rule 12 fail-loud」段落。
// QA 是唯讀審查者，Hard Rules／Edit Protocol／前端規範對它無作用卻每輪照付 token。
let _qaRulesCache = null;
function loadQaRules() {
  const stat = fs.statSync(CLAUDE_MD_PATH);
  if (_qaRulesCache && _qaRulesCache.mtimeMs === stat.mtimeMs) return _qaRulesCache.text;
  const full = loadPipelineRules();
  const odoo = full.match(/## 1\. Odoo Constraints[\s\S]*?(?=\n## |$)/);
  const python = full.match(/## 2\. Python Constraints[\s\S]*?(?=\n## |$)/);
  const rule12 = full.match(/\*\*Rule 12[^\n]*[\s\S]*?(?=\n\n|$)/);
  const text = [
    '# 審查依據（節錄自專案 CLAUDE.md）',
    odoo ? odoo[0].trim() : '',
    python ? python[0].trim() : '',
    rule12 ? rule12[0].trim() : ''
  ].filter(Boolean).join('\n\n');
  _qaRulesCache = { mtimeMs: stat.mtimeMs, text };
  return text;
}

function loadDebugMethodology() {
  const stat = fs.statSync(DEBUG_MD_PATH);
  if (_debugCache && _debugCache.mtimeMs === stat.mtimeMs) return _debugCache.text;
  const text = fs.readFileSync(DEBUG_MD_PATH, 'utf8').trim();
  _debugCache = { mtimeMs: stat.mtimeMs, text };
  return text;
}

function loadSourceRouting() {
  const stat = fs.statSync(SOURCE_ROUTING_MD_PATH);
  if (_sourceRoutingCache && _sourceRoutingCache.mtimeMs === stat.mtimeMs) return _sourceRoutingCache.text;
  const text = fs.readFileSync(SOURCE_ROUTING_MD_PATH, 'utf8').trim();
  _sourceRoutingCache = { mtimeMs: stat.mtimeMs, text };
  return text;
}

// {{placeholder}} 替換：漏傳的替成空字串、agent 收到空洞 prompt 照常執行＝最難察覺的準確性殺手 → 至少留告警（健檢 F）
function fillPlaceholders(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (vars && vars[k] != null) return String(vars[k]);
    console.warn(`[AGENT-RENDER] 未匹配 placeholder：{{${k}}}（以空字串替換）`);
    return '';
  });
}

function makeRender(body, rulesMode, includeDebug, includeSourceRouting, includeNotes, includeCsCapability, includePlainLanguage, includeSpecLookup, includeAskingWell, includeQuestionsContract, includeMustAsk, includeFigma, includeVisualValues) {
  return vars => {
    let out = fillPlaceholders(body, vars);
    // 題目撰寫契約：最貼近 body（它規範的是 body 的輸出格式），且無 placeholder、內容全平台固定
    if (includeQuestionsContract) out = `${loadQuestionsContract()}\n\n${out}`;
    // 視覺值 → figma → 必問三種：全靜態、無 placeholder。順序讓 visual-values 的「理由見上方【figma】」
    // 指得到東西（prepend 順序相反，故 figma 要後 prepend 才會排在 visual-values 上方）
    if (includeVisualValues) out = `${loadVisualValues()}\n\n${out}`;
    if (includeFigma) out = `${loadFigma()}\n\n${out}`;
    if (includeMustAsk) out = `${loadMustAsk()}\n\n${out}`;
    // 查碼守則：與 sourceRouting 同層級（含已解析的 repo 路徑），緊貼 body 上方最顯眼。
    // 沒有 repo_paths（任務尚無 worktree）就整段不注入——給了路徑卻是空的只會讓 agent 亂找。
    if (includeSpecLookup && vars && String(vars.repo_paths || '').trim()) {
      out = `${fillPlaceholders(loadSpecLookup(), vars)}\n\n${out}`;
    }
    // 技術客服能力片段：緊貼 body 上方（最內層、最貼近該關輸出契約）
    if (includeCsCapability) out = `${fillPlaceholders(loadCsCapability(), vars)}\n\n${out}`;
    // source-routing 用同一組 vars 填入已解析的 repo 路徑／分支，緊貼 body 上方（最貼近任務、最顯眼）
    if (includeSourceRouting) out = `${fillPlaceholders(loadSourceRouting(), vars)}\n\n${out}`;
    if (includeDebug) out = `${loadDebugMethodology()}\n\n${out}`;
    // 專案備註排在 debug 之後、規則之前 → 最終 top→bottom：規則 → 說人話 → 發問守則 → 備註 → debug → sourceRouting → csCapability → body。
    // 空／未傳不注入，維持與現況一致的 cache 前綴。
    if (includeNotes && vars && vars.project_notes && String(vars.project_notes).trim()) {
      out = `# 專案備註（人工維護，優先遵循）\n\n${String(vars.project_notes).trim()}\n\n${out}`;
    }
    // 發問守則與說人話同為靜態片段，兩者相鄰擺在備註之前，讓 cache 前綴儘量長
    if (includeAskingWell) out = `${loadAskingWell()}\n\n${out}`;
    // 說人話守則排在「規則之後、備註之前」（prepend 順序相反）：靜態片段先於 per-project 動態值，保 cache 前綴
    if (includePlainLanguage) out = `${loadPlainLanguage()}\n\n${out}`;
    if (rulesMode === 'full') out = `${loadPipelineRules()}\n\n${out}`;
    else if (rulesMode === 'qa') out = `${loadQaRules()}\n\n${out}`;
    return out;
  };
}

function agentPath(name) {
  return path.join(AGENTS_DIR, `${name}.md`);
}

function loadAgent(name) {
  const file = agentPath(name);
  const stat = fs.statSync(file); // throws if missing → caller handles
  const cached = _cache.get(name);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.agent;

  const { meta, body } = parse(fs.readFileSync(file, 'utf8'));
  const agent = {
    name: meta.name || name,
    role: meta.role || '',
    label: meta.label || meta.name || name,
    description: meta.description || '',
    model: meta.model || 'sonnet',
    stage: meta.stage || '',
    body,
    render: makeRender(body, CLAUDE_MD_AGENTS.get(meta.name || name) || false, DEBUG_AGENTS.has(meta.name || name), SOURCE_ROUTING_AGENTS.has(meta.name || name), NOTES_AGENTS.has(meta.name || name), CS_CAPABILITY_AGENTS.has(meta.name || name), PLAIN_LANGUAGE_AGENTS.has(meta.name || name), SPEC_LOOKUP_AGENTS.has(meta.name || name), ASKING_WELL_AGENTS.has(meta.name || name), QUESTIONS_CONTRACT_AGENTS.has(meta.name || name), MUST_ASK_AGENTS.has(meta.name || name), FIGMA_AGENTS.has(meta.name || name), VISUAL_VALUES_AGENTS.has(meta.name || name))
  };
  _cache.set(name, { mtimeMs: stat.mtimeMs, agent });
  return agent;
}

function listNames() {
  return fs.readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3));
}

function listAgents() {
  return listNames().map(name => {
    const a = loadAgent(name);
    return { name: a.name, role: a.role, label: a.label, description: a.description, model: a.model, stage: a.stage };
  });
}

function getLabels() {
  const out = {};
  for (const a of listAgents()) {
    if (a.stage && !out[a.stage]) out[a.stage] = a.label;
  }
  return out;
}

function invalidate(name) {
  if (name) _cache.delete(name);
  else _cache.clear();
}

// 靜態系統提示的版本指紋（注入的 CLAUDE.md 規則 ＋ 說人話守則 ＋ systematic-debugging ＋ agent body，與 makeRender 同組成，
// 但不含 per-task 的 {{placeholder}} 替換）。供 session 綁定：建 session 時記下版本，resume 前比對——
// prompt 內容變了（改 agent／CLAUDE.md／debug 方法論）就強制 fresh，讓新指令生效；沒變則照常 resume 省 token。
function promptVersion(name) {
  const agent = loadAgent(name);
  const mode = CLAUDE_MD_AGENTS.get(name) || false;
  let s = agent.body;
  if (QUESTIONS_CONTRACT_AGENTS.has(name)) s = `${loadQuestionsContract()}\n\n${s}`;
  if (VISUAL_VALUES_AGENTS.has(name)) s = `${loadVisualValues()}\n\n${s}`;
  if (FIGMA_AGENTS.has(name)) s = `${loadFigma()}\n\n${s}`;
  if (MUST_ASK_AGENTS.has(name)) s = `${loadMustAsk()}\n\n${s}`;
  if (SPEC_LOOKUP_AGENTS.has(name)) s = `${loadSpecLookup()}\n\n${s}`;
  if (CS_CAPABILITY_AGENTS.has(name)) s = `${loadCsCapability()}\n\n${s}`;
  if (SOURCE_ROUTING_AGENTS.has(name)) s = `${loadSourceRouting()}\n\n${s}`;
  if (DEBUG_AGENTS.has(name)) s = `${loadDebugMethodology()}\n\n${s}`;
  if (ASKING_WELL_AGENTS.has(name)) s = `${loadAskingWell()}\n\n${s}`;
  if (PLAIN_LANGUAGE_AGENTS.has(name)) s = `${loadPlainLanguage()}\n\n${s}`;
  if (mode === 'full') s = `${loadPipelineRules()}\n\n${s}`;
  else if (mode === 'qa') s = `${loadQaRules()}\n\n${s}`;
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/**
 * 更新 agent 的 model 與 prompt body，寫回 .md（保留其餘 frontmatter 原樣）。
 * 錯誤以 err.status 標記（404 未知 name / 400 非法 model）。
 */
function updateAgent(name, { model, prompt } = {}) {
  if (!listNames().includes(name)) {
    const e = new Error(`未知的 agent：${name}`); e.status = 404; throw e;
  }
  if (model != null && !ALLOWED_MODELS.includes(model)) {
    const e = new Error(`不支援的 model：${model}（僅允許 ${ALLOWED_MODELS.join(' / ')}）`); e.status = 400; throw e;
  }

  const raw = fs.readFileSync(agentPath(name), 'utf8');
  const m = raw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/);
  if (!m) { const e = new Error('agent 檔缺少 frontmatter'); e.status = 500; throw e; }

  let fmBlock = m[1];
  let body = m[2];

  if (model != null) {
    fmBlock = /^model:.*$/m.test(fmBlock)
      ? fmBlock.replace(/^model:.*$/m, `model: ${model}`)
      : fmBlock.replace(/\r?\n---(\r?\n?)$/, `\nmodel: ${model}\n---$1`);
  }
  if (prompt != null) {
    // 防 UI 編輯改壞輸出契約（健檢 F）：舊 body 有 <result> 則新 prompt 也必須有；舊有的 {{placeholder}} 不得被移除
    if (body.includes('<result>') && !prompt.includes('<result>')) {
      const e = new Error('更新遭拒：prompt 移除了輸出契約標記 <result>，會讓下一輪任務無法解析而 stopped'); e.status = 400; throw e;
    }
    const oldPh = new Set(body.match(/\{\{\w+\}\}/g) || []);
    const newPh = new Set(prompt.match(/\{\{\w+\}\}/g) || []);
    const removed = [...oldPh].filter(p => !newPh.has(p));
    if (removed.length) {
      const e = new Error(`更新遭拒：prompt 移除了既有 placeholder ${removed.join('、')}，JS 端仍會傳入對應資料`); e.status = 400; throw e;
    }
    body = prompt.endsWith('\n') ? prompt : prompt + '\n';
  }

  fs.writeFileSync(agentPath(name), fmBlock + body);
  invalidate(name);
  return loadAgent(name);
}

module.exports = { loadAgent, listAgents, listNames, getLabels, agentPath, invalidate, updateAgent, promptVersion, AGENTS_DIR, ALLOWED_MODELS };
