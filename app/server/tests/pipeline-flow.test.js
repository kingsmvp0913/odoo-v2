const fs = require('fs');
const path = require('path');
const {
  STATUS_LABELS, TASK_STATUSES, HUMAN_STATUSES, RUNNABLE_STATUSES
} = require('../../public/js/status-labels.js');
const {
  PF_TRACKS, PF_UNDRAWN_STATUSES, pipelineTracks, pipelineNodes, pipelineEdges
} = require('../../public/js/pipeline-spec.js');

// 這支測試守的是「流程圖上畫的關卡，真的存在於狀態機」，兩個方向都要守。
//
// 失效方式不是報錯而是靜默誤導：流程內容（pipeline-spec.js）與真正在跑的狀態機
// （server/pipeline/*）沒有任何程式上的連結，改了 pipeline 卻沒改 spec，圖照樣渲染、
// 測試照樣全綠、console 一個錯都沒有——只是它從此開始騙人。
// 實際發生過：圖上把「先寫 E2E 考題」畫成 status: 'spec_tour' 的一關，但那不是任務狀態
// （它是 branch_pending 內部的一步，spec_tour 只是 token 記帳用的 agentType），任務永遠
// 不會停在那裡。對一張「拿來對焦討論流程」的圖來說，講錯比沒有更糟。
//
// 三個開關會實際增刪節點與連線，所以結構檢查一律跑遍全部八種組合，不是只驗預設值。
const COMBOS = [];
for (let m = 0; m < 8; m++) {
  COMBOS.push({ e2eEnabled: !!(m & 1), specTour: !!(m & 2), showGit: !!(m & 4) });
}
const label = (f) => `e2e=${f.e2eEnabled ? 1 : 0} tour=${f.specTour ? 1 : 0} git=${f.showGit ? 1 : 0}`;

// 一個節點可以在 status 裡並列兩個入口狀態（分診：reject_triage / resolve_triage）
const statusesOf = (n) => (n.status || '').split('/').map((s) => s.trim()).filter(Boolean);
const drawnStatuses = () => new Set(
  COMBOS.flatMap((f) => pipelineNodes(f)).flatMap(statusesOf)
);

// 語法錯誤在 view 的後果是整頁白畫面（Vue 元件根本註冊不上），而純資料的 spec 由上面的
// require 本身就驗掉了。view 沒有 window／Vue 就載不起來，只能單獨驗語法。
// 實際發生過：改路由邏輯時多了一個 `}`，測試全綠、頁面全白。
test('PipelineFlow.js 語法有效（語法錯＝整頁白畫面，靜態比對抓不到）', () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/views/PipelineFlow.js'), 'utf8');
  expect(() => new vm.Script(src, { filename: 'PipelineFlow.js' })).not.toThrow();
});

// pipeline-spec.js:25 教的擴充方式是「加一條泳道就是加一筆 {flag:'showXxx'}，版面與開關列
// 會自動跟上」。view 曾把開關收窄成三個硬寫的鍵（flags() 直接回 {e2eEnabled, specTour, showGit}），
// 於是照著註解加泳道會拿到 flags.showXxx === undefined：泳道與掛在它上面的節點一個都不出現，
// 而且不報錯、不紅燈——文件教的做法做不到，這是最難查的一種。
// view 沒有 window／Vue 就載不起來，所以在獨立 context 裡餵最小替身把它載進來，
// 只取 data() 與 computed.flags 這兩個純函式來驗。
const loadView = (extraTracks = []) => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/views/PipelineFlow.js'), 'utf8');
  const sandbox = { Vue: { defineComponent: (d) => d }, PF_TRACKS: [...PF_TRACKS, ...extraTracks] };
  sandbox.window = sandbox;
  vm.runInNewContext(src, sandbox);
  return sandbox.PipelineFlowView;
};

