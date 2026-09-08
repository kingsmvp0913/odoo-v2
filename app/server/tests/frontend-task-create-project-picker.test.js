// 意圖：建立任務彈窗的專案欄要能打字過濾，而且順序要「我的最愛 → 最近有互動 → 其餘按中文名」。
//
// 使用者回報（2026-09-07）：那一格是原生 <select>，只能滑鼠下拉，選項就是 API 回傳的原始順序。
// 專案數量到三十幾個時，每次建立任務都要從頭捲著找。
//
// 這裡不比對字串（改寫法就繞過），而是把檔案丟進 vm sandbox、用假的 Vue.defineComponent
// 收下 options 物件，直接呼叫真正的 computed。同 frontend-tasklist.test.js 的做法。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const readPublic = (file) => fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8');

// UiNextShared.js 與 TaskList.js 都是 classic script，共用同一個 sandbox 才拿得到 window.UiNextShared。
function loadViews() {
  const sandbox = {
    window: { UiNextIcon: {}, STATUS_LABELS: {}, HUMAN_STATUSES: [], RUNNABLE_STATUSES: [] },
    document: { addEventListener() {}, removeEventListener() {} },
    Vue: { defineComponent: (o) => o },
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(readPublic('js/ui-next/UiNextShared.js'), sandbox);
  vm.runInContext(readPublic('js/ui-next/pages/TaskList.js'), sandbox);
  return { shared: sandbox.window.UiNextShared, taskList: sandbox.window.UiNextTaskListView, sandbox };
}

const at = (iso) => iso;

test('sandbox 真的載到了元件（harness 壞掉時測試不得靜默通過）', () => {
  const { shared, taskList } = loadViews();
  expect(typeof shared.sortProjectsForPicker).toBe('function');
  expect(typeof shared.UiNextProjectPicker.computed.filtered).toBe('function');
  expect(typeof taskList.computed.sortedProjects).toBe('function');
});

// 原生 select 沒有這件事：選項就是 API 給的順序，使用者只能滑鼠捲。
test('建立任務的專案欄不再是原生 select，而是可打字過濾的 combobox', () => {
  const { taskList, shared } = loadViews();
  const tpl = taskList.template;
  const modalAt = tpl.indexOf('ui-next-task-create-title');
  expect(modalAt).toBeGreaterThan(-1);
  const modal = tpl.slice(modalAt, modalAt + 1200);
  expect(modal).toContain('<ui-next-project-picker');
  expect(modal).not.toMatch(/<select v-model="newTask\.project_id"/);
  // 「可打字過濾」是這條回饋的核心，元件真的要做得到
  const picker = shared.UiNextProjectPicker;
  const projects = [{ id: 1, name: '鴻久' }, { id: 2, name: '萊峰' }];
  expect(picker.computed.filtered.call({ projects, query: ' 萊 ' })).toEqual([{ id: 2, name: '萊峰' }]);
  expect(picker.computed.filtered.call({ projects, query: '' })).toEqual(projects);
});

describe('排序規則（UiNextShared.sortProjectsForPicker）', () => {
  const { shared } = loadViews();
  const names = (list) => list.map((p) => p.name);

  test('我的最愛排最前面，其次最近有互動，其餘按中文名', () => {
    const projects = [
      { id: 1, name: '丙專案' },
      { id: 2, name: '乙專案' },
      { id: 3, name: '甲專案', is_favorite: true },
      { id: 4, name: '丁專案' },
    ];
    const sorted = shared.sortProjectsForPicker(projects, [
      { project_id: 4, at: at('2026-09-06T00:00:00Z') },
      { project_id: 2, at: at('2026-09-07T00:00:00Z') },
    ]);
    // 最愛 → 最近（乙比丁新）→ 沒互動的丙
    expect(names(sorted)).toEqual(['甲專案', '乙專案', '丁專案', '丙專案']);
  });

  test('同一個專案有多筆互動時取最新的那一筆（不是最後出現的那筆）', () => {
    const projects = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
    const sorted = shared.sortProjectsForPicker(projects, [
      { project_id: 1, at: at('2026-09-08T00:00:00Z') },
      { project_id: 1, at: at('2026-01-01T00:00:00Z') },
      { project_id: 2, at: at('2026-09-07T00:00:00Z') },
    ]);
    expect(names(sorted)).toEqual(['A', 'B']);
  });

  // 刻意用 ASCII 名：中文的先後取決於 collation（zh-Hant 是筆劃序，不是注音序），
  // 拿中文當期望值會變成在測 ICU 而不是在測這段程式。
  test('沒有任何互動紀錄時整份照名稱排，不是 API 的原始順序', () => {
    const projects = [{ id: 1, name: 'Beta' }, { id: 2, name: 'Alpha' }];
    expect(names(shared.sortProjectsForPicker(projects, []))).toEqual(['Alpha', 'Beta']);
  });
});

// 這條才是「與首頁唯一的差異」：首頁只算最近有對話，建立任務還要算最近有任務。
// 少了任務那一半，剛開過任務的專案會被排到最後——而那正是使用者要來開下一張任務的專案。
describe('第二順位同時看「最近有對話」與「最近有任務」', () => {
  const { taskList } = loadViews();
  const sortedNames = (ctx) => taskList.computed.sortedProjects.call(ctx).map((p) => p.name);

  const projects = [
    { id: 1, name: '只有對話' },
    { id: 2, name: '只有任務' },
    { id: 3, name: '兩者都沒有' },
  ];

  test('只有任務紀錄的專案也算「最近有互動」，排在沒互動的前面', () => {
    expect(sortedNames({
      projects,
      recentChatProjects: [{ project_id: 1, last_message_at: at('2026-09-01T00:00:00Z') }],
      tasks: [{ project_id: 2, updated_at: at('2026-09-07T00:00:00Z') }],
      archivedTasks: [],
    })).toEqual(['只有任務', '只有對話', '兩者都沒有']);
  });

  test('同一專案兩種都有時取較新的那個時間', () => {
    // 舊對話 ＋ 新任務：若只看對話，「只有對話」那個會被排到前面。
    expect(sortedNames({
      projects: [{ id: 1, name: '舊對話新任務' }, { id: 2, name: '中間的對話' }],
      recentChatProjects: [
        { project_id: 1, last_message_at: at('2026-01-01T00:00:00Z') },
        { project_id: 2, last_message_at: at('2026-05-01T00:00:00Z') },
      ],
      tasks: [{ project_id: 1, updated_at: at('2026-09-07T00:00:00Z') }],
      archivedTasks: [],
    })).toEqual(['舊對話新任務', '中間的對話']);
  });

  test('任務沒有 updated_at 時退回 created_at，不會被當成「沒互動」', () => {
    expect(sortedNames({
      projects,
      recentChatProjects: [],
      tasks: [{ project_id: 2, created_at: at('2026-09-07T00:00:00Z') }],
      archivedTasks: [],
    })[0]).toBe('只有任務');
  });
});

// 排序要有資料才成立：少抓這一支，第二順位就只剩任務那一半。
test('任務列表開頁時會抓 chats/sidebar-projects', () => {
  expect(readPublic('js/ui-next/pages/TaskList.js')).toContain('Api.get("chats/sidebar-projects")');
});
