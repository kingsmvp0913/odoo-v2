// 意圖（Task 6，安全核心）：測試區建立不得再把全平台 user＋password_hash 灌進去，改每環境隨機
// SSO secret ＋隨機 E2E 密碼。以原始碼靜態斷言鎖住這條防線——只要有人把「無 WHERE 的全表
// SELECT ... FROM users」加回 _seedOdooUsersDocker（憑證外洩回歸），本檔即失敗（Rule 9）。
const fs = require('fs');
const src = fs.readFileSync(require.resolve('../pipeline/env-agent.js'), 'utf8');
const seedSrc = fs.readFileSync(require.resolve('../pipeline/seed_odoo_users.py'), 'utf8');

describe('env-agent 測試區 seed 不外洩平台憑證', () => {
  test('_seedOdooUsersDocker 不再撈全平台 users（無 SELECT ... FROM users 全表）', () => {
    // brief Step 1：無 WHERE 的全表 SELECT username ... FROM users 即回歸
    expect(src).not.toMatch(/SELECT\s+username[^;]*FROM users\b(?![^;]*WHERE)/i);
  });

  test('全檔不再自 users 表撈 password_hash 送進測試區', () => {
    expect(src).not.toMatch(/password_hash[^;]*FROM users/i);
    expect(src).not.toMatch(/FROM users\b/i); // seed 已改為只送 E2E 一筆，不應再讀 platform users 表
  });

  test('seed 只送 E2E 一筆（login＋隨機明文密碼），不含 platform hash', () => {
    expect(src).toMatch(/login:\s*E2E_LOGIN[^}]*password_plain:\s*ctx\.e2ePassword/);
  });

  test('seed 透過 AIDEV_SSO_SECRET 把該環境 secret 傳進 odoo shell', () => {
    expect(src).toMatch(/AIDEV_SSO_SECRET:\s*ctx\.ssoSecret/);
  });

  test('每環境憑證用 crypto.randomBytes 產生（32-byte hex secret＋18-byte base64url 密碼）', () => {
    expect(src).toMatch(/crypto\.randomBytes\(32\)\.toString\('hex'\)/);
    expect(src).toMatch(/crypto\.randomBytes\(18\)\.toString\('base64url'\)/);
  });
});

describe('seed_odoo_users.py 寫入 SSO config param', () => {
  test('commit 前把 AIDEV_SSO_SECRET 寫入 ir.config_parameter aidev.sso_secret', () => {
    expect(seedSrc).toMatch(/set_param\(\s*['"]aidev\.sso_secret['"]/);
    // 必須在 commit 前寫入才會落地
    const paramIdx = seedSrc.indexOf("set_param('aidev.sso_secret'");
    const commitIdx = seedSrc.indexOf('env.cr.commit()');
    expect(paramIdx).toBeGreaterThan(-1);
    expect(paramIdx).toBeLessThan(commitIdx);
  });

  test('保留 E2E 帳號的 group_system（Rule 7：admin 未降權，隨機密碼即非公開後門）', () => {
    expect(seedSrc).toMatch(/base\.group_system/);
    expect(seedSrc).toMatch(/group_field:\s*\[\(4, gid\)\]/);
  });
});
