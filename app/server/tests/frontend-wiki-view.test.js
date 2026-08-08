// WikiView 的三種「無聲毀資料」路徑，全部只在瀏覽器點下去才會發生，所以在這裡用「載入 options
// 物件、直接呼叫 method」的方式釘住（同 frontend-env-poll.test.js 的作法；前端沒有 mount 測試 infra）。
//   1) 讀取失敗 → 空樹 →「建立 wiki」按鈕冒出來 → 按下去用骨架蓋掉概論與每一頁模組頁
//   2) 未儲存內容在切頁時被直接覆寫（點左樹、改網址都會中）
//   3) 教程示範專案（id 是字串 'demo'）的寫入動作打真 API → project_id 型別不符噴 500
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../public/js/views/WikiView.js');

// WikiView.js 是瀏覽器腳本（掛全域、無 module.exports），以 stub 過的全域載出 options 物件。
function loadComponent({ Api = {}, showToast = () => {}, confirmDialog = async () => true, win = {} } = {}) {
  const src = fs.readFileSync(SRC, 'utf8');
  const factory = new Function(
    'Vue', 'window', 'Api', 'showToast', 'confirmDialog', 'renderMarkdown',
    `${src}\nreturn window.WikiView;`
  );
  return factory({ defineComponent: (o) => o }, win, Api, showToast, confirmDialog, () => '');
}

// data() 的初值 + 全部 methods 當成同一個 this，method 內互相呼叫（isTourDemo／isDirty／loadPages）才有效
function makeCtx(comp, over = {}) {
  const ctx = Object.assign({}, comp.data(), comp.methods, {
    $route: { params: { id: '1' } },
    $router: { replace: jest.fn() }
  }, over);
  return ctx;
}

describe('讀取失敗不得偽裝成「這個專案還沒有 wiki」', () => {
  // 「建立 wiki」走 initProjectWiki，用骨架 ON CONFLICT DO UPDATE 覆寫概論與每一頁模組頁。
  // 清單一旦載入失敗，pages 停在 []，只看 !pages.length 就會在「其實有內容」的專案上把按鈕端出來，
  // 使用者看到空樹自然會按——一次網路抖動換整份累積內容被沖掉，且無法還原。
  test('loadPages 失敗 → 記下錯誤，且「建立 wiki」按鈕不得出現', async () => {
    const comp = loadComponent({ Api: { get: () => Promise.reject(new Error('502 Bad Gateway')) } });
    const ctx = makeCtx(comp);
    await ctx.loadPages();
    expect(ctx.loadError).toBe('502 Bad Gateway'); // 使用者要知道是載入失敗，不是「沒有頁面」
    expect(comp.computed.canBuild.call(ctx)).toBe(false);
  });

  test('載入成功但真的沒有頁面 → 按鈕照常出現（修法不得把功能整個關掉）', async () => {
    const comp = loadComponent({ Api: { get: () => Promise.resolve([]) } });
    const ctx = makeCtx(comp);
    await ctx.loadPages();
    expect(ctx.loadError).toBe('');
    expect(comp.computed.canBuild.call(ctx)).toBe(true);
  });

  test('重試成功 → 錯誤狀態要清掉（否則按鈕永遠回不來）', async () => {
    let fail = true;
    const comp = loadComponent({
      Api: { get: () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve([])) }
    });
    const ctx = makeCtx(comp);
    await ctx.loadPages();
    fail = false;
    await ctx.loadPages();
    expect(ctx.loadError).toBe('');
  });

  // 前端沒有 mount 測試，computed 對了但 template 還綁著 !pages.length 的話 bug 原封不動，
  // 所以連綁定本身一起釘。
  test('template 的建立按鈕綁 canBuild，而非 !pages.length', () => {
    const comp = loadComponent();
    const btn = comp.template.split('\n').find(l => l.includes('buildWiki'));
    expect(btn).toContain('v-if="canBuild"');
  });

  test('載入失敗時樹狀區要顯示失敗訊息（空白畫面＝使用者以為沒資料）', () => {
    const comp = loadComponent();
    expect(comp.template).toMatch(/v-else-if="loadError"/);
    // 深色模式硬規則：語意色走 app.css 的 class，不得在 inline style 寫死淺色底
    expect(comp.template).toMatch(/v-else-if="loadError"[^>]*class="error-msg"/);
  });
});

