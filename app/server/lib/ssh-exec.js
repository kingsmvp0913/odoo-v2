// SSH 執行與參數白名單的單一來源。
//
// 原本 ssh-log.js 的 sshExecLog 與 ssh-sql.js 的 sshExec 是逐字元相同的重複，
// ssh-log.js 的註解本來就標記「暫不共用，待抽 lib/ssh-exec.js」——自動部署器是第三個
// 使用者，抽出來的時機到了。三處共用同一份，sudoPrefix 的提示置空等既有修正才不會分岔。
const { Client } = require('ssh2');

const IDENT_RE = /^[A-Za-z0-9_.\-]+$/;
const PATH_RE = /^\/[A-Za-z0-9_.\-\/]+$/;

function validatePath(p) {
  const s = String(p || '');
  return PATH_RE.test(s) && !s.includes('..');
}

function requireIdent(val, name) {
  if (!val) throw new Error(`缺少 ${name}`);
  if (!IDENT_RE.test(String(val))) throw new Error(`${name} 含不允許的字元`);
  return String(val);
}

// sudo 密碼一律不進指令列。舊寫法是 `echo '密碼' | sudo -S -p '' `，而 SSH 執行指令時
// sshd 是用 `bash -c "整串指令"` 起的，那串 argv 會出現在 /proc/<pid>/cmdline——
// Linux 上這個檔案全機可讀，客戶機上任何一個本機帳號在部署那段時間跑 ps 就抄得到密碼，
// 而那顆密碼同時就是 SSH 登入密碼。
//
// 改走 sudo 的 SUDO_ASKPASS：密碼由 SSH channel 的 stdin 送進去（stdin 不出現在 argv），
// 落成 0600 暫存檔給 askpass shim 讀，指令結束由 trap 清掉。see askpassPreamble。
// 順帶解決了 -p '' 當初要處理的事：-A 模式下 sudo 根本不印「[sudo] password for x: 」提示，
// 不會有提示字串黏進 stdout 第一行害 ssh-log 的 splitEntries 吃掉第一筆記錄。
// ── 主機金鑰驗證（TOFU：trust on first use，第一次連上就把指紋記起來，之後每次比對）──
//
// ssh2 預設「完全不驗對方是誰」：沒給 hostVerifier 就照單全收。少了它，任何能坐在網路
// 路徑上的人都能冒充客戶主機，收下我們送過去的 SSH 密碼與 sudo 密碼，再回傳假的成功輸出。
// 慈雲那台走的是公開網路，這不是理論風險。
//
// 為什麼是 TOFU 而不是預先設定指紋：客戶機的指紋沒有可信的帶外管道可以拿，要人工抄一次
// 反而會被跳過。TOFU 把「永遠不驗」換成「只有第一次有風險」，而第一次通常發生在建連線的
// 當下，不是三個月後的自動部署。
function fingerprint(key) {
  const crypto = require('crypto');
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

// conn.id 是 db_connections 的主鍵，也是記指紋的鍵。刻意不用 host:port 當鍵：
// 走 VPN 時 host 會被改寫成 127.0.0.1、port 是動態配的轉發埠，用它當鍵等於每次都是新主機。
// 沒有 id（新建連線的「測試連線」按鈕，表單值還沒存檔）＝天生沒有可比對的舊指紋，
// 等同 TOFU 的第一次，放行。
function makeHostVerifier(conn) {
  return (key, verify) => {
    const cid = conn && conn.id;
    if (!cid) return verify(true);
    const fp = fingerprint(key);
    (async () => {
      const { query } = require('../db');
      const { rows: [row] } = await query('SELECT ssh_host_key FROM db_connections WHERE id = $1', [cid]);
      if (!row) return verify(true);                       // 連線已被刪，交給上層報錯
      if (!row.ssh_host_key) {                             // 第一次：記下來
        await query('UPDATE db_connections SET ssh_host_key = $2 WHERE id = $1', [cid, fp]);
        return verify(true);
      }
      verify(row.ssh_host_key === fp);
    })().catch(() => verify(false));                       // 查不到就不要放行（fail closed）
  };
}

// ssh2 對指紋不符只丟 'Host denied (verification failed)'，看不出要做什麼。
// 換成講得出下一步的訊息——這個錯誤有兩種完全不同的成因，猜錯方向的代價差很多。
const HOST_DENIED = 'Host denied (verification failed)';
function explainSshError(err) {
  if (err && String(err.message || '').includes(HOST_DENIED)) {
    const e = new Error('遠端主機金鑰與上次連線時不同。可能是主機重建或更換，也可能是連線遭到攔截。'
      + '確認機器確實有變更後，到專案的資料庫連線設定重新儲存一次該筆連線即可重新信任。');
    e.code = 'SSH_HOST_KEY_MISMATCH';
    return e;
  }
  return err;
}

function buildConnectConfig(conn, readyTimeout) {
  const cfg = {
    host: conn.ssh_host, port: conn.ssh_port || 22, username: conn.ssh_user,
    readyTimeout,
    hostVerifier: makeHostVerifier(conn),
  };
  if (conn.auth_type === 'key' && conn.ssh_key) cfg.privateKey = Buffer.from(conn.ssh_key, 'utf8');
  else cfg.password = conn.ssh_password;
  return cfg;
}

const ASKPASS_TOKEN = 'sudo -A ';

function sudoPrefix(conn) {
  const pw = (conn && conn.ssh_password) || '';
  if (!pw) return 'sudo ';
  return ASKPASS_TOKEN;
}

// 接在需要 sudo 密碼的指令前面。密碼是 stdin 的第一行，由 sshExec 寫入。
// mktemp 失敗就直接 exit：拿不到安全的暫存位置時，寧可整段部署失敗，也不要退回把密碼
// 塞進指令列的老路——那種「悄悄降級」正是最難察覺的漏洞。
function askpassPreamble() {
  return [
    'IFS= read -r __AIDEV_PW',
    'umask 077',
    '__AIDEV_D=$(mktemp -d) || { echo "mktemp 失敗，無法安全傳遞 sudo 密碼" >&2; exit 90; }',
    `trap 'rm -rf "$__AIDEV_D"' EXIT`,
    'printf %s "$__AIDEV_PW" > "$__AIDEV_D/pw"',
    'unset __AIDEV_PW',
    `printf '#!/bin/sh\\ncat "%s/pw"\\n' "$__AIDEV_D" > "$__AIDEV_D/askpass"`,
    'chmod 700 "$__AIDEV_D/askpass"',
    'export SUDO_ASKPASS="$__AIDEV_D/askpass"',
  ].join('\n');
}

function needsAskpass(conn, command) {
  return !!((conn && conn.ssh_password) && String(command).includes(ASKPASS_TOKEN));
}

function sshExec(conn, command) {
  const useAskpass = needsAskpass(conn, command);
  const finalCmd = useAskpass ? `${askpassPreamble()}\n${command}` : command;
  return new Promise((resolve, reject) => {
    const c = new Client();
    let stdout = '', stderr = '';
    c.on('ready', () => {
      c.exec(finalCmd, (err, stream) => {
        if (err) { c.end(); return reject(explainSshError(err)); }
        stream.on('close', (code) => { c.end(); resolve({ stdout, stderr, code }); })
          .on('data', d => { stdout += d; })
          .stderr.on('data', d => { stderr += d; });
        // 密碼走 stdin。刻意不 end() stdin：維持與改動前一致的行為（stdin 保持開著），
        // 免得某個吃 stdin 的遠端指令因為突然收到 EOF 而改變行為。
        if (useAskpass) stream.write(conn.ssh_password + '\n');
      });
    }).on('error', (e) => reject(explainSshError(e)));
    c.connect(buildConnectConfig(conn, 15000));
  });
}

module.exports = { sshExec, sudoPrefix, requireIdent, validatePath, IDENT_RE, PATH_RE,
  askpassPreamble, needsAskpass, buildConnectConfig, explainSshError, fingerprint, ASKPASS_TOKEN };
