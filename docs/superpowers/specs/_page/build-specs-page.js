// 把規格 markdown 注入 HTML 樣板，輸出可發布的單檔頁面
const fs = require('fs');
const path = require('path');

const SPEC_DIR = '/home/odoo/odoo-v2/docs/superpowers/specs';
const HERE = __dirname;

const docs = [
  { id: 'overview', num: '', label: '總覽', deps: '從這裡開始', file: '2026-09-11-productize-overview.md' },
  { id: 'sandbox', num: '0', label: '把 AI 關起來', deps: '無前置', file: '2026-09-11-agent-sandbox-design.md' },
  { id: 'tenant', num: '1', label: '租戶隔離', deps: '前置 0', file: '2026-09-11-tenant-isolation-design.md' },
  { id: 'byok', num: '2', label: '客戶自帶 API key', deps: '前置 0、1', file: '2026-09-11-byok-api-key-design.md' },
  { id: 'flow', num: '3', label: '客戶按到底', deps: '前置 0、1、2', file: '2026-09-11-customer-self-serve-flow-design.md' },
  { id: 'ops', num: '4', label: '上線營運', deps: '大部分在 3 之後', file: '2026-09-11-saas-operations-design.md' },
];
const extra = path.join(SPEC_DIR, '2026-09-11-productize-rollout-plan.md');
if (fs.existsSync(extra)) docs.splice(1, 0, { id: 'rollout', num: '', label: '開發順序', deps: '不影響現有平台的做法', file: path.basename(extra) });

const loaded = docs.map(d => ({ ...d, md: fs.readFileSync(path.join(SPEC_DIR, d.file), 'utf8') }));

// JSON 會被放進 <script>：拆掉 "</" 避免提早結束標籤；U+2028／U+2029 在舊 JS 引擎的字串字面裡不合法，改成跳脫序列
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const json = JSON.stringify(loaded)
  .split('</').join('<\\/')
  .split(LS).join('\\u2028')
  .split(PS).join('\\u2029');

const tpl = fs.readFileSync(path.join(HERE, 'specs-template.html'), 'utf8');
if (!tpl.includes('/*__DOCS__*/null')) throw new Error('template placeholder missing');
const out = tpl.replace('/*__DOCS__*/null', () => json);
fs.writeFileSync(path.join(HERE, 'odoo-v2-saas-specs.html'), out);
console.log('written', out.length, 'bytes;', loaded.map(d => `${d.id}:${d.md.length}`).join(' '));
