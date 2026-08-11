// 意圖：Docker 測試區的正確性都在「怎麼組 docker 參數」——連宿主 DB 的 host 改寫、addons 掛載映射、
// addons-path 補核心、容器名/image 標籤清洗、run/exec argv。這些是純函式，離線就能把實機才會踩到的
// 坑（漏核心 addons→base 找不到、localhost 連不到宿主 DB、addons basename 撞名互蓋）鎖死在測試裡。
const fs = require('fs');
const os = require('os');
const path = require('path');
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

  // 意圖（實際踩到的）：folder_name 是選填，留空時 dirName 拿專案 name。純中文名稱（「凌越生醫」）
  // 每個字都被換成 `-`、前導 `-` 再被剝光 → 空字串 → 舊版一律回固定的 'env'，**所有純中文專案
  // 共用同一個容器名**。而建立環境的第一步是 removeContainer(同名)，第二個中文專案一啟動就會
  // 砍掉第一個正在跑的容器，DB 仍記 running，使用者只看到「測試區突然變空白」。
  test('純非 ASCII 名稱：不同專案不得塌縮成同一個容器名', () => {
    const a = d.containerNameFor('凌越生醫', 8);
    const b = d.containerNameFor('慈雲寶塔', 2);
    expect(a).not.toBe(b);
    expect(a).toBe('odoo-test-p8');
    expect(a).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);   // 仍須是 docker 合法名稱
  });

  // 有可用名稱時不得改名——既有容器全靠這個名字被找到，改了等於全部變孤兒
  test('可用的 ASCII 名稱不受 projectId 影響（既有容器名不得漂移）', () => {
    expect(d.containerNameFor('odoo19_ciyun', 2)).toBe('odoo-test-odoo19_ciyun');
    expect(d.containerNameFor('odoo19_ciyun')).toBe('odoo-test-odoo19_ciyun');
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
    expect(p).toBe(`${d.PLATFORM_ADDONS_CONTAINER},/mnt/extra-addons/main,${d.CORE_ADDONS}`);
    expect(p).toContain(d.CORE_ADDONS);
  });
  test('containerAddonsPath 必含平台 addons（idx_aidev_sso 免密登入模組所在）', () => {
    // 平台自帶 addons（app/docker/addons）必須進「每個」測試區的 addons-path，否則平台簽發 token 的
    // /aidev/sso 端點在測試區根本不存在。無專案 repo（mounts 空）時也必須在。
    expect(d.containerAddonsPath([])).toContain(d.PLATFORM_ADDONS_CONTAINER);
    expect(d.containerAddonsPath(d.addonsMounts(['/repos/p/main']))).toContain(d.PLATFORM_ADDONS_CONTAINER);
  });
  test('enterprise 掛載排在專案 repos 之後、核心之前（順序即覆蓋權）', () => {
    const mounts = [
      ...d.addonsMounts(['/repos/p/main']),
      { host: '/enterprise/17', container: d.ENTERPRISE_CONTAINER_DIR, enterprise: true },
    ];
    expect(d.containerAddonsPath(mounts))
      .toBe(`${d.PLATFORM_ADDONS_CONTAINER},/mnt/extra-addons/main,/mnt/enterprise,${d.CORE_ADDONS}`);
  });
  test('enterprise 掛載一律唯讀（容器內寫不進共用來源）', () => {
    // mountFlags 未匯出（module.exports :312-323），故從 buildRunArgs 的實際輸出驗證，
    // 不為了測試而擴大匯出面。
    const args = d.buildRunArgs({
      name: 'c', image: 'i', host: '127.0.0.1', port: 21000, dbName: 'test_x',
      mounts: [{ host: '/enterprise/17', container: d.ENTERPRISE_CONTAINER_DIR, enterprise: true }],
    });
    expect(args).toContain('/enterprise/17:/mnt/enterprise:ro');
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
  test('filestoreDir → 綁 /var/lib/odoo/filestore（持久化，避免重建容器遺失 attachment）', () => {
    const a = d.buildRunArgs({ name: 'c', image: 'odoo-idx:17', port: 8070, dbName: 'test_p1', filestoreDir: '/host/env/filestore' });
    const image = 'odoo-idx:17';
    const preImage = a.slice(0, a.indexOf(image));
    expect(preImage).toContain('/host/env/filestore:/var/lib/odoo/filestore');
  });
  test('未給 filestoreDir → 不加該 -v（沿用容器預設 volume）', () => {
    expect(args.some(x => String(x).includes('/var/lib/odoo/filestore'))).toBe(false);
  });

  test('平台 addons 目錄一律唯讀掛入（idx_aidev_sso 進每個測試區）', () => {
    // 專案 repo 之外，平台自帶 addons（app/docker/addons）必掛入且列入 addons-path。
    expect(args).toContain(`${d.PLATFORM_ADDONS_HOST}:${d.PLATFORM_ADDONS_CONTAINER}:ro`);
    const odooIdx = args.indexOf('odoo');
    const apIdx = args.indexOf('--addons-path', odooIdx);
    expect(args[apIdx + 1]).toContain(d.PLATFORM_ADDONS_CONTAINER);
  });

  test('buildRunArgs 加上 DB manager hardening 旗標（--db-filter 為 Odoo CLI 選項名，非 config 的 dbfilter）', () => {
    const args = d.buildRunArgs({ name: 'c', image: 'odoo:17', host: '127.0.0.2', port: 8069, dbName: 'test_demo' });
    expect(args).toContain('--no-database-list');
    expect(args).toContain('--db-filter=^test_demo$');
  });

  test('db-filter 對 dbName 做 regex-escape：含 "." 的資料夾名不會被當 pattern 放寬', () => {
    const args = d.buildRunArgs({ name: 'c', image: 'odoo:17', port: 8069, dbName: 'test_a.b' });
    expect(args).toContain('--db-filter=^test_a\\.b$');
    expect(args).not.toContain('--db-filter=^test_a.b$');
  });

  test('不帶 master 密碼旗標：Odoo 17 無 --admin_passwd CLI 選項，靠 --no-database-list 關管理介面', () => {
    const args = d.buildRunArgs({ name: 'c', image: 'odoo:17', port: 8069, dbName: 'test_demo' });
    expect(args.some(a => String(a).startsWith('--admin_passwd'))).toBe(false);
  });

  test('帶 --proxy-mode：反代終結 TLS，Odoo 須信任 X-Forwarded-Proto 才不會產 http:// redirect 打回 400', () => {
    const args = d.buildRunArgs({ name: 'c', image: 'odoo:17', port: 8069, dbName: 'test_demo' });
    expect(args).toContain('--proxy-mode');
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
  // 意圖：逾時被我方 SIGKILL 與「指令自己非 0 結束」的 code 都可能是 null，唯一能分辨的就是這個
  // 旗標。env-agent 用它標 err.killed，deploy 才知道「重試只會再 hang 一次 10 分鐘」而直接停等人工。
  test('逾時被砍時回傳 timedOut=true（正常結束不帶此欄）', async () => {
    const neverCloses = () => {
      const ch = new EventEmitter();
      ch.stdout = new EventEmitter(); ch.stderr = new EventEmitter();
      ch.stdin = { write() {}, end() {} }; ch.kill = () => {};
      return ch; // 永不 close：模擬 odoo 升級卡住
    };
    const r = await d.runDocker(['exec', 'c1', 'odoo'], { spawnFn: neverCloses, timeoutMs: 20 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
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
  // 依序回應多次 docker 呼叫（第 1 次是 image inspect、之後是 build），並記下每次的 argv
  function scriptedSpawn(scripts, calls) {
    let i = 0;
    return (cmd, args) => {
      calls.push(args);
      return fakeSpawn(scripts[Math.min(i++, scripts.length - 1)])();
    };
  }

  test('ensureImage：相依指紋相符 → 不 build', async () => {
    const fp = d.depsFingerprint(['pyodbc', 'xlsxtpl']);
    const calls = [];
    const r = await d.ensureImage('16', '/ctx', { pipPkgs: ['xlsxtpl', 'pyodbc'] },
      { spawnFn: scriptedSpawn([{ code: 0, stdout: `${fp}|image\n` }], calls) });
    expect(r.ok).toBe(true);
    expect(r.log).toContain('已存在');
    expect(calls.some(a => a[0] === 'build')).toBe(false);
  });

  // 意圖：image 已存在就早退，會讓「改了相依清單／Dockerfile」毫無效果——同一個坑在 vpn-gateway
  // 的 entrypoint.sh 上踩過一次（九關程式碼審查全綠但實機完全無效）。判準必須是內容指紋而非存在性。
  test('ensureImage：相依清單變了（指紋不符）→ 仍會 build，且把聯集帶進 build-arg 與 label', async () => {
    const calls = [];
    const r = await d.ensureImage('16', '/ctx', { pipPkgs: ['xlsxtpl', 'pyodbc'] },
      { spawnFn: scriptedSpawn([{ code: 0, stdout: 'stale-fingerprint|image\n' }, { code: 0, stdout: 'built' }], calls) });
    expect(r.ok).toBe(true);
    const build = calls.find(a => a[0] === 'build');
    expect(build).toBeDefined();
    expect(build).toContain('PIP_PKGS=pyodbc xlsxtpl');           // 去重後排序，順序穩定才有指紋意義
    expect(build).toContain(`idx.deps=${d.depsFingerprint(['pyodbc', 'xlsxtpl'])}`);
  });

  // 意圖：某專案宣告一個裝不動的套件時，不可以變成「全平台都建不了測試區」。預裝失敗要退回現行的
  // 「容器層 pip」路徑（installModuleRequirements 照跑），但必須在 setup_log 大聲說，不得靜默降級。
  test('ensureImage：預裝相依 build 失敗 → 退回不預裝再 build 一次，回 ok 且 log 大聲說', async () => {
    const calls = [];
    const r = await d.ensureImage('16', '/ctx', { pipPkgs: ['nosuchpkg'] }, {
      spawnFn: scriptedSpawn([
        { code: 0, stdout: '|\n' },                    // image 不存在／無 label
        { code: 1, stderr: 'No matching distribution found for nosuchpkg' },
        { code: 0, stdout: 'built' },
      ], calls),
    });
    expect(r.ok).toBe(true);
    expect(r.log).toContain('退回');
    expect(r.log).toContain('nosuchpkg');              // 真因要看得到，不能只說「失敗」
    const builds = calls.filter(a => a[0] === 'build');
    expect(builds).toHaveLength(2);
    expect(builds[1]).toContain('PIP_PKGS=');          // 第二次不帶任何套件
    expect(builds[1]).toContain('idx.pip=fallback');
  });

  // 意圖：退回產生的 image 指紋一樣（否則每次建環境都要白付一次 30 分鐘 build），但使用者不能因此
  // 再也看不到警告——只要這顆 image 是退回來的，每次都要在建立記錄裡重申。
  test('ensureImage：退回產生的 image 之後每次仍在 log 警告，不因指紋相符而靜默', async () => {
    const fp = d.depsFingerprint(['nosuchpkg']);
    const calls = [];
    const r = await d.ensureImage('16', '/ctx', { pipPkgs: ['nosuchpkg'] },
      { spawnFn: scriptedSpawn([{ code: 0, stdout: `${fp}|fallback\n` }], calls) });
    expect(r.ok).toBe(true);
    expect(calls.some(a => a[0] === 'build')).toBe(false);
    expect(r.log).toContain('容器層');
  });

  // 意圖：系統套件（unixodbc／FreeTDS）寫死在 Dockerfile，pip 清單不會變。若指紋只看 pip 清單，
  // 改了 Dockerfile 就永遠不會重 build——正是 vpn-gateway entrypoint.sh 那個坑。
  test('ensureImage：只改 Dockerfile（pip 清單不變）也要重 build', async () => {
    const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'imgctx-'));
    const dfPath = path.join(ctx, 'Dockerfile.odoo');
    fs.writeFileSync(dfPath, 'FROM odoo:16\n');
    const pkgs = ['xlsxtpl'];
    const fpBefore = d.depsFingerprint(pkgs, fs.readFileSync(dfPath, 'utf8'));

    const before = [];
    await d.ensureImage('16', ctx, { pipPkgs: pkgs },
      { spawnFn: scriptedSpawn([{ code: 0, stdout: `${fpBefore}|image\n` }], before) });
    expect(before.some(a => a[0] === 'build')).toBe(false); // 沒動任何東西 → 不 build

    fs.writeFileSync(dfPath, 'FROM odoo:16\nRUN apt-get install -y unixodbc\n');
    const after = [];
    await d.ensureImage('16', ctx, { pipPkgs: pkgs },
      { spawnFn: scriptedSpawn([{ code: 0, stdout: `${fpBefore}|image\n` }, { code: 0, stdout: 'built' }], after) });
    expect(after.some(a => a[0] === 'build')).toBe(true);
  });

  test('ensureImage：兩次 build 都失敗 → ok:false，帶出第一次（有預裝）的真因', async () => {
    const calls = [];
    const r = await d.ensureImage('16', '/ctx', { pipPkgs: ['nosuchpkg'] }, {
      spawnFn: scriptedSpawn([
        { code: 0, stdout: '|\n' },
        { code: 1, stderr: 'No matching distribution found for nosuchpkg' },
        { code: 1, stderr: 'apt-get update failed' },
      ], calls),
    });
    expect(r.ok).toBe(false);
    expect(r.log).toContain('nosuchpkg');
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

  // 刪除環境目錄：Odoo 在容器內以 image 的 odoo user（uid 101）寫 filestore，產出的樹平台無權刪。
  // 正式機因此每個跑過的測試區都刪不掉——stopEnv 已收掉容器與 port、DB 標回 idle，卻在最後 500，
  // 留下孤兒 filestore 佔磁碟且狀態不一致。以下把「退到 root 容器」與「不准靜默成功」鎖死。
  function eaccesFs(gone = { yes: false }) {
    return {
      existsSync: () => !gone.yes,
      rmSync: () => { throw Object.assign(new Error('permission denied, rmdir'), { code: 'EACCES' }); },
    };
  }
  test('buildRootRmArgs：掛 parent 進容器（掛目錄本身只會清空內容、刪不掉掛載點）', () => {
    expect(d.buildRootRmArgs('/envs/proj1', 'alpine:3'))
      .toEqual(['run', '--rm', '-v', '/envs:/target', 'alpine:3', 'rm', '-rf', '/target/proj1']);
  });
  test('removeDirForce：一般情形直接 rmSync，不動用 docker', async () => {
    let spawned = false;
    const r = await d.removeDirForce('/envs/p', {
      fs: { existsSync: () => true, rmSync: () => {} },
      spawnFn: () => { spawned = true; return fakeSpawn({ code: 0 })(); },
    });
    expect(r).toEqual({ removed: true, viaDocker: false });
    expect(spawned).toBe(false);
  });
  test('removeDirForce：EACCES 退到 root 容器刪，刪的是 /target/<basename>', async () => {
    const gone = { yes: false };
    const cap = {};
    const r = await d.removeDirForce('/envs/p', {
      fs: eaccesFs(gone),
      spawnFn: (cmd, args) => { cap.cmd = cmd; cap.args = args; gone.yes = true; return fakeSpawn({ code: 0 })(); },
    });
    expect(r).toEqual({ removed: true, viaDocker: true });
    expect(cap.cmd).toBe('docker');
    expect(cap.args.slice(0, 4)).toEqual(['run', '--rm', '-v', '/envs:/target']);
    expect(cap.args).toContain('/target/p');
  });
  test('removeDirForce：root 容器退路失敗 → throw（靜默吞掉會讓 DB 標 idle 但目錄還在）', async () => {
    await expect(d.removeDirForce('/envs/p', {
      fs: eaccesFs(), spawnFn: fakeSpawn({ code: 1, stderr: 'Unable to find image' }),
    })).rejects.toThrow('Unable to find image');
  });
  test('removeDirForce：docker 回 0 但目錄仍在 → 一樣 throw，不當成刪掉', async () => {
    await expect(d.removeDirForce('/envs/p', {
      fs: eaccesFs(), spawnFn: fakeSpawn({ code: 0 }),
    })).rejects.toThrow('目錄仍然存在');
  });
  test('removeDirForce：非權限錯誤原樣拋出，不被 root 容器掩蓋成另一種故障', async () => {
    let spawned = false;
    await expect(d.removeDirForce('/envs/p', {
      fs: { existsSync: () => true, rmSync: () => { throw Object.assign(new Error('device busy'), { code: 'EBUSY' }); } },
      spawnFn: () => { spawned = true; return fakeSpawn({ code: 0 })(); },
    })).rejects.toThrow('device busy');
    expect(spawned).toBe(false);
  });
  test('removeDirForce：目錄本來就不存在 → no-op', async () => {
    expect(await d.removeDirForce('/envs/gone', { fs: { existsSync: () => false } }))
      .toEqual({ removed: false, viaDocker: false });
  });
});
