// app/server/lib/ai-scope.js
/**
 * ai-scope.js — /ai 端點依「本次執行的 scope」做群組與專案檢查（子專案 0 §4.4）
 * req.aiRun 由 aiEndpointGuard 設定：socket 來的是 { runId, scope, projectId, endpoints }；TCP 舊路徑是 null（互動式，不限）。
 */
function requireAiEndpoint(group) {
  return (req, res, next) => {
    if (!req.aiRun) return next();
    if (!req.aiRun.endpoints.includes(group)) {
      return res.status(403).json({ ok: false, error: `本次執行的範圍（${req.aiRun.scope}）不含 /ai/${group}` });
    }
    return next();
  };
}

function projectForbidden(req, projectId) {
  if (!req.aiRun || !String(req.aiRun.scope).startsWith('project-')) return false;
  return Number(projectId) !== Number(req.aiRun.projectId);
}

function forbidProject(res) {
  return res.status(403).json({ ok: false, error: '該專案不屬於本次執行的範圍' });
}

module.exports = { requireAiEndpoint, projectForbidden, forbidProject };
