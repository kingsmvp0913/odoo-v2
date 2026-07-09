const { stopGateway, removeGateway } = require('../lib/vpn-gateway');

test('stopGateway 呼叫 docker stop', () => {
  const execFileSync = jest.fn();
  stopGateway({ id: 3, vpn_container_name: 'vpn-conn-3' }, { execFileSync });
  expect(execFileSync).toHaveBeenCalledWith('docker', ['stop', 'vpn-conn-3'], { stdio: 'ignore' });
});

test('stopGateway 沒有 vpn_container_name 時用 containerName(id) 推算', () => {
  const execFileSync = jest.fn();
  stopGateway({ id: 5 }, { execFileSync });
  expect(execFileSync).toHaveBeenCalledWith('docker', ['stop', 'vpn-conn-5'], { stdio: 'ignore' });
});

test('stopGateway 容器不存在時不丟出錯誤', () => {
  const execFileSync = jest.fn(() => { throw new Error('no such container'); });
  expect(() => stopGateway({ id: 3, vpn_container_name: 'vpn-conn-3' }, { execFileSync })).not.toThrow();
});

test('removeGateway 呼叫 docker rm -f', () => {
  const execFileSync = jest.fn();
  removeGateway({ id: 3, vpn_container_name: 'vpn-conn-3' }, { execFileSync });
  expect(execFileSync).toHaveBeenCalledWith('docker', ['rm', '-f', 'vpn-conn-3'], { stdio: 'ignore' });
});

test('removeGateway 容器不存在時不丟出錯誤', () => {
  const execFileSync = jest.fn(() => { throw new Error('no such container'); });
  expect(() => removeGateway({ id: 3, vpn_container_name: 'vpn-conn-3' }, { execFileSync })).not.toThrow();
});
