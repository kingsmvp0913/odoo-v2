// 意圖：更版機制的失敗**只在畫面上通知**（已拍板：這台機器沒有 webhook、也沒有 Teams）。
// 所以「畫面上有沒有那一條」不是美觀問題，是這條通知管道存不存在的問題——它斷掉的樣子就是
// 「一切看起來都正常」，沒有紅燈、沒有例外、沒有人被叫起來。
//
// 2026-09-22 使用者裁決取消獨立的「平台更版」頁（Release.js／#/admin/release）：更版是改善
// 流程的最後一步（提案 → 核准 → 夜間批次改碼 → 合併 → 生效），不該自成一個管理功能。
// 這一支跟著搬到三個新家，意圖一字未改：
//   (1) 管理員首頁（Admin.js）＝失敗通知**唯一**的落點。原本裁決是「更版頁標紅＋首頁掛一條」，
//       更版頁沒了，首頁那一條就是全部——它必須不點任何東西就看得到失敗全文與該怎麼辦，
//       而且要講出「沒有任何東西會通知你」（以為會被通知的人不會自己回來看）。
//   (2) 改善提案頁（AdminFeedback.js）＝待更版清單、稽核軌跡與「立刻更版」。
//   (3) 系統設定頁（AdminSettings.js）＝維護時段。
// 另外釘住「那一頁真的不見了」：留著死路由的話，選單／門禁會指向一個不存在的 component，
// 而 Vue 對 undefined component 是渲染成空白，不會報錯。
const fs = require('fs');
const path = require('path');

