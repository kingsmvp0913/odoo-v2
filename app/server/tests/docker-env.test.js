// 意圖：Docker 測試區的正確性都在「怎麼組 docker 參數」——連宿主 DB 的 host 改寫、addons 掛載映射、
// addons-path 補核心、容器名/image 標籤清洗、run/exec argv。這些是純函式，離線就能把實機才會踩到的
// 坑（漏核心 addons→base 找不到、localhost 連不到宿主 DB、addons basename 撞名互蓋）鎖死在測試裡。
const d = require('../lib/docker-env');

describe('image 標籤 / 容器名清洗', () => {
  test('imageTagFor 只取數字大版本', () => {
    expect(d.imageTagFor('17.0')).toBe('odoo-idx:17');
    expect(d.imageTagFor(13)).toBe('odoo-idx:13');
  });
  test('containerNameFor 清成 docker 合法字元、去前導點/連字號', () => {
    expect(d.containerNameFor('my proj/測試')).toBe('odoo-test-my-proj---');
    expect(d.containerNameFor('.hidden')).toBe('odoo-test-hidden');
    expect(d.containerNameFor('')).toBe('odoo-test-env');
  });
});

describe('remapDbHostForContainer：容器連宿主 Postgres', () => {
  test('localhost/127.0.0.1 → host.docker.internal', () => {
    expect(d.remapDbHostForContainer(['--db_host', 'localhost', '--db_port', '5416']))
      .toEqual(['--db_host', 'host.docker.internal', '--db_port', '5416']);
    expect(d.remapDbHostForContainer(['--db_host', '127.0.0.1']))
      .toEqual(['--db_host', 'host.docker.internal']);
  });
  test('遠端 DB host 原樣保留', () => {
    expect(d.remapDbHostForContainer(['--db_host', 'db.internal.example']))
      .toEqual(['--db_host', 'db.internal.example']);
  });
  test('未帶 --db_host → 補 host.docker.internal（否則容器連不到宿主 DB）', () => {
    expect(d.remapDbHostForContainer(['--db_user', 'odoo']))
      .toEqual(['--db_user', 'odoo', '--db_host', 'host.docker.internal']);
  });
});

describe('addonsMounts / containerAddonsPath', () => {
  test('各 host repo 掛成 /mnt/extra-addons/<basename>', () => {
    const m = d.addonsMounts(['/repos/p/main', '/repos/p/extra']);
    expect(m).toEqual([
      { host: '/repos/p/main', container: '/mnt/extra-addons/main' },
      { host: '/repos/p/extra', container: '/mnt/extra-addons/extra' },
    ]);
  });
  test('basename 撞名 → 綴序號，容器路徑不互蓋', () => {
    const m = d.addonsMounts(['/a/addons', '/b/addons']);
    expect(m.map(x => x.container)).toEqual(['/mnt/extra-addons/addons', '/mnt/extra-addons/addons-2']);
  });
  test('containerAddonsPath 必含核心 addons（否則 base 找不到）', () => {
    const m = d.addonsMounts(['/repos/p/main']);
    const p = d.containerAddonsPath(m);
    expect(p).toBe(`/mnt/extra-addons/main,${d.CORE_ADDONS}`);
    expect(p).toContain(d.CORE_ADDONS);
  });
});

