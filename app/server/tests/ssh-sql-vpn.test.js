// VPN 轉發：runSelect 在 vpn_enabled 時應改用 127.0.0.1:<forwardPort> 查詢，其餘邏輯不變。
jest.mock('../lib/vpn-gateway', () => ({ ensureGatewayRunning: jest.fn() }));
const { ensureGatewayRunning } = require('../lib/vpn-gateway');

const mockPgClient = { connect: jest.fn(), query: jest.fn(), end: jest.fn() };
const mockPgClientCtor = jest.fn(() => mockPgClient);
jest.mock('pg', () => ({ Client: mockPgClientCtor }));

const { runSelect, applyVpnForward } = require('../lib/ssh-sql');

beforeEach(() => {
  ensureGatewayRunning.mockReset();
  mockPgClientCtor.mockClear();
  mockPgClient.connect.mockReset().mockResolvedValue();
  mockPgClient.query.mockReset().mockResolvedValue({ fields: [], rows: [] });
  mockPgClient.end.mockReset().mockResolvedValue();
});

describe('applyVpnForward（純函式）', () => {
  test('非 direct 模式：替換 ssh_host/ssh_port，其餘欄位不變', () => {
    const conn = { id: 1, connect_mode: 'docker', ssh_host: '1.2.3.4', ssh_port: 22, docker_container: 'c' };
    const result = applyVpnForward(conn, 22005);
    expect(result).toEqual({ ...conn, ssh_host: '127.0.0.1', ssh_port: 22005 });
  });

  test('direct 模式：替換 db_host/db_port，其餘欄位不變', () => {
    const conn = { id: 2, connect_mode: 'direct', db_host: 'db.example.com', db_port: 5432, db_user: 'reader' };
    const result = applyVpnForward(conn, 22006);
    expect(result).toEqual({ ...conn, db_host: '127.0.0.1', db_port: 22006 });
  });
});

describe('runSelect 的 VPN 分支', () => {
  const gw = {
    containerName: 'vpn-proj-2', config: 'cfg', username: 'u', password: 'p',
    targets: [{ forwardPort: 22009, host: 'db.example.com', port: 5432 }], staleContainers: [],
  };
  const vpnDirectConn = {
    id: 9, connect_mode: 'direct', vpn_enabled: true, vpn_forward_port: 22009, vpn: gw,
    db_host: 'db.example.com', db_port: 5432, db_user: 'reader', db_password: 'pw', db_name: 'odoo_prd', db_ssl: false,
  };

  test('vpn_enabled 為真時，用 conn.vpn 撥號並改連轉發位址', async () => {
    ensureGatewayRunning.mockResolvedValue({ containerName: 'vpn-proj-2', targetsSpec: 'x' });
    await runSelect(vpnDirectConn, 'SELECT 1');
    expect(ensureGatewayRunning).toHaveBeenCalledWith(gw);
    expect(mockPgClientCtor).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 22009 }));
  });

  test('vpn_enabled 為假時完全不撥號，行為與現有一致', async () => {
    await runSelect({ ...vpnDirectConn, vpn_enabled: false }, 'SELECT 1');
    expect(ensureGatewayRunning).not.toHaveBeenCalled();
    expect(mockPgClientCtor).toHaveBeenCalledWith(expect.objectContaining({ host: 'db.example.com', port: 5432 }));
  });

  // 白撥號只會浪費 40 秒然後給一個看不懂的逾時訊息；缺設定要當場講清楚要去哪裡補。
  test('連線勾了 VPN 但專案沒設定時，回明確錯誤且完全不碰 docker', async () => {
    const result = await runSelect({ ...vpnDirectConn, vpn: null }, 'SELECT 1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/專案尚未設定 VPN/);
    expect(ensureGatewayRunning).not.toHaveBeenCalled();
    expect(mockPgClientCtor).not.toHaveBeenCalled();
  });

  test('連線沒配到轉發埠時，回明確錯誤且不撥號', async () => {
    const result = await runSelect({ ...vpnDirectConn, vpn_forward_port: null }, 'SELECT 1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/尚未配置轉發埠/);
    expect(ensureGatewayRunning).not.toHaveBeenCalled();
  });

  test('Gateway 撥號失敗時回 [VPN] 前綴錯誤，不嘗試連資料庫', async () => {
    ensureGatewayRunning.mockRejectedValue(new Error('VPN 連線逾時（40 秒內未能透過隧道連到 db.example.com:5432）'));
    const result = await runSelect(vpnDirectConn, 'SELECT 1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^\[VPN\]/);
    expect(mockPgClientCtor).not.toHaveBeenCalled();
  });

  test('direct + db_ssl + vpn_enabled 同時開啟時，直接回錯不撥號（轉發後主機變 127.0.0.1，憑證驗證必失敗）', async () => {
    const result = await runSelect({ ...vpnDirectConn, db_ssl: true }, 'SELECT 1');
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/\[VPN\]/) });
    expect(ensureGatewayRunning).not.toHaveBeenCalled();
    expect(mockPgClientCtor).not.toHaveBeenCalled();
  });
});
