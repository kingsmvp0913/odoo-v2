const fs = require('fs');
const path = require('path');
const {
  AR_ZONES, AR_KINDS, architectureSystems, architectureLinks, architectureBuses, architectureNotes
} = require('../../public/js/architecture-spec.js');

// 這支測試守的是「系統地景圖沒有靜默壞掉」。這張圖的失效方式全都不報錯：
//   id 打一個字錯 → 那條線整條消失，圖照樣渲染、console 一個錯都沒有
//   step 挪一格   → 線從別的方塊身上直直穿過去，看起來像多接了一條線
//   kind 打錯     → 框線退回灰色，「這東西歸誰管」的顏色分類靜默失效
// 三種都是「畫面看起來正常，但它開始騙人」，而這頁的用途正是拿去對外介紹。
//
// 版面幾何本身（線有沒有重疊、字有沒有貼框）jest 測不到——路徑是 Vue 算出來的，要瀏覽器。
// 那部分的驗法寫在 views/Architecture.js 檔頭。這裡驗的是**排版前提**：能純資料算出來的
// 那幾種穿框，見下方 describe。

const systems = architectureSystems();
const links = architectureLinks();
const buses = architectureBuses();
const byId = Object.fromEntries(systems.map((s) => [s.id, s]));
// 幾何一律看**欄**：兩個分區可以共用同一欄（單據來源與客戶現場），用分區序號判斷左右會錯。
const zoneCol = Object.fromEntries(AR_ZONES.map((z, i) => [z.id, z.col !== undefined ? z.col : i]));
const colOf = (id) => zoneCol[byId[id].zone];

describe('地景圖的結構完整', () => {
  test('解析到合理數量的系統與連線（spec 壞掉時測試不得靜默通過）', () => {
    expect(systems.length).toBeGreaterThan(12);
    expect(links.length).toBeGreaterThan(12);
    expect(AR_ZONES.length).toBeGreaterThan(2);
  });

  test('每個系統都屬於一個存在的分區', () => {
    expect(systems.filter((s) => !(s.zone in zoneCol)).map((s) => s.id)).toEqual([]);
  });

  // kind 是「這東西歸誰管」的唯一表達管道（view 靠它上框線顏色）。打錯字的後果不是報錯，
  // 是那一格退回無語意的灰色——而顏色正是這張圖讓人一眼分辨我方／客戶方的方式。
  test('每個系統的 kind 都在 AR_KINDS 內', () => {
    expect(systems.filter((s) => !AR_KINDS.includes(s.kind)).map((s) => s.id)).toEqual([]);
  });

  test('每條連線的兩端都存在（id 打錯字＝整條線消失且零訊號）', () => {
    const bad = links.filter(([a, b]) => !byId[a] || !byId[b]).map(([a, b]) => a + '>' + b);
    expect(bad).toEqual([]);
  });

  // 孤島＝畫上去卻沒接任何線。它在畫面上看起來只是「一個方塊」，不會有人發現它其實
  // 沒被接進來——通常代表新增系統時忘了補連線。
  test('沒有孤島系統', () => {
    const touched = new Set(links.flatMap(([a, b]) => [a, b]));
    expect(systems.filter((s) => !touched.has(s.id)).map((s) => s.id)).toEqual([]);
  });

  // 守的是**欄**不是分區：共用同一欄的兩個分區若在同一列各放一格，兩格的座標完全相同，
  // 會直接疊在一起畫——而且不會有任何錯誤訊息，只是後畫的蓋住先畫的。
  test('同一欄的同一列只能有一個系統（兩個會疊在同一個位置畫）', () => {
    const seen = new Set(), dup = [];
    for (const s of systems) {
      const k = zoneCol[s.zone] + '#' + s.step;
      if (seen.has(k)) dup.push(s.id);
      seen.add(k);
    }
    expect(dup).toEqual([]);
  });

  test('每個系統都有白話說明（右側面板空的等於這頁沒有內容）', () => {
    expect(systems.filter((s) => !s.label || !s.sub || !s.detail?.length).map((s) => s.id)).toEqual([]);
    expect(links.filter(([, , label]) => !label).map(([a, b]) => a + '>' + b)).toEqual([]);
    expect(architectureNotes().length).toBeGreaterThan(0);
  });
});

