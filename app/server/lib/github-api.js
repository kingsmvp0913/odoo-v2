const https = require('https');

// 純函式：從 GET /user 與 GET /user/emails 的回應組出 git 身分。
// email 優先 primary+verified，無則退 GitHub noreply（保證連得到帳號、且尊重隱私）。
function buildIdentityFromResponses(user, emails) {
  const login = user.login;
  const name = user.name || login;
  let email = null;
  if (Array.isArray(emails)) {
    const primary = emails.find(e => e.primary && e.verified) || emails.find(e => e.verified);
    if (primary) email = primary.email;
  }
  if (!email) email = `${user.id}+${login}@users.noreply.github.com`;
  return { login, name, email };
}

// 對 api.github.com 發一次 GET（帶 PAT）。回 { status, json }。
function realHttpGet(pathname, pat) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path: pathname, method: 'GET',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'User-Agent': 'odoo-v2-platform',
        'Accept': 'application/vnd.github+json'
      },
      timeout: 10000
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(raw || 'null') }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('連線 GitHub 逾時')); });
    req.end();
  });
}

// 驗證 PAT 並抓身分。httpGetImpl 可注入供測試。
async function fetchGitHubIdentity(pat, httpGetImpl = realHttpGet) {
  const userRes = await httpGetImpl('/user', pat);
  if (userRes.status === 401) throw new Error('GitHub 認證失敗：PAT 無效');
  if (userRes.status !== 200 || !userRes.json) throw new Error(`GitHub /user 回應異常（${userRes.status}）`);
  const emailsRes = await httpGetImpl('/user/emails', pat).catch(() => ({ status: 0, json: null }));
  const emails = emailsRes.status === 200 ? emailsRes.json : null;
  return buildIdentityFromResponses(userRes.json, emails);
}

module.exports = { buildIdentityFromResponses, fetchGitHubIdentity, realHttpGet };
