const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const notify = require('../notify');
const { killChildGracefully } = require('../lib/proc');
const { looksLikeAuthFailure } = require('./auth-signature');
const { getClaudeAuthEnv } = require('../lib/claude-auth');
const { getContext7ApiKey } = require('../lib/context7-auth');
const { aiTokenEnv, aiBaseEnv } = require('../lib/ai-token');

// 每關「刻意指定」MCP：pipeline 子行程一律不繼承環境 MCP（--strict-mcp-config），
// 凡需查「grep 補不了的 Odoo 原生知識」的關卡都掛 context7：analysis/coding（API 用法）、
// spec_tour（tour selector/導航 URL）、qa（判 base Odoo 是否合法）、reject_triage（判是否不符 Odoo 標準）、chat（技術問答）。
// 缺 context7 的關卡會退而 grep/find 本機 Odoo core（odoo-envs），曾滾成 `find /` 全碟掃描 → 逾時。
// 掃碟守衛掛上之後，缺 context7 的症狀改換一種樣子：agent 改用 WebSearch/WebFetch 去 raw.githubusercontent.com
// 抓 Odoo core（實測 spec_tour 一輪 38 次工具呼叫裡 7 次 WebSearch＋7 次 WebFetch＋3 次 ToolSearch 找不到 context7，
// 跑滿逾時零產出）。prompt 裡「走 context7 查證、不要掃碟找核心原始碼」這種禁令，缺了這張表就是只禁不給
// （rules/agent-prompt 107）——凡 prompt 提到 context7 的關卡都必須在此登記，agent-loader.test.js 有守衛。
// 實測 serena 即使在場也不被用（Grep/Read 已覆蓋 repo 內 symbol 查詢），故全 pipeline 不掛 serena，省下冷啟動 indexing 與空找 schema。
const MCP_PROFILES = {
  analysis: 'context7.json', coding: 'context7.json',
  spec_tour: 'context7.json', qa: 'context7.json',
  reject_triage: 'context7.json', chat: 'context7.json',
  cs: 'context7.json',
};
// 「刻意不掛」也要具名：漏登記與決定不掛在程式上長得一模一樣（都是查不到 key → none.json），
// 分不出來就沒有東西擋得住下一個新關卡重蹈 spec_tour 的覆轍。新增 stage 時兩張表挑一張填，
// 測試會逼你做這個決定。respec 這幾關的 spec-lookup.md 已明寫「你這一關也沒有 context7」，
// 屬於文字與設定一致的刻意設計，不是漏。
const NO_MCP_STAGES = new Set([
  'respec', 'merge', 'chat-to-task', 'deploy_fix', 'reject_classify',
  'wiki', 'wiki_drift_classify', 'workflow_health',
]);
// context7 啟動策略：優先用本地依賴（node ＋ 執行期解析的絕對路徑）——npx -y 每次 spawn 都可能
// 重新下載套件（冷啟動慢、離線直接失敗）。未安裝時退回 npx。
// API key（lib/context7-auth，管理員在後台設定）寫進生成檔的 env：MCP server 由 claude CLI 另行
// spawn，不保證繼承平台行程的環境變數，故顯式帶。生成檔已在 .gitignore，key 不會進版控。
// 快取連 key 一起比對——管理員換 key 後下一個 spawn 就要用新的，不必重啟（存檔端會 reset 快取，
// 但兩者都比對才擋得住「先 spawn 過再換 key」這種順序）。
let _context7Path = null;
let _context7Key = null;
function context7ConfigPath() {
  const apiKey = getContext7ApiKey();
  if (_context7Path && _context7Key === apiKey) return _context7Path;
  let server;
  try {
    const pkgDir = path.dirname(require.resolve('@upstash/context7-mcp/package.json'));
    const entry = path.join(pkgDir, 'dist', 'index.js');
    if (!fs.existsSync(entry)) throw new Error('entry missing');
    server = { command: process.execPath, args: [entry] };
  } catch { server = { command: 'npx', args: ['-y', '@upstash/context7-mcp'] }; }
  if (apiKey) server.env = { CONTEXT7_API_KEY: apiKey };
  try {
    const gen = path.join(__dirname, 'mcp', 'context7.local.json');
    fs.writeFileSync(gen, JSON.stringify({ mcpServers: { context7: server } }, null, 2));
    _context7Path = gen;
  } catch {
    // 寫不出生成檔（唯讀掛載等）才退版控裡的靜態檔——那份沒有 key，等於回到匿名額度
    _context7Path = path.join(__dirname, 'mcp', 'context7.json');
  }
  _context7Key = apiKey;
  return _context7Path;
}
function mcpConfigPath(agentType) {
  return MCP_PROFILES[agentType] ? context7ConfigPath() : path.join(__dirname, 'mcp', 'none.json');
}

