// 環境評估器：唯讀探測客戶機，回報「這台機器長什麼形狀」。
//
// 探測與解析刻意分家：解析是純函式，用兩台真機的實際輸出當 fixture 測得起來；
// SSH 那半只有在有真機時才驗得了。自己編的樣本過了不代表看得懂真機吐出來的東西。
const { sudoPrefix } = require('./ssh-exec');

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

module.exports = { buildProbeScript, parseProbe, parseComposeLabels, parseConf, isDeployCandidate };
