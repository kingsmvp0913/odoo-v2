const { newDb } = require('pg-mem');
const { buildServerBlocks, syncNginxMap, publicHost } = require('../lib/nginx-map');

// —— 純函式：running 埠 rows → nginx server block 字串（port 模式） ——
describe('buildServerBlocks', () => {
  const cfg = {
    host: 'odoo-ai-dev.example',
    bindHost: '10.0.0.1',
    cert: '/etc/nginx/ssl/odoo-ai-dev.example/fullchain.cer',
    key: '/etc/nginx/ssl/odoo-ai-dev.example/private.key',
  };

  test('每個 running 埠產一段 listen <port> ssl，proxy 到 bindHost:同埠，共用同一張憑證', () => {
    const out = buildServerBlocks([{ port: 21000 }, { port: 21001 }], cfg);
    // 兩段 server block
    expect((out.match(/server \{/g) || []).length).toBe(2);
    // 每個埠各自 listen + proxy_pass 到 bindHost:同埠
    expect(out).toContain('listen 21000 ssl;');
    expect(out).toContain('proxy_pass http://10.0.0.1:21000;');
    expect(out).toContain('listen 21001 ssl;');
    expect(out).toContain('proxy_pass http://10.0.0.1:21001;');
    // server_name 為裸網域、憑證共用
    expect(out).toContain('server_name odoo-ai-dev.example;');
    expect(out).toContain('ssl_certificate /etc/nginx/ssl/odoo-ai-dev.example/fullchain.cer;');
    expect(out).toContain('ssl_certificate_key /etc/nginx/ssl/odoo-ai-dev.example/private.key;');
    // Odoo 需要的 websocket upgrade 標頭（缺了 bus/longpolling 靜默退化）
    expect(out).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(out).toContain('proxy_set_header Connection "upgrade";');
    // 附件不被 nginx 全域 2m 擋
    expect(out).toContain('client_max_body_size 50m;');
  });

  test('跳過無 port 的項（不寫半截 block）', () => {
    const out = buildServerBlocks([{ port: 21000 }, { port: null }, {}], cfg);
    expect((out.match(/server \{/g) || []).length).toBe(1);
    expect(out).toContain('listen 21000 ssl;');
  });

  test('無 running 者 → 空字串（空 conf 檔對 nginx 合法）', () => {
    expect(buildServerBlocks([], cfg)).toBe('');
  });
});

// —— publicHost：由對外網址樣板推導 server_name 主機名（去 port） ——
describe('publicHost', () => {
  const OLD = process.env.ENV_PUBLIC_URL_TEMPLATE;
  afterEach(() => { if (OLD === undefined) delete process.env.ENV_PUBLIC_URL_TEMPLATE; else process.env.ENV_PUBLIC_URL_TEMPLATE = OLD; });

  test('https://host:{port} → host（不含 port）', () => {
    process.env.ENV_PUBLIC_URL_TEMPLATE = 'https://odoo-ai-dev.ideaxpress.biz:{port}';
    expect(publicHost()).toBe('odoo-ai-dev.ideaxpress.biz');
  });
  test('樣板未設 → null', () => {
    delete process.env.ENV_PUBLIC_URL_TEMPLATE;
    expect(publicHost()).toBeNull();
  });
});

// —— 同步協調：gate / 原子寫入 / nginx -t / reload / rollback ——
describe('syncNginxMap', () => {
  const KEYS = ['NGINX_SYNC_CONF_FILE', 'NGINX_CONTAINER', 'ENV_PUBLIC_URL_TEMPLATE', 'ENV_BIND_HOST', 'ENV_TLS_CERT', 'ENV_TLS_KEY'];
  const OLD = {};
  let errSpy;
  // 一組讓所有必需設定齊備的 env（個別測試再覆寫要驗的那項）
  function setAll() {
    process.env.NGINX_SYNC_CONF_FILE = '/etc/nginx/odoo/envs.conf';
    process.env.NGINX_CONTAINER = 'agency-NginxUI-1';
    process.env.ENV_PUBLIC_URL_TEMPLATE = 'https://odoo-ai-dev.example:{port}';
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
    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ port: 21000 }] }) });
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
    const query = async () => ({ rows: [{ port: 21000 }] });

    const res = await syncNginxMap({ fs, run, query });

    expect(res.ok).toBe(true);
    const written = fs._store.get('/etc/nginx/odoo/envs.conf');
    expect(written).toContain('listen 21000 ssl;');
    expect(written).toContain('proxy_pass http://10.0.0.1:21000;');
    expect(written).toContain('server_name odoo-ai-dev.example;');
    expect(fs._store.has('/etc/nginx/odoo/envs.conf.tmp')).toBe(false); // rename 後 tmp 不殘留
    expect(run).toHaveBeenNthCalledWith(1, 'docker', ['exec', 'agency-NginxUI-1', 'nginx', '-t']);
    expect(run).toHaveBeenNthCalledWith(2, 'docker', ['exec', 'agency-NginxUI-1', 'nginx', '-s', 'reload']);
  });

  test('nginx -t 失敗 → 還原舊 conf、絕不 reload 壞檔', async () => {
    setAll();
    process.env.NGINX_SYNC_CONF_FILE = '/m/envs.conf';
    const fs = fakeFs({ '/m/envs.conf': 'server { listen 20999 ssl; }\n' });
    const run = jest.fn().mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'test failed' });
    const query = async () => ({ rows: [{ port: 21000 }] });

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
    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ port: 21000 }] }) });
    expect(res.reloadFailed).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });

  test('gate 已設但缺 NGINX_CONTAINER → 回錯不 throw、不寫檔、loud log', async () => {
    setAll();
    delete process.env.NGINX_CONTAINER;
    const fs = fakeFs();
    const run = jest.fn();
    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ port: 21000 }] }) });
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
    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ port: 21000 }] }) });
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

    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ port: 21000 }] }) });

    expect(res.rolledBack).toBe(true);
    expect(fs._store.has('/m/envs.conf')).toBe(false);
  });
});

