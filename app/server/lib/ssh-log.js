// 客戶正式區 Odoo log 讀取。與 lib/ssh-sql.js 的 runSelect 並列，共用同一條 SSH 通道。
//
// 安全模型與 runSelect 相反且更嚴：runSelect 讓呼叫端自由撰寫 SQL、靠黑名單攔截危險語句；
// 本模組所有進入指令的參數都是型別受控（時間戳由程式重新序列化、window/level 是 enum、
// 連線設定來自 DB），唯一的自由文字 keyword 根本不進指令，在平台側比對。
const { Client } = require('ssh2');
const { ensureGatewayRunning } = require('./vpn-gateway');
const { splitEntries, filterByLevel, filterByKeyword, truncate, maskSecrets, TS_RE } = require('./log-parse');

const WINDOWS = [10, 30, 60];
const LEVELS = ['ERROR', 'WARNING', 'INFO', 'ALL'];
// INFO/ALL 量級遠大於 ERROR/WARNING，窗必須跟著縮
const WINDOW_CAP = { INFO: 10, ALL: 10 };

function validateLogParams({ at, window, level, keyword } = {}) {
  if (!at) return { ok: false, error: '必須指定事發時間點 at（ISO 8601，含時區）' };

  // 檢查時區偏移。Date.parse 沒偏移會用伺服器本機時區解讀，跨機器會產生 8 小時錯誤。
  // 接受 Z/z（UTC）或 ±HH:MM/±HHMM 格式。
  const hasTimezoneOffset = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(String(at).trim());
  if (!hasTimezoneOffset) {
    return { ok: false, error: '`at` 必須帶時區偏移（如 `+08:00` 或 `Z`），否則會被當成伺服器本機時間解讀' };
  }

  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) return { ok: false, error: `at 無法解析為時間：${at}` };

  const windowMin = window === undefined || window === null ? 10 : Number(window);
  if (!WINDOWS.includes(windowMin)) return { ok: false, error: `window 只接受 ${WINDOWS.join(' / ')} 分鐘` };

  const lv = level === undefined || level === null || level === '' ? 'ERROR' : String(level).toUpperCase();
  if (!LEVELS.includes(lv)) return { ok: false, error: `level 只接受 ${LEVELS.join(' / ')}` };

  const cap = WINDOW_CAP[lv];
  if (cap && windowMin > cap) {
    return { ok: false, error: `level=${lv} 的資料量遠大於 ERROR，window 上限為 ${cap} 分鐘（收到 ${windowMin}）` };
  }

  return { ok: true, atMs, windowMin, level: lv, keyword: keyword == null ? '' : String(keyword) };
}

const IDENT_RE = /^[A-Za-z0-9_.\-]+$/;
const PATH_RE = /^\/[A-Za-z0-9_.\-\/]+$/;

function validateLogPath(p) {
  const s = String(p || '');
  return PATH_RE.test(s) && !s.includes('..');
}

function requireIdent(val, name) {
  if (!val) throw new Error(`連線缺少 ${name}，請先執行 log 來源偵測`);
  if (!IDENT_RE.test(String(val))) throw new Error(`連線欄位 ${name} 含不允許的字元`);
  return String(val);
}

// 兩位數補零的 UTC 分解，避免依賴執行機時區。
function partsUtc(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}
function isoUtc(ms) { const { date, time } = partsUtc(ms); return `${date}T${time}Z`; }
function spaceUtc(ms) { const { date, time } = partsUtc(ms); return `${date} ${time}`; }

// sudo 前綴：沿用 ssh-sql 的慣例，有密碼走 sudo -S，沒有就直接 sudo。
// -p '' 把提示字串置空：docker 指令尾端帶 2>&1，sudo 的提示（預設「[sudo] password for x: 」）
// 會被併入 stdout 且不帶換行，黏在第一行 log 前面，splitEntries 會把整個「提示+第一筆」當成
// 不含時間戳的孤兒續行丟棄——第一筆記錄因此消失。置空提示等於不印，從源頭避免此問題。
function sudoPrefix(conn) {
  const pw = conn.ssh_password || '';
  if (!pw) return 'sudo ';
  return `echo '${pw.replace(/'/g, "'\\''")}' | sudo -S -p '' `;
}

