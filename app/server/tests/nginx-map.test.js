const { newDb } = require('pg-mem');
const { buildMapContent, syncNginxMap } = require('../lib/nginx-map');

// —— 純函式：DB rows → nginx map include 檔內容 ——
describe('buildMapContent', () => {
  const hostFor = f => `${f}.odoo-ai-dev.example`;

  test('每個專案一行 <host> <port>;，且含 default 444（未知 host 關連線）', () => {
    const out = buildMapContent(
      [{ folder: 'alpha', port: 21000 }, { folder: 'beta', port: 21001 }],
      hostFor
    );
    expect(out).toBe('default 444;\nalpha.odoo-ai-dev.example 21000;\nbeta.odoo-ai-dev.example 21001;\n');
  });

  test('跳過無 port 或 host 推導失敗的項（不寫出半截行）', () => {
    const out = buildMapContent(
      [{ folder: 'alpha', port: 21000 }, { folder: 'noport', port: null }, { folder: 'nohost', port: 21002 }],
      f => (f === 'nohost' ? null : `${f}.x`)
    );
    expect(out).toBe('default 444;\nalpha.x 21000;\n');
  });
});

// —— 同步協調：gate / 原子寫入 / nginx -t / reload / rollback ——
describe('syncNginxMap', () => {
  const KEYS = ['NGINX_SYNC_MAP_FILE', 'NGINX_CONTAINER', 'ENV_PUBLIC_URL_TEMPLATE'];
  const OLD = {};
  let errSpy;
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

  test('gate：未設 NGINX_SYNC_MAP_FILE → 整段不執行（Windows/未反代機零影響）', async () => {
    delete process.env.NGINX_SYNC_MAP_FILE;
    const fs = fakeFs();
    const run = jest.fn();
    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ folder: 'a', port: 1 }] }) });
    expect(res).toEqual({ skipped: true });
    expect(run).not.toHaveBeenCalled();
    expect(fs._store.size).toBe(0);
  });

  test('happy path：原子寫 map → nginx -t 過 → reload 共用 nginx 容器', async () => {
    process.env.NGINX_SYNC_MAP_FILE = '/etc/nginx/odoo/envs.map';
    process.env.NGINX_CONTAINER = 'agency-NginxUI-1';
    process.env.ENV_PUBLIC_URL_TEMPLATE = 'https://{folder}.odoo-ai-dev.example';
    const fs = fakeFs();
    const run = jest.fn()
      .mockResolvedValueOnce({ code: 0, stdout: 'syntax ok', stderr: '' })  // nginx -t
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });          // reload
    const query = async () => ({ rows: [{ folder: 'alpha', port: 21000 }] });

    const res = await syncNginxMap({ fs, run, query });

    expect(res.ok).toBe(true);
    expect(fs._store.get('/etc/nginx/odoo/envs.map'))
      .toBe('default 444;\nalpha.odoo-ai-dev.example 21000;\n');
    expect(fs._store.has('/etc/nginx/odoo/envs.map.tmp')).toBe(false); // rename 後 tmp 不殘留
    expect(run).toHaveBeenNthCalledWith(1, 'docker', ['exec', 'agency-NginxUI-1', 'nginx', '-t']);
    expect(run).toHaveBeenNthCalledWith(2, 'docker', ['exec', 'agency-NginxUI-1', 'nginx', '-s', 'reload']);
  });

  test('nginx -t 失敗 → 還原舊 map、絕不 reload 壞檔', async () => {
    process.env.NGINX_SYNC_MAP_FILE = '/m/envs.map';
    process.env.NGINX_CONTAINER = 'c';
    process.env.ENV_PUBLIC_URL_TEMPLATE = 'https://{folder}.x';
    const fs = fakeFs({ '/m/envs.map': 'default 444;\nOLD.x 20999;\n' });
    const run = jest.fn().mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'test failed' });
    const query = async () => ({ rows: [{ folder: 'newone', port: 21000 }] });

    const res = await syncNginxMap({ fs, run, query });

    expect(res.rolledBack).toBe(true);
    expect(fs._store.get('/m/envs.map')).toBe('default 444;\nOLD.x 20999;\n'); // 還原成舊內容
    expect(run).toHaveBeenCalledTimes(1); // 只跑 -t，沒有 reload
    expect(errSpy).toHaveBeenCalled(); // 失敗必 loud log
  });

  test('reload 失敗 → 回 reloadFailed 並 loud log（map 已過 -t）', async () => {
    process.env.NGINX_SYNC_MAP_FILE = '/m/envs.map';
    process.env.NGINX_CONTAINER = 'c';
    process.env.ENV_PUBLIC_URL_TEMPLATE = 'https://{folder}.x';
    const fs = fakeFs();
    const run = jest.fn()
      .mockResolvedValueOnce({ code: 0, stdout: 'ok', stderr: '' })        // -t 過
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'reload err' }); // reload 掛
    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ folder: 'a', port: 21000 }] }) });
    expect(res.reloadFailed).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });

  test('gate 已設但缺 NGINX_CONTAINER → 回錯不 throw、不寫檔、loud log', async () => {
    process.env.NGINX_SYNC_MAP_FILE = '/m/envs.map';
    delete process.env.NGINX_CONTAINER;
    process.env.ENV_PUBLIC_URL_TEMPLATE = 'https://{folder}.x';
    const fs = fakeFs();
    const run = jest.fn();
    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ folder: 'a', port: 21000 }] }) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/NGINX_CONTAINER/);
    expect(fs._store.size).toBe(0); // 沒寫任何檔
    expect(run).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  test('nginx -t 失敗且原本無 map 檔 → 移除剛寫的檔（不留壞檔）', async () => {
    process.env.NGINX_SYNC_MAP_FILE = '/m/envs.map';
    process.env.NGINX_CONTAINER = 'c';
    process.env.ENV_PUBLIC_URL_TEMPLATE = 'https://{folder}.x';
    const fs = fakeFs();
    const run = jest.fn().mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'bad' });

    const res = await syncNginxMap({ fs, run, query: async () => ({ rows: [{ folder: 'a', port: 21000 }] }) });

    expect(res.rolledBack).toBe(true);
    expect(fs._store.has('/m/envs.map')).toBe(false);
  });
});

// —— SQL 實跑（pg-mem）：只納入 running 且 projects.port 非空者 ——
describe('syncNginxMap SQL（pg-mem 實跑）', () => {
  const KEYS = ['NGINX_SYNC_MAP_FILE', 'NGINX_CONTAINER', 'ENV_PUBLIC_URL_TEMPLATE'];
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

  test('只列 running；idle 不列；folder_name 缺時退回 name', async () => {
    process.env.NGINX_SYNC_MAP_FILE = '/m/envs.map';
    process.env.NGINX_CONTAINER = 'c';
    process.env.ENV_PUBLIC_URL_TEMPLATE = 'https://{folder}.x';
    const store = new Map();
    const fs = {
      existsSync: p => store.has(p), readFileSync: p => store.get(p),
      writeFileSync: (p, c) => store.set(p, c),
      renameSync: (a, b) => { store.set(b, store.get(a)); store.delete(a); },
      unlinkSync: p => store.delete(p),
    };
    const run = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await syncNginxMap({ fs, run });

    // alpha(running) + gamma(running, folder 缺→name)；beta(idle) 不列
    expect(store.get('/m/envs.map')).toBe('default 444;\nalpha.x 21000;\ngamma.x 21002;\n');
  });
});
