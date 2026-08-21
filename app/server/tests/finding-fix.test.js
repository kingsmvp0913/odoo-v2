// 意圖：「修這條」是平台自己改自己，最陰險的失敗方式是把測試改成永遠通過、或放寬健檢自己的判準
// ——兩者在指標上都看不出異常。所以範圍檢查寫在程式裡而不是只寫在提示詞裡，這一支就是釘住那道防線。
const { classifyChanges } = require('../pipeline/finding-fix');

// git status --porcelain 的格式：前兩碼是狀態，第 4 碼起是路徑
const line = (code, file) => `${code} ${file}`;

test('可改範圍：後端、前端、各關提示詞', () => {
  const { violations } = classifyChanges([
    line(' M', 'app/server/pipeline/runner.js'),
    line(' M', 'app/public/js/views/TaskDetail.js'),
    line(' M', '.claude/agents/coding-project.md'),
  ].join('\n'));
  expect(violations).toEqual([]);
});

test('既有測試只能新增不能改：改一支既有測試就整份作廢', () => {
  const modified = classifyChanges(line(' M', 'app/server/tests/runner.test.js'));
  expect(modified.violations).toHaveLength(1);
  expect(modified.violations[0]).toContain('不得修改或刪除既有測試');

  const deleted = classifyChanges(line(' D', 'app/server/tests/runner.test.js'));
  expect(deleted.violations).toHaveLength(1);

  // 新增測試是被鼓勵的：修 bug 要補一支會抓到該 bug 的測試
  expect(classifyChanges(line('??', 'app/server/tests/new-thing.test.js')).violations).toEqual([]);
  expect(classifyChanges(line('A ', 'app/server/tests/new-thing.test.js')).violations).toEqual([]);
});

test('健檢不准改自己：放寬自己的判準在指標上只會看起來像「變積極了」', () => {
  const agents = classifyChanges(line(' M', '.claude/agents/health-auditor.md'));
  expect(agents.violations[0]).toContain('健檢自己的提示詞');

  const skill = classifyChanges(line(' M', '.claude/skills/healthCheck/SKILL.md'));
  expect(skill.violations[0]).toContain('健檢判準');
});

test('範圍外一律擋：設定檔、規則檔、客戶模組、CI', () => {
  const { violations } = classifyChanges([
    line(' M', '.claude/settings.json'),
    line(' M', 'CLAUDE.md'),
    line(' M', '.github/workflows/deploy.yml'),
    line(' M', 'custom_addons/idx_x/models/a.py'),
  ].join('\n'));
  expect(violations).toHaveLength(4);
  violations.forEach(v => expect(v).toContain('超出可修改範圍'));
});

test('重新命名取新路徑：R 的舊路徑若拿去比對，會把合法搬移誤判成違規（或反之）', () => {
  const ok = classifyChanges(line('R ', 'app/server/a.js -> app/server/b.js'));
  expect(ok.violations).toEqual([]);
  expect(ok.files).toEqual(['app/server/b.js']);

  // 把檔案搬進禁區也要擋得住
  const bad = classifyChanges(line('R ', 'app/server/a.js -> .claude/agents/health-task.md'));
  expect(bad.violations).toHaveLength(1);
});

test('空輸入（什麼都沒改）→ 沒有檔案也沒有違規', () => {
  expect(classifyChanges('')).toEqual({ files: [], violations: [] });
  expect(classifyChanges(null)).toEqual({ files: [], violations: [] });
});
