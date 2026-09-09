const { spawn } = require('child_process');
const { query } = require('../db');
const notify = require('../notify');
const { killChildGracefully } = require('../lib/proc');
const { aiTokenEnv, aiBaseEnv } = require('../lib/ai-token');
const { looksLikeAuthFailure } = require('./auth-signature');
const { sandboxFailureReason } = require('./sandbox-signature');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.CLAUDE_AGENT_TIMEOUT_MS || '2400000', 10);
const KILL_GRACE_MS = parseInt(process.env.PIPELINE_KILL_GRACE_MS || '5000', 10);

function abortError() { return Object.assign(new Error('手動暫停'), { aborted: true }); }
function fail(err, status, startedAt, sessionId) {
  return Object.assign(err, { claudeStatus: status, durationMs: Date.now() - startedAt, sessionId });
}
function displayEvent(ev) {
  if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') return ev.item.text || null;
  if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') {
    const cmd = ev.item.command || ev.item.command_line || 'command';
    const out = ev.item.aggregated_output || '';
    return `\n\x1b[90m⚙ ${cmd}${out ? `\n  → ${out.slice(0, 200)}` : ''}\x1b[0m\n`;
  }
  if (ev.type === 'item.completed' && ev.item?.type === 'error') return `\x1b[31m${ev.item.message || ev.item.error || 'Codex error'}\x1b[0m\n`;
  return null;
}

