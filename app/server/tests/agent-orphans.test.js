// 意圖：重啟後殘留的 AI 容器要清，但只能清「本平台實例、本平台打過 label 的 AI 容器」。
// 同一台主機跑著約 110 個容器（開發順序 §2.4），多一個字的篩選錯誤就是砍到別人的服務。
const { removeOrphanAgentContainers } = require('../lib/agent-orphans');

function fake(psOut) {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => { calls.push([cmd, ...args]); cb(null, args[0] === 'ps' ? psOut : '', ''); };
  return { execFile, calls };
}

test('同時帶 aidev.run 與本實例 label 篩選，只刪列出來的 id', async () => {
  const f = fake('aaa111\nbbb222\n');
  const r = await removeOrphanAgentContainers({ execFile: f.execFile, instanceId: 'odoo-v2' });
  expect(f.calls[0]).toEqual(['docker', 'ps', '-aq', '--filter', 'label=aidev.run=1', '--filter', 'label=aidev.instance=odoo-v2']);
  expect(f.calls[1]).toEqual(['docker', 'rm', '-f', 'aaa111', 'bbb222']);
  expect(r).toEqual({ removed: 2 });
});

test('沒有殘留 → 不呼叫 rm', async () => {
  const f = fake('\n');
  await removeOrphanAgentContainers({ execFile: f.execFile, instanceId: 'odoo-v2' });
  expect(f.calls.some(c => c[1] === 'rm')).toBe(false);
});

test('取不到實例 id → 一個都不刪（寧可留著也不要只靠 aidev.run 篩）', async () => {
  const f = fake('aaa111\n');
  const r = await removeOrphanAgentContainers({ execFile: f.execFile, instanceId: () => { throw new Error('PLATFORM_CONTAINER 未設定'); } });
  expect(f.calls).toEqual([]);
  expect(r.removed).toBe(0);
  expect(r.skipped).toMatch(/PLATFORM_CONTAINER/);
});

test('ps 輸出含非容器 id 的字 → 丟例外，不把奇怪的字串交給 rm', async () => {
  const f = fake('aaa111\n--all\n');
  await expect(removeOrphanAgentContainers({ execFile: f.execFile, instanceId: 'odoo-v2' })).rejects.toThrow();
});
