// app/server/tests/setup-config.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureConfig, randomSecret } = require('../../../scripts/lib/config');

describe('randomSecret', () => {
  test('回傳非空 base64 字串，每次呼叫不同', () => {
    const a = randomSecret();
    const b = randomSecret();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe('ensureConfig', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-config-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('既有 config 已含 APP_SECRET/JWT_SECRET 時原樣回傳，不呼叫 ask()', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    const existing = { DATABASE_URL: 'postgres://a:b@localhost:5432/aidev', JWT_SECRET: 'jwt123', APP_SECRET: 'app123', PORT: 3939 };
    fs.writeFileSync(configPath, JSON.stringify(existing));
    const ask = jest.fn();

    const cfg = await ensureConfig(configPath, ask);

    expect(cfg).toEqual(existing);
    expect(ask).not.toHaveBeenCalled();
  });

  test('既有 config 缺 APP_SECRET 時補產，且不動其他欄位', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    const existing = { DATABASE_URL: 'postgres://a:b@localhost:5432/aidev', JWT_SECRET: 'jwt123', PORT: 3939 };
    fs.writeFileSync(configPath, JSON.stringify(existing));
    const ask = jest.fn();

    const cfg = await ensureConfig(configPath, ask);

    expect(cfg.DATABASE_URL).toBe(existing.DATABASE_URL);
    expect(cfg.JWT_SECRET).toBe('jwt123');
    expect(cfg.PORT).toBe(3939);
    expect(typeof cfg.APP_SECRET).toBe('string');
    expect(cfg.APP_SECRET.length).toBeGreaterThan(0);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(onDisk.APP_SECRET).toBe(cfg.APP_SECRET);
  });

  test('config 不存在時，用 ask() 收集輸入並寫檔（略過選填 API key）', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    const answers = { PG_HOST: 'localhost', PG_PORT: '5432', PG_DB: 'aidev', PG_USER: 'alice', PG_PASSWORD: 'pw', ANTHROPIC_API_KEY: '' };
    const ask = jest.fn((name) => Promise.resolve(answers[name]));

    const cfg = await ensureConfig(configPath, ask);

    expect(cfg.DATABASE_URL).toBe('postgres://alice:pw@localhost:5432/aidev');
    expect(cfg.PORT).toBe(3939);
    expect(typeof cfg.JWT_SECRET).toBe('string');
    expect(typeof cfg.APP_SECRET).toBe('string');
    expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
    expect(fs.existsSync(configPath)).toBe(true);
  });

  test('PG_USER 留白時套用預設值 aidev，避免產生不合法的空 user DATABASE_URL', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    // 模擬使用者一路 Enter：ask() 收到空輸入時回傳呼叫方給的 defaultValue
    const ask = jest.fn((name, def) => Promise.resolve(def));

    const cfg = await ensureConfig(configPath, ask);

    expect(cfg.DATABASE_URL).toBe('postgres://aidev:@localhost:5432/aidev');
    // parseDatabaseUrl 的 IDENT_RE 會擋掉空 user；預設帶 aidev 才不會中止安裝
    const { parseDatabaseUrl } = require('../../../scripts/lib/postgres');
    expect(() => parseDatabaseUrl(cfg.DATABASE_URL)).not.toThrow();
  });

  test('config 不存在且填了 ANTHROPIC_API_KEY 時會寫入該欄位', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    const answers = { PG_HOST: 'localhost', PG_PORT: '5432', PG_DB: 'aidev', PG_USER: 'alice', PG_PASSWORD: 'pw', ANTHROPIC_API_KEY: 'sk-ant-xxx' };
    const ask = jest.fn((name) => Promise.resolve(answers[name]));

    const cfg = await ensureConfig(configPath, ask);

    expect(cfg.ANTHROPIC_API_KEY).toBe('sk-ant-xxx');
  });
});
