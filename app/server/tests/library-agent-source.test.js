const { _collectModuleSource } = require('../pipeline/library-agent');

test('rejects path traversal moduleName', () => {
  expect(_collectModuleSource([{ local_path: '/tmp' }], '../../etc')).toBe('');
  expect(_collectModuleSource([{ local_path: '/tmp' }], '..')).toBe('');
  expect(_collectModuleSource([{ local_path: '/tmp' }], 'a/b')).toBe('');
  expect(_collectModuleSource([{ local_path: '/tmp' }], '')).toBe('');
});

test('allows safe module identifier (no dir → empty string, no throw)', () => {
  // 安全名稱通過守衛；目錄不存在時回空字串（不拋錯）
  expect(_collectModuleSource([{ local_path: '/nonexistent-xyz' }], 'sale_ext')).toBe('');
});