describe('泳道開關與 spec 的擴充方式一致', () => {
  test('現有泳道：flag 是 data 上真實存在的鍵（v-model 寫不進不存在的鍵）', () => {
    const flagged = PF_TRACKS.filter((t) => t.flag);
    expect(flagged.length).toBeGreaterThan(0);            // registry 被清空的防呆
    const data = loadView().data();
    expect(flagged.filter((t) => !(t.flag in data))).toEqual([]);
  });

  test('照 spec 檔頭新增一條帶 flag 的泳道，開關與 flags 自動跟上', () => {
    const def = loadView([{ id: 'eservice', label: 'eService', flag: 'showEservice', toggleLabel: '顯示 eService' }]);
    const data = def.data();
    expect(data).toHaveProperty('showEservice');          // 沒有這個鍵＝開關按了寫不進去
    const flags = def.computed.flags.call({ ...data });
    expect(flags.showEservice).toBe(true);                // undefined＝泳道與其上節點全部不出現
  });

  // 出考題與考試併成同一個 e2eEnabled 之後，這裡只剩一個專案設定開關。
  // 仍要斷言它「原樣傳給 spec」：view 與 spec 的 flag 名稱對不上時，畫面不會報錯，
  // 只會安靜地永遠畫成停用的樣子。
  test('專案設定開關原樣傳給 spec', () => {
    const def = loadView();
    const flags = def.computed.flags.call({ ...def.data(), e2eEnabled: true });
    expect(flags).toMatchObject({ e2eEnabled: true, showGit: true });
    expect(flags).not.toHaveProperty('specTour');   // 舊旗標必須真的消失，不是留著沒人讀
  });
});

// spec 是純資料檔，但 view 靠 <script> 全域載入——漏加 script tag 的症狀是整頁白畫面，
// 而 jest 這邊 require 得到、照樣全綠。
test('index.html 有載入 pipeline-spec.js 且排在 PipelineFlow.js 之前', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  const spec = html.indexOf('js/pipeline-spec.js');
  const view = html.indexOf('js/views/PipelineFlow.js');
  expect(spec).toBeGreaterThan(-1);
  expect(view).toBeGreaterThan(-1);
  expect(spec).toBeLessThan(view);
});

