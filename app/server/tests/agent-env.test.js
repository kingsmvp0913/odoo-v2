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

// 原本逐行比對 spawn('claude' 那一行。2026-09-24 加上客戶自帶 key 之後，review.js 與
// challenge.js 的 spawn 選項跨了多行（env 要併進 authEnv），那種寫法讓這支守衛對不上，
// 而它守的東西並沒有變。改成看整個呼叫並先剝掉註解——註解裡出現 process.env 不代表
// 程式真的那樣寫，剝掉才不會被自己的說明文字騙過去。
test.each(['challenge.js', 'review.js', 'evidence.js'])('lib/exam/%s 的 spawn 帶 env 白名單', (f) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'exam', f), 'utf8');
  const spawnLines = src.split('\n').filter(l => l.includes("spawn('claude'"));
  expect(spawnLines.length).toBe(1);

  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const call = code.slice(code.indexOf("spawn('claude'"));
  const envExpr = call.slice(call.indexOf('env:'), call.indexOf('env:') + 120);

  // 白名單必須是 env 的**起點**。多給一層 { ... } 併別的東西可以（憑證就是這樣進去的），
  // 但起點不是白名單就等於把三把總鑰匙送進子行程。
  expect(envExpr).toMatch(/^env: (\{ \.\.\.)?pickLegacyEnv\(process\.env\)/);
  // 併進來的東西不得是整包 process.env——那會把白名單擋掉的鑰匙原封不動補回去。
  expect(envExpr).not.toMatch(/\.\.\.process\.env/);
});
