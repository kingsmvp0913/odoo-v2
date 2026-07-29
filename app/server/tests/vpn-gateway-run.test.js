const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureGatewayRunning, imageTag } = require('../lib/vpn-gateway');

// 鴻久的真實形狀：兩個目標（Odoo 那台走 ssh、SM 那台走 mssql），共用一條隧道。
const baseGw = {
  containerName: 'vpn-proj-2',
  config: 'client\ndev tun\n...',
  username: 'u1',
  password: 'p1',
  targets: [
    { forwardPort: 22000, host: '192.168.1.233', port: 22 },
    { forwardPort: 22001, host: '192.168.1.240', port: 1433 },
  ],
  staleContainers: [],
};
const SPEC = '22000:192.168.1.233:22,22001:192.168.1.240:1433';

function fakeDeps(overrides = {}) {
  return {
    // 預設：daemon 已啟動、image 已 build、容器不存在（inspect 失敗）
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return 'sha256:abc123\n';
      if (args[0] === 'inspect') throw new Error('No such object');
      return '';
    }),
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
    tmpFilePath: jest.fn(() => 'C:\\tmp\\vpn-proj-2.ovpn'),
    waitReachable: jest.fn().mockResolvedValue(),
    ...overrides,
  };
}

// 容器在跑、且 label 指紋等於現在需要的目標集合 → 直接沿用（inspect 兩次：Running + Labels）
function runningWithSpec(spec) {
  return jest.fn((cmd, args) => {
    if (args[0] === 'info') return '';
    if (args[0] === 'images') return 'sha256:abc123\n';
    if (args[0] === 'inspect' && String(args[2] || '').includes('State.Running')) return 'true\n';
    if (args[0] === 'inspect' && String(args[2] || '').includes('Labels')) return `${spec}\n`;
    return '';
  });
}

test('容器已在跑且目標指紋相同時，直接沿用，不重建也不等待', async () => {
  const deps = fakeDeps({ execFileSync: runningWithSpec(SPEC) });
  const result = await ensureGatewayRunning(baseGw, deps);
  expect(result).toEqual({ containerName: 'vpn-proj-2', targetsSpec: SPEC });
  expect(deps.execFileSync.mock.calls.some(c => c[1][0] === 'run')).toBe(false);
  expect(deps.waitReachable).not.toHaveBeenCalled();
  expect(deps.writeFileSync).not.toHaveBeenCalled();
});

// 這是共用容器方案唯一「必須重建」的情境：使用者新增了打去第三台機器的連線。
test('容器在跑但目標指紋不同時（多了新目標），先 stop+rm 再重建', async () => {
  const deps = fakeDeps({ execFileSync: runningWithSpec('22000:192.168.1.233:22') });
  await ensureGatewayRunning(baseGw, deps);

  const stopIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'stop');
  const runIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'run');
  expect(stopIdx).toBeGreaterThanOrEqual(0);
  expect(runIdx).toBeGreaterThan(stopIdx);
});

