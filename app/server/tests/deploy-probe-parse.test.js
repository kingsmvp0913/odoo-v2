const { parseProbe, parseConf, parseComposeLabels, buildProbeScript,
  parseConfPath, parseOdooBin, parseMounts, mapToHostPath, listRepoModules, rankAddonsDirs } = require('../lib/deploy-probe');

// 以下 fixture 是 2026-09-08 對兩台真實客戶機的探測輸出，逐字照抄。
// 意圖（Rule 9）：解析器唯一的價值就是「看得懂真機吐出來的東西」，自己編的樣本
// 過了不代表什麼——真機的空白、大小寫、錯誤訊息格式都跟想像的不一樣。

const CIYUN = `### odooversion
Odoo Server 17.0e
### whoami
uid=1001(ideaxpress) gid=1002(ideaxpress) groups=1002(ideaxpress),113(odoo),1001(google-sudoers)
### sudo-nopass
RC=0
### docker
bash: line 6: docker: command not found
### systemd-odoo
  odoo-server.service    loaded    active   running LSB: Enterprise Business Applications
  odoo-test.service      loaded    active   running Odoo Test Instance
### disk
Filesystem      Size  Used Avail Use% Mounted on
/dev/root        48G  7.9G   40G  17% /`;

const HUNGJOU = `### whoami
uid=1000(arich) gid=1000(arich) groups=1000(arich),27(sudo)
### sudo-nopass
sudo: a password is required
RC=1
### docker
odoo-tst-web|odoo-tst:17.0|8071-8072/tcp, 0.0.0.0:8101->8069/tcp
odoo-tst-runner|odoo-odoo-tst-runner|8069/tcp
odoo-db|postgres:16|5432/tcp
caddy-odoo|caddy-dns:local|0.0.0.0:443->443/tcp
### systemd-odoo
### disk
Filesystem      Size  Used Avail Use% Mounted on
/dev/nvme0n1p2  900G  442G  412G  52% /`;

test('慈雲：無 docker、免密 sudo、兩個 systemd unit', () => {
  const r = parseProbe(CIYUN);
  expect(r.runtime).toBe('systemd');
  expect(r.sudoMode).toBe('nopasswd');
  expect(r.containers).toEqual([]);
  expect(r.units).toEqual(['odoo-server', 'odoo-test']);
  expect(r.diskAvailGb).toBe(40);
  expect(r.odooVersion).toBe('Odoo Server 17.0e');
});

// 意圖：spec §11 唯一還沒解的事實就是慈雲那台的 Odoo 版本。
// 解析器要看得懂它，否則探測跑了還是拿不到。
test('解析 Odoo 版本；沒探到時回 null 不回空字串', () => {
  expect(parseProbe('### odooversion\nOdoo Server 17.0-20260324\n').odooVersion)
    .toBe('Odoo Server 17.0-20260324');
  expect(parseProbe('### odooversion\n').odooVersion).toBeNull();
});

test('鴻久：docker、需密碼 sudo', () => {
  const r = parseProbe(HUNGJOU);
  expect(r.runtime).toBe('docker');
  expect(r.sudoMode).toBe('password');
  expect(r.diskAvailGb).toBe(412);
});

// 意圖：odoo-db 名字含 odoo 但 image 是 postgres:16，caddy 是反向代理——
// 兩者都不是部署目標。只看名字會把 odoo-db 收進來，得用 image 排除。
test('排除資料庫與反代容器，保留 odoo 容器', () => {
  const r = parseProbe(HUNGJOU);
  expect(r.containers.map(c => c.name)).toEqual(['odoo-tst-web', 'odoo-tst-runner']);
});

test('docker 不存在時輸出是錯誤訊息，不可解析成容器', () => {
  const r = parseProbe(CIYUN);
  expect(r.containers).toEqual([]);
});

test('解析 compose 標籤', () => {
  const out = 'project=odoo service=odoo-tst workdir=/home/arich/DockerData/odoo files=/home/arich/DockerData/odoo/compose.yaml';
  expect(parseComposeLabels(out)).toEqual({
    project: 'odoo', service: 'odoo-tst',
    workingDir: '/home/arich/DockerData/odoo',
    configFiles: '/home/arich/DockerData/odoo/compose.yaml'
  });
});

