// 意圖：VPN 與測試區生命週期共管的正確性＝「起停時做什麼、失敗怎麼隔離」。
// 三個真正會出事的情境：
//   ①撥號失敗不能擋住測試區（Odoo 本身不走 VPN 網路）
//   ②專案沒設定 VPN／沒有目標時不能白撥號
//   ③停機收 VPN 若 docker 掛了不能反過來擋住測試區停機
jest.mock('../lib/db-connections', () => ({ loadProjectVpn: jest.fn() }));
jest.mock('../lib/vpn-gateway', () => ({
  ensureGatewayRunning: jest.fn(),
  stopGateway: jest.fn(),
  projectContainerName: (id) => `vpn-proj-${id}`,
}));

const { loadProjectVpn } = require('../lib/db-connections');
const { ensureGatewayRunning, stopGateway } = require('../lib/vpn-gateway');
const { startProjectVpns, stopProjectVpns } = require('../lib/project-vpn');

const gw = (over = {}) => ({
  containerName: 'vpn-proj-7', config: 'cfg', username: 'u', password: 'p',
  targets: [
    { forwardPort: 22000, host: '192.168.1.233', port: 22 },
    { forwardPort: 22001, host: '192.168.1.240', port: 1433 },
  ],
  staleContainers: [], ...over,
});

beforeEach(() => {
  loadProjectVpn.mockReset();
  ensureGatewayRunning.mockReset();
  stopGateway.mockReset();
});

describe('startProjectVpns', () => {
  test('整個專案只撥一次號、只起一個容器', async () => {
    loadProjectVpn.mockResolvedValue(gw());
    ensureGatewayRunning.mockResolvedValue({ containerName: 'vpn-proj-7', targetsSpec: 'x' });
    const log = await startProjectVpns(7);
    expect(ensureGatewayRunning).toHaveBeenCalledTimes(1);
    expect(ensureGatewayRunning).toHaveBeenCalledWith(expect.objectContaining({ containerName: 'vpn-proj-7' }), expect.anything());
    expect(log).toContain('vpn-proj-7 OK');
    expect(log).toContain('2 個目標');
  });

  test('撥號失敗只記 log、不 throw（不擋測試區起動）', async () => {
    loadProjectVpn.mockResolvedValue(gw());
    ensureGatewayRunning.mockRejectedValue(new Error('撥號逾時'));
    const log = await startProjectVpns(7);
    expect(log).toContain('FAIL 撥號逾時');
  });

  test('專案沒設定 VPN 時不碰 gateway', async () => {
    loadProjectVpn.mockResolvedValue(null);
    const log = await startProjectVpns(7);
    expect(ensureGatewayRunning).not.toHaveBeenCalled();
    expect(log).toBe('');
  });

  test('有設定但沒有任何已配埠的目標時不撥號', async () => {
    loadProjectVpn.mockResolvedValue(gw({ targets: [] }));
    const log = await startProjectVpns(7);
    expect(ensureGatewayRunning).not.toHaveBeenCalled();
    expect(log).toContain('SKIP');
  });

  test('讀取設定本身丟錯（如 APP_SECRET 換過導致解密失敗）也不 throw', async () => {
    loadProjectVpn.mockRejectedValue(new Error('Unsupported state or unable to authenticate data'));
    const log = await startProjectVpns(7);
    expect(log).toContain('FAIL');
    expect(ensureGatewayRunning).not.toHaveBeenCalled();
  });
});

describe('stopProjectVpns', () => {
  test('停該專案的單一容器', async () => {
    loadProjectVpn.mockResolvedValue(gw());
    await stopProjectVpns(7);
    expect(stopGateway).toHaveBeenCalledTimes(1);
    expect(stopGateway).toHaveBeenCalledWith({ containerName: 'vpn-proj-7' }, expect.anything());
  });

  // 意圖：這條沒有早退的話，任何呼叫 stopEnv 的程式（含測試）都會對宿主機盲發
  // `docker stop vpn-proj-<id>`。實測跑 project-routes.test.js 就把本機同名的真容器停掉——
  // pg-mem 裡的假專案 id 跟真機器上的容器名撞在一起，而 stopGateway 對「容器不存在」是靜默的，
  // 所以砍錯東西完全沒有任何訊號。對照 startProjectVpns 早就會先確認有設定才動作。
  test('專案沒設定 VPN 時完全不發 docker 指令', async () => {
    loadProjectVpn.mockResolvedValue(null);
    await stopProjectVpns(7);
    expect(stopGateway).not.toHaveBeenCalled();
  });

  test('讀取設定丟錯時也不發 docker 指令（寧可留著殘留容器，也不盲打宿主機）', async () => {
    loadProjectVpn.mockRejectedValue(new Error('Unsupported state or unable to authenticate data'));
    await expect(stopProjectVpns(7)).resolves.toBeUndefined();
    expect(stopGateway).not.toHaveBeenCalled();
  });

  test('stopGateway 丟錯不會讓 stopProjectVpns throw（不擋停機）', async () => {
    loadProjectVpn.mockResolvedValue(gw());
    stopGateway.mockImplementation(() => { throw new Error('docker 掛了'); });
    await expect(stopProjectVpns(7)).resolves.toBeUndefined();
  });
});
