// 意圖：切換到容器後 HOME 換了，舊 session 必定找不到。要能分辨「session 不在」與「CLI 其他錯誤」，
// 時間軸才寫得出人看得懂的原因。比照 sandbox-signature.js：只收 CLI 自己印的字面，不收籠統詞。
const sig = require('../pipeline/session-signature');

// 閘門：佔位文字本身也含 UUID，不擋的話沒貼 M2 實測值測試照樣綠
test('SAMPLE_LINE 已換成 M2 實測值（不是計畫裡的佔位文字）', () => {
  expect(sig.SAMPLE_LINE).not.toMatch(/M2 Step 2|逐字抄下/);
});

test('M2 實測的那行（換一個 session id）也認得出來', () => {
  const other = sig.SAMPLE_LINE.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, '12345678-abcd-4def-8abc-1234567890ab');
  expect(sig.looksLikeMissingSession(`something before\n${other}\nafter`)).toBe(true);
  expect(sig.missingSessionReason(other)).toBe(other.trim().slice(0, 300));
});

test.each([
  'Error: Not logged in',
  'API Error: 529 overloaded',
  'claude exited with code 1',
  'No such file or directory',
  'session',
])('其他錯誤不誤判：%s', (t) => {
  expect(sig.looksLikeMissingSession(t)).toBe(false);
});
