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
    const result = applyVpnForward(conn, 11005);
    expect(result).toEqual({ ...conn, ssh_host: '127.0.0.1', ssh_port: 11005 });
  });

  test('direct 模式：替換 db_host/db_port，其餘欄位不變', () => {
    const conn = { id: 2, connect_mode: 'direct', db_host: 'db.example.com', db_port: 5432, db_user: 'reader' };
    const result = applyVpnForward(conn, 11006);
    expect(result).toEqual({ ...conn, db_host: '127.0.0.1', db_port: 11006 });
  });
});

describe('runSelect 的 VPN 分支', () => {
  const vpnDirectConn = {
    id: 9, connect_mode: 'direct', vpn_enabled: true,
    db_host: 'db.example.com', db_port: 5432, db_user: 'reader', db_password: 'pw', db_name: 'odoo_prd', db_ssl: false,
  };

  test('vpn_enabled 為真時，呼叫 ensureGatewayRunning 並用轉發位址連線', async () => {
    ensureGatewayRunning.mockResolvedValue({ forwardPort: 11009 });
    await runSelect(vpnDirectConn, 'SELECT 1');

    expect(ensureGatewayRunning).toHaveBeenCalledWith(vpnDirectConn);
    expect(mockPgClientCtor).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 11009 }));
  });

  test('vpn_enabled 為假（或未設）時，完全不呼叫 ensureGatewayRunning，行為與現有一致', async () => {
    const plainConn = { ...vpnDirectConn, vpn_enabled: false };
    await runSelect(plainConn, 'SELECT 1');

    expect(ensureGatewayRunning).not.toHaveBeenCalled();
    expect(mockPgClientCtor).toHaveBeenCalledWith(expect.objectContaining({ host: 'db.example.com', port: 5432 }));
  });

  test('Gateway 撥號失敗時，回傳 [VPN] 前綴錯誤，不嘗試連資料庫', async () => {
    ensureGatewayRunning.mockRejectedValue(new Error('VPN 連線逾時（25 秒內轉發 port 未就緒），請確認 VPN 帳號密碼與設定檔是否正確'));
    const result = await runSelect(vpnDirectConn, 'SELECT 1');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^\[VPN\]/);
    expect(mockPgClientCtor).not.toHaveBeenCalled();
  });

  test('direct 模式 + db_ssl + vpn_enabled 同時開啟時，直接回傳明確錯誤，不啟動 Gateway 也不嘗試連線', async () => {
    const conn = { ...vpnDirectConn, db_ssl: true };
    const result = await runSelect(conn, 'SELECT 1');

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/\[VPN\]/) });
    expect(ensureGatewayRunning).not.toHaveBeenCalled();
    expect(mockPgClientCtor).not.toHaveBeenCalled();
  });
});
