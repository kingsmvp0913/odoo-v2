  window.UiNextPipelineFlowView = Vue.defineComponent({
    name: "UiNextPipelineFlowView",
    data() {
      return {
        // 預設對齊「新專案剛建好時的實際樣子」：e2e_disabled 預設停用。這頁一打開看到的就該是
        // 多數專案真正在跑的流程，要看開啟後長怎樣再自己撥開關。
        e2eEnabled: false,     // 專案層 e2e_disabled 的反面（出考題與考試同一個開關）
        hovered: null,
        // 泳道顯示開關（目前只有 Git 一條，純顯示、與專案設定無關）由 PF_TRACKS 推導，預設全開。
        // 不可寫死鍵名：照 pipeline-spec.js:25 的說明加一條新泳道時，那個 flag 不會存在於 data，
        // v-model 寫不進去、flags 也永遠是 undefined——泳道與掛在它上面的節點一個都不出現，
        // 而且不報錯。spec 檔頭教的擴充方式必須真的做得到，否則那段註解就是在騙人。
        ...Object.fromEntries(PF_TRACKS.filter((t) => t.flag).map((t) => [t.flag, true]))
      };
    },
    computed: {
      // 開關打包成一個物件傳給 spec，spec 不知道 Vue 的存在
      flags() {
        const f = { e2eEnabled: this.e2eEnabled };
        for (const t of PF_TRACKS) if (t.flag) f[t.flag] = this[t.flag];
        return f;
      },
      tracks() { return pipelineTracks(this.flags); },
      trackToggles() { return PF_TRACKS.filter(t => t.flag); },

      // 節點與連線都來自 js/pipeline-spec.js；這裡只做**版面**需要的那一步：收合空列。
      // step 在 spec 裡是手寫的且刻意留空號（節點搬泳道後原本佔的列就空著），照著畫會留一大塊空白。
      // 按實際用到的列重新編號，空列自動消失——搬完節點不必把後面的 step 全部往上挪一次。
      nodes() {
        const n = pipelineNodes(this.flags);
        const usedSteps = [...new Set(n.map((x) => x.step))].sort((p, q) => p - q);
        const remap = {};
        usedSteps.forEach((s, i) => { remap[s] = i; });
        return n.map((x) => ({ ...x, step: remap[x.step] }));
      },

      edges() { return pipelineEdges(this.flags); },

      nodeById() { return Object.fromEntries(this.nodes.map(n => [n.id, n])); },

      // 版面：泳道等寬由左至右，step 等距由上至下。SVG 尺寸由節點數推導。
      layout() {
        const LANE = 240, STEP = 112, W = 152, H = 54;
        // 走廊寬度＝LANE-W＝88，垂直間隙＝STEP-H＝58：兩者都要容得下好幾條線並排。
        // 早期版本各取 34／32，結果是跨泳道的線全擠進同一條走廊，疊成一條看不出起訖的長線。
        // 左側 PAD_X 要留給退回匯流排（見 busX），右側 SIDE 留給最右泳道往右的繞行線。
        // SIDE 要容得下最外側那一軌繞行線：最右泳道的退回線往右繞，重疊越多讓出的軌道越外面
        // （目前最多 4 軌＝節點中心右方 152px）。留不夠不會報錯，只會把線裁掉一截。
        // SIDE 要容得下最外側那一軌：分診匯流排停在最外泳道外緣 +40，繞外側的線從 +56 起算、
        // 每多讓一軌再 +22。留不夠不會報錯，只會把線裁掉一截。
        const PAD_X = 64, PAD_TOP = 34, SIDE = 100, BOTTOM = 24;
        const laneX = {};
        this.tracks.forEach((t, i) => { laneX[t.id] = PAD_X + i * LANE; });
        const pos = {};
        for (const n of this.nodes) {
          pos[n.id] = { x: laneX[n.track], y: PAD_TOP + n.step * STEP, w: W, h: H };
        }
        const maxStep = Math.max(...this.nodes.map(n => n.step));
        return {
          pos, laneX,
          w: PAD_X + (this.tracks.length - 1) * LANE + W + SIDE,
          h: PAD_TOP + maxStep * STEP + H + BOTTOM,
          W, H, STEP, PAD_TOP, GAP: LANE - W
        };
      },

      // 一個關的某一側若已經被「同列的橫線」佔住，同方向再往下的線就別跟它擠——改從**底部**
      // 出發（inner），貼著自己泳道往下，到目標高度才橫出去；回程走更靠內一點往上（innerBack）。
      // 這就是原則 3「會擠就換最近的方向」，圖上有兩處是這個形狀：
      //   客服處理 → 需補資料（同列橫線，佔住右側）＋ → 等待確認回覆（改走底部）
      //   分診    → 開發    （同列橫線，佔住左側）＋ → 待你裁決      （改走底部）
      branchRoutes() {
        const out = {};
        const sideOf = (from, to) => (this.layout.pos[to].x > this.layout.pos[from].x ? 'R' : 'L');
        for (const [a, b] of this.edges) {
          const na = this.nodeById[a], nb = this.nodeById[b];
          if (!na || !nb || na.track === nb.track) continue;
          if (nb.step <= na.step) continue;                  // 只看往下的
          if (this.busSourceMap[a + '>' + b]) continue;      // 匯流排接頭另有走法
          const dir = sideOf(a, b);
          // 同一個關、同一側、同一列的橫線＝那一側已經被佔住
          const sideTaken = this.edges.some(([x, y]) => {
            const ny = this.nodeById[y];
            return x === a && ny && ny.track !== na.track && ny.step === na.step && sideOf(a, y) === dir;
          });
          if (sideTaken) {
            out[a + '>' + b] = 'inner';
            if (this.edges.some(([x, y]) => x === b && y === a)) out[b + '>' + a] = 'innerBack';
            continue;
          }
          // 反過來看目標端：目標的這一側若也被同列橫線佔住，就別從側邊硬擠進去，
          // 橫到它正上方再往下進頂部（規格層重做→開發：開發右側已被 分診→開發 佔住）。
          // 注意是「線**進入**目標的哪一側」，不是「目標在對方的哪一側」——兩者相反。
          // 寫反的話 等待規格確認→建立分支 會被誤判成要橫過去進頂部，跟別的線疊 148px。
          const enterSide = (x, y) => (this.layout.pos[y].x > this.layout.pos[x].x ? 'L' : 'R');
          const myEnter = enterSide(a, b);
          const enterTaken = this.edges.some(([x, y]) => {
            const nx = this.nodeById[x];
            return y === b && x !== a && nx && nx.track !== nb.track
              && nx.step === nb.step && enterSide(x, b) === myEnter;
          });
          // 但「橫到正上方再往下」的前提是**掉下去那一段是空的**。目標的泳道在中間夾著別的關時，
          // 從頂部進來就是從那幾關身上直直穿過去——合併衝突→併入 ai-dev 正好落在「部署測試區」的
          // 中心線上，看起來像是合併衝突有第二條線接進部署。這種只能退回走廊，擠在被佔住的那側旁。
          const dropBlocked = this.nodes.some((n) => n.track === nb.track
            && n.step > na.step && n.step < nb.step);
          if (enterTaken && !dropBlocked) out[a + '>' + b] = 'over';
        }
        return out;
      },

      // 哪些線併進哪條匯流排——純邏輯、不碰座標。刻意與 buses（算幾何）分開：portOffsets 需要
      // 知道「這條線是不是接頭」，而 buses 又需要 portOffsets 才知道主幹該從哪個高度進入目標，
      // 合在一起就是循環依賴。
      busSourceMap() {
        const m = {};
        for (const cfg of PF_BUSES) {
          if (!this.nodeById[cfg.target]) continue;
          // 只收「回頭路」：link 是 Git 泳道的橫向對應線，雖然也指向開發關，但它表達的是
          // 「這一關在 Git 上做了什麼」，被吞進退回匯流排會被畫成紅色退回線，語意完全相反。
          const sources = this.edges
            .filter(([a, b, kind]) => b === cfg.target && kind !== 'link'
              && !cfg.exclude.includes(a) && this.nodeById[a])
            .map(([a]) => a);
          if (sources.length < 2) continue;          // 只有一條線就不必立一條主幹
          for (const s of sources) m[s + '>' + cfg.target] = cfg;
        }
        return m;
      },

      // 每條匯流排的幾何：主幹涵蓋所有匯入點與目標，最後一段水平接進目標（箭頭在那裡）。
      // 匯入點可能同時在目標的上方與下方（分診就是：裁決在上、停下與審核在下），所以主幹用
      // 「涵蓋全部的垂直線」＋「另一段進入線」兩個 subpath，不是單純從一端拉到另一端。
      buses() {
        const p = this.layout.pos, out = [];
        for (const cfg of PF_BUSES) {
          const tgt = this.nodeById[cfg.target], tp = p[cfg.target];
          if (!tgt || !tp) continue;
          const sources = Object.keys(this.busSourceMap)
            .filter(k => k.endsWith('>' + cfg.target)).map(k => k.split('>')[0]);
          if (!sources.length) continue;
          // side='bottom'：主幹走目標正下方，從底部進來。匯入的關全在目標下方時用這個——
          // 從側邊進來的話，那些接頭得先橫到目標旁邊，正好和目標往外送出的線打叉。
          const bottom = cfg.side === 'bottom';
          const x = bottom ? tp.x + tp.w / 2
            : cfg.side === 'left' ? tp.x - 40 : tp.x + tp.w + 40;
          const ys = sources.map(id => {
            const n = this.nodeById[id], q = p[id];
            // 同泳道的接頭走節點中線（含接口分軌）；跨泳道的走節點下方的間隙（見 edgePath）
            return n.track === tgt.track
              ? q.y + q.h / 2 + ((this.portOffsets[id + '>' + cfg.target] || {}).out || 0)
              : this.gapY(q, id + '>' + cfg.target, true);
          });
          // 主幹進入目標的高度也要參與接口分軌，否則會和其他進入同一側的線（Git 對應線）重疊
          const endY = bottom ? tp.y + tp.h
            : tp.y + tp.h / 2 + ((this.portOffsets['bus:' + cfg.target] || {}).in || 0);
          const lo = Math.min(...ys, endY), hi = Math.max(...ys, endY);
          const enter = bottom ? null : (cfg.side === 'left' ? tp.x : tp.x + tp.w);
          const sourceY = {};
          sources.forEach((id, i) => { sourceY[id] = ys[i]; });
          out.push({
            id: cfg.target, side: cfg.side, x, sources, sourceY, endY, enter, bottom,
            // 從底部進來時主幹本身就通到目標底緣，不需要另一段水平進入線
            path: bottom ? `M ${x} ${hi} V ${endY}` : `M ${x} ${lo} V ${hi} M ${x} ${endY} H ${enter}`
          });
        }
        return out;
      },
      // edgeKey → 它屬於哪條匯流排（該邊只畫接頭，不畫完整路徑）
      busEdgeMap() {
        const m = {};
        for (const b of this.buses) for (const s of b.sources) m[s + '>' + b.id] = b;
        return m;
      },
      // 用純邏輯版當來源，配色／線型／分軌就不必經過幾何鏈（少一層依賴，也少一個循環的機會）
      busEdges() { return new Set(Object.keys(this.busSourceMap)); },

      // 上下緣的接點分配。只接一條就**置中**，多條才依序讓開——早期一律偏 16px，單獨一條的
      // 節點看起來也是歪的；後來只數「有幾條」卻不分配位置，同一個底部的兩條匯流排接頭又都
      // 走正中間疊在一起（待你裁決→開發 與 →分診）。所以這裡要算到「第幾條」，不只是「幾條」。
      // 主線（直上直下那條）優先佔中心，其他往兩側讓。
      vertPortSlots() {
        const byPort = {};
        const add = (id, edge, key, isMain, dirX) => {
          (byPort[id + ':' + edge] = byPort[id + ':' + edge] || []).push({ key, isMain: !!isMain, dirX: dirX || 0 });
        };
        const xdir = (from, to) => Math.sign(this.layout.pos[to].x - this.layout.pos[from].x);
        for (const [a, b] of this.edges) {
          const na = this.nodeById[a], nb = this.nodeById[b];
          if (!na || !nb) continue;
          const r = this.routeKind(a, b);
          if (!r) continue;
          const k = a + '>' + b;
          if (r.mode === 'straight') {
            if (nb.step > na.step) { add(a, 'B', k, true); add(b, 'T', k, true); }
            else { add(a, 'T', k, true); add(b, 'B', k, true); }
          } else if (r.mode === 'inner') add(a, 'B', k, false, xdir(a, b));
          else if (r.mode === 'innerUp') add(a, 'T', k, false, xdir(a, b));
          else if (r.mode === 'innerBack') add(b, 'B', k, false, xdir(b, a));
          else if (r.mode === 'over') { add(a, 'B', k, false, xdir(a, b)); add(b, 'T', k, false, xdir(b, a)); }
          // 繞外側的線只有目標端接上／下緣（起點端從側邊出去，佔的是 portOffsets 那邊的位）。
          // 讓位的方向要指向**它是從哪邊繞過來的**，否則會被排到另一側，一落下來就得往回橫。
          else if (r.mode === 'outer') add(b, nb.step < na.step ? 'T' : 'B', k, false, xdir(b, a));
          else if (r.mode === 'bus' && !r.sameTrack) {
            const tp = this.layout.pos[r.bus.target];
            add(a, 'B', k, false, Math.sign(this.busXOf(r.bus) - (this.layout.pos[a].x + this.layout.pos[a].w / 2)));
          }
        }
        // 走正下方的匯流排主幹也是從目標底部接進去的，一樣佔一個位——漏算的話，
        // 從那個底部出去的線會以為那裡是空的，直接疊在主幹上。
        for (const cfg of PF_BUSES) {
          if (cfg.side !== 'bottom' || !this.nodeById[cfg.target]) continue;
          if (Object.keys(this.busSourceMap).some((k) => k.endsWith('>' + cfg.target))) {
            add(cfg.target, 'B', 'bus:' + cfg.target, true);   // 主幹佔中心
          }
        }
        const out = {};
        for (const gk of Object.keys(byPort)) {
          const list = byPort[gk];
          if (list.length < 2) continue;                       // 單獨一條 → 置中（查不到就是 0）
          // 按線要往哪邊走來分位置：往左的靠左、往右的靠右，主線（直上直下）留中間。
          // 不看方向的話，往左的線可能被排到右邊，一出去就得先往回繞（等待審核→更新 Wiki 就這樣）。
          const mid = list.filter((it) => it.isMain || !it.dirX);
          const left = list.filter((it) => !it.isMain && it.dirX < 0);
          const right = list.filter((it) => !it.isMain && it.dirX > 0);
          mid.forEach((it, i) => { out[it.key + '@' + gk] = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 16; });
          left.forEach((it, i) => { out[it.key + '@' + gk] = -16 * (i + 1); });
          right.forEach((it, i) => { out[it.key + '@' + gk] = 16 * (i + 1); });
        }
        return out;
      },

      // 接口分軌：把「接在某個關的某一側」的線全部收在一起排開，**不分進出**。
      // routeTracks 管的是走廊上的平行段，管不到端點；而只分軌出線口也不夠——一條線進來、
      // 一條線出去，兩條都走節點中線照樣完全重疊（合併衝突的左側就是這樣疊了 44px）。
      // 回傳 { edgeKey: { out: dy, in: dy } }：一條線的兩端各有自己的偏移。
      portOffsets() {
        const byPort = {};
        // dir＝這條線在這個接口是往上還是往下延伸。排序時往上的擺上面、往下的擺下面，
        // 去程與回程就天生不會打叉——回程從上面橫走時，去程的垂直段還沒開始往下。
        let seq = 0;
        const add = (nodeId, side, key, end, dir, isLevel, dist) => {
          if (!side) return;
          const gk = nodeId + ':' + side;
          (byPort[gk] = byPort[gk] || []).push({
            key, end, dir: dir || 0, isLevel: !!isLevel, idx: seq, dist: dist == null ? null : dist
          });
        };
        const lastTrack = this.tracks[this.tracks.length - 1].id;
        // 匯流排主幹先在目標節點的接口佔一個位——它的路徑是獨立畫的，不在下面的 edges 迴圈裡，
        // 不佔位的話別的線會以為那個高度是空的（Git 對應線就這樣和主幹疊了 40px）。
        for (const cfg of PF_BUSES) {
          const tgt = this.nodeById[cfg.target];
          if (!tgt) continue;
          const srcSteps = Object.keys(this.busSourceMap)
            .filter((k) => k.endsWith('>' + cfg.target))
            .map((k) => (this.nodeById[k.split('>')[0]] || {}).step);
          if (!srcSteps.length) continue;
          // 主幹算「從哪個方向進來」：匯入的關全在下面就是 +1。標對了才會排到該去的那一格——
          // 開發關的匯入點全在下方，主幹卻被排到上面，於是 Git 對應線（產生 commit→開發）
          // 橫過來時正好穿過主幹。
          const dir = srcSteps.every((s) => s > tgt.step) ? 1
            : srcSteps.every((s) => s < tgt.step) ? -1 : 0;
          add(cfg.target, cfg.side === 'left' ? 'L' : 'R', 'bus:' + cfg.target, 'in', dir);
        }
        for (const [a, b] of this.edges) {
          const key = a + '>' + b;
          seq += 1;
          const na = this.nodeById[a], nb = this.nodeById[b];
          const pa = this.layout.pos[a], pb = this.layout.pos[b];
          if (!na || !nb || !pa || !pb) continue;
          const r = this.routeKind(a, b);
          if (!r) continue;
          if (r.mode === 'straight') continue;                 // 直上直下走頂／底，不佔側邊
          // 接點的上下順序＝**這條線是從哪個方向來的**：從上面來就接上面的點、從下面來就接下面的。
          // 這樣線不必為了接到點而回頭繞。QA（在上）與 部署（在下）都指向失敗待確認，兩條接點
          // 因此自然一上一下，不再互相交錯。
          const dOut = Math.sign(nb.step - na.step);   // 出去：往上的關在上面 → -1
          const dIn = -dOut;                           // 進來：從上面來 → -1
          // 這條線的垂直段離某一端多遠（走上／下緣或匯流排的沒有這一段 → null）。走廊線的兩端
          // 共用同一條垂直段，但各自量到自己的中線——排接口順序時要用的是「離**這一關**多遠」。
          const vx = this.entryVertX(a, b, r);
          const distTo = (p) => (vx == null ? null : Math.abs(vx - (p.x + p.w / 2)));
          const dist = distTo(pb);
          if (r.mode === 'bus') {
            // 接頭的另一端落在主幹上，不佔目標節點的接口；跨泳道的接頭從底部出發也不佔側邊
            // 主幹在正下方時，接頭一律從節點底部走，不佔側邊接口
            if (r.sameTrack && r.bus.side !== 'bottom') add(a, r.bus.side === 'left' ? 'L' : 'R', key, 'out', dOut);
          } else if (r.mode === 'inner') {
            // 起點端在自己泳道底下用固定偏移錯開；目標端仍是側邊接口，要分軌——
            // 去程的終點與回程的起點都落在目標同一側，不分軌就整段疊在一起。
            add(b, r.side === 'R' ? 'L' : 'R', key, 'in', dIn, false, dist);
          } else if (r.mode === 'innerUp') {
            add(b, r.side === 'R' ? 'L' : 'R', key, 'in', dIn, false, dist);
          } else if (r.mode === 'outer') {
            add(a, r.side, key, 'out', dOut);          // 目標端接上／下緣，不佔側邊
          } else if (r.mode === 'innerBack') {
            // r.side 就是「往哪一邊走」，所以線從同名的那一側出去。寫成反的話，去程的終點與
            // 回程的起點會被登記到節點的不同側，分軌就不會把這兩條算在一起（它們其實都接左側）。
            add(a, r.side, key, 'out', dOut);
          } else if (r.mode === 'over') {
            // 目標端進頂部，不佔側邊；但起點端**不一定**從底部走——edgePath 會先試「從側邊
            // 直接橫過去」的捷徑（原則 3：能直連就別繞），只有那條橫線會撞到別的關才改走間隙。
            // 這裡原本整條跳過，於是走捷徑的線落在節點正中線、完全不參與該側分軌：關掉 E2E 後
            // 部署測試區→等待審核 就這樣夾在 部署→失敗待確認 與 合併衝突→部署測試區 中間，
            // 左右各差 6.5px，並行 164px——看起來是一條粗雙線，而重疊掃描（門檻 3px）測不到。
            add(a, r.side, key, 'out', dOut);
          } else if (r.mode === 'sidestep') {
            add(a, r.side, key, 'out', dOut); add(b, r.side, key, 'in', dIn);
          } else {                                             // level／corridor
            const isLevel = r.mode === 'level';
            add(a, r.side, key, 'out', dOut, isLevel, distTo(pa));
            add(b, r.side === 'R' ? 'L' : 'R', key, 'in', dIn, isLevel, dist);
          }
        }
        const out = {};
        for (const gk of Object.keys(byPort)) {
          const list = byPort[gk];
          if (list.length < 2) continue;                    // 只有一條就走中線
          // 先按來向排（從上面來的擺上面）；同一個來向時，**出去的擺上面**——
          // 「從上面下來進入某關」與「從該關往上出去」在接口處都算「上」，不再分就會擠成一點，
          // 兩條線在那裡打叉（合併衝突→部署測試區 撞 部署→失敗待確認）。
          // 同 step 的橫線與其他線分開排：
          //   兩條都是同 step 橫線 → 按**定義順序**。這種線的兩端各屬於不同的接口群組，用 out/in
          //   當排序鍵的話，同一對節點的往返會在兩端都拿到對稱位置，兩條疊成 Z 字（客服處理↔需補資料）。
          //   其他 → **出去的擺上面**：「從上面下來進入某關」與「從該關往上出去」在接口處都算「上」，
          //   不再分就會擠成一點（合併衝突→部署測試區 撞 部署→失敗待確認）。
          // 兩條線都要在這一側轉彎時，順序由**垂直段離這一關多遠**決定，不看進出：
          // 垂直段往上長的（從上面下來的線）→ 近的接在上面；往下長的 → 遠的接在上面。
          // 反過來排的話，外側那條的橫段必然穿過內側那條的垂直段——
          //   分診→待你裁決（垂直段在 x=844）壓過 規格層重做→待你裁決（x=740）、
          //   合併衝突↔併入 ai-dev 這對來回線在兩端各打一個叉，都是這樣來的。
          // 只有一端量得到距離時（另一端走頂／底緣或匯流排）才退回舊規則「出去的擺上面」。
          list.sort((p, q) => (p.dir - q.dir)
            || (p.dist != null && q.dist != null
              ? (p.dir < 0 ? p.dist - q.dist : q.dist - p.dist)
              : 0)
            || (p.isLevel && q.isLevel
              ? p.idx - q.idx
              : (p.end === 'out' ? 0 : 1) - (q.end === 'out' ? 0 : 1))
            || (p.idx - q.idx));
          list.forEach((it, i) => {
            const dy = (i - (list.length - 1) / 2) * 13;
            (out[it.key] = out[it.key] || {})[it.end] = dy;
          });
        }
        // 同 step 的橫線：只要有一端沒有別的線在搶（那一端本來就走中線），就跟著另一端的高度，
        // 整條畫成一條直線。兩端各自讓開會在中間折一小段 6～13px 的垂直，而那截 Z 字常常正好
        // 落在別條線上——併入測試→合併衝突 就這樣和 併入 ai-dev→合併衝突 疊了 15px。
        // 兩端都有別的線在搶時不動：那種折是真的擠不下（客服處理↔需補資料）。
        for (const [a, b] of this.edges) {
          const r = this.routeKind(a, b);
          if (!r || r.mode !== 'level') continue;
          const o = out[a + '>' + b];
          if (!o) continue;                                 // 兩端都沒人搶＝本來就是直線
          if (o.out == null) o.out = o.in;
          else if (o.in == null) o.in = o.out;
        }
        return out;
      },

      // 間隙分軌：走「關與關之間那條橫向間隙」的線（匯流排接頭、繞外側的線）如果都取間隙中線，
      // 同一格的兩條就會整段疊在一起（裁決→開發 的接頭與 QA→失敗待確認 疊了 206px）。
      // 這裡按水平區間分軌——不重疊的線仍可共用同一個高度，只有真的交疊才往下讓。
      gapTracks() {
        const groups = {};
        for (const [a, b] of this.edges) {
          const r = this.routeKind(a, b);
          if (!r) continue;
          const na = this.nodeById[a], nb = this.nodeById[b];
          const pa = this.layout.pos[a], pb = this.layout.pos[b];
          if (!na || !nb || !pa || !pb) continue;
          const cx = pa.x + pa.w / 2;
          let step, x0, x1;
          if (r.mode === 'bus' && !r.sameTrack) {
            step = na.step;
            const bx = this.busXOf(r.bus);
            x0 = Math.min(cx, bx); x1 = Math.max(cx, bx);
          } else if (r.mode === 'over') {
            step = na.step;                          // 橫過去那一段也走這條間隙
            const bx = pb.x + pb.w / 2 + 16;
            x0 = Math.min(cx, bx); x1 = Math.max(cx, bx);
          } else continue;
          (groups[step] = groups[step] || []).push({ k: a + '>' + b, x0, x1 });
        }
        const out = {};
        for (const gk of Object.keys(groups)) {
          const ends = [];
          for (const it of groups[gk].sort((p, q) => p.x0 - q.x0)) {
            let t = ends.findIndex((e) => e <= it.x0);
            if (t === -1) t = ends.length;
            ends[t] = it.x1;
            out[it.k] = t;
          }
        }
        return out;
      },

      // 走廊分軌：同一條走廊（或同一側的繞行）上，只有「垂直範圍真的重疊」的線才需要錯開。
      // 早期版本用雜湊決定每條線的偏移量，結果是每條線都被推歪一點、彼此不平行——而其中絕大多數
      // 根本不與任何線重疊，等於為了少數幾處衝突把整張圖弄斜。這裡改成區間著色：先按起點排序，
      // 依序塞進第一條「已經空出來」的軌道，不重疊的線自然全部落在軌道 0（＝走中線、對齊）。
      routeTracks() {
        const groups = {};
        for (const [a, b] of this.edges) {
          const k = a + '>' + b;
          if (this.busEdges.has(k)) continue;              // 匯流排的位置是固定的，不參與分軌
          const na = this.nodeById[a], nb = this.nodeById[b];
          const pa = this.layout.pos[a], pb = this.layout.pos[b];
          if (!na || !nb || !pa || !pb) continue;
          const y0 = Math.min(pa.y, pb.y), y1 = Math.max(pa.y + pa.h, pb.y + pb.h);
          const r = this.routeKind(a, b);
          if (!r || r.mode === 'straight' || r.mode === 'level') continue;        // 這兩種不佔走廊
          if (r.mode.startsWith('inner') || r.mode === 'over') continue;         // 各有專屬通道
          let gk;
          // 繞外側的線與 sidestep 走同一條外側通道，分在同一組才會一內一外讓開
          if (r.mode === 'sidestep' || r.mode === 'outer') gk = 'side:' + na.track;
          else gk = 'gap:' + this.corridorMidX(a, b);
          (groups[gk] = groups[gk] || []).push({ k, y0, y1 });
        }
        const out = {};
        for (const gk of Object.keys(groups)) {
          const lanes = [];                                 // 每條軌道上已佔用的區間
          // 跨得短的先分配，才會拿到內側軌道。反過來的話，短程線被擠到外側，它從節點橫出去的
          // 那一小段就會穿過長程線的垂直段（分診→規格層重做 與 分診→待你裁決 就是這樣打叉的）。
          // 因為不再按起點排序，判「這一軌塞不塞得下」必須逐一比對該軌所有區間，
          // 不能只看最後一個區間的結束點——那是按起點排序才成立的簡化。
          for (const it of groups[gk].sort((p, q) => (p.y1 - p.y0) - (q.y1 - q.y0))) {
            let t = lanes.findIndex((iv) => iv.every(([s, e]) => it.y1 <= s || it.y0 >= e));
            if (t === -1) { t = lanes.length; lanes.push([]); }
            lanes[t].push([it.y0, it.y1]);
            out[it.k] = t;
          }
        }
        return out;
      },

      // hover 時主幹只亮「這一關的接頭 → 目標」那一段。整條主幹一起亮的話，接頭以外的部分
      // 亮著卻沒接到任何亮起的東西，看起來就是一截斷在半空中的線。
      // hover 的是目標關本身時才整條亮——那時每一條接頭確實都通到它。
      busHighlight() {
        if (!this.hovered) return [];
        const out = [];
        for (const b of this.buses) {
          if (this.hovered === b.id) { out.push({ key: b.id, d: b.path }); continue; }
          if (!b.sources.includes(this.hovered)) continue;
          out.push({ key: b.id, d: b.bottom
            ? `M ${b.x} ${b.sourceY[this.hovered]} V ${b.endY}`
            : `M ${b.x} ${b.sourceY[this.hovered]} V ${b.endY} H ${b.enter}` });
        }
        return out;
      },

      // 匯流排主幹縱跨 780px 以上，比視窗還高——hover 某一關時，接頭往主幹一接就跑出畫面，
      // 看不到它接去哪，感覺像少了一段。在接頭末端標出目標名稱，就不必追著線捲畫面。
      // 只在 hover 時出現，平常不佔版面。
      busStubLabels() {
        if (!this.hovered) return [];
        const q = this.layout.pos[this.hovered], n = this.nodeById[this.hovered];
        if (!q || !n) return [];
        return this.buses.filter(b => b.sources.includes(this.hovered)).map(b => {
          const tgt = this.nodeById[b.id];
          // 高度必須跟接頭**用同一個算式**（見 buses）：跨泳道的接頭走 gapY（間隙 18px 起、
          // 每讓一軌再 13px），這裡原本自己算成間隙正中間（29px），差 11px——標籤剛好落在
          // 它要標示的那條線上，字被線穿過去。
          const y = n.track === tgt.track
            ? q.y + q.h / 2 + ((this.portOffsets[this.hovered + '>' + b.id] || {}).out || 0)
            : this.gapY(q, this.hovered + '>' + b.id, true);
          return {
            key: b.id, x: b.x + (b.side === 'left' ? 6 : -6), y: y - 7,
            anchor: b.side === 'left' ? 'start' : 'end',
            text: '↩ ' + tgt.label
          };
        });
      },

      active() { return this.hovered ? this.nodeById[this.hovered] : null; },
      activeEdges() {
        if (!this.hovered) return new Set();
        return new Set(this.edges
          .filter(([a, b]) => a === this.hovered || b === this.hovered)
          .map(([a, b]) => a + '>' + b));
      },
      activeNeighbours() {
        const s = new Set();
        if (!this.hovered) return s;
        for (const [a, b] of this.edges) {
          if (a === this.hovered) s.add(b);
          if (b === this.hovered) s.add(a);
        }
        return s;
      }
    },
    methods: {
      kindColor(n) { return PF_KIND_COLOR[n.kind] || 'var(--border-strong)'; },

      // 狀態名太長時折成兩行。原本是壓成 134px 塞進 152px 的框，左右只剩 9px——而線正好接在
      // 框的左右邊緣，字與線之間等於沒有留白，看起來就是字壓在線上（分診那格畫的是
      // 「reject_triage / resolve_triage」兩個入口狀態）。折行後每行只剩十來個字元，
      // 自然寬度約 80px、左右各留 35px，跟「開發」那種短狀態名的留白一致。
      statusLines(n) {
        const s = n.status || n.ref || '';
        const i = s.indexOf(' / ');
        return i > 0 && s.length > 24 ? [s.slice(0, i + 2), s.slice(i + 3)] : [s];
      },


      // 一條水平線會不會壓過某個方塊的內部。用來決定「直接橫過去」還不還得通。
      horizontalHitsNode(y, x0, x1) {
        const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
        return this.nodes.some((n) => {
          const p = this.layout.pos[n.id];
          return p && y > p.y + 2 && y < p.y + p.h - 2 && hi > p.x + 2 && lo < p.x + p.w - 2;
        });
      },

      // 同泳道且兩點之間夾著別的節點 → 直線會穿過那個節點，必須繞。
      blockedBetween(a, b) {
        const lo = Math.min(a.step, b.step), hi = Math.max(a.step, b.step);
        return this.nodes.some(n => n.track === a.track && n.step > lo && n.step < hi);
      },

      // 一條線該怎麼走——**單一判斷來源**。portOffsets（決定接在節點的哪一側）與 edgePath（畫路徑）
      // 都問這裡；兩邊各判一次的話，加一種新走法就會不同步，接口分軌算在左邊、線卻從右邊出去。
      routeKind(from, to) {
        const na = this.nodeById[from], nb = this.nodeById[to];
        const pa = this.layout.pos[from], pb = this.layout.pos[to];
        if (!na || !nb || !pa || !pb) return null;
        const bus = this.busSourceMap[from + '>' + to];
        if (bus) return { mode: 'bus', bus, sameTrack: na.track === nb.track };
        if (na.track === nb.track) {
          // 往上也可以直走——只要中間沒夾著別的關，而且沒有反向的線會跟它重疊。
          // 分診→規格層重做 就是這種：同泳道、上一格、中間沒東西，繞到側邊反而多兩個彎。
          if (!this.blockedBetween(na, nb)
            && (nb.step > na.step || !this.edges.some(([x, y]) => x === to && y === from))) {
            return { mode: 'straight' };
          }
          return { mode: 'sidestep', side: this.tracks[this.tracks.length - 1].id === na.track ? 'R' : 'L' };
        }
        if (Math.abs(pa.y - pb.y) < 1) return { mode: 'level', side: pb.x > pa.x ? 'R' : 'L' };
        // 往哪一側走，看的是**目標在起點的左邊還是右邊**。早期用「起點是不是最左那條泳道」來判，
        // 關掉 Git 泳道後任務主線變成最左，判斷整個反過來，線就往左鑽出去、直接穿過目標節點。
        const outSide = pb.x > pa.x ? 'R' : 'L';
        const br = this.branchRoutes[from + '>' + to];
        if (br) return { mode: br, side: outSide };
        // 跨泳道往下：從**底部**出發，先往下再橫過去（兩段）。從側邊出發的話是「橫→下→橫」
        // 三段，多繞一個彎（原則 3）。前提是自己泳道在中間那幾列沒有別的關擋著垂直段。
        if (nb.step > na.step
          && !this.nodes.some((n) => n.track === na.track && n.step > na.step && n.step <= nb.step)) {
          return { mode: 'inner', side: outSide };
        }
        // 往上的對稱做法：從**頂部**出發。少了這一條，往上的線只能從側邊擠出去，就會和「從上面
        // 下來進入同一關」的線在那一側打叉（部署→失敗待確認 撞 合併衝突→部署、QA→失敗待確認）。
        if (nb.step < na.step
          && !this.nodes.some((n) => n.track === na.track && n.step < na.step && n.step >= nb.step)) {
          return { mode: 'innerUp', side: outSide };
        }
        // 曾經讓「跨兩格以上」的線繞外側，想解掉 部署→失敗待確認 撞 併入測試↔合併衝突 那兩個
        // 交叉。實測反而從 11 個變成 13 個：繞外側要橫跨整條人工泳道與分診匯流排，沿途製造的
        // 交叉比省下的多。那兩個交叉在目前的節點排列下無解，留著。
        //
        // 但走廊的最後一段是「橫進目標」，跨兩條泳道以上時它可能正好從中間那條泳道的某一關身上
        // 輾過去（分診→分析 壓過「等待確認」）。這種才繞外側。與上面那次的差別是**有沒有先問過**：
        // 那次是無差別繞，這裡只在真的壓到方塊時繞，而且限來源就在最外側泳道——外面是空的，
        // 整段路上一個交叉都不生。
        const away = pb.x > pa.x ? 'L' : 'R';
        const outerLane = this.tracks[away === 'R' ? this.tracks.length - 1 : 0].id;
        if (na.track === outerLane
          && this.horizontalHitsNode(pb.y + pb.h / 2, this.corridorMidX(from, to),
            pb.x > pa.x ? pb.x : pb.x + pb.w)) {
          return { mode: 'outer', side: away };
        }
        return { mode: 'corridor', side: pb.x > pa.x ? 'R' : 'L' };
      },

      // 走廊的 x（起點泳道旁邊那條，不是起訖的幾何中點）。routeTracks 分組、edgePath 畫線、
      // entryVertX 排接口順序三處都要拿到**同一個值**：各算各的就會被分到不同組、各自以為獨佔
      // 那條走廊，然後疊在一起（客服處理↔等待確認回覆 疊過 99px）。
      corridorMidX(from, to) {
        const a = this.layout.pos[from], b = this.layout.pos[to];
        return b.x > a.x ? a.x + a.w + this.layout.GAP / 2 : a.x - this.layout.GAP / 2;
      },

      // 一條線在「橫進目標」之前那段垂直線落在哪個 x。接口分軌要靠它排上下順序（見 portOffsets）。
      // 走上／下緣或匯流排的線沒有這一段，回 null。
      entryVertX(from, to, r) {
        const a = this.layout.pos[from], key = from + '>' + to;
        const acx = a.x + a.w / 2;
        if (r.mode === 'inner') return acx + (this.vertPortSlots[key + '@' + from + ':B'] || 0);
        if (r.mode === 'innerUp') return acx + (this.vertPortSlots[key + '@' + from + ':T'] || 0);
        if (r.mode !== 'corridor') return null;
        const t = this.routeTracks[key] || 0;
        return this.corridorMidX(from, to) + (t === 0 ? 0 : (t % 2 ? 1 : -1) * Math.ceil(t / 2) * 15);
      },

      // 匯流排主幹的 x——buses（算幾何）與 gapTracks／edgePath（算接頭）都問這裡，各自重算就會
      // 在加第三種 side 時漏掉某一處。
      busXOf(cfg) {
        const tp = this.layout.pos[cfg.target];
        if (!tp) return 0;
        return cfg.side === 'bottom' ? tp.x + tp.w / 2
          : cfg.side === 'left' ? tp.x - 40 : tp.x + tp.w + 40;
      },

      // 走間隙的線落在哪個高度：從節點邊緣算起 18px，每讓一軌再 13px（間隙共 58px，容得下 3 軌）。
      // buses 算主幹範圍時也要問這裡，否則接頭停在 A 高度、主幹只涵蓋到 B 高度，接頭就懸空了。
      gapY(pos, key, down) {
        const off = 18 + (this.gapTracks[key] || 0) * 13;
        return down ? pos.y + pos.h + off : pos.y - off;
      },

      // 連線路徑（曼哈頓路由）。跨泳道的垂直段一律走「兩條泳道之間的走廊」，
      // 不走泳道中線——走中線會穿過該泳道上其他關的方框。
      edgePath(from, to) {
        const p = this.layout.pos, a = p[from], b = p[to];
        const na = this.nodeById[from], nb = this.nodeById[to];
        if (!a || !b || !na || !nb) return '';
        const key = from + '>' + to;
        const acx = a.x + a.w / 2, bcx = b.x + b.w / 2;
        // 接口分軌（見 portOffsets）：兩端各自讓開，否則同一側的線會疊在一起
        const port = this.portOffsets[key] || {};
        const acy = a.y + a.h / 2 + (port.out || 0);
        const bcy = b.y + b.h / 2 + (port.in || 0);

        const r = this.routeKind(from, to);
        if (!r) return '';
        const t = this.routeTracks[key] || 0;
        // 上下緣的偏移：查這條線在該接口分到第幾個位置（只接一條就是 0＝置中，見 vertPortSlots）
        const vOff = (id, edge) => this.vertPortSlots[key + '@' + id + ':' + edge] || 0;

        // 併進匯流排的線只畫「接頭」，主幹由 buses 單獨畫一次（每條各畫一次會疊在一起，
        // hover 打亮時更是整條主幹粗細不一致）。
        if (r.mode === 'bus') {
          const bus = this.busEdgeMap[key];
          // 與目標同泳道 → 從節點側邊直接橫出去；跨泳道 → 先下到該關底下的間隙再橫越，
          // 那條間隙保證沒有方框，不會穿過中間泳道的任何一關。
          if (r.sameTrack && !bus.bottom) {
            return bus.side === 'left' ? `M ${a.x} ${acy} H ${bus.x}` : `M ${a.x + a.w} ${acy} H ${bus.x}`;
          }
          return `M ${acx + vOff(from, 'B')} ${a.y + a.h} V ${this.gapY(a, key, true)} H ${bus.x}`;
        }

        // 同泳道、中間沒東西擋 → 直線（往上就從頂部出、接到目標底部）
        if (r.mode === 'straight') {
          return nb.step > na.step
            ? `M ${acx + vOff(from, 'B')} ${a.y + a.h} V ${b.y}`
            : `M ${acx + vOff(from, 'T')} ${a.y} V ${b.y + b.h}`;
        }

        // 同泳道但要繞開夾在中間的節點
        if (r.mode === 'sidestep') {
          const isR = r.side === 'R';
          const off = a.w / 2 + 16 + t * 15;
          const sx = isR ? acx + off : acx - off;
          return `M ${isR ? a.x + a.w : a.x} ${acy} H ${sx} V ${bcy} H ${isR ? b.x + b.w : b.x}`;
        }

        // 側邊被同列橫線佔住時改走的通道（見 branchRoutes）。去程與回程的內外是**刻意相反**的，
        // 否則兩條會交叉——交叉不是重疊，掃描重疊那一關完全看不出來，畫面上卻是兩條線打叉。
        if (r.mode === 'inner') {
          // 貼著自己泳道的主線旁邊往下，到目標高度才橫出去。垂直段走的是泳道底下那片空白。
          const isR = r.side === 'R';
          return `M ${acx + vOff(from, 'B')} ${a.y + a.h} V ${bcy} H ${isR ? b.x : b.x + b.w}`;
        }
        // 往上：從頂部出發，先往上再橫過去
        if (r.mode === 'innerUp') {
          const isR = r.side === 'R';
          return `M ${acx + vOff(from, 'T')} ${a.y} V ${bcy} H ${isR ? b.x : b.x + b.w}`;
        }
        if (r.mode === 'innerBack') {
          // 從**朝著目標的那一側**出發。早期把方向判反，線從自己節點的另一側出來，等於先橫穿
          // 過自己一遍（等待確認回覆→客服處理 穿過自己 152px）。
          //
          // 垂直段跟去程放**同一側**、再往外一格：一左一右的話，回程的橫段必須跨過中間那條
          // 主線才回得來，白白多一個交叉。同側就只是兩條平行線，主線留在中間不受打擾。
          const goLeft = r.side === 'L';
          const sx = goLeft ? a.x : a.x + a.w;
          return `M ${sx} ${acy} H ${bcx + (goLeft ? 32 : -32)} V ${b.y + b.h}`;
        }
        // 目標的側邊被同列橫線佔住 → 橫到它正上方再往下進頂部（進來的方向換掉，見 branchRoutes）。
        // 先試從側邊直接橫過去（原則 3：優先直連）；只有那條水平線會撞到別的關時才退而求其次，
        // 從底部出來走關與關之間的間隙——開啟「依規格先寫測試」時，任務主線那一格就多出
        // 「先寫 E2E 考題」，直橫過去會穿過它。
        if (r.mode === 'over') {
          const ax0 = r.side === 'R' ? a.x + a.w : a.x;
          const tx = bcx + vOff(to, 'T');          // 目標頂部只接這一條就走正中間
          if (!this.horizontalHitsNode(acy, ax0, tx)) return `M ${ax0} ${acy} H ${tx} V ${b.y}`;
          return `M ${acx + vOff(from, 'B')} ${a.y + a.h} V ${this.gapY(a, key, true)} H ${tx} V ${b.y}`;
        }
        // 繞外側（見 routeKind）：從**背對目標**的那一側出去，貼著最外泳道外面走到目標那一列的
        // 上／下方間隙，再橫回目標正上／正下方接進頂／底緣。外側那條通道與 sidestep 共用
        // （routeTracks 分在同一組），兩者同時出現時會自動一內一外，不會疊在一起。
        if (r.mode === 'outer') {
          const isR = r.side === 'R';
          const up = nb.step < na.step;
          const ox = acx + (isR ? 1 : -1) * (a.w / 2 + 16 + t * 15);
          const tx = bcx + vOff(to, up ? 'T' : 'B');
          return `M ${isR ? a.x + a.w : a.x} ${acy} H ${ox} V ${this.gapY(b, key, !up)} H ${tx} V ${up ? b.y : b.y + b.h}`;
        }
        const goRight = b.x > a.x;
        // 同一 step 的橫線：兩端都照接口分軌讓開，高度一致就是直線，不一致就在起點旁折一小段。
        // 一度改成「往右走上方、往左走下方」的固定偏移，但那樣它不參與分軌，會和同一個接口上
        // 別條線算出幾乎相同的高度（差 0.5px，等於疊在一起）。接口分軌現在有上下排序，
        // 同一對節點的來回兩條線本來就會被分到不同軌，不需要另一套固定偏移。
        if (Math.abs(a.y - b.y) < 1) {
          const ax0 = goRight ? a.x + a.w : a.x;
          const bx0 = goRight ? b.x : b.x + b.w;
          if (Math.abs(acy - bcy) < 1) return `M ${ax0} ${acy} H ${bx0}`;
          const mx = goRight ? ax0 + this.layout.GAP / 2 : ax0 - this.layout.GAP / 2;
          return `M ${ax0} ${acy} H ${mx} V ${bcy} H ${bx0}`;
        }
        // 走廊取「起點泳道旁邊那條」，不是起訖的幾何中點——跨兩條泳道時，中點會落在中間那條
        // 泳道的節點上，線就直接穿過去了（QA→失敗待確認 穿過「規格層重做」）。
        const gapX = this.corridorMidX(from, to) + (t === 0 ? 0 : (t % 2 ? 1 : -1) * Math.ceil(t / 2) * 15);
        const ax = goRight ? a.x + a.w : a.x;
        const bx = goRight ? b.x : b.x + b.w;
        return `M ${ax} ${acy} H ${gapX} V ${bcy} H ${bx}`;
      },

      // 併進匯流排的接頭一律跟主幹同色同線型。接頭一種顏色、主幹另一種的話，同一條路徑看起來
      // 像是斷成兩截、後半沒被打亮（規格層重做→開發 是 main 類，原本畫成灰白實線接上紅色虛線主幹）。
      edgeColor(kind, key) {
        if (this.busEdges.has(key) || kind === 'back') return 'var(--danger)';
        if (kind === 'link') return 'var(--info)';
        return 'var(--text-muted)';
      },
      edgeDash(kind, key) {
        if (this.busEdges.has(key)) return '5 4';
        if (kind === 'main') return '';
        if (kind === 'link') return '3 5';
        return '5 4';
      },
      // 箭頭要跟線同色，否則紅線末端接一個灰箭頭，看起來像兩條不同的線交會
      edgeMarker(kind, key) {
        if (kind === 'link' || this.busEdges.has(key)) return '';       // 接頭的箭頭在主幹末端
        return kind === 'back' ? 'url(#pf-arrow-danger)' : 'url(#pf-arrow)';
      },
      dim(id) { return this.hovered && id !== this.hovered && !this.activeNeighbours.has(id); },
      edgeDim(a, b) { return this.hovered && !this.activeEdges.has(a + '>' + b); }
    },
    template: `
      <div class="page-header">
        <div class="page-header-inner">
          <h1 class="page-title">Pipeline 流程圖</h1>
          <p style="color:var(--text-muted);font-size:var(--fs-sm);margin-top:var(--space-1)">
            泳道由左到右是{{ tracks.map(t => t.label).join('、') }}。滑鼠移到節點上會打亮它與相鄰的路徑，並在右側顯示這一關的邏輯。
            下方開關是<strong>推演用</strong>——只改這張圖，不會動到任何專案的設定。
          </p>
        </div>
      </div>

      <div class="page-body">
        <div class="flow-toggle-bar">
          <label class="switch-label-row">
            <div class="switch">
              <input type="checkbox" v-model="e2eEnabled" />
              <div class="switch-track"></div>
              <div class="switch-knob"></div>
            </div>
            <span style="font-size:var(--fs-md);color:var(--text)">E2E 測試{{ e2eEnabled ? '啟用' : '停用' }}</span>
          </label>
          <label v-for="t in trackToggles" :key="t.id"
                 class="switch-label-row">
            <div class="switch">
              <input type="checkbox" v-model="$data[t.flag]" />
              <div class="switch-track"></div>
              <div class="switch-knob"></div>
            </div>
            <span style="font-size:var(--fs-md);color:var(--text)">{{ t.toggleLabel }}</span>
          </label>
        </div>

        <div class="flow-main-row">
          <div data-tour="flow-diagram" class="flow-diagram-panel">
            <!-- 圖是固定尺寸的曼哈頓路由（節點座標全部算好），縮到 390px 會讓標籤疊在一起。
                 與 Terminal 同一種降級：讓它自己橫捲，並明說可以捲——沒有這行，手機使用者
                 只會看到左邊一小條，不會知道右邊還有東西。 -->
            <div class="flow-mobile-hint">圖較寬，可左右捲動檢視；完整流程建議在桌機檢視</div>
            <svg :width="layout.w" :height="layout.h" :viewBox="'0 0 ' + layout.w + ' ' + layout.h"
                 style="display:block;max-width:none">
              <defs>
                <marker id="pf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" />
                </marker>
                <marker id="pf-arrow-danger" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--danger)" />
                </marker>
              </defs>

              <!-- 泳道標題 -->
              <g v-for="t in tracks" :key="'lane-' + t.id">
                <text :x="layout.laneX[t.id] + layout.W / 2" :y="16" text-anchor="middle"
                      fill="var(--text-muted)"
                      style="font-size:11px;font-weight:600;letter-spacing:.5px">{{ t.label }}</text>
              </g>

              <g>
                <!-- 匯流排主幹（退回開發／回分診）：各關的接頭由 edgePath 畫 -->
                <path v-for="bus in buses" :key="'bus-' + bus.id"
                      :d="bus.path" fill="none" stroke="var(--danger)"
                      stroke-width="1.6" stroke-dasharray="5 4"
                      :opacity="hovered ? 0.12 : 0.6"
                      marker-end="url(#pf-arrow-danger)"
                      style="transition:opacity .15s" />
                <!-- hover 時只亮主幹上「這一關通到目標」的那一段，其餘維持淡色 -->
                <path v-for="hl in busHighlight" :key="'hl-' + hl.key"
                      :d="hl.d" fill="none" stroke="var(--danger)"
                      stroke-width="2.5" stroke-dasharray="5 4" opacity="1"
                      marker-end="url(#pf-arrow-danger)" />
                <!-- data-edge 是給檢查用的：改完版面後可以逐條 diff，看出「修 A 卻連帶動到 B」 -->
                <path v-for="[a,b,kind] in edges" :key="a+'>'+b" :data-edge="a+'>'+b"
                      :d="edgePath(a,b)" fill="none"
                      :stroke="edgeColor(kind, a+'>'+b)"
                      :stroke-width="activeEdges.has(a+'>'+b) ? 2.5 : 1.4"
                      :stroke-dasharray="edgeDash(kind, a+'>'+b)"
                      :opacity="edgeDim(a,b) ? 0.12 : (activeEdges.has(a+'>'+b) ? 1 : (kind === 'link' ? 0.4 : 0.55))"
                      :marker-end="edgeMarker(kind, a+'>'+b)"
                      style="transition:opacity .15s, stroke-width .15s" />
              </g>

              <!-- 接頭末端標出「這條回頭路通到哪」，免得追著主幹捲出畫面 -->
              <text v-for="s in busStubLabels" :key="'stub-' + s.key"
                    :x="s.x" :y="s.y" :text-anchor="s.anchor" fill="var(--danger)"
                    style="font-size:10px;font-weight:600;pointer-events:none">{{ s.text }}</text>

              <!-- 觸控裝置沒有 hover：這頁的價值全在移上去帶出來的右側詳情，只綁 mouseenter
                   等於手機上點下去沒反應。click 用**指定**而非切換：行動瀏覽器點一下會先補一次
                   mouseenter 再送 click，寫成 toggle 會當場又關掉。鍵盤同理走 focus。 -->
              <g v-for="n in nodes" :key="n.id"
                 @mouseenter="hovered = n.id" @mouseleave="hovered = null"
                 @click="hovered = n.id" @focus="hovered = n.id"
                 tabindex="0" role="button" :aria-label="n.label"
                 :opacity="dim(n.id) ? 0.25 : 1"
                 style="cursor:pointer;transition:opacity .15s">
                <!-- hover 效果刻意**不動顏色**：框線顏色是這張圖表達「這是什麼性質的關」的
                     唯一管道（見 PF_KIND_COLOR），原本 hover 會把框線與底色換成 primary，
                     等於把「要人動手」的橘框臨時說成「AI agent」的藍框，指著問的當下最容易誤導。
                     改用不帶語意的維度：框線加粗＋以**它自己的顏色**外暈。 -->
                <rect :x="layout.pos[n.id].x" :y="layout.pos[n.id].y"
                      :width="layout.pos[n.id].w" :height="layout.pos[n.id].h" rx="8"
                      fill="var(--card-bg)" :stroke="kindColor(n)"
                      :stroke-width="hovered === n.id ? 2.8 : 1.4"
                      :stroke-dasharray="n.kind === 'inline' || n.kind === 'ext' ? '5 3' : ''"
                      :style="{ transition: 'stroke-width .15s, filter .15s',
                                filter: hovered === n.id ? 'drop-shadow(0 0 6px ' + kindColor(n) + ')' : 'none' }" />
                <!-- 折成兩行的那一格，標題往上讓 4px，否則第二行會頂到下緣 -->
                <text :x="layout.pos[n.id].x + layout.pos[n.id].w/2"
                      :y="layout.pos[n.id].y + (statusLines(n).length > 1 ? 19 : 23)"
                      text-anchor="middle" fill="var(--text)"
                      style="font-size:13px;font-weight:600">{{ n.label }}</text>
                <!-- 過長的狀態名折行（見 statusLines）；折不了的（單一長字串）才退回壓寬度 -->
                <text :x="layout.pos[n.id].x + layout.pos[n.id].w/2"
                      :y="layout.pos[n.id].y + (statusLines(n).length > 1 ? 33 : 40)"
                      text-anchor="middle" fill="var(--text-muted)"
                      :textLength="statusLines(n).length === 1 && statusLines(n)[0].length > 24 ? layout.W - 18 : null"
                      lengthAdjust="spacingAndGlyphs"
                      style="font-size:9.5px;font-family:var(--font-mono, monospace)"><tspan
                        v-for="(s, i) in statusLines(n)" :key="i"
                        :x="layout.pos[n.id].x + layout.pos[n.id].w/2" :dy="i ? 12 : 0">{{ s }}</tspan></text>
              </g>
            </svg>

            <div class="flow-legend-bar">
              <span>—— 主線</span>
              <span>- - - 分支／條件</span>
              <span style="color:var(--danger)">- - - 回頭路（兩條主幹＝各關「退回開發」與「回分診」的匯流排）</span>
              <span style="color:var(--info)">- - - Git 對應</span>
              <span style="color:var(--warning)">▢ 要人動手</span>
              <span style="color:var(--primary)">▢ AI agent</span>
              <span>▢ 系統自動</span>
              <span style="color:var(--info)">▢ Git</span>
              <span>⬚ 虛線框＝不是獨立狀態（任務不會停在那裡）</span>
            </div>
          </div>

          <div class="flow-side-panel">
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-3);min-height:220px">
              <template v-if="active">
                <h3 style="font-size:var(--fs-md);font-weight:var(--fw-semibold);margin-bottom:var(--space-1)">{{ active.label }}</h3>
                <div style="font-size:var(--fs-xs);color:var(--text-muted);font-family:var(--font-mono, monospace);margin-bottom:var(--space-2)">
                  {{ active.status || active.ref }}<template v-if="active.agent"> · agent: {{ active.agent }}</template>
                </div>
                <dl class="flow-detail-grid">
                  <template v-for="(row, i) in active.detail.filter(Boolean)" :key="i">
                    <dt class="flow-detail-term">{{ row[0] }}</dt>
                    <dd style="margin:0;color:var(--text)">{{ row[1] }}</dd>
                  </template>
                </dl>
              </template>
              <div v-else style="color:var(--text-muted);font-size:var(--fs-sm)">
                把滑鼠移到任一個節點上（觸控裝置請點一下），這裡會顯示那一關的進入條件、做什麼、成功與失敗各往哪走。
              </div>
            </div>
          </div>
        </div>
      </div>
    `
  });
