/**
 * figma-auth.js — Figma REST API 的 personal access token（全平台一把，管理員在網頁設定）
 *
 * 為什麼是 REST + PAT 而不是 Figma 官方 MCP：官方 MCP（remote 與 desktop 皆然）只認 OAuth，
 * 而 OAuth 只能在互動式 client 裡完成授權——pipeline 的 `claude -p` 是 headless 子行程，跑不了。
 * 更硬的一道：官方 MCP 的所有讀取工具都要求該檔案的 **edit access**，`View` seat 一律被拒
 * （2026-08-14 實測 whoami=View seat，get_figjam／get_screenshot 皆回 "don't have edit access"）。
 * REST 的 `file_content:read` 只要看得到檔案就讀得到（同一個檔案、同一個帳號，REST 回 200、
 * `role: viewer`）。所以走 REST 不是退而求其次，是唯一在 headless ＋ view 權限下成立的路。
 *
 * 與 context7 key 的關鍵差異：context7 未設定時退匿名額度（軟失敗），**Figma 沒有匿名額度**——
 * 未設定就是讀不到任何東西。故 `/ai/figma` 在無 key 時必須明確 fail loud（見 figma-routes），
 * 不可回空結果讓 agent 以為「這份設計稿沒有內容」。
 *
 * 讀取端同步：與 lib/context7-auth、lib/claude-auth 同理，非同步只發生在啟動載入（index.js）
 * 與管理員存檔（resetFigmaKeyCache）。
 *
 * 本模組不得把 token 寫進任何 log。
 */
const { query } = require('../db');
const { decrypt } = require('./crypto');

let _key = null;

async function loadFigmaKey() {
  try {
    const { rows } = await query('SELECT figma_api_key_enc FROM teams_settings WHERE id = 1');
    const blob = rows[0]?.figma_api_key_enc;
    _key = blob ? decrypt(blob) : null;
  } catch (err) {
    // APP_SECRET 換過／密文損壞／DB 查不到：此處絕不能 throw（啟動載入若炸開會讓整台 server 起不來）。
    // 後果由 /ai/figma 的無 key 分支負責講清楚，不在這裡吞成沉默。
    console.warn('[FIGMA-AUTH] 讀取 API key 失敗，Figma 查詢將無法使用：', err.message);
    _key = null;
  }
}

// 同步：未設定回 null，由呼叫端決定如何報錯
function getFigmaApiKey() {
  return _key || null;
}

async function resetFigmaKeyCache() {
  await loadFigmaKey();
}

function _setForTesting(key) { _key = key; }

module.exports = { loadFigmaKey, getFigmaApiKey, resetFigmaKeyCache, _setForTesting };