// 意圖：conf 的 db_name 是逗號分隔的 dbfilter 白名單，不是「要升級哪個 DB」。
// 鴻久測試區就是 `odoo_tst,hutest`。誤把整串當 DB 名會直接讓升級指令炸掉。
test('conf 的 db_name 是清單，要拆開', () => {
  const conf = `[options]
addons_path = /usr/lib/python3/dist-packages/odoo/addons,/mnt/extra-addons
db_name = odoo_tst,hutest
http_port = 8069
db_password = BZpdmqA48CpTtj2zzAo5ZFUch8WF8wpR`;
  const r = parseConf(conf);
  expect(r.dbNames).toEqual(['odoo_tst', 'hutest']);
  expect(r.addonsPath).toEqual(['/usr/lib/python3/dist-packages/odoo/addons', '/mnt/extra-addons']);
  expect(r.httpPort).toBe(8069);
});

test('慈雲的 conf 用 addons_path= 無空格、port 是 8070', () => {
  const r = parseConf('http_port = 8070\naddons_path = /odoo/odoo-server/addons,/odoo/custom/addons_test');
  expect(r.addonsPath).toEqual(['/odoo/odoo-server/addons', '/odoo/custom/addons_test']);
  expect(r.httpPort).toBe(8070);
});

// 意圖：探測腳本裡如果有任何自由文字，白名單就白設了。
test('探測腳本唯讀且不含破壞性指令', () => {
  const s = buildProbeScript({ ssh_password: "p'w" });
  expect(s).toContain('sudo -A');
  // 探測會連進客戶正式機。密碼走 stdin，不得出現在指令字串（/proc/<pid>/cmdline 全機可讀）
  expect(s).not.toContain("p'w");
  expect(s).not.toMatch(/\brm\b|\bmv\b|systemctl (stop|restart|start)|docker (restart|stop|rm)/);
  expect(s).toContain('### odooversion');
});

// ── 自動帶出欄位用的解析器

// 意圖（Rule 9）：conf 路徑抓錯，部署指令的 -c 就指到不存在的檔，Odoo 直接用預設值起來，
// 升級的是別的資料庫。docker 與 systemd 兩種來源的分隔符不同，兩種都要吃得下。
test('conf 路徑：docker 的 JSON 陣列與 systemd 的 ExecStart 都解得出來', () => {
  expect(parseConfPath('["odoo","-c","/etc/odoo/odoo.conf"] ["/entrypoint.sh"]'))
    .toBe('/etc/odoo/odoo.conf');
  expect(parseConfPath('{ path=/usr/bin/odoo ; argv[]=/usr/bin/odoo -c /etc/odoo15.conf ; ignore_errors=no }'))
    .toBe('/etc/odoo15.conf');
  expect(parseConfPath('["odoo","--config=/opt/odoo/custom.conf"]')).toBe('/opt/odoo/custom.conf');
});

// 找不到就回 null，不可退回一個猜的路徑——猜的路徑會被當成事實存進部署目標。
test('conf 路徑找不到時回 null，不亂猜', () => {
  expect(parseConfPath('["odoo"]')).toBeNull();
  expect(parseConfPath('')).toBeNull();
  expect(parseConfPath('-c /etc/odoo/odoo.yaml')).toBeNull();   // 不是 .conf
});

test('掛載資訊解不動時回空陣列，不拋', () => {
  expect(parseMounts('')).toEqual([]);
  expect(parseMounts('Error: No such object')).toEqual([]);
  expect(parseMounts('[{"Source":"/host/a","Destination":"/mnt/a"}]'))
    .toEqual([{ Source: '/host/a', Destination: '/mnt/a' }]);
});

// 意圖（Rule 9）：conf 裡的 addons_path 是容器內路徑，部署卻是 SFTP 傳到宿主。
// 少了這層換算會把宿主上不存在的路徑存成 addons_dir，要到真的部署那一刻才炸。
// 兩個掛載都命中時必須取較深的那個——取錯會把碼放到整個資料目錄的根。
test('容器內路徑換算成宿主路徑，多個掛載命中時取最深的', () => {
  const mounts = [
    { Source: '/home/arich/DockerData/odoo/Data', Destination: '/mnt' },
    { Source: '/home/arich/DockerData/odoo/Data/odoo-tst/addons', Destination: '/mnt/extra-addons' },
  ];
  expect(mapToHostPath('/mnt/extra-addons', mounts))
    .toBe('/home/arich/DockerData/odoo/Data/odoo-tst/addons');
  expect(mapToHostPath('/mnt/extra-addons/idx_hj', mounts))
    .toBe('/home/arich/DockerData/odoo/Data/odoo-tst/addons/idx_hj');
});

