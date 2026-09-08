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

// -p '' 把 sudo 的提示字串置空：指令尾端帶 2>&1 時，預設提示「[sudo] password for x: 」
// 會被併入 stdout 且不帶換行，黏在第一行輸出前面，讓下游解析把它當孤兒行丟棄
// （ssh-log 的 splitEntries 因此吃掉過第一筆記錄）。置空等於不印，從源頭避免。
function sudoPrefix(conn) {
  const pw = (conn && conn.ssh_password) || '';
  if (!pw) return 'sudo ';
  return `echo '${pw.replace(/'/g, "'\\''")}' | sudo -S -p '' `;
}

function sshExec(conn, command) {
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

module.exports = { sshExec, sudoPrefix, requireIdent, validatePath, IDENT_RE, PATH_RE };
