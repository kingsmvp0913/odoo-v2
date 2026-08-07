const fs = require('fs');
const { execFile } = require('child_process');
// db 必須在檔頭 require：syncNginxMap 會被 syncNginxMapDebounced 的 timer 叫到，而那個 timer
// 是 unref 的背景路徑，可能在 jest 拆掉環境之後才觸發——延遲 require 到那時才執行會拋
// 「import a file after the Jest environment has been torn down」，測試全綠卻讓 jest exit 1。
const { query: dbQuery } = require('../db');

// 測試區對外曝露（子網域模式）：把「running 且持有對外名額（external_slot）的測試區 → 內部埠」
// 寫成共用 nginx 的 include 檔，每個持名額者產一段
// `server { listen 443 ssl; server_name <slot 對應子網域>; proxy_pass http://<ENV_BIND_HOST>:<port>; }`。
// 對外一律走 443、靠 server_name 分流；連到哪個內部埠才是「這台在跑哪個測試區」的實際差異，
// 不再靠「開了哪個埠」這種需要 NAT 逐一放行的方式暴露。
//
// slot 與子網域的對應由 ENV_EXTERNAL_URL_TEMPLATE（形如 https://odoo-ai-test-{slot}.ideaxpress.biz）
// 代入 {slot} 推出，只認 0–9 共 10 個固定子網域。
//
// 為何不是 wildcard：DNS 在 Wix，不支援 `*` 記錄、也無 ACME DNS API，wildcard 憑證起不來；
// 改用一張涵蓋 10 個固定子網域的 SAN 憑證（HTTP-01 逐一簽好即可）替代每測試區各配一張裸網域憑證，
// 也不必再靠「開埠」讓使用者分辨測試區。
//
// 曝露的名額是租約（odoo_envs.external_slot），與 pipeline 跑用的內部埠（odoo_envs.port）是兩個池：
// 只有 running 且持有 external_slot（真人在看）的才會被列進這份 conf；pipeline 自己在跑但沒人在看
// 的環境有 port、沒 slot，不會被對外曝露——這是雙池分離的落地點。
//
// 安全前提：整段以 env `NGINX_SYNC_CONF_FILE` 當 gate——未設＝完全不執行，Windows/未反代機零影響。
// 寫檔前必先過 assertServerNames 這道守衛（見下方函式）：這份 conf 會被 include 進與正式站
// （AICEO/IDX…）共用的同一台 nginx，一旦 server_name 推導出錯，等於把測試區的 location 蓋到
// 正式站的網域上。寫檔後先 `nginx -t`，過才 reload；不過就 rollback 舊檔、絕不 reload 壞檔，
// 以免壞設定卡到同一台共用 nginx 上其他站台的下次 reload。同步失敗只影響對外連結，不阻斷建/刪環境。
// 對外曝露面因此收斂成固定 10 個子網域走 443：原本每個測試區各自對外的 21000–21099 埠段全部
// 收回內網、不再對公網開放；443 本來就已對公網開通常無需再逐一放行 NAT。真要限制來源（測試區
// 跑未審程式碼、且與平台共用 PG superuser），改在 443 前端加 IP 白名單／VPN，不再是逐埠管制。

// 只納入「running 且持有對外名額」者。pipeline 跑起來但沒人在看的環境有 port、沒 slot，
// 故不會被寫進 nginx——這是雙池分離的落地點，讀錯條件就退回「pipeline 吃掉對外名額」的老問題。
const RUNNING_SQL = `
  SELECT e.external_slot AS slot, e.port AS port
  FROM odoo_envs e
  WHERE e.status = 'running' AND e.external_slot IS NOT NULL AND e.port IS NOT NULL
  ORDER BY e.external_slot`;

// 由對外網址樣板代入 slot 推出該段的 server_name。樣板未設或無法解析 → null。
function externalServerName(slot) {
  const tpl = process.env.ENV_EXTERNAL_URL_TEMPLATE;
  if (!tpl) return null;
  try { return new URL(tpl.replace(/\{slot\}/g, String(slot))).hostname || null; }
  catch { return null; }
}

