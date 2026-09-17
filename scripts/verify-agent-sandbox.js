#!/usr/bin/env node
// scripts/verify-agent-sandbox.js — 觸發平台的 AI 容器自我檢測並判讀（子專案 0 §8.3）
// 用法：AIDEV_ADMIN_JWT=<平台管理員 JWT> node scripts/verify-agent-sandbox.js <project_id> <task_id> <other_project_id>
// 埠：env PORT，否則讀 data/config.json 的 PORT，否則 3939。有任何一項未通過 → exit 1。
const fs = require('fs');
const path = require('path');
const http = require('http');

const [projectId, taskId, otherProjectId] = process.argv.slice(2).map(Number);
const jwt = process.env.AIDEV_ADMIN_JWT;
if (!projectId || !taskId || !otherProjectId || !jwt) {
  console.error('用法：AIDEV_ADMIN_JWT=<jwt> node scripts/verify-agent-sandbox.js <project_id> <task_id> <other_project_id>');
  process.exit(2);
}
let port = process.env.PORT;
if (!port) { try { port = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8')).PORT; } catch { port = null; } }
port = port || 3939;

const body = JSON.stringify({ project_id: projectId, task_id: taskId, other_project_id: otherProjectId });
const req = http.request({ host: '127.0.0.1', port, path: '/api/admin/agent-sandbox/selftest', method: 'POST', timeout: 600000,
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${jwt}` } }, res => {
  let raw = '';
  res.on('data', c => { raw += c; });
  res.on('end', () => {
    let r;
    try { r = JSON.parse(raw); } catch { console.error(`HTTP ${res.statusCode}：${raw.slice(0, 500)}`); process.exit(1); }
    if (res.statusCode !== 200) { console.error(`HTTP ${res.statusCode}：${r.error}`); process.exit(1); }
    for (const c of r.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  [${c.phase}] ${c.name}${c.detail ? `  ${c.detail}` : ''}`);
    const failed = r.checks.filter(c => !c.pass).length;
    console.log(r.ok ? `\n全部 ${r.checks.length} 項通過` : `\n${failed} 項未通過`);
    process.exit(r.ok ? 0 : 1);
  });
});
req.on('timeout', () => { console.error('逾時（10 分鐘）'); req.destroy(); process.exit(1); });
req.on('error', e => { console.error(`連線失敗：${e.message}`); process.exit(1); });
req.end(body);