describe('流程圖節點對得上狀態機', () => {
  const declared = [...drawnStatuses()];

  test('解析到合理數量的 status（spec 壞掉時測試不得靜默通過）', () => {
    expect(declared.length).toBeGreaterThan(12);
  });

  test.each(declared)('%s 是真的任務狀態', (key) => {
    expect(STATUS_LABELS[key]).toBeDefined();
  });

  // 反向：後端會停下來等人的狀態，圖上必須畫得到——這幾個正是「使用者卡住時想在圖上找的那一格」。
  // 缺了不會有任何訊號，只有人看著圖說「那我現在這張任務在哪裡？」時才會發現。
  // 來源是 status registry 的 actor:'human'——API 的 needs_action 查詢、通知派送、列表篩選現在都由它
  // 推導，掃單一支 route 檔的字面陣列已經沒有意義（那份重複已收回 registry）。
  test('等人動作的狀態全部有畫在圖上', () => {
    expect(HUMAN_STATUSES.length).toBeGreaterThan(5);   // registry 被清空的防呆
    expect(HUMAN_STATUSES.filter((s) => !declared.includes(s))).toEqual([]);
  });

  // 第三個方向：上面兩條守的是「兩邊都有這個 status」，守不住「兩邊對它的定性不一致」。
  // 圖上畫成 gate（等人的閘門）、registry 卻標成 system，畫面看起來完全正常，但那張任務會被 cron
  // 當成可推進的撈走——使用者根本沒機會決定，而且不會有任何錯誤訊息。
  // start／end／git／ext／inline 不在此規則內：它們不是「由誰推進」的分類（終態、分支示意、平台外）。
  const KIND_ACTOR = { gate: 'human', stop: 'human', agent: 'agent', sys: 'system' };
  test('圖上的節點性質與 registry 的 actor 不得矛盾', () => {
    const bad = [];
    const seen = new Set();
    for (const n of COMBOS.flatMap((f) => pipelineNodes(f))) {
      const want = KIND_ACTOR[n.kind];
      if (!want) continue;
      for (const s of statusesOf(n)) {
        if (seen.has(`${n.id}:${s}`)) continue;
        seen.add(`${n.id}:${s}`);
        const actor = (TASK_STATUSES[s] || {}).actor;
        if (actor !== want) bad.push(`${n.id}(kind=${n.kind}) 的 ${s}：actor=${actor}，應為 ${want}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // 派工清單混進等人的狀態，該閘門就會被 cron 自動推走。規格原文寫的是「runner.js 內不得存在自動
  // 推進 human 狀態的賦值」，但掃原始碼分不出方向——runner 本來就必須能把任務推進「到」閘門。真正
  // 該擋的是「停在閘門時還被撈去派工」，也就是這裡驗的 RUNNABLE ∩ HUMAN。
  // 第二個斷言是牙齒所在：任何 actor 被改成無效值都會讓總數對不上，而不是靜默從某一份名單消失。
  test('派工清單不得包含等人動作的狀態（閘門被自動跳過＝使用者的決定被略過）', () => {
    expect(RUNNABLE_STATUSES.filter((s) => HUMAN_STATUSES.includes(s))).toEqual([]);
    const terminal = Object.keys(TASK_STATUSES).filter((s) => TASK_STATUSES[s].actor === 'terminal');
    expect(RUNNABLE_STATUSES.length + HUMAN_STATUSES.length + terminal.length)
      .toBe(Object.keys(TASK_STATUSES).length);
  });

  // 最重要的一條：runner 那邊實際會寫進 tasks.status 的每一個狀態，圖上都要找得到。
  // 只驗「圖上畫的存在於狀態機」是不夠的——那只擋得住畫錯，擋不住**漏畫**。新增一關而沒更新
  // spec，圖會安靜地少一格，而這正是「以流程圖為準」最致命的失效方式。
  // 過渡態（答完就走、不會停在那裡）不畫，但必須在 PF_UNDRAWN_STATUSES 具名並寫理由。
  test('runner 會設定的任務狀態，圖上都畫得到（或已具名列為過渡態）', () => {
    const dir = path.join(__dirname, '../pipeline');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f))
      .concat([path.join(__dirname, '../pipeline-routes.js'), path.join(__dirname, '../tasks-routes.js')]);
    const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    // 只認得出 tasks.status 的賦值形式；撈到的雜訊（clone_status／env status 等）用
    // STATUS_LABELS 過濾掉——那份表就是「什麼算任務狀態」的定義。
    const found = [...new Set([...src.matchAll(/status\s*=\s*'([a-z_]+)'/g)].map((m) => m[1]))]
      .filter((s) => STATUS_LABELS[s]);
    expect(found.length).toBeGreaterThan(15);        // regex 失效防呆
    const undrawn = new Set(PF_UNDRAWN_STATUSES.map(([s]) => s));
    const missing = found.filter((s) => !declared.includes(s) && !undrawn.has(s));
    expect(missing).toEqual([]);
  });

  test('PF_UNDRAWN_STATUSES 每一筆都是真狀態，且真的沒畫（避免名單長霉）', () => {
    for (const [s, why] of PF_UNDRAWN_STATUSES) {
      expect(STATUS_LABELS[s]).toBeDefined();
      expect(declared).not.toContain(s);
      expect(String(why).length).toBeGreaterThan(5);   // 一定要寫理由
    }
  });
});

// 版面用「泳道 × step」定位，兩個節點撞同一格會直接疊在一起（後畫的蓋住先畫的）。
// 條件式節點（spec tour、E2E）平常不渲染，撞格了要等某個開關被打開才看得見，所以逐組合檢查。
describe('流程圖結構完整（八種開關組合）', () => {
  test('解析到合理數量的節點（spec 壞掉時測試不得靜默通過）', () => {
    expect(pipelineNodes({ e2eEnabled: true, specTour: true, showGit: true }).length).toBeGreaterThan(15);
    expect(PF_TRACKS.length).toBeGreaterThan(2);
  });

  test.each(COMBOS.map((f) => [label(f), f]))('%s：同一泳道內沒有兩個節點共用同一 step', (_, f) => {
    const seen = new Set(), clashes = [];
    for (const n of pipelineNodes(f)) {
      const key = `${n.track}#${n.step}`;
      if (seen.has(key)) clashes.push(key);
      seen.add(key);
    }
    expect(clashes).toEqual([]);
  });

  test.each(COMBOS.map((f) => [label(f), f]))('%s：節點 id 不重複', (_, f) => {
    const ids = pipelineNodes(f).map((n) => n.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test.each(COMBOS.map((f) => [label(f), f]))('%s：每個節點的 track 都是當下顯示中的泳道', (_, f) => {
    const shown = pipelineTracks(f).map((t) => t.id);
    expect([...new Set(pipelineNodes(f).map((n) => n.track))].filter((t) => !shown.includes(t))).toEqual([]);
  });

  // 連線指到不存在的節點不會報錯，只會靜默不畫——關掉某個開關後少一條線，肉眼很難發現。
  //
  // ⚠ 這條檢查一度是**恆真式**：pipelineEdges 回傳前自己就先 `filter(端點都在)`，這裡再拿
  // 過濾後的結果驗「兩端都存在」，等於問它自己。實測三種單字元 typo（'gitt'／'codingg'／
  // 'clarifyy'）各自讓一個節點或一條退回線整格消失，而八組結構檢查 0 紅燈。
  // 已改成「線跟著節點的條件一起 push、不做事後過濾」，這條才咬得到；下面那支 mutation
  // 測試是它的看門狗——誰把過濾加回去，那裡會紅。
  test.each(COMBOS.map((f) => [label(f), f]))('%s：每條連線的兩端都存在', (_, f) => {
    const ids = new Set(pipelineNodes(f).map((n) => n.id));
    expect(pipelineEdges(f).filter(([a, b]) => !ids.has(a) || !ids.has(b))).toEqual([]);
  });

  // 上面那條有沒有牙齒，只有真的把 id 打壞才驗得出來。這裡把 spec 原始碼的一個 id 改壞、
  // 在獨立 context 重新載入一次，斷言結構檢查會紅——三個案例正是實測過會靜默通過的那三種。
  describe.each([
    ['連線端點打錯（gitwt→gitt）', "['gitwt', 'gitcommit', 'main']", "['gitt', 'gitcommit', 'main']"],
    ['節點 id 打錯（coding→codingg）', "id: 'coding', track: 'task'", "id: 'codingg', track: 'task'"],
    ['退回線端點打錯（clarify→clarifyy）', "['clarify', 'coding', 'back']", "['clarifyy', 'coding', 'back']"]
  ])('%s 會被上面的結構檢查抓到', (_, from, to) => {
    test('至少一種開關組合驗出端點不存在的連線', () => {
      const vm = require('vm');
      const src = fs.readFileSync(path.join(__dirname, '../../public/js/pipeline-spec.js'), 'utf8');
      expect(src).toContain(from);            // 錨點漂掉時不得靜默通過（改不到＝什麼都沒驗）
      const mod = { exports: {} };
      vm.runInNewContext(src.replace(from, to), { module: mod, exports: mod.exports });
      const broken = COMBOS.some((f) => {
        const ids = new Set(mod.exports.pipelineNodes(f).map((n) => n.id));
        return mod.exports.pipelineEdges(f).some(([a, b]) => !ids.has(a) || !ids.has(b));
      });
      expect(broken).toBe(true);
    });
  });

  // 孤兒節點＝畫了一個框卻沒有任何線連到它，通常是改流程時只刪了線忘了刪節點。
  test.each(COMBOS.map((f) => [label(f), f]))('%s：沒有連不到任何線的孤兒節點', (_, f) => {
    const touched = new Set(pipelineEdges(f).flatMap(([a, b]) => [a, b]));
    expect(pipelineNodes(f).map((n) => n.id).filter((id) => !touched.has(id))).toEqual([]);
  });

  // 每一格都要走得到。孤兒檢查只看「有沒有連到線」，擋不住「拿掉一條轉移，整段變成走不到的
  // 半島」——實測過：刪掉 更新 Wiki→完成 之後，兩個節點都還各自連著別的線，孤兒檢查照樣全綠。
  // 對一張要當流程依據的圖來說，走不到的格子跟畫錯一樣糟。
  // link 是 Git 對應線、不是轉移，所以當無向邊看待（Git 泳道就是靠它掛到主線上的）。
  test.each(COMBOS.map((f) => [label(f), f]))('%s：每個節點都從入口走得到', (_, f) => {
    const nodes = pipelineNodes(f);
    const entries = nodes.filter((n) => n.kind === 'start').map((n) => n.id);
    expect(entries.length).toBe(1);                  // 入口不只一個＝有獨立島，下面的檢查會失去意義
    const adj = {};
    const link = (a, b) => { (adj[a] = adj[a] || []).push(b); };
    for (const [a, b, kind] of pipelineEdges(f)) {
      link(a, b);
      if (kind === 'link') link(b, a);
    }
    const seen = new Set(entries), stack = [...entries];
    while (stack.length) for (const nx of adj[stack.pop()] || []) if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
    expect(nodes.map((n) => n.id).filter((id) => !seen.has(id))).toEqual([]);
  });

  test.each(COMBOS.map((f) => [label(f), f]))('%s：連線類型只有四種', (_, f) => {
    const bad = pipelineEdges(f).filter(([, , kind]) => !['main', 'alt', 'back', 'link'].includes(kind));
    expect(bad).toEqual([]);
  });

  // link 是 Git 對應線，不是流程轉移：它一定橫跨 git 泳道與別的泳道。畫錯邊會讓「這一關在
  // Git 上做了什麼」被讀成「流程會走到那裡」。
  test('link 線一定是 git 泳道連到別的泳道', () => {
    const f = { e2eEnabled: true, specTour: true, showGit: true };
    const byId = Object.fromEntries(pipelineNodes(f).map((n) => [n.id, n]));
    const links = pipelineEdges(f).filter(([, , k]) => k === 'link');
    expect(links.length).toBeGreaterThan(3);
    for (const [a, b] of links) {
      expect(byId[a].track).toBe('git');
      expect(byId[b].track).not.toBe('git');
    }
  });

  // detail 是這頁真正的價值（hover 才看得到的邏輯摘要），空的節點等於只畫了個框。
  test.each(COMBOS.map((f) => [label(f), f]))('%s：每個節點都有 detail 且每列是 [標題, 內容]', (_, f) => {
    for (const n of pipelineNodes(f)) {
      const rows = (n.detail || []).filter(Boolean);
      expect(rows.length).toBeGreaterThan(1);
      for (const r of rows) {
        expect(Array.isArray(r)).toBe(true);
        expect(r).toHaveLength(2);
        expect(String(r[1]).length).toBeGreaterThan(0);
      }
    }
  });

  // status 與 ref 分工：status 只放真狀態，其他一律 ref。混用就擋不住把不存在的狀態畫成一關。
  test.each(COMBOS.map((f) => [label(f), f]))('%s：每個節點至少有 status 或 ref 其中之一', (_, f) => {
    expect(pipelineNodes(f).filter((n) => !n.status && !n.ref).map((n) => n.id)).toEqual([]);
  });
});