test('容器不存在時：寫設定檔、多目標 docker run、等待就緒', async () => {
  const deps = fakeDeps();
  const result = await ensureGatewayRunning(baseGw, deps);

  expect(result).toEqual({ containerName: 'vpn-proj-2', targetsSpec: SPEC });
  expect(deps.writeFileSync).toHaveBeenCalledWith('C:\\tmp\\vpn-proj-2.ovpn', 'client\ndev tun\n...', { mode: 0o600 });

  const args = deps.execFileSync.mock.calls.find(c => c[1][0] === 'run')[1];
  expect(args).toContain('--name');
  expect(args).toContain('vpn-proj-2');
  expect(args).toContain('--cap-add=NET_ADMIN');
  // openvpn 要建 tun0 必須掛 /dev/net/tun；只給 NET_ADMIN 會倒在 "Cannot open TUN/TAP dev"。
  // 這是既有的血淚修正（commit 4044c5e），改多目標時不可退化。
  const devIdx = args.indexOf('--device');
  expect(devIdx).toBeGreaterThanOrEqual(0);
  expect(args[devIdx + 1]).toBe('/dev/net/tun');
  // 每個目標各 publish 一個埠，且容器內 listen 埠＝主機埠（省掉對照層）
  expect(args).toContain('127.0.0.1:22000:22000');
  expect(args).toContain('127.0.0.1:22001:22001');
  expect(args).toContain('-v');
  expect(args).toContain('C:\\tmp\\vpn-proj-2.ovpn:/config/client.ovpn:ro');
  expect(args).toContain('VPN_USER=u1');
  expect(args).toContain('VPN_PASS=p1');
  expect(args).toContain(`TARGETS=${SPEC}`);
  expect(args).toContain(`targets=${SPEC}`);
  expect(deps.rmSync).toHaveBeenCalledWith('C:\\tmp\\vpn-proj-2.ovpn', { recursive: true, force: true });
});

test('指紋與 TARGETS 依 forwardPort 排序，與 targets 陣列的傳入順序無關', async () => {
  const reversed = { ...baseGw, targets: [...baseGw.targets].reverse() };
  const deps = fakeDeps();
  const result = await ensureGatewayRunning(reversed, deps);
  expect(result.targetsSpec).toBe(SPEC);
});

// 遷移的關鍵一步：舊的 vpn-conn-* 若留著，會用同一組帳號一直掛著一個 openvpn session，
// 新容器再撥就是同帳號雙重撥號，VPN 伺服器可能把兩邊都踢掉。
test('起容器前會先清掉 staleContainers 列出的舊容器', async () => {
  const gw = { ...baseGw, staleContainers: ['vpn-conn-1', 'vpn-conn-3'] };
  const deps = fakeDeps();
  await ensureGatewayRunning(gw, deps);

  const rmNames = deps.execFileSync.mock.calls.filter(c => c[1][0] === 'rm').map(c => c[1][2]);
  expect(rmNames).toContain('vpn-conn-1');
  expect(rmNames).toContain('vpn-conn-3');
  const runIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'run');
  const lastRmIdx = deps.execFileSync.mock.calls.map(c => c[1][0]).lastIndexOf('rm');
  expect(runIdx).toBeGreaterThan(lastRmIdx);
});

test('清舊容器時容器本來就不存在（stop/rm 皆失敗），不影響後續 docker run', async () => {
  const gw = { ...baseGw, staleContainers: ['vpn-conn-1'] };
  const deps = fakeDeps({
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return 'sha256:abc123\n';
      if (args[0] === 'inspect') throw new Error('No such object');
      if (args[0] === 'stop' || args[0] === 'rm') throw new Error('No such container');
      return '';
    }),
  });
  const result = await ensureGatewayRunning(gw, deps);
  expect(result.containerName).toBe('vpn-proj-2');
  expect(deps.execFileSync.mock.calls.some(c => c[1][0] === 'run')).toBe(true);
});

test('暫存 .ovpn 要等就緒檢查完成才清除（太早刪會讓 openvpn 開檔撲空）', async () => {
  const callOrder = [];
  const deps = fakeDeps({
    rmSync: jest.fn(() => callOrder.push('rmSync')),
    waitReachable: jest.fn(async () => { callOrder.push('waitReachable'); }),
  });
  await ensureGatewayRunning(baseGw, deps);
  expect(callOrder[callOrder.length - 1]).toBe('rmSync');
  expect(callOrder[callOrder.length - 2]).toBe('waitReachable');
});

test('VPN 帳密留空時，環境變數仍帶入空字串（不丟錯）', async () => {
  const deps = fakeDeps();
  await ensureGatewayRunning({ ...baseGw, username: undefined, password: undefined }, deps);
  const args = deps.execFileSync.mock.calls.find(c => c[1][0] === 'run')[1];
  expect(args).toContain('VPN_USER=');
  expect(args).toContain('VPN_PASS=');
});

