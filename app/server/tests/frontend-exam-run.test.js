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

// 四個訊號各一種形狀，不用讀文字就分得出來。原本是「輸入答案／審查答案／
// 投票 100%」三串中文，長度不同、位置跟著浮動，掃視時要逐字讀。
test('各答案用圖示標在選項上，不再顯示下方答案區塊', () => {
  expect(view).toContain('name="star-filled"');                    // 審查
  expect(view).toContain('name="thumb-up"');                       // 投票
  // 歷史：可信＝綠問號＋信心度（只是「上次我這樣答」，沒有官方背書，
  // 用勾勾看起來跟已確認的一樣篤定）；大概率錯＝紅叉
  expect(view).toContain('v-if="q.history_wrong" name="close"');
  expect(view).toContain('<template v-else><i>?</i>');
  // 沒人投票時不留「投票 -」佔位：那一行對使用者沒有資訊（2026-09-05 使用者回饋）
  expect(view).not.toContain('投票 -');
  expect(view).toContain('topVote(q).answer');
  expect(view).not.toContain('<div class="ui-next-exam-run-answers">');
});

// 輸入答案刻意不另外標：worker 寫入時 answer_final 預設就等於作答答案，
// 勾選狀態本身就是它。多一個綠標只是重複同一件事。
test('輸入答案不另外標，改過之後靠 title 查得回原本輸入什麼', () => {
  expect(view).not.toContain('ui-next-exam-run-input-mark');
  expect(view).not.toContain('>輸入答案<');
  expect(view).toContain('這是原本輸入的答案');
});

// 星號旁邊要有數字：只有一顆星看不出「審查有多確定」，而那正是要不要
// 推翻自己作答的依據
test('審查星號帶著信心度百分比', () => {
  expect(view).toContain('q.review_confidence != null');
  expect(view).toContain('{{ q.review_confidence }}%');
});

// 「需確認」＝審查有意見，或又選了上次已知大概率錯的那個答案。
// 後者審查可能毫無異議（它跟上次一樣被騙），光看不一致抓不到。
test('只有需確認的題目預設展開，投票後按鈕消失', () => {
  expect(view).toContain(':open="needsCheck(q)"');
  expect(view).toContain('isMismatch(q) || this.repeatsKnownWrong(q)');
  expect(view).toContain('v-if="!q.has_voted"');
  expect(view).toContain('q.has_voted = true');
});

