#!/usr/bin/env bash
# scripts/agent-sandbox-probe.sh — 子專案 0 自我檢測的容器內探針（由 lib/agent-sandbox-selftest.js 啟動）
# 用法：agent-sandbox-probe.sh <mode:project|audit> <appDir> <otherRoot> <ownGitDir|-> <ownSlug> <otherSlug> <hostTargets(空白分隔)>
# 輸出：CHECK <name> PASS|FAIL <detail>；TOKEN <token>
set -u
MODE="$1"; APP="$2"; OTHER_ROOT="$3"; OWN_GIT="$4"; OWN_SLUG="$5"; OTHER_SLUG="$6"; HOSTS="$7"
ok()  { echo "CHECK $1 PASS ${2:-}"; }
bad() { echo "CHECK $1 FAIL ${2:-}"; }
expect_fail() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$name" "應失敗但成功：$*"; else ok "$name"; fi; }
expect_ok()   { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name" "應成功但失敗：$*"; fi; }
code() { curl -s -m 20 -o /dev/null -w '%{http_code}' "$@"; }

for k in APP_SECRET JWT_SECRET DATABASE_URL; do
  if [ -z "$(printenv "$k")" ]; then ok "env_no_$k"; else bad "env_no_$k" "有值"; fi
done
expect_fail read_platform_config cat "$APP/data/config.json"
expect_fail read_ai_socket_dir ls "$APP/data/run"
expect_fail read_other_project ls "$OTHER_ROOT"

for h in $HOSTS; do for p in 8771 8772 22 21000 5416; do
  expect_fail "tcp_blocked_${h}_${p}" timeout 3 bash -c "</dev/tcp/$h/$p"
done; done
expect_fail tcp_blocked_direct_internet timeout 5 bash -c '</dev/tcp/1.1.1.1/443'

c=$(code -x "$HTTPS_PROXY" https://api.anthropic.com/); [ "$c" != "000" ] && ok proxy_anthropic "$c" || bad proxy_anthropic "$c"
c=$(code -x "$HTTPS_PROXY" https://example.com/); [ "$c" = "000" ] && ok proxy_example_blocked || bad proxy_example_blocked "$c"

H="X-AIDEV-AI-TOKEN: $AIDEV_AI_TOKEN"
if [ "$MODE" = project ]; then
  expect_fail write_git_config sh -c "echo '[core]' >> '$OWN_GIT/config'"
  expect_fail write_git_hooks touch "$OWN_GIT/hooks/aidev-probe"
  expect_ok write_git_objects sh -c "touch '$OWN_GIT/objects/aidev-probe' && rm -f '$OWN_GIT/objects/aidev-probe'"
  c=$(code -H "$H" "$AIDEV_AI_BASE/ai/wiki/pages?project=$OWN_SLUG"); [ "$c" = 200 ] && ok ai_own_project "$c" || bad ai_own_project "$c"
  c=$(code -H "$H" "$AIDEV_AI_BASE/ai/wiki/pages?project=$OTHER_SLUG"); [ "$c" = 403 ] && ok ai_other_project_403 "$c" || bad ai_other_project_403 "$c"
  c=$(code -H "$H" "$AIDEV_AI_BASE/ai/db/connections?project=$OTHER_SLUG"); [ "$c" = 403 ] && ok ai_other_db_403 "$c" || bad ai_other_db_403 "$c"
  c=$(code -H "$H" -H 'Content-Type: application/json' -d '{"sql":"SELECT 1"}' "$AIDEV_AI_BASE/ai/platform/query"); [ "$c" = 403 ] && ok ai_platform_query_403 "$c" || bad ai_platform_query_403 "$c"
else
  expect_fail write_platform_worktree touch "$PWD/aidev-probe"
  body=$(curl -s -m 20 -H "$H" -H 'Content-Type: application/json' -d '{"sql":"SELECT COUNT(*) AS n FROM tasks"}' "$AIDEV_AI_BASE/ai/platform/query")
  echo "$body" | grep -q '"ok":true' && ok platform_query_ok || bad platform_query_ok "$body"
  body=$(curl -s -m 20 -H "$H" -H 'Content-Type: application/json' -d '{"sql":"SELECT password_hash FROM users LIMIT 1"}' "$AIDEV_AI_BASE/ai/platform/query")
  echo "$body" | grep -qi 'permission denied' && ok platform_query_sensitive_denied || bad platform_query_sensitive_denied "$body"
  c=$(code -H "$H" "$AIDEV_AI_BASE/ai/db/connections"); [ "$c" = 403 ] && ok ai_internal_db_403 "$c" || bad ai_internal_db_403 "$c"
fi

out=$(echo "只回覆 PROBE-OK" | claude -p --output-format stream-json --verbose --dangerously-skip-permissions --strict-mcp-config --mcp-config "$APP/app/server/pipeline/mcp/none.json" 2>&1)
sid=$(echo "$out" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "$out" | grep -q PROBE-OK && ok claude_run "$sid" || bad claude_run "$(echo "$out" | tail -1 | cut -c1-200)"
out=$(echo "只回覆 PROBE-RESUMED" | claude -p --output-format stream-json --verbose --dangerously-skip-permissions --strict-mcp-config --mcp-config "$APP/app/server/pipeline/mcp/none.json" --resume "$sid" 2>&1)
echo "$out" | grep -q PROBE-RESUMED && ok claude_resume || bad claude_resume "$(echo "$out" | tail -1 | cut -c1-200)"

echo "TOKEN $AIDEV_AI_TOKEN"
