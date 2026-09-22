// 意圖：側欄的「專案清單」與「最近對話」會過期，使用者得按 F5。真因是 ui-next 外殼是根元件、
// 只 mounted 一次，換頁不會重掛，那兩份清單於是停在進站當下的樣子（任務那五筆有 socket 推、
// 未讀數由 socket.js 直接寫，所以只有這兩份會爛）。
// 修法兩件：(1) 各頁面在伺服器確認之後丟 ui-next:sidebar-refresh，外殼監聽重載；
//           (2) 換頁時，只在「側欄範疇」真的變了才補刷。
//
// 這個 repo 沒有任何 DOM 測試，上面兩件事全是前端程式碼的結構決定，人工開瀏覽器驗完就沒人再驗。
// 本檔比照 frontend-tenant-guard.test.js 的手法：讀原始碼字面、切片比對，把每個決定釘住。
// 不 require UiNextApp.js——它依賴 Vue／VueRouter 等瀏覽器全域，在 node 環境載不起來。
//
// ⚠ 盲區（打算相信它之前先讀完）
//  A. 只認字面。dispatchEvent 改成包一層 helper、事件名改用常數、anchors 那幾句被改寫，
//     本檔會紅——那時該教它新寫法，不是把程式改回舊字面。
//  B. 只認清單上的 9 個發射點。新頁面新增了會動這兩份清單的操作卻沒發事件，本檔看不見
//     （沒有「所有 mutation 都必須發事件」的自動推導，Api.post/put/delete 太多支無法一概而論）。
//  C. 驗「條件的字面」不驗「條件的值」：監聽器掛著但 reloadSidebarLists 內部壞掉、
//     或事件根本沒人收（元件早就 unmount），本檔照樣全綠。
//  D. legacy 前端（app/public/js/views/）不在掃描範圍，也不該進——它已不維護。
//
// 每一份切片都先斷言自己切得到、且發射點總數對得上：掃不到東西的守衛會永遠靜默通過。
const fs = require('fs');
const path = require('path');

const EVENT = 'ui-next:sidebar-refresh';
const EMIT = `window.dispatchEvent(new CustomEvent("${EVENT}"))`;

const uiNext = path.join(__dirname, '..', '..', 'public', 'js', 'ui-next');
const read = (...parts) => fs.readFileSync(path.join(uiNext, ...parts), 'utf8');

const SHELL = read('UiNextApp.js');
const PROJECT_LIST = read('pages', 'ProjectList.js');
const PROJECT_DETAIL = read('pages', 'ProjectDetail.js');
const PROJECT_CHAT = read('pages', 'ProjectChat.js');

const SOURCES = {
  'UiNextApp.js': SHELL,
  'ProjectList.js': PROJECT_LIST,
  'ProjectDetail.js': PROJECT_DETAIL,
  'ProjectChat.js': PROJECT_CHAT,
};

// 註解裡也有「ui-next:sidebar-refresh」「finally」這些字，成功路徑的判定必須先剝掉註解。
const stripComments = (src) => src.replace(/\/\/.*$/gm, '');

describe('掃描對象本身（檔案讀得到才談內容）', () => {
  test.each(Object.keys(SOURCES))('%s 讀得到且不是空檔', (name) => {
    expect(`${name}: ${SOURCES[name].length > 2000}`).toBe(`${name}: true`);
  });
});

