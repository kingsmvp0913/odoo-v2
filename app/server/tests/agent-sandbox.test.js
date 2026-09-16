// 意圖：隔離的正確性全在「docker run 帶了什麼參數」。這裡鎖死規格 §8.1 的每一條：
// 就算平台行程的 env 裡有，容器也拿不到三把總鑰匙；.git/config 與 hooks 一定唯讀（否則平台在主機跑 git
// 時會執行容器寫進去的指令＝逃出容器）；網路、--rm、cap-drop、no-new-privileges、三個資源上限一個都不能少。
const s = require('../lib/agent-sandbox');

function baseRun(over = {}) {
  return {
    instanceId: 'odoo-v2', runId: 'abcd1234abcd1234', scope: 'project-7', image: 'aidev-agent:2.1.266',
    network: 'odoo-v2-agent-net', user: '1004:1004',
    mounts: [{ source: '/srv/repos/p7/.worktrees/t1', readonly: false }],
    workdir: '/srv/repos/p7/.worktrees/t1', home: '/srv/app/data/agent-home/project-7',
    env: { AIDEV_AI_BASE: 'http://odoo-v2-gw:8080', AIDEV_AI_TOKEN: 'tok-secret-value', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-value' },
    limits: { memory: '4g', cpus: '2', pids: 512 },
    command: ['claude', '-p', '--output-format', 'stream-json'],
    ...over,
  };
}
const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];

