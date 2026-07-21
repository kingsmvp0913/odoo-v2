/**
 * scan-guard.js — 掃碟守衛（pipeline agent 的 PreToolUse hook）
 *
 * 背景：coding/analysis/qa… 等 agent 的 prompt 早已明文「Odoo 核心不在 worktree、查核心走
 * context7、禁止 `find /`／掃 C:\」，並向 agent 保證這類廣掃「會被平台掃碟守衛中止」。
 * 但那個守衛過去並不存在——純文字禁令 LLM 有時不理，`find /` 就真的跑出去、滾成全碟掃描燒逾時，
 * 逾時被殺時又在 Windows 留下孤兒 find.exe（收屍那半由 lib/proc.js 的 tree-kill 處理）。
 * 本檔就是把那道被承諾、卻不存在的守衛真的做出來：claude-runner 派每一關子行程時以 --settings 掛上，
 * 攔截「從磁碟根／worktree 外」的 find 與遞迴廣掃，當場擋掉並回饋原因讓 agent 改走 context7。
 *
 * Claude Code PreToolUse hook 協定：stdin 收 { tool_name, tool_input:{ command } } JSON；
 * exit 0 放行、exit 2 阻擋（stderr 內容回饋給 model）。
 *
 * detectBroadScan(command) 為純函式，供單測直接驗證（見 tests/scan-guard.test.js）。
 */

// 廣掃的「起點路徑」黑名單判定：磁碟根、drive root、家目錄、系統目錄、以及本平台會踩到的
// Odoo 核心／非工作目錄樹（odoo-envs / online_addons / custom_addons / /c/odoo）。
// worktree 內的相對路徑或本任務 repo 的絕對路徑不會命中——只擋明顯過廣的起點，避免誤傷正常搜尋。
function isBroadRoot(raw) {
  if (!raw) return false;
  let p = raw.replace(/^['"]|['"]$/g, '').trim(); // 去引號
  if (!p) return false;
  const lower = p.toLowerCase();

  // 明確踩到 Odoo 核心／工作目錄外的樹（不論在路徑何處）
  if (/(^|[\\/])odoo-envs([\\/]|$)/i.test(p)) return true;
  if (/(^|[\\/])(online_addons|custom_addons)([\\/]|$)/i.test(p)) return true;
  if (/(^|[\\/])c[\\/]odoo([\\/]|$)/i.test(p)) return true; // /c/odoo（Git Bash 形式的 C:\odoo）

  const norm = p.replace(/\\/g, '/');

  // 磁碟根 / 當前磁碟根
  if (norm === '/' || norm === '//' || norm === '/.') return true;
  // Git Bash 磁碟掛載根：/c、/c/、/d …（單層字母）
  if (/^\/[a-z]\/?$/i.test(norm)) return true;
  // Windows drive root：C:、C:\、C:/、c:.
  if (/^[a-z]:[/]?$/i.test(norm)) return true;
  // 家目錄整棵
  if (norm === '~' || norm === '~/' || norm === '$home' || lower === '%userprofile%') return true;
  // 系統／使用者頂層目錄整棵
  if (/^\/(home|root|usr|mnt|opt|etc|var|c\/users)\/?$/i.test(norm)) return true;

  return false;
}

// 把一整段 shell 指令切成子指令（依 ; && || | 與換行），逐段判斷。
function splitSubcommands(command) {
  return command.split(/\r?\n|&&|\|\||[;|]/).map(s => s.trim()).filter(Boolean);
}

// 從子指令抽出「命令字」與其後的參數 token（粗略 tokenize，夠判斷廣掃即可）。
function tokenize(sub) {
  const toks = sub.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  return toks;
}

function baseName(cmd) {
  return (cmd || '').replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

/**
 * 回傳 { blocked, reason }。blocked=true 代表這段指令是「從過廣起點」的掃描，應擋。
 */
function detectBroadScan(command) {
  if (!command || typeof command !== 'string') return { blocked: false };

  for (const sub of splitSubcommands(command)) {
    const toks = tokenize(sub);
    if (!toks.length) continue;
    const cmd = baseName(toks[0]);

    // 1) find [path...] [expression]：path 出現在選項/表達式之前，逐一檢查是否命中廣掃起點
    if (cmd === 'find') {
      for (let i = 1; i < toks.length; i++) {
        const t = toks[i];
        if (t.startsWith('-') || t.startsWith('(') || t === '!') break; // 進入 find 表達式，後面不是路徑
        if (isBroadRoot(t)) {
          return { blocked: true, reason: `find 的搜尋起點「${t}」過廣（磁碟根／工作目錄外）` };
        }
      }
      // find 未給任何路徑（預設從 . 掃）＝限 cwd，不擋
      continue;
    }

    // 2) 遞迴列舉：ls -R / find 之外的 grep -r、Get-ChildItem/gci/dir -Recurse，起點若廣則擋
    const isGci = ['get-childitem', 'gci', 'dir', 'ls'].includes(cmd);
    const isGrepR = ['grep', 'rg'].includes(cmd);
    if (isGci || isGrepR) {
      const hasRecurse = toks.some(t => /^(-r|-R|--recurse|-recurse|--recursive)$/i.test(t));
      // dir/gci 預設不遞迴；ls -R、grep -r 才算遞迴掃
      const recursive = isGci ? hasRecurse : hasRecurse;
      if (!recursive) continue;
      for (let i = 1; i < toks.length; i++) {
        const t = toks[i];
        if (t.startsWith('-')) continue; // 跳過選項（-Path 值仍是下一個 token）
        if (/^(-path|-literalpath)$/i.test(toks[i - 1] || '')) { /* 明示 -Path 值 */ }
        if (isBroadRoot(t)) {
          return { blocked: true, reason: `${cmd} 遞迴掃描的起點「${t}」過廣（磁碟根／工作目錄外）` };
        }
      }
    }
  }
  return { blocked: false };
}

const DENY_MESSAGE = [
  '⛔ 掃碟守衛：已中止這次全域檔案掃描。',
  'Odoo 核心原始碼不在你的 worktree 內，禁止用 find／遞迴列舉去掃磁碟根或工作目錄以外的路徑',
  '（`find /`、掃 C:\\、/c/odoo、odoo-envs 等）——這會滾成全碟掃描、拖垮機器並讓本回合逾時報廢。',
  '需要 Odoo 原生 API／慣例：改用 context7 MCP。需要本專案程式碼：用 Glob／Grep／Read，限 worktree 內。',
].join('\n');

// hook 進入點：只在被當作 script 直接執行時跑（被 require 進測試時不動 stdin）
if (require.main === module) {
  let input = '';
  process.stdin.on('data', d => { input += d; });
  process.stdin.on('end', () => {
    let cmd = '';
    try { cmd = (JSON.parse(input || '{}').tool_input || {}).command || ''; } catch { /* 非預期輸入：放行 */ }
    const { blocked, reason } = detectBroadScan(cmd);
    if (blocked) {
      process.stderr.write(`${DENY_MESSAGE}\n（觸發原因：${reason}）\n`);
      process.exit(2); // PreToolUse：exit 2 = 阻擋工具呼叫，stderr 回饋給 model
    }
    process.exit(0);
  });
  // stdin 若無資料流入（異常情境）不要卡死
  process.stdin.on('error', () => process.exit(0));
}

module.exports = { detectBroadScan, isBroadRoot, DENY_MESSAGE };