// 寫檔前的最後一道保全。這份 conf 會被 include 進與正式站共用的同一台 nginx，
// 程式一旦產出非預期的 server_name，等於把測試區的 location 蓋到正式站的網域上。
// 兩項斷言：
//   1. 每段都推得出 server_name
//   2. 主機名最左標籤以 -<slot> 結尾 → 反證樣板確實含 {slot}
//      （缺 {slot} 時 10 個名額會產出 10 段同名 server_name，直接蓋掉那個網域）
// 刻意不寫死 `odoo-ai-test` 字面值：寫死的話換網域就得改碼，而漏改的症狀是守衛全面誤擋。
function assertServerNames(entries) {
  for (const e of entries || []) {
    if (!e || !e.port) continue;
    const name = externalServerName(e.slot);
    if (!name) throw new Error(`slot ${e.slot} 無法由 ENV_EXTERNAL_URL_TEMPLATE 推出 server_name，中止同步`);
    const label = String(name).split('.')[0];
    if (!new RegExp(`-${e.slot}$`).test(label)) {
      throw new Error(`server_name「${name}」未以 -${e.slot} 結尾＝樣板缺 {slot}；多個名額會產出同名 server_name 並蓋掉共用 nginx 上的其他站台，中止同步`);
    }
  }
}

// 純函式：持名額的環境 rows → nginx server block 字串。cfg = { bindHost, cert, key }。
// 對外一律 443、靠 server_name 分流；內部埠只出現在 proxy_pass（容器→宿主，不經 NAT）。
// 無 port 的項略過（不寫半截 block）；無人持有名額時回空字串（空 conf 檔對 nginx 合法）。
function buildServerBlocks(entries, cfg) {
  const { bindHost, cert, key } = cfg || {};
  const blocks = [];
  for (const e of entries || []) {
    if (!e || !e.port) continue;
    blocks.push(
`server {
    listen 443 ssl;
    server_name ${externalServerName(e.slot)};
    ssl_certificate ${cert};
    ssl_certificate_key ${key};
    location / {
        proxy_pass http://${bindHost}:${e.port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
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

  const q = deps.query || dbQuery;
  const fsx = deps.fs || fs;
  const run = deps.run || defaultRun;
  const container = process.env.NGINX_CONTAINER; // 容器名以 env 設定，不寫死
  const cfg = {
    bindHost: process.env.ENV_BIND_HOST,
    cert: process.env.ENV_TLS_CERT,
    key: process.env.ENV_TLS_KEY,
  };

  try {
    if (!container) throw new Error('NGINX_SYNC_CONF_FILE 已設但缺 NGINX_CONTAINER');
    const missing = ['bindHost', 'cert', 'key'].filter(k => !cfg[k]);
    if (missing.length) {
      throw new Error(`NGINX_SYNC_CONF_FILE 已設但缺設定：${missing.join('/')}（需 ENV_BIND_HOST／ENV_TLS_CERT／ENV_TLS_KEY）`);
    }
    if (!process.env.ENV_EXTERNAL_URL_TEMPLATE) {
      throw new Error('NGINX_SYNC_CONF_FILE 已設但缺 ENV_EXTERNAL_URL_TEMPLATE（子網域模式的 server_name 來源）');
    }
    const { rows } = await q(RUNNING_SQL);
    assertServerNames(rows); // 守衛不過即 throw，落入下方 catch：不寫檔、不 reload、loud log
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

// 防抖版入口。這台 nginx 與多個正式站共用，一次 reload 會重讀所有站的設定；閒置回收與夜間
// 關機會在幾秒內連續還掉一整批名額，逐一 reload 等於連續打擾正式站。窗口內的多次變動合併成一次。
//
// ⚠️ 借名額的路徑不得用這個版本——借完會立刻把網址交給瀏覽器開新頁，delay 期間 nginx 還沒
// reload，使用者當下拿到 502。借用 syncNginxMap（同步等 -t + reload 完成），只有「還」走這裡。
const DEBOUNCE_MS = parseInt(process.env.NGINX_SYNC_DEBOUNCE_MS || '1500', 10);
let _debounceTimer = null;
let _debounceWaiters = [];

function syncNginxMapDebounced(deps = {}) {
  return new Promise((resolve) => {
    _debounceWaiters.push(resolve);
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(async () => {
      _debounceTimer = null;
      const waiters = _debounceWaiters;
      _debounceWaiters = [];
      const result = await syncNginxMap(deps).catch(err => ({ ok: false, error: err.message }));
      for (const w of waiters) w(result);
    }, deps.debounceMs ?? DEBOUNCE_MS);
    // 別讓這個 timer 拖住 process 結束（cron 短命進程／jest）
    if (_debounceTimer.unref) _debounceTimer.unref();
  });
}

module.exports = { buildServerBlocks, syncNginxMap, syncNginxMapDebounced, externalServerName, assertServerNames };
