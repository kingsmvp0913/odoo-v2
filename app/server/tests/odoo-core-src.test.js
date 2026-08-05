// odoo-core-src：核心 addons 解壓＋資料來源守則。docker／fs 全 mock，不碰真 docker。
jest.mock('child_process');
jest.mock('fs');

const fs = require('fs');
const { execFileSync } = require('child_process');
const { ensureOdooCoreSrc, coreSourceGuidance, majorOf } = require('../lib/odoo-core-src');

beforeEach(() => {
  jest.clearAllMocks();
  // fs 寫入類一律 no-op（回 undefined 即可）
  fs.mkdirSync.mockReturnValue(undefined);
  fs.rmSync.mockReturnValue(undefined);
  fs.renameSync.mockReturnValue(undefined);
  fs.writeFileSync.mockReturnValue(undefined);
});

describe('majorOf（複用 docker-env.majorDigits，與 env-agent 同一套，不寫死 17）', () => {
  test('各大版本都能取（13～20+）', () => {
    expect(majorOf('13.0')).toBe('13');
    expect(majorOf('17.0')).toBe('17');
    expect(majorOf('19.0.1.2')).toBe('19');
    expect(majorOf('20.0')).toBe('20');
    expect(majorOf('saas~17')).toBe('17');   // 與 env-agent 正規化一致 → 對到同一個 image
  });
  test('空／無數字版本 → 空字串（讓呼叫端退回 Context7）', () => {
    expect(majorOf('')).toBe('');
    expect(majorOf(null)).toBe('');
    expect(majorOf('odoo')).toBe('');
  });
});

describe('ensureOdooCoreSrc', () => {
  test('marker＋addons 都在 → 直接回路徑，不呼叫 docker（快取命中）', () => {
    fs.existsSync.mockReturnValue(true);
    const dir = ensureOdooCoreSrc('17.0');
    expect(dir).toMatch(/[\\/]17[\\/]addons$/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  test('未解過 → docker create+cp+rm，回 addons 路徑並寫 marker（版本帶入 image tag，非寫死 17）', () => {
    fs.existsSync.mockReturnValue(false);          // marker 不在 → 需解壓
    execFileSync.mockImplementation((cmd, args) => {
      if (args[0] === 'create') return 'container-abc\n'; // cid
      return '';                                          // cp / rm
    });
    const dir = ensureOdooCoreSrc('19.0');
    expect(dir).toMatch(/[\\/]19[\\/]addons$/);
    // 用了對應版本 image（odoo-idx:19），且有寫 marker
    expect(execFileSync).toHaveBeenCalledWith('docker', ['create', 'odoo-idx:19'], expect.anything());
    expect(fs.writeFileSync).toHaveBeenCalled();
    // 有清掉暫存容器（rm -f cid）
    expect(execFileSync).toHaveBeenCalledWith('docker', ['rm', '-f', 'container-abc'], expect.anything());
  });

  test('docker create 失敗 → 回空字串，不 throw（不擋 pipeline）', () => {
    fs.existsSync.mockReturnValue(false);
    execFileSync.mockImplementation(() => { throw new Error('Cannot connect to the Docker daemon'); });
    expect(ensureOdooCoreSrc('17.0')).toBe('');
  });

  test('無數字版本 → 空字串，完全不碰 docker', () => {
    expect(ensureOdooCoreSrc('odoo')).toBe('');
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe('coreSourceGuidance', () => {
  test('取得核心 → 守則含唯讀路徑、教先 Grep、Context7 退為補充', () => {
    fs.existsSync.mockReturnValue(true);           // 快取命中回路徑
    const g = coreSourceGuidance('17.0');
    expect(g).toMatch(/[\\/]17[\\/]addons/);       // 帶出實際路徑
    expect(g).toContain('唯讀');
    expect(g).toContain('先在這裡 Grep');
    expect(g).toContain('Context7');               // 仍保留為補充
  });

  test('取不到核心 → 退回既有安全行為（只用 Context7＋嚴禁掃碟）', () => {
    const g = coreSourceGuidance('');              // 版本空 → ensure 回 ''
    expect(g).toContain('只用 Context7 MCP');
    expect(g).toContain('嚴禁');
    expect(g).not.toMatch(/先在這裡 Grep/);
  });
});
