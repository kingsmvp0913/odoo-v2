const { diff, listFiles, SRC } = require('../../../scripts/sync-skills');

// 意圖（Rule 9）：skill 有兩份實體副本——`.claude/skills/`（Claude Code 讀）與
// `.agents/skills/`（Codex 讀）。改了來源卻忘記同步副本，不會有任何徵狀：測試全綠、
// 畫面正常，Codex 照樣載入舊版 SKILL.md，然後照著過期指示辦事。這種漂移在這個 repo
// 已經以別的形式踩過（agent prompt 片段、新手教學錨點），共通點都是「靠人記得」而
// 沒有訊號。這支測試就是那個訊號。
describe('skill 副本與來源同步', () => {
  test('.agents/skills 是 .claude/skills 的最新副本', () => {
    // 空陣列＝同步；不同步時 problems 會逐檔說明是缺檔、內容不一致還是該刪
    expect(diff()).toEqual([]);
  });

  // 意圖：上面那條在「來源目錄整個消失」時也會過（沒有來源檔就沒有不一致），
  // 那正是最該紅的情況。釘一個下限，讓比對永遠有實際內容。
  test('來源目錄有 skill 可比對', () => {
    expect(listFiles(SRC).length).toBeGreaterThan(0);
  });
});