// ── Fix 1：發射點 ─────────────────────────────────────────────
// after＝「伺服器已確認」的那一句（await 的 API 呼叫）；before＝它後面的下一個動作。
// 事件必須落在這兩者之間，才叫「await 回來之後、且不在 finally」。
const SITES = [
  {
    subject: 'UiNextApp.js 首頁送出（建立對話）',
    file: 'UiNextApp.js',
    after: '`projects/${this.projectId}/chats`, { title: chatTitle(this.prompt)',
    before: 'sessionStorage.setItem(`ui-next:pending-msg',
  },
  {
    subject: 'UiNextApp.js 側欄對話列選單（刪除對話）',
    file: 'UiNextApp.js',
    after: 'await Api.delete(`projects/${project.id}/chats/${chat.id}`);',
    before: 'this.projectChats[project.id] = (this.projectChats[project.id] || [])',
  },
  {
    subject: 'ProjectList.js add（新增專案）',
    file: 'ProjectList.js',
    after: 'await Api.post("projects", {',
    before: 'this.closeAddForm();',
  },
  {
    subject: 'ProjectList.js remove（刪除專案）',
    file: 'ProjectList.js',
    after: 'await Api.delete(`projects/${project.id}`);',
    before: 'await this.load();',
  },
  {
    // 我的最愛直接決定側欄要列哪些專案（sidebarProjects 會把 is_favorite 的全撈進來）。
    subject: 'ProjectList.js toggleFavorite（我的最愛）',
    file: 'ProjectList.js',
    after: 'await Api.delete(`projects/${project.id}/favorite`);',
    before: '} catch (error) { project.is_favorite = !next;',
  },
  {
    subject: 'ProjectDetail.js saveBasics（改專案名稱）',
    file: 'ProjectDetail.js',
    after: 'await Api.put(`projects/${this.$route.params.id}`, { name,',
    before: 'showToast("已儲存"',
  },
  {
    subject: 'ProjectDetail.js createChat（建立對話）',
    file: 'ProjectDetail.js',
    after: '`projects/${this.$route.params.id}/chats`, { title: this.newChatTitle',
    before: 'if (content || files.length) {',
  },
  {
    subject: 'ProjectChat.js createChat（建立對話）',
    file: 'ProjectChat.js',
    after: '`projects/${this.$route.params.id}/chats`, { title: this.newTitle',
    before: 'if (content || files.length) {',
  },
  {
    subject: 'ProjectChat.js deleteChat（刪除對話）',
    file: 'ProjectChat.js',
    after: 'await Api.delete(`projects/${this.$route.params.id}/chats/${chat.id}`);',
    before: 'if (this.activeChat',
  },
];

// 發射點總數：漏掉一個、或某個檔案被整批改寫成別的寫法，這裡先喊。
const EXPECTED_EMITS = { 'UiNextApp.js': 2, 'ProjectList.js': 3, 'ProjectDetail.js': 2, 'ProjectChat.js': 2 };

