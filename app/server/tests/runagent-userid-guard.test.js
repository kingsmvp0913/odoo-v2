/**
 * runagent-userid-guard.test.js — 防止「以後新增的 runAgent 呼叫端忘記帶 userId」（規格 §7、裁決 R19）
 *
 * 這一支不測行為，測的是「每一支呼叫 runAgent 的地方，都把發起人的 userId 帶進去」這個結構性事實。
 * 為什麼需要：canRun（公司可用性檢查）與 Codex 守衛（isUserCompanyInternal）都只看
 * opts.userId——沒帶 userId 不會有任何徵狀，就是安靜地放行，公司停用了照樣繼續燒 AI 的錢。
 * 這正是裁決 R19 抓到的 Critical：brief 原本假設呼叫端都會帶 userId，實測 13 個呼叫點裡有
 * 5 個沒帶（6 種 CODEX_ELIGIBLE agent 裡有 5 種都在這 5 個裡）。
 *
 * 走訪全樹而不是寫死檔名清單：寫死清單只涵蓋當初改到的那幾支，之後新增的檔案不會被掃到。
 *
 * 已知盲區（守衛看不見，不在本測試範圍內修，比照 tenant-route-guard.test.js 的前例列出）：
 * - **`runClaude` 直接呼叫端完全不在本守衛掃描範圍內**——本守衛只認字面上寫 `runAgent(` 的呼叫。
 *   `merge-agent.js` 的三個 agentType（merge／merge-explain／merge-clarify）繞過 `runAgent`、
 *   直接呼叫 `runClaude(prompt, { ...opts, ... })`，同樣會經過 canRun（`runClaude` 內部一樣會
 *   起 sandbox-run），但 opts 裡同樣沒有 userId（`resolveConflict` 只把 `refUser` 拿去記帳，
 *   沒有放進丟給 `runClaude` 的 opts）——這是 fix round 2 審查過程中新發現、與 R19 同一類但
 *   不在其列舉範圍內的缺口，已個別回報，不在本測試的斷言範圍。
 * - **`{ ...runOpts, ... }` 這種展開寫法本身看不到字面 `userId`**：`with-resume.js` 的兩個
 *   呼叫點因此改成下推一層——另外去查「呼叫 withResume 的地方，它們自己的 runOpts 物件字面上
 *   有沒有 userId」。但如果以後有人寫成「先組出 runOpts 變數、隔了好幾行才呼叫 withResume」，
 *   變數賦值處與呼叫處不在同一段擷取範圍內，一樣會被本守衛看漏。
 * - 用變數組出來的呼叫（例如把 `runAgent`／`withResume` 存進另一個變數再呼叫）本守衛看不到，
 *   比照 tenant-route-guard.test.js 的同類盲區。
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

// 找出檔案裡所有「呼叫」（非定義）某函式的括號內文字
function findCallBodies(src, fnName) {
  const bodies = [];
  const re = new RegExp(`\\b${fnName}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s*$/.test(before)) continue; // 排除函式定義本身
    const openParenIdx = m.index + m[0].length - 1;
    bodies.push(extractBalanced(src, openParenIdx, '(', ')'));
  }
  return bodies;
}

// 真正沒有發起人（架構上不可能有客戶身分流過）的呼叫，放進明確的 allow-list。
// 每一筆都要能講出「為什麼」——不是「懶得查」。
const ALLOWLIST = [
  {
    file: 'pipeline/health-check-runner.js',
    match: /agentType:\s*'workflow_health'/,
    reason: '健檢是平台對自己 pipeline 的健康稽核，不是替某個客戶做事。呼叫端只有兩處' +
      '（admin-routes.js 手動觸發、cron.js 排程觸發）：手動觸發那兩支路由掛的是' +
      '[verifyToken, requireAdmin]，起單者只可能是平台管理員（沒有公司）；排程觸發' +
      '則 startedBy 恆為 undefined。這條路徑架構上不可能有客戶身分流過，不是漏掉。',
  },
];

const files = walk(serverDir);

test('掃到的檔案數量合理（走訪壞掉時這一支會先紅，而不是讓守衛靜默空轉）', () => {
  expect(files.length).toBeGreaterThanOrEqual(20);
});

test('每一支直接呼叫 runAgent 的地方都帶了 userId（allow-list 之外）', () => {
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(serverDir, file);
    if (rel === 'pipeline/agent-runner.js') continue; // 定義檔本身
    const src = fs.readFileSync(file, 'utf8');
    for (const call of findCallBodies(src, 'runAgent')) {
      if (call.includes('...runOpts')) continue; // 展開寫法：交給下一支測試另外查 runOpts 來源
      const allowed = ALLOWLIST.find(a => a.file === rel && a.match.test(call));
      if (allowed) continue;
      if (!/\buserId\b/.test(call)) offenders.push(`${rel}: runAgent(${call.slice(0, 120)}…)`);
    }
  }
  expect(offenders).toEqual([]);
});

test('呼叫 withResume 的地方，runOpts 物件字面上都帶了 userId', () => {
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(serverDir, file);
    if (rel === 'pipeline/with-resume.js') continue; // 只是轉手 opts，不是來源
    const src = fs.readFileSync(file, 'utf8');
    for (const call of findCallBodies(src, 'withResume')) {
      const m = call.match(/runOpts:\s*\{/);
      if (!m) { offenders.push(`${rel}: withResume 呼叫沒有 runOpts 欄位`); continue; }
      const objText = extractBalanced(call, m.index + m[0].length - 1, '{', '}');
      if (!/\buserId\b/.test(objText)) offenders.push(`${rel}: withResume runOpts={${objText.slice(0, 120)}…}`);
    }
  }
  expect(offenders).toEqual([]);
});
