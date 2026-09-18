const fs = require('fs');
const path = require('path');
const { SKILLS_BY_SCOPE } = require('../lib/agent-mounts');

// 意圖（Rule 9）：這些 skill 同時被「互動式 session」與「容器裡的 pipeline agent」讀。
// 互動式那條要自己推 base URL 與通行碼；容器那條由平台注入閘道位址（http://<gw>:8080）
// 與每次執行通行證。SKILL.md 若教一段「無條件 export」，容器內的 agent 會照做，
// 把對的值蓋成 localhost:<PORT> 與全域通行碼——前者在容器裡沒人聽、後者 socket 側一律不認。
// 症狀是 agent 回報「平台服務沒起來」，然後改用別的來源答題，答案與 wiki 不符而完全不留錯誤紀錄
// （閘道只記轉發失敗，這種情況連轉發都沒發生）。實際發生過：chat 136 答備份保留 3 天，
// wiki 寫的是 14 天（2026-09-18）。所以 export 一律要先判「已經有值就別動」。
const SRC = path.join(__dirname, '..', '..', '..', '.claude', 'skills');
const MOUNTED = [...new Set(Object.values(SKILLS_BY_SCOPE).flat())];

describe('掛進容器的 skill 不得覆蓋平台注入的 /ai 連線設定', () => {
  test('有 skill 可檢查', () => {
    expect(MOUNTED.length).toBeGreaterThan(0);
  });

  test.each(MOUNTED)('%s/SKILL.md 的 export 都有「已設定就跳過」的護欄', (name) => {
    const file = path.join(SRC, name, 'SKILL.md');
    if (!fs.existsSync(file)) return; // 白名單允許列尚未建檔的 skill；缺檔由 agent-mounts 自己處理
    const bad = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /export\s+(AIDEV_AI_(?:BASE|TOKEN))=/.exec(line);
      if (!m) continue;
      // 同一行必須先判該變數是否已有值，才准 export
      if (!new RegExp(`\\[\\s*-n\\s*"\\$${m[1]}"\\s*\\]\\s*\\|\\|`).test(line)) bad.push(line.trim());
    }
    expect(bad).toEqual([]);
  });
});
