// 意圖：時間軸的「機器輸入型 log 收合」有兩種失效方式，兩種都不會報錯：
//   (1) 只比前綴不比 role → 使用者把那則整段複製、貼進提問框發問，他自己的發言被折成 AI 的那句人話，
//       畫面上看起來像 AI 又講了一遍。
//   (2) 前綴字面值散在前後端各處 → 有人改了後端寫入端卻沒改前端收合表，後端測試照綠、前端靜默失效，
//       使用者直接吃回整段技術文。
// 前者用行為測試釘住（同一段文字、role 不同結果必須不同），後者用靜態守衛釘住（任何檔案都不得
// 再自帶前綴字面值；不是我們的檔案則反過來斷言它寫的仍是 registry 那一個）。
const fs = require('fs');
const path = require('path');
const {
  MACHINE_LOGS, machineLogHeader, stripMachineHeader, machineLogHint
} = require('../../public/js/machine-logs.js');

const QA = MACHINE_LOGS.qa_fail;
const TRIAGE = MACHINE_LOGS.respec_handoff;
const CS = MACHINE_LOGS.cs_code_change;

describe('收合必須同時比對 role（bug：使用者自己的發言被收合）', () => {
  // 實際觸發情境：使用者複製 [QA 未通過] 那則整段、貼進提問框問「這是什麼意思」。
  // 那段原文會以 role='user' 原樣寫進 task_logs（tasks-routes 的澄清回答／提問、pipeline-routes 的
  // 規格審核意見／cs 追問四條路徑），而前端把所有 task_logs 一律映成 kind:'log'，不分 role。
  const qaLog = `${QA.prefix}\n1. 欄位 note_t 型別錯誤\n2. form view 沒加備註欄位`;

  test('AI 寫的 QA 未通過 → 收合成人話', () => {
    expect(machineLogHint('ai', qaLog)).toBe(QA.hint);
  });

  test('使用者原樣貼回同一段文字（role=user）→ 不得收合', () => {
    expect(machineLogHint('user', qaLog)).toBeNull();
  });

  // 反向：分診交棒刻意以 role='user' 寫入（偽裝成使用者澄清餵給重跑的 analysis），
  // 所以它的 role 綁定是 user——寫成 ai 一律收合會反過來漏收這條。
  test('分診交棒（role=user）→ 收合；同樣文字掛 role=ai → 不收合', () => {
    const log = `${TRIAGE.prefix}\n規格要改成依倉庫別分開統計`;
    expect(machineLogHint('user', log)).toBe(TRIAGE.hint);
    expect(machineLogHint('ai', log)).toBeNull();
  });

  test('一般對話不受影響', () => {
    expect(machineLogHint('user', '請問這個什麼時候好')).toBeNull();
    expect(machineLogHint('ai', '已完成，請確認')).toBeNull();
  });
});

describe('QA 的去向後綴：停等人工時不得寫成「已自動退回開發修正」', () => {
  test('帶去向 → chip 說的是這一則的真實去向', () => {
    const log = `${machineLogHeader('qa_fail', '循環次數已達上限，任務停下等你處理')}\n問題清單`;
    expect(machineLogHint('ai', log)).toBe(`${QA.hint}，循環次數已達上限，任務停下等你處理`);
    expect(machineLogHint('ai', log)).not.toContain('退回開發');
  });

  test('無去向後綴（本次改動前寫下的舊資料）→ 退回泛用 hint，不亂編去向', () => {
    expect(machineLogHint('ai', `${QA.prefix}\n問題清單`)).toBe(QA.hint);
  });

  // strip 契約：去向只能活在標頭列。剝不乾淨的話它會混進下一輪 QA 的未解清單被當成待驗項，
  // QA 會對著「已自動退回開發修正」這句話重驗。
  test('去向後綴會連同前綴一起被剝掉，不進未解清單', () => {
    const body = '1. 欄位型別錯誤\n2. view 沒掛上去';
    const log = `${machineLogHeader('qa_fail', '已自動退回開發修正')}\n${body}`;
    expect(stripMachineHeader('qa_fail', log)).toBe(body);
  });

  // 界定符是全形括號而非「吃到行尾」：既有資料有寫成單行「<前綴> <本體>」的（見 qa-agent.test.js
  // 的 pg-mem fixture），吃到行尾的剝法會把本體整段吞掉，QA 下一輪拿到空清單。
  test('單行舊格式「<前綴> <本體>」的本體不得被吞掉', () => {
    expect(stripMachineHeader('qa_fail', `${QA.prefix} 按鈕位置未緊鄰新增按鈕`)).toBe('按鈕位置未緊鄰新增按鈕');
  });
});

