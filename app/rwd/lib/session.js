// 登入態與樣本資料。截圖不走 UI 登入——token 與主題都存在 localStorage，
// 用 addInitScript 在頁面載入前注入即可，少一個會壞的環節。

const BASE_URL = (process.env.RWD_BASE_URL || 'http://localhost:3939/').replace(/\/?$/, '/');

function apiUrl(path) { return `${BASE_URL}api/${path}`; }

async function login() {
  const username = process.env.RWD_USER;
  const password = process.env.RWD_PASS;
  if (!username || !password) {
    throw new Error('請設定 RWD_USER / RWD_PASS 環境變數（截圖帳號必須是 admin，否則 admin 頁會被導回首頁）');
  }
  const res = await fetch(apiUrl('auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`登入失敗 HTTP ${res.status} ${body}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error('登入回應沒有 token');
  return data.token;
}

async function getJson(path, token) {
  const res = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

// 驗證帳號權限。非 admin 會讓 12 個 admin 頁靜默截到首頁——
// 那種假綠比紅燈危險，所以在這裡就擋掉（CLAUDE.md §5 Rule 12：Fail Loud）。
async function assertAdmin(token) {
  const me = await getJson('auth/me', token);
  if (me.role !== 'admin') {
    throw new Error(`截圖帳號 role=${me.role}，需要 admin。admin 頁會被 app.js:61 的 guard 導回首頁。`);
  }
  return me;
}

// 一定要拿 id 而不是 task_id：`task_id` 是客服來的外部單號（`manual_1785993215853` 這種字串），
// 而 #/task/:id 路由吃的是 DB 整數主鍵。挑錯的那個不會報錯，只會讓 task-detail 這頁的基線
// 一直是「invalid input syntax for type integer」錯誤頁——全站第二重要的頁面等於沒進門禁。
function firstId(payload) {
  const list = Array.isArray(payload) ? payload : (payload.tasks || payload.projects || payload.rows || []);
  return list.length ? (list[0].id || list[0].task_id) : null;
}

// :taskId / :projectId 這類路由需要真實樣本。取不到就讓該路由跳過並在報告中列明，
// 不要拿假 id 去截一張 404 畫面當基線。
async function sampleIds(token) {
  const ids = {};
  try { ids.taskId = firstId(await getJson('tasks', token)); } catch { ids.taskId = null; }
  try { ids.projectId = firstId(await getJson('projects', token)); } catch { ids.projectId = null; }
  return ids;
}

function resolveUrl(route, ids) {
  if (route.path) return `${BASE_URL}${route.path}`;
  const hash = route.hash
    .replace(':taskId', ids.taskId)
    .replace(':projectId', ids.projectId);
  return `${BASE_URL}${hash}`;
}

module.exports = { BASE_URL, apiUrl, login, getJson, assertAdmin, sampleIds, resolveUrl };