describe(`Fix 1：${EVENT} 的發射點`, () => {
  test('清單有 9 個發射點，且每個檔案的實際數量對得上（掃不到＝這支守衛失效）', () => {
    expect(SITES.length).toBe(9);
    for (const [name, want] of Object.entries(EXPECTED_EMITS)) {
      const got = SOURCES[name].split(EMIT).length - 1;
      expect(`${name} 發射點數: ${got}`).toBe(`${name} 發射點數: ${want}`);
    }
    expect(Object.values(EXPECTED_EMITS).reduce((a, b) => a + b, 0)).toBe(SITES.length);
  });

  test.each(SITES.map((s) => [s.subject, s]))('%s：錨點切得到', (subject, site) => {
    const src = SOURCES[site.file];
    const hits = src.split(site.after).length - 1;
    expect(`${subject} 的 after 錨點出現次數: ${hits}`).toBe(`${subject} 的 after 錨點出現次數: 1`);
    const afterIdx = src.indexOf(site.after);
    const beforeIdx = src.indexOf(site.before, afterIdx);
    expect(`${subject} 的 before 錨點在 after 之後: ${beforeIdx > afterIdx}`).toBe(`${subject} 的 before 錨點在 after 之後: true`);
  });

  test.each(SITES.map((s) => [s.subject, s]))('%s：伺服器確認之後就發事件', (subject, site) => {
    const src = SOURCES[site.file];
    const afterIdx = src.indexOf(site.after);
    const slice = src.slice(afterIdx, src.indexOf(site.before, afterIdx));
    expect(`${subject} 發了 ${EVENT}: ${slice.includes(EMIT)}`).toBe(`${subject} 發了 ${EVENT}: true`);
  });

  test.each(SITES.map((s) => [s.subject, s]))('%s：事件在成功路徑上，不在 catch／finally', (subject, site) => {
    const src = SOURCES[site.file];
    const afterIdx = src.indexOf(site.after);
    const slice = stripComments(src.slice(afterIdx, src.indexOf(site.before, afterIdx)));
    // await 與事件之間若插進 catch／finally，代表事件被移出成功路徑：請求失敗也會重載側欄，
    // 側欄刷成「什麼都沒變」，使用者讀到的是「按鈕沒反應」。
    // 只認語句型的 catch／finally；Promise 的 .catch(...)（送訊息那支刻意不等待）不算岔開。
    const detoured = /(^|[^.\w])catch\s*\(|\bfinally\b/.test(slice);
    expect(`${subject} 事件前被 catch/finally 岔開: ${detoured}`).toBe(`${subject} 事件前被 catch/finally 岔開: false`);
  });
});

// ── Fix 1：外殼的監聽器 ───────────────────────────────────────
describe('Fix 1：外殼掛監聽、也要拆監聽', () => {
  const mountedIdx = SHELL.indexOf('async mounted()');
  const unmountIdx = SHELL.indexOf('beforeUnmount()', mountedIdx);
  const watchIdx = SHELL.indexOf('watch: {', unmountIdx);

  test('外殼的 mounted／beforeUnmount／watch 三段切得到（切不到就什麼都沒驗）', () => {
    for (const [name, idx] of [['async mounted()', mountedIdx], ['beforeUnmount()', unmountIdx], ['watch: {', watchIdx]]) {
      expect(`${name} 找得到: ${idx > -1}`).toBe(`${name} 找得到: true`);
    }
    expect(`三段順序正確: ${mountedIdx < unmountIdx && unmountIdx < watchIdx}`).toBe('三段順序正確: true');
  });

  test('mounted 裡掛上 window 監聽', () => {
    const slice = SHELL.slice(mountedIdx, unmountIdx);
    const ok = slice.includes(`window.addEventListener("${EVENT}", this._onSidebarRefresh)`);
    expect(`mounted 掛 ${EVENT}: ${ok}`).toBe(`mounted 掛 ${EVENT}: true`);
  });

  // window 上的 listener 抓著元件不放就是洩漏（TaskList.js 的 mounted／beforeUnmount 成對是同一個慣例）。
  test('beforeUnmount 裡把同一個 handler 拆掉', () => {
    const slice = SHELL.slice(unmountIdx, watchIdx);
    const ok = slice.includes(`window.removeEventListener("${EVENT}", this._onSidebarRefresh)`);
    expect(`beforeUnmount 拆 ${EVENT}: ${ok}`).toBe(`beforeUnmount 拆 ${EVENT}: true`);
  });

  test('監聽到事件時重載的是那兩份清單（不是整頁重來）', () => {
    const start = SHELL.indexOf('this._onSidebarRefresh = () => {');
    expect(`handler 切得到: ${start > -1}`).toBe('handler 切得到: true');
    const slice = SHELL.slice(start, SHELL.indexOf('};', start));
    expect(`handler 呼叫 reloadSidebarLists: ${slice.includes('this.reloadSidebarLists()')}`).toBe('handler 呼叫 reloadSidebarLists: true');
  });
});

// ── Fix 3：換頁補刷的條件 ─────────────────────────────────────
describe('Fix 3：換頁補刷只在「側欄範疇」變了才做', () => {
  // 方法可能寫成 `name(` 或 `async name(`，兩種都要找得到，否則切片會是空字串＝假綠。
  const sliceOfMethod = (name) => {
    let start = SHELL.indexOf(`      ${name}(`);
    if (start < 0) start = SHELL.indexOf(`      async ${name}(`);
    return start < 0 ? '' : SHELL.slice(start, SHELL.indexOf('\n      },', start));
  };
  const scopeKey = sliceOfMethod('sidebarScopeKey');
  const onRoute = sliceOfMethod('refreshSidebarOnRouteChange');
  const reload = sliceOfMethod('reloadSidebarLists');

  test('三支方法都切得到（切不到＝下面全是假綠）', () => {
    for (const [name, body] of [['sidebarScopeKey', scopeKey], ['refreshSidebarOnRouteChange', onRoute], ['reloadSidebarLists', reload]]) {
      expect(`${name} 切片長度>40: ${body.length > 40}`).toBe(`${name} 切片長度>40: true`);
    }
  });

  // 沿用既有的那一個 watcher，不另開第二個——兩個 watcher 各自判斷，遲早會有人只改到一邊。
  test('掛在既有的 $route.path watcher 上，而且全檔只有這一個', () => {
    const count = SHELL.split('"$route.path"()').length - 1;
    expect(`$route.path watcher 數量: ${count}`).toBe('$route.path watcher 數量: 1');
    const line = '"$route.path"() { this.syncSidebarToRoute(); this.refreshSidebarOnRouteChange(); },';
    expect(`watcher 內容正確: ${SHELL.includes(line)}`).toBe('watcher 內容正確: true');
  });

  // 範疇鍵＝路徑第一段（頁面區段）＋專案 id，且專案 id 只在 /projects 區段採計。
  // 排除掉的：同專案內切頁籤（只動 query，watcher 根本不觸發）、同專案內換對話（只動路徑尾巴）、
  // 逐張看任務（$route.path.params.id 在任務頁是任務 id，不排除就會一直重載）。
  test('範疇鍵用「區段＋（僅 projects 區段的）專案 id」', () => {
    for (const token of ['$route.path.split("/")[1]', 'section === "projects"', 'this.currentProjectId']) {
      expect(`sidebarScopeKey 含 ${token}: ${scopeKey.includes(token)}`).toBe(`sidebarScopeKey 含 ${token}: true`);
    }
  });

  test('範疇沒變就不重載', () => {
    expect(`未變即 return: ${onRoute.includes('if (key === this._sidebarScope) return;')}`).toBe('未變即 return: true');
  });

  // 節流是刻意的第二道：連續換頁（逐一點開專案）不該每一步都打兩支 API；
  // _sidebarListsAt 還沒有值＝mounted 那次載入還沒回來，這時重載純屬重複。
  test('15 秒節流還在，且涵蓋「mounted 尚未載完」', () => {
    expect(`節流門檻 15000: ${onRoute.includes('15000')}`).toBe('節流門檻 15000: true');
    expect(`未載完不重載: ${onRoute.includes('!this._sidebarListsAt')}`).toBe('未載完不重載: true');
  });

  // 成本上限釘死：一次補刷就是兩支 API，不准有人順手再多掛一支。
  test('一次重載只打兩支 API：projects 與 chats/sidebar-projects', () => {
    const gets = [...reload.matchAll(/Api\.get\(\s*"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(`reloadSidebarLists 的 Api.get: ${JSON.stringify(gets)}`).toBe(`reloadSidebarLists 的 Api.get: ${JSON.stringify(['chats/sidebar-projects', 'projects'])}`);
  });

  // 重載失敗不准把清單清空：側欄整排消失比顯示過期資料更糟。
  test('重載失敗保留既有清單', () => {
    const hasCatch = /catch\s*\(error\)/.test(reload);
    expect(`reloadSidebarLists 有 catch: ${hasCatch}`).toBe('reloadSidebarLists 有 catch: true');
    expect(`catch 內不清空 projects: ${/catch[\s\S]*this\.projects = \[\]/.test(reload)}`).toBe('catch 內不清空 projects: false');
  });
});
