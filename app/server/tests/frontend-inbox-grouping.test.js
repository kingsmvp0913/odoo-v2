// 意圖：收件匣一則卡片＝一次「標記已讀」。收合條件漏掉哪一種重複，使用者就要為同一件事
// 多按幾次——這正是實際回報的症狀。原本的條件是「相鄰 ＋ 兩則都是 bounce ＋ 同任務」，
// 於是同任務的 action 完全不收合（'stopped' 是等人狀態，pipeline 裡二十幾個派送點各停一次
// 就各寫一筆 action），action 與 bounce 交錯時也不收合。
//
// 這支不掃字串、直接把 Inbox.js 裡真的那段 grouped() 切出來跑：測試複製一份平行實作的話，
// 來源改壞了複製品照樣綠。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../public/js/views/Inbox.js');

// Inbox.js 整支依賴 Vue 全域，無法直接 require；只取 grouped 這個 computed 來跑。
// 收尾靠「4 空格縮排的 },」定位：方法內部的閉合都在 6／8 空格，不會誤中。
function loadGrouped() {
  const src = fs.readFileSync(SRC, 'utf8');
  const from = src.indexOf('    grouped() {');
  const END = '\n    },';
  const to = src.indexOf(END, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);

  const obj = new Function(`return ({ ${src.slice(from, to + END.length)} });`)();
  return (items) => obj.grouped.call({ items });
}

// created_at DESC，所以陣列前面的是比較新的那則
const ev = (id, task_id, kind, extra = {}) => ({ id, task_id, kind, read_at: null, ...extra });

describe('收件匣收合：一張卡片要能一次清掉同任務的全部未讀', () => {
  const grouped = loadGrouped();

  test('同任務連續的 action 收合成一則，ids 帶齊全部（否則同一件事要按好幾次已讀）', () => {
    const out = grouped([
      ev(3, 7, 'action', { status: 'stopped' }),
      ev(2, 7, 'action', { status: 'stopped' }),
      ev(1, 7, 'action', { status: 'stopped' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
    expect(out[0].ids).toEqual([3, 2, 1]);   // markRead 逐筆送這串，漏一個就留一則未讀
  });

  test('同任務的 action 與 bounce 交錯也收合（退回後停下來是同一件事的兩則紀錄）', () => {
    const out = grouped([
      ev(4, 7, 'action', { status: 'stopped' }),
      ev(3, 7, 'bounce'),
      ev(2, 7, 'bounce'),
      ev(1, 7, 'action', { status: 'stopped' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].ids).toEqual([4, 3, 2, 1]);
  });

  test('收合後顯示最新那則的 kind／status（卡片要說得出「現在」是什麼情況）', () => {
    const out = grouped([
      ev(2, 7, 'action', { status: 'review_pending' }),
      ev(1, 7, 'bounce', { status: 'coding_running' }),
    ]);
    expect(out[0].kind).toBe('action');
    expect(out[0].status).toBe('review_pending');
  });

  test('不同任務不收合（收過頭會把別人的未讀一起標掉）', () => {
    const out = grouped([ev(2, 8, 'action'), ev(1, 7, 'action')]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.task_id)).toEqual([8, 7]);
  });

  test('中間夾了別的任務就分段（收合只認相鄰，時間順序不被壓扁）', () => {
    const out = grouped([ev(3, 7, 'bounce'), ev(2, 8, 'bounce'), ev(1, 7, 'bounce')]);
    expect(out.map((r) => r.count)).toEqual([1, 1, 1]);
  });

  // ?all=1 下同一群組可能新的已讀、舊的未讀。群組沿用最新那則的 read_at 的話，整組會被當成
  // 已讀 → 「標記已讀」鈕（v-if="!row.read_at"）消失，底下那幾則就再也點不到了。
  test('群組內只要有一則未讀就算未讀', () => {
    const out = grouped([
      ev(2, 7, 'action', { read_at: '2026-08-18T00:00:00Z' }),
      ev(1, 7, 'bounce'),
    ]);
    expect(out[0].read_at).toBeNull();
  });

  test('整組都已讀就是已讀（不可把已讀的也一律當未讀，那 badge 與畫面又對不上）', () => {
    const read = { read_at: '2026-08-18T00:00:00Z' };
    const out = grouped([ev(2, 7, 'action', read), ev(1, 7, 'bounce', read)]);
    expect(out[0].read_at).not.toBeNull();
  });
});

// 這條線斷掉是零訊號的：TaskDetail 那邊 catch 掉所有錯誤（收件匣不是任務頁的關鍵路徑），
// 端點改名或路徑打錯只會讓「進任務就已讀」靜靜失效，畫面上什麼都看不出來。
describe('「進任務就已讀」的前後端接線', () => {
  test('TaskDetail 進頁時打 inbox/task/:id/read，且後端真的有這支', () => {
    const detail = fs.readFileSync(path.join(__dirname, '../../public/js/views/TaskDetail.js'), 'utf8');
    expect(detail).toMatch(/Api\.post\(`inbox\/task\/\$\{[^}]+\}\/read`\)/);
    expect(detail).toMatch(/this\.markInboxRead\(\)/);   // 有方法但沒人呼叫＝等於沒做

    const routes = fs.readFileSync(path.join(__dirname, '../inbox-routes.js'), 'utf8');
    expect(routes).toContain("app.post('/api/inbox/task/:taskId/read'");
  });

  test('清完要校正 badge，否則數字要等下次換頁才更新', () => {
    const detail = fs.readFileSync(path.join(__dirname, '../../public/js/views/TaskDetail.js'), 'utf8');
    const body = detail.match(/async markInboxRead\(\)\s*\{[\s\S]*?\n    \},/)[0];
    expect(body).toContain('loadInboxUnread');
  });
});
