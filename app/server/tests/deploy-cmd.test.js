const { pickModules, buildUpgradeCmd, buildUpgradeCmdMulti, readExitCodesByDb,
  buildRestartCmd, buildHealthCmd, buildSwapCmd, buildRollbackCmd,
  groupTargets } = require('../lib/deploy-cmd');

const HUNGJOU_TEST = {
  runtime: 'docker',
  compose_dir: '/home/arich/DockerData/odoo',
  compose_service: 'odoo-tst',
  container_name: 'odoo-tst-web',
  addons_dir: '/home/arich/DockerData/odoo/Data/odoo-tst/addons',
  conf_path: '/etc/odoo/odoo.conf',
  db_name: 'odoo_tst',
  http_port: 8101,
  modules: ['idx_hj', 'idx_scan', 'queue_job'],
};
const CIYUN_TEST = {
  runtime: 'systemd', service_name: 'odoo-test',
  addons_dir: '/odoo/custom/addons_test', conf_path: '/etc/odoo-test.conf',
  db_name: 'production_test', http_port: 8070, modules: ['idx_ciyun'],
};
const PW = { ssh_password: 'pw' };
const NOPW = {};
const TS = '20260908T153000';

test('第一次部署（沒有 last sha）＝全部模組', () => {
  expect(pickModules([], HUNGJOU_TEST.modules, null)).toEqual(['idx_hj', 'idx_scan', 'queue_job']);
});

test('取 diff 路徑的頂層目錄與 target 模組的交集', () => {
  const changed = ['idx_hj/views/x.xml', 'idx_hj/models/y.py', 'README.md', 'web_responsive/z.js'];
  // web_responsive 是遠端獨有、不在 target.modules 裡，必須被濾掉
  expect(pickModules(changed, HUNGJOU_TEST.modules, 'abc123')).toEqual(['idx_hj']);
});

test('交集為空回空陣列（呼叫端據此整趟跳過）', () => {
  expect(pickModules(['README.md', 'odoo_backup.py'], HUNGJOU_TEST.modules, 'abc123')).toEqual([]);
});

// 意圖（Rule 9）：跨模組任務只帶一個模組升級，另一半改動會靜默不生效而部署仍回綠燈。
// 此 repo 已經踩過一次（commit 7f2b358f、39da9e48）。
test('升級指令一次帶上所有模組，逗號分隔', () => {
  const cmd = buildUpgradeCmd(HUNGJOU_TEST, PW, ['idx_hj', 'idx_scan']);
  expect(cmd).toContain('-u idx_hj,idx_scan');
});

test('docker 走 compose，用 service 名不是容器名', () => {
  const cmd = buildUpgradeCmd(HUNGJOU_TEST, PW, ['idx_hj']);
  expect(cmd).toContain('cd /home/arich/DockerData/odoo');
  expect(cmd).toContain('compose stop odoo-tst');
  expect(cmd).toContain('compose start odoo-tst');
  expect(cmd).not.toContain('odoo-tst-web');
});

test('沒有 compose_dir 的 docker 環境退回 docker exec + restart', () => {
  const noCompose = { ...HUNGJOU_TEST, compose_dir: null, compose_service: null };
  const cmd = buildUpgradeCmd(noCompose, PW, ['idx_hj']);
  expect(cmd).toContain('docker exec odoo-tst-web');
  expect(cmd).toContain('docker restart odoo-tst-web');
});

test('systemd 走 systemctl，帶 conf 與 DB，且以 odoo 帳號執行', () => {
  const cmd = buildUpgradeCmd(CIYUN_TEST, NOPW, ['idx_ciyun']);
  expect(cmd).toContain('systemctl stop odoo-test');
  expect(cmd).toContain('sudo -u odoo odoo-bin');
  expect(cmd).toContain('-c /etc/odoo-test.conf');
  expect(cmd).toContain('-d production_test');
  expect(cmd).toContain('-u idx_ciyun');
  expect(cmd).toContain('systemctl start odoo-test');
});

// 意圖：失敗的 odoo -u 仍會印一堆看似正常的啟動訊息，靠關鍵字判斷會誤判。
// 而 exit code 一旦經過管線就不是那條指令的碼——此 repo 已誤判三次。
test('升級指令把 exit code 落檔，不經管線', () => {
  const cmd = buildUpgradeCmd(HUNGJOU_TEST, PW, ['idx_hj']);
  expect(cmd).toMatch(/echo "EXITCODE=\$\?"/);
  expect(cmd).not.toMatch(/--stop-after-init[^\n]*\|/);
});

