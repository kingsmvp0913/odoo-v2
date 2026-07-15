const { query } = require('./db');

// 通用外部通知 channel（outbound webhook）：任務進入需人工動作狀態（stopped/review_pending/
// spec_review/confirm_pending…，見 notify.js ACTION_STATUSES）時，把 payload POST 到 admin 設定的
// notify_webhook_url。這是使用者不在網頁上、也沒設 Microsoft Teams 時唯一的離線通知出口——
// LINE Notify 轉發、Slack incoming webhook、自建接收端都能直接接。

const CACHE_MS = 60000;
let _cache = { url: null, at: 0 };

async function getNotifyWebhookUrl() {
  if (Date.now() - _cache.at < CACHE_MS) return _cache.url;
  try {
    const { rows } = await query('SELECT notify_webhook_url FROM teams_settings WHERE id = 1');
    _cache = { url: (rows[0]?.notify_webhook_url || '').trim() || null, at: Date.now() };
  } catch {
    _cache = { url: null, at: Date.now() };
  }
  return _cache.url;
}

async function sendWebhook(userId, payload) {
  const url = await getNotifyWebhookUrl();
  if (!url) return false;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, ...payload }),
      signal: AbortSignal.timeout(10000)
    });
    return true;
  } catch (err) {
    // 通知失敗只記 log，不得影響 pipeline 狀態轉移
    console.warn('[NOTIFY-WEBHOOK] 送出失敗：', err.message);
    return false;
  }
}

function registerWebhookChannel() {
  const notify = require('./notify');
  notify.registerChannel((userId, payload) => { sendWebhook(userId, payload); });
}

function _resetCacheForTesting() { _cache = { url: null, at: 0 }; }

module.exports = { registerWebhookChannel, sendWebhook, _resetCacheForTesting };
