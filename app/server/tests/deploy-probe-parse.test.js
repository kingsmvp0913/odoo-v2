const { parseProbe, parseConf, parseComposeLabels, buildProbeScript } = require('../lib/deploy-probe');

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
  expect(s).toContain("sudo -S -p ''");
  expect(s).not.toMatch(/\brm\b|\bmv\b|systemctl (stop|restart|start)|docker (restart|stop|rm)/);
  expect(s).toContain('### odooversion');
});
