const fs = require('fs');
const path = require('path');

const view = fs.readFileSync(
  path.join(__dirname, '../../public/js/ui-next/pages/ExamRun.js'), 'utf8');
const app = fs.readFileSync(
  path.join(__dirname, '../../public/js/ui-next/UiNextApp.js'), 'utf8');
const bankView = fs.readFileSync(
  path.join(__dirname, '../../public/js/ui-next/pages/ExamBank.js'), 'utf8');
const css = fs.readFileSync(
  path.join(__dirname, '../../public/css/ui-next-pages/09-later-patches.css'), 'utf8');

test('考試頁是 POST 結果工作台，不再要求使用者手動上傳或啟動', () => {
  expect(view).toContain('外部 POST 後自動審題');
  expect(view).not.toContain('type="file"');
  expect(view).not.toContain('開始判題');
});

test('完整選項用勾選框設定正式答案，而且可以取消成空白', () => {
  expect(view).toContain('v-for="option in q.options"');
  expect(view).toContain('type="checkbox"');
  expect(view).toContain('@change="toggleFinal(q,option.letter,$event.target.checked)"');
  expect(view).toContain("!checked ? current.filter");
  expect(view).toContain('this.finalDraft = { ...this.finalDraft');
  expect(view).not.toContain('最後答案（可空白）');
});

test('各答案直接標在完整選項上，不再顯示下方答案區塊', () => {
  expect(view).toContain('ui-next-exam-run-input-mark');
  expect(view).toContain('ui-next-exam-run-review-mark');
  expect(view).toContain('投票 {{ topVote(q).pct }}%');
  expect(view).toContain('投票 -');
  expect(view).toContain('topVote(q).answer');
  expect(view).not.toContain('<div class="ui-next-exam-run-answers">');
});

test('只有答案不一致的題目預設展開，投票後按鈕消失', () => {
  expect(view).toContain(':open="isMismatch(q)"');
  expect(view).toContain('v-if="!q.has_voted"');
  expect(view).toContain('q.has_voted = true');
});

test('考試頁狀態不使用左側色條', () => {
  expect(css).not.toMatch(/\.ui-next-exam-run-(?:card|option)[^{]*\{[^}]*border-left/);
});

test('題目列隱藏原生展開箭頭但仍保留 details 收合能力', () => {
  expect(view).toContain('<details v-else :open="isMismatch(q)"');
  expect(css).toContain('.ui-next-exam-run-question > summary { padding: 13px 14px; cursor: pointer; list-style: none; }');
  expect(css).toContain('.ui-next-exam-run-question > summary::-webkit-details-marker { display: none; }');
});

test('考試頁不顯示審查原因，但不影響 API 保存該值', () => {
  expect(view).not.toContain('q.review_reason');
  expect(view).not.toContain('ui-next-exam-run-reason');
});

test('官方確認題是不可展開的鎖定區塊', () => {
  expect(view).toContain("v-if=\"q.review_source==='official'\"");
  expect(view).toContain('ui-next-exam-run-official');
  expect(view).toContain('🔒');
});

test('更多工具只有一個認證入口，題庫改由考試頁右上進入', () => {
  expect(app).toContain("go('/exam-run')\"><ui-next-icon name=\"book\"/>ODOO認證輔助");
  expect(app).not.toContain("go('/exam-bank')");
  expect(app).not.toContain('考試作戰台</button>');
  expect(view).toContain("$router.push('/exam-bank')");
  expect(view).toContain('class="btn btn-outline btn-sm" @click="$router.push(\'/exam-bank\')">題庫</button>');
  expect(bankView).toContain('class="btn btn-outline btn-sm" @click="$router.push(\'/exam-run\')">← 考試頁</button>');
  expect(bankView).not.toContain("banks.length <= 1");
});

test('兩頁互動元件沿用平台的 focus-visible 與輸入框 focus 樣式', () => {
  expect(css).toContain('.ui-next-exam-chip:focus-visible');
  expect(css).toContain('.ui-next-exam-run-stat:focus-visible');
  expect(css).toContain('.ui-next-exam-run-card-head:focus-visible');
  expect(css).toContain('.ui-next-exam-search:focus');
  expect(css).toContain('.ui-next-exam-run-option label:has(input:focus-visible)');
  expect(css).toContain('outline: 2px solid color-mix(in srgb, var(--primary) 35%, transparent)');
});
