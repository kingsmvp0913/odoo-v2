const fs = require('fs');
const { execFile } = require('child_process');

// 測試區對外曝露（port 模式）：把「running 的測試區 → 對外埠」寫成共用 nginx 的 include 檔，
// 每個測試區產一段 `server { listen <port> ssl; ... proxy_pass http://<ENV_BIND_HOST>:<port>; }`。
// 全部共用同一張裸網域憑證（server_name 皆為 ENV_PUBLIC_URL_TEMPLATE 的主機名），
// 使用者連 `https://<host>:<port>`——憑證只認主機名不認 port，一張蓋全部埠。
//
// 為何不用 wildcard 子網域：DNS 在 Wix，不支援 `*` 記錄、也無 ACME DNS API，wildcard 起不來。
// port 模式只需裸網域一張 HTTP-01 憑證（可一鍵簽），且新專案自動配埠、零人工 DNS/憑證。
//
// 安全前提：整段以 env `NGINX_SYNC_CONF_FILE` 當 gate——未設＝完全不執行，Windows/未反代機零影響。
// 寫檔後先 `nginx -t`，過才 reload；不過就 rollback 舊檔、絕不 reload 壞檔，以免壞設定卡到同一台
// 共用 nginx 上其他站台的下次 reload。同步失敗只影響對外連結，不阻斷建/刪環境。
// 曝露的埠段務必以 VPN／IP 白名單擋在可信來源內（測試區跑未審程式碼、且與平台共用 PG superuser）。

// 只納入「測試區 running 且已配發 projects.port」者。
const RUNNING_SQL = `
  SELECT p.port AS port
  FROM projects p JOIN odoo_envs e ON e.project_id = p.id
  WHERE e.status = 'running' AND p.port IS NOT NULL
  ORDER BY p.port`;

// 由對外網址樣板推導 server_name 的主機名（去掉 port）。樣板未設或無法解析 → null。
function publicHost() {
  const tpl = process.env.ENV_PUBLIC_URL_TEMPLATE;
  if (!tpl) return null;
  try {
    const sub = tpl.replace(/\{port\}/g, '0').replace(/\{folder\}/g, 'x').replace(/\{host\}/g, 'x');
    return new URL(sub).hostname || null;
  } catch { return null; }
}

// 純函式：running 埠 rows → nginx server block 字串。cfg = { host, bindHost, cert, key }。
// 無 port 的項略過（不寫半截 block）；無 running 者回空字串（空 conf 檔對 nginx 合法）。
function buildServerBlocks(entries, cfg) {
  const { host, bindHost, cert, key } = cfg || {};
  const blocks = [];
  for (const e of entries || []) {
    if (!e || !e.port) continue;
    blocks.push(
`server {
    listen ${e.port} ssl;
    server_name ${host};
    ssl_certificate ${cert};
    ssl_certificate_key ${key};
    location / {
        proxy_pass http://${bindHost}:${e.port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 50m;
        proxy_read_timeout 600s;
    }
}`);
  }
  return blocks.length ? blocks.join('\n') + '\n' : '';
}

// 唯一的 process IO 邊界：跑 docker/nginx，測試以 deps.run 注入 mock。
function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// 依當前 DB 狀態重寫 conf 並讓共用 nginx 生效。不 throw：任何失敗只 loud log，回結果物件。
async function syncNginxMap(deps = {}) {
  const confFile = process.env.NGINX_SYNC_CONF_FILE;
  if (!confFile) return { skipped: true }; // gate：未設 → 整段新流程不執行

  const q = deps.query || require('../db').query;
  const fsx = deps.fs || fs;
  const run = deps.run || defaultRun;
  const container = process.env.NGINX_CONTAINER; // 容器名以 env 設定，不寫死
  const cfg = {
    host: deps.host || publicHost(),
    bindHost: process.env.ENV_BIND_HOST,
    cert: process.env.ENV_TLS_CERT,
    key: process.env.ENV_TLS_KEY,
  };

  try {
    if (!container) throw new Error('NGINX_SYNC_CONF_FILE 已設但缺 NGINX_CONTAINER');
    const missing = ['host', 'bindHost', 'cert', 'key'].filter(k => !cfg[k]);
    if (missing.length) {
      throw new Error(`NGINX_SYNC_CONF_FILE 已設但缺設定：${missing.join('/')}（需 ENV_PUBLIC_URL_TEMPLATE／ENV_BIND_HOST／ENV_TLS_CERT／ENV_TLS_KEY）`);
    }
    const { rows } = await q(RUNNING_SQL);
    const content = buildServerBlocks(rows, cfg);
    const prev = fsx.existsSync(confFile) ? fsx.readFileSync(confFile, 'utf8') : null;

    // 原子寫入：先寫 .tmp 再 rename（同分割區 rename 為原子操作，nginx 不會讀到半截檔）。
    const tmp = `${confFile}.tmp`;
    fsx.writeFileSync(tmp, content);
    fsx.renameSync(tmp, confFile);

    const test = await run('docker', ['exec', container, 'nginx', '-t']);
    if (test.code !== 0) {
      if (prev === null) fsx.unlinkSync(confFile); else fsx.writeFileSync(confFile, prev);
      console.error(`[nginx-map] nginx -t 失敗，已 rollback 舊 conf、未 reload：${(test.stderr || '').trim()}`);
      return { ok: false, rolledBack: true };
    }

    const reload = await run('docker', ['exec', container, 'nginx', '-s', 'reload']);
    if (reload.code !== 0) {
      console.error(`[nginx-map] nginx reload 失敗（conf 已過 -t、內容已更新）：${(reload.stderr || '').trim()}`);
      return { ok: false, reloadFailed: true };
    }
    return { ok: true, count: rows.length };
  } catch (err) {
    console.error(`[nginx-map] 同步失敗（不阻斷建/刪環境）：${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { buildServerBlocks, syncNginxMap, publicHost };
