/**
 * runagent-userid-guard.test.js — 防止「以後新增的 runAgent／runClaude 呼叫端忘記帶 userId」
 * （規格 §7、裁決 R19／R20／fix round 3）
 *
 * 這一支不測行為，測的是「每一支會實際觸發 Claude 執行的地方，都把發起人的 userId 帶進去」
 * 這個結構性事實。為什麼需要：canRun（公司可用性檢查，在 sandbox-run.js 的 prepareSandboxRun
 * 裡）與 Codex 守衛（isUserCompanyInternal）都只看 opts.userId——沒帶 userId 不會有任何徵狀，
 * 就是安靜地放行，公司停用了照樣繼續燒 AI 的錢。
 *
 * ⚠ fix round 3 訂正（見 task-7-report.md 同日期段落）：canRun 真正掛在 `runClaude`
 * （`prepareSandboxRun` 在 claude-runner.js 內被呼叫），不是 `runAgent`——`runAgent` 只是
 * claude／codex 兩個 provider 的分派層，provider='claude' 時原封轉呼叫 `runClaude`。只掃
 * `runAgent` 守到的是一部分路徑，round 3 起本檔同時掃描 `runAgent(` 與 `runClaude(` 兩種
 * 字面呼叫。round 2 曾誤判 `merge-agent.js` 三個 agentType（merge／merge-explain／
 * merge-clarify）沒帶 userId——那是誤讀：它們透過 `{ ...opts }`／`{ ...runOpts }` 展開，
 * opts／runOpts 由外層 `resolveConflict`／`explainConflict`／`clarifyConflict` 的呼叫端用
 * 字面物件 `{ taskId, userId, ... }` 建構後傳入，userId 確實有到——round 2 只看到
 * `resolveConflict` 內部另一個純粹用於記帳的 `refUser` 區域變數就下結論，沒有追完整條
 * 資料流。已在下面用專屬測試改為「查那 4 個入口函式的呼叫端」，不再誤判。
 *
 * 走訪全樹而不是寫死檔名清單：寫死清單只涵蓋當初改到的那幾支，之後新增的檔案不會被掃到。
 *
 * 已知盲區（守衛看不見，不在本測試範圍內修，比照 tenant-route-guard.test.js 的前例列出）：
 * - **正則看不穿物件展開／變數轉手，這件事同時造成兩個方向的風險**：
 *   (a) 有帶 userId 的呼叫可能被誤判成沒帶——round 2 的 merge-agent.js 誤判就是這樣來的；
 *       為了不重蹈覆轍，本檔對「已知會展開的入口」（`withResume`、`resolveConflict`／
 *       `resolveConflicts`／`explainConflict`／`clarifyConflict`）改成往上一層查「呼叫端
 *       傳的物件字面上有沒有 userId」，而不是逕自判它們沒帶。
 *   (b) 反過來，沒帶 userId 的呼叫也可能因為展開而躲過本檔的字面掃描——如果以後有人在
 *       `resolveConflict` 與這幾個入口之間，插入一層新的轉手函式（例如再包一層
 *       `resolveConflictWrapper(opts)` 去呼叫 `resolveConflict`），本檔只查到「目前已知的
 *       4 個入口函式」的呼叫端，看不到新插入的那一層是否把 userId 弄丟。
 * - `pipeline/task-agent.js` 的 `runOpts`（spec_tour）用「同檔案內往前找最後一個
 *   `const runOpts = {...}`」的方式驗證——如果同一個檔案裡出現第二個同名的 `runOpts`
 *   （不同函式），本檔的「取呼叫點之前最後一次宣告」邏輯可能配對到錯的宣告。目前檔案內只有
 *   一個 `const runOpts`，尚未踩到這個風險。
 * - 用變數組出來的呼叫（例如把 `runAgent`／`runClaude`／`withResume` 存進另一個變數再呼叫）
 *   本守衛完全看不到，比照 tenant-route-guard.test.js 的同類盲區。
 */
const fs = require('fs');
const path = require('path');

const serverDir = path.join(__dirname, '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  if (e.name === 'node_modules' || e.name === 'tests') return [];
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
});