test('暫存設定檔在 docker run 失敗時仍會被清除', async () => {
  const deps = fakeDeps({
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'inspect') throw new Error('No such object');
      if (args[0] === 'run') throw new Error('docker daemon not running');
      return '';
    }),
  });
  await expect(ensureGatewayRunning(baseGw, deps)).rejects.toThrow(/docker daemon not running/);
  expect(deps.rmSync).toHaveBeenCalledWith('C:\\tmp\\vpn-proj-2.ovpn', { recursive: true, force: true });
});

test('image 不存在時，docker run 之前會先 build', async () => {
  const deps = fakeDeps({
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return '';
      if (args[0] === 'inspect') throw new Error('No such object');
      return '';
    }),
  });
  await ensureGatewayRunning(baseGw, deps);
  const buildIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'build');
  const runIdx = deps.execFileSync.mock.calls.findIndex(c => c[1][0] === 'run');
  expect(buildIdx).toBeGreaterThanOrEqual(0);
  expect(runIdx).toBeGreaterThan(buildIdx);
});

// 就緒＝「任一目標可達」。若要求全部可達，SM 那台關機就會害整個 gateway 起不來，
// 連 Odoo 那條也不能查——個別目標不通應該留給該連線自己的查詢去報錯。
test('不注入 waitReachable 時：只要有一個目標 nc 探測成功就算就緒', async () => {
  let started = false;
  const deps = {
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return 'sha256:abc\n';
      if (args[0] === 'run') { started = true; return ''; }
      if (args[0] === 'inspect' && String(args[2] || '').includes('State.Running')) return started ? 'true\n' : 'false\n';
      if (args[0] === 'inspect' && String(args[2] || '').includes('Labels')) return '\n';
      return '';
    }),
    // 第一個目標不通、第二個通 → 仍算就緒
    execFile: jest.fn((cmd, args, cb) => cb(args[6] === '192.168.1.240' ? null : new Error('nc fail'))),
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
    tmpFilePath: () => 'C:\\tmp\\vpn-proj-2.ovpn',
  };
  const result = await ensureGatewayRunning(baseGw, deps);
  expect(result.containerName).toBe('vpn-proj-2');
  const probes = deps.execFile.mock.calls.filter(c => c[1][0] === 'exec').map(c => c[1]);
  expect(probes).toContainEqual(['exec', 'vpn-proj-2', 'nc', '-z', '-w', '2', '192.168.1.233', '22']);
  expect(probes).toContainEqual(['exec', 'vpn-proj-2', 'nc', '-z', '-w', '2', '192.168.1.240', '1433']);
});

test('不注入 waitReachable 時，容器撥號中途退出：撈 docker logs 併入錯誤，不傻等到逾時', async () => {
  const deps = {
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return 'sha256:abc\n';
      if (args[0] === 'inspect' && String(args[2] || '').includes('State.Running')) return 'false\n';
      if (args[0] === 'inspect' && String(args[2] || '').includes('Labels')) return '\n';
      if (args[0] === 'logs') return 'AUTH: Received control message: AUTH_FAILED\n';
      return '';
    }),
    execFile: jest.fn((cmd, args, cb) => cb(new Error('nc: bad address'))),
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
    tmpFilePath: () => 'C:\\tmp\\vpn-proj-2.ovpn',
  };
  await expect(ensureGatewayRunning(baseGw, deps)).rejects.toThrow(/AUTH_FAILED/);
  expect(deps.rmSync).toHaveBeenCalledWith('C:\\tmp\\vpn-proj-2.ovpn', { recursive: true, force: true });
});

test('逾時錯誤訊息要列出所有目標，方便判斷是哪台不通', async () => {
  const deps = fakeDeps({
    waitReachable: jest.fn().mockRejectedValue(
      new Error('VPN 連線逾時（40 秒內未能透過隧道連到 192.168.1.233:22、192.168.1.240:1433），請確認 VPN 帳號密碼與設定檔是否正確')
    ),
  });
  await expect(ensureGatewayRunning(baseGw, deps)).rejects.toThrow(/192\.168\.1\.240:1433/);
});

