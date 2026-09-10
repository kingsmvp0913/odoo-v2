// 意圖：側欄專案清單＝我的最愛 ＋ 最近 15 天有任務或對話的專案。使用者的抱怨是「這幾天在忙的
// 專案不在側欄，每次都要繞去專案列表」——舊規則只看「最近有對話的前 5 名」，所以只開任務、
// 不開 chat 的專案永遠進不來，而一個半年前聊過的專案反而長住側欄。
//
// 這支不掃字串、直接把 UiNextApp.js 裡真的那段 sidebarProjects() 切出來跑：測試複製一份平行
// 實作的話，來源改壞了複製品照樣綠（同 frontend-inbox-grouping.test.js 的做法）。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../public/js/ui-next/UiNextApp.js');

// UiNextApp.js 整支依賴 Vue 全域，無法直接 require；只取 sidebarProjects 這個 computed 來跑。
// 收尾靠「6 空格縮排的 },」定位：方法內部的閉合都在 8 空格以上，不會誤中。
function loadSidebarProjects() {
  const src = fs.readFileSync(SRC, 'utf8');
  const from = src.indexOf('      sidebarProjects() {');
  const END = '\n      },';
  const to = src.indexOf(END, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);

  const obj = new Function(`return ({ ${src.slice(from, to + END.length)} });`)();
  return (state) => obj.sidebarProjects.call({
    projects: [], sidebarChatProjects: [], sidebarTasks: [], currentProjectId: "", ...state,
  });
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
const proj = (id, name, is_favorite = false) => ({ id, name, is_favorite });
const names = (rows) => rows.map((r) => r.name);

describe('側欄專案：我的最愛 ＋ 最近 15 天有任務或對話', () => {
  const sidebarProjects = loadSidebarProjects();

  test('只有任務、沒有對話的專案也要進側欄（舊規則只看對話，這種專案永遠看不到）', () => {
    const rows = sidebarProjects({
      projects: [proj(1, '甲'), proj(2, '乙')],
      sidebarTasks: [{ project_id: 1, updated_at: daysAgo(2) }],
    });
    expect(names(rows)).toEqual(['甲']);
  });

  test('15 天內有對話的專案要進側欄', () => {
    const rows = sidebarProjects({
      projects: [proj(1, '甲'), proj(2, '乙')],
      sidebarChatProjects: [{ project_id: 2, last_message_at: daysAgo(14) }],
    });
    expect(names(rows)).toEqual(['乙']);
  });

  test('超過 15 天的活動不進側欄——否則久未碰的專案會長住，擠掉這週在忙的', () => {
    const rows = sidebarProjects({
      projects: [proj(1, '甲'), proj(2, '乙')],
      sidebarChatProjects: [{ project_id: 1, last_message_at: daysAgo(16) }],
      sidebarTasks: [{ project_id: 2, updated_at: daysAgo(200) }],
    });
    expect(rows).toEqual([]);
  });

  test('我的最愛不受 15 天限制，且永遠排在最前面', () => {
    const rows = sidebarProjects({
      projects: [proj(1, '甲'), proj(2, '乙', true)],
      sidebarTasks: [{ project_id: 1, updated_at: daysAgo(1) }],
    });
    expect(names(rows)).toEqual(['乙', '甲']);
  });

  test('同一專案既是最愛又有近期活動時只出現一次（重複列會讓側欄看起來像壞了）', () => {
    const rows = sidebarProjects({
      projects: [proj(1, '甲', true)],
      sidebarChatProjects: [{ project_id: 1, last_message_at: daysAgo(1) }],
      sidebarTasks: [{ project_id: 1, updated_at: daysAgo(1) }],
    });
    expect(rows).toHaveLength(1);
  });

  test('目前開著的專案即使沒有近期活動也要補進來（否則側欄選不到自己在哪）', () => {
    const rows = sidebarProjects({
      projects: [proj(7, '舊專案')],
      currentProjectId: '7',
    });
    expect(names(rows)).toEqual(['舊專案']);
  });

  test('活動時間缺值或壞掉不算最近，也不得讓整份清單爆掉', () => {
    const rows = sidebarProjects({
      projects: [proj(1, '甲'), proj(2, '乙')],
      sidebarChatProjects: [{ project_id: 1, last_message_at: null }],
      sidebarTasks: [{ project_id: 2, updated_at: 'not-a-date' }, { project_id: null, updated_at: daysAgo(1) }],
    });
    expect(rows).toEqual([]);
  });

  test('活動指到已不存在的專案（剛被刪掉）時跳過，不得混進 undefined 讓排序炸掉', () => {
    const rows = sidebarProjects({
      projects: [proj(1, '甲')],
      sidebarTasks: [{ project_id: 999, updated_at: daysAgo(1) }, { project_id: 1, updated_at: daysAgo(1) }],
    });
    expect(names(rows)).toEqual(['甲']);
  });
});