// 從「開括號」位置開始，數配對括號取出括號內文字（不含頭尾括號本身）。openChar/closeChar
// 讓同一支既能取 `(...)` 呼叫參數，也能取 `{...}` 物件字面量。
function extractBalanced(src, openIdx, openChar = '(', closeChar = ')') {
  let depth = 1, i = openIdx + 1;
  const start = i;
  while (depth > 0 && i < src.length) {
    if (src[i] === openChar) depth++;
    else if (src[i] === closeChar) depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

// 找出檔案裡所有「呼叫」（非定義）某函式的括號內文字，連同呼叫起點位置一併回傳
// （供「同檔往前找變數宣告」的檢查使用）。
function findCalls(src, fnName) {
  const calls = [];
  const re = new RegExp(`\\b${fnName}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s*$/.test(before)) continue; // 排除函式定義本身
    const openParenIdx = m.index + m[0].length - 1;
    calls.push({ at: m.index, body: extractBalanced(src, openParenIdx, '(', ')') });
  }
  return calls;
}
const findCallBodies = (src, fnName) => findCalls(src, fnName).map(c => c.body);

// 在 call 之前，同檔找最後一個 `const/let <name> = {...}` 宣告，回其物件字面文字；找不到回 null。
function resolveLocalObjectLiteral(src, name, beforeIdx) {
  const re = new RegExp(`\\b(?:const|let)\\s+${name}\\s*=\\s*\\{`, 'g');
  let m, last = null;
  while ((m = re.exec(src)) && m.index < beforeIdx) last = m;
  if (!last) return null;
  return extractBalanced(src, last.index + last[0].length - 1, '{', '}');
}

// 真正沒有發起人（架構上不可能有客戶身分流過）的呼叫，放進明確的 allow-list。
// 每一筆的 reason 都對過 lib/agent-profiles.js 的 scope 登記與實際呼叫端，不是從檔名猜的。
const ALLOWLIST = [
  {
    file: 'pipeline/health-check-runner.js',
    match: /agentType:\s*'workflow_health'/,
    reason: '健檢是平台對自己 pipeline 的健康稽核，不是替某個客戶做事。scope=internal-audit' +
      '（agent-profiles.js）。呼叫端只有兩處（admin-routes.js 手動觸發、cron.js 排程觸發）：' +
      '手動觸發那兩支路由掛的是 [verifyToken, requireAdmin]，起單者只可能是平台管理員（沒有' +
      '公司）；排程觸發則 startedBy 恆為 undefined。這條路徑架構上不可能有客戶身分流過。',
  },
  {
    file: 'pipeline/fix-review.js',
    match: /agentType:\s*'fix_review'/,
    reason: 'scope=internal-fix（agent-profiles.js）：審的是平台自己健檢提案的修正 diff，' +
      '不是客戶的任務。呼叫端記帳固定傳 { taskId: null, projectId: null }, null，本來就沒有' +
      '客戶身分可傳。',
  },
  {
    file: 'pipeline/feedback-merge.js',
    match: /agentType:\s*'feedback_merge'/,
    reason: 'scope=internal-fix（agent-profiles.js）：把當晚健檢候選意見合併去重，同樣是平台' +
      '對自己的維運工作，記帳固定傳 { taskId: null, projectId: null }, null。',
  },
  {
    file: 'pipeline/fix-verify.js',
    match: /agentType:\s*'fix_verify'/,
    reason: 'scope=internal-fix（agent-profiles.js）：對平台自己的修正 diff 跑 jest／node --check' +
      '複驗，記帳固定傳 { taskId: null, projectId: null }, null，不服務任何客戶任務。',
  },
  {
    file: 'pipeline/finding-fix.js',
    match: /agentType:\s*'platform_fix'/,
    reason: 'scope=internal-fix（agent-profiles.js）：改的是平台自己的程式／提示詞。startedBy' +
      '只有兩種來源——admin-routes.js:832 的路由掛 [verifyToken, requireAdmin]（只可能是平台' +
      '管理員，沒有公司）；nightly-fix.js 的自動改善通道預設 startedBy=null（無人監督）。' +
      '架構上不可能有客戶身分流過，就算補傳 startedBy 也不影響 canRun 的判斷（平台管理員沒有' +
      '公司，isUserCompanyUsable 恆真）。',
  },
  {
    file: 'admin-routes.js',
    match: /agentType:\s*'auth_probe'/,
    reason: 'scope=none（agent-profiles.js）：管理員測試自己剛貼上的 Claude OAuth token 能不能' +
      '用，掛在 [verifyToken, requireAdmin] 底下，背後沒有任何任務／專案，純粹是設定頁的' +
      '「驗證一下」按鈕，跟客戶的公司狀態無關。',
  },
];

// 已知會把 opts 用「展開」或「裸變數」轉手、字面掃描看不到 userId 的入口函式。
// 每一項都用專屬測試往呼叫端查，不放進上面主測試的 allow-list（那是給「真的沒有發起人」用的）。
const PASSTHROUGH_FUNCTIONS = ['withResume', 'resolveConflict', 'resolveConflicts', 'explainConflict', 'clarifyConflict'];
// 這些檔案本身只轉手 opts，不是 userId 的來源，排除在主檢查之外（各自的專屬測試已覆蓋）：
const PASSTHROUGH_FILES = new Set(['pipeline/with-resume.js', 'pipeline/merge-agent.js']);

const files = walk(serverDir);

test('掃到的檔案數量合理（走訪壞掉時這一支會先紅，而不是讓守衛靜默空轉）', () => {
  expect(files.length).toBeGreaterThanOrEqual(20);
});

// 上面「檔案數量合理」防的是走訪壞掉；這一支防的是「檔案走訪都還在，但 findCalls 的 regex
// 壞掉」——那種壞法 offenders 陣列一樣會是空的（regex 配不到任何呼叫＝沒有東西可以違規），
// 底下兩支測試照樣全綠，守衛在不出聲的狀況下完全失能。獨立量測全庫（含 allow-list／
// PASSTHROUGH_FILES 排除掉的 3 個檔案）實際呼叫點：19 個 runClaude ＋ 13 個 runAgent ＝ 32
// （量法：與本檔同一套 findCalls，但不排除 agent-runner.js／merge-agent.js／with-resume.js，
// 見 finalfix-2 報告）。地板抓在略低於實測值，容許之後正常增修新呼叫點。
test('掃到的 runAgent／runClaude 呼叫點總數合理（regex 壞掉時這一支會先紅）', () => {
  let total = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    total += findCalls(src, 'runAgent').length + findCalls(src, 'runClaude').length;
  }
  expect(total).toBeGreaterThanOrEqual(28);
});

test('每一支直接呼叫 runAgent／runClaude 的地方都帶了 userId（allow-list 之外）', () => {
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(serverDir, file);
    if (rel === 'pipeline/agent-runner.js') continue; // 定義檔＋轉手 runAgent 自己的 opts（呼叫端已在本測試查過）
    if (PASSTHROUGH_FILES.has(rel)) continue; // 展開轉手，交下面專屬測試查呼叫端
    const src = fs.readFileSync(file, 'utf8');
    for (const fnName of ['runAgent', 'runClaude']) {
      for (const { at, body: call } of findCalls(src, fnName)) {
        if (/\buserId\b/.test(call)) continue; // 字面上就有，直接過
        const allowed = ALLOWLIST.find(a => a.file === rel && a.match.test(call));
        if (allowed) continue;
        // 展開／裸變數轉手：往同檔前面找那個變數的區域宣告再驗一次。
        const spreadMatch = call.match(/\.\.\.(\w+)/);
        const bareMatch = call.match(/,\s*(\w+)\s*\)?$/); // 第二參數是裸識別字（如 runClaude(prompt, runOpts)）
        const varName = spreadMatch ? spreadMatch[1] : (bareMatch ? bareMatch[1] : null);
        if (varName) {
          const localObj = resolveLocalObjectLiteral(src, varName, at);
          if (localObj != null) {
            if (/\buserId\b/.test(localObj)) continue; // 同檔區域變數驗過，有帶
            offenders.push(`${rel}: ${fnName}(...) 的區域變數 ${varName} = {${localObj.slice(0, 120)}…} 沒有 userId`);
            continue;
          }
        }
        offenders.push(`${rel}: ${fnName}(${call.slice(0, 120)}…)`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test('withResume／merge 衝突處理的入口函式，呼叫端都用字面物件帶了 userId', () => {
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(serverDir, file);
    const src = fs.readFileSync(file, 'utf8');
    for (const fnName of PASSTHROUGH_FUNCTIONS) {
      // findCalls 本身已經排除函式定義（緊接在 `function ` 後面那個），這裡不必再排除定義檔——
      // merge-agent.js 內部就有 resolveConflicts 呼叫 resolveConflict／explainConflict 的真實呼叫，要查得到。
      for (const call of findCallBodies(src, fnName)) {
        // withResume 的 userId 包在 runOpts:{...} 子物件裡；merge 系列則是扁平物件的最後一個參數。
        const runOptsMatch = call.match(/runOpts:\s*\{/);
        const target = runOptsMatch ? extractBalanced(call, runOptsMatch.index + runOptsMatch[0].length - 1, '{', '}') : call;
        if (!/\buserId\b/.test(target)) {
          offenders.push(`${rel}: ${fnName}(${call.slice(0, 120)}…)`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});