// Codex JSONL 與 Claude stream-json 不相容，保留獨立 runner；回傳形狀則完全一致。
function runCodex(prompt, opts = {}) {
  const { signal, cwd, taskId, userId, model, effort, timeoutMs = DEFAULT_TIMEOUT_MS, resumeSessionId, env, agentType } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fail(abortError(), 'aborted', Date.now(), null));
    const args = resumeSessionId
      ? ['exec', 'resume', resumeSessionId, '-', '--json']
      : ['exec', '-', '--json'];
    if (model) args.push('--model', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    // 批次一全為無工作區寫入的純文字 agent；read-only 避免意外寫檔。
    // `exec resume` 子指令不接受 --sandbox（0.149.1 實測：unexpected argument、exit code 2，
    // 數十毫秒即退），整包參數在 CLI 解析階段就死掉、with-resume 靜默降級成 fresh 重送——
    // 續接輪等於從沒成立過。續接改用等價的 -c 設定同一個 read-only 模式（非放寬保護）。
    args.push(...(resumeSessionId ? ['-c', 'sandbox_mode="read-only"'] : ['--sandbox', 'read-only']));
    args.push('--dangerously-bypass-hook-trust');
    const startedAt = Date.now();
    let sessionId = null, resultText = '', assistantText = '', usage = null, stderr = '', toolOutput = '', settled = false, timer;
    let lineBuffer = '';
    // 訂閱模式使用 `codex app-server` 所保存、會自動刷新的 ChatGPT 登入；絕不把
    // OPENAI_API_KEY 繼承進子行程，避免同一台正式機意外退回 API 按量計費。
    const childEnv = { ...process.env, ...aiTokenEnv(), ...aiBaseEnv(), ...(env || {}) };
    delete childEnv.OPENAI_API_KEY;
    delete childEnv.CODEX_API_KEY;
    delete childEnv.CODEX_ACCESS_TOKEN;
    const child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'], cwd,
      env: childEnv
    });
    child.stdin.on?.('error', () => {});
    const emit = text => {
      if (!text || !taskId) return;
      if (userId) notify.emitToUser(userId, 'terminal:output', { taskId, data: text });
      query('INSERT INTO task_events (task_id, content) VALUES ($1,$2)', [taskId, text]).catch(() => {});
    };
    const finish = fn => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const kill = () => killChildGracefully(child, KILL_GRACE_MS);
    timer = setTimeout(() => { kill(); finish(() => reject(fail(new Error(`codex 執行逾時（${Math.round(timeoutMs / 1000)}s）`), 'timeout', startedAt, sessionId))); }, timeoutMs);
    query('INSERT INTO prompt_logs (agent_type, model, task_id, prompt, char_len) VALUES ($1,$2,$3,$4,$5)',
      [agentType || null, model || null, taskId != null ? String(taskId) : null, prompt, (prompt || '').length]).catch(() => {});
    child.stdout.on('data', d => {
      lineBuffer += d.toString();
      let nl;
      while ((nl = lineBuffer.indexOf('\n')) >= 0) {
        const raw = lineBuffer.slice(0, nl).trim(); lineBuffer = lineBuffer.slice(nl + 1);
        if (!raw) continue;
        try {
          const ev = JSON.parse(raw);
          if (ev.type === 'thread.started') sessionId = ev.thread_id || sessionId;
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
            resultText = ev.item.text || resultText;
            assistantText += ev.item.text || '';
          }
          // 工具指令的輸出只走 stdout 的 JSONL（不進 stderr）——沙箱起不來的證據只在這裡。
          if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') toolOutput += `${ev.item.aggregated_output || ''}\n`;
          if (ev.type === 'turn.completed') usage = ev.usage || null;
          if (ev.type === 'turn.failed') stderr += `${ev.error?.message || 'Codex turn failed'}\n`;
          const shown = displayEvent(ev); if (shown) emit(shown);
        } catch { emit(raw + '\n'); }
      }
    });
    // Codex 的工具失敗只在 stderr；必須顯示，否則 exit 0 會造成假綠。
    child.stderr.on('data', d => { const text = d.toString(); stderr += text; emit(`\x1b[31m${text}\x1b[0m`); });
    child.stdin.write(prompt); child.stdin.end();
    if (signal) signal.addEventListener('abort', () => { kill(); finish(() => reject(fail(abortError(), 'aborted', startedAt, sessionId))); }, { once: true });
    child.on('close', (code, sig) => finish(() => {
      if (code !== 0) {
        const message = stderr.trim() || (code === null ? `codex 行程被外部終止（${sig || 'signal'}）` : `codex exited with code ${code}`);
        const status = code === null ? 'interrupted' : (looksLikeAuthFailure(message) ? 'auth' : 'error');
        return reject(fail(new Error(message), status, startedAt, sessionId));
      }
      // 沙箱起不來時每個工具呼叫都在啟動階段就失敗（agent 讀不到任何檔案、只能回「查不到」），
      // 但 CLI 仍以 exit 0 結束；不在這裡攔就會被 token-logger 記成 completed，全程零失敗訊號。
      const sandboxReason = sandboxFailureReason(`${toolOutput}\n${stderr}`);
      if (sandboxReason) {
        return reject(fail(new Error(`codex 沙箱啟動失敗，agent 無法執行任何工具指令：${sandboxReason}`), 'error', startedAt, sessionId));
      }
      if (usage) {
        usage.cache_read_input_tokens = usage.cached_input_tokens || 0;
        usage.cache_creation_input_tokens = usage.cache_write_input_tokens || 0;
        usage.model = model || null;
        usage.provider = 'codex';
      }
      // raw：與 claude-runner 同一份語意（契約解析的唯一來源），呼叫端才能不分 provider 一律取 .raw
      resolve({ text: resultText.trim(), assistantText: assistantText.trim(), raw: assistantText.trim() || resultText.trim(), usage, durationMs: Date.now() - startedAt, sessionId, model: model || null });
    }));
    child.on('error', err => finish(() => {
      if (err.code === 'ENOENT') err.message = cwd && !require('fs').existsSync(cwd) ? `工作目錄不存在：${cwd}` : '找不到 codex 執行檔，請確認 Codex CLI 可用';
      reject(fail(err, 'error', startedAt, sessionId));
    }));
  });
}

module.exports = { runCodex };