// —— SQL 實跑（pg-mem）：只納入 running 且 projects.port 非空者 ——
describe('syncNginxMap SQL（pg-mem 實跑）', () => {
  const KEYS = ['NGINX_SYNC_CONF_FILE', 'NGINX_CONTAINER', 'ENV_PUBLIC_URL_TEMPLATE', 'ENV_BIND_HOST', 'ENV_TLS_CERT', 'ENV_TLS_KEY'];
  const OLD = {};
  let dbModule;

  beforeAll(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    dbModule = require('../db');
    dbModule._setPoolForTesting(new Pool());
    await dbModule.migrate();

    const { rows: [p1] } = await dbModule.query(
      "INSERT INTO projects (name, odoo_version, folder_name, port) VALUES ('P1','17.0','alpha',21000) RETURNING id");
    await dbModule.query("INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,'running',21000)", [p1.id]);

    const { rows: [p2] } = await dbModule.query(
      "INSERT INTO projects (name, odoo_version, folder_name, port) VALUES ('P2','17.0','beta',21001) RETURNING id");
    await dbModule.query("INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,'idle',21001)", [p2.id]);

    const { rows: [p3] } = await dbModule.query(
      "INSERT INTO projects (name, odoo_version, port) VALUES ('gamma','17.0',21002) RETURNING id");
    await dbModule.query("INSERT INTO odoo_envs (project_id, status, port) VALUES ($1,'running',21002)", [p3.id]);
  });

  beforeEach(() => { KEYS.forEach(k => { OLD[k] = process.env[k]; }); });
  afterEach(() => {
    KEYS.forEach(k => { if (OLD[k] === undefined) delete process.env[k]; else process.env[k] = OLD[k]; });
  });
  afterAll(() => { dbModule._setPoolForTesting(null); });

  test('只列 running 的埠；idle 不列', async () => {
    process.env.NGINX_SYNC_CONF_FILE = '/m/envs.conf';
    process.env.NGINX_CONTAINER = 'c';
    process.env.ENV_PUBLIC_URL_TEMPLATE = 'https://odoo-ai-dev.example:{port}';
    process.env.ENV_BIND_HOST = '10.0.0.1';
    process.env.ENV_TLS_CERT = '/ssl/fullchain.cer';
    process.env.ENV_TLS_KEY = '/ssl/private.key';
    const store = new Map();
    const fs = {
      existsSync: p => store.has(p), readFileSync: p => store.get(p),
      writeFileSync: (p, c) => store.set(p, c),
      renameSync: (a, b) => { store.set(b, store.get(a)); store.delete(a); },
      unlinkSync: p => store.delete(p),
    };
    const run = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await syncNginxMap({ fs, run });

    const written = store.get('/m/envs.conf');
    // alpha(running,21000) + gamma(running,21002) 各一段；beta(idle,21001) 不列
    expect((written.match(/server \{/g) || []).length).toBe(2);
    expect(written).toContain('listen 21000 ssl;');
    expect(written).toContain('listen 21002 ssl;');
    expect(written).not.toContain('listen 21001 ssl;');
  });
});
