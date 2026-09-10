jest.mock('../lib/vpn-gateway', () => ({ ensureGatewayRunning: jest.fn().mockResolvedValue({}) }));
jest.mock('../lib/db-connections', () => ({ loadDecryptedConn: jest.fn() }));

const { ensureGatewayRunning } = require('../lib/vpn-gateway');
const { loadDecryptedConn } = require('../lib/db-connections');
const { runProbe, linkConns } = require('../lib/deploy-probe');

const DOCKER_OUT = `### sudo-nopass
sudo: a password is required
RC=1
### docker
odoo-tst-web|odoo-tst:17.0|0.0.0.0:8101->8069/tcp
### disk
/dev/nvme0n1p2  900G  442G  412G  52% /`;

const SYSTEMD_OUT = `### sudo-nopass
RC=0
### systemd-odoo
  odoo-test.service    loaded active running Odoo Test Instance
### odooversion
Odoo Server 17.0e`;

const LABELS = 'project=odoo service=odoo-tst workdir=/home/arich/DockerData/odoo files=/home/arich/DockerData/odoo/compose.yaml';

// docker 路線會多打兩次（inspect 標籤、進容器問版本），依指令內容分派假輸出。
// 探測腳本自己就含 `odoo --version`，所以要先認出探測腳本，不能只比對 --version。
function dockerExec(extra = {}) {
  return async (conn, cmd) => {
    if (cmd.includes('### whoami')) return { stdout: DOCKER_OUT, stderr: '', code: 0 };
    if (cmd.includes('com.docker.compose')) return { stdout: extra.labels ?? LABELS, stderr: '', code: 0 };
    if (cmd.includes('docker exec')) return { stdout: extra.version ?? 'Odoo Server 17.0-20260324', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
}

beforeEach(() => {
  ensureGatewayRunning.mockClear();
  loadDecryptedConn.mockReset();
});

// 意圖（Rule 9）：VPN 專案不先撥號就直接 SSH，會對一個連不到的內網位址握手，
// 錯誤訊息完全不指向真因。鴻久是 vpn_enabled，這條路徑是它的日常。
test('vpn_enabled 的連線先撥號，且目標改指轉發埠', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 2, ssh_host: '192.168.1.233', ssh_user: 'arich', ssh_password: 'pw',
    vpn_enabled: true, vpn_forward_port: 30022, vpn: { targets: [] }, db_name: 'odoo_tst',
  });
  const seen = [];
  const base = dockerExec();
  const exec = async (conn, cmd) => { seen.push(conn); return base(conn, cmd); };
  const r = await runProbe(2, 3, exec);
  expect(r.ok).toBe(true);
  expect(ensureGatewayRunning).toHaveBeenCalledTimes(1);
  expect(seen[0].ssh_host).toBe('127.0.0.1');
  expect(seen[0].ssh_port).toBe(30022);
});

test('VPN 已啟用但專案沒設定 .ovpn 時擋在撥號前', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 2, ssh_host: 'h', ssh_user: 'u', vpn_enabled: true, vpn: null, db_name: 'd',
  });
  const r = await runProbe(2, 3, dockerExec());
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/VPN/);
  expect(ensureGatewayRunning).not.toHaveBeenCalled();
});

test('不是 VPN 的連線不撥號', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 7, ssh_host: '34.173.226.223', ssh_user: 'ideaxpress', auth_type: 'key', ssh_key: 'K',
    vpn_enabled: false, db_name: 'production_test',
  });
  const r = await runProbe(7, 2, async () => ({ stdout: SYSTEMD_OUT, stderr: '', code: 0 }));
  expect(ensureGatewayRunning).not.toHaveBeenCalled();
  expect(r.candidates[0].runtime).toBe('systemd');
  expect(r.candidates[0].serviceName).toBe('odoo-test');
  expect(r.candidates[0].odooVersion).toBe('Odoo Server 17.0e');
});

