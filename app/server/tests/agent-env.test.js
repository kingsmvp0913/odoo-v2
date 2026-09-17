// 意圖：不進容器的 AI 子行程（考試、Codex）至少拿不到三把總鑰匙。白名單而不是黑名單：
// start.sh 之後又 export 了什麼（例如 ANTHROPIC_API_KEY、PLATFORM_CONTAINER）都不該默默傳下去。
const fs = require('fs');
const path = require('path');
const { pickLegacyEnv, LEGACY_ENV_KEYS } = require('../lib/agent-env');

test('只留系統變數與 git 加固；三把鑰匙與其他平台變數全部不留', () => {
  const src = {
    PATH: '/usr/bin', HOME: '/home/odoo', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'Asia/Taipei', TMPDIR: '/tmp',
    APP_SECRET: 's', JWT_SECRET: 'j', DATABASE_URL: 'postgres://x', ANTHROPIC_API_KEY: 'k', PLATFORM_CONTAINER: 'odoo-v2',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
  };
  const out = pickLegacyEnv(src);
  expect(out).toEqual({
    PATH: '/usr/bin', HOME: '/home/odoo', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'Asia/Taipei', TMPDIR: '/tmp',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
  });
  expect(LEGACY_ENV_KEYS).not.toEqual(expect.arrayContaining(['APP_SECRET']));
});

test.each(['challenge.js', 'review.js', 'evidence.js'])('lib/exam/%s 的 spawn 帶 env 白名單', (f) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'exam', f), 'utf8');
  const spawnLines = src.split('\n').filter(l => l.includes("spawn('claude'"));
  expect(spawnLines.length).toBe(1);
  expect(spawnLines[0]).toMatch(/env: pickLegacyEnv\(process\.env\)/);
});
