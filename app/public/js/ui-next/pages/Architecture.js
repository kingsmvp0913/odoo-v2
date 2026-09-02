  window.UiNextArchitectureView = Vue.defineComponent({
    name: "UiNextArchitectureView",
    data() {
      // hovered 與 focused 分開存，最後取聯集（current）。合成同一個變數會壞在這裡：
      // 鍵盤 Tab 進來的焦點只有 blur 會收，滑鼠移出只該收 hover——共用一個變數的話，
      // 焦點還在某一格、滑鼠隨便經過就把說明清空了（而那一格仍然是鍵盤焦點所在）。
      // 實測過的樣子：方塊有焦點、右側說明卻是空的，兩邊講的不是同一件事。
      return { hovered: null, focused: null };
    },
    computed: {
      zones() { return AR_ZONES; },

      // 收合空列：spec 的 step 是手寫的且刻意留空號（挪動系統時不必把後面全部重編）。
      // 照著畫會留下一整條空白列。與 PipelineFlow 的 nodes() 同一個作法。
      systems() {
        const list = architectureSystems();
        const used = [...new Set(list.map((s) => s.step))].sort((a, b) => a - b);
        const remap = {};
        used.forEach((s, i) => { remap[s] = i; });
        return list.map((s) => ({ ...s, step: remap[s.step] }));
      },

      links() { return architectureLinks(); },
      buses() { return architectureBuses(); },
      notes() { return architectureNotes(); },
      byId() { return Object.fromEntries(this.systems.map((s) => [s.id, s])); },
      // 目前被指到的那一格：滑鼠優先於鍵盤焦點（手在滑鼠上時，看的是滑鼠）
      current() { return this.hovered || this.focused; },
      active() { return this.current ? this.byId[this.current] : null; },

      // 版面：分區等寬由左至右，step 等距由上至下。
      // 走廊寬 = ZONE-W = 92，垂直間隙 = STEP-H = 52：兩者都要容得下三條線並排讓道。
      // PAD_X 要夠寬——最左那一區（客戶現場）的跨列線往左繞，繞在圖框外就會被裁掉且不報錯。
      layout() {
        const ZONE = 260, STEP = 110, W = 168, H = 58;
        const PAD_X = 86, PAD_TOP = 66, SIDE = 96, BOTTOM = 28;
        const zoneX = {};
        this.zones.forEach((z) => { zoneX[z.id] = PAD_X + this.colOf(z.id) * ZONE; });
        const pos = {};
        for (const s of this.systems) {
          pos[s.id] = { x: zoneX[s.zone], y: PAD_TOP + s.step * STEP, w: W, h: H,
                        step: s.step, zone: s.zone, col: this.colOf(s.zone) };
        }
        const maxStep = Math.max(...this.systems.map((s) => s.step));
        const maxCol = Math.max(...this.zones.map((z) => this.colOf(z.id)));
        return {
          pos, zoneX, W, H, STEP, ZONE, PAD_TOP,
          w: PAD_X + maxCol * ZONE + W + SIDE,
          h: PAD_TOP + maxStep * STEP + H + BOTTOM
        };
      },

      // 「東西跑在哪台機器、哪個容器裡」是這張圖的主要資訊——除了 docker-compose.yml 沒有第二個
      // 地方看得到。主機這一層只用**標題**表達（不畫框，見 template 的說明），容器才畫框。
      //
      // 四個容器框**誰也沒包住誰**，是刻意的：平台容器掛宿主的 docker.sock 去起測試區與
      // VPN，起出來的是兄弟容器，不是巢狀在它裡面。畫成包住的話，會讓人以為砍掉平台容器
      // 測試區也跟著沒了，而那是錯的。四個框上下排在同一欄，一欄一個容器。
      //
      // 不用「圖最上方一排區名」（流程圖的做法）：各區的縱向位置差很多，統一擺頂端的話，
      // 客戶現場的標題會離它的方塊六列遠，讀者根本連不起來。
      // 沒有 host 的分區才畫自己的框；有 host 的改由容器框加宿主機標題表達，
      // 框疊在一起只會讓人數不清邊界。
      zoneBoxes() {
        return this.zones.filter((z) => !z.host).map((z) => {
          const mine = this.systems.filter((s) => s.zone === z.id);
          return mine.length ? { id: z.id, label: z.label, ...this.boxOf(mine, 20, 30, 12) } : null;
        }).filter(Boolean);
      },

      containerBoxes() {
        const groups = {};
        for (const s of this.systems) {
          if (!s.container) continue;
          const k = s.zone + '/' + s.container;
          (groups[k] = groups[k] || []).push(s);
        }
        return Object.entries(groups).map(([k, list]) => ({
          id: k, label: list[0].container, ...this.boxOf(list, 14, 26, 10)
        }));
      },

      // 宿主機只需要一個標題座標（不畫框，見 template）：x 貼齊該欄最上面那個方塊的左緣，
      // y 則與**最上面那一列的分區標題**同一高度（zoneBoxes 的標題是 boxY-30+19）。
      //
      // 為什麼不貼著自己那一欄的第一個容器框放：容器欄的第一格比單據來源低一列（網頁工作台
      // 對齊的是 eService，不是內部管理 Odoo——見 spec 的 step 說明，那個錯開是刻意的），
      // 貼著放的話兩欄的標題會一高一低，看起來像沒對齊。改成兩個標題切齊同一條線。
      hostBoxes() {
        const groups = {};
        for (const z of this.zones) {
          if (!z.host) continue;
          const mine = this.systems.filter((s) => s.zone === z.id);
          if (mine.length) (groups[z.host] = groups[z.host] || []).push(...mine);
        }
        const titleY = this.layout.PAD_TOP - 11;
        return Object.entries(groups).map(([host, list]) => {
          const b = this.boxOf(list, 0, 0, 0);
          return { id: host, label: host, x: b.x, y: titleY };
        });
      },

      // 所有連線的實際路徑。一次算完而不是每條各自呼叫函式：軌道分配要知道「同一條走廊上
      // 已經有幾條線了」，逐條獨立計算做不到，那正是兩條線疊成一條的成因。
      routes() {
        const L = this.layout, P = L.pos;
        const gapTrack = {};    // 列間走廊：key -> 已用軌道數
        const sideTrack = {};   // 區外走廊：key -> 已用軌道數

        // ── 第一趟：決定每條線的形狀，順便登記它會用到哪個方塊的哪一側 ──
        // 出入口不能「先來先佔中線」：那樣分到的位置與線要去的方向無關，往左的線可能從右邊
        // 出發，橫過來就會壓到同一個方塊往下的線。實測 4 個重疊／交叉全出自這一點。
        // 改成登記完再統一分配：同一側的多條線，**按對方所在的方位排序**依次讓開，
        // 往左的走左邊的口、往上的走上面的口，線就不會自己跟自己打叉。
        // 一律用**欄**判斷左右與同不同排，不用分區：單據來源與客戶現場共用第 0 欄，
        // 用分區判斷的話它們之間會被當成「跨區」，而跨區的線是照兩欄之間的走廊畫的——
        // 同一欄根本沒有那條走廊，畫出來會是一條落在方塊上的零寬度線。
        const zi = (id) => this.colOf(id);
        const plan = [];
        const ports = {};       // nodeId+側 -> [{ i, by }]，by 是排序用的對方座標
        const reg = (id, side, by, i) => { (ports[id + side] = ports[id + side] || []).push({ i, by }); };

        // ── 匯流排：先把成員線挑出來，它們不走下面的個別路由 ──
        // 主幹的 x 與繞行線**共用同一組軌道計數**（sideTrack）：兩者都走分區外側那條走廊，
        // 各算各的話必然疊在一起——而疊起來的兩條線在畫面上就是一條粗線，且不會有錯誤訊息。
        const busOf = {};       // 連線 key -> 匯流排序號
        const busPlan = [];
        this.buses.forEach((bus, bi) => {
          const targets = bus.to.map((t) => ({ id: t.id, label: t.label, P: P[t.id] })).filter((t) => t.P);
          const members = bus.from.map((f) => ({ id: f, P: P[f] })).filter((m) => m.P);
          if (!targets.length || members.length < 2) return;
          // 成員端的箭頭要看它與**各個目標**的方向：只要有一條是雙向的就補回頭箭頭。
          members.forEach((m) => {
            m.dir = targets.some((t) => (this.links.find(([x, y]) => x === m.id && y === t.id) || [])[3] === 'both')
              ? 'both' : null;
            targets.forEach((t) => { busOf[m.id + '>' + t.id] = bi; });
          });
          const goRight = targets[0].P.x > members[0].P.x;
          const mSide = goRight ? 'R' : 'L', tSide = goRight ? 'L' : 'R';
          // 出入口：成員那側依目標的平均高度排序；每個目標那側依成員的平均高度排序。
          const avgT = targets.reduce((n, t) => n + t.P.y, 0) / targets.length;
          const avgM = members.reduce((n, m) => n + m.P.y, 0) / members.length;
          members.forEach((m, k) => { m.i = 90000 + bi * 10 + k; reg(m.id, mSide, avgT, m.i); });
          targets.forEach((t, k) => { t.i = 99000 + bi * 10 + k; reg(t.id, tSide, avgM, t.i); });
          busPlan.push({ bi, targets, members, goRight, mSide, tSide,
                         col: this.colOf(this.byId[targets[0].id].zone),
                         ids: [...members.map((m) => m.id), ...targets.map((t) => t.id)] });
        });

        this.links.forEach(([a, b, label, dir], i) => {
          const A = P[a], B = P[b];
          if (!A || !B) return;
          if (busOf[a + '>' + b] !== undefined) return;   // 這條由匯流排代畫
          const e = { i, key: a + '>' + b, a, b, label, both: dir === 'both', A, B };
          if (A.col !== B.col && A.step === B.step) {
            e.shape = 'row';
            e.right = B.x > A.x;
            // 同列水平線走側邊的口，按對方的高度排序（同列時只有一條，排序不影響）
            reg(a, e.right ? 'R' : 'L', B.y, i);
            reg(b, e.right ? 'L' : 'R', A.y, i);
          } else if (A.col === B.col) {
            const between = this.systems.some((s) => this.colOf(s.zone) === A.col
              && s.step > Math.min(A.step, B.step) && s.step < Math.max(A.step, B.step));
            e.down = B.step > A.step;
            if (!between) {
              e.shape = 'col';
              // 排序鍵必須與形狀 4 同一個尺度（見那裡的說明）：同一個出入口上兩種形狀混在一起，
              // 尺度不同的話小尺度那個永遠排最前，等於沒排序。實測「直接開單」與「存任務與知識」
              // 就是這樣打叉的——兩條都接在網頁工作台的下緣。
              reg(a, e.down ? 'B' : 'T', B.x * 100 - B.step, i);
              reg(b, e.down ? 'T' : 'B', A.x * 100 - A.step, i);
            } else {
              e.shape = 'loop';
              e.left = this.loopSide(A.col, A.step, B.step) === 'L';
              const sk = A.col + (e.left ? 'L' : 'R');
              sideTrack[sk] = (sideTrack[sk] || 0) + 1;
              e.track = sideTrack[sk] - 1;
              // 出發口用 -B.y 排序（目標越下面，出發口越上面）：外軌的線得先橫過內軌的
              // 垂直段，出發口若比內軌低，那一橫就正好打在內軌身上。實測「排隊派工」與
              // 「存附件與記錄」的交叉就是這樣來的。
              reg(a, e.left ? 'L' : 'R', -B.y, i);
              reg(b, e.left ? 'L' : 'R', A.y, i);
            }
          } else {
            e.shape = 'step';
            e.down = B.step > A.step;
            // key 取「間隙編號」而不是「來源列＋方向」：從第 3 列往下、與從第 4 列往上，
            // 走的是**同一條**走廊。分開記的話兩條線各自以為自己是第一條，疊成一條 226px 的
            // 粗線（實測 GitHub→AI 代理 與 AI 代理→VPN 就是這樣疊的）。
            // 目標區在來源與目標之間還有別的方塊 → 從最近的走廊橫過去會直接壓在它們身上。
            // 這種線改走「目標前一格」的走廊：先在**來源這一欄**多降幾格（來源欄下方是空的，
            // 見測試「被擋住的線，來源區下方要淨空」），到目標旁邊才橫過去。
            //
            // 一開始寫的是「繞目標區的側邊」，那條路兩邊都走不通：往右撞企業版原始碼進測試區的
            // 橫線，往左撞 VPN 出去接客戶的橫線，換邊只是把交叉搬個位置。改成在來源欄下降之後，
            // 這條線整段都不經過別人的走廊，交叉自然消失——**繞路要繞在自己家那側**。
            e.blocked = this.systems.some((s) => this.colOf(s.zone) === B.col
              && s.step > Math.min(A.step, B.step) && s.step < Math.max(A.step, B.step));
            // 走廊 key 取「間隙編號」而不是「來源列＋方向」：從第 3 列往下、與從第 4 列往上，
            // 走的是**同一條**走廊。分開記的話兩條線各自以為自己是第一條，疊成一條 226px 的
            // 粗線（實測 GitHub→AI 代理 與 AI 代理→VPN 就是這樣疊的）。
            const near = e.down ? A.step : A.step - 1;
            const far = e.down ? B.step - 1 : B.step;
            e.gap = String(e.blocked ? far : near);
            // 排序鍵用 B.x 主、B.step 次：兩條線去同一欄的不同列時（AI 代理同時接測試區與 VPN），
            // 只看 B.x 會分不出先後，誰佔到內側全憑陣列順序。走得比較遠的那條排外側，
            // 另一條橫出去時才不會從它的垂直段上壓過去。
            reg(a, e.down ? 'B' : 'T', B.x * 100 - B.step, i);
            // 進入端用 +A.step（與出發端的 -B.step 反向）：同一欄下來的兩條線，走廊在上面的那條
            // 會先轉彎、再直直降過另一條的走廊。它若排在內側，那一降就正好打在對方的橫段上。
            // 實測 核心原始碼→測試區（走廊在上）與 GitHub repo→測試區（走廊在下）就是這樣打叉的。
            reg(b, e.down ? 'T' : 'B', A.x * 100 + A.step, i);
          }
          plan.push(e);
        });

        // ── 分配列間走廊的軌道 ──
        // 側繞的線（形狀 4b）一律排到**最外側**那一軌：它的垂直段是從走廊往下延伸的，
        // 排在內側的話那一段會直接穿過同一條走廊上其他線的橫段。實測 AI 代理同時接
        // 測試區與 VPN 時就是這樣打叉的——兩條線本身都沒錯，錯在誰先佔到內軌。
        for (const e of plan.filter((x) => x.shape === 'step')) {
          gapTrack[e.gap] = gapTrack[e.gap] || { n: 0, list: [] };
          gapTrack[e.gap].list.push(e);
        }
        for (const g of Object.values(gapTrack)) {
          // 同一條走廊上，往下的線排在往上的線**前面**（＝軌道編號小＝走廊上緣）。
          // 走廊上下都有線要進來：往下的從上方進來、往上的從下方進來，各自貼近自己那一側就不會
          // 交錯；反過來排的話，兩條線的垂直段各自都要穿過對方的橫段。實測 核心原始碼→測試區
          // 與 GitHub repo→AI 開發代理 共用第 7 條走廊時就是這樣打叉的。
          g.list.sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0)
            || (a.down ? 0 : 1) - (b.down ? 0 : 1));
          g.list.forEach((e, n) => { e.track = n; });
        }

        // ── 匯流排主幹的軌道：排在繞行線**後面** ──
        // 繞行線要拿最內側那一軌：它的兩端各有一小段橫線接回自己的方塊，排在外側的話那兩小段
        // 會與主幹的成員短線疊在一起（兩者都在同一列的話 y 還會剛好相同，實測疊 18px）。
        for (const b of busPlan) {
          const sk = b.col + (b.goRight ? 'L' : 'R');
          sideTrack[sk] = (sideTrack[sk] || 0) + 1;
          const track = sideTrack[sk] - 1;
          // 目標都在同一欄，取第一個當基準即可
          const T0 = b.targets[0].P;
          b.trunkX = b.goRight ? T0.x - (36 + track * 14) : T0.x + T0.w + (36 + track * 14);
        }

        // ── 分配出入口位置 ──
        // 上下緣讓 34px、左右緣讓 16px：都要大於線寬與字高，否則畫面上就是一條粗線
        // ——而那不會有任何錯誤訊息。
        const off = {};
        for (const k of Object.keys(ports)) {
          const arr = ports[k].slice().sort((p, q) => p.by - q.by);
          const gap = (k.endsWith('L') || k.endsWith('R')) ? 16 : 34;
          arr.forEach((e, n) => { off[e.i + '@' + k] = (n - (arr.length - 1) / 2) * gap; });
        }
        const px = (i, id, side) => off[i + '@' + id + side] || 0;

        // ── 第二趟：算路徑 ──
        const out = [];
        for (const e of plan) {
          const { A, B, i } = e;
          const acx = A.x + A.w / 2, bcx = B.x + B.w / 2;
          const acy = A.y + A.h / 2, bcy = B.y + B.h / 2;
          let d, lx, ly, anchor = 'middle';

          if (e.shape === 'row') {
            // 形狀 1：同列不同區 → 水平直線
            const sa = e.right ? 'R' : 'L', sb = e.right ? 'L' : 'R';
            const y1 = acy + px(i, e.a, sa), y2 = bcy + px(i, e.b, sb);
            const x1 = e.right ? A.x + A.w : A.x;
            const x2 = e.right ? B.x : B.x + B.w;
            d = y1 === y2 ? `M ${x1} ${y1} H ${x2}`
              : `M ${x1} ${y1} H ${(x1 + x2) / 2} V ${y2} H ${x2}`;
            lx = (x1 + x2) / 2; ly = Math.min(y1, y2) - 8;
          } else if (e.shape === 'col') {
            // 形狀 2：同區相鄰列 → 垂直直線
            const ox = px(i, e.a, e.down ? 'B' : 'T');
            d = `M ${acx + ox} ${e.down ? A.y + A.h : A.y} V ${e.down ? B.y : B.y + B.h}`;
            lx = acx + ox + 8; ly = (Math.min(A.y + A.h, B.y + B.h) + Math.max(A.y, B.y)) / 2 + 4;
            anchor = 'start';
          } else if (e.shape === 'loop') {
            // 形狀 3：同區跨列 → 從側邊繞出去走區外走廊
            const side = e.left ? 'L' : 'R';
            const y1 = acy + px(i, e.a, side), y2 = bcy + px(i, e.b, side);
            // 36 而不是 26：繞行線要與容器框（比方塊寬 14）之間留得出空隙，26 只差 12px，
            // 看起來像貼著框線走。上限是欄距 92 減去隔壁分區外框的 20 ＝ 72，而同一條走廊上
            // 現在最多會有三條（一條繞行、兩條匯流排主幹），所以 36 起、每軌 14。
            const cx = e.left ? A.x - (36 + e.track * 14) : A.x + A.w + (36 + e.track * 14);
            d = `M ${e.left ? A.x : A.x + A.w} ${y1} H ${cx} V ${y2} H ${e.left ? B.x : B.x + B.w}`;
            lx = cx + (e.left ? -6 : 6); ly = (y1 + y2) / 2; anchor = e.left ? 'end' : 'start';
          } else {
            // 形狀 4：不同區不同列 → 垂直出、列間走廊橫走、垂直進。
            // 走廊取「離來源最近的那一道列間空隙」：離得越遠，橫線要跨過的區就越多。
            const base = e.down ? A.y + A.h : A.y;
            // 走廊 g 的中心 = 第 g 列的下緣再加半個間隙。用 gap 編號算而不是用「來源位置＋方向」，
            // 上行與下行的線才會落在同一條走廊上、共用同一組軌道。
            const gy = L.PAD_TOP + Number(e.gap) * L.STEP + L.H + (L.STEP - L.H) / 2 + e.track * 14;
            // 出發端的垂直短段也要跟著軌道錯開：同一欄相鄰兩列的兩個方塊，若都往它們之間的
            // 那條走廊出線（一個往下、一個往上），兩段短垂直線會落在同一個欄中心上疊成一條。
            // 橫段有軌道分開、垂直段沒有，所以只有這一小截疊著——實測 14px，肉眼是一條粗線。
            const ox = px(i, e.a, e.down ? 'B' : 'T') + e.track * 14;
            const ix = px(i, e.b, e.down ? 'T' : 'B');
            d = `M ${acx + ox} ${base} V ${gy} H ${bcx + ix} V ${e.down ? B.y : B.y + B.h}`;
            lx = (acx + ox + bcx + ix) / 2; ly = gy - 8;

          }

          out.push({ key: e.key, a: e.a, b: e.b, label: e.label, d, lx, ly, anchor, both: e.both });
        }

        // ── 匯流排的三段：成員短線 → 主幹 → 出線 ──
        // 拆成多個 <path> 而不是一條多段路徑：SVG 的箭頭只長在整條 path 的頭尾，多段的話
        // 三條成員線只會有一個箭頭。箭頭只放在「進目標」那一端；成員端只有雙向的才放
        // （單向的放了會變成「平台也會寫回去」，例如平台上直接開單根本沒有回寫）。
        for (const b of busPlan) {
          for (const m of b.members) {
            m.stubY = m.P.y + m.P.h / 2 + px(m.i, m.id, b.mSide);
            const x0 = b.goRight ? m.P.x + m.P.w : m.P.x;
            // 成員短線刻意**不掛** bus：hover 某一格時只打亮它自己那條短線＋主幹＋出線，
            // 其他成員的短線要跟著它們的方塊一起淡出，否則會出現「亮線接著暗方塊」。
            out.push({ key: 'bus' + b.bi + '>' + m.id, a: m.id, bus: b.targets.map((t) => t.id), label: '',
                       d: `M ${x0} ${m.stubY} H ${b.trunkX}`, arrowEnd: false, both: m.dir === 'both' });
          }
          for (const t of b.targets) {
            t.outY = t.P.y + t.P.h / 2 + px(t.i, t.id, b.tSide);
            const xt = b.goRight ? t.P.x : t.P.x + t.P.w;
            // 標籤置中在**整條走廊**（欄與欄之間），不是置中在出線上：出線只有 44px，字擺不下。
            // 這樣字會壓在主幹上，靠標籤本身那圈底色蓋掉（見 template）。走廊寬 92，所以匯流排的
            // 標籤要短——五、六個字，細節寫在方塊說明與圖下註腳裡。
            const mx = b.goRight ? b.members[0].P.x + b.members[0].P.w : b.members[0].P.x;
            out.push({ key: 'bus' + b.bi + '>out>' + t.id, a: null, b: t.id, bus: b.ids, label: t.label,
                       d: `M ${b.trunkX} ${t.outY} H ${xt}`,
                       lx: (mx + xt) / 2, ly: t.outY - 8, anchor: 'middle' });
          }

          // 主幹切成一段一段畫（接點與接點之間各一段），不是一整條。
          // 為的是 hover：指到「企業版原始碼」時，該亮的只有它自己走過的那幾段；整條一起亮的話，
          // 會亮出它根本沒走過的那一截，看圖的人會以為那些格子之間有關係。
          // 沒 hover 時各段接在一起，看起來仍是一條。
          const joins = [...b.members.map((m) => m.stubY), ...b.targets.map((t) => t.outY)];
          const ys = [...new Set(joins)].sort((m, n) => m - n);
          const covers = (y0, y1, a, z) => Math.min(a, z) <= y0 + 0.5 && Math.max(a, z) >= y1 - 0.5;
          for (let k = 0; k < ys.length - 1; k++) {
            const users = new Set();
            for (const m of b.members) for (const t of b.targets) {
              if (covers(ys[k], ys[k + 1], m.stubY, t.outY)) { users.add(m.id); users.add(t.id); }
            }
            out.push({ key: 'bus' + b.bi + '>trunk' + k, a: null, b: null, bus: [...users], label: '',
                       d: `M ${b.trunkX} ${ys[k]} V ${ys[k + 1]}`, arrowEnd: false });
          }
        }
        return out;
      },

      // hover 時要打亮的連線：與該系統直接相連的。
      activeLinks() {
        if (!this.current) return new Set();
        return new Set(this.routes
          .filter((r) => r.a === this.current || r.b === this.current || (r.bus || []).includes(this.current))
          .map((r) => r.key));
      },

      // 有標籤的那些線（匯流排的成員線與主幹沒有標籤，標籤只寫在出線上）
      routeLabels() { return this.routes.filter((r) => r.label); },

      // hover 時的鄰居（連同自己）——其餘方塊淡出。
      // 用 links 而不是 routes：誰跟誰相鄰是**事實**，與合不合併成匯流排無關。
      activeNodes() {
        if (!this.current) return null;
        const s = new Set([this.current]);
        for (const [a, b] of this.links) {
          if (a === this.current) s.add(b);
          if (b === this.current) s.add(a);
        }
        return s;
      },

      legend() { return AR_KINDS.map((k) => ({ k, color: AR_KIND_COLOR[k], text: AR_KIND_LEGEND[k] })); }
    },
    methods: {
      // 繞行要往哪一邊出去。繞行線會沿著該區的外側走一整段，那一側若正好有跨區的橫線進出，
      // 兩者必然打叉——所以判準是「哪一邊擋路的橫線少就往哪邊繞」。
      //
      // 必須**逐條**算，不能整區指定一個方向：四個容器併成一欄之後，同一欄就有兩條繞行線，
      // 而它們該走的邊剛好相反——網頁工作台→AI 開發代理 跨的那幾列，左邊被來源單據的線佔住；
      // AI 開發代理→VPN 通道 跨的那幾列，右邊被程式碼倉庫的線佔住。整區指定的話必有一條打叉。
      //
      // 「擋路」只算**嚴格夾在中間**那幾列的橫線：與端點同列的線是從這條繞行線的頭或尾接出去的，
      // 走的是同一個出入口分配（見 ports），不會與它打叉。
      loopSide(here, aStep, bStep) {
        const [lo, hi] = [aStep, bStep].sort((m, n) => m - n);
        let left = 0, right = 0;
        for (const [a, b] of this.links) {
          const A = this.byId[a], B = this.byId[b];
          if (!A || !B) continue;
          const ca = this.colOf(A.zone), cb = this.colOf(B.zone);
          const [mine, other, oc] = ca === here ? [A, B, cb] : cb === here ? [B, A, ca] : [];
          if (!mine || oc === here) continue;
          if (!(other.step > lo && other.step < hi) && !(mine.step > lo && mine.step < hi)) continue;
          if (oc < here) left++; else right++;
        }
        if (left !== right) return left < right ? 'L' : 'R';
        return here === 0 ? 'L' : 'R';
      },

      // 分區在第幾欄。沒寫 col 就照分區順序（舊寫法），寫了就照 col——兩個分區可以共用一欄。
      colOf(zoneId) {
        const i = this.zones.findIndex((z) => z.id === zoneId);
        const z = this.zones[i];
        return z && z.col !== undefined ? z.col : i;
      },

      // 吃參數，所以**必須**放在 methods：放進 computed 的話 Vue 會把它當計算屬性直接求值，
      // 呼叫端拿到的是求值結果而不是函式，症狀是 list.map is not a function ＋整頁白畫面。
      boxOf(list, padX, padTop, padBottom) {
        const L = this.layout;
        const xs = list.map((s) => L.pos[s.id].x), ys = list.map((s) => L.pos[s.id].y);
        return {
          x: Math.min(...xs) - padX, y: Math.min(...ys) - padTop,
          w: Math.max(...xs) - Math.min(...xs) + L.W + padX * 2,
          h: Math.max(...ys) - Math.min(...ys) + L.H + padTop + padBottom
        };
      },

      kindColor(s) { return AR_KIND_COLOR[s.kind] || 'var(--text-muted)'; },
      dim(id) { return this.activeNodes ? !this.activeNodes.has(id) : false; },
      linkDim(r) { return this.current ? !this.activeLinks.has(r.key) : false; }
    },
    template: `
      <div class="page-header">
        <div class="page-header-inner">
          <h1 class="page-title">系統地景圖</h1>
          <p style="color:var(--text-muted);font-size:var(--fs-sm);margin-top:var(--space-1)">
            這套體系會碰到哪些地方、彼此怎麼連。中間那一直排是公司主機，裡面四個虛線框各是一個 Docker 容器（彼此是兄弟關係，不是層層包住）；左邊那一欄是本來就存在、不是我們架的（上半是單子從哪來，下半是客戶現場），右邊是程式碼。
            滑鼠移到任一個方塊上會打亮它與相鄰的路徑，並在右側說明它是什麼。
            想看「一張任務會經過哪幾關」請改看<router-link to="/pipeline-flow">流程圖</router-link>。
          </p>
        </div>
      </div>

      <div class="page-body">
        <div class="flow-main-row">
          <div class="flow-diagram-panel">
            <div class="flow-mobile-hint">圖較寬，可左右捲動檢視；完整地景建議在桌機檢視</div>
            <svg :width="layout.w" :height="layout.h" :viewBox="'0 0 ' + layout.w + ' ' + layout.h"
                 style="display:block;max-width:none">
              <defs>
                <marker id="ar-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" />
                </marker>
              </defs>

              <!-- 三層框，由外而內畫：宿主機 → 容器 → 一般分區。
                   順序不能顛倒，後畫的會蓋住先畫的底色。 -->
              <!-- 宿主機只寫**標題**、不畫框：四個容器併成一欄之後，那個框就只是沿著這一欄外緣
                   再描一圈，與容器框幾乎重疊，反而讓人數不清邊界（三層框剩兩層更好讀）。 -->
              <g v-for="h in hostBoxes" :key="'host-' + h.id">
                <text :x="h.x" :y="h.y" fill="var(--text-muted)"
                      style="font-size:14px;font-weight:700;letter-spacing:.5px">🖥️ {{ h.label }}</text>
              </g>
              <g v-for="c in containerBoxes" :key="'ct-' + c.id">
                <rect :x="c.x" :y="c.y" :width="c.w" :height="c.h" rx="10"
                      fill="var(--card-bg)" stroke="var(--border)" stroke-width="1"
                      stroke-dasharray="5 3" opacity="0.9" />
                <text :x="c.x + 10" :y="c.y + 17" fill="var(--text-muted)"
                      style="font-size:11px;font-weight:600">🐳 {{ c.label }}</text>
              </g>
              <g v-for="z in zoneBoxes" :key="'zone-' + z.id">
                <rect :x="z.x" :y="z.y" :width="z.w" :height="z.h" rx="12"
                      fill="var(--surface)" stroke="var(--border)" stroke-width="1"
                      stroke-dasharray="4 4" opacity="0.75" />
                <text :x="z.x + 12" :y="z.y + 19" fill="var(--text-muted)"
                      style="font-size:12px;font-weight:600;letter-spacing:.5px">{{ z.label }}</text>
              </g>

              <!-- 連線。data-link 是給檢查用的：改完版面可逐條 diff，看出「修 A 卻連帶動到 B」 -->
              <g>
                <path v-for="r in routes" :key="r.key" :data-edge="r.key"
                      :d="r.d" fill="none" stroke="var(--text-muted)"
                      :stroke-width="activeLinks.has(r.key) ? 2.4 : 1.4"
                      :opacity="linkDim(r) ? 0.12 : (activeLinks.has(r.key) ? 1 : 0.5)"
                      :marker-end="r.arrowEnd === false ? null : 'url(#ar-arrow)'"
                      :marker-start="r.both ? 'url(#ar-arrow)' : null"
                      style="transition:opacity .15s, stroke-width .15s" />
                <!-- 標籤描一圈底色再填字（paint-order="stroke"）：欄距只有 92，同列橫線的標籤落在
                     正中央，而繞行線的走廊也在那附近——沒有這圈底色，線就從字中間穿過去。
                     底色取 --surface（面板與分區框的底色），容器框內是 --card-bg，兩者只差一階。 -->
                <text v-for="r in routeLabels" :key="'lb-' + r.key" :data-edge-label="r.key"
                      :x="r.lx" :y="r.ly" :text-anchor="r.anchor" fill="var(--text-muted)"
                      paint-order="stroke" stroke="var(--surface)" stroke-width="3" stroke-linejoin="round"
                      :opacity="linkDim(r) ? 0.12 : (activeLinks.has(r.key) ? 1 : 0.8)"
                      style="font-size:10px;pointer-events:none;transition:opacity .15s">{{ r.label }}</text>
              </g>

              <!-- 觸控裝置沒有 hover，說明全在移上去之後才出現：click 用**指定**而非切換
                   （行動瀏覽器點一下會先補一次 mouseenter，寫成 toggle 會當場又關掉）。 -->
              <g v-for="s in systems" :key="s.id"
                 @mouseenter="hovered = s.id" @mouseleave="hovered = null"
                 @click="hovered = s.id" @focus="focused = s.id" @blur="focused = null"
                 tabindex="0" role="button" :aria-label="s.label"
                 :opacity="dim(s.id) ? 0.25 : 1"
                 style="cursor:pointer;transition:opacity .15s">
                <rect :x="layout.pos[s.id].x" :y="layout.pos[s.id].y"
                      :width="layout.pos[s.id].w" :height="layout.pos[s.id].h" rx="8"
                      fill="var(--card-bg)" :stroke="kindColor(s)"
                      :stroke-width="current === s.id ? 2.8 : 1.4"
                      :style="{ transition: 'stroke-width .15s, filter .15s',
                                filter: current === s.id ? 'drop-shadow(0 0 6px ' + kindColor(s) + ')' : 'none' }" />
                <text :x="layout.pos[s.id].x + layout.pos[s.id].w / 2"
                      :y="layout.pos[s.id].y + 24" text-anchor="middle" fill="var(--text)"
                      style="font-size:13px;font-weight:600">{{ s.label }}</text>
                <text :x="layout.pos[s.id].x + layout.pos[s.id].w / 2"
                      :y="layout.pos[s.id].y + 41" text-anchor="middle" fill="var(--text-muted)"
                      style="font-size:10px">{{ s.sub }}</text>
              </g>
            </svg>

            <div class="flow-legend-bar">
              <span v-for="l in legend" :key="l.k" :style="{ color: l.color }">▢ {{ l.text }}</span>
            </div>

            <ul style="margin:var(--space-3) 0 0;padding-left:1.1em;color:var(--text-muted);font-size:var(--fs-sm);line-height:1.7">
              <li v-for="(n, i) in notes" :key="i">{{ n }}</li>
            </ul>
          </div>

          <div class="flow-side-panel">
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-3);min-height:220px">
              <template v-if="active">
                <h3 style="font-size:var(--fs-md);font-weight:var(--fw-semibold);margin-bottom:var(--space-1)">{{ active.label }}</h3>
                <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-bottom:var(--space-2)">{{ active.sub }}</div>
                <dl class="flow-detail-grid">
                  <template v-for="(row, i) in active.detail" :key="i">
                    <dt class="flow-detail-term">{{ row[0] }}</dt>
                    <dd style="margin:0;color:var(--text)">{{ row[1] }}</dd>
                  </template>
                </dl>
              </template>
              <div v-else style="color:var(--text-muted);font-size:var(--fs-sm)">
                把滑鼠移到任一個方塊上（觸控裝置請點一下），這裡會說明它是什麼、平台對它做什麼、以及刻意不做什麼。
              </div>
            </div>
          </div>
        </div>
      </div>
    `
  });
