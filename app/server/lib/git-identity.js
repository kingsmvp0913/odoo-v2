const path = require('path');
const { query } = require('../db');
const { decrypt } = require('./crypto');

class NoGitCredentialError extends Error {
  constructor(msg = '使用者尚未設定個人 GitHub PAT') { super(msg); this.code = 'NO_GIT_CRED'; }
}

// askpass 決策（純函式，供腳本與測試共用語意）
function askpassAnswer(promptArg, pat) {
  return /username/i.test(promptArg || '') ? 'x-access-token' : (pat || '');
}

function askpassShimPath() {
  return path.join(__dirname, process.platform === 'win32' ? 'git-askpass.cmd' : 'git-askpass.sh');
}

// 解出某 user 的 git 注入 env。無 PAT → throw NoGitCredentialError。
async function buildGitEnv(userId) {
  const { rows } = await query(
    'SELECT github_pat_enc, github_login, git_name, git_email FROM users WHERE id = $1', [userId]
  );
  const u = rows[0];
  if (!u || !u.github_pat_enc) throw new NoGitCredentialError();
  const pat = decrypt(u.github_pat_enc);
  const name = u.git_name || u.github_login || 'user';
  const email = u.git_email || `${u.github_login || 'user'}@users.noreply.github.com`;
  return {
    GIT_ASKPASS: askpassShimPath(),
    GIT_ASKPASS_NODE: process.execPath,
    GIT_PAT: pat,
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
    // 機器上設定的 credential.helper（如 Windows Credential Manager）會搶在 GIT_ASKPASS 前被 git 嘗試，
    // 導致仍以機器帳號認證、PAT 被靜默繞過。清空 helper 清單（GIT_CONFIG_* 等效 -c credential.helper=）
    // 讓 askpass 成為唯一來源；GIT_TERMINAL_PROMPT=0 讓壞/空 PAT 直接失敗，不會 headless 卡死等互動輸入。
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_TERMINAL_PROMPT: '0',
  };
}

module.exports = { buildGitEnv, askpassAnswer, NoGitCredentialError, askpassShimPath };
