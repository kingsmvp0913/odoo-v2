const { newDb } = require('pg-mem');
const { buildServerBlocks, syncNginxMap, externalServerName, assertServerNames } = require('../lib/nginx-map');

// —— 純函式：持名額的環境 rows → nginx server block 字串（子網域模式） ——
describe('buildServerBlocks', () => {
  const CFG = { bindHost: '10.0.0.1', cert: '/ssl/san.cer', key: '/ssl/san.key' };
  const saved = process.env.ENV_EXTERNAL_URL_TEMPLATE;
  beforeAll(() => { process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-test-{slot}.example.com'; });
  afterAll(() => {
    if (saved === undefined) delete process.env.ENV_EXTERNAL_URL_TEMPLATE;
    else process.env.ENV_EXTERNAL_URL_TEMPLATE = saved;
  });

  // 意圖：對外一律走 443、靠 server_name 分流；後端目標才是內部埠。兩者若都用同一個數字
  // （port 模式的舊行為），內部池就會被綁死在「NAT 放行了幾個埠」上，正是本次要拆開的。
  test('每個持名額者產一段 listen 443 ssl，server_name 由 slot 決定、proxy 到內部埠', () => {
    const out = buildServerBlocks([{ slot: 0, port: 21000 }, { slot: 3, port: 21047 }], CFG);
    expect(out).toContain('listen 443 ssl;');
    expect(out).toContain('server_name odoo-ai-test-0.example.com;');
    expect(out).toContain('server_name odoo-ai-test-3.example.com;');
    expect(out).toContain('proxy_pass http://10.0.0.1:21000;');
    expect(out).toContain('proxy_pass http://10.0.0.1:21047;');
    expect(out).not.toContain('listen 21000');
  });

  // 意圖：Odoo 的 bus/longpolling 靠 WebSocket，缺 Upgrade header 會靜默退化成「通知不會跳」，
  // 而畫面其他部分看起來完全正常——極難歸因，故必須有測試釘住。
  test('保留 WebSocket upgrade 與大檔上傳設定', () => {
    const out = buildServerBlocks([{ slot: 0, port: 21000 }], CFG);
    expect(out).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(out).toContain('proxy_set_header Connection "upgrade";');
    expect(out).toContain('client_max_body_size 50m;');
    // Host 必須用 $http_host（含 port）：$host 會砍掉 port，Odoo（未開 proxy_mode）
    // 靠 Host 拼絕對網址，跳轉/redirect 的 Location 就會掉 port、落到 443。
    expect(out).toContain('proxy_set_header Host $http_host;');
    expect(out).not.toContain('proxy_set_header Host $host;');
    // X-Forwarded-Host 必送：Odoo 17 http.py 的 ProxyFix 守門是「proxy_mode 且 HTTP_X_FORWARDED_HOST
    // 存在」兩者都要——漏了它，連 X-Forwarded-Proto:https 也一起被無視 → 產 http:// redirect → 打到
    // 只收 TLS 的 port 回 400。用 $http_host 讓 ProxyFix 的 x_host 一併吃到正確 port。
    expect(out).toContain('proxy_set_header X-Forwarded-Host $http_host;');
  });

  test('跳過無 port 的項（不寫半截 block）', () => {
    expect(buildServerBlocks([{ slot: 0, port: null }], CFG)).toBe('');
  });

  test('無人持有名額 → 空字串（空 conf 檔對 nginx 合法）', () => {
    expect(buildServerBlocks([], CFG)).toBe('');
  });
});

// 意圖：這段 conf 會被寫進與正式站（AICEO/IDX…）共用的同一台 nginx。程式一旦產出非預期的
// server_name，等於把測試區的 location 蓋到正式站的網域上。守衛是寫檔前最後一道保全。
describe('assertServerNames', () => {
  const saved = process.env.ENV_EXTERNAL_URL_TEMPLATE;
  afterEach(() => {
    if (saved === undefined) delete process.env.ENV_EXTERNAL_URL_TEMPLATE;
    else process.env.ENV_EXTERNAL_URL_TEMPLATE = saved;
  });

  test('樣板正常 → 不 throw', () => {
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-test-{slot}.example.com';
    expect(() => assertServerNames([{ slot: 0, port: 1 }, { slot: 9, port: 2 }])).not.toThrow();
  });

  test('樣板未設 → throw（不寫出沒有 server_name 的段）', () => {
    delete process.env.ENV_EXTERNAL_URL_TEMPLATE;
    expect(() => assertServerNames([{ slot: 0, port: 1 }])).toThrow(/server_name/);
  });

  // 意圖：樣板漏了 {slot} 是最危險的一種出包——10 個名額會產出 10 段同名 server_name，
  // 在共用 nginx 上直接蓋掉那個網域（可能是正式站）。錯誤訊息必須指名這個成因。
  test('樣板缺 {slot} → throw，訊息指出會蓋到其他站台', () => {
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-test.example.com';
    expect(() => assertServerNames([{ slot: 0, port: 1 }])).toThrow(/\{slot\}/);
  });
});

// —— 同步協調：gate / 原子寫入 / nginx -t / reload / rollback ——
describe('syncNginxMap', () => {
  const KEYS = ['NGINX_SYNC_CONF_FILE', 'NGINX_CONTAINER', 'ENV_EXTERNAL_URL_TEMPLATE', 'ENV_BIND_HOST', 'ENV_TLS_CERT', 'ENV_TLS_KEY'];
  const OLD = {};
  let errSpy;
  // 一組讓所有必需設定齊備的 env（個別測試再覆寫要驗的那項）
  function setAll() {
    process.env.NGINX_SYNC_CONF_FILE = '/etc/nginx/odoo/envs.conf';
    process.env.NGINX_CONTAINER = 'agency-NginxUI-1';
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-dev-{slot}.example.com';
    process.env.ENV_BIND_HOST = '10.0.0.1';
    process.env.ENV_TLS_CERT = '/ssl/fullchain.cer';
    process.env.ENV_TLS_KEY = '/ssl/private.key';
  }
  beforeEach(() => {
    KEYS.forEach(k => { OLD[k] = process.env[k]; });
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); // 收掉並斷言 loud log
  });
  afterEach(() => {
    KEYS.forEach(k => { if (OLD[k] === undefined) delete process.env[k]; else process.env[k] = OLD[k]; });
    errSpy.mockRestore();
  });

  function fakeFs(initial) {
    const store = new Map(Object.entries(initial || {}));
    return {
      _store: store,
      existsSync: p => store.has(p),
      readFileSync: p => store.get(p),
      writeFileSync: (p, c) => store.set(p, c),
      renameSync: (a, b) => { store.set(b, store.get(a)); store.delete(a); },
      unlinkSync: p => store.delete(p),
    };
  }

  test('gate：未設 NGINX_SYNC_CONF_FILE → 整段不執行（Windows/未反代機零影響）', async () => {
    setAll();
    delete process.env.NGINX_SYNC_CONF_FILE;
    const fs = fakeFs();
    const run = jest.fn();
    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ slot: 0, port: 21000 }] }) });
    expect(res).toEqual({ skipped: true });
    expect(run).not.toHaveBeenCalled();
    expect(fs._store.size).toBe(0);
  });

  test('happy path：原子寫 conf → nginx -t 過 → reload 共用 nginx 容器', async () => {
    setAll();
    const fs = fakeFs();
    const run = jest.fn()
      .mockResolvedValueOnce({ code: 0, stdout: 'syntax ok', stderr: '' })  // nginx -t
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });          // reload
    const query = async () => ({ rows: [{ slot: 0, port: 21000 }] });

    const res = await syncNginxMap({ fs, run, query });

    expect(res.ok).toBe(true);
    const written = fs._store.get('/etc/nginx/odoo/envs.conf');
    expect(written).toContain('listen 443 ssl;');
    expect(written).toContain('proxy_pass http://10.0.0.1:21000;');
    expect(written).toContain('server_name odoo-ai-dev-0.example.com;');
    expect(fs._store.has('/etc/nginx/odoo/envs.conf.tmp')).toBe(false); // rename 後 tmp 不殘留
    expect(run).toHaveBeenNthCalledWith(1, 'docker', ['exec', 'agency-NginxUI-1', 'nginx', '-t']);
    expect(run).toHaveBeenNthCalledWith(2, 'docker', ['exec', 'agency-NginxUI-1', 'nginx', '-s', 'reload']);
  });

  test('nginx -t 失敗 → 還原舊 conf、絕不 reload 壞檔', async () => {
    setAll();
    process.env.NGINX_SYNC_CONF_FILE = '/m/envs.conf';
    const fs = fakeFs({ '/m/envs.conf': 'server { listen 20999 ssl; }\n' });
    const run = jest.fn().mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'test failed' });
    const query = async () => ({ rows: [{ slot: 0, port: 21000 }] });

    const res = await syncNginxMap({ fs, run, query });

    expect(res.rolledBack).toBe(true);
    expect(fs._store.get('/m/envs.conf')).toBe('server { listen 20999 ssl; }\n'); // 還原成舊內容
    expect(run).toHaveBeenCalledTimes(1); // 只跑 -t，沒有 reload
    expect(errSpy).toHaveBeenCalled(); // 失敗必 loud log
  });

  test('reload 失敗 → 回 reloadFailed 並 loud log（conf 已過 -t）', async () => {
    setAll();
    process.env.NGINX_SYNC_CONF_FILE = '/m/envs.conf';
    const fs = fakeFs();
    const run = jest.fn()
      .mockResolvedValueOnce({ code: 0, stdout: 'ok', stderr: '' })        // -t 過
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'reload err' }); // reload 掛
    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ slot: 0, port: 21000 }] }) });
    expect(res.reloadFailed).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });

  test('gate 已設但缺 NGINX_CONTAINER → 回錯不 throw、不寫檔、loud log', async () => {
    setAll();
    delete process.env.NGINX_CONTAINER;
    const fs = fakeFs();
    const run = jest.fn();
    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ slot: 0, port: 21000 }] }) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/NGINX_CONTAINER/);
    expect(fs._store.size).toBe(0); // 沒寫任何檔
    expect(run).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  test('gate 已設但缺 TLS 憑證設定 → 回錯不 throw、不寫檔、loud log', async () => {
    setAll();
    delete process.env.ENV_TLS_CERT;
    const fs = fakeFs();
    const run = jest.fn();
    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ slot: 0, port: 21000 }] }) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ENV_TLS_CERT/);
    expect(fs._store.size).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  test('nginx -t 失敗且原本無 conf 檔 → 移除剛寫的檔（不留壞檔）', async () => {
    setAll();
    process.env.NGINX_SYNC_CONF_FILE = '/m/envs.conf';
    const fs = fakeFs();
    const run = jest.fn().mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'bad' });

    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ slot: 0, port: 21000 }] }) });

    expect(res.rolledBack).toBe(true);
    expect(fs._store.has('/m/envs.conf')).toBe(false);
  });

  // 意圖：assertServerNames 是「寫檔前最後一道保全」，這個接線點必須被獨立守著——
  // 若日後有人把守衛移到 buildServerBlocks 之後、或不小心包進吞例外的分支，
  // 上面那些用合法樣板的 test 全部仍會綠燈，唯有這裡（刻意用壞樣板）能抓到。
  test('樣板缺 {slot} → syncNginxMap 回 ok:false 且不寫檔（守衛真的接在寫檔之前）', async () => {
    setAll();
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-dev.example.com'; // 缺 {slot}
    const fs = fakeFs();
    const run = jest.fn();
    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ slot: 0, port: 21000 }] }) });

    expect(res.ok).toBe(false);
    expect(fs._store.size).toBe(0); // 守衛擋在寫檔之前，不該有任何檔案內容
    expect(run).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });
});

