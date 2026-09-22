// 意圖：錯誤訊息與 log 裡的「專案」要指得出是哪一家客戶。寫 id 等於要讀的人自己去翻資料庫，
// 實務上沒人翻——所以 projectLabel 一律回名字。
// 反面同樣重要：查不到名字時**不得**吞掉 id，否則訊息變成「專案「」失敗」，連唯一的線索都沒了。
let mockQuery;
jest.mock('../db', () => ({ query: (...a) => mockQuery(...a) }));
const { projectLabel } = require('../lib/project-ref');

test('查得到 → 回專案名稱', async () => {
  mockQuery = async () => ({ rows: [{ name: '鴻久' }] });
  expect(await projectLabel(7)).toBe('鴻久');
});

test('專案已刪／id 是髒資料 → 退回 #id，不得只剩空字串', async () => {
  mockQuery = async () => ({ rows: [] });
  expect(await projectLabel(7)).toBe('#7');
});

test('id 是 null → 不打 DB，回一句人看得懂的話', async () => {
  mockQuery = async () => { throw new Error('不該查 DB'); };
  expect(await projectLabel(null)).toBe('（未指定專案）');
});