// 意圖：Task 4 寫了 parseComposeLabels 卻沒人呼叫的話，compose_dir／compose_service
// 會永遠是空的，整條 compose 部署路線跑不動——而且不會有任何錯誤。
test('docker 候選帶出 compose service 與工作目錄（與容器名不同）', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 1, ssh_host: 'h', ssh_user: 'u', ssh_password: 'p', vpn_enabled: false, db_name: 'odoo_tst',
  });
  const r = await runProbe(1, 3, dockerExec());
  const c = r.candidates[0];
  expect(c.containerName).toBe('odoo-tst-web');
  expect(c.composeService).toBe('odoo-tst');
  expect(c.composeDir).toBe('/home/arich/DockerData/odoo');
  expect(c.odooVersion).toBe('Odoo Server 17.0-20260324');
});

test('取不到 compose 標籤時候選仍列出來，只是欄位為 null', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 1, ssh_host: 'h', ssh_user: 'u', ssh_password: 'p', vpn_enabled: false, db_name: 'odoo_tst',
  });
  const r = await runProbe(1, 3, dockerExec({ labels: 'project= service= workdir= files=' }));
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].composeService).toBeNull();
});

// 意圖：db_name 以 db_connections 為準，conf 只作交叉驗證。
// 讀 conf 猜會拿到 `odoo_tst,hutest` 這種清單，選錯就升級到別的 DB。
test('候選帶入的 db_name 來自 db_connections 而非 conf', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 1, ssh_host: 'h', ssh_user: 'u', ssh_password: 'p', vpn_enabled: false, db_name: 'odoo_tst',
  });
  const r = await runProbe(1, 3, dockerExec());
  expect(r.candidates[0].dbName).toBe('odoo_tst');
});

// 意圖：客戶 conf 內的 db_password/admin_passwd 是明碼，探測一定會讀到。
// 存進 probe_json 或回給前端之前一定要遮掉。
test('原始輸出回傳前已遮罩', async () => {
  loadDecryptedConn.mockResolvedValue({ id: 1, ssh_host: 'h', ssh_user: 'u', vpn_enabled: false, db_name: 'd' });
  const r = await runProbe(1, 3, async () => ({ stdout: '### hostconf\ndb_password = SuperSecret123\n', stderr: '', code: 0 }));
  expect(r.raw).not.toContain('SuperSecret123');
});

test('SSH 連不上時回 ok:false，不是拋例外', async () => {
  loadDecryptedConn.mockResolvedValue({ id: 1, ssh_host: 'h', ssh_user: 'u', vpn_enabled: false, db_name: 'd' });
  const r = await runProbe(1, 3, async () => { throw new Error('connect ETIMEDOUT'); });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/ETIMEDOUT/);
});

test('找不到連線設定時回 ok:false', async () => {
  loadDecryptedConn.mockResolvedValue(null);
  const r = await runProbe(999, 3, dockerExec());
  expect(r.ok).toBe(false);
});

// ── 自動帶出欄位（conf 路徑／addons 目錄／conf 內的 db 清單）

const CONF = `[options]
addons_path = /usr/lib/python3/dist-packages/odoo/addons,/mnt/extra-addons
db_name = odoo_tst,hutest
http_port = 8069
db_password = SuperSecret123`;

const MOUNTS = '[{"Source":"/home/arich/DockerData/odoo/Data/odoo-tst/addons","Destination":"/mnt/extra-addons"}]';
const HOST_ADDONS = '/home/arich/DockerData/odoo/Data/odoo-tst/addons';

