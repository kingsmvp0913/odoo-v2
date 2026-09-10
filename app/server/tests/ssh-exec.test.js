const { sudoPrefix, requireIdent, validatePath, IDENT_RE, PATH_RE,
  askpassPreamble, needsAskpass, fingerprint } = require('../lib/ssh-exec');

// 意圖（Rule 9）：sudo 密碼絕不可出現在指令字串裡。SSH 執行時遠端是 `bash -c "整串指令"`，
// 那串 argv 落在 /proc/<pid>/cmdline，Linux 上全機可讀——客戶機任何一個本機帳號跑 ps
// 就抄得到，而那顆密碼同時就是 SSH 登入密碼。這條測試就是那道防線本身。
test('sudo 前綴不得含有密碼', () => {
  const p = sudoPrefix({ ssh_password: 'p@ss' });
  expect(p).not.toContain('p@ss');
  expect(p).toBe('sudo -A ');
});

test('密碼含單引號等特殊字元時，仍然完全不進指令字串', () => {
  expect(sudoPrefix({ ssh_password: "a'b" })).not.toContain("a'b");
});

test('沒有密碼時退回裸 sudo（免密機器不需要 askpass）', () => {
  expect(sudoPrefix({})).toBe('sudo ');
});

// 意圖：密碼改走 stdin。preamble 只負責「把 stdin 第一行接成一個 0600 的 askpass 檔」，
// 它自己也不可以含有密碼，否則等於換個地方洩漏。
test('askpass preamble 只從 stdin 讀，不含任何密碼字面量', () => {
  const s = askpassPreamble();
  expect(s).toContain('read -r __AIDEV_PW');
  expect(s).toContain('SUDO_ASKPASS');
  expect(s).toContain('umask 077');
  // mktemp 失敗必須整段停掉，不可以退回「把密碼塞進指令列」的老路（悄悄降級最難察覺）
  expect(s).toContain('exit 90');
  // 清理：暫存的密碼檔不留在客戶機上
  expect(s).toContain('trap');
});

// 意圖：只有真的要用 sudo 密碼時才加 preamble。無條件加會讓免密機器（慈雲）
// 的每一條指令都卡在 read 等一行永遠不會來的 stdin。
test('needsAskpass 只在「有密碼且指令真的用到 sudo -A」時成立', () => {
  expect(needsAskpass({ ssh_password: 'x' }, 'sudo -A docker ps')).toBe(true);
  expect(needsAskpass({ ssh_password: '' }, 'sudo -A docker ps')).toBe(false);
  expect(needsAskpass({ ssh_password: 'x' }, 'ls -1 /tmp')).toBe(false);
});

// 意圖：指紋是 TOFU 比對的唯一依據，格式必須穩定且與金鑰內容綁定。
test('指紋是 SHA256 前綴且同金鑰恆等、不同金鑰必異', () => {
  const a = fingerprint(Buffer.from('key-material-a'));
  expect(a).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  expect(fingerprint(Buffer.from('key-material-a'))).toBe(a);
  expect(fingerprint(Buffer.from('key-material-b'))).not.toBe(a);
});

// 意圖：這兩條正則是唯一擋在「使用者可編輯的欄位」與「遠端 shell」之間的東西。
test('識別字白名單擋掉命令注入字元', () => {
  expect(IDENT_RE.test('odoo-tst-web')).toBe(true);
  expect(IDENT_RE.test('odoo_prd')).toBe(true);
  expect(IDENT_RE.test('a; rm -rf /')).toBe(false);
  expect(IDENT_RE.test('a$(id)')).toBe(false);
  expect(IDENT_RE.test('a b')).toBe(false);
});

test('路徑必須是絕對路徑且不含 ..', () => {
  expect(validatePath('/odoo/custom/addons')).toBe(true);
  expect(validatePath('/home/arich/DockerData/odoo/Data/odoo-tst/addons')).toBe(true);
  expect(validatePath('relative/path')).toBe(false);
  expect(validatePath('/a/../../etc/passwd')).toBe(false);
  expect(validatePath('/a; rm -rf /')).toBe(false);
});

test('requireIdent 對不合法值 throw 並帶欄位名', () => {
  expect(() => requireIdent('a;b', 'container_name')).toThrow(/container_name/);
  expect(() => requireIdent('', 'db_name')).toThrow(/db_name/);
  expect(requireIdent('odoo_tst', 'db_name')).toBe('odoo_tst');
});

// PATH_RE 有匯出，確認它與 validatePath 是同一組規則（validatePath 多擋 ..）
test('PATH_RE 本身不含 .. 的檢查', () => {
  expect(PATH_RE.test('/a/../b')).toBe(true);
  expect(validatePath('/a/../b')).toBe(false);
});
