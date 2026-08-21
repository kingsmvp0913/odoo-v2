// odoo-core-src：核心 addons 解壓＋資料來源守則。docker／fs 全 mock，不碰真 docker。
jest.mock('child_process');
jest.mock('fs');

const { EventEmitter } = require('events');
const fs = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');
const { ensureOdooCoreSrc, coreSourceGuidance, majorOf } = require('../lib/odoo-core-src');

// callback 式 execFile 的腳本：依 args 回 stdout，impl 丟錯即等同 docker 失敗
function mockDocker(impl) {
  execFile.mockImplementation((cmd, args, opts, cb) => {
    try { cb(null, impl(args), ''); } catch (e) { cb(e, '', ''); }
  });
}

// 解壓那段走 spawn（docker 吐 tar → 本機 tar 解），需要能收 close 事件的假行程。
// codes 給非 0 即模擬該端失敗；給 function 則以 (cmd, args) 決定 code——解壓分兩段
// （addons 走 `cp`、框架本體走 `run`）都是 docker，要靠 args 才分得開。
function mockSpawn(codes = {}) {
  const codeOf = typeof codes === 'function' ? codes : (cmd) => codes[cmd] ?? 0;
  spawn.mockImplementation((cmd, args) => {
    const p = new EventEmitter();
    p.stdout = Object.assign(new EventEmitter(), { pipe: jest.fn() });
    p.stderr = new EventEmitter();
    p.stdin = new EventEmitter();
    p.kill = jest.fn();
    setImmediate(() => p.emit('close', codeOf(cmd, args) ?? 0));
    return p;
  });
}

