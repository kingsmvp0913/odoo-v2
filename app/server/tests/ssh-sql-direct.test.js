// direct 模式：pg 直連 TCP。mock pg.Client，驗證分叉、格式一致、SSL 開關與唯讀防護。
const mockClient = { connect: jest.fn(), query: jest.fn(), end: jest.fn() };
const mockClientCtor = jest.fn(() => mockClient);
jest.mock('pg', () => ({ Client: mockClientCtor }));

const { runSelect } = require('../lib/ssh-sql');
const ClientCtor = mockClientCtor;

const base = {
  connect_mode: 'direct',
  db_host: 'db.example.com', db_port: 5432,
  db_user: 'reader', db_password: 'pw', db_name: 'odoo_prd', db_ssl: false,
};

beforeEach(() => {
  ClientCtor.mockClear();
  mockClient.connect.mockReset().mockResolvedValue();
  mockClient.query.mockReset();
  mockClient.end.mockReset().mockResolvedValue();
});

test('direct 成功：回傳格式與 SSH 路徑一致（columns/rows 為字串陣列）', async () => {
  mockClient.query.mockResolvedValue({
    fields: [{ name: 'id' }, { name: 'login' }],
    rows: [[1, 'admin'], [6, 'user1']],
  });
  const res = await runSelect(base, 'SELECT id, login FROM res_users');
  expect(res).toEqual({ ok: true, columns: ['id', 'login'], rows: [['1', 'admin'], ['6', 'user1']], row_count: 2 });
  // 以 rowMode:'array' 查詢，避免重複欄名塌陷
  expect(mockClient.query).toHaveBeenCalledWith({ text: 'SELECT id, login FROM res_users', rowMode: 'array' });
  expect(mockClient.end).toHaveBeenCalled();
});

test('direct 連線參數帶入 host/port/user/password/database', async () => {
  mockClient.query.mockResolvedValue({ fields: [], rows: [] });
  await runSelect(base, 'SELECT 1');
  expect(ClientCtor).toHaveBeenCalledWith(expect.objectContaining({
    host: 'db.example.com', port: 5432, user: 'reader', password: 'pw', database: 'odoo_prd',
  }));
});

test('db_ssl=true → ssl:{rejectUnauthorized:false}；false → ssl:false', async () => {
  mockClient.query.mockResolvedValue({ fields: [], rows: [] });
  await runSelect({ ...base, db_ssl: true }, 'SELECT 1');
  expect(ClientCtor.mock.calls[0][0].ssl).toEqual({ rejectUnauthorized: false });
  ClientCtor.mockClear();
  await runSelect({ ...base, db_ssl: false }, 'SELECT 1');
  expect(ClientCtor.mock.calls[0][0].ssl).toBe(false);
});

test('NULL 值轉空字串（對齊 --csv 語意）', async () => {
  mockClient.query.mockResolvedValue({ fields: [{ name: 'a' }], rows: [[null]] });
  const res = await runSelect(base, 'SELECT a FROM t');
  expect(res.rows).toEqual([['']]);
});

test('direct 模式非 SELECT 一樣被擋（不建立連線）', async () => {
  const res = await runSelect(base, 'DELETE FROM t');
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/不允許/);
  expect(ClientCtor).not.toHaveBeenCalled();
});

test('direct 連線失敗 → ok:false，錯誤標記 [DIRECT]，仍呼叫 end', async () => {
  mockClient.connect.mockRejectedValue(new Error('ECONNREFUSED'));
  const res = await runSelect(base, 'SELECT 1');
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/^\[DIRECT\]/);
  expect(res.error).toMatch(/ECONNREFUSED/);
  expect(mockClient.end).toHaveBeenCalled();
});