// 掃碟守衛：PreToolUse hook 攔截「從磁碟根／worktree 外」的 find 與遞迴廣掃（見 hooks/scan-guard.js）。
// prompt 早已禁止全碟掃描並向 agent 保證「會被平台掃碟守衛中止」，此處把那道守衛真的掛上，讓禁令有牙齒。
// 產生一份只含 hook 的 settings 供 --settings 併入；hook 指令用 forward-slash 路徑（跨 cmd/bash 皆可）＋PATH 上的 node。
let _scanGuardPath = null;
function scanGuardSettingsPath() {
  if (_scanGuardPath) return _scanGuardPath;
  const script = path.join(__dirname, 'hooks', 'scan-guard.js').replace(/\\/g, '/');
  const gen = path.join(__dirname, 'hooks', 'scan-guard.settings.json');
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${script}"` }] },
      ],
    },
  };
  fs.writeFileSync(gen, JSON.stringify(settings, null, 2));
  _scanGuardPath = gen;
  return _scanGuardPath;
}

// task_events 批次寫入：顯示走 socket 即時，持久化累積後批量落地（取代每行一筆的高頻 INSERT）
const EVENT_FLUSH_MS = parseInt(process.env.PIPELINE_EVENT_FLUSH_MS || '500', 10);
const EVENT_FLUSH_MAX = parseInt(process.env.PIPELINE_EVENT_FLUSH_MAX || '50', 10);
// SIGTERM 後的寬限期，逾期未退出升級 SIGKILL
const KILL_GRACE_MS = parseInt(process.env.PIPELINE_KILL_GRACE_MS || '5000', 10);

function formatEvent(ev) {
  if (!ev || !ev.type) return null;

  if (ev.type === 'system' && ev.subtype === 'init') {
    return `\x1b[90m[Claude 已啟動，session: ${ev.session_id?.slice(0, 8) || '?'}]\x1b[0m\n`;
  }

  if (ev.type === 'assistant' && ev.message?.content) {
    let out = '';
    for (const blk of ev.message.content) {
      if (blk.type === 'text') {
        out += blk.text;
      } else if (blk.type === 'tool_use') {
        const input = JSON.stringify(blk.input || {});
        const short = input.length > 120 ? input.slice(0, 120) + '…' : input;
        out += `\n\x1b[90m⚙ ${blk.name}(${short})\x1b[0m\n`;
      }
    }
    return out || null;
  }

  if (ev.type === 'user' && ev.message?.content) {
    for (const blk of ev.message.content) {
      if (blk.type === 'tool_result') {
        const text = Array.isArray(blk.content)
          ? blk.content.filter(c => c.type === 'text').map(c => c.text).join('')
          : String(blk.content || '');
        const preview = text.length > 200 ? text.slice(0, 200) + '…' : text;
        return preview ? `\x1b[90m  → ${preview}\x1b[0m\n` : null;
      }
    }
  }

  return null;
}

