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

// 解出某 user 的 git 注入 env。退回順序：個人 → 公司 →（平台管理員不退回）→ 丟例外（規格 §6）。
// 個人優先是為了「推上去看得出是誰」；平台管理員沒有公司可退，悄悄退到某家公司的憑證
// 會讓 commit 掛上錯誤的身分，所以 09-14 裁決是擋下、要他自己填個人 PAT。
// 回傳值多一個 source，讓呼叫端寫得出「這次是用誰的身分推的」。
const { hardenGitEnv } = require('./git-hardening');
const { isUserCompanyUsable } = require('./tenant-access');

async function buildGitEnv(userId) {
  const { rows } = await query(
    `SELECT u.github_pat_enc, u.github_login, u.git_name, u.git_email,
            c.git_pat_enc AS co_pat_enc, c.git_login AS co_login,
            c.git_name AS co_name, c.git_email AS co_email
       FROM users u
       LEFT JOIN companies c ON c.id = u.company_id
      WHERE u.id = $1`,
    [userId]
  );
  const u = rows[0];
  if (!u) throw new NoGitCredentialError();

  // 停用或到期的公司，它的憑證不可以再被拿來推 code（規格 §7）。
  // HTTP 那一側第 1 部的全域閘門已經擋掉了，但 cron／部署／夜間批次不經過 HTTP。
  const companyUsable = u.co_pat_enc ? await isUserCompanyUsable(userId) : true;

  let source, patEnc, login, name, email;
  if (u.github_pat_enc) {
    source = 'personal';
    patEnc = u.github_pat_enc; login = u.github_login; name = u.git_name; email = u.git_email;
  } else if (u.co_pat_enc && companyUsable) {
    source = 'company';
    patEnc = u.co_pat_enc; login = u.co_login; name = u.co_name; email = u.co_email;
  } else {
    throw new NoGitCredentialError();
  }

  const pat = decrypt(patEnc);
  const gitName = name || login || 'user';
  const gitEmail = email || `${login || 'user'}@users.noreply.github.com`;
  const out = hardenGitEnv({
      GIT_ASKPASS: askpassShimPath(),
      GIT_ASKPASS_NODE: process.execPath,
      GIT_PAT: pat,
      GIT_AUTHOR_NAME: gitName, GIT_AUTHOR_EMAIL: gitEmail,
      GIT_COMMITTER_NAME: gitName, GIT_COMMITTER_EMAIL: gitEmail,
      // 機器上設定的 credential.helper（如 Windows Credential Manager）會搶在 GIT_ASKPASS 前被 git 嘗試，
      // 導致仍以機器帳號認證、PAT 被靜默繞過。清空 helper 清單（GIT_CONFIG_* 等效 -c credential.helper=）
      // 讓 askpass 成為唯一來源；GIT_TERMINAL_PROMPT=0 讓壞/空 PAT 直接失敗，不會 headless 卡死等互動輸入。
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_TERMINAL_PROMPT: '0',
  });
  // source 刻意設成「不可列舉」：gitEnv 在 7 個地方被 { ...process.env, ...gitEnv } 整包
  // 展開丟進子行程（lib/deploy-run.js:218、lib/enterprise-sources.js:124、
  // pipeline/finding-fix.js:445/459/575、project-routes.js:148、pipeline/git.js:54）。
  // 若用普通屬性，git 會收到一個叫 source 的環境變數——無害但髒，而且以後有人加
  // 別的 metadata 時會一路帶進所有子行程。不可列舉讓展開拿不到它，gitEnv.source 照樣讀得到。
  Object.defineProperty(out, 'source', { value: source, enumerable: false });
  return out;
}

// 交給 AI 子行程（含容器）的 git env：只有身分。AI 只 commit 不 push，PAT／askpass 不出平台（子專案 0 §4.2）
const IDENTITY_KEYS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
function pickGitIdentity(gitEnv) {
  const out = {};
  for (const k of IDENTITY_KEYS) if (gitEnv && gitEnv[k]) out[k] = gitEnv[k];
  return out;
}

module.exports = { buildGitEnv, askpassAnswer, NoGitCredentialError, askpassShimPath, pickGitIdentity };
