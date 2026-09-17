// 意圖：AI 在容器裡拿得到什麼，全由這張表決定。表錯一格＝某個 agent 看得到不該看的東西，
// 或查不到該查的東西而整關失敗。以下每條都對應一個 09-15 已裁決的權限邊界。
const p = require('../lib/agent-profiles');

describe('profileFor：未登記的 agentType 一律擋下（rules/pipeline 59：fallback 指向最嚴格）', () => {
  test('拼錯字不可以默默拿到任何 profile', () => {
    expect(() => p.profileFor('codng')).toThrow(/codng/);
    expect(() => p.profileFor(undefined)).toThrow();
  });
  test('09-15 盤點出的每個 agentType 都有 profile', () => {
    for (const t of ['analysis', 'coding', 'spec_tour', 'qa', 'respec', 'reject_triage', 'cs', 'chat',
      'merge', 'merge-explain', 'merge-clarify', 'wiki', 'chat-to-task', 'chat-title', 'deploy_fix',
      'reject_classify', 'wiki_drift_classify', 'repair', 'auth_probe', 'workflow_health', 'fix_review',
      'feedback_merge', 'platform_fix', 'fix_verify']) {
      expect(p.profileFor(t)).toBeTruthy();
    }
  });
});

describe('R6-A：內部 scope 拆兩級，只有健檢 AI 查得到平台 DB', () => {
  test('workflow_health 是 internal-audit，端點含 platform', () => {
    const s = p.runScope(p.profileFor('workflow_health'), null);
    expect(s).toBe('internal-audit');
    expect(p.endpointsFor(s)).toContain('platform');
  });
  test.each(['platform_fix', 'fix_verify', 'fix_review', 'feedback_merge'])(
    '%s 拿不到 /ai/platform/query，也拿不到客戶文字的 wiki／tasks', (t) => {
      const s = p.runScope(p.profileFor(t), null);
      expect(s).toBe('internal-fix');
      expect(p.endpointsFor(s)).not.toContain('platform');
      expect(p.endpointsFor(s)).not.toContain('wiki');
      expect(p.endpointsFor(s)).not.toContain('tasks');
    });
});

describe('內部 scope 一律查不到客戶正式 DB（總覽 D4）', () => {
  test.each(['internal-audit', 'internal-fix'])('%s 不含 db', (s) => {
    expect(p.endpointsFor(s)).not.toContain('db');
  });
});

describe('客戶 agent 的 scope 綁專案', () => {
  test('有 projectId → project-<id>', () => {
    expect(p.runScope(p.profileFor('chat'), 12)).toBe('project-12');
    expect(p.endpointsFor('project-12')).toEqual(['db', 'wiki', 'tasks', 'glossary']);
  });
  // cs 會遇到還沒綁專案的任務：沒有專案就沒有任何可查的東西，退到 none 而不是丟例外讓分流整關壞掉
  test('project 類但沒有 projectId → none（什麼端點都沒有）', () => {
    expect(p.runScope(p.profileFor('cs'), null)).toBe('none');
    expect(p.endpointsFor('none')).toEqual([]);
  });
  test('分類器類不需要任何資料 → none，即使帶了 projectId', () => {
    expect(p.runScope(p.profileFor('deploy_fix'), 5)).toBe('none');
  });
  test('scopeKind 認不得的字串丟例外（不猜）', () => {
    expect(() => p.scopeKind('project-')).toThrow();
    expect(() => p.scopeKind('internal')).toThrow();
    expect(p.scopeKind('project-3')).toBe('project');
  });
});

describe('內部 AI 不會掛到客戶 repo，客戶 AI 不會掛到平台 repo', () => {
  test('內部 profile 的掛載種類只能是 platform-*', () => {
    for (const [t, prof] of Object.entries(p.AGENT_PROFILES)) {
      if (p.isInternalProfile(prof)) expect(prof.mount).toMatch(/^platform-/);
      else expect(prof.mount).not.toMatch(/^platform-/);
      expect(t).toBeTruthy();
    }
  });
});