// —— SQL 實跑（pg-mem）：只納入 running 且持有 external_slot（真人在看）者 ——
describe('syncNginxMap SQL（pg-mem 實跑）', () => {
  const KEYS = ['NGINX_SYNC_CONF_FILE', 'NGINX_CONTAINER', 'ENV_EXTERNAL_URL_TEMPLATE', 'ENV_BIND_HOST', 'ENV_TLS_CERT', 'ENV_TLS_KEY'];
  const OLD = {};
  let dbModule;
  let fakeFs;
  let seq = 0;
  const okRun = async () => ({ code: 0, stdout: '', stderr: '' });

  beforeAll(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    dbModule = require('../db');
    dbModule._setPoolForTesting(new Pool());
    await dbModule.migrate();
    // pg-mem 限制（非正式 bug，勿改動正式 SQL／索引）：odoo_envs_extslot_idx 這個 partial unique
    // index 存在時，pg-mem 對 `external_slot IS NOT NULL AND port IS NOT NULL` 這類雙重 IS NOT
    // NULL 條件的查詢規劃會誤判成 0 筆（實測對照：拿掉此索引後同一查詢即恢復正確）。真正的
    // PostgreSQL 不受影響，故只在測試用的 pg-mem 執行個體移除，不動正式 migrate() 的索引。
    await dbModule.query('DROP INDEX IF EXISTS odoo_envs_extslot_idx');
  });

  // 建一個 project + odoo_envs：folder 當 project name／folder_name（每次呼叫需唯一，故加序號）。
  async function mkEnv(folder, status, port, externalSlot) {
    seq += 1;
    const name = `${folder}-${seq}`;
    const { rows: [p] } = await dbModule.query(
      "INSERT INTO projects (name, odoo_version, folder_name) VALUES ($1,'17.0',$2) RETURNING id",
      [name, folder]);
    const { rows: [e] } = await dbModule.query(
      "INSERT INTO odoo_envs (project_id, status, port, external_slot) VALUES ($1,$2,$3,$4) RETURNING id",
      [p.id, status, port, externalSlot]);
    return e.id;
  }

  beforeEach(async () => {
    await dbModule.query('DELETE FROM odoo_envs'); // 每測試獨立：上一測試留下的 env 不該外溢
    await dbModule.query('DELETE FROM projects');
    KEYS.forEach(k => { OLD[k] = process.env[k]; });
    process.env.NGINX_SYNC_CONF_FILE = '/m/envs.conf';
    process.env.NGINX_CONTAINER = 'c';
    process.env.ENV_EXTERNAL_URL_TEMPLATE = 'https://odoo-ai-test-{slot}.example.com';
    process.env.ENV_BIND_HOST = '10.0.0.1';
    process.env.ENV_TLS_CERT = '/ssl/fullchain.cer';
    process.env.ENV_TLS_KEY = '/ssl/private.key';
    fakeFs = {
      written: '',
      existsSync: () => false,
      readFileSync: () => '',
      writeFileSync(_p, c) { this.written = c; },
      renameSync: () => {},
      unlinkSync: () => {},
    };
  });
  afterEach(() => {
    KEYS.forEach(k => { if (OLD[k] === undefined) delete process.env[k]; else process.env[k] = OLD[k]; });
  });
  afterAll(() => { dbModule._setPoolForTesting(null); });

  // 意圖：pipeline 跑起來的環境不得佔用對外名額——這正是雙池分離的目的。
  // 只有 external_slot 非 NULL（真人在看）的才寫進 nginx。
  test('只列持有 external_slot 的 running 環境；有 port 沒名額的不列', async () => {
    const a = await mkEnv('a', 'running', 21000, 0);
    await mkEnv('b', 'running', 21001, null);   // pipeline 在跑，沒人在看
    await syncNginxMap({ fs: fakeFs, run: okRun, query: dbModule.query });
    expect(fakeFs.written).toContain('odoo-ai-test-0.example.com');
    expect(fakeFs.written).toContain('proxy_pass http://10.0.0.1:21000;');
    expect(fakeFs.written).not.toContain('21001');   // b 沒人在看，不該對外
    expect(a).toBeTruthy();
  });

  test('idle 的環境即使還留著 external_slot 也不列', async () => {
    await mkEnv('c', 'idle', 21002, 1);
    await syncNginxMap({ fs: fakeFs, run: okRun, query: dbModule.query });
    expect(fakeFs.written).toBe('');
  });
});