const pubJs = path.join(__dirname, '..', '..', 'public', 'js');
const pagesDir = path.join(pubJs, 'ui-next', 'pages');
const pageFiles = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.js'));
const ADMIN = fs.readFileSync(path.join(pagesDir, 'Admin.js'), 'utf8');
const FEEDBACK = fs.readFileSync(path.join(pagesDir, 'AdminFeedback.js'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(pagesDir, 'AdminSettings.js'), 'utf8');

// 母體先自證：檔案讀空了（改名、搬家）時下面每一條都會變成「在空字串裡找不到東西」，
// 而那些斷言多半是 toBe(false) 形狀的，會靜默全綠。
test('掃描母體成立（頁面檔讀得到，數量合理）', () => {
  expect(pageFiles.length).toBeGreaterThanOrEqual(25);
  expect(ADMIN.length).toBeGreaterThan(2000);
  expect(FEEDBACK.length).toBeGreaterThan(20000);
  expect(SETTINGS.length).toBeGreaterThan(20000);
});

describe('獨立的更版頁已經刪乾淨', () => {
  test('pages 目錄下沒有 Release.js', () => {
    expect(pageFiles).not.toContain('Release.js');
  });

  // 路由沒了但別處還指著它＝選單點下去落到 undefined component（畫面全白、主控台無錯誤）。
  test('前端沒有任何檔案還指向 /admin/release 或 UiNextReleaseView', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    const files = walk(pubJs).filter((f) => f.endsWith('.js'));
    // 掃到的檔案數先釘住：walk 壞掉回空陣列時，下面的 offenders 必定是空的。
    expect(files.length).toBeGreaterThanOrEqual(30);
    const offenders = files
      .filter((f) => /\/admin\/release['"`]|UiNextReleaseView/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.basename(f));
    expect(offenders).toEqual([]);
  });

  // 後端端點原封不動是這次搬家的前提（只有呼叫的人換了）。端點若也被順手刪掉，
  // 上面三頁會全部變成「狀態讀取失敗」——而那是靜默的。
  test('後端 /api/admin/release 三個端點還在（這次只搬前端）', () => {
    const routes = fs.readFileSync(path.join(__dirname, '..', 'release-routes.js'), 'utf8');
    for (const ep of ["'/api/admin/release'", "'/api/admin/release/window'", "'/api/admin/release/now'"]) {
      expect(`${ep}: ${routes.includes(ep)}`).toBe(`${ep}: true`);
    }
  });
});

describe('管理員首頁：更版失敗唯一的通知點', () => {
  // 失敗那一塊整段切出來（兩端都釘：切不到就不是綠燈，是守衛失效）。
  const failBlock = (() => {
    const at = ADMIN.indexOf('<div v-if="release && (releaseFailed || envReviveFailed)"');
    const end = ADMIN.indexOf('<!-- 沒有任何東西會通知你', at);
    return at < 0 || end < 0 ? '' : ADMIN.slice(at, end);
  })();

  test('失敗區塊切得到（切不到＝守衛失效，不是通過）', () => {
    expect(`失敗區塊切得到: ${failBlock.length > 500}`).toBe('失敗區塊切得到: true');
  });

  test('首頁自己去讀更版狀態，不是把人導去別頁才看得到', () => {
    expect(`首頁讀 admin/release: ${/Api\.get\('admin\/release'\)/.test(ADMIN)}`)
      .toBe('首頁讀 admin/release: true');
  });

  test('判準是 restarted 不是 testsPassed：後者是三態，null 不是通過（release.js 的契約）', () => {
    expect(`用 restarted 判: ${/restarted !== true/.test(ADMIN)}`).toBe('用 restarted 判: true');
    // 把判準寫成 `last.testsPassed` 之類的 falsy 判斷才是真正的倒退（「跳過全跑但有重啟」會被
    // 誤報成失敗、「根本沒跑起來」會被誤報成沒事），所以釘的是「沒有人拿它當條件」。
    expect(`沒拿 testsPassed 當條件: ${/(if|\?|&&|\|\|)[^\n]*testsPassed/.test(ADMIN)}`)
      .toBe('沒拿 testsPassed 當條件: false');
  });

  // 半夜兩點沒有人在，看到這段的人多半是隔了幾天才來的：只說「失敗了」等於把問題丟回去。
  test('失敗當場講得出「該怎麼辦」四步，而不是一顆紅點', () => {
    expect(ADMIN).toMatch(/上一次更版沒有成功/);
    expect(ADMIN).toMatch(/還跑著舊碼/);
    const steps = failBlock.match(/<li>/g) || [];
    expect(`該怎麼辦的步驟數: ${steps.length}`).toBe('該怎麼辦的步驟數: 4');
    // 四步要各自可執行：碼在哪、怎麼看是哪支紅的、修好之後去哪裡重按、什麼情況才跳過全跑。
    expect(failBlock).toMatch(/master/);
    expect(failBlock).toMatch(/test:quiet/);
    expect(failBlock).toMatch(/立刻更版/);
    expect(failBlock).toMatch(/跳過重啟前全跑/);
    // 更版頁已不存在，重按的地方是改善提案頁——指回舊路由等於把人送到 404。
    expect(`指向改善提案頁: ${/to="\/admin\/feedback"/.test(failBlock)}`).toBe('指向改善提案頁: true');
  });

  // 這句話是上面那張卡片存在的前提，而且必須是**讀資料**得來的結論：哪天真的接了 webhook，
  // 改的是後端 notify.channels，這一頁自己就會改口，不必有人記得回來改文案。
  test('「沒有任何東西會通知你」來自 notify.channels，不是寫死的一句話', () => {
    expect(`讀 notify.channels: ${/notify\.channels|n\.channels/.test(ADMIN)}`).toBe('讀 notify.channels: true');
    expect(`判空陣列: ${/channels\.length === 0/.test(ADMIN)}`).toBe('判空陣列: true');
    expect(ADMIN).toMatch(/沒有任何東西會通知你/);
    // 有管道時要改口說出是哪些管道——沒有這一支，上面那條就只是條件式的文案而非資料的結論。
    expect(`有管道時改口: ${/channels\.join/.test(ADMIN)}`).toBe('有管道時改口: true');
  });

  // 測試區沒救回來＝那幾台「開著但什麼都不動」（Odoo 的排程執行緒在平台重啟時死掉），
  // 客戶要好幾天才會發現。這份紀錄（release_last_result.envRevive）除了這裡沒有第二個地方讀得到。
  test('測試區沒重開成功也算「沒完全成功」，並說得出是哪幾台、要做什麼', () => {
    expect(`首頁讀 envRevive: ${/last\.envRevive/.test(ADMIN)}`).toBe('首頁讀 envRevive: true');
    expect(`有 envReviveFailed 這個判準: ${/envReviveFailed/.test(ADMIN)}`).toBe('有 envReviveFailed 這個判準: true');
    expect(`列出是哪幾台: ${/envRevive\.failures|envReviveFailures/.test(ADMIN)}`).toBe('列出是哪幾台: true');
    expect(failBlock).toMatch(/手動重啟|人工重啟/);
  });

  test('顏色一律取自 CSS 變數，不得硬寫十六進位（深色模式是硬規則）', () => {
    expect(ADMIN.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(ADMIN).toMatch(/var\(--danger\)/);
  });
});

describe('改善提案頁：待更版清單、稽核軌跡與「立刻更版」', () => {
  const block = (() => {
    const at = FEEDBACK.indexOf('<div v-if="release" class="settings-section">');
    const end = FEEDBACK.indexOf('<div class="settings-section">', at + 10);
    return at < 0 || end < 0 ? '' : FEEDBACK.slice(at, end);
  })();

  test('待更版區塊切得到（切不到＝守衛失效，不是通過）', () => {
    expect(`待更版區塊切得到: ${block.length > 1000}`).toBe('待更版區塊切得到: true');
  });

  test('讀得到待更版清單，且看得出來源是哪一條提案', () => {
    expect(`讀 admin/release: ${/Api\.get\('admin\/release'\)/.test(FEEDBACK)}`).toBe('讀 admin/release: true');
    expect(block).toMatch(/releasePending/);
    expect(block).toMatch(/feedback_ids/);
    expect(block).toMatch(/commit_sha/);
  });

  // 沒有人在合併前讀過這些碼，稽核軌跡是唯一的人工稽核材料（整段歷史，含被退回那一輪）。
  test('每一筆點得開稽核軌跡，走既有的 findings/:id/fix（回整段歷史）', () => {
    expect(`打 findings/:id/fix: ${/health-check\/findings\/' \+ row\.finding_id \+ '\/fix/.test(FEEDBACK)}`)
      .toBe('打 findings/:id/fix: true');
    expect(block).toMatch(/reject_reason/);
    expect(block).toMatch(/verify_notes/);
  });

  test('「立刻更版」在這裡，兩個旋鈕的代價要寫在畫面上', () => {
    expect(`打 admin/release/now: ${/Api\.post\('admin\/release\/now'/.test(FEEDBACK)}`)
      .toBe('打 admin/release/now: true');
    expect(block).toMatch(/立刻更版/);
    expect(block).toMatch(/一併中止在飛任務/);
    expect(block).toMatch(/不會留下任何測試證據/);
    // 沒有待更版的碼時不該讓人按下去（按了也只是白重啟一次平台）
    expect(`沒東西可更版就停用: ${/:disabled="releasing \|\| !releasePending\.length"/.test(block)}`)
      .toBe('沒東西可更版就停用: true');
  });

  test('待更版那一區的顏色取自 CSS 變數', () => {
    expect(block.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(block).toMatch(/var\(--warning-strong\)/);
  });
});

describe('系統設定頁：維護時段', () => {
  const block = (() => {
    const at = SETTINGS.indexOf('<!-- 維護時段（自動更版）');
    const end = SETTINGS.indexOf('<!-- 平台資料庫備份', at);
    return at < 0 || end < 0 ? '' : SETTINGS.slice(at, end);
  })();

  test('維護時段區塊切得到（切不到＝守衛失效，不是通過）', () => {
    expect(`維護時段區塊切得到: ${block.length > 800}`).toBe('維護時段區塊切得到: true');
  });

  test('讀寫清三件事都在，且清除前要確認', () => {
    expect(`讀: ${/Api\.get\('admin\/release'\)/.test(SETTINGS)}`).toBe('讀: true');
    expect(`寫: ${/Api\.put\('admin\/release\/window'/.test(SETTINGS)}`).toBe('寫: true');
    expect(`清: ${/Api\.delete\('admin\/release\/window'\)/.test(SETTINGS)}`).toBe('清: true');
    const clear = SETTINGS.slice(SETTINGS.indexOf('async clearReleaseWindow()'), SETTINGS.indexOf('formatBytes(n)'));
    expect(`清除前確認: ${/confirmDialog\(/.test(clear)}`).toBe('清除前確認: true');
  });

  // 存進去了不代表更版引擎認得（兩邊的驗證規則若漂移，症狀是畫面顯示存好了而機制其實是關的）。
  test('後端回的 window 是 null 時要當錯誤講出來，不能顯示「已儲存」', () => {
    expect(`檢查 r.window: ${/if \(!r\.window\) showToast\(/.test(SETTINGS)}`).toBe('檢查 r.window: true');
    expect(SETTINGS).toMatch(/更版引擎讀不到它/);
  });

  test('沒設定時段時要說出後果（不是只留空表單）', () => {
    expect(block).toMatch(/不會自動更版/);
    // 跨午夜會被判無效並靜默關閉整條機制——這句話不寫在表單旁邊，沒有人會知道
    expect(block).toMatch(/跨午夜|午夜/);
  });

  test('這一區的顏色取自 CSS 變數（AdminSettings 舊有的 #fff 開關把手不在本區內）', () => {
    expect(block.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(block).toMatch(/var\(--warning-strong\)/);
  });
});