// 意圖（Rule 9）：需要密碼的機器走 sudo -A（密碼由 stdin 進 askpass），免密機器維持裸 sudo。
// 關鍵斷言是「指令字串裡沒有密碼」——遠端是 bash -c "整串指令"，argv 落在
// /proc/<pid>/cmdline，Linux 上全機可讀，而那顆密碼就是 SSH 登入密碼。
test('有密碼時走 sudo -A 且指令不含密碼；免密時是裸 sudo', () => {
  const cmd = buildRestartCmd(HUNGJOU_TEST, PW);
  expect(cmd).toContain('sudo -A');
  expect(cmd).not.toContain(PW.ssh_password);
  expect(buildRestartCmd(CIYUN_TEST, NOPW)).toContain('sudo systemctl restart odoo-test');
});

test('健康檢查打自己的 port 並印出可判讀的標記', () => {
  const cmd = buildHealthCmd(HUNGJOU_TEST);
  expect(cmd).toContain('http://localhost:8101/web/login');
  expect(cmd).toContain('HEALTH_OK');
  expect(cmd).toContain('HEALTH_FAIL');
});

// 意圖：整包 mv 才處理得掉「這次刪掉的檔案」。慈雲那台沒有 rsync，也不能用。
test('替換是整包 mv，先備份再換，且只碰指定模組', () => {
  const cmd = buildSwapCmd(HUNGJOU_TEST, ['idx_hj'], TS);
  expect(cmd).toContain('.deploy-bak-20260908T153000');
  expect(cmd).toContain('/addons/idx_hj');
  expect(cmd).toContain('.deploy-staging/idx_hj');
  // 遠端獨有的模組完全不可出現
  expect(cmd).not.toContain('web_responsive');
  expect(cmd).not.toContain('rsync');
});

// 意圖（Rule 9）：沒有 set -e 的話，tar 解檔失敗（磁碟滿、tgz 損毀）之後後面幾行照跑——
// 舊模組已經被 mv 進備份、新的沒解出來，模組就整個從 addons 目錄消失了。
// 而 Odoo 的 -u 對「找不到的模組」只印警告就 exit 0、健康檢查照樣過 ⇒ 部署回報成功、
// last_deployed_sha 被推進，那個模組從此不會再被送上去。這一行是唯一擋住它的東西。
test('換檔整段 set -e，且解出來了才准動現役目錄', () => {
  const cmd = buildSwapCmd(HUNGJOU_TEST, ['idx_hj'], TS);
  expect(cmd.split('\n')[0]).toBe('set -e');
  // tar 解完要有一道「頂層目錄真的在」的斷言，才輪得到動 addons 底下的現役目錄
  const lines = cmd.split('\n');
  const assertIdx = lines.findIndex(l => l === '[ -d /home/arich/DockerData/odoo/Data/odoo-tst/addons/.deploy-staging/idx_hj ]');
  const moveIdx = lines.findIndex(l => l.includes('mv /home/arich/DockerData/odoo/Data/odoo-tst/addons/idx_hj'));
  expect(assertIdx).toBeGreaterThan(-1);
  expect(moveIdx).toBeGreaterThan(assertIdx);
  // 上一次失敗留下的 staging 殘骸會讓上面那道斷言假通過，所以解檔前要先清掉
  expect(cmd).toContain('rm -rf /home/arich/DockerData/odoo/Data/odoo-tst/addons/.deploy-staging/idx_hj');
});

test('回滾把備份搬回原位', () => {
  const cmd = buildRollbackCmd(HUNGJOU_TEST, ['idx_hj'], TS);
  expect(cmd).toContain('.deploy-bak-20260908T153000/idx_hj');
  expect(cmd).toContain('/addons/idx_hj');
});