describe('buildRunArgs', () => {
  const args = d.buildRunArgs({
    name: 'odoo-test-p1', image: 'odoo-idx:16', host: '127.0.0.5', port: 8070, dbName: 'test_p1',
    dbArgs: ['--db_host', 'localhost', '--db_user', 'odoo'],
    mounts: d.addonsMounts(['/repos/p1/main']),
    serverArgs: ['--without-demo=all'],
  });
  test('含 -d、名稱、host-gateway、port 對映、掛載', () => {
    expect(args.slice(0, 4)).toEqual(['run', '-d', '--name', 'odoo-test-p1']);
    expect(args).toContain('--add-host');
    expect(args).toContain('host.docker.internal:host-gateway');
    const pIdx = args.indexOf('-p');
    expect(args[pIdx + 1]).toBe('127.0.0.5:8070:8069');
    const vIdx = args.indexOf('-v');
    expect(args[vIdx + 1]).toBe('/repos/p1/main:/mnt/extra-addons/main:ro');
  });
  test('odoo 參數：db、addons-path 含核心、server 參數帶入；DB 連線不走 CLI（改走 entrypoint env）', () => {
    const odooIdx = args.indexOf('odoo');
    const tail = args.slice(odooIdx);
    expect(tail).toContain('test_p1');
    const apIdx = tail.indexOf('--addons-path');
    expect(tail[apIdx + 1]).toContain(d.CORE_ADDONS);
    expect(tail).toContain('--without-demo=all');
    // 官方 image entrypoint 會在使用者參數後補一組 --db_host/... 覆蓋 CLI 值，故 run 的 DB 連線
    // 一律不放 CLI（否則被覆蓋成 db:5432/odoo），改用 -e HOST=... 讓 entrypoint 組出正確連線。
    expect(tail).not.toContain('--db_host');
  });
  test('DB 連線改以 entrypoint env 傳入（-e HOST/USER，localhost 已 remap）', () => {
    // image 之前的 -e 旗標區
    const image = 'odoo-idx:16';
    const preImage = args.slice(0, args.indexOf(image));
    expect(preImage).toContain('HOST=host.docker.internal');
    expect(preImage).toContain('USER=odoo');
  });
});

describe('buildExecArgs（docker exec 進常駐容器跑一次性指令）', () => {
  test('非互動 odoo 指令：exec <container> <argv>', () => {
    const a = d.buildExecArgs({ container: 'c1', argv: ['odoo', '-u', 'sale', '-d', 'test_p1', '--stop-after-init'] });
    expect(a).toEqual(['exec', 'c1', 'odoo', '-u', 'sale', '-d', 'test_p1', '--stop-after-init']);
  });
  test('互動 + env：加 -i 與 -e（供 odoo shell 讀 stdin 腳本）', () => {
    const a = d.buildExecArgs({ container: 'c1', argv: ['odoo', 'shell', '--no-http'], interactive: true, env: { PYTHONUTF8: '1' } });
    expect(a).toContain('-i');
    const eIdx = a.indexOf('-e');
    expect(a[eIdx + 1]).toBe('PYTHONUTF8=1');
    expect(a.slice(-3)).toEqual(['odoo', 'shell', '--no-http']);
  });
  test('pip 補件走 -u root（需寫 site-packages）', () => {
    const a = d.buildExecArgs({ container: 'c1', argv: ['python', '-m', 'pip', 'install', '--', 'xlsxtpl'], user: 'root' });
    expect(a.slice(0, 4)).toEqual(['exec', '-u', 'root', 'c1']);
  });
});

describe('odooDbAddonsArgs（exec/run 共用的 db+addons 片段）', () => {
  test('含 -d、--addons-path（核心）、remap 後 db_host', () => {
    const a = d.odooDbAddonsArgs({ dbName: 'test_p1', mounts: d.addonsMounts(['/r/main']), dbArgs: ['--db_host', 'localhost'] });
    expect(a[0]).toBe('-d');
    expect(a[1]).toBe('test_p1');
    const apIdx = a.indexOf('--addons-path');
    expect(a[apIdx + 1]).toContain(d.CORE_ADDONS);
    const hIdx = a.indexOf('--db_host');
    expect(a[hIdx + 1]).toBe('host.docker.internal');
  });
});

