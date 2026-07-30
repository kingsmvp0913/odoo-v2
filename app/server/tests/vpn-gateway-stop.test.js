const { stopGateway, removeGateway } = require('../lib/vpn-gateway');

// docker 呼叫全面非同步化後，注入點從 execFileSync 換成 callback 形式的 execFile
// （簽名 (cmd, args, opts, cb)），兩個函式都回 Promise，呼叫端要 await。
// 「容器不存在不丟錯」的 intent 不變，只是從「同步不 throw」變成「Promise 不 reject」。
function okExecFile() {
  return jest.fn((cmd, args, opts, cb) => process.nextTick(() => cb(null, '')));
}
function failExecFile() {
  return jest.fn((cmd, args, opts, cb) => process.nextTick(() => cb(new Error('no such container'))));
}

test('stopGateway 呼叫 docker stop', async () => {
  const execFile = okExecFile();
  await stopGateway({ containerName: 'vpn-proj-2' }, { execFile });
  expect(execFile).toHaveBeenCalledWith('docker', ['stop', 'vpn-proj-2'], expect.any(Object), expect.any(Function));
});

test('stopGateway 容器不存在時不丟出錯誤', async () => {
  await expect(stopGateway({ containerName: 'vpn-proj-2' }, { execFile: failExecFile() })).resolves.toBeUndefined();
});

test('removeGateway 呼叫 docker rm -f', async () => {
  const execFile = okExecFile();
  await removeGateway({ containerName: 'vpn-proj-2' }, { execFile });
  expect(execFile).toHaveBeenCalledWith('docker', ['rm', '-f', 'vpn-proj-2'], expect.any(Object), expect.any(Function));
});

test('removeGateway 容器不存在時不丟出錯誤', async () => {
  await expect(removeGateway({ containerName: 'vpn-proj-2' }, { execFile: failExecFile() })).resolves.toBeUndefined();
});
