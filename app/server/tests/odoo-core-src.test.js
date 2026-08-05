// odoo-core-src：核心 addons 解壓＋資料來源守則。docker／fs 全 mock，不碰真 docker。
jest.mock('child_process');
jest.mock('fs');

const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const { ensureOdooCoreSrc, coreSourceGuidance, majorOf } = require('../lib/odoo-core-src');

// callback 式 execFile 的腳本：依 args 回 stdout，impl 丟錯即等同 docker 失敗
function mockDocker(impl) {
  execFile.mockImplementation((cmd, args, opts, cb) => {
    try { cb(null, impl(args), ''); } catch (e) { cb(e, '', ''); }
  });
}

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

// 各案例刻意用不同大版本：失敗冷卻與 in-flight 是模組層狀態，共用版本會跨 test 互相干擾（testing.md #21）
describe('ensureOdooCoreSrc', () => {
  test('marker＋addons 都在 → 直接回路徑，不呼叫 docker（快取命中）', async () => {
    fs.existsSync.mockReturnValue(true);
    await expect(ensureOdooCoreSrc('17.0')).resolves.toMatch(/[\\/]17[\\/]addons$/);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('未解過 → docker create+cp+rm，回 addons 路徑並寫 marker（版本帶入 image tag，非寫死 17）', async () => {
    fs.existsSync.mockReturnValue(false);          // marker 不在 → 需解壓
    mockDocker(args => (args[0] === 'create' ? 'container-abc\n' : ''));
    const dir = await ensureOdooCoreSrc('19.0');
    expect(dir).toMatch(/[\\/]19[\\/]addons$/);
    // 用了對應版本 image（odoo-idx:19），且有寫 marker
    expect(execFile).toHaveBeenCalledWith('docker', ['create', 'odoo-idx:19'], expect.anything(), expect.any(Function));
    expect(fs.writeFileSync).toHaveBeenCalled();
    // 有清掉暫存容器（rm -f cid）
    expect(execFile).toHaveBeenCalledWith('docker', ['rm', '-f', 'container-abc'], expect.anything(), expect.any(Function));
  });

  // 意圖：image 內核心 addons 的路徑只有 docker-env 一份真相（可用 ODOO_IMAGE_CORE_ADDONS 覆寫）。
  // 這裡另抄一份字面值的話，改了那個 env var 會變成 env-agent 正常、解壓卻靜默失敗回退。
  // 用 env 覆寫成非預設值才有鑑別力：比對「與 docker-env 相同」的話，抄一份字面值也會通過（testing.md #18）
  test('cp 的來源路徑取自 docker-env.CORE_ADDONS，不是自己抄一份', async () => {
    const prev = process.env.ODOO_IMAGE_CORE_ADDONS;
    process.env.ODOO_IMAGE_CORE_ADDONS = '/custom/core/addons';
    try {
      let core, cp;   // docker-env 在載入時讀 env → 要連 odoo-core-src 一起重載才吃得到覆寫
      jest.isolateModules(() => { core = require('../lib/odoo-core-src'); cp = require('child_process'); });
      cp.execFile.mockImplementation((cmd, args, opts, cb) => cb(null, args[0] === 'create' ? 'cid-1' : '', ''));
      await core.ensureOdooCoreSrc('16.0');
      const cpCall = cp.execFile.mock.calls.find(c => c[1][0] === 'cp');
      expect(cpCall[1][1]).toBe('cid-1:/custom/core/addons');
    } finally {
      if (prev === undefined) delete process.env.ODOO_IMAGE_CORE_ADDONS;
      else process.env.ODOO_IMAGE_CORE_ADDONS = prev;
    }
  });

  test('docker create 失敗 → 回空字串，不 throw（不擋 pipeline）', async () => {
    fs.existsSync.mockReturnValue(false);
    mockDocker(() => { throw new Error('Cannot connect to the Docker daemon'); });
    await expect(ensureOdooCoreSrc('15.0')).resolves.toBe('');
  });

  // 意圖：docker 沒開／image 還沒建時，六個關卡的 prompt build 會一路撞同一個錯。
  // 沒有冷卻就是每關重敲一次 docker（daemon 卡住時每次可拖到 60s timeout）。
  test('失敗後冷卻期內不再敲 docker', async () => {
    fs.existsSync.mockReturnValue(false);
    mockDocker(() => { throw new Error('daemon down'); });
    await ensureOdooCoreSrc('14.0');
    const afterFirst = execFile.mock.calls.length;
    await ensureOdooCoreSrc('14.0');
    expect(execFile.mock.calls.length).toBe(afterFirst);
  });

  // 意圖：同版本被多關同時要到時只該解壓一次，否則兩份 docker cp 會互相 rm／rename 對方的目錄。
  test('同版本並行呼叫共用同一份解壓', async () => {
    fs.existsSync.mockReturnValue(false);
    mockDocker(args => (args[0] === 'create' ? 'cid-par' : ''));
    const [a, b] = await Promise.all([ensureOdooCoreSrc('18.0'), ensureOdooCoreSrc('18.0')]);
    expect(a).toBe(b);
    expect(execFile.mock.calls.filter(c => c[1][0] === 'create')).toHaveLength(1);
  });

  test('無數字版本 → 空字串，完全不碰 docker', async () => {
    await expect(ensureOdooCoreSrc('odoo')).resolves.toBe('');
    expect(execFile).not.toHaveBeenCalled();
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
    const g = coreSourceGuidance('');              // 版本空 → 快取查不到
    expect(g).toContain('只用 Context7 MCP');
    expect(g).toContain('嚴禁');
    expect(g).not.toMatch(/先在這裡 Grep/);
  });

  // 意圖：這支跑在「組 prompt」的同步路徑上、被六個關卡呼叫。任何同步 docker 呼叫都會凍住整個
  // Node 事件迴圈＝全平台一起卡死（見 1e721aa7：vpn-gateway 的 execFileSync 讓一次查詢凍住平台數分鐘）。
  test('快取落空時不做任何同步 docker 呼叫，改在背景解壓', () => {
    fs.existsSync.mockReturnValue(false);
    mockDocker(args => (args[0] === 'create' ? 'cid-bg' : ''));
    const g = coreSourceGuidance('20.0');
    expect(execFileSync).not.toHaveBeenCalled();   // 絕不同步阻塞
    expect(execFile).toHaveBeenCalled();           // 但背景解壓有啟動，下一關就有得用
    expect(g).toContain('只用 Context7 MCP');      // 本輪仍走既有回退
  });
});