describe('runDocker（IO 邊界，mock spawn）', () => {
  const { EventEmitter } = require('events');
  function fakeSpawn(script) {
    // script: { code, stdout, stderr }
    return () => {
      const ch = new EventEmitter();
      ch.stdout = new EventEmitter();
      ch.stderr = new EventEmitter();
      ch.stdin = { write() {}, end() {} };
      ch.kill = () => {};
      setImmediate(() => {
        if (script.stdout) ch.stdout.emit('data', script.stdout);
        if (script.stderr) ch.stderr.emit('data', script.stderr);
        ch.emit('close', script.code);
      });
      return ch;
    };
  }
  test('回傳 code/stdout/stderr，不 reject', async () => {
    const r = await d.runDocker(['info'], { spawnFn: fakeSpawn({ code: 0, stdout: 'ok' }) });
    expect(r).toEqual({ code: 0, stdout: 'ok', stderr: '' });
  });
  test('imageExists：有輸出→true', async () => {
    const yes = await d.imageExists('odoo-idx:16', { spawnFn: fakeSpawn({ code: 0, stdout: 'abc123\n' }) });
    expect(yes).toBe(true);
    const no = await d.imageExists('odoo-idx:16', { spawnFn: fakeSpawn({ code: 0, stdout: '' }) });
    expect(no).toBe(false);
  });
  test('containerRunning：inspect true → true', async () => {
    const run = await d.containerRunning('c1', { spawnFn: fakeSpawn({ code: 0, stdout: 'true\n' }) });
    expect(run).toBe(true);
    const stop = await d.containerRunning('c1', { spawnFn: fakeSpawn({ code: 0, stdout: 'false\n' }) });
    expect(stop).toBe(false);
  });
  test('ensureImage：image 已存在 → 不 build', async () => {
    const r = await d.ensureImage('16', '/ctx', { spawnFn: fakeSpawn({ code: 0, stdout: 'imgid\n' }) });
    expect(r.ok).toBe(true);
    expect(r.log).toContain('已存在');
  });

  // argv 組法：捕捉實際傳給 spawn 的參數（execOdoo 走 runDocker→spawn）
  function captureSpawn(captured) {
    return (cmd, args) => { captured.cmd = cmd; captured.args = args; return fakeSpawn({ code: 0, stdout: 'ok' })(); };
  }
  test('execOdoo：shell 子指令排在 odoo 之後、db 參數之前（否則 odoo 報 unrecognized shell）', async () => {
    const cap = {};
    await d.execOdoo(
      { container: 'c1', dbName: 'test_p1', dbArgs: ['--db_host', 'localhost'], mounts: [], odooArgs: ['shell', '--no-http'], interactive: true },
      { spawnFn: captureSpawn(cap), input: 'print(1)' }
    );
    const a = cap.args;
    expect(a[0]).toBe('exec');
    const odooIdx = a.indexOf('odoo');
    expect(a[odooIdx + 1]).toBe('shell');            // shell 緊接 odoo
    expect(a.indexOf('shell')).toBeLessThan(a.indexOf('-d')); // 在 db 參數之前
    expect(a).toContain('--no-http');
  });
  test('execOdoo：以 - 開頭的 odooArgs（如 -i）維持 server 指令，不誤判成子指令', async () => {
    const cap = {};
    await d.execOdoo(
      { container: 'c1', dbName: 'test_p1', dbArgs: [], mounts: [], odooArgs: ['-i', 'sale', '--stop-after-init'] },
      { spawnFn: captureSpawn(cap) }
    );
    const a = cap.args;
    const odooIdx = a.indexOf('odoo');
    expect(a[odooIdx + 1]).toBe('-d');               // 沒有子指令，直接接 db 參數
    expect(a.indexOf('-d')).toBeLessThan(a.indexOf('-i'));
  });
  test('execPipInstall：用 python3（官方 image 無 python 別名）、以 root 補件', async () => {
    const cap = {};
    await d.execPipInstall('c1', ['docxtpl', 'htmldocx'], { spawnFn: captureSpawn(cap) });
    const a = cap.args;
    expect(a.slice(0, 4)).toEqual(['exec', '-u', 'root', 'c1']);
    expect(a.slice(4, 8)).toEqual(['python3', '-m', 'pip', 'install']);
    expect(a).toContain('docxtpl');
    expect(a).toContain('htmldocx');
  });
});