// 時間基準三者不同，見計畫「對 spec 未定處的明確化」第 3 點。
function buildLogCmd(conn, fromMs, toMs) {
  const mode = conn.log_mode;
  if (!mode) throw new Error('此連線尚未偵測 log 來源，請先至連線設定執行偵測');

  if (mode === 'docker') {
    const c = requireIdent(conn.log_container, 'log_container');
    return `${sudoPrefix(conn)}docker logs --since ${isoUtc(fromMs)} --until ${isoUtc(toMs)} ${c} 2>&1`;
  }

  if (mode === 'journald') {
    const u = requireIdent(conn.log_unit, 'log_unit');
    return `${sudoPrefix(conn)}journalctl -u ${u} --since "${spaceUtc(fromMs)} UTC" --until "${spaceUtc(toMs)} UTC" -o cat`;
  }

  if (mode === 'file') {
    if (!validateLogPath(conn.log_path)) throw new Error('log_path 不是合法的絕對路徑');
    const off = Number(conn.log_tz_offset || 0) * 60000;
    const s = spaceUtc(fromMs + off);
    const e = spaceUtc(toMs + off);
    // 利用 Odoo 時間戳字典序即時間序的特性；inrange 讓 traceback 續行跟隨所屬記錄。
    // 不用 {4} 這種 POSIX interval expression：Debian/Ubuntu 預設 awk 是 mawk，較舊版本不支援，
    // 會把 {4} 當字面量比對、永遠不匹配 → 零輸出、exit 0，空結果被誤讀成「沒有異常」。
    const awk = `/^[0-9][0-9][0-9][0-9]-/ { inrange = ($0 >= s && $0 <= e) } inrange`;
    return `${sudoPrefix(conn)}awk -v s="${s}" -v e="${e}" '${awk}' ${conn.log_path}`;
  }

  throw new Error(`未知的 log_mode：${mode}`);
}

const UNIT_CANDIDATES = ['odoo', 'odoo-server', 'odoo14', 'odoo15', 'odoo16', 'odoo17'];
const PATH_CANDIDATES = [
  '/var/log/odoo/odoo-server.log',
  '/var/log/odoo/odoo.log',
  '/var/log/odoo/openerp-server.log',
  '/opt/odoo/odoo.log',
];

function looksLikeOdooLog(text) {
  return String(text || '').split('\n').some(l => TS_RE.test(l));
}

// log 最後一行必然是近期寫入，與當下 UTC 的差距即為 log 的時區偏移。
// 誤差來自「最後一行不是剛剛寫的」，故吸收到 30 分鐘級距；超過 14 小時視為推算失敗。
function deriveTzOffset(lastLogTs, remoteUtcNow) {
  const logMs = Date.parse(String(lastLogTs).replace(',', '.').replace(' ', 'T') + 'Z');
  const nowMs = Date.parse(String(remoteUtcNow).trim().replace(' ', 'T') + 'Z');
  if (Number.isNaN(logMs) || Number.isNaN(nowMs)) return null;
  const diffMin = (logMs - nowMs) / 60000;
  if (Math.abs(diffMin) > 14 * 60) return null;
  return Math.round(diffMin / 30) * 30 || 0; // 吸收 Math.round 在極小負值產生的 -0
}

function lastTsOf(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = TS_RE.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

// 與 ssh-sql.js 的 sshExec 同構（逐字元相同）。暫不共用，待抽 lib/ssh-exec.js（後續重構）。
function sshExecLog(conn, command) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let stdout = '', stderr = '';
    c.on('ready', () => {
      c.exec(command, (err, stream) => {
        if (err) { c.end(); return reject(err); }
        stream.on('close', (code) => { c.end(); resolve({ stdout, stderr, code }); })
          .on('data', d => { stdout += d; })
          .stderr.on('data', d => { stderr += d; });
      });
    }).on('error', reject);
    const cfg = { host: conn.ssh_host, port: conn.ssh_port || 22, username: conn.ssh_user, readyTimeout: 15000 };
    if (conn.auth_type === 'key' && conn.ssh_key) cfg.privateKey = Buffer.from(conn.ssh_key, 'utf8');
    else cfg.password = conn.ssh_password;
    c.connect(cfg);
  });
}

