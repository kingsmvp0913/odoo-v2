// 意圖：免密登入進測試區的帳號，權限必須跟 admin 一致，不得再讓使用者自己回設定頁逐個 App 勾群組。
// base.group_system 只是「設定」的管理權，不隱含任何應用群組（銷售／庫存／會計的 user／manager 都是
// 各模組自己的 res.groups）——只給它就是使用者實際遇到的症狀：登進去是管理員，但每個服務都還要
// 手動開權限。核心模組安裝時多半會把自己的 manager 群組指派給 admin，跟著 admin 走就自動長。
//
// 這支測的是 idx_aidev_sso 的原始碼結構（比照 env-agent.test.js 對 seed_odoo_users.py 的作法）：
// 平台這端沒有可跑的 Odoo，controller 只有部署到測試區才會被執行，靜態守衛是唯一能擋住回歸的門。
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', '..', 'docker', 'addons', 'idx_aidev_sso', 'controllers', 'main.py'),
  'utf8'
);
const fn = src.slice(src.indexOf('def _sync_admin_groups'), src.indexOf('class AidevSso'));

describe('SSO 免密登入：群組同步至 admin', () => {
  test('每次登入都同步，不是只在 JIT 建帳號時（deploy 裝進新模組後 admin 拿到的群組要能跟上）', () => {
    const syncIdx = src.indexOf('_sync_admin_groups(user, gfield)');
    const loginIdx = src.search(/\n {8}_login_as\(user\)/);   // 呼叫處，不是 def
    expect(syncIdx).toBeGreaterThan(-1);
    // 建 session 之前就要同步完，否則這次登入拿到的仍是舊權限
    expect(syncIdx).toBeLessThan(loginIdx);
    // 縮排 8 格 ＝ 在 sso() 的 method body；縮排 12 格會是縮在 `if not user:` 裡＝只有新帳號才同步
    expect(src).toMatch(/\n {8}_sync_admin_groups\(user, gfield\)/);
  });

  test('對齊對象是 admin 本人的群組，不是「全部群組」', () => {
    expect(fn).toMatch(/env\.ref\('base\.user_admin', raise_if_not_found=False\)/);
    // 全開會連 admin 自己都沒開的功能開關（多公司／多幣別／多倉位置）一起打開，畫面換成進階版
    expect(fn).not.toMatch(/res\.groups'\]/);
  });

  test('用覆寫（6,0）而非只加（4）：語意是「跟 admin 一樣」，多的要收得回來', () => {
    expect(fn).toMatch(/\(6, 0, sorted\(target\)\)/);
  });

  test('用 gfield 寫入而非寫死 groups_id（Odoo 19 改名 group_ids，寫死會 Invalid field）', () => {
    expect(fn).toMatch(/user\.write\(\{gfield:/);
    expect(fn).not.toMatch(/groups_id|group_ids/);
  });

  test('已一致時直接返回（每次登入不重寫一次群組）', () => {
    expect(fn).toMatch(/if not target or target == set\(user\[gfield\]\.ids\):\s*\n\s*return/);
  });

  test('admin 找不到就整個不動，不得清空使用者既有群組', () => {
    expect(fn).toMatch(/if not admin or admin\.id == user\.id:\s*\n\s*return/);
  });

  test('同步失敗不得讓登入 500，且要在 odoo.log 留線索（靜默＝權限沒同步到卻無跡可循）', () => {
    expect(fn).toMatch(/except Exception as e:\s*\n\s*_logger\.warning/);
    expect(src).toMatch(/_logger = logging\.getLogger\(__name__\)/);
  });

  test('seed 不跟著改：E2E playwright 帳號維持 group_system，tour 的畫面基線不因權限而變', () => {
    const seedSrc = fs.readFileSync(
      path.join(__dirname, '..', 'pipeline', 'seed_odoo_users.py'),
      'utf8'
    );
    expect(seedSrc).toMatch(/base\.group_system/);
    expect(seedSrc).not.toMatch(/base\.user_admin/);
  });
});