// 意圖（Rule 9）：回滾若先無條件 rm -rf 現役目錄再看有沒有備份，那麼「swap 在建立備份之前
// 就失敗」的情況下，那一行會把客戶正在用的模組直接刪掉，而且沒有東西補得回去。
// 刪除必須被「備份存在」這個條件包住，兩件事同進同出。
test('回滾在沒有備份時不得刪掉現役模組', () => {
  const cmd = buildRollbackCmd(HUNGJOU_TEST, ['idx_hj'], TS);
  for (const line of cmd.split('\n')) {
    if (!line.includes('rm -rf')) continue;
    // 同一行內必須先出現備份存在的判斷，rm 才會被執行到
    expect(line.indexOf('[ -d /home/arich/DockerData/odoo/Data/odoo-tst/addons/.deploy-bak-20260908T153000/idx_hj ]'))
      .toBeGreaterThan(-1);
    expect(line.indexOf('[ -d ')).toBeLessThan(line.indexOf('rm -rf'));
  }
});

// 意圖：這是唯一擋在「使用者可編輯的欄位」與「遠端 shell」之間的東西。
test('不合法的服務名／DB 名／路徑／模組名一律 throw，不產出指令', () => {
  expect(() => buildUpgradeCmd({ ...HUNGJOU_TEST, compose_service: 'a; rm -rf /' }, PW, ['idx_hj'])).toThrow();
  expect(() => buildUpgradeCmd({ ...HUNGJOU_TEST, db_name: 'a$(id)' }, PW, ['idx_hj'])).toThrow();
  expect(() => buildUpgradeCmd({ ...HUNGJOU_TEST, conf_path: '../../etc/passwd' }, PW, ['idx_hj'])).toThrow();
  expect(() => buildSwapCmd({ ...HUNGJOU_TEST, addons_dir: 'relative/path' }, ['idx_hj'], TS)).toThrow();
  expect(() => buildUpgradeCmd(HUNGJOU_TEST, PW, ['idx_hj; id'])).toThrow();
  expect(() => buildUpgradeCmd(HUNGJOU_TEST, PW, [])).toThrow();
  expect(() => buildHealthCmd({ ...HUNGJOU_TEST, http_port: '8101; id' })).toThrow();
});

// ── 多資料庫共用一次停機

const T_DOCKER = {
  runtime: 'docker', compose_dir: '/home/arich/DockerData/odoo', compose_service: 'odoo-prd',
  container_name: 'odoo-prd-web', conf_path: '/etc/odoo/odoo.conf', addons_dir: '/d/addons',
};
const T_SYSTEMD = { runtime: 'systemd', service_name: 'odoo', conf_path: '/etc/odoo.conf', addons_dir: '/d/addons' };

// 意圖（Rule 9）：鴻久那台 odoo_prd 與 odoo_dev 都掛在 odoo-prd 容器底下。
// 一個目標停一次的話客戶被斷線兩次，而且兩次之間服務是活的——使用者這時進得來，
// 用到的是只升了一半的狀態。停一次、逐個升、起一次才對。
test('多 DB（docker compose）只停一次、起一次，中間逐個資料庫升級', () => {
  const cmd = buildUpgradeCmdMulti([
    { target: { ...T_DOCKER, db_name: 'odoo_prd' }, modules: ['idx_hj'] },
    { target: { ...T_DOCKER, db_name: 'odoo_dev' }, modules: ['idx_hj', 'idx_scan'] },
  ], {});
  expect((cmd.match(/docker compose stop odoo-prd/g) || [])).toHaveLength(1);
  expect((cmd.match(/docker compose start odoo-prd/g) || [])).toHaveLength(1);
  expect((cmd.match(/docker compose run --rm/g) || [])).toHaveLength(2);
  // 升級順序＝傳進來的順序，且每個 DB 只吃自己的模組
  expect(cmd.indexOf('-d odoo_prd')).toBeLessThan(cmd.indexOf('-d odoo_dev'));
  expect(cmd).toMatch(/-d odoo_prd -u idx_hj /);
  expect(cmd).toMatch(/-d odoo_dev -u idx_hj,idx_scan /);
});

test('多 DB（systemd）只停一次、起一次', () => {
  const cmd = buildUpgradeCmdMulti([
    { target: { ...T_SYSTEMD, db_name: 'ciyun' }, modules: ['idx_hj'] },
    { target: { ...T_SYSTEMD, db_name: 'production_test' }, modules: ['idx_hj'] },
  ], {});
  expect((cmd.match(/systemctl stop odoo\b/g) || [])).toHaveLength(1);
  expect((cmd.match(/systemctl start odoo\b/g) || [])).toHaveLength(1);
  expect((cmd.match(/odoo-bin -c/g) || [])).toHaveLength(2);
  expect(cmd).toMatch(/-d ciyun -u idx_hj/);
  expect(cmd).toMatch(/-d production_test -u idx_hj/);
});