// enrich 會多打四種指令，順序不保證，一律依內容分派。
// `docker exec ... cat` 與 `docker exec ... odoo --version` 前綴相同，要靠尾巴分。
function richExec(extra = {}) {
  return async (conn, cmd) => {
    if (cmd.includes('### whoami')) return { stdout: DOCKER_OUT, stderr: '', code: 0 };
    if (cmd.includes('com.docker.compose')) return { stdout: LABELS, stderr: '', code: 0 };
    if (cmd.includes('.Config.Cmd')) return { stdout: extra.cmd ?? '["odoo","-c","/etc/odoo/odoo.conf"] ["/entrypoint.sh"]', stderr: '', code: 0 };
    if (cmd.includes('.Mounts')) return { stdout: extra.mounts ?? MOUNTS, stderr: '', code: 0 };
    if (cmd.includes('odoo --version')) return { stdout: 'Odoo Server 17.0-20260324', stderr: '', code: 0 };
    if (cmd.includes('cat ')) return { stdout: extra.conf ?? CONF, stderr: '', code: 0 };
    if (cmd.includes('ls -1 ')) {
      return { stdout: cmd.includes(HOST_ADDONS) ? 'idx_hj\nidx_scan\nweb_responsive\n' : '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
}

const REPOS = [{ id: 5, label: '主 repo', isPrimary: true, modules: ['idx_hj', 'idx_scan'] }];
const deps = { loadRepos: async () => REPOS };

function conn(db = 'odoo_tst') {
  loadDecryptedConn.mockResolvedValue({
    id: 1, ssh_host: 'h', ssh_user: 'u', ssh_password: 'p', vpn_enabled: false, db_name: db,
  });
}

// 意圖（Rule 9）：這三個欄位過去全靠人手打。抓不到不是「少個方便」——
// addons 目錄打錯，部署會把碼放進不會被載入的目錄，而且部署當下完全不報錯。
test('候選帶出 conf 路徑、宿主 addons 目錄與 conf 內的 db 清單', async () => {
  conn();
  const r = await runProbe(1, 3, richExec(), deps);
  const c = r.candidates[0];
  expect(c.confPath).toBe('/etc/odoo/odoo.conf');
  expect(c.addonsCandidates[0].dir).toBe(HOST_ADDONS);
  expect(c.addonsCandidates[0].matched).toEqual(['idx_hj', 'idx_scan']);
  expect(c.confDbNames).toEqual(['odoo_tst', 'hutest']);
  expect(c.httpPort).toBe(8069);
  expect(r.repos).toEqual(REPOS);
});

// 意圖：容器內建的核心 addons（/usr/lib/.../odoo/addons）沒有對應掛載，換不回宿主路徑。
// 若沒跳過而是原樣留著，人會挑到一條 SFTP 傳不進去的路徑。
test('換不回宿主路徑的容器內建 addons 目錄不列入候選', async () => {
  conn();
  const r = await runProbe(1, 3, richExec(), deps);
  const dirs = r.candidates[0].addonsCandidates.map(a => a.dir);
  expect(dirs).toEqual([HOST_ADDONS]);
});

// 意圖：db_name 仍以 db_connections 為準（conf 的是 dbfilter 白名單，猜錯就升到別的 DB）。
// 但一條連線探到多個 instance 時每個候選都拿到同一個 db_name，那時只有 conf 分辨得出誰是誰。
test('conf 的 db 清單不含這條連線的 db_name 時標記 dbMismatch', async () => {
  conn('odoo_prd');
  const r = await runProbe(1, 3, richExec(), deps);
  expect(r.candidates[0].dbName).toBe('odoo_prd');      // 不自作主張改掉
  expect(r.candidates[0].dbMismatch).toBe(true);
});

test('conf 的 db 清單含這條連線的 db_name 時不標記', async () => {
  conn('hutest');
  const r = await runProbe(1, 3, richExec(), deps);
  expect(r.candidates[0].dbMismatch).toBe(false);
});

// 意圖：conf 讀不到就只是那幾個欄位空著，候選本身必須還在——
// 候選不見了人就無從指認，比欄位空著糟得多。
test('conf 讀不到時候選仍列出來，只是欄位為 null／空', async () => {
  conn();
  const r = await runProbe(1, 3, richExec({ conf: 'cat: /etc/odoo/odoo.conf: No such file or directory' }), deps);
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].containerName).toBe('odoo-tst-web');
  expect(r.candidates[0].confPath).toBeNull();
  expect(r.candidates[0].addonsCandidates).toEqual([]);
  expect(r.candidates[0].dbMismatch).toBe(false);
});

// 啟動指令裡沒有 -c 時退回官方 image 的慣例路徑，但一定要 cat 得到才留著。
test('啟動指令沒帶 -c 時退回預設 conf 路徑，且要讀得到才算數', async () => {
  conn();
  const r = await runProbe(1, 3, richExec({ cmd: '["odoo"] ["/entrypoint.sh"]' }), deps);
  expect(r.candidates[0].confPath).toBe('/etc/odoo/odoo.conf');
});

// ── 用連線的 log_container 認出「這個資料庫由哪個容器服務」

const DOCKER_TWO = `### sudo-nopass
RC=0
### docker
odoo-dev-web|odoo-dev:17.0|0.0.0.0:8201->8069/tcp
odoo-prd-web|odoo-prd:17.0|0.0.0.0:8001->8069/tcp
### disk
/dev/nvme0n1p2  900G  442G  412G  52% /`;

function twoExec() {
  return async (conn, cmd) => {
    if (cmd.includes('### whoami')) return { stdout: DOCKER_TWO, stderr: '', code: 0 };
    if (cmd.includes('com.docker.compose')) {
      const svc = cmd.includes('odoo-prd-web') ? 'odoo-prd' : 'odoo-dev';
      return { stdout: `project=odoo service=${svc} workdir=/home/arich/DockerData/odoo files=x`, stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
}

// 意圖（Rule 9）：鴻久那台的 odoo_dev 是掛在 **odoo-prd** 容器底下，
// 但機器上另有一個同名的 odoo-dev 容器。照名字挑會挑到沒人在用的那個，
// 於是碼傳進沒人讀的目錄、重啟沒人用的容器，而 DB 的模組版本卻被升上去——
// 檔案舊、DB 新，Odoo 直接壞。唯一分辨得出來的線索是人填的 log_container。
test('連線的 log_container 指向誰，就把誰標成關聯並排到最前面', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 1, ssh_host: 'h', ssh_user: 'u', ssh_password: 'p', vpn_enabled: false, db_name: 'odoo_tst',
  });
  const conns = [
    { id: 2, name: '鴻久 - 正式', db_name: 'odoo_prd', log_container: 'odoo-prd-web' },
    { id: 3, name: '鴻伍 - 正式', db_name: 'odoo_dev', log_container: 'odoo-prd-web' },
  ];
  const r = await runProbe(1, 3, twoExec(), { loadRepos: async () => [], loadConns: async () => conns });
  // docker ps 先吐 odoo-dev-web，但有連線指名的 odoo-prd-web 要排第一
  expect(r.candidates[0].containerName).toBe('odoo-prd-web');
  expect(r.candidates[0].linkedConns.map(c => c.dbName)).toEqual(['odoo_prd', 'odoo_dev']);
  expect(r.candidates[1].containerName).toBe('odoo-dev-web');
  expect(r.candidates[1].linkedConns).toEqual([]);
});

// 沒有任何連線填 log_container 時不能報錯也不能亂排，維持 docker ps 的原順序。
test('沒有 log_container 線索時候選照原順序，linkedConns 為空', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 1, ssh_host: 'h', ssh_user: 'u', ssh_password: 'p', vpn_enabled: false, db_name: 'odoo_tst',
  });
  const r = await runProbe(1, 3, twoExec(), { loadRepos: async () => [], loadConns: async () => [] });
  expect(r.candidates.map(c => c.containerName)).toEqual(['odoo-dev-web', 'odoo-prd-web']);
  expect(r.candidates[0].linkedConns).toEqual([]);
});