// 這支測試直接對應這次修的缺口：舊版 IMAGE_NAME 是寫死的 :latest，ensureImageBuilt 只要看到
// 「同名 image 存在」就跳過 build——任何已經 build 過一次的機器（如 ai-server）之後改
// entrypoint.sh，容器內還是跑舊版，且完全沒有錯誤訊息可看。若把 ensureImageBuilt 檢查/build
// 用的 tag 跟 docker run 用的 tag 改壞成不同值，這支測試會抓到；若改回寫死 :latest，
// `.not.toBe('odoo-v2-vpn-gateway:latest')` 這行會紅。
test('docker run 用的 image tag 與 ensureImageBuilt 檢查/build 的 tag 是同一個（不是寫死的 :latest）', async () => {
  const deps = fakeDeps({
    execFileSync: jest.fn((cmd, args) => {
      if (args[0] === 'info') return '';
      if (args[0] === 'images') return ''; // image 不存在 → 走 build 分支，同時撈到查詢用的 tag
      if (args[0] === 'inspect') throw new Error('No such object');
      return '';
    }),
  });
  await ensureGatewayRunning(baseGw, deps);

  const imagesCall = deps.execFileSync.mock.calls.find(c => c[1][0] === 'images');
  const buildCall = deps.execFileSync.mock.calls.find(c => c[1][0] === 'build');
  const runCall = deps.execFileSync.mock.calls.find(c => c[1][0] === 'run');
  const queriedTag = imagesCall[1][2];
  const builtTag = buildCall[1][2];
  const runImage = runCall[1][runCall[1].length - 1];

  expect(queriedTag).toBe(builtTag);
  expect(runImage).toBe(queriedTag);
  expect(runImage).not.toBe('odoo-v2-vpn-gateway:latest');
  expect(runImage).toMatch(/^odoo-v2-vpn-gateway:[0-9a-f]{12}$/);
});

