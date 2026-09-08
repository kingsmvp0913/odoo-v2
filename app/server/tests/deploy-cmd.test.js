const { pickModules, buildUpgradeCmd, buildRestartCmd, buildHealthCmd, buildSwapCmd, buildRollbackCmd } = require('../lib/deploy-cmd');

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

test('有密碼時 sudo 走 -S 且提示置空；免密時是裸 sudo', () => {
  expect(buildRestartCmd(HUNGJOU_TEST, PW)).toContain("sudo -S -p ''");
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

test('回滾把備份搬回原位', () => {
  const cmd = buildRollbackCmd(HUNGJOU_TEST, ['idx_hj'], TS);
  expect(cmd).toContain('.deploy-bak-20260908T153000/idx_hj');
  expect(cmd).toContain('/addons/idx_hj');
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
