// 意圖：把平台的 project skill 佈進任務 worktree（headless claude 只認 cwd 底下的 skill、不往上找），
// 並釘住兩件會靜默壞掉的事：白名單不得外流平台自己的 skill、提示詞與佈署兩半不得漂移。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureWorktreeSkills, DEPLOYED } = require('../pipeline/worktree-skills');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SKILL_SRC = path.join(REPO_ROOT, '.claude', 'skills');

function tmpWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wt-skills-'));
}
const skillFile = (cwd, name) => path.join(cwd, '.claude', 'skills', name, 'SKILL.md');

test('佈到 worktree：白名單內的 skill 出現在 cwd 的 .claude/skills 下，內容與來源一致', () => {
  const cwd = tmpWorktree();
  const ready = ensureWorktreeSkills(cwd);
  expect(ready).toEqual(DEPLOYED);
  for (const name of DEPLOYED) {
    expect(fs.readFileSync(skillFile(cwd, name), 'utf8'))
      .toBe(fs.readFileSync(path.join(SKILL_SRC, name, 'SKILL.md'), 'utf8'));
  }
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('冪等：來源沒改就不重佈（每關都會呼叫，重佈等於每次多做一次磁碟 IO）', () => {
  const cwd = tmpWorktree();
  ensureWorktreeSkills(cwd);
  const before = fs.statSync(skillFile(cwd, DEPLOYED[0])).mtimeMs;
  ensureWorktreeSkills(cwd);
  expect(fs.statSync(skillFile(cwd, DEPLOYED[0])).mtimeMs).toBe(before);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('來源更新後重佈：否則改了 skill，既有 worktree 會永遠拿到舊版且無訊號', () => {
  const cwd = tmpWorktree();
  ensureWorktreeSkills(cwd);
  const dest = skillFile(cwd, DEPLOYED[0]);
  fs.writeFileSync(dest, '（被改壞的舊版）');
  // 佈出去的那份「時間比來源新」是正常狀態（cpSync 不保留時間戳），所以要真的把來源時間往後推
  const src = path.join(SKILL_SRC, DEPLOYED[0], 'SKILL.md');
  const future = new Date(Date.now() + 60000);
  const original = fs.statSync(src);
  fs.utimesSync(src, future, future);
  try {
    ensureWorktreeSkills(cwd);
    expect(fs.readFileSync(dest, 'utf8')).toBe(fs.readFileSync(src, 'utf8'));
  } finally {
    fs.utimesSync(src, original.atime, original.mtime);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('白名單：平台自己的 skill 不得佈進客戶 worktree', () => {
  const cwd = tmpWorktree();
  ensureWorktreeSkills(cwd);
  const deployed = fs.readdirSync(path.join(cwd, '.claude', 'skills'));
  // 這幾支教的是平台內部操作（查平台 DB、推平台 repo、健檢判準），在客戶 repo 裡作業的 agent
  // 不該拿到；`platformDB` 更是直接給出本機 DB 的查法。
  for (const forbidden of ['platformDB', 'pushRepo', 'healthCheck', 'getSQL']) {
    expect(deployed).not.toContain(forbidden);
  }
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('cwd 不存在 → 回空陣列，不丟例外（worktree 尚未建立的關會這樣呼叫）', () => {
  expect(ensureWorktreeSkills(path.join(os.tmpdir(), 'no-such-dir-' + Date.now()))).toEqual([]);
  expect(ensureWorktreeSkills(null)).toEqual([]);
});

// --- 兩個靜態守衛：這兩半只要有一半沒跟上，就是「agent 被叫去載一支不存在的 skill」或
// 「skill 佈出去了但沒有任何 agent 知道要載」——兩種都零訊號。

test('凡是拿 worktree 當 cwd 的 pipeline 模組，都必須佈 skill（掃描，不列死清單）', () => {
  const dir = path.join(__dirname, '..', 'pipeline');
  const offenders = fs.readdirSync(dir)
    .filter(f => f.endsWith('.js') && f !== 'worktree-skills.js')
    .filter(f => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      return src.includes('worktreeParent(') && !src.includes('ensureWorktreeSkills');
    });
  expect(offenders).toEqual([]);
});

test('提示詞與佈署不得漂移：source-routing 指名的 skill 必須在白名單且來源真的存在', () => {
  const fragment = fs.readFileSync(path.join(__dirname, '..', 'pipeline', 'source-routing.md'), 'utf8');
  for (const name of DEPLOYED) {
    expect(fragment).toContain(name);                                   // agent 要知道它存在才會去載
    expect(fs.existsSync(path.join(SKILL_SRC, name, 'SKILL.md'))).toBe(true);
  }
});
