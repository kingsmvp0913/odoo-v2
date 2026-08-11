/**
 * context7-auth.js — context7 MCP 的 API key（全平台一把，管理員在網頁設定）
 *
 * 背景：未設 key 時 context7 走匿名額度（依來源 IP 計）。配額用盡**不會**變成錯誤——MCP 照常
 * 回應，內容是一句 "Monthly quota exceeded"，工具呼叫仍算成功、任務狀態仍是 completed。於是各關
 * 拿不到 Odoo 官方寫法，改用 WebSearch/WebFetch 去 raw.githubusercontent.com 抓原始碼：慢、不準，
 * 且那段消耗常常不進 token_usage（2026-08-11 實測 task 122）。全程無告警，只在 task_events 的
 * 工具回傳裡看得到。加一把免費 key 即可把額度拉開。
 *
 * 讀取端刻意是同步的：`context7ConfigPath()` 在 spawn 當下組 MCP 設定檔，改成 async 會讓
 * 既有「呼叫後同步對 mock child 發事件」的 runner 測試整片失效（與 lib/claude-auth 同理）。
 * 非同步只發生在啟動載入（index.js）與管理員存檔（resetContext7KeyCache）。
 *
 * 本模組不得把 key 寫進任何 log。
 */
const { query } = require('../db');
const { decrypt } = require('./crypto');

let _key = null;

async function loadContext7Key() {
  try {
    const { rows } = await query('SELECT context7_api_key_enc FROM teams_settings WHERE id = 1');
    const blob = rows[0]?.context7_api_key_enc;
    _key = blob ? decrypt(blob) : null;
  } catch (err) {
    // APP_SECRET 換過／密文損壞／DB 查不到：退回匿名額度即可，絕不能 throw
    //（啟動載入若炸開會讓整台 server 起不來）
    console.warn('[CONTEXT7-AUTH] 讀取 API key 失敗，改用匿名額度：', err.message);
    _key = null;
  }
}

// 同步：未設定回 null，由呼叫端決定不寫 env（寫 '' 會蓋掉手動設定的環境變數）
function getContext7ApiKey() {
  return _key || null;
}

async function resetContext7KeyCache() {
  await loadContext7Key();
}

function _setForTesting(key) { _key = key; }

module.exports = { loadContext7Key, getContext7ApiKey, resetContext7KeyCache, _setForTesting };
