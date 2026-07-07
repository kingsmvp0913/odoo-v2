const { spawn } = require('child_process');
const { query } = require('../db');

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
        out += `\n⚙ ${blk.name}(${short})\n`;
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
        return preview ? `  → ${preview}\n` : null;
      }
    }
  }

  return null;
}

function callClaude(prompt, signal, opts = {}) {
  const { taskId, userId, notify, model } = opts;
  return new Promise((resolve, reject) => {
    // headless pipeline agent：略過權限提示，否則子行程要 Write/Bash 會卡在無法互動批准
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let resultText = '';
    let usage = null;
    let durationMs = null;
    let lineBuffer = '';
    let stderr = '';
    let settled = false;
    const finish = fn => { if (!settled) { settled = true; fn(); } };
    const emit = text => {
      if (!text || !taskId) return;
      if (userId && notify) notify.emitToUser(userId, 'terminal:output', { taskId, data: text });
      // 落地執行歷程供事後回放（best-effort，寫入失敗不影響 claude 執行）
      query('INSERT INTO task_events (task_id, content) VALUES ($1, $2)', [taskId, text]).catch(() => {});
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
          const display = formatEvent(ev);
          if (display) emit(display);
          if (ev.type === 'result') {
            resultText = ev.result      || resultText;
            usage      = ev.usage       || null;
            durationMs = ev.duration_ms || null;
          }
        } catch {
          emit(line + '\n');
        }
      }
    });

    child.stderr.on('data', d => { stderr += d.toString(); });
    child.stdin.write(prompt);
    child.stdin.end();

    if (signal) {
      signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
        finish(() => reject(abortError()));
      }, { once: true });
    }

    child.on('close', code => {
      if (taskId && userId && notify) notify.emitToUser(userId, 'terminal:done', { taskId, exitCode: code });
      finish(() => {
        if (code !== 0) reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        else resolve({ text: resultText.trim(), usage, durationMs });
      });
    });
    child.on('error', err => finish(() => reject(err)));
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

module.exports = { callClaude, abortError, stopReason };