// 統一 runner（合併原 callClaude/spawnClaude，健檢 U13）：所有階段共用一份子行程實作，
// 事件流同時寫 socket 與 task_events；支援 cwd（worktree 隔離）、session 捕捉、--resume（主題 B）。
function runClaude(prompt, opts = {}) {
  const { signal, cwd, taskId, userId, model, timeoutMs = 600000, resumeSessionId, env, agentType } = opts;
  return new Promise((resolve, reject) => {
    // signal 已 abort（使用者在前置 DB 查詢／組 prompt 期間、或同關前一次 runClaude 進行中按暫停）：
    // addEventListener 對已 abort 的 signal 永遠不會觸發 → 不檢查的話這一整段 claude 會照跑燒 token
    if (signal?.aborted) {
      return reject(Object.assign(abortError(), { claudeStatus: 'aborted', durationMs: 0 }));
    }
    // headless pipeline agent：略過權限提示，否則子行程要 Write/Bash 會卡在無法互動批准
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    // 刻意不加 --exclude-dynamic-system-prompt-sections（2026-08-17 實測後決定不採用）：
    // 它把 cwd／git status 等每台機不同的區段移出 system prompt 以提升跨任務快取命中，實測換目錄跑
    // 同一 prompt，cache_create 8884→6879（−22.6%）、cache_read 20614→22325，總 token 不變——
    // 換算全平台僅約 1.2% 成本，佔 cache_create 總量的 4%（其餘 96% 是各 agent prompt body 不同、
    // 每張任務規格不同造成的結構性寫入，無旗標可解）。
    // 不採用的理由：它把那些資訊降格到 user message，而 user message 會被 auto-compact 壓縮、
    // system prompt 不會——長 coding session 中途的注意力衰減無法用短測驗證。
    // 依 rules/always.md 第 10 條「穩定 > 準確 > 省 token」，1.2% 不值得換一個排除不掉的準確率風險。
    // 每關只載入指定的 MCP，剝掉繼承的 serena 等（見 MCP_PROFILES）
    args.push('--strict-mcp-config', '--mcp-config', mcpConfigPath(agentType));
    // 每關都掛掃碟守衛：攔全域 find／遞迴廣掃，避免滾成全碟掃描逾時（見 scanGuardSettingsPath）
    args.push('--settings', scanGuardSettingsPath());
    // 續用前一輪對話（含規格理解、codebase 探索、上輪 diff），重跑只送短 feedback（健檢 U3）
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    // env：敏感憑證（如 E2E 密碼）以環境變數傳入子行程，不進 prompt/串流/腳本（健檢 E-1）。
    // 認證憑證在此集中注入（19 個呼叫端零改動）：管理員設定優先於繼承的環境變數，
    // 未設定時回空物件、完全不碰該 key；呼叫端自帶的 env 排最後，語意不受影響。
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'], cwd,
      // aiTokenEnv：/ai/* 端點的通行碼。agent 用 curl 打那些端點時要帶進 header——
      // 沒有它，agent 查不到客戶 DB／wiki，而症狀（403）完全不像認證問題（見 lib/ai-token.js）。
      // aiBaseEnv：同一組端點的 base URL。prompt 不得寫死埠號，否則 PORT 一被覆寫就整組靜默失聯。
      env: { ...process.env, ...getClaudeAuthEnv(), ...aiTokenEnv(), ...aiBaseEnv(), ...(env || {}) },
    });
    // 子行程提早死掉（bad flag／立即崩潰）時，對已關閉的 stdin 寫入會在 stdin 串流發 EPIPE error；
    // 無 handler 會變 uncaughtException 拖垮整個 server。錯誤本身由 close/error 事件歸因，這裡吞掉即可。
    child.stdin.on?.('error', () => {});

    // SIGTERM 後寬限期未退出就升級 SIGKILL：claude 掛死不理 SIGTERM 時避免殭屍行程佔資源
    const killChild = () => killChildGracefully(child, KILL_GRACE_MS);

    let resultText = '';
    // 整段 assistant 文字（非只末輪 ev.result）：agent 把 <result> 當中間步驟吐出後，若還繼續講話
    // 或派子任務，ev.result 只剩收尾散文、契約標籤整個蒸發。留全量 transcript 供 result-contract 關卡
    // 用 extractResult 從中撈「最後一組」<result>，不靠 agent 自律把契約留在末輪（Rule 60／69）。
    let assistantText = '';
    let usage = null;
    let durationMs = null;
    let sessionId = null;
    let usedModel = null;
    let lineBuffer = '';
    let stderr = '';
    // 認證失效的原始字面：claude 把 "Not logged in" 印在 stdout（非 JSON 行）且 stderr 空，
    // 不留存的話 close 只剩泛用退出碼、真因整個蒸發（見 auth-signature.js）
    let authReason = null;
    let settled = false;
    let timer = null;
    const startedAt = Date.now();
    // 執行歷程批次寫：emit 先進 buffer，計時器／滿批／收尾時一次多列落地（unnest WITH ORDINALITY 保序，回放 ORDER BY id 不亂序）
    const eventBuf = [];
    let flushTimer = null;
    const flushEvents = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!eventBuf.length || !taskId) return Promise.resolve();
      const batch = eventBuf.splice(0);
      return query(
        'INSERT INTO task_events (task_id, content) SELECT $1, content FROM unnest($2::text[]) WITH ORDINALITY AS t(content, ord) ORDER BY ord',
        [taskId, batch]
      ).catch(() => {});
    };
    // settle 前先 flush 殘餘事件，確保尾段落地且排在下一關 marker 之前
    const finish = fn => { if (!settled) { settled = true; if (timer) clearTimeout(timer); Promise.resolve(flushEvents()).finally(fn); } };
    // 失敗也要能記帳與鑑識：標注失敗類別與實際耗時（健檢 U12）
    const fail = (err, status) => Object.assign(err, { claudeStatus: status, durationMs: Date.now() - startedAt });
    // CLI 掛死時若無 timeout，任務會永久卡在 *_running、merge 鎖永不釋放，只能重啟 server（健檢 U9）
    timer = setTimeout(() => {
      killChild();
      finish(() => reject(fail(new Error(`claude 執行逾時（${Math.round(timeoutMs / 1000)}s）`), 'timeout')));
    }, timeoutMs);
    // 有 taskId 才有落地對象；socket 另需 userId 才知道推給誰（前端依 taskId 路由終端輸出）
    const emit = text => {
      if (!text || !taskId) return;
      if (userId) notify.emitToUser(userId, 'terminal:output', { taskId, data: text });
      // 落地執行歷程供事後回放（批次寫：滿批立刻 flush，否則排定計時器；best-effort，寫入失敗不影響 claude 執行）
      eventBuf.push(text);
      if (eventBuf.length >= EVENT_FLUSH_MAX) flushEvents();
      else if (!flushTimer) flushTimer = setTimeout(flushEvents, EVENT_FLUSH_MS);
    };

    child.stdout.on('data', d => {
      lineBuffer += d.toString();
      let nl;
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, nl).trim();
        lineBuffer = lineBuffer.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
            sessionId = ev.session_id; // 供 coding 重跑 --resume 續用
          }
          // 抓實際 model（第一則 assistant 事件帶 resolved model id）供成本歸屬
          if (!usedModel && ev.type === 'assistant' && ev.message && ev.message.model) {
            usedModel = ev.message.model;
          }
          // 累積所有 assistant text block（見 assistantText 宣告處）
          if (ev.type === 'assistant' && ev.message?.content) {
            for (const blk of ev.message.content) {
              if (blk.type === 'text' && blk.text) assistantText += blk.text;
            }
          }
          const display = formatEvent(ev);
          if (display) emit(display);
          if (ev.type === 'result') {
            resultText = ev.result      || resultText;
            usage      = ev.usage       || null;
            durationMs = ev.duration_ms || null;
          }
        } catch {
          if (!authReason && looksLikeAuthFailure(line)) authReason = line.slice(0, 200);
          emit(line + '\n');
        }
      }
    });

    child.stderr.on('data', d => { stderr += d.toString(); });
    // 落地本次送出的完整 prompt 供管理員稽核（best-effort，失敗不影響 claude 執行）；只保留最近 100 筆
    query(
      'INSERT INTO prompt_logs (agent_type, model, task_id, prompt, char_len) VALUES ($1, $2, $3, $4, $5)',
      [agentType || null, model || null, taskId != null ? String(taskId) : null, prompt, (prompt || '').length]
    ).then(() => query(
      'DELETE FROM prompt_logs WHERE id NOT IN (SELECT id FROM prompt_logs ORDER BY id DESC LIMIT 100)'
    )).catch(() => {});
    child.stdin.write(prompt);
    child.stdin.end();

    if (signal) {
      signal.addEventListener('abort', () => {
        killChild();
        finish(() => reject(fail(abortError(), 'aborted')));
      }, { once: true });
    }

    child.on('close', (code, sig) => {
      if (taskId && userId) notify.emitToUser(userId, 'terminal:done', { taskId, exitCode: code });
      finish(() => {
        // code null＝被 signal 終止：自家的 timeout/abort kill 已先 settle（此處為 no-op），
        // 走到這裡代表外部殺掉（OOM killer 等）→ 視為失敗，不能拿空結果當成功回傳
        if (code !== 0) {
          const raw = stderr.trim();
          // 認證失效優先歸因：否則只剩泛用「exited with code 1」，blocker 看不出真因、
          // 分類器也判不出（→ 停等人工）。標 claudeStatus='auth' 供分類器歸 transient 自癒。
          const auth = authReason || (looksLikeAuthFailure(raw) ? raw.slice(0, 200) : null);
          if (auth) reject(fail(new Error(`Claude CLI 未登入或認證失效：${auth}`), 'auth'));
          else {
            // code null＝被外部信號終止（伺服器重開／OOM kill 等），非執行失敗——標 interrupted，
            // 與手動暫停 aborted 同類（用量報表把兩者都排除在呼叫數／失敗數之外）。routing 不受影響：
            // 分類器只特判 timeout／auth，interrupted 一律走訊息分類，與原本的外部終止 error 走向一致。
            // 真正的非零 exit（claude 自己 exit N）仍記 error。
            const externalKill = code === null;
            const msg = raw || (externalKill ? `claude 行程被外部終止（${sig || 'signal'}）` : `claude exited with code ${code}`);
            reject(fail(new Error(msg), externalKill ? 'interrupted' : 'error'));
          }
        } else {
          // 實際 model：優先用事件回報的 resolved id，退回 opts 的 model alias（sonnet/opus…）
          const finalModel = usedModel || model || null;
          // 折進 usage，讓 logTokenUsage 零改動就能落 model 欄
          if (usage && finalModel) usage.model = finalModel;
          resolve({ text: resultText.trim(), assistantText: assistantText.trim(), usage, durationMs, sessionId, model: finalModel });
        }
      });
    });
    child.on('error', err => {
      // spawn 的 ENOENT 有兩種來源、無法從 err 本身區分：cwd 目錄不存在，或 PATH 找不到 claude。
      // cwd（多為任務 worktree）不存在最常見於「停在早期階段的任務被 resume」時 worktree 尚未建立——
      // 別再誤報成找不到 claude，據 cwd 是否存在給正確歸因。
      if (err.code === 'ENOENT') {
        err.message = (cwd && !fs.existsSync(cwd))
          ? `工作目錄不存在（worktree 可能尚未建立或已清除）：${cwd}`
          : '找不到 claude 執行檔（PATH 未含 claude 安裝目錄），請確認 claude CLI 可用';
      }
      finish(() => reject(fail(err, 'error')));
    });
  });
}

// 手動暫停會 abort 執行中的 claude；標記 aborted 讓上層區分「使用者暫停」與「真正失敗」
function abortError() {
  return Object.assign(new Error('手動暫停'), { aborted: true });
}

// 組失敗原因：手動暫停顯示「手動暫停」，其餘顯示「<階段> 執行失敗：<訊息>」
function stopReason(prefix, err) {
  return err && err.aborted ? '手動暫停' : `${prefix}：${err.message}`;
}

module.exports = { runClaude, abortError, stopReason, mcpConfigPath, MCP_PROFILES, NO_MCP_STAGES };