// log_container 可能填的是 compose service 名而不是容器名（兩者不同：odoo-prd vs odoo-prd-web）
test('log_container 填 compose service 名也認得出來', () => {
  const c = { containerName: 'odoo-prd-web', composeService: 'odoo-prd', serviceName: null };
  expect(linkConns(c, [{ id: 9, name: 'X', db_name: 'd', log_container: 'odoo-prd' }]))
    .toEqual([{ id: 9, name: 'X', dbName: 'd' }]);
});

// ── systemd 專案（慈雲那台沒有容器）

const SYSTEMD_FULL = `### sudo-nopass
RC=0
### systemd-odoo
  odoo.service    loaded active running Odoo
### disk
/dev/sda1  200G  80G  110G  42% /
### odooversion
Odoo Server 17.0`;

const CIYUN_CONF = `[options]
addons_path = /opt/odoo/odoo/addons,/opt/odoo/custom/addons
db_name = ciyun
http_port = 8069`;

// 意圖（Rule 9）：conf 路徑寫死 /etc/odoo/odoo.conf 的話，systemd 安裝的專案（慈雲那台
// 是 /etc/odoo.conf）會全部抓不到 conf，於是 addons 目錄與模組三個欄位一起退回手填——
// 而且畫面上看不出是「路徑猜錯」還是「真的沒有 conf」。
function systemdExec({ confAt = '/etc/odoo.conf', execStart = null } = {}) {
  return async (conn, cmd) => {
    if (cmd.includes('### whoami')) return { stdout: SYSTEMD_FULL, stderr: '', code: 0 };
    if (cmd.includes('systemctl show')) return { stdout: execStart || '', stderr: '', code: 0 };
    if (cmd.includes('cat ')) {
      return cmd.includes(confAt)
        ? { stdout: CIYUN_CONF, stderr: '', code: 0 }
        : { stdout: `cat: 沒有此檔案`, stderr: '', code: 1 };
    }
    if (cmd.includes('ls -1 /opt/odoo/custom/addons')) return { stdout: 'idx_cy\nidx_hj\n', stderr: '', code: 0 };
    if (cmd.includes('ls -1 ')) return { stdout: 'base\nweb\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
}

test('systemd 專案：啟動指令沒帶 -c 時，依序試到 /etc/odoo.conf 才停', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 8, ssh_host: '34.173.226.223', ssh_user: 'ideaxpress', vpn_enabled: false, db_name: 'ciyun',
  });
  const r = await runProbe(8, 2, systemdExec(), {
    loadRepos: async () => [{ id: 1, label: 'main', isPrimary: true, modules: ['idx_cy', 'idx_hj'] }],
    loadConns: async () => [],
  });
  const c = r.candidates[0];
  expect(c.runtime).toBe('systemd');
  expect(c.serviceName).toBe('odoo');
  expect(c.confPath).toBe('/etc/odoo.conf');
  expect(c.confDbNames).toEqual(['ciyun']);
  expect(c.httpPort).toBe(8069);
});