// VPN 專案的連線在執行前需先確保閘道就緒並改指轉發埠（比照 runSelect）。
async function withVpn(conn) {
  if (!conn.vpn_enabled) return conn;
  if (!conn.vpn) throw new Error('[VPN] 專案尚未設定 VPN，請先到專案 VPN 設定上傳 .ovpn');
  if (!conn.vpn_forward_port) throw new Error('[VPN] 此連線尚未配置轉發埠，請重新儲存一次連線設定');
  // 撥號失敗／連線逾時的例外訊息（來自 vpn-gateway.js）不帶 [VPN] 前綴，包起來補上，
  // 否則呼叫端只能看到裸的原始訊息，SKILL.md 教 agent 認 [VPN] 前綴的對照表會判不到這條路徑。
  try {
    await ensureGatewayRunning(conn.vpn);
  } catch (e) {
    throw new Error(`[VPN] ${e.message}`);
  }
  return { ...conn, ssh_host: '127.0.0.1', ssh_port: conn.vpn_forward_port };
}

// direct 模式不經 SSH，本模組所有功能一律走 SSH——擋在最前面，避免落到下游繼續嘗試
// SSH 握手（更隱蔽的是 vpn-gateway 對 direct 模式回的 targetHostPort 是 db_host:db_port，
// withVpn 卻無條件把它當 SSH 埠用，會對 Postgres 埠做 SSH 握手，錯誤訊息完全不指向真因）。
function rejectDirectMode(conn) {
  if (conn.connect_mode === 'direct') return '此連線是 direct 模式（不經 SSH），無法讀取主機 log';
  return null;
}

// 逐一嘗試三種來源，第一個「輸出符合 Odoo log 格式」者勝出。
// 只看容器／unit 名稱不足以判定——資料庫容器也叫 odoo-*，其 log 格式正常但完全不相干。
async function probeLogSource(conn, execFn = sshExecLog) {
  const directErr = rejectDirectMode(conn);
  if (directErr) return { ok: false, error: directErr };

  let target;
  try { target = await withVpn(conn); }
  catch (e) { return { ok: false, error: e.message }; }

  let found = null;
  // execFn 例外（SSH 連線層失敗）過去會直接冒泡出 probeLogSource，讓同一種 SSH 故障從
  // runLogTail 看是 { ok:false, error:'[SSH] …' }，從探測按鈕看卻是未捕捉例外（route 層再包成
  // HTTP 500）。這裡統一接住，正規化成 { code:-1 }，並記下第一個例外訊息供最終判斷使用。
  let sshError = null;
  const safeExec = async (cmd) => {
    try { return await execFn(target, cmd); }
    catch (e) { if (!sshError) sshError = e.message; return { code: -1, stdout: '', stderr: e.message }; }
  };

  // docker ps 非 0 exit（常見成因：帳號只給了 sudo、沒加入 docker 群組）與「這台機器根本沒跑
  // docker」目前回同一句話，會把「權限沒開」誤診成「這台沒跑 docker」。跑成功但退出碼非 0 時
  // 記下 stderr，供三種來源都失敗時的錯誤訊息區分。
  let dockerPsErr = null;
  const ps = await safeExec(`${sudoPrefix(target)}docker ps --format '{{.Names}}'`);
  if (ps.code === 0) {
    for (const name of String(ps.stdout).split('\n').map(s => s.trim()).filter(Boolean)) {
      if (!/odoo/i.test(name) || !IDENT_RE.test(name)) continue;
      const out = await safeExec(`${sudoPrefix(target)}docker logs --tail 20 ${name} 2>&1`);
      if (out.code === 0 && looksLikeOdooLog(out.stdout)) {
        found = { log_mode: 'docker', log_container: name, sample: out.stdout };
        break;
      }
    }
  } else if (ps.code !== -1) {
    dockerPsErr = String(ps.stderr || ps.stdout || `exit ${ps.code}`).trim().slice(0, 300);
  }

  if (!found) {
    for (const unit of UNIT_CANDIDATES) {
      const out = await safeExec(`${sudoPrefix(target)}journalctl -u ${unit} -n 20 -o cat`);
      if (out.code === 0 && looksLikeOdooLog(out.stdout)) {
        found = { log_mode: 'journald', log_unit: unit, sample: out.stdout };
        break;
      }
    }
  }

  if (!found) {
    for (const p of PATH_CANDIDATES) {
      const out = await safeExec(`${sudoPrefix(target)}tail -n 20 ${p}`);
      if (out.code === 0 && looksLikeOdooLog(out.stdout)) {
        found = { log_mode: 'file', log_path: p, sample: out.stdout };
        break;
      }
    }
  }

  if (!found) {
    // 曾發生連線層例外（SSH 本身斷了）：這不是「三種來源都偵測不到」，是根本沒探測到，
    // 回 [SSH] 前綴讓呼叫端走 SKILL.md 的既定判讀，而非誤導成「請手動指定」。
    if (sshError) return { ok: false, error: `[SSH] ${sshError}` };
    const base = '三種來源（docker / journald / 檔案）都偵測不到 Odoo log';
    if (dockerPsErr) {
      return { ok: false, error: `${base}；docker ps 執行失敗（${dockerPsErr}），若該帳號僅有 sudo 但未加入 docker 群組會有此現象，請確認後再試或手動指定 log_mode` };
    }
    return { ok: false, error: `${base}，請手動指定 log_mode 與對應欄位` };
  }

  const now = await safeExec(`date -u +'%Y-%m-%d %H:%M:%S'`);
  const offset = now.code === 0 ? deriveTzOffset(lastTsOf(found.sample), now.stdout) : null;
  if (offset === null) {
    return { ok: false, error: '已找到 log 來源，但時區偏移推算失敗（差距超出合理範圍），請手動確認 log_tz_offset' };
  }

  delete found.sample;
  return { ok: true, log_tz_offset: offset, ...found };
}

