const { sudoPrefix, requireIdent, validatePath, IDENT_RE, PATH_RE } = require('../lib/ssh-exec');

// 意圖（Rule 9）：sudo 提示字串若不置空，會被併進 stdout 且不帶換行，黏在第一行輸出前面，
// 讓下游解析把「提示+第一筆」當成孤兒行丟棄。這個坑 ssh-log 踩過一次，抽出來後必須保住。
test('有密碼時走 sudo -S 且提示字串置空', () => {
  expect(sudoPrefix({ ssh_password: 'p@ss' })).toBe("echo 'p@ss' | sudo -S -p '' ");
});

test('密碼含單引號時正確逸出', () => {
  expect(sudoPrefix({ ssh_password: "a'b" })).toBe("echo 'a'\\''b' | sudo -S -p '' ");
});

test('沒有密碼時退回裸 sudo', () => {
  expect(sudoPrefix({})).toBe('sudo ');
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