// 每個值都要過白名單。這是唯一擋在使用者可編輯的欄位與客戶正式機 shell 之間的東西。
test('多 DB 的任一個資料庫名不合法就整串不產出', () => {
  expect(() => buildUpgradeCmdMulti([
    { target: { ...T_DOCKER, db_name: 'ok_db' }, modules: ['idx_hj'] },
    { target: { ...T_DOCKER, db_name: 'x; rm -rf /' }, modules: ['idx_hj'] },
  ], {})).toThrow(/db_name/);
});

test('多 DB 清單為空直接拋，不產半套指令', () => {
  expect(() => buildUpgradeCmdMulti([], {})).toThrow(/不可為空/);
});

// 意圖（Rule 9）：沿用單一的 readExitCode（取整份最後一個）會只讀到最後一個 DB 的碼，
// 前面失敗的全部被判成功，而且部署回報綠燈。一定要 per-DB 分開讀。
test('多 DB 的 exit code 依 DB 分開讀，前面失敗不會被後面洗掉', () => {
  const out = [
    '### DB odoo_prd', 'Traceback ...', 'EXITCODE=1',
    '### DB odoo_dev', 'Modules loaded.', 'EXITCODE=0',
  ].join('\n');
  const m = readExitCodesByDb(out);
  expect(m.get('odoo_prd')).toBe(1);
  expect(m.get('odoo_dev')).toBe(0);
});

// log 內容本身可能含 EXITCODE= 字樣，取每段最後一個才是我們印的那個
test('段落內出現 EXITCODE 字樣時取最後一個', () => {
  const out = ['### DB a', 'client said EXITCODE=99', 'EXITCODE=0'].join('\n');
  expect(readExitCodesByDb(out).get('a')).toBe(0);
});

// 指令被截斷／DB 根本沒跑到時該段沒有碼，回 null 讓呼叫端當失敗——漏讀比誤判成功安全
test('某個 DB 沒有 exit code 時回 null 而不是省略', () => {
  const out = ['### DB a', 'EXITCODE=0', '### DB b', '（被截斷）'].join('\n');
  const m = readExitCodesByDb(out);
  expect(m.get('a')).toBe(0);
  expect(m.has('b')).toBe(true);
  expect(m.get('b')).toBeNull();
});

// ── 分組

const G = (o) => ({ id: o.id, conn_id: 1, repo_id: 1, branch: 'main', runtime: 'docker',
  compose_dir: '/srv', compose_service: 'web', container_name: 'web-1', service_name: null,
  addons_dir: '/d/addons', conf_path: '/etc/odoo/odoo.conf', ...o });

test('同一個部署位置的目標合成一組', () => {
  expect(groupTargets([G({ id: 1, db_name: 'a' }), G({ id: 2, db_name: 'b' })])).toEqual([[1, 2]]);
});

// 意圖（Rule 9）：分支不同＝要送的檔案版本不同。共用同一份 addons 目錄會互相覆蓋，
// 於是正式區拿到測試分支的碼——而且部署全程綠燈。
test('分支不同的目標不可合併', () => {
  expect(groupTargets([G({ id: 1, branch: 'main' }), G({ id: 2, branch: 'ai-dev' })]))
    .toEqual([[1], [2]]);
});

test('addons 目錄、容器、連線、repo 任一不同都不合併', () => {
  for (const diff of [{ addons_dir: '/other' }, { compose_service: 'other' },
    { conn_id: 2 }, { repo_id: 2 }, { conf_path: '/other.conf' }]) {
    expect(groupTargets([G({ id: 1 }), G({ id: 2, ...diff })])).toEqual([[1], [2]]);
  }
});

// null 與空字串在 DB 裡是兩種寫法，但指的是同一件事（沒有 compose context）
test('null 與 undefined 的欄位視為相同，不會被拆成兩組', () => {
  expect(groupTargets([
    G({ id: 1, service_name: null }),
    G({ id: 2, service_name: undefined }),
  ])).toEqual([[1, 2]]);
});