// systemd 沒有容器掛載，conf 裡的 addons_path 本身就是宿主路徑，直接 ls 不必換算
test('systemd 專案：addons 目錄不做掛載換算，命中多的排前面', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 8, ssh_host: 'h', ssh_user: 'u', vpn_enabled: false, db_name: 'ciyun',
  });
  const r = await runProbe(8, 2, systemdExec(), {
    loadRepos: async () => [{ id: 1, label: 'main', isPrimary: true, modules: ['idx_cy', 'idx_hj'] }],
    loadConns: async () => [],
  });
  const dirs = r.candidates[0].addonsCandidates;
  expect(dirs[0].dir).toBe('/opt/odoo/custom/addons');
  expect(dirs[0].matched).toEqual(['idx_cy', 'idx_hj']);
  expect(dirs[1].dir).toBe('/opt/odoo/odoo/addons');
  expect(dirs[1].matched).toEqual([]);
});

test('systemd 專案：ExecStart 帶 -c 時就用它，不再試慣例路徑', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 8, ssh_host: 'h', ssh_user: 'u', vpn_enabled: false, db_name: 'ciyun',
  });
  const exec = systemdExec({
    confAt: '/opt/odoo/odoo.conf',
    execStart: '{ path=/opt/odoo/odoo-bin ; argv[]=/opt/odoo/odoo-bin -c /opt/odoo/odoo.conf ; }',
  });
  const r = await runProbe(8, 2, exec, { loadRepos: async () => [], loadConns: async () => [] });
  expect(r.candidates[0].confPath).toBe('/opt/odoo/odoo.conf');
});