test('考試頁狀態不使用左側色條', () => {
  expect(css).not.toMatch(/\.ui-next-exam-run-(?:card|option)[^{]*\{[^}]*border-left/);
});

test('題目列隱藏原生展開箭頭但仍保留 details 收合能力', () => {
  expect(view).toContain('<details v-else :open="needsCheck(q)"');
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
  // 圖示走側欄那套線條 SVG，不是 emoji：emoji 的字重與大小跟著系統走，
  // 跟旁邊的圖示擺在一起像兩個時代的東西，缺字時還會變豆腐框
  expect(view).toContain('<ui-next-icon name="lock"');
  expect(view).not.toContain('🔒');
});

// 掃視時要能一眼跳過「不用看的題」——收合狀態下沒有這個標記就得一題題點開
test('一致且有把握的題在題號前掛勾勾，判準與題庫頁同一套', () => {
  expect(view).toContain('isSettled(q)');
  expect(view).toContain('<ui-next-icon v-if="isSettled(q)" name="check"');
  expect(view).toContain('q.review_confidence >= 70');
});

// 考題原文是英文，中譯只是輔助。看不到原文就無法確認翻譯有沒有把語意帶偏
test('選項與題幹一樣中英對照', () => {
  expect(view).toContain('ui-next-exam-run-opt-en');
  expect(view).toContain('v-if="option.text_zh && option.text"');
});

test('更多工具只有一個認證入口，題庫改由考試頁右上進入', () => {
  expect(app).toContain("go('/exam-run')\"><ui-next-icon name=\"book\"/>ODOO認證輔助");
  expect(app).not.toContain("go('/exam-bank')");
  expect(app).not.toContain('考試作戰台</button>');
  expect(view).toContain('@click="$router.push(\'/exam-bank\')">題庫</button>');
  expect(bankView).toContain('@click="$router.push(\'/exam-run\')">考試作戰台</button>');
  expect(bankView).not.toContain("banks.length <= 1");
});

// 兩頁是「更多工具」選單裡的一般頁面，不是 Admin 子頁。走錯外殼的症狀很難用肉眼歸因：
// 標題只有 24px、貼著頂端、多一條橫線、內容也不受 1180px 置中限寬，
// 但每一項單看都像「這頁就長這樣」。所以把外殼與按鈕系統釘死在這裡。
test('兩頁走主要頁面的外殼與按鈕，不是 Admin 子頁那一套', () => {
  for (const [name, src] of [['ExamRun', view], ['ExamBank', bankView]]) {
    expect(`${name}:${src}`).toContain('class="ui-next-page ui-next-exam-page"');
    expect(`${name}:${src}`).toContain('class="ui-next-page-head"');
    expect(`${name}:${src}`).toContain('class="ui-next-head-tools"');
    // .topbar／.content 是 Admin 子頁的殼，.btn btn-* 是 app.css 的舊按鈕系統
    expect(`${name}:${src}`).not.toContain('class="topbar');
    expect(`${name}:${src}`).not.toContain('class="content"');
    expect(`${name}:${src}`).not.toContain('class="btn btn-');
  }
  // 篩選用全站的頁籤列，不是自成一套的實心藥丸
  expect(view).toContain('class="ui-next-page-tabs"');
  expect(bankView).toContain('class="ui-next-page-tabs"');
});

test('兩頁互動元件沿用平台的 focus-visible 與輸入框 focus 樣式', () => {
  expect(css).toContain('.ui-next-exam-chip:focus-visible');
  expect(css).toContain('.ui-next-exam-run-stat:focus-visible');
  expect(css).toContain('.ui-next-exam-run-card-head:focus-visible');
  expect(css).toContain('.ui-next-exam-search:focus');
  expect(css).toContain('.ui-next-exam-run-option label:has(input:focus-visible)');
  expect(css).toContain('outline: 2px solid color-mix(in srgb, var(--primary) 35%, transparent)');
});

// 篩選要真的只留有問題的題目：原本只篩到「頁」，點進去整頁 12 題還是全部攤開，
// 要自己在裡面找哪幾題有問題（2026-09-05 使用者回饋）
test('只看需確認時，頁內也只留需確認的題目', () => {
  expect(view).toContain("this.filter === 'check' ? g.questions.filter(q => this.needsCheck(q))");
  expect(view).toContain("this.filter !== 'check' || g.questions.length");
});

// 照審查改完之後那題就該退出清單。比對 answer_their 的話清單永遠不會變短，
// 等於沒有「處理完」這件事。
test('一致與否比對的是最終答案，不是原始輸入', () => {
  expect(view).toContain('!this.sameAnswer(this.current(q), q.review_answer)');
  expect(view).toContain('q.answer_final) && q.answer_final.length) ? q.answer_final : q.answer_their');
});

// 作答是在審查完成前就建好的（saveVerdicts 要靠它們對應題號），所以題目會先冒出來、
// 判斷卻還沒寫進去。那時候計進統計，「需確認」會先跳一個假數字再自己變回去，
// 看起來像判錯又改口（2026-09-05 使用者回饋）。
test('還在跑的頁不計入統計', () => {
  expect(view).toContain('!g.is_test && !this.isBusy(g)');
});

// socket 從第一天起就沒綁上過：舊寫法去讀 window._socket，而那個全域根本不存在
// （_socket 是 socket.js 那個 IIFE 的區域變數）。失敗完全靜默——畫面只是退回
// 5 秒輪詢，沒有任何錯誤，所以一直沒人發現（2026-09-05 使用者回報）。
test('即時更新走 SocketManager，不要自己摸 window._socket', () => {
  const socket = fs.readFileSync(
    path.join(__dirname, '../../public/js/socket.js'), 'utf8');
  expect(socket).toContain('onSocket, offSocket');
  expect(view).toContain("SocketManager.onSocket('exam-progress'");
  // 只擋真正的用法，不擋註解裡解釋「為什麼不能用它」的那句
  expect(view).not.toMatch(/=\s*window\._socket|window\._socket\./);
  // 綁不到就每 300ms 重試的那個永不停止的計時器要一起拆掉
  expect(view).not.toContain('_sockTimer');
});

// 考卷本來就是 P1、P2… 這樣走，倒著排會讓人逆著找題號（2026-09-05 使用者回饋）
test('頁面依上傳順序由上而下，先傳的在最上面', () => {
  expect(view).toContain('.sort((a, b) => a.id - b.id)');
});

// 本頁沒有題庫選擇器，bankId 只在 created 設一次＝「最新的那個」只在開頁那一刻算。
// 頁面開著時新建的題庫永遠不會出現，而症狀長得像 socket 壞掉（2026-09-05 使用者回報）。
test('每次 refresh 都重抓題庫清單並跟到最新的那一場', () => {
  // 抓題庫清單必須在 refresh() 裡（每輪都會跑），不能只留在 created()
  const refreshBody = view.slice(view.indexOf('async refresh()'));
  expect(refreshBody).toContain("this.banks = await Api.get('exam/banks')");
  expect(refreshBody).toContain('this.bankId = latest');
  // created 不得自己再抓一份，否則「跟到最新」有兩份實作會漂移
  expect(view.match(/Api\.get\('exam\/banks'\)/g)).toHaveLength(1);
});

describe('串接說明跳窗', () => {
  test('右上有入口，開的是 modal 不是內嵌面板', () => {
    expect(view).toContain('串接說明');
    expect(view).toContain('ui-next-task-modal-backdrop');
    // 沒有題庫時最需要看串接說明（那正是還沒開始傳的時候），
    // 所以入口不能被 v-else-if="!banks.length" 之後那一段包住
    expect(view.indexOf('串接說明')).toBeLessThan(view.indexOf('!banks.length'));
  });

  test('產通行碼走 POST，並把效期一起顯示', () => {
    expect(view).toContain("Api.post('exam/upload-token'");
    expect(view).toContain("Api.get('exam/upload-token')");
    expect(view).toContain('tokenExpiresAt');
  });

  // .ui-next-modal-close 全站沒有任何 CSS（同 .btn-secondary 那個家族），
  // 用了等於放一顆裸按鈕。這裡改用真的有樣式的 btn。
  test('關閉鈕不用沒有樣式的 ui-next-modal-close', () => {
    expect(view).not.toContain('ui-next-modal-close');
  });
});
