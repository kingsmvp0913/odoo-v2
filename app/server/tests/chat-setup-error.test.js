// 意圖（Rule 9）：對話回覆失敗時補的收尾訊息，必須分得出「跑到一半被中斷」與「根本還沒起跑」。
// 後者是確定性的設定錯誤（例：專案的 repo 還沒 clone 完成），重送一百次都是同一個結果——沿用
// CHAT_INTERRUPTED_MSG 會同時誤指成伺服器重啟、蓋掉真因、再給一個保證無效的「請重新發送」。
// 兩支測試分別釘住這條鏈的兩端：丟錯的那裡有標記，收尾訊息真的因為那個標記而不同。
const mockRunClaude = jest.fn().mockResolvedValue({ text: '回覆', usage: {}, durationMs: 1 });
jest.mock('../pipeline/claude-runner', () => ({ runClaude: (...a) => mockRunClaude(...a) }));
jest.mock('../pipeline/token-logger', () => ({ logTokenUsage: jest.fn(), logFailedUsage: jest.fn() }));
// 快取沒命中時 coreSourceGuidance 會 fire-and-forget 去跑真 docker 解壓 1.2G（rules/testing.md #23）
jest.mock('../lib/odoo-core-src', () => ({
  coreSourceGuidance: jest.fn().mockReturnValue('【核心原始碼守則哨兵】'),
  ensureOdooCoreSrc: jest.fn().mockResolvedValue(''),
  majorOf: jest.fn().mockReturnValue(''),
  CORE_SRC_ROOT: '/core-src'
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...a) => mockQuery(...a) }));

const tmpUploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-chat-setup-err-'));
process.env.UPLOAD_DIR = tmpUploadRoot;
afterAll(() => { delete process.env.UPLOAD_DIR; fs.rmSync(tmpUploadRoot, { recursive: true, force: true }); });

const { chatReply, CHAT_INTERRUPTED_MSG } = require('../pipeline/chat-agent');
const { resolveSandboxMounts } = require('../lib/agent-mounts');
const { profileFor } = require('../lib/agent-profiles');

beforeEach(() => {
  mockRunClaude.mockClear();
  mockQuery.mockReset();
  mockQuery.mockImplementation((sql) => {
    if (/project_repos/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久' }] });
    return Promise.resolve({ rows: [] });
  });
});

// 標記是這條鏈唯一的訊號：拿掉它，收尾訊息就默默退回「請重新發送」，而且沒有任何徵狀。
//
// ⚠ 2026-09-24 起這裡用 wiki 而不是 chat 當例子：chat／cs 標了 sourceOptional，
// 沒有 clone 完成的 repo 時會**降級照跑**而不是丟錯（六天內因此失敗 11 次，見
// agent-profiles.js 的註解）。但「設定錯誤要帶得出真因與下一步」這條鏈本身沒有變，
// 對其他硬擋的 agent 仍然成立——所以換一支還會丟錯的來釘，機制不動。
test('掛載層丟出的設定錯誤有標記，並帶使用者做得到的下一步', async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-mounts-'));
  const ctx = {
    profile: profileFor('wiki'), projectId: 7, taskDbId: null, cwd: undefined, chatId: 5,
    feedbackIds: [], home: path.join(appDir, 'home'), platformWorktree: null, appDir,
  };
  const err = await resolveSandboxMounts(ctx, {
    getProjectInfo: async () => null,
    query: async () => ({ rows: [{ name: '鴻久' }] }),   // 錯誤訊息要指名道姓，得另外查一次
  }).catch(e => e);
  fs.rmSync(appDir, { recursive: true, force: true });

  expect(err.message).toMatch(/沒有 clone 完成的 repo/);
  expect(err.agentSetupError).toBe(true);
  expect(err.userAction).toMatch(/clone/);   // 下一步只有丟錯的那裡知道，不能留空
});

test('起跑前的設定錯誤 → 收尾訊息講真因與下一步，不得叫使用者重新發送', async () => {
  mockRunClaude.mockRejectedValueOnce(Object.assign(
    new Error('專案 7 沒有 clone 完成的 repo，無法組容器掛載'),
    { agentSetupError: true, userAction: '請到專案頁的「Git Repositories」確認 repo 已 clone 完成。' }
  ));
  const calls = [];
  mockQuery.mockImplementation((sql, params) => {
    calls.push([sql, params]);
    if (/project_repos/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久' }] });
    return Promise.resolve({ rows: [] });
  });

  await expect(chatReply('7', '2', '正式區某張單金額算錯', 99)).rejects.toThrow('沒有 clone 完成的 repo');

  const aiMsg = calls.find(c => /INSERT INTO project_chat_messages/.test(c[0]) && c[1] && c[1][1] === 'ai');
  expect(aiMsg).toBeTruthy();
  const content = aiMsg[1][2];
  expect(content).not.toBe(CHAT_INTERRUPTED_MSG);
  expect(content).not.toContain('請重新發送');      // 重送保證無效，不能這樣指示
  expect(content).not.toContain('伺服器重啟');      // 誤指原因
  expect(content).toContain('沒有 clone 完成的 repo'); // 真因要看得到
  expect(content).toContain('Git Repositories');     // 使用者做得到的下一步
});

// 真正的中斷／連線異常仍該保留原本的「請重新發送」——分辨不能把兩邊都改掉。
test('沒有設定錯誤標記的失敗 → 維持原本的中斷訊息', async () => {
  mockRunClaude.mockRejectedValueOnce(new Error('boom'));
  const calls = [];
  mockQuery.mockImplementation((sql, params) => {
    calls.push([sql, params]);
    if (/project_repos/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM wiki_pages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM project_chat_messages/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM projects/.test(sql)) return Promise.resolve({ rows: [{ name: '鴻久' }] });
    return Promise.resolve({ rows: [] });
  });

  await expect(chatReply('7', '2', '會壞的問題', 99)).rejects.toThrow('boom');

  const aiMsg = calls.find(c => /INSERT INTO project_chat_messages/.test(c[0]) && c[1] && c[1][1] === 'ai');
  expect(aiMsg[1][2]).toBe(CHAT_INTERRUPTED_MSG);
});
