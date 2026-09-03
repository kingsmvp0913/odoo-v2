// 維護視窗：單一真相測試。旗標用「到期時間」不是布林——過期自動失效是最重要的一支
// （布林卡在 true 會讓派工安靜地停擺，此 repo 踩過：夜班空轉 98 輪無人察覺）。
//
// runPipeline／cron 的整合測試拆到獨立檔（maintenance-runner.test.js／maintenance-cron.test.js）：
// jest.mock() 是整檔 hoist，不是 describe 級別作用域，同檔混用「真跑 runner」與「mock 掉 runner」
// 兩種 describe 會讓後者的 mock 洩漏進前者，把真正的派工邏輯換成空殼。
describe('維護視窗', () => {
  let dbModule, m;
  beforeAll(async () => {
    jest.resetModules();
    const mem = require('pg-mem').newDb();
    jest.doMock('pg', () => mem.adapters.createPg());
    dbModule = require('../db'); await dbModule.migrate();
    await dbModule.query('INSERT INTO teams_settings (id) VALUES (1) ON CONFLICT DO NOTHING');
    m = require('../pipeline/maintenance');
  });

  test('進場後 isMaintenance 為 true，離場後為 false', async () => {
    await m.enterMaintenance(60000);
    expect(await m.isMaintenance()).toBe(true);
    await m.leaveMaintenance();
    expect(await m.isMaintenance()).toBe(false);
  });

  // ⚠ 這條是最重要的一支。旗標若做成布林值，批次拋錯／平台被 kill 會讓它卡在 true，
  //   而派工從此安靜地停擺——安靜的失敗最難發現（此 repo 踩過：夜班空轉 98 輪無人察覺）。
  test('過期的旗標自動失效', async () => {
    await dbModule.query("UPDATE teams_settings SET maintenance_until = NOW() - interval '1 minute' WHERE id=1");
    expect(await m.isMaintenance()).toBe(false);
  });
});
