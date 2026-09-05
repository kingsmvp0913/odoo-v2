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
const routes = fs.readFileSync(
  path.join(__dirname, '../exam-upload-routes.js'), 'utf8');

test('考試頁是 POST 結果工作台，不再要求使用者手動上傳考題或啟動判題', () => {
  expect(view).toContain('外部 POST 後自動審題');
  expect(view).not.toContain('開始判題');
  // 考題截圖一律走外部 POST。頁面上唯一的 file input 是歸檔時讀官方成績單那顆，
  // 它讀完只預填欄位、不會送出，與「手動上傳考題」是兩件事。
  const fileInputs = view.match(/type="file"/g) || [];
  expect(fileInputs).toHaveLength(1);
  expect(view).toContain('@change="onScoreSheet"');
});

// 成績單本來就是一張圖，人再抄一次只是多一次出錯的機會——而抄錯會把錯的題
// 永久鎖成正解（歸檔不可逆）。所以讀完只預填，人對過再按確認歸檔。
test('讀成績單只預填欄位，不會直接歸檔', () => {
  expect(view).toContain('read-sections');
  expect(view).toContain('this.archivePages = this.archivePages.map');
  // onScoreSheet 裡不得出現送出歸檔的呼叫
  const fn = view.slice(view.indexOf('async onScoreSheet('), view.indexOf('archiveFilled()'));
  expect(fn).not.toContain('doArchive');
  expect(fn).not.toContain("banks/${this.bankId}/archive`,");
  // 對不上的章節要講出來，不能靜靜少填
  expect(fn).toContain('unmatchedPages');
  expect(fn).toContain('unusedTitles');
});

test('完整選項用勾選框設定正式答案，而且可以取消成空白', () => {
  expect(view).toContain('v-for="option in q.options"');
  expect(view).toContain('type="checkbox"');
  expect(view).toContain('@change="toggleFinal(q,option.letter,$event.target.checked)"');
  expect(view).toContain("!checked ? current.filter");
  expect(view).toContain('this.finalDraft = { ...this.finalDraft');
  expect(view).not.toContain('最後答案（可空白）');
});

// 原本一個選項最多掛五個標記（輸入答案／審查／投票／上次我選／上次已知答錯），
// 要同時讀五種形狀才判斷得出一題。審查與已知答錯已折進推薦分數，其餘改掛 title。
test('選項上只留推薦分數與投票，其餘訊號折進分數', () => {
  expect(view).toContain('name="thumb-up"');                       // 投票留著
  expect(view).toContain('topVote(q).answer');
  // 沒人投票時不留「投票 -」佔位：那一行對使用者沒有資訊（2026-09-05 使用者回饋）
  expect(view).not.toContain('投票 -');
  expect(view).not.toContain('<div class="ui-next-exam-run-answers">');
});

// 輸入答案刻意不另外標：worker 寫入時 answer_final 預設就等於作答答案，
// 勾選狀態本身就是它。多一個綠標只是重複同一件事。
test('輸入答案不另外標，改過之後靠 title 查得回原本輸入什麼', () => {
  expect(view).not.toContain('ui-next-exam-run-input-mark');
  expect(view).not.toContain('>輸入答案<');
  expect(view).toContain('這是原本輸入的答案');
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

// 公式本身在 server/lib/exam/score.js，由 exam-score.test.js 守。這裡只守「前端有
// 照著用後端算好的數字」——前端自己再算一份就會有兩套會漂移的實作。
test('推薦分數用後端算好的 option_scores，前端不自己算', () => {
  expect(view).toContain('q.option_scores');
  expect(view).not.toMatch(/EXAM_SCORE_FLOOR|normalize100/);
  expect(routes).toContain("require('./lib/exam/score')");
  expect(routes).toContain('a.option_scores = optionScores(');
  // 餵給公式的是拍板的答案，沒拍板才退回輸入答案——要與 confidence 的定義對齊
  expect(routes).toContain('? a.answer_final : a.answer_their');
});

test('選項上只留推薦分數與投票兩個標記', () => {
  expect(view).toContain('ui-next-exam-run-score');
  expect(view).toContain('is-vote');
  // 折進分數的三個原始訊號不該再各自畫一個標記
  expect(view).not.toContain('is-review');
  expect(view).not.toContain('is-past');
  expect(view).not.toContain('star-filled');
  // 但資訊不能消失——改掛 title
  expect(view).toContain('scoreWhy(q,option.letter)');
});

// 「還在跑」與「跑到一半死了」原本在畫面上長得一模一樣——兩者都是每一頁顯示
// 「等待審題」轉圈，等多久都不會變。判題狀態沒接前端，這件事就看不出來。
test('判題狀態接上前端，卡住時給得出「繼續判題」', () => {
  expect(view).toContain('exam/jobs?bank=');
  expect(view).toContain('jobState');
  // 三種狀態要分得開：跑著等就好／卡住要按繼續／失敗要看錯誤
  for (const k of ['running', 'stuck', 'failed']) expect(view).toContain(`'${k}'`);
  // 卡住＝有頁在等但沒有工作在跑；重啟打斷後最常見的就是這個
  expect(view).toContain("u.status === 'pending'");
  expect(view).toContain("j.status === 'interrupted'");
  // 繼續判題走既有的 POST /api/exam/run（本來就在，只是沒地方按得到）
  expect(view).toContain("Api.post('exam/run'");
  expect(css).toContain('.ui-next-exam-job.is-stuck');
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
  // 題庫頁的篩選用全站的頁籤列，不是自成一套的實心藥丸
  expect(bankView).toContain('class="ui-next-page-tabs"');
});

// 同一個 filter 有兩顆開關時，改了一邊另一邊會靜默不同步，而且畫面上看不出哪個才算數
test('作戰台的篩選只有數字卡一組，沒有第二排重複的頁籤', () => {
  expect(view).toContain('ui-next-exam-run-stats');
  expect(view).not.toContain('ui-next-page-tabs');
  // 沒有「只看沒問題」這個篩選，那張卡就不能長得像可以點
  expect(view).toContain('ui-next-exam-run-stat is-ok is-static');
  expect(css).toContain('.ui-next-exam-run-stat.is-static { cursor: default; }');
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