describe('未儲存的內容不得在切頁時被無聲丟棄', () => {
  const editingCtx = (comp, over = {}) => makeCtx(comp, Object.assign({
    editing: true,
    current: { slug: 'page-a', title: '頁A', content: '原本的內容', node_type: 'function' },
    editContent: '打到一半的內容'
  }, over));

  test('有未儲存修改時切到別頁 → 先問過使用者，選擇不放棄就留在原頁', async () => {
    const get = jest.fn();
    const confirmDialog = jest.fn().mockResolvedValue(false); // 使用者說「不要放棄」
    const comp = loadComponent({ Api: { get }, confirmDialog });
    const ctx = editingCtx(comp);
    await ctx.loadPage('page-b');
    expect(confirmDialog).toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(ctx.current.slug).toBe('page-a');
    expect(ctx.editContent).toBe('打到一半的內容');
    // 網址可能已被帶到 page-b（改網址列／上一頁），不導回去會變成「畫面是 A、網址是 B」
    expect(ctx.$router.replace).toHaveBeenCalledWith('/projects/1/wiki/page-a');
  });

  test('使用者確認放棄 → 照常切頁', async () => {
    const get = jest.fn().mockResolvedValue({ slug: 'page-b', title: '頁B', content: 'B 的內容' });
    const comp = loadComponent({ Api: { get }, confirmDialog: async () => true });
    const ctx = editingCtx(comp);
    await ctx.loadPage('page-b');
    expect(ctx.current.slug).toBe('page-b');
    expect(ctx.editContent).toBe('B 的內容');
    expect(ctx.editing).toBe(false);
  });

  // 沒改過就攔＝每次點樹都跳確認框，使用者三次之後就開始無視它，等於沒有防線。
  test('沒有未儲存修改時不得打擾使用者', async () => {
    const confirmDialog = jest.fn().mockResolvedValue(true);
    const comp = loadComponent({
      Api: { get: async () => ({ slug: 'page-b', title: '頁B', content: 'B' }) }, confirmDialog
    });
    const ctx = editingCtx(comp, { editContent: '原本的內容' }); // 與 current.content 相同
    await ctx.loadPage('page-b');
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(ctx.current.slug).toBe('page-b');
  });

  // 重新生成完成後 refreshNode 會對同一頁 loadPage；那條路徑已由樹上 ⟳ 的停用擋住，
  // 這裡再跳一次確認框只會讓人困惑。
  test('重載同一頁不得跳確認框', async () => {
    const confirmDialog = jest.fn().mockResolvedValue(true);
    const comp = loadComponent({
      Api: { get: async () => ({ slug: 'page-a', title: '頁A', content: '新內容' }) }, confirmDialog
    });
    const ctx = editingCtx(comp);
    await ctx.loadPage('page-a');
    expect(confirmDialog).not.toHaveBeenCalled();
  });
});

describe('專案備註（notes）打到一半切頁同樣要攔', () => {
  // notes 的 textarea 永遠是活的，而 editing 只有「編輯」鈕會設 true，那顆鈕在 node_type !== 'notes'
  // 的分支裡 → notes 的 editing 永遠是 false，任何以 editing 為基礎的保護對它一律失效。
  // notes 是人工維護、且會注入各開發關卡的內容，丟失代價最高。
  // 這裡不比對字串，而是把 template 上的 @input 綁定取出來實際執行，避免「有寫但寫錯」的假綠。
  function notesInputHandler(comp) {
    const notesBranch = comp.template.split("current.node_type === 'notes'")[1];
    const m = notesBranch.match(/<textarea[^>]*@input="([^"]*)"/);
    return m && m[1];
  }

  test('在備註 textarea 打字會進入編輯狀態', () => {
    const comp = loadComponent();
    const expr = notesInputHandler(comp);
    expect(expr).toBeTruthy();
    const ctx = makeCtx(comp, { current: { slug: 'project-notes', title: '專案備註', content: '', node_type: 'notes' } });
    new Function('$ctx', `with($ctx){${expr}}`)(ctx);
    expect(ctx.editing).toBe(true);
  });

  test('備註打到一半切到別頁 → 跳確認框，不放棄就留在備註頁', async () => {
    const confirmDialog = jest.fn().mockResolvedValue(false);
    const get = jest.fn();
    const comp = loadComponent({ Api: { get }, confirmDialog });
    const ctx = makeCtx(comp, {
      current: { slug: 'project-notes', title: '專案備註', content: '', node_type: 'notes' },
      editContent: '窗口：王小明 分機 210'
    });
    new Function('$ctx', `with($ctx){${notesInputHandler(comp)}}`)(ctx); // 模擬打字
    await ctx.loadPage('overview');
    expect(confirmDialog).toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(ctx.editContent).toBe('窗口：王小明 分機 210');
  });
});

