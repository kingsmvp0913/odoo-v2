const { spawn } = require('child_process');
const { query } = require('../db');
const notify = require('../notify');
const { killChildGracefully } = require('../lib/proc');
const { getCodexAuthEnv } = require('../lib/codex-auth');
const { aiTokenEnv, aiBaseEnv } = require('../lib/ai-token');
const { looksLikeAuthFailure } = require('./auth-signature');

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
    args.push('--sandbox', 'read-only', '--dangerously-bypass-hook-trust');
    const startedAt = Date.now();
    let sessionId = null, resultText = '', assistantText = '', usage = null, stderr = '', settled = false, timer;
    let lineBuffer = '';
    const child = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'], cwd,
      env: { ...process.env, ...getCodexAuthEnv(), ...aiTokenEnv(), ...aiBaseEnv(), ...(env || {}) }
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
      if (usage) {
        usage.cache_read_input_tokens = usage.cached_input_tokens || 0;
        usage.cache_creation_input_tokens = usage.cache_write_input_tokens || 0;
        usage.model = model || null;
        usage.provider = 'codex';
      }
      resolve({ text: resultText.trim(), assistantText: assistantText.trim(), usage, durationMs: Date.now() - startedAt, sessionId, model: model || null });
    }));
    child.on('error', err => finish(() => {
      if (err.code === 'ENOENT') err.message = cwd && !require('fs').existsSync(cwd) ? `工作目錄不存在：${cwd}` : '找不到 codex 執行檔，請確認 Codex CLI 可用';
      reject(fail(err, 'error', startedAt, sessionId));
    }));
  });
}

module.exports = { runCodex };
