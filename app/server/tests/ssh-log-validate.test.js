const { validateLogParams } = require('../lib/ssh-log');

const AT = '2026-08-10T14:23:00+08:00';

test('at 必填', () => {
  expect(validateLogParams({}).ok).toBe(false);
  expect(validateLogParams({}).error).toContain('at');
});

test('at 必須可解析', () => {
  expect(validateLogParams({ at: '昨天下午' }).ok).toBe(false);
});

test('at 沒有時區偏移時被拒絕', () => {
  const r = validateLogParams({ at: '2026-08-10T14:23:00' });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('時區');
});

test('at 接受 Z（UTC）時區', () => {
  const r = validateLogParams({ at: '2026-08-10T14:23:00Z' });
  expect(r.ok).toBe(true);
});

test('at 接受小寫 z（UTC）時區', () => {
  const r = validateLogParams({ at: '2026-08-10T06:23:00z' });
  expect(r.ok).toBe(true);
  expect(r.atMs).toBe(Date.parse('2026-08-10T06:23:00Z'));
});

test('at 接受 ±HH:MM 時區格式', () => {
  const r = validateLogParams({ at: '2026-08-10T14:23:00+08:00' });
  expect(r.ok).toBe(true);
});

test('at 解析為 UTC 毫秒', () => {
  const r = validateLogParams({ at: AT });
  expect(r.ok).toBe(true);
  expect(r.atMs).toBe(Date.parse('2026-08-10T06:23:00Z'));
});

test('window 預設 10', () => {
  expect(validateLogParams({ at: AT }).windowMin).toBe(10);
});

test('window 只接受 10/30/60', () => {
  expect(validateLogParams({ at: AT, window: 30 }).ok).toBe(true);
  expect(validateLogParams({ at: AT, window: 30 }).windowMin).toBe(30);
  expect(validateLogParams({ at: AT, window: 60 }).ok).toBe(true);
  expect(validateLogParams({ at: AT, window: 60 }).windowMin).toBe(60);
  expect(validateLogParams({ at: AT, window: 15 }).ok).toBe(false);
  expect(validateLogParams({ at: AT, window: 1440 }).ok).toBe(false);
});

test('level 預設 ERROR', () => {
  expect(validateLogParams({ at: AT }).level).toBe('ERROR');
});

test('level 只接受四種', () => {
  expect(validateLogParams({ at: AT, level: 'TRACE' }).ok).toBe(false);
});

test('level 小寫被轉成大寫', () => {
  expect(validateLogParams({ at: AT, level: 'error' }).level).toBe('ERROR');
  expect(validateLogParams({ at: AT, level: 'info' }).level).toBe('INFO');
});

// 量大的是級別而非時間：INFO 含每個 HTTP request，±60 分鐘幾乎必然觸發截斷，
// agent 付了撈兩小時的成本卻只拿到被砍過的前 64KB。在參數層擋掉此組合。
test('INFO/ALL 的 window 上限為 10', () => {
  expect(validateLogParams({ at: AT, level: 'INFO', window: 30 }).ok).toBe(false);
  expect(validateLogParams({ at: AT, level: 'ALL', window: 60 }).ok).toBe(false);
  expect(validateLogParams({ at: AT, level: 'INFO', window: 10 }).ok).toBe(true);
});

test('拒絕時說明原因而非靜默降級', () => {
  const r = validateLogParams({ at: AT, level: 'INFO', window: 60 });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('INFO');
  expect(r.error).toContain('10');
});

test('keyword 為選填且原樣帶出（不進指令，故不需白名單）', () => {
  expect(validateLogParams({ at: AT, keyword: '; rm -rf /' }).keyword).toBe('; rm -rf /');
  expect(validateLogParams({ at: AT }).keyword).toBe('');
});