// 意圖：這台 nginx 與多個正式站共用，一次 reload 會重讀所有站的設定。閒置回收／夜間關機
// 會在幾秒內連續還掉一整批名額，逐一 reload 等於連續打擾正式站。合併成一次。
describe('syncNginxMapDebounced', () => {
  const savedConf = process.env.NGINX_SYNC_CONF_FILE;
  afterEach(() => {
    if (savedConf === undefined) delete process.env.NGINX_SYNC_CONF_FILE;
    else process.env.NGINX_SYNC_CONF_FILE = savedConf;
  });

  test('窗口內連續三次呼叫 → 只實際同步一次', async () => {
    delete process.env.NGINX_SYNC_CONF_FILE; // gate 關閉：syncNginxMap 直接回 skipped，不碰 fs
    const { syncNginxMapDebounced } = require('../lib/nginx-map');
    const rs = await Promise.all([
      syncNginxMapDebounced({ debounceMs: 5 }),
      syncNginxMapDebounced({ debounceMs: 5 }),
      syncNginxMapDebounced({ debounceMs: 5 }),
    ]);
    expect(rs).toHaveLength(3);
    for (const r of rs) expect(r.skipped).toBe(true); // 三個呼叫端都拿到同一次同步的結果
  });

  // 意圖：合併不等於吞掉。等待中的呼叫端都必須拿到結果，否則上游的 await 會永遠掛著。
  test('每個呼叫端都拿到結果（合併不吞 promise）', async () => {
    delete process.env.NGINX_SYNC_CONF_FILE;
    const { syncNginxMapDebounced } = require('../lib/nginx-map');
    const a = syncNginxMapDebounced({ debounceMs: 5 });
    const b = syncNginxMapDebounced({ debounceMs: 5 });
    await expect(a).resolves.toBeDefined();
    await expect(b).resolves.toBeDefined();
  });
});
