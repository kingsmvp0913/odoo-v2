// app/server/lib/agent-profiles.js
/**
 * agent-profiles.js — 每個 agentType 在容器裡「是誰、看得到什麼」的唯一真相（子專案 0 §4.2、§4.5）
 *
 * scope 種類：
 *   project        客戶觸發、綁單一專案；/ai 只能查該專案
 *   none           不需要任何資料（分類器、標題、補救）；/ai 一律不給
 *   internal-audit 健檢；看得到全平台任務／wiki、可唯讀查平台 DB，查不到客戶正式 DB
 *   internal-fix   改碼／審碼（R6-A 09-15）；只給公開術語表——它們只該讀到人核准過、放進 prompt 的文字
 *
 * 新增 agentType 一定要在這裡登記；沒登記的在容器模式下直接丟例外（rules/pipeline 59）。
 */
const AGENT_PROFILES = Object.freeze({
  analysis:            Object.freeze({ scope: 'project', mount: 'task-worktree', attachments: 'task' }),
  coding:              Object.freeze({ scope: 'project', mount: 'task-worktree', attachments: 'task' }),
  spec_tour:           Object.freeze({ scope: 'project', mount: 'task-worktree', attachments: 'task' }),
  qa:                  Object.freeze({ scope: 'project', mount: 'task-worktree', attachments: 'task' }),
  respec:              Object.freeze({ scope: 'project', mount: 'task-worktree-or-none', attachments: 'task' }),
  reject_triage:       Object.freeze({ scope: 'project', mount: 'task-worktree-or-clone', attachments: 'task' }),
  cs:                  Object.freeze({ scope: 'project', mount: 'project-clone', attachments: 'task', logs: true }),
  chat:                Object.freeze({ scope: 'project', mount: 'project-clone', attachments: 'chat', logs: true }),
  merge:               Object.freeze({ scope: 'project', mount: 'project-clone' }),
  'merge-explain':     Object.freeze({ scope: 'project', mount: 'project-clone' }),
  'merge-clarify':     Object.freeze({ scope: 'project', mount: 'project-clone' }),
  wiki:                Object.freeze({ scope: 'project', mount: 'project-clone' }),
  'chat-to-task':      Object.freeze({ scope: 'project', mount: 'none', attachments: 'chat' }),
  'chat-title':        Object.freeze({ scope: 'none', mount: 'none' }),
  deploy_fix:          Object.freeze({ scope: 'none', mount: 'none' }),
  reject_classify:     Object.freeze({ scope: 'none', mount: 'none' }),
  wiki_drift_classify: Object.freeze({ scope: 'none', mount: 'none' }),
  repair:              Object.freeze({ scope: 'none', mount: 'none' }),
  auth_probe:          Object.freeze({ scope: 'none', mount: 'none' }),
  workflow_health:     Object.freeze({ scope: 'internal-audit', mount: 'platform-clean' }),
  fix_review:          Object.freeze({ scope: 'internal-fix', mount: 'platform-clean' }),
  feedback_merge:      Object.freeze({ scope: 'internal-fix', mount: 'platform-clean' }),
  platform_fix:        Object.freeze({ scope: 'internal-fix', mount: 'platform-fix', attachments: 'feedback' }),
  fix_verify:          Object.freeze({ scope: 'internal-fix', mount: 'platform-fix' }),
});

// 端點群組：db＝/ai/db/*、wiki＝/ai/wiki/*、tasks＝/ai/tasks/*、glossary＝/ai/glossary、platform＝/ai/platform/query
const SCOPE_ENDPOINTS = Object.freeze({
  project: Object.freeze(['db', 'wiki', 'tasks', 'glossary']),
  'internal-audit': Object.freeze(['wiki', 'tasks', 'platform', 'glossary']),
  'internal-fix': Object.freeze(['glossary']),
  none: Object.freeze([]),
});

function profileFor(agentType) {
  const prof = Object.prototype.hasOwnProperty.call(AGENT_PROFILES, agentType) ? AGENT_PROFILES[agentType] : null;
  if (!prof) throw new Error(`未登記的 agentType：${agentType}（容器模式下必須先在 lib/agent-profiles.js 登記）`);
  return prof;
}

function isInternalProfile(profile) {
  return profile.scope === 'internal-audit' || profile.scope === 'internal-fix';
}

function runScope(profile, projectId) {
  if (profile.scope !== 'project') return profile.scope;
  const id = Number(projectId);
  return projectId != null && Number.isInteger(id) && id > 0 ? `project-${id}` : 'none';
}

function scopeKind(scope) {
  if (scope === 'none' || scope === 'internal-audit' || scope === 'internal-fix') return scope;
  if (/^project-[1-9]\d*$/.test(String(scope))) return 'project';
  throw new Error(`無法辨識的 scope：${scope}`);
}

function endpointsFor(scope) {
  return [...SCOPE_ENDPOINTS[scopeKind(scope)]];
}

module.exports = { AGENT_PROFILES, SCOPE_ENDPOINTS, profileFor, runScope, scopeKind, endpointsFor, isInternalProfile };