describe('教程示範專案的寫入動作不得打真 API', () => {
  // 示範專案 id 是字串 'demo'，送進 integer 型別的 project_id 一路噴到 500 錯誤 toast，
  // 新手第一次用平台就看到紅字。讀取路徑（loadPages／loadPage）本來就走 TourDemo 假資料，
  // 寫入路徑三支卻漏了。
  const demoComp = (api) => loadComponent({
    Api: api,
    win: { TourDemo: { isProject: (id) => String(id) === 'demo', wikiPages: () => [], wikiPage: () => ({}) } }
  });
  const demoCtx = (comp) => makeCtx(comp, {
    $route: { params: { id: 'demo' } },
    current: { slug: 'overview', title: '專案概論', content: 'x', node_type: 'overview' }
  });

  test('儲存不打 API', async () => {
    const api = { put: jest.fn(), get: jest.fn() };
    const ctx = demoCtx(demoComp(api));
    await ctx.save();
    expect(api.put).not.toHaveBeenCalled();
  });

  test('⟳ 重新生成不打 API', async () => {
    const api = { post: jest.fn(), get: jest.fn() };
    const ctx = demoCtx(demoComp(api));
    await ctx.refreshNode('overview');
    expect(api.post).not.toHaveBeenCalled();
    expect(ctx.refreshing).toBe(''); // 不得卡在轉圈狀態
  });

  test('✕ 刪除不打 API', async () => {
    const api = { delete: jest.fn(), get: jest.fn() };
    const ctx = demoCtx(demoComp(api));
    await ctx.removePage('overview');
    expect(api.delete).not.toHaveBeenCalled();
  });

  // 下面兩支是同一家族的另外兩個入口。上面三支修好之後它們仍然會打真 API——
  // 「已經修過這個 bug」與「這個 bug 已經沒有了」是兩件事。
  test('+ 新增頁面不打 API', async () => {
    const api = { post: jest.fn(), get: jest.fn() };
    const ctx = demoCtx(demoComp(api));
    Object.assign(ctx, { newPageTitle: '銷售訂單模組', newPageSlug: 'sale-order' });
    await ctx.submitAddPage();
    expect(api.post).not.toHaveBeenCalled();
    expect(ctx.addingPage).toBe(false); // 不得卡在送出中
  });

  test('建立 wiki 不打 API', async () => {
    const api = { post: jest.fn(), get: jest.fn() };
    const ctx = demoCtx(demoComp(api));
    await ctx.buildWiki();
    expect(api.post).not.toHaveBeenCalled();
    expect(ctx.building).toBe(false); // 不得卡在轉圈
  });

  // 對照組：非示範專案一定要照常送出，否則上面三條用「把功能拿掉」也能全綠。
  test('真專案照常送出', async () => {
    const put = jest.fn().mockResolvedValue({ slug: 'overview', title: 'O', content: 'y' });
    const comp = loadComponent({ Api: { put, get: async () => [] } });
    const ctx = makeCtx(comp, {
      current: { slug: 'overview', title: '專案概論', content: 'x', node_type: 'overview' },
      editContent: 'y'
    });
    await ctx.save();
    expect(put).toHaveBeenCalled();
  });
});
