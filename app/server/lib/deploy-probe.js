// 環境評估器：唯讀探測客戶機，回報「這台機器長什麼形狀」。
//
// 探測與解析刻意分家：解析是純函式，用兩台真機的實際輸出當 fixture 測得起來；
// SSH 那半只有在有真機時才驗得了。自己編的樣本過了不代表看得懂真機吐出來的東西。
const { sshExec, sudoPrefix, requireIdent, validatePath } = require('./ssh-exec');
const { maskSecrets } = require('./log-parse');

// 段落標記。用 ### 前綴切段，指令輸出裡不會自然出現這個開頭。
const SECT = /^### (.+)$/;

function sections(stdout) {
  const out = {};
  let cur = null;
  for (const line of String(stdout || '').split('\n')) {
    const m = SECT.exec(line);
    if (m) { cur = m[1].trim(); out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n');
  return out;
}

// 全部唯讀。任何一行都不得寫入、重啟或安裝——這支會連進客戶的正式機。
function buildProbeScript(conn) {
  const S = sudoPrefix(conn);
  return [
    'echo "### whoami"; id',
    'echo "### host"; hostname; (grep PRETTY /etc/os-release) 2>/dev/null',
    'echo "### sudo-nopass"; sudo -n true 2>&1; echo "RC=$?"',
    `echo "### docker"; ${S}docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}' 2>&1`,
    'echo "### systemd-odoo"; systemctl list-units --type=service --all --no-pager 2>/dev/null | grep -i odoo',
    'echo "### initd-odoo"; ls /etc/init.d/ 2>/dev/null | grep -i odoo',
    'echo "### conf"; ls -l /etc/odoo* 2>&1',
    'echo "### hostconf"; cat /etc/odoo*.conf 2>/dev/null',
    'echo "### disk"; df -h / 2>/dev/null',
    'echo "### tools"; which git tar pg_dump 2>&1',
    // spec §11 唯一還沒解的事實：慈雲那台的 Odoo 版本。docker 環境宿主問不到，由 runProbe 進容器補。
    'echo "### odooversion"; (odoo --version 2>/dev/null || odoo-bin --version 2>/dev/null || python3 -c "import odoo.release as r;print(r.version)" 2>/dev/null) | head -1',
  ].join('\n');
}

// 容器是不是部署目標：用 image 排除資料庫與周邊服務。
// 只看名字含 odoo 會把 odoo-db 收進來——它的名字有 odoo，image 卻是 postgres:16。
function isDeployCandidate(image) {
  return !/^(postgres|mysql|mariadb|redis|caddy|nginx|traefik|portainer)/i.test(image || '');
}

function parseProbe(stdout) {
  const s = sections(stdout);

  // sudo -n true 成功（RC=0）＝免密。其餘一律當「需要密碼」，實際有沒有密碼可用
  // 由呼叫端看 db_connections 有沒有存。
  const sudoMode = /RC=0/.test(s['sudo-nopass'] || '') ? 'nopasswd' : 'password';

  const containers = [];
  for (const line of (s['docker'] || '').split('\n')) {
    const parts = line.split('|');
    if (parts.length < 2) continue;              // 「command not found」這類錯誤訊息沒有分隔符
    const [name, image, ports] = parts;
    if (!name.trim() || !isDeployCandidate(image)) continue;
    containers.push({ name: name.trim(), image: (image || '').trim(), ports: (ports || '').trim() });
  }

  const units = [];
  for (const line of (s['systemd-odoo'] || '').split('\n')) {
    const m = /^\s*(\S+)\.service\s/.exec(line);
    if (m) units.push(m[1]);
  }

  const disk = /(\d+)G\s+\d+%/.exec(s['disk'] || '');
  const diskAvailGb = disk ? Number(disk[1]) : null;

  const runtime = containers.length ? 'docker' : (units.length ? 'systemd' : 'unknown');

  // 宿主直接跑得到 odoo 才有值；docker 環境要進容器問，由 runProbe 補
  const odooVersion = (s['odooversion'] || '').trim().split('\n')[0] || null;

  return { runtime, sudoMode, containers, units, diskAvailGb, odooVersion };
}

function parseComposeLabels(stdout) {
  const g = (k) => {
    const m = new RegExp(`${k}=(\\S*)`).exec(String(stdout || ''));
    return m ? m[1] : '';
  };
  return { project: g('project'), service: g('service'), workingDir: g('workdir'), configFiles: g('files') };
}

function parseConf(text) {
  const t = String(text || '');
  const one = (k) => {
    const m = new RegExp(`^\\s*${k}\\s*=\\s*(.+)$`, 'm').exec(t);
    return m ? m[1].trim() : '';
  };
  const addons = one('addons_path');
  const dbs = one('db_name');
  const port = one('http_port') || one('xmlrpc_port');
  return {
    addonsPath: addons ? addons.split(',').map(x => x.trim()).filter(Boolean) : [],
    // db_name 是 dbfilter 白名單，可以是多個（鴻久測試區＝odoo_tst,hutest）。
    // 這裡只負責拆開，選哪個是呼叫端的事——而且該以 db_connections 為準，不是這裡。
    dbNames: dbs ? dbs.split(',').map(x => x.trim()).filter(Boolean) : [],
    httpPort: port ? Number(port) : null,
  };
}

// ── 以下是「自動帶出欄位」用的解析器。全是純函式，理由同檔頭：SSH 那半沒有真機驗不了。

// 啟動指令裡找不到 -c 時才用的慣例路徑，依序試到 cat 得到為止。
// docker 官方 image 是 /etc/odoo/odoo.conf；systemd 安裝（慈雲那台）常見的是 /etc/odoo.conf，
// 各家打包又各自不同——寫死一條的話 systemd 專案會全部抓不到 conf，於是三個欄位都退回手填。
const CONF_FALLBACKS = ['/etc/odoo/odoo.conf', '/etc/odoo.conf', '/etc/odoo-server.conf'];

// 從 docker inspect 的 Cmd/Entrypoint（JSON 陣列）或 systemd 的 ExecStart 找 conf 路徑。
// 兩種來源的分隔符不同（`","` vs 空白），所以分隔字元放同一個字元類別一起吃。
// 找不到回 null——退回讓人手填，不亂猜一條路徑丟進部署指令。
function parseConfPath(text) {
  const m = /(?:^|[\s"])(?:-c|--config(?:file)?)(?:=|["\s,]+)([^"\s,\]]+\.conf)/.exec(String(text || ''));
  return m ? m[1] : null;
}

// systemd 的 ExecStart（`systemctl show -p ExecStart --value`）裡的 path= 就是實際被執行的檔案。
// 只認 basename 是 odoo-bin／odoo 的：慈雲的正式區走舊式 init 腳本（path=/etc/init.d/odoo-server），
// 那不是 odoo 執行檔，拿去 `sudo -u odoo <它> -c ... -u ...` 會用完全不同的參數語意跑起來。
// 認不出就回 null——退回裸名 `odoo-bin`，與這個欄位存在之前的行為相同。
function parseOdooBin(text) {
  const m = /(?:^|[\s{;])path=(\/[^\s;]+)/.exec(String(text || ''));
  if (!m || !validatePath(m[1])) return null;
  return /^odoo(-bin)?$/.test(m[1].split('/').pop()) ? m[1] : null;
}

// docker inspect -f '{{json .Mounts}}' 的輸出。解不動就回空陣列——沒有掛載資訊時
// 容器內路徑換不回宿主路徑，該候選的 addons 目錄就交給人手填。
function parseMounts(stdout) {
  try {
    const arr = JSON.parse(String(stdout || '').trim());
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// conf 裡的 addons_path 是**容器內**路徑，但部署是 SFTP 傳到**宿主**再由容器讀。
// 少了這層換算會把宿主上根本不存在的路徑存成 addons_dir，要到真的部署才炸。
// 多個掛載同時命中時取最深的那個（/mnt/extra-addons 比 /mnt 精確）。
function mapToHostPath(containerPath, mounts) {
  const p = String(containerPath || '').replace(/\/+$/, '');
  let best = null;
  for (const m of mounts || []) {
    const dest = String(m.Destination || '').replace(/\/+$/, '');
    const src = String(m.Source || '');
    if (!dest || !src) continue;
    if (p === dest || p.startsWith(dest + '/')) {
      if (!best || dest.length > best.dest.length) best = { dest, src };
    }
  }
  return best ? best.src + p.slice(best.dest.length) : null;
}

// 平台本機這個專案的 repo clone 裡，我們自己維護的模組＝頂層含 __manifest__.py 的目錄。
// 不可只篩 idx_ 前綴：沿用既有 module 時不改名（CLAUDE.md §1），那些不叫 idx_。
function listRepoModules(localPath, deps = {}) {
  const fs = deps.fs || require('fs');
  const path = deps.path || require('path');
  try {
    return fs.readdirSync(localPath, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
      .filter(n => fs.existsSync(path.join(localPath, n, '__manifest__.py')))
      .sort();
  } catch { return []; }
}

// 客戶機的哪一個 addons 目錄是「我們的」：拿目錄內容跟 repo 的模組清單取交集，命中多的排前面。
// addons_path 常混著 Odoo 核心與 OCA（鴻久那台就是），挑錯會把碼放進不會被載入的目錄，
// 而且部署當下不會報錯——升級指令照跑，只是升的是舊碼。
function rankAddonsDirs(listings, ourModules) {
  const ours = new Set(ourModules || []);
  return (listings || [])
    .map(({ dir, entries }) => ({ dir, matched: (entries || []).filter(e => ours.has(e)) }))
    .sort((a, b) => b.matched.length - a.matched.length);
}

// 平台本機這個專案的 repo clone。模組清單與部署分支都從這裡推導，不必問客戶機。
// 拿不到不算致命（同 compose 標籤）：前端會退回讓人手填，所以整段吞掉錯誤。
async function defaultLoadRepos(projectId) {
  try {
    const { query } = require('../db');
    const { rows } = await query(
      `SELECT id, label, is_primary, local_path FROM project_repos
       WHERE project_id = $1 AND clone_status = 'done' AND local_path IS NOT NULL
       ORDER BY is_primary DESC, id`, [projectId]);
    return rows.map(r => ({
      id: r.id, label: r.label, isPrimary: !!r.is_primary,
      modules: listRepoModules(r.local_path),
    }));
  } catch { return []; }
}

// 同專案的連線設定裡，log_container 指出「這個環境的 log 要去哪個容器抓」——
// 那就是「這個資料庫由哪個容器服務」的答案，而且是人親手填的。
// 鴻久實例：conn「鴻伍 - 正式」(odoo_dev) 的 log_container 是 odoo-prd-web，
// 表示 odoo_dev 是掛在 odoo-prd 底下，不是同名的 odoo-dev 容器。沒有這條線索
// 就只能靠名字猜，而名字剛好會把人騙到錯的容器去。
async function defaultLoadConns(projectId) {
  try {
    const { query } = require('../db');
    const { rows } = await query(
      `SELECT id, name, db_name, log_container, log_unit FROM db_connections
       WHERE project_id = $1
         AND (COALESCE(log_container, '') <> '' OR COALESCE(log_unit, '') <> '')
       ORDER BY id`, [projectId]);
    return rows;
  } catch { return []; }
}

// 哪些連線把 log 指到這個容器。回空陣列＝沒有線索，不是「沒有關聯」。
function linkConns(candidate, conns) {
  // systemd 專案沒有容器名，線索在 log_unit；unit 名可能帶或不帶 .service 後綴，兩種都收
  const strip = (v) => String(v || '').replace(/\.service$/, '');
  const names = new Set([candidate.containerName, candidate.composeService, candidate.serviceName]
    .filter(Boolean).map(strip));
  return (conns || [])
    .filter(c => (c.log_container && names.has(strip(c.log_container)))
      || (c.log_unit && names.has(strip(c.log_unit))))
    .map(c => ({ id: c.id, name: c.name, dbName: c.db_name }));
}

// 對一個候選補齊 conf 路徑、addons 目錄候選與 conf 內的 db 清單。
// 每一步都獨立 try：任何一步失敗只讓那個欄位變 null，不可讓整個候選消失——
// 候選不見了人就無從指認，比欄位空著糟得多。
async function enrichCandidate(execFn, target, S, c, ourModules) {
  const out = { confPath: null, addonsCandidates: [], confDbNames: [], httpPort: null, odooBin: null };
  const inContainer = c.runtime === 'docker';
  // 容器名／服務名都要進 shell 指令，一律過白名單。呼叫端已驗過一次，這裡再驗是因為
  // 這支函式的參數是「使用者可編輯的欄位」與客戶正式機的 shell 之間唯一的東西。
  let name;
  try { name = requireIdent(inContainer ? c.containerName : c.serviceName, inContainer ? 'container' : 'service'); }
  catch { return out; }
  const prefix = inContainer ? `${S}docker exec ${name} ` : S;

  let mounts = [];
  if (inContainer) {
    try {
      const insp = await execFn(target, `${S}docker inspect -f '{{json .Config.Cmd}} {{json .Config.Entrypoint}}' ${name}`);
      out.confPath = parseConfPath(insp.stdout);
    } catch { /* 拿不到啟動指令就退回慣例路徑 */ }
    try {
      const mt = await execFn(target, `${S}docker inspect -f '{{json .Mounts}}' ${name}`);
      mounts = parseMounts(mt.stdout);
    } catch { /* 沒有掛載資訊 ＝ 換不回宿主路徑，addons 目錄交給人填 */ }
  } else {
    try {
      const es = await execFn(target, `systemctl show -p ExecStart --value ${name}`);
      out.confPath = parseConfPath(es.stdout);
      out.odooBin = parseOdooBin(es.stdout);
    } catch { /* 同上 */ }
  }

  // 啟動指令抓到的優先；抓不到就依序試慣例路徑。讀不到會拿到「No such file」這類訊息，
  // 不含 '=' 就當沒讀到——絕不留一條猜的路徑，那會被當成事實存進部署目標。
  const tries = out.confPath ? [out.confPath] : CONF_FALLBACKS;
  let conf = null;
  out.confPath = null;
  for (const cand of tries) {
    if (!validatePath(cand)) continue;
    try {
      const cat = await execFn(target, `${prefix}cat ${cand}`);
      if (cat.stdout && cat.stdout.includes('=')) { conf = parseConf(cat.stdout); out.confPath = cand; break; }
    } catch { /* 下一個候選 */ }
  }

  if (!conf) return out;
  out.confDbNames = conf.dbNames;
  out.httpPort = conf.httpPort;

  // 逐個 addons 目錄換算成宿主路徑後在**宿主**上 ls：既取得目錄內容，也順帶驗證
  // 那條宿主路徑真的存在（部署是 SFTP 傳到宿主，容器內路徑傳不進去）。
  const listings = [];
  for (const dir of conf.addonsPath) {
    const host = inContainer ? mapToHostPath(dir, mounts) : dir;
    // 換不出宿主路徑的多半是容器內建的核心 addons，本來就不該部署，跳過
    if (!host || !validatePath(host)) continue;
    try {
      const ls = await execFn(target, `${S}ls -1 ${host}`);
      listings.push({ dir: host, entries: String(ls.stdout || '').split('\n').map(s => s.trim()).filter(Boolean) });
    } catch { listings.push({ dir: host, entries: [] }); }
  }
  out.addonsCandidates = rankAddonsDirs(listings, ourModules);
  return out;
}

// execFn 可注入，測試才餵得進假輸出（比照 ssh-log.js 的 probeLogSource）。
async function runProbe(connId, projectId, execFn = sshExec, deps = {}) {
  const { loadDecryptedConn } = require('./db-connections');
  const conn = await loadDecryptedConn(connId, projectId);
  if (!conn) return { ok: false, error: '找不到這筆連線設定' };

  let target = conn;
  if (conn.vpn_enabled) {
    // 不先撥號就 SSH，會對連不到的內網位址握手，錯誤訊息完全不指向真因
    const { ensureGatewayRunning } = require('./vpn-gateway');
    if (!conn.vpn) return { ok: false, error: '[VPN] 專案尚未設定 VPN，請先上傳 .ovpn' };
    if (!conn.vpn_forward_port) return { ok: false, error: '[VPN] 此連線尚未配置轉發埠，請重新儲存一次連線設定' };
    try { await ensureGatewayRunning(conn.vpn); }
    catch (e) { return { ok: false, error: `[VPN] ${e.message}` }; }
    target = { ...conn, ssh_host: '127.0.0.1', ssh_port: conn.vpn_forward_port };
  }

  let out;
  try { out = await execFn(target, buildProbeScript(target)); }
  catch (e) { return { ok: false, error: e.message }; }

  const parsed = parseProbe(out.stdout);
  // 客戶 conf 內的 db_password／admin_passwd 是明碼，這份會存進 probe_json 也會回前端
  const raw = maskSecrets(`${out.stdout}\n${out.stderr || ''}`);

  const repos = await (deps.loadRepos || defaultLoadRepos)(projectId);
  const ourModules = [...new Set(repos.flatMap(r => r.modules))];
  const conns = await (deps.loadConns || defaultLoadConns)(projectId);
  const S = sudoPrefix(target);

  let candidates;
  if (parsed.runtime === 'docker') {
    candidates = [];
    for (const c of parsed.containers) {
      // compose 定址：service 名與容器名不同（odoo-tst vs odoo-tst-web），兩個都要存。
      // 標籤是容器自己帶的，比 find 找 compose 檔可靠——鴻久的 compose.yaml 在第 5 層，
      // find -maxdepth 4 剛好漏掉（2026-09-08 實際踩過）。
      let compose = { project: '', service: '', workingDir: '', configFiles: '' };
      let ver = parsed.odooVersion;
      let name;
      try { name = requireIdent(c.name, 'container'); } catch { continue; }
      try {
        const insp = await execFn(target,
          `${S}docker inspect -f 'project={{index .Config.Labels "com.docker.compose.project"}} service={{index .Config.Labels "com.docker.compose.service"}} workdir={{index .Config.Labels "com.docker.compose.project.working_dir"}} files={{index .Config.Labels "com.docker.compose.project.config_files"}}' ${name}`);
        compose = parseComposeLabels(insp.stdout);
      } catch { /* 標籤取不到不算致命，候選仍列出來讓人指認 */ }
      try {
        const v = await execFn(target, `${S}docker exec ${name} odoo --version 2>&1 | head -1`);
        if (v.stdout && v.stdout.trim()) ver = v.stdout.trim();
      } catch { /* 同上 */ }
      const base = {
        runtime: 'docker', containerName: c.name, serviceName: null,
        composeDir: compose.workingDir || null, composeService: compose.service || null,
        dbName: conn.db_name, sudoMode: parsed.sudoMode, ports: c.ports, odooVersion: ver,
      };
      candidates.push({ ...base, ...(await enrichCandidate(execFn, target, S, base, ourModules)) });
    }
  } else {
    candidates = [];
    for (const u of parsed.units) {
      const base = {
        runtime: 'systemd', serviceName: u, containerName: null,
        composeDir: null, composeService: null,
        dbName: conn.db_name, sudoMode: parsed.sudoMode, ports: null, odooVersion: parsed.odooVersion,
      };
      candidates.push({ ...base, ...(await enrichCandidate(execFn, target, S, base, ourModules)) });
    }
  }

  // db_name 仍以 db_connections 為準（conf 的是 dbfilter 白名單，猜錯就升到別的 DB）。
  // 但一條連線探到多個 instance 時每個候選都會拿到同一個 db_name，那時只有 conf 分辨得出
  // 誰是誰——所以標出「conf 裡沒有這個 db」讓人核對，而不是自作主張改掉。
  for (const c of candidates) {
    c.dbMismatch = c.confDbNames.length > 0 && !c.confDbNames.includes(c.dbName);
    c.linkedConns = linkConns(c, conns);
  }

  // 有連線指名的排前面。指名是人填的事實，比容器名字可靠——odoo_dev 這個 db
  // 由 odoo-prd 服務時，照名字排會把 odoo-dev 那個沒人用的容器擺在第一個。
  // 次要鍵是「這個 instance 的 addons 目錄裡有沒有我們的模組」：鴻久那台實測列出 7 個候選，
  // 其中 4 個是 queue_job 的 *-runner，它們沒有我們的 addons 目錄，不該混在前面。
  candidates.sort((a, b) => (b.linkedConns.length - a.linkedConns.length)
    || (b.addonsCandidates.length - a.addonsCandidates.length));

  return { ok: true, candidates, diskAvailGb: parsed.diskAvailGb, raw, repos };
}

module.exports = { buildProbeScript, parseProbe, parseComposeLabels, parseConf, isDeployCandidate, runProbe,
  parseConfPath, parseOdooBin, parseMounts, mapToHostPath, listRepoModules, rankAddonsDirs, linkConns };
