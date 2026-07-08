const { spawn } = require('child_process');
const { query } = require('../db');
const notify = require('../notify');

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

// 統一 runner（合併原 callClaude/spawnClaude，健檢 U13）：所有階段共用一份子行程實作，
// 事件流同時寫 socket 與 task_events；支援 cwd（worktree 隔離）、session 捕捉、--resume（主題 B）。
function runClaude(prompt, opts = {}) {
  const { signal, cwd, taskId, userId, model, timeoutMs = 600000, resumeSessionId, env } = opts;
  return new Promise((resolve, reject) => {
    // headless pipeline agent：略過權限提示，否則子行程要 Write/Bash 會卡在無法互動批准
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    // 續用前一輪對話（含規格理解、codebase 探索、上輪 diff），重跑只送短 feedback（健檢 U3）
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    // env：敏感憑證（如 E2E 密碼）以環境變數傳入子行程，不進 prompt/串流/腳本（健檢 E-1）
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd, env: env ? { ...process.env, ...env } : process.env });

    let resultText = '';
    let usage = null;
    let durationMs = null;
    let sessionId = null;
    let usedModel = null;
    let lineBuffer = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const startedAt = Date.now();
    const finish = fn => { if (!settled) { settled = true; if (timer) clearTimeout(timer); fn(); } };
    // 失敗也要能記帳與鑑識：標注失敗類別與實際耗時（健檢 U12）
    const fail = (err, status) => Object.assign(err, { claudeStatus: status, durationMs: Date.now() - startedAt });
    // CLI 掛死時若無 timeout，任務會永久卡在 *_running、merge 鎖永不釋放，只能重啟 server（健檢 U9）
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(fail(new Error(`claude 執行逾時（${Math.round(timeoutMs / 1000)}s）`), 'timeout')));
    }, timeoutMs);
    // 有 taskId 才有落地對象；socket 另需 userId 才知道推給誰（前端依 taskId 路由終端輸出）
    const emit = text => {
      if (!text || !taskId) return;
      if (userId) notify.emitToUser(userId, 'terminal:output', { taskId, data: text });
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
          if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
            sessionId = ev.session_id; // 供 coding 重跑 --resume 續用
          }
          // 抓實際 model（第一則 assistant 事件帶 resolved model id）供成本歸屬
          if (!usedModel && ev.type === 'assistant' && ev.message && ev.message.model) {
            usedModel = ev.message.model;
          }
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
        finish(() => reject(fail(abortError(), 'aborted')));
      }, { once: true });
    }

    child.on('close', code => {
      if (taskId && userId) notify.emitToUser(userId, 'terminal:done', { taskId, exitCode: code });
      finish(() => {
        if (code !== 0 && code !== null) reject(fail(new Error(stderr.trim() || `claude exited with code ${code}`), 'error'));
        else {
          // 實際 model：優先用事件回報的 resolved id，退回 opts 的 model alias（sonnet/opus…）
          const finalModel = usedModel || model || null;
          // 折進 usage，讓 logTokenUsage 零改動就能落 model 欄
          if (usage && finalModel) usage.model = finalModel;
          resolve({ text: resultText.trim(), usage, durationMs, sessionId, model: finalModel });
        }
      });
    });
    child.on('error', err => finish(() => reject(fail(err, 'error'))));
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

module.exports = { runClaude, abortError, stopReason };
