/**
 * Block commands that recursively scan a filesystem root or protected Odoo
 * source tree. The hook accepts both the Claude-compatible and Codex hook
 * payload shapes because Codex Desktop invokes the same project hook.
 */

function isBroadRoot(raw) {
  if (!raw) return false;
  const p = raw.replace(/^['"]|['"]$/g, '').trim();
  if (!p) return false;
  const lower = p.toLowerCase();

  if (/(^|[\\/])odoo-envs([\\/]|$)/i.test(p)) return true;
  if (/(^|[\\/])(online_addons|custom_addons)([\\/]|$)/i.test(p)) return true;
  if (/(^|[\\/])c[\\/]odoo([\\/]|$)/i.test(p)) return true;

  const norm = p.replace(/\\/g, '/');
  if (norm === '/' || norm === '//' || norm === '/.') return true;
  if (/^\/[a-z]\/?$/i.test(norm)) return true;
  if (/^[a-z]:[/]?$/i.test(norm)) return true;
  if (norm === '~' || norm === '~/' || norm === '$home' || lower === '%userprofile%') return true;
  return /^\/(home|root|usr|mnt|opt|etc|var|c\/users)\/?$/i.test(norm);
}

function splitSubcommands(command) {
  const result = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if ((char === '"' || char === "'") && command[i - 1] !== '\\') quote = quote === char ? null : (quote || char);
    if (!quote && (char === ';' || char === '|' || char === '\n' || (char === '&' && command[i + 1] === '&'))) {
      if (current.trim()) result.push(current.trim());
      current = '';
      if (char === '&') i += 1;
    } else {
      current += char;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function tokenize(sub) {
  return sub.match(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^\s]+/g) || [];
}

function unquote(value) {
  return value.replace(/^['"]|['"]$/g, '');
}

function baseName(command) {
  return unquote(command || '').replace(/\\/g, '/').split('/').pop().replace(/\.(cmd|exe)$/i, '').toLowerCase();
}

function unwrapCommand(command, depth = 0) {
  if (depth > 4 || !command) return [command];
  const tokens = tokenize(command);
  const executable = baseName(tokens[0]);
  let nested;

  if (executable === 'rtk') {
    nested = tokens.slice(1).join(' ');
  } else if (['powershell', 'pwsh', 'bash', 'sh', 'zsh'].includes(executable)) {
    const commandFlag = tokens.findIndex(token => /^(-command|-c|-lc)$/i.test(unquote(token)));
    if (commandFlag >= 0) nested = tokens.slice(commandFlag + 1).join(' ');
  }

  return nested ? [command, ...unwrapCommand(unquote(nested), depth + 1)] : [command];
}

function detectOneCommand(command) {
  for (const sub of splitSubcommands(command)) {
    const tokens = tokenize(sub);
    if (!tokens.length) continue;
    const executable = baseName(tokens[0]);

    if (executable === 'find') {
      for (let i = 1; i < tokens.length; i += 1) {
        const token = unquote(tokens[i]);
        if (token.startsWith('-') || token.startsWith('(') || token === '!') break;
        if (isBroadRoot(token)) return { blocked: true, reason: `find 的搜尋根目錄過於寬廣：${token}` };
      }
      continue;
    }

    if (['get-childitem', 'gci', 'dir', 'ls', 'grep', 'rg'].includes(executable)) {
      const recursive = tokens.some(token => /^(-r|-R|--recurse|-recurse|--recursive)$/i.test(unquote(token)));
      if (!recursive) continue;
      for (let i = 1; i < tokens.length; i += 1) {
        const token = unquote(tokens[i]);
        if (token.startsWith('-')) continue;
        if (isBroadRoot(token)) return { blocked: true, reason: `${executable} 的遞迴搜尋根目錄過於寬廣：${token}` };
      }
    }
  }
  return { blocked: false };
}

function detectBroadScan(command) {
  if (!command || typeof command !== 'string') return { blocked: false };
  for (const candidate of unwrapCommand(command)) {
    const result = detectOneCommand(candidate);
    if (result.blocked) return result;
  }
  return { blocked: false };
}

function getCommandFromHookInput(input) {
  return input?.tool_input?.command
    || input?.tool_input?.input?.command
    || input?.input?.command
    || input?.arguments?.command
    || input?.command
    || '';
}

const DENY_MESSAGE = [
  '掃碟守衛已阻擋此命令。',
  '禁止遞迴掃描檔案系統根目錄、Odoo 核心或受保護的 addons 目錄。',
  '請限縮到 worktree，或以 Context7 查詢 Odoo 核心 API。',
].join('\n');

if (require.main === module) {
  let input = '';
  process.stdin.on('data', data => { input += data; });
  process.stdin.on('end', () => {
    let command = '';
    try { command = getCommandFromHookInput(JSON.parse(input || '{}')); } catch { /* malformed hook input must not block all tools */ }
    const { blocked, reason } = detectBroadScan(command);
    if (blocked) {
      const message = `${DENY_MESSAGE}\n原因：${reason}`;
      process.stderr.write(`${message}\n`);
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message } })}\n`);
      process.exit(2);
    }
  });
  process.stdin.on('error', () => process.exit(0));
}

module.exports = { detectBroadScan, getCommandFromHookInput, isBroadRoot, unwrapCommand, DENY_MESSAGE };