// 慈雲的連線沒填 log_unit／log_container（實查：兩條都是 null）。
// 沒有線索時不可以報錯，也不可以亂排——就是照原順序、linkedConns 空。
test('systemd 專案沒填 log_unit 時不影響探測', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 8, ssh_host: 'h', ssh_user: 'u', vpn_enabled: false, db_name: 'ciyun',
  });
  const r = await runProbe(8, 2, systemdExec(), { loadRepos: async () => [], loadConns: async () => [] });
  expect(r.candidates).toHaveLength(1);
  expect(r.candidates[0].linkedConns).toEqual([]);
});

// systemd 專案的線索在 log_unit（沒有容器名）。unit 名帶不帶 .service 都要認得。
test('systemd 專案用 log_unit 當線索，.service 後綴有無都認得', () => {
  const c = { containerName: null, composeService: null, serviceName: 'odoo' };
  expect(linkConns(c, [{ id: 8, name: '正式', db_name: 'ciyun', log_unit: 'odoo.service' }]))
    .toEqual([{ id: 8, name: '正式', dbName: 'ciyun' }]);
  expect(linkConns(c, [{ id: 8, name: '正式', db_name: 'ciyun', log_unit: 'odoo' }]))
    .toEqual([{ id: 8, name: '正式', dbName: 'ciyun' }]);
});

// 意圖（Rule 9）：鴻久那台實測列出 7 個候選，其中 4 個是 queue_job 的 *-runner——
// 它們沒有掛我們的 addons 目錄，卻會混在候選清單前面把真正的目標推下去。
// 沒有連線指名時，「這個 instance 有沒有我們的模組」就是唯一能排序的線索。
test('都沒有連線指名時，有我們模組的 instance 排在沒有的前面', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 1, ssh_host: 'h', ssh_user: 'u', ssh_password: 'p', vpn_enabled: false, db_name: 'odoo_tst',
  });
  const exec = async (conn, cmd) => {
    if (cmd.includes('### whoami')) return { stdout: DOCKER_TWO, stderr: '', code: 0 };
    if (cmd.includes('com.docker.compose')) {
      const svc = cmd.includes('odoo-prd-web') ? 'odoo-prd-runner' : 'odoo-dev';
      return { stdout: `project=odoo service=${svc} workdir=/srv files=x`, stderr: '', code: 0 };
    }
    if (cmd.includes('.Mounts')) {
      // runner 沒有掛 addons 目錄；odoo-dev 有
      return cmd.includes('odoo-prd-web')
        ? { stdout: '[]', stderr: '', code: 0 }
        : { stdout: '[{"Source":"/host/dev/addons","Destination":"/mnt/extra-addons"}]', stderr: '', code: 0 };
    }
    if (cmd.includes('cat ')) return { stdout: 'addons_path = /mnt/extra-addons\ndb_name = d\n', stderr: '', code: 0 };
    if (cmd.includes('ls -1 /host/dev/addons')) return { stdout: 'idx_hj\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const r = await runProbe(1, 3, exec, {
    loadRepos: async () => [{ id: 1, label: 'm', isPrimary: true, modules: ['idx_hj'] }],
    loadConns: async () => [],
  });
  // docker ps 先吐 odoo-dev-web；就算順序反過來，有 addons 的也該在前
  expect(r.candidates[0].containerName).toBe('odoo-dev-web');
  expect(r.candidates[0].addonsCandidates).toHaveLength(1);
  expect(r.candidates[1].containerName).toBe('odoo-prd-web');
  expect(r.candidates[1].addonsCandidates).toHaveLength(0);
});

// 連線指名仍然是第一順位：runner 就算沒有 addons，被指名時也該排在前面（人說了算）
test('連線指名優先於「有沒有我們的模組」', async () => {
  loadDecryptedConn.mockResolvedValue({
    id: 1, ssh_host: 'h', ssh_user: 'u', ssh_password: 'p', vpn_enabled: false, db_name: 'odoo_tst',
  });
  const r = await runProbe(1, 3, twoExec(), {
    loadRepos: async () => [],
    loadConns: async () => [{ id: 9, name: 'X', db_name: 'd', log_container: 'odoo-prd-web' }],
  });
  expect(r.candidates[0].containerName).toBe('odoo-prd-web');
});
