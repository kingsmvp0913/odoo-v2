const fs = require('fs');
const os = require('os');
const path = require('path');
const { restoreHandoff, snapshotMemory, memorySlug } = require('../../../scripts/lib/handoff');

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-root-'));
  for (const [rel, body] of Object.entries(files)) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
  return root;
}

const withRtk = { execFileSync: () => '/usr/bin/rtk' };
const noRtk = { execFileSync: () => { throw new Error('not found'); } };

describe('restoreHandoff', () => {
  let home;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-home-')); });

  test('記憶落在由 repo 路徑推導的 slug 目錄，新機器換 clone 路徑不必手改', () => {
    const root = makeRepo({ 'docs/handoff/memory/a.md': 'fact a' });

    restoreHandoff({ root, home, deps: withRtk });

    const dest = path.join(home, '.claude', 'projects', memorySlug(root), 'memory', 'a.md');
    expect(fs.readFileSync(dest, 'utf8')).toBe('fact a');
  });

  test('已存在的記憶不被覆蓋——覆蓋會把新機器上更新過的事實打回快照當時的舊版', () => {
    const root = makeRepo({ 'docs/handoff/memory/a.md': '快照版（舊）' });
    const dest = path.join(home, '.claude', 'projects', memorySlug(root), 'memory');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'a.md'), '本機版（新）');

    const { steps } = restoreHandoff({ root, home, deps: withRtk });

    expect(fs.readFileSync(path.join(dest, 'a.md'), 'utf8')).toBe('本機版（新）');
    expect(steps.find((s) => s.name === '開發記憶').status).toBe('skipped');
  });

  test('rtk 的個人過濾設定跟著走——少了它新機器的輸出過濾行為與舊機器不同', () => {
    const root = makeRepo({ 'docs/handoff/rtk-config/filters.toml': 'max_lines = 40' });

    restoreHandoff({ root, home, deps: withRtk });

    expect(fs.readFileSync(path.join(home, '.config', 'rtk', 'filters.toml'), 'utf8')).toBe('max_lines = 40');
  });

  test('settings.json 只補缺鍵，既有的本機專屬設定不被洗掉', () => {
    const root = makeRepo({
      'docs/handoff/claude-home/settings.json': JSON.stringify({ model: 'opus[1m]', theme: 'dark' }),
    });
    const dest = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify({ theme: 'light' }));

    restoreHandoff({ root, home, deps: withRtk });

    expect(JSON.parse(fs.readFileSync(dest, 'utf8'))).toEqual({ theme: 'light', model: 'opus[1m]' });
  });

  test('本機沒有 rtk 時不寫入 rtk hook——寫了會讓之後每一次 Bash 呼叫都跑不存在的指令', () => {
    const root = makeRepo({
      'docs/handoff/claude-home/settings.json': JSON.stringify({
        model: 'opus[1m]',
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] },
      }),
    });

    const { steps } = restoreHandoff({ root, home, deps: noRtk });

    const written = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    expect(written.hooks).toBeUndefined();
    expect(written.model).toBe('opus[1m]');
    expect(steps.find((s) => s.name === 'rtk hook').status).toBe('skipped');
  });

  test('rtk 在時 hook 照常寫入', () => {
    const root = makeRepo({
      'docs/handoff/claude-home/settings.json': JSON.stringify({ hooks: { PreToolUse: [] } }),
    });

    restoreHandoff({ root, home, deps: withRtk });

    const written = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    expect(written.hooks).toEqual({ PreToolUse: [] });
  });

  test('接手包不存在時只回報跳過，不讓整個安裝中斷', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-empty-'));

    const { steps } = restoreHandoff({ root, home, deps: withRtk });

    expect(steps).toEqual([{ name: '接手包', status: 'skipped', detail: expect.stringContaining('docs') }]);
  });
});

describe('snapshotMemory', () => {
  function makeLiveMemory(root, files) {
    const dir = path.join(root, '.home', '.claude', 'projects', memorySlug(root), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return path.join(root, '.home');
  }

  test('客戶專案記憶不進接手包，索引裡指向它的那行也一起拿掉', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-snap-'));
    const home = makeLiveMemory(root, {
      'MEMORY.md': '# Index\n- [平台](platform-thing.md) — hook\n- [鴻久](hungjou-272-review.md) — hook\n',
      'platform-thing.md': 'platform fact',
      'hungjou-272-review.md': 'customer fact',
    });

    const r = snapshotMemory({ root, home });

    const dest = path.join(root, 'docs', 'handoff', 'memory');
    expect(fs.existsSync(path.join(dest, 'platform-thing.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'hungjou-272-review.md'))).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'MEMORY.md'), 'utf8')).not.toContain('鴻久');
    expect(r.skipped).toEqual(['hungjou-272-review.md']);
  });

  test('本機已刪掉的記憶，快照也跟著刪——留著等於把被推翻的事實傳給下一台機器', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-snap-'));
    const home = makeLiveMemory(root, { 'still-true.md': 'fact' });
    const dest = path.join(root, 'docs', 'handoff', 'memory');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'was-deleted.md'), 'obsolete');

    const r = snapshotMemory({ root, home });

    expect(fs.existsSync(path.join(dest, 'was-deleted.md'))).toBe(false);
    expect(r.removed).toEqual(['was-deleted.md']);
  });

  test('本機沒有記憶目錄時回報錯誤，不產生空快照蓋掉既有的', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-snap-'));

    expect(snapshotMemory({ root, home: path.join(root, 'nope') }).error).toContain('找不到本機記憶目錄');
  });
});
