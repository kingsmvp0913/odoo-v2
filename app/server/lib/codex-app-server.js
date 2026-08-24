// Codex app-server 是官方提供給 IDE／桌面端的 JSON-RPC 介面。平台只透過它做
// ChatGPT 訂閱登入與用量讀取；實際 pipeline 仍由 codex exec 執行並共用同一份登入狀態。
const { spawn } = require('child_process');

let child = null;
let ready = null;
let nextId = 1;
let buffer = '';
const pending = new Map();
let login = null;

function stop(err) {
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(err); }
  pending.clear(); child = null; ready = null; buffer = '';
}

function send(method, params, timeoutMs = 15000) {
  if (!child?.stdin?.writable) return Promise.reject(new Error('Codex app-server 尚未啟動'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} 逾時`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ method, id, params }) + '\n');
  });
}

function onMessage(msg) {
  if (msg.id != null && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
    return msg.error ? p.reject(new Error(msg.error.message || 'Codex app-server error')) : p.resolve(msg.result);
  }
  if (msg.method === 'account/login/completed' && login && msg.params?.loginId === login.login_id) {
    login = { ...login, state: msg.params.success ? 'completed' : 'failed', error: msg.params.error || null };
  }
  if (msg.method === 'account/updated' && login && msg.params?.authMode === 'chatgpt') {
    login = { ...login, state: 'completed', plan_type: msg.params.planType || null };
  }
}

function start() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const fail = err => { stop(err); reject(err); };
    child.on('error', err => fail(err.code === 'ENOENT' ? new Error('找不到 codex 執行檔，請先在正式機安裝 Codex CLI') : err));
    child.on('close', () => stop(new Error('Codex app-server 已停止')));
    child.stdout.on('data', data => {
      buffer += data.toString(); let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
        if (!raw) continue;
        try { onMessage(JSON.parse(raw)); } catch { /* app-server stdout 應只有 JSONL；忽略壞行避免中斷既有登入 */ }
      }
    });
    child.stderr.on('data', () => {}); // 診斷訊息不可混進 JSONL，也不可回傳可能含憑證的內容。
    setTimeout(async () => {
      try {
        await send('initialize', { clientInfo: { name: 'idx_ai_dev_workbench', title: 'IDX AI Dev 工作台', version: '1.0' } });
        child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
        resolve();
      } catch (err) { fail(err); }
    }, 0);
  });
  return ready;
}

async function accountStatus() {
  await start();
  const result = await send('account/read', { refreshToken: true });
  const account = result?.account || null;
  return {
    configured: account?.type === 'chatgpt',
    auth_mode: account?.type || null,
    email: account?.email || null,
    plan_type: account?.planType || null,
    pending_login: login && login.state === 'pending' ? login : null
  };
}

async function startDeviceLogin() {
  await start();
  const result = await send('account/login/start', { type: 'chatgptDeviceCode' });
  login = { login_id: result.loginId, verification_url: result.verificationUrl, user_code: result.userCode, state: 'pending', error: null };
  return login;
}

async function rateLimits() {
  await start();
  return send('account/rateLimits/read', {});
}

async function logout() {
  await start();
  await send('account/logout', {});
  login = null;
}

function _resetForTesting() { if (child) child.kill(); child = null; ready = null; nextId = 1; buffer = ''; pending.clear(); login = null; }
module.exports = { accountStatus, startDeviceLogin, rateLimits, logout, _resetForTesting };
