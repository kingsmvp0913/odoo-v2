/** Codex API key 快取；介面刻意與 claude-auth 對齊，runner 可同步取用。 */
const { query } = require('../db');
const { decrypt } = require('./crypto');

let token = null;

async function loadCodexToken() {
  try {
    const { rows } = await query('SELECT openai_api_key_enc FROM teams_settings WHERE id=1');
    token = rows[0]?.openai_api_key_enc ? decrypt(rows[0].openai_api_key_enc) : null;
  } catch (err) {
    console.warn('[CODEX-AUTH] 讀取憑證失敗，改用本機認證：', err.message);
    token = null;
  }
}

function getCodexAuthEnv() { return token ? { OPENAI_API_KEY: token } : {}; }
function shadowingEnvVar() { return process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : null; }
async function resetCodexTokenCache() { await loadCodexToken(); }
function _setForTesting(value) { token = value; }

module.exports = { loadCodexToken, getCodexAuthEnv, shadowingEnvVar, resetCodexTokenCache, _setForTesting };