// Fix B：容器共用成單一資源後，同一個 containerName 的併發呼叫會互砍。
//
// 注意「兩邊都跑 docker run」不是能分辨有無鎖的訊號：isContainerRunning 檢查到 docker run
// 之間全是同步的 execFileSync，單執行緒下第二個呼叫者永遠是在容器已建好之後才醒來。
// 真正的破壞窗口在 waitReachable——先到者在那裡 await（最長 40 秒）讓出 event loop，
// 後到者此時進場；只要兩邊的目標集合不同（實際場景：測試區起動的 fire-and-forget 撥號讀到
// 舊的連線清單，使用者剛存好第二條連線後查詢觸發的 lazy 撥號讀到新的），後到者就會判定
// 指紋不符而走 removeStaleContainer，把先到者還在撥號的容器 stop+rm 掉，
// 讓先到者在 waitReachable 撞見容器消失、對使用者報一個假的「撥號失敗」。
//
// withProjectLock 排隊後：後到者要等先到者整段做完才開始，先到者正常撥通回報成功，
// 後到者才接著依新的目標集合重建——兩邊都成功。
test('併發呼叫：後到者不得在先到者撥號途中把容器砍掉重建（Fix B）', async () => {
  const SPEC_ONE = '22000:192.168.1.233:22';
  const oneTarget = { ...baseGw, targets: [baseGw.targets[0]] };

  let running = null; // 容器現在掛的 targets 指紋；null＝沒有容器
  const execFileSync = jest.fn((cmd, args) => {
    if (args[0] === 'info') return '';
    if (args[0] === 'images') return 'sha256:abc123\n';
    if (args[0] === 'stop' || args[0] === 'rm') { running = null; return ''; }
    if (args[0] === 'run') { running = args[args.indexOf('--label') + 1].replace('targets=', ''); return ''; }
    if (args[0] === 'inspect') {
      if (running === null) throw new Error('No such object');
      if (String(args[2] || '').includes('State.Running')) return 'true\n';
      if (String(args[2] || '').includes('Labels')) return `${running}\n`;
    }
    return '';
  });

  // 撥號中停住，由測試決定何時「撥通」，藉此把後到者放進先到者的撥號窗口內。
  const dialing = [];
  const waitReachable = jest.fn(async () => {
    const mine = running; // 這次 docker run 起的那個容器
    await new Promise(resolve => dialing.push(resolve));
    // 真實的 waitReachable 靠 docker exec 探目標，容器被砍掉會直接報「容器已結束」
    if (running !== mine) throw new Error('VPN 撥號失敗，容器已結束');
  });

  const deps = {
    execFileSync,
    writeFileSync: jest.fn(),
    rmSync: jest.fn(),
    tmpFilePath: jest.fn(() => 'C:\\tmp\\vpn-proj-2.ovpn'),
    waitReachable,
  };

  const first = ensureGatewayRunning(oneTarget, deps); // 測試區起動的 fire-and-forget 撥號
  const second = ensureGatewayRunning(baseGw, deps); // 使用者剛存好第二條連線後的 lazy 撥號
  const settled = Promise.allSettled([first, second]);
  // 有鎖時後到者要等先到者整段做完才進撥號，兩邊不會同時在 dialing 裡——逐輪放行直到都收斂。
  for (let i = 0; i < 10; i++) {
    dialing.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
  }
  const [r1, r2] = await settled;

  // 沒有鎖時這裡會是 rejected：先到者的容器在它撥號途中被後到者砍掉
  expect(r1.status).toBe('fulfilled');
  expect(r1.value).toEqual({ containerName: 'vpn-proj-2', targetsSpec: SPEC_ONE });
  expect(r2.status).toBe('fulfilled');
  expect(r2.value).toEqual({ containerName: 'vpn-proj-2', targetsSpec: SPEC });
});

describe('imageTag：tag 依 Dockerfile／entrypoint.sh 內容雜湊', () => {
  function makeFixtureDir(dockerfileContent, entrypointContent) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-gateway-hash-'));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), dockerfileContent);
    fs.writeFileSync(path.join(dir, 'entrypoint.sh'), entrypointContent);
    return dir;
  }

  test('建置內容（Dockerfile 或 entrypoint.sh）不同，算出的 tag 就不同', () => {
    const dirA = makeFixtureDir('FROM alpine:3.20\n', '#!/bin/sh\necho a\n');
    const dirB = makeFixtureDir('FROM alpine:3.20\n', '#!/bin/sh\necho b\n');
    try {
      expect(imageTag(dirA)).not.toBe(imageTag(dirB));
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  // 同一份邏輯內容不能因為換行符不同就算出不同 tag，否則同一份程式碼在 Windows（CRLF）
  // 與 Linux（LF）上、甚至同一台機器因 git autocrlf 設定不同，會被誤判成「內容變了」。
  test('內容相同、只是換行符不同（CRLF vs LF），tag 要相同', () => {
    const dirCRLF = makeFixtureDir('FROM alpine:3.20\r\nRUN x\r\n', '#!/bin/sh\r\necho hi\r\n');
    const dirLF = makeFixtureDir('FROM alpine:3.20\nRUN x\n', '#!/bin/sh\necho hi\n');
    try {
      expect(imageTag(dirCRLF)).toBe(imageTag(dirLF));
    } finally {
      fs.rmSync(dirCRLF, { recursive: true, force: true });
      fs.rmSync(dirLF, { recursive: true, force: true });
    }
  });

  test('讀不到建置檔案時 fail loud（丟錯，不靜默退回舊行為）', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-gateway-hash-empty-'));
    try {
      expect(() => imageTag(emptyDir)).toThrow();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
