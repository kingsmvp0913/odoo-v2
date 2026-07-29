const { stopGateway, removeGateway } = require('../lib/vpn-gateway');

test('stopGateway 呼叫 docker stop', () => {
  const execFileSync = jest.fn();
  stopGateway({ containerName: 'vpn-proj-2' }, { execFileSync });
  expect(execFileSync).toHaveBeenCalledWith('docker', ['stop', 'vpn-proj-2'], { stdio: 'ignore' });
});

test('stopGateway 容器不存在時不丟出錯誤', () => {
  const execFileSync = jest.fn(() => { throw new Error('no such container'); });
  expect(() => stopGateway({ containerName: 'vpn-proj-2' }, { execFileSync })).not.toThrow();
});

test('removeGateway 呼叫 docker rm -f', () => {
  const execFileSync = jest.fn();
  removeGateway({ containerName: 'vpn-proj-2' }, { execFileSync });
  expect(execFileSync).toHaveBeenCalledWith('docker', ['rm', '-f', 'vpn-proj-2'], { stdio: 'ignore' });
});

test('removeGateway 容器不存在時不丟出錯誤', () => {
  const execFileSync = jest.fn(() => { throw new Error('no such container'); });
  expect(() => removeGateway({ containerName: 'vpn-proj-2' }, { execFileSync })).not.toThrow();
});
