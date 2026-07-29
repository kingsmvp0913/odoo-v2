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
  test('停該專案的單一容器（免查 DB、免解密）', async () => {
    await stopProjectVpns(7);
    expect(stopGateway).toHaveBeenCalledTimes(1);
    expect(stopGateway).toHaveBeenCalledWith({ containerName: 'vpn-proj-7' }, expect.anything());
  });

  test('stopGateway 丟錯不會讓 stopProjectVpns throw（不擋停機）', async () => {
    stopGateway.mockImplementation(() => { throw new Error('docker 掛了'); });
    await expect(stopProjectVpns(7)).resolves.toBeUndefined();
  });
});
