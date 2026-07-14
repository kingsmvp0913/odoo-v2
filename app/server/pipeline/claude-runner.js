const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const notify = require('../notify');

// 每關「刻意指定」MCP：pipeline 子行程一律不繼承環境 MCP（--strict-mcp-config），
// 凡需查「grep 補不了的 Odoo 原生知識」的關卡都掛 context7：analysis/coding（API 用法）、
// playwright（tour selector/導航 URL）、qa（判 base Odoo 是否合法）、reject_triage（判是否不符 Odoo 標準）、chat（技術問答）。
// 缺 context7 的關卡會退而 grep/find 本機 Odoo core（odoo-envs），曾滾成 `find /` 全碟掃描 → 逾時。
// 實測 serena 即使在場也不被用（Grep/Read 已覆蓋 repo 內 symbol 查詢），故全 pipeline 不掛 serena，省下冷啟動 indexing 與空找 schema。
const MCP_PROFILES = {
  analysis: 'context7.json', coding: 'context7.json',
  playwright: 'context7.json', qa: 'context7.json', reject_triage: 'context7.json', chat: 'context7.json',
};
function mcpConfigPath(agentType) {
  return path.join(__dirname, 'mcp', MCP_PROFILES[agentType] || 'none.json');
}

// task_events 批次寫入：顯示走 socket 即時，持久化累積後批量落地（取代每行一筆的高頻 INSERT）
const EVENT_FLUSH_MS = parseInt(process.env.PIPELINE_EVENT_FLUSH_MS || '500', 10);
const EVENT_FLUSH_MAX = parseInt(process.env.PIPELINE_EVENT_FLUSH_MAX || '50', 10);

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
    // headless pipeline agent：略過權限提示，否則子行程要 Write/Bash 會卡在無法互動批准
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (model) args.push('--model', model);
    // 每關只載入指定的 MCP，剝掉繼承的 serena 等（見 MCP_PROFILES）
    args.push('--strict-mcp-config', '--mcp-config', mcpConfigPath(agentType));
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
      child.kill('SIGTERM');
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

module.exports = { runClaude, abortError, stopReason, mcpConfigPath };
