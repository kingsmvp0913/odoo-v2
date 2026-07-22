// uninstallModule 的環境防呆分支：容器不存在／未運行時（等同環境沒建過），module 不可能裝過
// → 直接回 skipped_no_env，且「不進 execOdoo」。意圖：刪任務對從未部署過的專案不該真的去跑
// odoo shell（浪費且可能報錯）。
jest.mock('../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ name: 'nonexistent_env_for_test', folder_name: null, odoo_version: '17.0', port: 8070 }] }),
}));
jest.mock('../lib/docker-env', () => {
  const actual = jest.requireActual('../lib/docker-env');
  return { ...actual, containerRunning: jest.fn().mockResolvedValue(false), execOdoo: jest.fn() };
});

const dockerEnv = require('../lib/docker-env');
const { uninstallModule } = require('../pipeline/env-agent');

test('容器未運行（等同環境沒建過）→ 回 skipped_no_env，且不跑 execOdoo', async () => {
  const r = await uninstallModule(999, 'idx_whatever');
  expect(r).toEqual({ result: 'skipped_no_env' });
  expect(dockerEnv.execOdoo).not.toHaveBeenCalled();
});