// 取出某個指令的 spawn 參數（docker / tar）——docker 有多段時取第一段（addons）
const spawnArgs = (cmd) => (spawn.mock.calls.find((c) => c[0] === cmd) || [])[1];
// 取出所有該指令的 spawn 參數，用來分辨 addons 段與框架本體段
const allSpawnArgs = (cmd) => spawn.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  // fs 寫入類一律 no-op（回 undefined 即可）
  fs.mkdirSync.mockReturnValue(undefined);
  fs.rmSync.mockReturnValue(undefined);
  fs.renameSync.mockReturnValue(undefined);
  fs.writeFileSync.mockReturnValue(undefined);
  mockSpawn();
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

  // 意圖（這一條是踩過才有的）：`docker cp` 直接寫檔案系統，會在「指向複製範圍外的 symlink」
  // 上整個中止——實測 odoo-idx:17 的 point_of_sale/static/src/fonts/Inconsolata.otf 指到 image 的
  // /share/fonts/…，cp 回 `invalid symlink` 並 exit 1，已複製的 387/643 個模組留在暫存目錄，
  // rename 永遠等不到，於是每一關都退回「只用 Context7」。改成 dest=`-`（吐 tar 串流）後 tar
  // 原樣保存 symlink、不驗證目標，643/643 全數解出。dest 一旦被「優化」回檔案系統路徑就會復發。
  test('docker cp 的目的地必須是 `-`（tar 串流），不得直接寫檔案系統', async () => {
    fs.existsSync.mockReturnValue(false);
    mockDocker(args => (args[0] === 'create' ? 'cid-tar' : ''));
    await ensureOdooCoreSrc('19.1');
    const args = spawnArgs('docker');
    expect(args[0]).toBe('cp');
    expect(args[args.length - 1]).toBe('-');
    // 串流要有人接：本機 tar 解到暫存目錄（旗標寫法不拘，-xf 或 -x -f 都算）
    expect(spawnArgs('tar').join(' ')).toMatch(/-x/);
    expect(spawnArgs('tar')).toContain('-C');
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
      cp.spawn.mockImplementation(() => {
        const p = new EventEmitter();
        p.stdout = Object.assign(new EventEmitter(), { pipe: jest.fn() });
        p.stderr = new EventEmitter();
        p.stdin = new EventEmitter();
        p.kill = jest.fn();
        setImmediate(() => p.emit('close', 0));
        return p;
      });
      await core.ensureOdooCoreSrc('16.0');
      const cpCall = cp.spawn.mock.calls.find(c => c[0] === 'docker');
      expect(cpCall[1]).toContain('cid-1:/custom/core/addons');
    } finally {
      if (prev === undefined) delete process.env.ODOO_IMAGE_CORE_ADDONS;
      else process.env.ODOO_IMAGE_CORE_ADDONS = prev;
    }
  });

  // 意圖（這一條是踩過才有的，慈雲 task #173）：只解 addons 時，`odoo/tools/convert.py` 這類
  // 框架本體不在 agent 手上。該檔的 `_tag_menuitem` 決定了 `<menuitem groups="...">` 的排除前綴是
  // `-` 而非 view arch 的 `!`——分析關查不到卻寫了「已於核心文件確認支援 `!`」，部署炸掉；
  // coding 改對成 `-`，QA 拿 addons 內的 res_users.py（那是 view arch 語義）判它錯，兩關互斥
  // 撞 reentry 上限而 stopped。兩邊都「有原始碼佐證」，因為真相檔根本不在解出來的範圍內。
  test('解壓要同時取框架本體（tools／models／fields／http.py），不是只有 addons', async () => {
    fs.existsSync.mockReturnValue(false);
    mockDocker(args => (args[0] === 'create' ? 'cid-fw' : ''));
    await ensureOdooCoreSrc('19.3');
    const dockerCalls = allSpawnArgs('docker');
    expect(dockerCalls).toHaveLength(2);                     // addons 一段、框架本體一段
    const fw = dockerCalls[1].join(' ');
    expect(fw).toMatch(/\bodoo-idx:19\b/);                   // 對到本版本 image
    expect(fw).toMatch(/--exclude[= ]odoo\/addons/);         // 不再拉一次 1.4GB 的 addons
    // 框架本體 rename 到 <root>/19/odoo，與 addons 分開落地
    expect(fs.renameSync).toHaveBeenCalledWith(expect.stringMatching(/odoo$/), expect.stringMatching(/[\\/]19[\\/]odoo$/));
  });

  // 意圖：框架本體的來源同樣只有 docker-env.CORE_ADDONS 一份真相（其父目錄即 odoo 套件根）。
  // 另抄一份字面值的話，改 ODOO_IMAGE_CORE_ADDONS 會變成 addons 解得到、框架本體靜默解錯地方。
  // 用 env 覆寫成非預設值才有鑑別力（testing.md #18）。
  test('框架本體的來源路徑由 docker-env.CORE_ADDONS 推導，不是自己抄一份', async () => {
    const prev = process.env.ODOO_IMAGE_CORE_ADDONS;
    process.env.ODOO_IMAGE_CORE_ADDONS = '/custom/core/addons';
    try {
      let core, cp;
      jest.isolateModules(() => { core = require('../lib/odoo-core-src'); cp = require('child_process'); });
      cp.execFile.mockImplementation((cmd, args, opts, cb) => cb(null, args[0] === 'create' ? 'cid-2' : '', ''));
      cp.spawn.mockImplementation(() => {
        const p = new EventEmitter();
        p.stdout = Object.assign(new EventEmitter(), { pipe: jest.fn() });
        p.stderr = new EventEmitter();
        p.stdin = new EventEmitter();
        p.kill = jest.fn();
        setImmediate(() => p.emit('close', 0));
        return p;
      });
      await core.ensureOdooCoreSrc('16.1');
      // /custom/core/addons ⇒ 套件根 /custom/core：tar 的 -C 是它的父目錄、成員名是套件名
      const fw = cp.spawn.mock.calls.filter(c => c[0] === 'docker')[1][1];
      expect(fw.join(' ')).toContain('-C /custom core');
      expect(fw.join(' ')).toMatch(/--exclude[= ]core\/addons/);     // 套件名與 addons 名皆由該路徑推導
      expect(fw.join(' ')).not.toContain('dist-packages');           // 沒有殘留的字面值預設路徑
    } finally {
      if (prev === undefined) delete process.env.ODOO_IMAGE_CORE_ADDONS;
      else process.env.ODOO_IMAGE_CORE_ADDONS = prev;
    }
  });

  // 意圖：本功能上線前解出的快取（marker＋addons 齊、無框架本體）必須被判為未完成並重解。
  // 只看 marker＋addons 的話，那三份既有快取會被永遠當成已完成，改動對現存版本等於沒生效。
  test('舊快取只有 addons、缺框架本體 → 視為未完成，重新解壓', async () => {
    fs.existsSync.mockImplementation(p => !String(p).endsWith(`${require('path').sep}odoo`));
    mockDocker(args => (args[0] === 'create' ? 'cid-stale' : ''));
    await ensureOdooCoreSrc('18.1');
    expect(execFile).toHaveBeenCalledWith('docker', ['create', 'odoo-idx:18'], expect.anything(), expect.any(Function));
  });

  // 意圖：與 addons 段同理——框架本體只解一半就寫 marker，等於把殘缺快取標成已完成，
  // 之後永遠不再重試，而 agent 會拿到一個「找不到就以為原生沒這東西」的路徑，比沒有更糟。
  test('框架本體段非 0 → 不寫 marker、回空字串', async () => {
    fs.existsSync.mockReturnValue(false);
    mockDocker(args => (args[0] === 'create' ? 'cid-fwfail' : ''));
    mockSpawn((cmd, args) => (cmd === 'docker' && args[0] !== 'cp' ? 1 : 0));   // cp 成功、框架段失敗
    await expect(ensureOdooCoreSrc('19.4')).resolves.toBe('');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  // 意圖：cp 失敗（如上述 invalid symlink）必須讓整輪解壓算失敗、不得寫 marker——
  // 寫了 marker 就等於把「半套的 387 個模組」標成已完成，之後永遠不再重試，而 agent 會拿到
  // 一個看似可用、實則缺一半模組的核心路徑：比完全沒有更糟（找不到就以為原生沒這東西）。
  test('cp 端非 0 → 不寫 marker、回空字串', async () => {
    fs.existsSync.mockReturnValue(false);
    mockDocker(args => (args[0] === 'create' ? 'cid-fail' : ''));
    mockSpawn({ docker: 1 });
    await expect(ensureOdooCoreSrc('19.2')).resolves.toBe('');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
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

  // 意圖：規格參照了目標版本根本不存在的欄位時，pipeline 會鎖死——部署關照著錯規格做會失敗、要求刪掉，
  // 審查關對照規格發現少了東西、要求補上，兩關各自都判對，碼怎麼改都被打回（raifong T1 實測，最後
  // 只能人工改規格解套）。守則要同時做到兩件事才解得開：落筆前先驗存在性（堵源頭），以及衝突時以
  // 原始碼為準（讓下游敢推翻錯規格）。這段守則六個關卡共用，所以審查關也讀得到後者。
  test('取得核心 → 要求具名欄位先驗存在性，且規格與原始碼衝突時以原始碼為準', () => {
    fs.existsSync.mockReturnValue(true);
    const g = coreSourceGuidance('19.0');
    expect(g).toContain('確認它在本版本真的存在');
    expect(g).toContain('以原始碼為準');
  });

  // 意圖：守則若只列 addons 路徑，agent 就不知道框架本體也在本機——task #173 的 coding 正是
  // 因此改去 `find / -name convert.py`，被掃碟守衛中止（守衛沒錯，錯在平台沒給替代來源）。
  // 同時舊守則那句「ORM 本體不在，那類問題仍走 Context7」現在是假的，留著會主動勸退 agent。
  test('取得核心 → 守則同時給框架本體路徑，且不再宣稱本體不在', () => {
    fs.existsSync.mockReturnValue(true);
    const g = coreSourceGuidance('19.0');
    expect(g).toMatch(/[\\/]19[\\/]odoo\b/);        // 框架本體路徑要寫出來
    expect(g).toMatch(/convert\.py|tools/);         // 指名 data file 解析器那類真相檔
    expect(g).not.toContain('ORM 本體');            // 舊的勸退句必須移除
  });

  // 意圖：企業版與社群版的差別只在多一包 addons，而那包一直都在本機（測試區唯讀掛入的就是它）。
  // 守則沒寫出路徑之前，agent 查企業版模組只能靠 Context7 猜——prompt 又明文禁止掃碟，等於沒有
  // 任何管道。覆蓋順序必須一起講：容器的 addons-path 是「專案自訂 → enterprise → 核心」，
  // 查反了會拿到被企業版覆蓋掉的社群版當結論，而那種錯誤在部署前完全看不出來。
  test('企業版專案 → 守則多給企業版路徑，並講明它覆蓋核心', () => {
    fs.existsSync.mockReturnValue(true);
    const g = coreSourceGuidance('17.0', '/srv/enterprise/17');
    expect(g).toContain('/srv/enterprise/17');
    expect(g).toContain('覆蓋');
    expect(g).toMatch(/先看這裡/);
    expect(g).toContain('查不到');            // 「核心裡查無」≠「這功能不存在」
  });

  test('社群版專案（沒傳企業版目錄）→ 守則不得出現企業版那段', () => {
    fs.existsSync.mockReturnValue(true);
    const g = coreSourceGuidance('17.0');
    expect(g).not.toContain('企業版');
  });

  // 意圖：管理員還沒同步、或目錄被清掉時，寫一條指向空氣的路徑比不寫更糟——agent 會照著去
  // Grep、查無結果，然後把「查無」當成事實下結論。組 prompt 這條路徑不 fail loud（那是建測試區
  // 的責任），所以這裡只能靜靜不寫。
  test('企業版目錄不存在 → 不寫進守則（不給指向空氣的路徑）', () => {
    fs.existsSync.mockImplementation((p) => !String(p).includes('gone'));
    const g = coreSourceGuidance('17.0', '/srv/enterprise/gone');
    expect(g).not.toContain('/srv/enterprise/gone');
    expect(g).not.toContain('企業版');
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
