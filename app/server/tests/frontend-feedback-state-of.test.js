// 意圖：改善提案列表的「狀態」欄講的是「這一筆現在卡在哪」。機器退場（platform-fix 判 no_change、
// 或連續失敗達門檻）會把 feedback 寫回 status='new' 並在 triage_note 冠上前綴，但**人後來處置時
// 不會清掉那個 triage_note**（feedback-routes.js 的 PATCH 只寫 status／verdict_note）。
//
// 於是只看前綴的話，已經修完合併的提案會永遠掛著「自動退場，待人工」——2026-09-21 實際踩到：
// #37（wall-clock p90）與 #38（*_running 回收）早已人工修好、status='done'，列表仍顯示待人工，
// 看起來像有兩筆沒人理。症狀是純顯示的，資料完全正確，所以任何後端測試都照樣全綠。
//
// 這支不掃字串、直接把 AdminFeedback.js 裡真的那段 stateOf 切出來跑（同 frontend-inbox-grouping）：
// 測試複製一份平行實作的話，來源改壞了複製品照樣綠。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../public/js/ui-next/pages/AdminFeedback.js');

// 整支依賴 Vue 全域，在 node 裡 require 不起來；只取 stateOf 這個 method 來跑。
// 收尾靠「6 空格縮排的 },」定位：method 內部的閉合都在 8 空格以上，不會誤中。
function loadStateOf() {
  const src = fs.readFileSync(SRC, 'utf8');
  const from = src.indexOf('      stateOf(r) {');
  const END = '\n      },';
  const to = src.indexOf(END, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);

  // stateOf 讀外層的 STATUS_LABEL 常數與 this.pillClass；兩個都餵進去，不在測試裡重寫一份。
  const STATUS_LABEL = { new: '待審核', approved: '已核准', rejected: '已駁回', done: '已完成' };
  const obj = new Function('STATUS_LABEL', `return ({ ${src.slice(from, to + END.length)} });`)(STATUS_LABEL);
  return (r) => obj.stateOf.call({ pillClass: () => 'pill-stub' }, r);
}

const RETIRED = '自動退場：platform-fix 判斷不需要修改（no_change）';

describe('改善提案的狀態欄：機器退場只在還沒有人處置時才算數', () => {
  const stateOf = loadStateOf();

  test("status 還是 'new'：印「自動退場，待人工」（否則看起來像使用者剛提的新意見）", () => {
    const s = stateOf({ status: 'new', triage_note: RETIRED });
    expect(s.label).toBe('自動退場，待人工');
    expect(s.hint).toBe(RETIRED);   // 理由要看得到，不然使用者不知道為什麼被踢回來
  });

  test('人工修完標 done：印「已完成」，不得因為 triage_note 還留著前綴而顯示待人工', () => {
    const s = stateOf({ status: 'done', triage_note: RETIRED });
    expect(s.label).toBe('已完成');
  });

  test('人工駁回：印「已駁回」，同上', () => {
    const s = stateOf({ status: 'rejected', triage_note: RETIRED });
    expect(s.label).toBe('已駁回');
  });

  test('退場後人工再核准：回到夜間批次的隊伍，不再是「待人工」', () => {
    const s = stateOf({ status: 'approved', triage_note: RETIRED });
    expect(s.label).toBe('已核准');
  });

  test('沒有退場前綴的一般意見：照 status 對照表印', () => {
    expect(stateOf({ status: 'new', triage_note: '' }).label).toBe('待審核');
  });
});