describe('env 白名單', () => {
  const saved = {};
  beforeAll(() => { for (const k of ['APP_SECRET', 'JWT_SECRET', 'DATABASE_URL']) { saved[k] = process.env[k]; process.env[k] = `leak-${k}`; } });
  afterAll(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('平台 env 裡有三把總鑰匙，argv 與 childEnv 都沒有', () => {
    const { argv, childEnv } = s.buildAgentRunArgs(baseRun());
    const all = JSON.stringify([argv, childEnv]);
    for (const k of ['APP_SECRET', 'JWT_SECRET', 'DATABASE_URL']) {
      expect(all).not.toContain(k);
      expect(all).not.toContain(`leak-${k}`);
    }
  });
  test('呼叫端硬塞總鑰匙 → 丟例外', () => {
    expect(() => s.buildAgentRunArgs(baseRun({ env: { APP_SECRET: 'x' } }))).toThrow(/APP_SECRET/);
  });
  // 寫錯 key（或把整包 gitEnv 帶進來，裡面有 GIT_PAT）不能靜默丟掉，否則會以為有傳、實際沒傳
  test('白名單外的 key → 丟例外，訊息點名那個 key', () => {
    expect(() => s.buildAgentRunArgs(baseRun({ env: { GIT_PAT: 'ghp_x' } }))).toThrow(/GIT_PAT/);
    expect(() => s.buildAgentRunArgs(baseRun({ env: { HOME: '/root' } }))).toThrow(/HOME/);
  });
  test('祕密值不進 argv（只以 -e KEY 傳名字），值在 childEnv', () => {
    const { argv, childEnv } = s.buildAgentRunArgs(baseRun());
    expect(argv.join(' ')).not.toContain('tok-secret-value');
    expect(argv.join(' ')).not.toContain('oauth-secret-value');
    expect(argv).toContain('AIDEV_AI_TOKEN');
    expect(childEnv.AIDEV_AI_TOKEN).toBe('tok-secret-value');
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-secret-value');
  });
  test('非祕密值以 KEY=VALUE 傳；HOME 固定指向 scope 家目錄', () => {
    const { argv } = s.buildAgentRunArgs(baseRun());
    expect(argv).toContain('AIDEV_AI_BASE=http://odoo-v2-gw:8080');
    expect(argv).toContain('HOME=/srv/app/data/agent-home/project-7');
  });
  test('childEnv 只有 docker CLI 需要的 PATH 與祕密值', () => {
    const { childEnv } = s.buildAgentRunArgs(baseRun());
    expect(Object.keys(childEnv).sort()).toEqual(['AIDEV_AI_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'PATH'].sort());
  });
});

describe('容器參數', () => {
  test('--rm、-i、網路、cap-drop、no-new-privileges、read-only、tmpfs、user', () => {
    const { argv } = s.buildAgentRunArgs(baseRun());
    expect(argv.slice(0, 3)).toEqual(['run', '-i', '--rm']);
    expect(flagValue(argv, '--network')).toBe('odoo-v2-agent-net');
    expect(flagValue(argv, '--cap-drop')).toBe('ALL');
    expect(flagValue(argv, '--security-opt')).toBe('no-new-privileges');
    expect(argv).toContain('--read-only');
    expect(flagValue(argv, '--tmpfs')).toBe('/tmp');
    expect(flagValue(argv, '--user')).toBe('1004:1004');
    expect(flagValue(argv, '--workdir')).toBe('/srv/repos/p7/.worktrees/t1');
  });
  test('名稱與 label 帶實例 id（兩套平台不互砍）', () => {
    const { argv, containerName } = s.buildAgentRunArgs(baseRun());
    expect(containerName).toBe('odoo-v2-run-abcd1234abcd1234');
    expect(flagValue(argv, '--name')).toBe(containerName);
    expect(argv).toEqual(expect.arrayContaining(['aidev.run=1', 'aidev.instance=odoo-v2', 'aidev.scope=project-7']));
  });
  test('三個資源上限都帶上；memory-swap 等於 memory（不給 swap 繞過上限）', () => {
    const { argv } = s.buildAgentRunArgs(baseRun());
    expect(flagValue(argv, '--memory')).toBe('4g');
    expect(flagValue(argv, '--memory-swap')).toBe('4g');
    expect(flagValue(argv, '--cpus')).toBe('2');
    expect(flagValue(argv, '--pids-limit')).toBe('512');
  });
  test.each(['memory', 'cpus', 'pids'])('缺 %s → 丟例外（沒有「不設上限」的預設）', (k) => {
    expect(() => s.buildAgentRunArgs(baseRun({ limits: { memory: '4g', cpus: '2', pids: 512, [k]: null } }))).toThrow(/上限/);
  });
  test('image 之後接 command，command 在最後', () => {
    const { argv } = s.buildAgentRunArgs(baseRun());
    const i = argv.indexOf('aidev-agent:2.1.266');
    expect(argv.slice(i + 1)).toEqual(['claude', '-p', '--output-format', 'stream-json']);
  });
  test('實例 id 缺或含非法字元 → 丟例外', () => {
    expect(() => s.buildAgentRunArgs(baseRun({ instanceId: '' }))).toThrow();
    expect(() => s.buildAgentRunArgs(baseRun({ instanceId: 'a b' }))).toThrow();
  });
});

describe('掛載', () => {
  test('用 --mount（來源不存在時 docker 會報錯，不會默默建一個 root 擁有的空目錄）', () => {
    const { argv } = s.buildAgentRunArgs(baseRun());
    expect(argv).toContain('type=bind,source=/srv/repos/p7/.worktrees/t1,target=/srv/repos/p7/.worktrees/t1');
    expect(argv).not.toContain('-v');
  });
  test('gitDirMounts rw：.git 可寫，config 與 hooks 疊唯讀', () => {
    const m = s.gitDirMounts('/srv/repos/p7/main', 'rw');
    expect(m).toEqual([
      { source: '/srv/repos/p7/main/.git', readonly: false },
      { source: '/srv/repos/p7/main/.git/config', readonly: true },
      { source: '/srv/repos/p7/main/.git/hooks', readonly: true },
    ]);
  });
  test('唯讀覆蓋層排在父目錄之後（docker 依序疊，順序錯會被父層蓋掉）', () => {
    const mounts = [...s.gitDirMounts('/srv/r/.', 'rw')].reverse();
    const { argv } = s.buildAgentRunArgs(baseRun({ mounts }));
    const specs = argv.filter(a => a.startsWith('type=bind,'));
    const idxGit = specs.findIndex(x => x.includes('target=/srv/r/.git,') || x.endsWith('target=/srv/r/.git'));
    const idxCfg = specs.findIndex(x => x.includes('target=/srv/r/.git/config'));
    expect(idxGit).toBeLessThan(idxCfg);
    expect(specs[idxCfg]).toMatch(/,readonly$/);
  });
  test('相對路徑或含逗號的路徑 → 丟例外（--mount 以逗號分欄）', () => {
    expect(() => s.buildAgentRunArgs(baseRun({ mounts: [{ source: 'rel/path', readonly: true }] }))).toThrow();
    expect(() => s.buildAgentRunArgs(baseRun({ mounts: [{ source: '/a,b', readonly: true }] }))).toThrow();
  });
});
