const { parseCsv } = require('../lib/ssh-sql');

test('解析基本 CSV', () => {
  expect(parseCsv('id,login\n2,admin\n6,user1')).toEqual([['id','login'],['2','admin'],['6','user1']]);
});

test('欄位內含逗號與換行（引號包圍）', () => {
  expect(parseCsv('a,b\n"x,y","line1\nline2"')).toEqual([['a','b'],['x,y','line1\nline2']]);
});
