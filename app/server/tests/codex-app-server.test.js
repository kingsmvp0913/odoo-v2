const { EventEmitter } = require('events');
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({ spawn: mockSpawn }));

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter(); child.stdin.writable = true; child.stdin.write = jest.fn();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = jest.fn();
  return child;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('codex app-server 訂閱登入橋接', () => {
  let child, lib;
  beforeEach(() => {
    jest.resetModules(); child = fakeChild(); mockSpawn.mockReturnValue(child);
    lib = require('../lib/codex-app-server');
  });
  afterEach(() => { lib._resetForTesting(); jest.clearAllMocks(); });
  function respond(id, result) { child.stdout.emit('data', Buffer.from(JSON.stringify({ id, result }) + '\n')); }

  test('裝置碼登入先走 initialize，僅回一次性網址與代碼，完成通知更新狀態', async () => {
    const login = lib.startDeviceLogin();
    await tick();
    expect(mockSpawn).toHaveBeenCalledWith('codex', ['app-server', '--stdio'], expect.objectContaining({ windowsHide: true }));
    expect(JSON.parse(child.stdin.write.mock.calls[0][0])).toMatchObject({ method: 'initialize', id: 1 });
    respond(1, {}); await tick();
    expect(JSON.parse(child.stdin.write.mock.calls[2][0])).toMatchObject({ method: 'account/login/start', id: 2, params: { type: 'chatgptDeviceCode' } });
    respond(2, { loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
    await expect(login).resolves.toMatchObject({ login_id: 'login-1', user_code: 'ABCD-1234', state: 'pending' });
    child.stdout.emit('data', Buffer.from(JSON.stringify({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } }) + '\n'));
    const status = lib.accountStatus(); await tick(); respond(3, { account: { type: 'chatgpt', email: 'a@example.com', planType: 'pro' } });
    await expect(status).resolves.toMatchObject({ configured: true, email: 'a@example.com', pending_login: null });
  });
});
