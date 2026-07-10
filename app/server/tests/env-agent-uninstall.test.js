// uninstallModule 的環境防呆分支：專案環境沒建過（venv/.ready 不在）時，
// module 不可能裝過 → 直接回 skipped_no_env，且「不 spawn odoo-bin」。
// 意圖：刪任務對從未部署過的專案不該真的去跑 odoo shell（浪費且可能報錯）。
jest.mock('../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [{ name: 'nonexistent_env_for_test', folder_name: null }] }),
}));

const cp = require('child_process');
const spawnSpy = jest.spyOn(cp, 'spawn');

const { uninstallModule } = require('../pipeline/env-agent');

test('環境沒建過 → 回 skipped_no_env，且不 spawn odoo-bin', async () => {
  const r = await uninstallModule(999, 'idx_whatever');
  expect(r).toEqual({ result: 'skipped_no_env' });
  expect(spawnSpy).not.toHaveBeenCalled();
});
