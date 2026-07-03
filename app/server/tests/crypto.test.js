process.env.APP_SECRET = 'test-secret-key';
const { encrypt, decrypt } = require('../lib/crypto');

test('加密後可解回原文', () => {
  const plain = 'my-ssh-password-中文';
  const blob = encrypt(plain);
  expect(blob).not.toContain(plain);
  expect(blob.split(':').length).toBe(3);
  expect(decrypt(blob)).toBe(plain);
});

test('APP_SECRET 未設時丟錯', () => {
  const saved = process.env.APP_SECRET;
  delete process.env.APP_SECRET;
  jest.resetModules();
  const c = require('../lib/crypto');
  expect(() => c.encrypt('x')).toThrow(/APP_SECRET/);
  process.env.APP_SECRET = saved;
});