// 沒有對應掛載的多半是容器內建的核心 addons，本來就不該部署，回 null 讓呼叫端跳過。
test('容器內路徑沒有對應掛載時回 null', () => {
  expect(mapToHostPath('/usr/lib/python3/dist-packages/odoo/addons', [{ Source: '/h', Destination: '/mnt' }]))
    .toBeNull();
  expect(mapToHostPath('/mnt/x', [])).toBeNull();
});

// 意圖（Rule 9 + Rule 19）：addons_path 常混著 Odoo 核心與 OCA（鴻久那台就是）。
// 挑錯目錄，部署當下不會報錯——升級指令照跑，只是升的是舊碼。
// 一定要放兩個以上目錄：只有一筆時排序邏輯對錯都一樣，全綠證明不了什麼。
test('addons 目錄依「我們的模組命中數」排序，命中多的排前面', () => {
  const listings = [
    { dir: '/opt/oca', entries: ['web_responsive', 'idx_hj'] },
    { dir: '/opt/ours', entries: ['idx_hj', 'idx_scan', 'hungjou_base'] },
    { dir: '/opt/core', entries: ['sale', 'purchase'] },
  ];
  const r = rankAddonsDirs(listings, ['idx_hj', 'idx_scan', 'hungjou_base']);
  expect(r[0].dir).toBe('/opt/ours');
  expect(r[0].matched).toEqual(['idx_hj', 'idx_scan', 'hungjou_base']);
  expect(r[2].dir).toBe('/opt/core');
  expect(r[2].matched).toEqual([]);
});

// repo 裡不是每個目錄都是模組（.git、docs、setup），也不能只篩 idx_ 前綴——
// 沿用既有 module 時不改名（CLAUDE.md §1），那些不叫 idx_。判準只有 __manifest__.py。
test('repo 模組清單以 __manifest__.py 為準，不看名字', () => {
  const dirs = ['.git', 'docs', 'idx_hj', 'hungjou_base', 'setup'];
  const withManifest = new Set(['idx_hj', 'hungjou_base']);
  const fs = {
    readdirSync: () => dirs.map(n => ({ name: n, isDirectory: () => true })),
    existsSync: (p) => withManifest.has(String(p).split('/').slice(-2)[0]),
  };
  expect(listRepoModules('/repo', { fs, path: { join: (...a) => a.join('/') } }))
    .toEqual(['hungjou_base', 'idx_hj']);
});

test('repo 路徑讀不到時回空陣列，不拋', () => {
  const fs = { readdirSync: () => { throw new Error('ENOENT'); }, existsSync: () => false };
  expect(listRepoModules('/nope', { fs })).toEqual([]);
});

// 意圖（Rule 9）：慈雲那台的 odoo-bin 不在 PATH 上，部署因此 `command not found` 整批回滾。
// 完整路徑一直都寫在 systemd 的 ExecStart 裡，只是以前沒人去讀。
test('odoo 執行檔：從 systemd 的 ExecStart 讀出完整路徑', () => {
  expect(parseOdooBin('{ path=/odoo/odoo-server/odoo-bin ; argv[]=/odoo/odoo-server/odoo-bin -c /etc/odoo-test.conf ; ignore_errors=no }'))
    .toBe('/odoo/odoo-server/odoo-bin');
  expect(parseOdooBin('{ path=/usr/bin/odoo ; argv[]=/usr/bin/odoo -c /etc/odoo15.conf ; }'))
    .toBe('/usr/bin/odoo');
});

// 慈雲的正式區走舊式 init 腳本（實查：path=/etc/init.d/odoo-server）。那不是 odoo 執行檔，
// 拿去 `sudo -u odoo <它> -c ... -u ...` 會用完全不同的參數語意跑起來。
// 認不出就回 null＝退回裸名，與這個欄位存在之前的行為相同。
test('odoo 執行檔：不是 odoo 執行檔就回 null，不亂猜', () => {
  expect(parseOdooBin('{ path=/etc/init.d/odoo-server ; argv[]=/etc/init.d/odoo-server start ; }')).toBeNull();
  expect(parseOdooBin('{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 /opt/odoo-bin ; }')).toBeNull();
  expect(parseOdooBin('')).toBeNull();
  expect(parseOdooBin('odoo-bin -c /etc/odoo.conf')).toBeNull();   // 沒有 path=
});