describe('cs 判定：只收合 fallback 的技術文，不收合白話說明', () => {
  // reason_plain 是白話短句、本來就是寫給人讀的，收合它等於藏掉唯一看得懂的說明。
  test('reason_plain（短）→ 不收合，使用者直接看到白話', () => {
    const log = `${CS.prefix}\n這個是報表沒有把退貨單排除掉，要改程式才會正確。`;
    expect(machineLogHint('ai', log)).toBeNull();
  });

  // 模型漏吐 reason_plain 時退回貼技術版 reason（實測平均 906 字）——a143fc8 要解的症狀
  test('reason fallback（長技術文）→ 收合', () => {
    const log = `${CS.prefix}\n${'stock/models/stock_move.py 的 _action_done 未過濾 returned qty。'.repeat(20)}`;
    expect(log.length).toBeGreaterThan(400);
    expect(machineLogHint('ai', log)).toBe(CS.hint);
  });
});

// 分診結論與客服回覆並排在同一條時間軸上，但讀者完全不同：前者講 Model／檔名／根因（寫給開發），
// 後者是講給客戶聽的白話。收錯邊的代價不對稱——漏收只是畫面吵，錯收會把唯一看得懂的說明藏起來。
describe('分診結論：技術文收合，但回答使用者的那則不收', () => {
  test('帶去向 → chip 講得出「接下來會怎樣」，不只是「有東西被收起來」', () => {
    const c = `${machineLogHeader('triage_summary', '轉回開發修正')}\n審核者複審退回三項技術缺陷：批次工具的 search() 未帶 active_test=False`;
    expect(machineLogHint('ai', c)).toBe('已判斷這次退回要怎麼處理，轉回開發修正');
  });

  // 刻意不設 collapseWhenLong：實測分診結論平均 247~433 字，比照 cs 設門檻的話幾乎永遠不會觸發，
  // 而「短」跟「看得懂」是兩回事——247 字的純技術文一樣沒人讀得下去。
  test('短的分診結論一樣要收（設了長度門檻就會靜默失效）', () => {
    const c = `${machineLogHeader('triage_summary', '放行往下一關')}\n審核者確認寫法正確，予以保留。`;
    expect(machineLogHint('ai', c)).toBeTruthy();
  });

  // reject-triage.js 的 answer 分支（使用者在最終審核關單純發問）刻意不帶前綴：那則是回答本人的話。
  test('回答使用者提問的那則不帶前綴 → 整段顯示', () => {
    expect(machineLogHint('ai', '好，兩個都做，理由成立：批次工具負責清掉已經卡住、按鈕已隱藏的舊單。')).toBeNull();
  });

  test('使用者把分診結論整段複製貼回提問框（role=user）→ 不得收合', () => {
    const c = `${machineLogHeader('triage_summary', '轉回開發修正')}\n審核者複審退回三項技術缺陷`;
    expect(machineLogHint('user', c)).toBeNull();
  });
});

describe('前綴單一來源（改了後端卻沒改前端＝靜默失效）', () => {
  const root = path.join(__dirname, '../..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  // 註解先剝掉：說明文字裡出現前綴是正常的，會被誤判成第二份定義。
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const PREFIXES = Object.values(MACHINE_LOGS).map((m) => m.prefix);

  // 走訪全樹而非寫死清單（比照 frontend-status-labels）：寫死清單只擋得住當初改到的那幾支，
  // 下一支新 view／新 pipeline 關卡照樣能複製一份前綴進來。
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    (e.name === 'vendor' || e.name === 'node_modules' || e.name === 'tests') ? [] :
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const scanned = [...walk(path.join(root, 'public')), ...walk(path.join(root, 'server'))]
    .map((f) => path.relative(root, f))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => f !== path.join('public', 'js', 'machine-logs.js'));
  // reject-triage.js 原本因「尚未接上 registry」被豁免、改用反向守衛盯字面值。2026-08-31 它兩處寫入
  // （respec 交棒、分診結論）都改走 machineLogHeader 了，豁免與反向守衛一併移除——正向掃描本來就更強。

  test('掃到合理數量的檔案（walk 失效時測試不得靜默通過）', () => {
    expect(scanned.length).toBeGreaterThan(50);
  });

  test.each(scanned)('%s 不得自帶機器 log 前綴字面值', (file) => {
    const src = stripComments(read(file));
    expect(PREFIXES.filter((p) => src.includes(p))).toEqual([]);
  });

  test('index.html 載入 machine-logs.js（漏載入＝TaskDetail 呼叫時整頁白畫面）', () => {
    expect(read(path.join('public', 'index.html'))).toContain('<script src="js/machine-logs.js"></script>');
  });
});
