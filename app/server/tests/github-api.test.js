const { buildIdentityFromResponses, fetchGitHubIdentity } = require('../lib/github-api');

test('buildIdentityFromResponses：取 primary+verified email', () => {
  const id = buildIdentityFromResponses(
    { id: 42, login: 'alice', name: 'Alice Wu' },
    [{ email: 'x@old.com', primary: false, verified: true },
     { email: 'alice@corp.com', primary: true, verified: true }]
  );
  expect(id).toEqual({ login: 'alice', name: 'Alice Wu', email: 'alice@corp.com' });
});

test('buildIdentityFromResponses：無公開/驗證 email → noreply', () => {
  const id = buildIdentityFromResponses({ id: 42, login: 'alice', name: null }, null);
  expect(id.email).toBe('42+alice@users.noreply.github.com');
  expect(id.name).toBe('alice'); // name 缺 → 退 login
});

test('fetchGitHubIdentity：401 → throw', async () => {
  const httpGet = async () => ({ status: 401, json: { message: 'Bad credentials' } });
  await expect(fetchGitHubIdentity('bad', httpGet)).rejects.toThrow(/認證失敗|Bad credentials|401/);
});

test('fetchGitHubIdentity：成功回身分', async () => {
  const httpGet = async (pathname) => pathname === '/user'
    ? { status: 200, json: { id: 7, login: 'bob', name: 'Bob' } }
    : { status: 200, json: [{ email: 'bob@corp.com', primary: true, verified: true }] };
  const id = await fetchGitHubIdentity('tok', httpGet);
  expect(id).toEqual({ login: 'bob', name: 'Bob', email: 'bob@corp.com' });
});
