// 意圖：upgrade.sh 的第一步是拉最新程式碼。2026-09-24 repo 搬到 Ideaxpress-odoo/odoo_ai_dev，
// 而新 repo 是**私有**的——舊的 kingsmvp0913/odoo-v2 是公開 repo，所以原本那句光禿禿的
// `git pull --ff-only` 一直都能動。換成私有之後它會停下來問帳密，而 GitHub 2021-08 就停用了
// 密碼登入 git，**輸入任何人的密碼都不會過**（實測：`could not read Username`）。
//
// 這支守的是「更新流程拿得到憑證」這件事。壞掉的症狀最難查：upgrade.sh 卡在第一步等輸入，
// 或是在無人值守時直接失敗，而後面「重啟了卻還是舊碼」會被歸因到別的地方去。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', '..');
const upgrade = fs.readFileSync(path.join(root, 'upgrade.sh'), 'utf8');
const puller = fs.readFileSync(path.join(root, 'scripts', 'git-pull.js'), 'utf8');
// 註解剝掉再比對：這支的檔頭**刻意**寫了「不寫進 ~/.git-credentials」，
// 直接對全文做 not.toContain 會被自己的說明文字絆倒（本 repo 踩過兩次）。
const code = puller.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

test('upgrade.sh 不得直接 git pull——私有 repo 會停下來問帳密', () => {
  expect(upgrade).toContain('node scripts/git-pull.js');
  // 只找「行首（可含縮排）的 git pull」，避免把註解裡引用那句話的文字算進來
  const bare = upgrade.split('\n').filter((l) => /^\s*git pull\b/.test(l));
  expect(`裸的 git pull: ${bare.join(' | ')}`).toBe('裸的 git pull: ');
});

test('拉取失敗必須中斷更新流程，不能繼續往下重啟', () => {
  // upgrade.sh 開頭是 set -e：node 非 0 離開就會整支停掉。少了它的話，拉取失敗仍會
  // 繼續跑到重啟，結果是「更新完成」但跑的是舊碼——而畫面上看不出差別。
  expect(upgrade).toMatch(/^set -e$/m);
});

describe('憑證取得方式', () => {
  test('走平台既有的 buildGitEnv，不另開第二條存憑證的路', () => {
    expect(puller).toContain('git-identity');
    expect(puller).toContain('buildGitEnv');
    // 多一個存憑證的地方就多一個會過期、會忘記輪替、而且沒人知道它存在的東西
    for (const bad of ['credential.helper store', '.git-credentials', 'credential.helper=store']) {
      expect(`${bad} 出現在程式碼裡: ${code.includes(bad)}`).toBe(`${bad} 出現在程式碼裡: false`);
    }
  });

  test('PAT 不得寫進 argv——/proc/<pid>/cmdline 同 uid 讀得到', () => {
    // 正確做法是把憑證放子行程的 env（buildGitEnv 走 GIT_ASKPASS）。
    // 這裡擋的是「把 token 塞進 URL」那種寫法：https://<token>@github.com/...
    expect(puller).not.toMatch(/https:\/\/\$\{?\w*(TOKEN|PAT)/i);
    expect(puller).not.toMatch(/['"`]https:\/\/[^'"`\s]*@github\.com/);
  });

  test('身分不得寫死 user id——本機與正式機各有各的 users 表', () => {
    expect(puller).toContain('cli_push_user_id');
    expect(puller).not.toMatch(/buildGitEnv\(\s*\d+\s*\)/);
  });
});

// 這支跑在更新流程的第一步，而且常常是無人值守。靜默失敗的代價是後面每一步都在錯的碼上跑。
test('每一條失敗路徑都講得出下一步，不是只印一句失敗', () => {
  for (const hint of ['DATABASE_URL', 'PAT', 'cli_push_user_id']) {
    expect(puller).toContain(hint);
  }
  // 取不到憑證時要 fail loud（非 0 離開），不可以吞掉往下跑
  expect(puller).toMatch(/process\.exit\(1\)/);
});
