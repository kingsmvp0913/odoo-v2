const { isInWindow, nextWindow } = require('../lib/release-window');
const CFG = { weekdays: [6, 0], startHour: 2, durationHours: 2 }; // 週六日 02:00-04:00

// 意圖：時段判斷算錯的後果不是報錯，是「該重啟的週末沒重啟」或「上班時間把人踢下線」，
// 兩種都不會有任何 log。所以邊界要逐一釘死，不能只測中間值。
test.each([
  ['2026-09-26T02:00:00+08:00', true,  '週六 02:00 整＝進場邊界，含'],
  ['2026-09-26T03:59:59+08:00', true,  '週六 03:59:59＝還在裡面'],
  ['2026-09-26T04:00:00+08:00', false, '週六 04:00 整＝出場邊界，不含'],
  ['2026-09-26T01:59:59+08:00', false, '週六 01:59:59＝還沒到'],
  ['2026-09-27T02:30:00+08:00', true,  '週日也是時段'],
  ['2026-09-25T02:30:00+08:00', false, '週五同一時刻不是時段'],
])('%s → %s（%s）', (iso, expected) => {
  expect(`${iso}: ${isInWindow(CFG, new Date(iso))}`).toBe(`${iso}: ${expected}`);
});

test('下一次時段：週五算出的是隔天週六', () => {
  const next = nextWindow(CFG, new Date('2026-09-25T10:00:00+08:00'));
  expect(next.toISOString()).toBe(new Date('2026-09-26T02:00:00+08:00').toISOString());
});

test('下一次時段：時段進行中算出的是「現在這一場」的開始，不是下週', () => {
  const next = nextWindow(CFG, new Date('2026-09-26T03:00:00+08:00'));
  expect(next.toISOString()).toBe(new Date('2026-09-26T02:00:00+08:00').toISOString());
});
