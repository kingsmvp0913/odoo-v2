// 意圖：掃碟守衛只能擋「從磁碟根／工作目錄外」的廣掃，且不得誤傷 worktree 內的正常搜尋——
// 誤傷會讓合法的 coding/analysis 步驟被擋、整關報廢，比不擋還糟。以下用具體指令釘住邊界。
const { detectBroadScan } = require('../pipeline/hooks/scan-guard');

describe('detectBroadScan：應擋的廣掃', () => {
  const blocked = [
    'find /',
    'find / -name "*.py"',
    'find /c -type f',                       // Git Bash 磁碟根
    'find /c/odoo -name models.py',          // C:\odoo（核心所在）
    'find C:\\ -name odoo-bin',
    'find "C:\\" -name "*.xml"',
    'find ~ -name credentials',
    'find /home -type d',
    'find odoo-envs/cwt/src -name sale_order.py', // 核心樹（工作目錄外）
    'find ../online_addons -name "*.py"',
    'ls -R /',
    'grep -r "def _compute" /c/odoo',
    'grep -r pattern odoo-envs',
    'cd /tmp && find / -name secrets',       // 子指令內的廣掃也要抓
  ];
  test.each(blocked)('擋：%s', cmd => {
    expect(detectBroadScan(cmd).blocked).toBe(true);
  });
});

describe('detectBroadScan：應放行的正常搜尋', () => {
  const allowed = [
    'find . -name "*.py"',                    // 預設從 cwd
    'find ./idx_sale_note -name models.py',
    'find src -type f -name "*.xml"',
    'grep -rn "compute" ./idx_sale_note',     // 遞迴但限相對子目錄
    'grep "pattern" file.py',                 // 非遞迴
    'tail -c 8192 "/c/odoo-envs/cwt/odoo.log"', // 讀 log（tail 不是掃描指令）
    'ls -la',
    'ls idx_sale_note/',
    'cat models.py | grep price',
    'git log --oneline -5',
    'Get-ChildItem idx_sale_note',            // 未遞迴
  ];
  test.each(allowed)('放行：%s', cmd => {
    expect(detectBroadScan(cmd).blocked).toBe(false);
  });
});

test('detectBroadScan：空／非字串輸入不炸、視為放行', () => {
  expect(detectBroadScan('').blocked).toBe(false);
  expect(detectBroadScan(undefined).blocked).toBe(false);
  expect(detectBroadScan(null).blocked).toBe(false);
});
