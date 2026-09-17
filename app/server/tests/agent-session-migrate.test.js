// 意圖：切換到容器那天，把還在續接的 session 放到容器 HOME 裡「容器 workdir 對應的」目錄。
// 放錯目錄＝等於沒搬（claude 依 cwd 找）；覆寫＝可能蓋掉容器裡已經續接過的新 session。
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../lib/agent-session-migrate');

test('encodeProjectDir 與 claude 實際目錄名一致（09-15 實查樣本）', () => {
  expect(m.encodeProjectDir('/home/odoo/odoo-v2')).toBe('-home-odoo-odoo-v2');
  expect(m.encodeProjectDir('/home/odoo/odoo-v2/repos/odoo17-concord/.worktrees/task_service_4015'))
    .toBe('-home-odoo-odoo-v2-repos-odoo17-concord--worktrees-task-service-4015');
  expect(m.encodeProjectDir('/home/odoo/odoo-v2/.claude/worktrees/fix-1')).toBe('-home-odoo-odoo-v2--claude-worktrees-fix-1');
});

describe('plan／apply', () => {
  let R, claudeHome, appDir, deps;
  const w = (p, c = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  beforeAll(() => {
    R = fs.mkdtempSync(path.join(os.tmpdir(), 'sessmig-'));
    claudeHome = path.join(R, 'claude');
    appDir = path.join(R, 'app');
    const root7 = path.join(appDir, 'repos', 'p7');
    const wt = path.join(root7, '.worktrees', 'task_7');
    fs.mkdirSync(wt, { recursive: true });
    const P = path.join(claudeHome, 'projects');
    w(path.join(P, m.encodeProjectDir(wt), 'qa-sess.jsonl'));
    w(path.join(P, m.encodeProjectDir(appDir), 'cs-sess.jsonl'));
    w(path.join(P, m.encodeProjectDir(appDir), 'chat-sess.jsonl'));
    w(path.join(P, m.encodeProjectDir(appDir), 'spec-sess.jsonl'));
    deps = {
      claudeHome, appDir,
      query: async (sql) => {
        if (/FROM tasks/.test(sql)) return { rows: [
          { id: 70, task_id: 'task_7', project_id: 7, analysis_session_id: null, qa_session_id: 'qa-sess', cs_session_id: 'cs-sess', clarify_session_id: null, spec_session_id: null },
          { id: 71, task_id: 'task_nowt', project_id: 7, analysis_session_id: null, qa_session_id: null, cs_session_id: null, clarify_session_id: null, spec_session_id: 'spec-sess' },
        ] };
        if (/FROM project_chats/.test(sql)) return { rows: [{ id: 5, project_id: 7, chat_session_id: 'chat-sess' }, { id: 6, project_id: 7, chat_session_id: 'gone' }] };
        throw new Error(sql);
      },
      getProjectInfo: async id => (id === 7 ? { root: root7 } : null),
      worktreeParent: (root, t) => path.join(root, '.worktrees', t),
    };
  });
  afterAll(() => fs.rmSync(R, { recursive: true, force: true }));

  test('計畫：worktree 整目錄、cs／chat 搬到專案根、無 worktree 的 spec 搬到容器家目錄；來源不存在的不列', async () => {
    const plans = await m.planSessionCopies(deps);
    const home = path.join(appDir, 'data', 'agent-home', 'project-7', '.claude', 'projects');
    const root7 = path.join(appDir, 'repos', 'p7');
    const wt = path.join(root7, '.worktrees', 'task_7');
    expect(plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'dir', to: path.join(home, m.encodeProjectDir(wt)) }),
      expect.objectContaining({ kind: 'file', to: path.join(home, m.encodeProjectDir(root7), 'cs-sess.jsonl') }),
      expect.objectContaining({ kind: 'file', to: path.join(home, m.encodeProjectDir(root7), 'chat-sess.jsonl') }),
      expect.objectContaining({ kind: 'file', to: path.join(home, m.encodeProjectDir(path.join(appDir, 'data', 'agent-home', 'project-7')), 'spec-sess.jsonl') }),
    ]));
    expect(plans.some(p => p.from.includes('gone'))).toBe(false);
    expect(plans.length).toBe(4);
  });

  test('套用：複製、不覆寫既有目標；第二次全部跳過', async () => {
    const plans = await m.planSessionCopies(deps);
    const first = m.applySessionCopies(plans);
    expect(first).toEqual({ copied: 4, skipped: 0 });
    for (const p of plans) expect(fs.existsSync(p.to)).toBe(true);
    const second = m.applySessionCopies(plans);
    expect(second).toEqual({ copied: 0, skipped: 4 });
  });
});
