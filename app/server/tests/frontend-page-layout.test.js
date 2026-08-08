// 意圖：全站有兩套版面骨架，混用或少一層都不會報錯、桌機截圖門禁也照樣綠，
// 症狀只有人眼看得到（標題貼著底線、內容黏在 navbar 上）。收件匣（2f55063）就是這樣上線的。
//
//   1) `.topbar` + 自己的內容容器 —— 17 個 view，列表／詳情頁走這套
//   2) `.page-header` + `.page-header-inner` + `.page-body` —— 5 個設定類頁面走這套
//
// 第 2 套少一層 inner 就會塌：`.page-header` 的 padding 下緣是 0（app.css:249），
// 留白全靠 `.page-header-inner` 的 padding-bottom 提供；內容區的留白則靠 `.page-body`。
const fs = require('fs');
const path = require('path');

const VIEWS = path.join(__dirname, '../../public/js/views');
const views = fs.readdirSync(VIEWS).filter((f) => f.endsWith('.js'))
  .map((f) => ({ file: f, src: fs.readFileSync(path.join(VIEWS, f), 'utf8') }));

const usingPageHeader = views.filter((v) => v.src.includes('class="page-header"'));
const usingTopbar = views.filter((v) => v.src.includes('class="topbar"'));

describe('設定類頁面的標頭三層結構', () => {
  // 守衛過期時要紅：某天全站改用別的骨架，這份測試該一起改掉，而不是留在原地空轉。
  it('至少有一個 view 使用 .page-header（否則這份守衛已經過期）', () => {
    expect(usingPageHeader.length).toBeGreaterThan(0);
  });

  it.each(usingPageHeader.map((v) => v.file))('%s：.page-header 內必須有 .page-header-inner', (file) => {
    expect(usingPageHeader.find((v) => v.file === file).src).toMatch(/class="page-header-inner/);
  });

  it.each(usingPageHeader.map((v) => v.file))('%s：有 .page-header 就必須有 .page-body 承接內容', (file) => {
    expect(usingPageHeader.find((v) => v.file === file).src).toMatch(/class="page-body"/);
  });
});

describe('兩套骨架不得混用', () => {
  // 混用的後果是兩套 padding 疊加或互相抵銷，而且兩邊的 CSS 各自修改時都不會想到對方。
  it.each(views.map((v) => v.file))('%s 只用其中一套', (file) => {
    const { src } = views.find((v) => v.file === file);
    const both = src.includes('class="topbar"') && src.includes('class="page-header"');
    expect({ file, both }).toEqual({ file, both: false });
  });
});

describe('收件匣的篩選放在內容區，不放在 navbar', () => {
  // `.topbar` 放的是「動作」（新增、批次、同步、全部標記已讀），`.content` 頂端的篩選列放的是
  // 「看哪些」——任務列表就是這樣分的。收件匣原本把篩選切換鈕塞進標頭，navbar 高度與其他頁對不上。
  const inbox = views.find((v) => v.file === 'Inbox.js').src;
  const topbar = inbox.match(/class="topbar"[\s\S]*?<\/div>/)[0];

  it('篩選切換不在 .topbar 裡', () => {
    expect(topbar).not.toMatch(/setShowAll|只看未處理/);
  });

  it('篩選切換在 .filter-row 裡，且兩個選項都在', () => {
    const row = inbox.match(/class="filter-row"[\s\S]*?<\/div>\s*<\/div>/)[0];
    expect(row).toContain('setShowAll(false)');
    expect(row).toContain('setShowAll(true)');
  });

  it('.filter-row 與任務列表的篩選列共用同一條樣式', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../public/css/app.css'), 'utf8');
    expect(css).toMatch(/\.tasklist-filter-row,\s*\.filter-row\s*\{/);
  });

  // 頁籤上的數字與側欄 badge 是同一個數，來源必須同樣是後端 COUNT 端點——
  // 從本頁 items 推算會在切到「全部」時變成另一個數（見 frontend-inbox-badge.test.js 的說明）。
  it('頁籤數字不從本頁 items 推算', () => {
    expect(inbox).toContain('unreadTotal() { return window.inboxUnread');
    expect(inbox).not.toMatch(/items\.filter\(i => !i\.read_at\)\.length/);
  });
});
