const fs = require('fs');
const { execFile } = require('child_process');

// 測試區對外曝露：把「running 的專案 → 對外子網域 → 測試埠」寫成共用 nginx 的 map include 檔。
// server block 內 `map $host $env_port { include <此檔>; }` + `proxy_pass http://<ENV_BIND_HOST>:$env_port`；
// 平台只寫這個 include 檔，不碰 server block（B3 一次性人工設定）。
//
// 安全前提（設計 Phase B）：整段以 env `NGINX_SYNC_MAP_FILE` 當 gate——未設＝完全不執行，
// Windows/未反代機零影響。寫檔後先 `nginx -t`，過才 reload；不過就 rollback 舊檔、絕不 reload 壞檔，
// 以免壞設定卡到同一台共用 nginx 上其他站台的下次 reload。同步失敗只影響對外連結，不阻斷建/刪環境。

// 只納入「測試區 running 且已配發 projects.port」者；folder_name 缺時退回 name（與 env-agent dirName 一致）。
const RUNNING_SQL = `
  SELECT COALESCE(p.folder_name, p.name) AS folder, p.port AS port
  FROM projects p JOIN odoo_envs e ON e.project_id = p.id
  WHERE e.status = 'running' AND p.port IS NOT NULL
  ORDER BY p.port`;

// 由對外網址樣板推導某 folder 的 host（樣板未設或無法解析 → null，該項略過而非寫出壞行）。
function hostForFolder(folder) {
  const tpl = process.env.ENV_PUBLIC_URL_TEMPLATE;
  if (!tpl) return null;
  try { return new URL(tpl.replace(/\{folder\}/g, folder || '')).host; }
  catch { return null; }
}

// 純函式：DB rows → map include 檔內容。default 落 444（server block 對 444 回關閉連線，擋未知子網域）。
function buildMapContent(entries, hostFor) {
  const lines = ['default 444;'];
  for (const e of entries || []) {
    if (!e || !e.port || !e.folder) continue;
    const host = hostFor(e.folder);
    if (!host) continue;
    lines.push(`${host} ${e.port};`);
  }
  return lines.join('\n') + '\n';
}

// 唯一的 process IO 邊界：跑 docker/nginx，測試以 deps.run 注入 mock。
function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// 依當前 DB 狀態重寫 map 並讓共用 nginx 生效。不 throw：任何失敗只 loud log，回結果物件。
async function syncNginxMap(deps = {}) {
  const mapFile = process.env.NGINX_SYNC_MAP_FILE;
  if (!mapFile) return { skipped: true }; // gate：未設 → 整段新流程不執行

  const q = deps.query || require('../db').query;
  const fsx = deps.fs || fs;
  const run = deps.run || defaultRun;
  const hostFor = deps.hostFor || hostForFolder;
  const container = process.env.NGINX_CONTAINER; // 容器名以 env 設定，不寫死

  try {
    if (!container) throw new Error('NGINX_SYNC_MAP_FILE 已設但缺 NGINX_CONTAINER');
    const { rows } = await q(RUNNING_SQL);
    const content = buildMapContent(rows, hostFor);
    const prev = fsx.existsSync(mapFile) ? fsx.readFileSync(mapFile, 'utf8') : null;

    // 原子寫入：先寫 .tmp 再 rename（同分割區 rename 為原子操作，nginx 不會讀到半截檔）。
    const tmp = `${mapFile}.tmp`;
    fsx.writeFileSync(tmp, content);
    fsx.renameSync(tmp, mapFile);

    const test = await run('docker', ['exec', container, 'nginx', '-t']);
    if (test.code !== 0) {
      if (prev === null) fsx.unlinkSync(mapFile); else fsx.writeFileSync(mapFile, prev);
      console.error(`[nginx-map] nginx -t 失敗，已 rollback 舊 map、未 reload：${(test.stderr || '').trim()}`);
      return { ok: false, rolledBack: true };
    }

    const reload = await run('docker', ['exec', container, 'nginx', '-s', 'reload']);
    if (reload.code !== 0) {
      console.error(`[nginx-map] nginx reload 失敗（map 已過 -t、內容已更新）：${(reload.stderr || '').trim()}`);
      return { ok: false, reloadFailed: true };
    }
    return { ok: true, count: rows.length };
  } catch (err) {
    console.error(`[nginx-map] 同步失敗（不阻斷建/刪環境）：${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { buildMapContent, syncNginxMap, hostForFolder };
