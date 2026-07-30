const fs = require('fs');
const os = require('os');
const path = require('path');

// getProjectInfo 走 DB；這裡只驗 work-context 自己的決策（要不要給 cwd），故把它整包 mock 掉。
jest.mock('../pipeline/task-agent', () => ({
  getProjectInfo: jest.fn(),
  worktreeParent: (root, taskId) => require('path').join(root, '.worktrees', taskId),
  buildRepoPaths: (info, taskId) => (info.repos || [])
    .map(r => `- ${require('path').join(info.root, '.worktrees', taskId, r.subdir)}`).join('\n')
}));

const { getProjectInfo } = require('../pipeline/task-agent');
const { taskWorkContext } = require('../pipeline/work-context');

let tmpRoot;
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wctx-'));
});
beforeEach(() => getProjectInfo.mockReset());

const TASK = { id: 1, task_id: 'task_9', project_id: 3 };

// 這是整個模組存在的理由：worktree 在，就把 cwd 交出去讓對話關自己查碼。
test('worktree 存在 → 回傳該目錄與 repo 路徑清單', async () => {
  const wt = path.join(tmpRoot, '.worktrees', 'task_9');
  fs.mkdirSync(wt, { recursive: true });
  getProjectInfo.mockResolvedValue({ root: tmpRoot, repos: [{ subdir: 'idx_hj' }] });
  const out = await taskWorkContext(TASK);
  expect(out.cwd).toBe(wt);
  expect(out.repoPaths).toContain('idx_hj');
});

// 目錄不存在卻照樣把 cwd 傳給 runClaude → spawn 直接 ENOENT，整關報錯收場；
// 少查一點東西（回 null＝退回純對話）遠比整關掛掉好。
test('worktree 還沒建（任務停在分析之前）→ 回 null，不得交出不存在的 cwd', async () => {
  getProjectInfo.mockResolvedValue({ root: tmpRoot, repos: [{ subdir: 'idx_hj' }] });
  const out = await taskWorkContext({ id: 2, task_id: 'task_never_built', project_id: 3 });
  expect(out).toBeNull();
});

test('專案沒有 clone 完成的 repo → 回 null', async () => {
  getProjectInfo.mockResolvedValue(null);
  expect(await taskWorkContext(TASK)).toBeNull();
});

// runner 派工的精簡列可能沒有 project_id（單機任務／舊資料），不可因此讓整關拋例外
test('缺 project_id／task_id → 回 null 且不查 DB', async () => {
  expect(await taskWorkContext({ id: 1, task_id: 'task_9' })).toBeNull();
  expect(await taskWorkContext(null)).toBeNull();
  expect(getProjectInfo).not.toHaveBeenCalled();
});

test('getProjectInfo 拋錯 → 吞掉回 null（查不到碼是降級，不是失敗）', async () => {
  getProjectInfo.mockRejectedValue(new Error('db down'));
  expect(await taskWorkContext(TASK)).toBeNull();
});
