// 意圖：容器只掛「這一組修正」用得到的意見附件；抓錯 id 不是讀不到圖，就是讀到別張意見的圖。
const { feedbackIdsOf } = require('../pipeline/finding-fix');

test('只取 feedback 來源、轉成整數、去重（runFix 實際收到的記憶體形狀 m.row.id）', () => {
  expect(feedbackIdsOf([
    { source: 'feedback', row: { id: '3' } },
    { source: 'finding', row: { id: 9 } },
    { source: 'feedback', row: { id: 3 } },
    { source: 'feedback', row: { id: 12 } },
  ])).toEqual([3, 12]);
});

test('沒有 members（單一健檢提案）→ 空陣列', () => {
  expect(feedbackIdsOf(null)).toEqual([]);
  expect(feedbackIdsOf(undefined)).toEqual([]);
});

test('非正整數 id 丟掉（會進掛載路徑）', () => {
  expect(feedbackIdsOf([
    { source: 'feedback', row: { id: '../1' } },
    { source: 'feedback', row: { id: 0 } },
  ])).toEqual([]);
});

test('退化到 { source, id }（finding_fixes.members 落 DB 後的持久化形狀）', () => {
  expect(feedbackIdsOf([
    { source: 'feedback', id: '5' },
    { source: 'feedback', id: 5 },
  ])).toEqual([5]);
});
