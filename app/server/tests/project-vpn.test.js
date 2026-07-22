// 意圖：VPN 與測試區生命週期共管的正確性＝「起停時對哪些連線做什麼、失敗怎麼隔離」。
// 這些純協調邏輯離線可測，把三個真正會出事的情境鎖死：
//   ①單條 VPN 撥號失敗不能拖垮整批（其餘仍要嘗試、整體不 throw）
//   ②非 vpn_enabled／未配埠的連線不能被誤起
//   ③停機收 VPN 若 docker 掛了不能反過來擋住測試區停機流程
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../lib/db-connections', () => ({ loadDecryptedConn: jest.fn() }));
jest.mock('../lib/vpn-gateway', () => ({ ensureGatewayRunning: jest.fn(), stopGateway: jest.fn() }));

const { query } = require('../db');
const { loadDecryptedConn } = require('../lib/db-connections');
const { ensureGatewayRunning, stopGateway } = require('../lib/vpn-gateway');
const { startProjectVpns, stopProjectVpns } = require('../lib/project-vpn');

beforeEach(() => {
  query.mockReset(); loadDecryptedConn.mockReset();
  ensureGatewayRunning.mockReset(); stopGateway.mockReset();
});

describe('startProjectVpns', () => {
  test('對每條 vpn_enabled 連線都解密並 ensureGatewayRunning', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
    loadDecryptedConn.mockImplementation(async (id) => ({ id, name: `c${id}`, vpn_forward_port: 11000 + id }));
    ensureGatewayRunning.mockResolvedValue({ forwardPort: 11001 });
    const log = await startProjectVpns(7);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('vpn_enabled=true'), [7]);
    expect(loadDecryptedConn).toHaveBeenCalledWith(1, 7);
    expect(loadDecryptedConn).toHaveBeenCalledWith(2, 7);
    expect(ensureGatewayRunning).toHaveBeenCalledTimes(2);
    expect(log).toContain('c1 OK');
    expect(log).toContain('c2 OK');
  });

  test('單條撥號失敗不影響其他條、整體不 throw', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
    loadDecryptedConn.mockImplementation(async (id) => ({ id, name: `c${id}`, vpn_forward_port: 11000 + id }));
    ensureGatewayRunning
      .mockRejectedValueOnce(new Error('撥號逾時'))
      .mockResolvedValueOnce({ forwardPort: 11002 });
    const log = await startProjectVpns(7);
    expect(ensureGatewayRunning).toHaveBeenCalledTimes(2);   // 第一條失敗仍嘗試第二條
    expect(log).toContain('c1 FAIL 撥號逾時');
    expect(log).toContain('c2 OK');
  });

  test('未配轉發埠的連線跳過、不呼叫 ensureGatewayRunning', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });
    loadDecryptedConn.mockResolvedValue({ id: 1, name: 'legacy', vpn_forward_port: null });
    const log = await startProjectVpns(7);
    expect(ensureGatewayRunning).not.toHaveBeenCalled();
    expect(log).toContain('legacy SKIP');
  });

  test('無 vpn_enabled 連線時不碰 gateway、回空字串', async () => {
    query.mockResolvedValue({ rows: [] });
    const log = await startProjectVpns(7);
    expect(ensureGatewayRunning).not.toHaveBeenCalled();
    expect(log).toBe('');
  });
});

describe('stopProjectVpns', () => {
  test('對每條 vpn_enabled 連線都 stopGateway', async () => {
    query.mockResolvedValue({ rows: [
      { id: 1, vpn_container_name: 'vpn-conn-1' },
      { id: 2, vpn_container_name: 'vpn-conn-2' },
    ] });
    await stopProjectVpns(7);
    expect(stopGateway).toHaveBeenCalledTimes(2);
    expect(stopGateway).toHaveBeenCalledWith(expect.objectContaining({ vpn_container_name: 'vpn-conn-1' }), expect.anything());
  });

  test('stopGateway 丟錯不會讓 stopProjectVpns throw（不擋停機）', async () => {
    query.mockResolvedValue({ rows: [{ id: 1, vpn_container_name: 'vpn-conn-1' }] });
    stopGateway.mockImplementation(() => { throw new Error('docker 掛了'); });
    await expect(stopProjectVpns(7)).resolves.toBeUndefined();
  });
});