const MAX_ENTRIES = 200;
const MAX_BYTES = 65536;

// file 模式讀不到已輪替的檔案。空結果在此情境下會被誤讀成「該時段無異常」，
// 故先確認檔案第一筆記錄的時間，早於它就明講查不到，不回空。
// execFn 失敗（如 SSH 連線在探測輪替時中斷）不視為「已輪替」——這只是輔助判斷，
// 不該因為它自己失敗就中止整個查詢，讓主查詢自己去撞真正的錯誤並回報 [SSH]/[LOG]。
async function rotatedOut(conn, fromMs, execFn) {
  if (conn.log_mode !== 'file') return false;
  let head;
  try { head = await execFn(conn, `${sudoPrefix(conn)}head -n 50 ${conn.log_path}`); }
  catch { return false; }
  if (head.code !== 0) return false;
  const first = lastTsOf(String(head.stdout).split('\n').reverse().join('\n'));
  if (!first) return false;
  const off = Number(conn.log_tz_offset || 0) * 60000;
  const firstUtcMs = Date.parse(first.replace(',', '.').replace(' ', 'T') + 'Z') - off;
  return fromMs < firstUtcMs;
}

async function runLogTail(conn, params, execFn = sshExecLog) {
  const directErr = rejectDirectMode(conn);
  if (directErr) return { ok: false, error: directErr };

  const v = validateLogParams(params);
  if (!v.ok) return { ok: false, error: `[LOG] ${v.error}` };

  let target;
  try { target = await withVpn(conn); }
  catch (e) { return { ok: false, error: e.message }; }

  const half = v.windowMin * 60000;
  const fromMs = v.atMs - half;
  const toMs = v.atMs + half;

  let cmd;
  try { cmd = buildLogCmd(target, fromMs, toMs); }
  catch (e) { return { ok: false, error: `[LOG] ${e.message}` }; }

  if (await rotatedOut(target, fromMs, execFn)) {
    return { ok: false, error: '[LOG] 請求時段早於目前 log 檔的第一筆記錄，該時段可能已被輪替（本功能不讀 .1／.gz）' };
  }

  let res;
  try { res = await execFn(target, cmd); }
  catch (e) { return { ok: false, error: `[SSH] ${e.message}` }; }

  if (res.code !== 0) {
    return { ok: false, error: `[LOG] ${String(res.stderr || res.stdout || `exit ${res.code}`).trim().slice(0, 2000)}` };
  }

  const matched = filterByKeyword(filterByLevel(splitEntries(res.stdout), v.level), v.keyword);
  const { entries, truncated } = truncate(matched, MAX_ENTRIES, MAX_BYTES);

  const out = {
    ok: true,
    log_mode: target.log_mode,
    range: { from: isoUtc(fromMs), to: isoUtc(toMs) },
    entries: entries.map(e => ({ ts: e.ts, level: e.level, logger: e.logger, text: maskSecrets(e.raw) })),
    total_matched: matched.length,
    returned: entries.length,
    truncated,
  };
  if (truncated) out.note = `已截斷（符合 ${matched.length} 筆，回傳 ${entries.length} 筆）。請縮小 window 或加關鍵字`;
  return out;
}

module.exports = {
  validateLogParams, WINDOWS, LEVELS, WINDOW_CAP, buildLogCmd, validateLogPath,
  looksLikeOdooLog, deriveTzOffset, probeLogSource,
  runLogTail, sshExecLog, MAX_ENTRIES, MAX_BYTES,
};