// 這頁是**對外介紹**用的（見 spec 檔頭）。埠號、資料庫名、檔案路徑一寫進去，它就變成
// 第二份技術文件——而第二份技術文件一定會過期，且第一次看的人會卡在名詞上。
// 掃的是資料內容不是原始碼：註解裡本來就要寫出實作檔名（那是給改這份檔的人看的）。
describe('內容維持在介紹的層級', () => {
  const texts = [
    ...systems.flatMap((s) => [s.label, s.sub, ...s.detail.flat()]),
    ...links.map(([, , label]) => label),
    ...architectureNotes()
  ];

  test('解析到合理數量的文字（掃描目標抓錯時不得靜默通過）', () => {
    expect(texts.length).toBeGreaterThan(60);
  });

  test.each([
    ['埠號', /:\d{4,5}\b/],
    ['檔名', /\.(js|py|xml|csv|sql|log)\b/],
    ['絕對路徑', /(^|[\s（(])([A-Za-z]:\\|\/(home|var|etc|opt)\/)/],
    ['環境變數', /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/]
  ])('不出現%s', (_label, re) => {
    expect(texts.filter((t) => re.test(t))).toEqual([]);
  });
});

// 版面幾何要瀏覽器才驗得到，但**穿框**這一種可以純資料算出來：線的形狀由 zone 與 step
// 決定（見 views/Architecture.js 檔頭「連線的四種形狀」），所以「這條線會不會從某個方塊
// 身上壓過去」在這裡就能算。挪動 step 是最常見的改動，而穿框在畫面上會被讀成
// 「這裡多接了一條線」——是會誤導的那種壞法，不是看起來壞掉的那種。
describe('排版前提：不會有線穿過方塊', () => {
  const at = (zone, step) => systems.find((s) => s.zone === zone && s.step === step);

  test('同列跨欄的水平線，中間各欄在那一列必須是空的', () => {
    const bad = [];
    for (const [a, b] of links) {
      const A = byId[a], B = byId[b];
      if (colOf(a) === colOf(b) || A.step !== B.step) continue;
      const [lo, hi] = [colOf(a), colOf(b)].sort((x, y) => x - y);
      const blockers = systems.filter((s) => s.step === A.step
        && zoneCol[s.zone] > lo && zoneCol[s.zone] < hi);
      for (const blocker of blockers) bad.push(`${a}>${b} 壓過 ${blocker.id}`);
    }
    expect(bad).toEqual([]);
  });

  // 目標區中間有東西擋住時，view 會改走「目標前一格」的走廊——那代表垂直段留在**來源這一欄**
  // 多降幾格。所以這裡守的是來源欄下方要淨空：不然那一段會從來源區自己的方塊身上壓過去。
  // 目前沒有任何一條線是這個形狀（四個容器併成一欄之後，原本唯一的那條 AI 開發代理 → VPN 通道
  // 變成同區繞行，改由下面那支測試把關）——留著是因為新增跨區連線時很容易又長出一條。
  test('被擋住的線，來源區在中間那幾列要淨空', () => {
    const bad = [];
    for (const [a, b] of links) {
      const A = byId[a], B = byId[b];
      if (A.zone === B.zone || A.step === B.step) continue;
      const [lo, hi] = [A.step, B.step].sort((x, y) => x - y);
      const blocked = systems.some((s) => zoneCol[s.zone] === colOf(b) && s.step > lo && s.step < hi);
      if (!blocked) continue;
      for (const blocker of systems.filter((s) => zoneCol[s.zone] === colOf(a) && s.step > lo && s.step < hi)) {
        bad.push(`${a}>${b} 的垂直段壓過 ${blocker.id}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // 同區跨列的連線得繞側邊（形狀 3）。view 會逐條挑「擋路橫線比較少」的那一邊走，但那只是
  // 挑**比較好**的一邊——兩邊都有橫線的話，挑完照樣打叉，而畫面上不會有任何錯誤訊息。
  // 所以這裡守的是更強的前提：每條繞行線至少有一邊是**完全淨空**的。
  // 只算嚴格夾在中間那幾列：與端點同列的橫線是從這條線的頭尾接出去的，不會與它打叉。
  test('每條繞行線至少有一邊淨空（兩邊都被橫線佔住＝必然打叉）', () => {
    const bad = [];
    for (const [a, b] of links) {
      const A = byId[a], B = byId[b];
      if (colOf(a) !== colOf(b)) continue;
      const [lo, hi] = [A.step, B.step].sort((x, y) => x - y);
      if (!systems.some((s) => zoneCol[s.zone] === colOf(a) && s.step > lo && s.step < hi)) continue;  // 直線，不繞
      let left = 0, right = 0;
      for (const [c, d] of links) {
        const C = byId[c], D = byId[d];
        const [mine, other] = colOf(c) === colOf(a) ? [C, D] : colOf(d) === colOf(a) ? [D, C] : [];
        if (!mine || zoneCol[other.zone] === colOf(a)) continue;
        if (!(other.step > lo && other.step < hi) && !(mine.step > lo && mine.step < hi)) continue;
        if (zoneCol[other.zone] < colOf(a)) left++; else right++;
      }
      if (left > 0 && right > 0) bad.push(`${a}>${b} 左${left}條右${right}條`);
    }
    expect(bad).toEqual([]);
  });

  // 容器框的範圍是用「同一容器所有方塊的 min/max」算出來的（view 的 boxOf）。同一個容器的
  // 方塊若在 step 上不連號，中間那一格會被框進去——畫面上看起來就是「它也在這個容器裡」，
  // 而那是假的，且完全不報錯。
  test('同一個容器的方塊在同一區內必須連號', () => {
    const groups = {};
    for (const s of systems) {
      if (!s.container) continue;
      (groups[s.zone + '/' + s.container] = groups[s.zone + '/' + s.container] || []).push(s.step);
    }
    const bad = [];
    for (const [k, steps] of Object.entries(groups)) {
      const lo = Math.min(...steps), hi = Math.max(...steps);
      const inRange = systems.filter((s) => s.zone === k.split('/')[0] && s.step >= lo && s.step <= hi);
      if (inRange.length !== steps.length) bad.push(k);
    }
    expect(bad).toEqual([]);
  });

  // 宿主機外框涵蓋所有帶同一個 host 的分區。那些分區必須**相鄰**，否則框會把夾在中間、
  // 不屬於這台主機的分區一起圈進去——「這也跑在我們機器上」是最不該畫錯的一件事。
  test('同一台主機的分區必須相鄰', () => {
    const byHost = {};
    AR_ZONES.forEach((z, i) => { if (z.host) (byHost[z.host] = byHost[z.host] || []).push(zoneCol[z.id]); });
    const bad = Object.entries(byHost)
      .filter(([, idx]) => Math.max(...idx) - Math.min(...idx) !== idx.length - 1)
      .map(([h]) => h);
    expect(bad).toEqual([]);
  });

  test('有 host 的分區其方塊都標了容器（否則會落在宿主機框內卻沒有容器框）', () => {
    const hosted = new Set(AR_ZONES.filter((z) => z.host).map((z) => z.id));
    expect(systems.filter((s) => hosted.has(s.zone) && !s.container).map((s) => s.id)).toEqual([]);
  });
});

// 匯流排只改「怎麼畫」，links 仍是一條一條的事實。它的壞法全都不報錯：
//   成員 id 打錯 → 那條線退回個別畫，圖看起來只是多一條線，沒有人會發現合併漏了一格
//   成員跨區     → 主幹會從別區的方塊旁邊冒出來，看圖的人分不出線是從哪一區來的
//   只剩一個成員 → 畫出一條「主幹＋一條短線」，比原本的直線還難看
describe('匯流排合併的前提', () => {
  const pairs = (bus) => bus.from.flatMap((f) => bus.to.map((t) => [f, t.id]));

  // 這支是「共用主幹」畫法的**代價**：一條主幹接多個出口，等於宣告每個成員都連到每個出口。
  // 少了任何一組，圖上就會出現一條實際不存在的關係——而且完全不報錯。
  // 真實案例：企業版原始碼原本連不到 AI 開發代理（平台沒把那包的路徑寫進 prompt，agent 查不到），
  // 那時它就不能跟核心、GitHub 共用同一條主幹；等到平台補上路徑、`ent>agent` 真的成立，
  // 才把它併進來。這支測試就是那個順序的守門員。
  test('匯流排的每一組（成員×出口）都真的存在於 links', () => {
    const keys = new Set(links.map(([a, b]) => a + '>' + b));
    const bad = buses.flatMap(pairs).filter(([f, t]) => !keys.has(f + '>' + t)).map(([f, t]) => f + '>' + t);
    expect(bad).toEqual([]);
  });

  test('同一條匯流排的成員必須同區（跨區合併會分不出線從哪來）', () => {
    const bad = buses.filter((bus) => new Set(bus.from.map((f) => byId[f] && byId[f].zone)).size !== 1)
      .map((bus) => bus.to.map((t) => t.id).join('+'));
    expect(bad).toEqual([]);
  });

  // 多個出口共用一條主幹，前提是它們在同一欄——不同欄的話主幹只能靠一邊，另一邊的出線
  // 要橫跨整張圖去接，那比不合併還糟。
  test('同一條匯流排的出口必須同欄，且每個出口都有標籤', () => {
    const bad = buses.filter((bus) =>
      new Set(bus.to.map((t) => byId[t.id] && zoneCol[byId[t.id].zone])).size !== 1
      || bus.to.some((t) => !t.label)).map((bus) => bus.to.map((t) => t.id).join('+'));
    expect(bad).toEqual([]);
  });

  test('每條匯流排至少兩個成員、至少一個出口', () => {
    expect(buses.filter((bus) => bus.from.length < 2 || !bus.to.length)
      .map((bus) => bus.from.join('+'))).toEqual([]);
    expect(buses.length).toBeGreaterThan(0);
  });

  // 出口自己不能是成員（會畫出一條接回自己的線），同一條線也不能被兩條匯流排收走（畫兩次）。
  test('沒有自我連接、也沒有一條線被兩條匯流排重複收走', () => {
    const seen = new Set(), dup = [];
    for (const bus of buses) {
      for (const t of bus.to) expect(bus.from).not.toContain(t.id);
      for (const [f, t] of pairs(bus)) {
        const k = f + '>' + t;
        if (seen.has(k)) dup.push(k);
        seen.add(k);
      }
    }
    expect(dup).toEqual([]);
  });
});

describe('這一頁真的接進站台了', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

  // spec 是純資料檔，但 view 靠 <script> 全域載入——漏加 script tag 的症狀是整頁白畫面，
  // 而 jest 這邊 require 得到、照樣全綠。
  test('index.html 有載入 architecture-spec.js 且排在 Architecture.js 之前', () => {
    const html = read('public/index.html');
    const spec = html.indexOf('js/architecture-spec.js');
    const view = html.indexOf('js/views/Architecture.js');
    expect(spec).toBeGreaterThan(-1);
    expect(view).toBeGreaterThan(-1);
    expect(spec).toBeLessThan(view);
  });

  // 語法錯誤在 view 的後果是整頁白畫面（Vue 元件根本註冊不上），靜態比對抓不到。
  test('Architecture.js 語法有效', () => {
    const vm = require('vm');
    const src = read('public/js/views/Architecture.js');
    expect(() => new vm.Script(src, { filename: 'Architecture.js' })).not.toThrow();
  });

  // kind 的顏色與圖例文字都在 view 裡（spec 只列出有哪些 kind）。spec 加一個新 kind 而
  // view 兩張表沒補，症狀是框線變灰、圖例那格印出 undefined——不報錯，也不會有人在改
  // spec 的當下想到要回頭看 view。
  test('view 的顏色與圖例涵蓋所有 kind', () => {
    const src = read('public/js/views/Architecture.js');
    const cut = (name) => {
      const from = src.indexOf('const ' + name);
      return src.slice(from, src.indexOf('};', from));
    };
    const color = cut('AR_KIND_COLOR'), legend = cut('AR_KIND_LEGEND');
    expect(AR_KINDS.filter((k) => !color.includes(k + ':'))).toEqual([]);
    expect(AR_KINDS.filter((k) => !legend.includes(k + ':'))).toEqual([]);
  });

  test('app.js 有註冊路由與側欄入口', () => {
    const app = read('public/js/app.js');
    expect(app).toContain("path: '/architecture'");
    expect(app).toContain('ArchitectureView');
    expect(app).toContain("to=\"/architecture\"");
  });

  // 側欄順序是使用者明確要的：地景圖與流程圖是「查資料」的兩頁，排在所有操作項目之後。
  // 這種順序沒有任何程式依賴，改版時最容易被順手挪走。
  test('側欄順序：管理員 → 架構圖 → 流程圖', () => {
    const app = read('public/js/app.js');
    const admin = app.indexOf('to="/admin" custom');
    const arch = app.indexOf('to="/architecture" custom');
    const flow = app.indexOf('to="/pipeline-flow" custom');
    expect(admin).toBeGreaterThan(-1);
    expect(admin).toBeLessThan(arch);
    expect(arch).toBeLessThan(flow);
  });

  // 沒進門禁的頁不會有基線截圖，之後任何改動都不會被比對到——而那完全沒有訊號。
  test('納入 RWD 截圖門禁', () => {
    const { activeRoutes } = require('../../rwd/routes');
    expect(activeRoutes().some((r) => r.hash === '#/architecture')).toBe(true);
  });
});
