// Pipeline 流程圖：把整條任務流程畫成圖，滑鼠移上去打亮該節點並帶出它的邏輯摘要。
//
// 開關是**頁面自帶的推演工具**，不讀也不寫任何專案設定——這頁的用途是「這樣設定會跑成怎樣」的
// 對焦與討論，不是某個專案的現況面板。要看某專案實際設定請去專案頁。
//
// 內容以程式碼為準（截至 2026-08-07）：狀態名對齊 status-labels.js，上限值對齊各關的常數
// （QA_LIMIT=5、DEPLOY_LIMIT=3、PW_LIMIT=3、MAX_REENTRY=2、QA_SPEC_LIMIT=2）。
// 改了那些常數或流程請一併更新這裡——這頁是拿來對焦的，講錯比沒有更糟。
window.PipelineFlowView = Vue.defineComponent({
  name: 'PipelineFlowView',
  data() {
    return {
      e2eEnabled: true,      // 專案層 e2e_disabled 的反面（新專案 INSERT 時預設停用 E2E）
      specTour: false,       // 專案層 spec_tour_enabled，預設 false
      hovered: null
    };
  },
  computed: {
    // 節點定義。deps 用來畫連線；每個節點的 detail 是「進入條件／做什麼／失敗往哪去」。
    nodes() {
      const n = [];
      const push = (o) => n.push(o);

      push({
        id: 'new', col: 0, row: 1, kind: 'start', label: '待分類',
        status: 'new',
        detail: [
          ['進入', '任務建立（手動、eService／Odoo 同步）'],
          ['做什麼', '判斷要不要先走客服分流'],
          ['往下', '需釐清 → 客服處理；否則直接進分析']
        ]
      });
      push({
        id: 'cs', col: 1, row: 0, kind: 'agent', label: '客服處理',
        status: 'cs_running', agent: 'cs',
        detail: [
          ['進入', '來源單需要先判斷問題性質'],
          ['做什麼', '自選來源（wiki／code／log／正式區 DB）查出初步定因'],
          ['往下', '判 code_change_clear → 分析（cs_findings 一併帶下去，標「待驗證」）'],
          ['分支', '需補資料 → 等待客戶回覆']
        ]
      });
      push({
        id: 'analysis', col: 2, row: 1, kind: 'agent', label: '分析',
        status: 'analysis_running', agent: 'analysis-project',
        detail: [
          ['進入', '待分類直接進，或客服判定需要改程式'],
          ['做什麼', '讀專案碼產出 analysis.yaml（含 acceptance 與 permissions）'],
          ['往下', 'determineNextStatus 三選一：夠有信心 → 建立分支；有問題要問 → 等待確認；要人看過 → 等待規格確認'],
          ['注意', '澄清答完會「完整重跑」這一關，不是接著上次跑']
        ]
      });
      push({
        id: 'confirm', col: 3, row: 0, kind: 'gate', label: '等待確認',
        status: 'confirm_pending',
        detail: [
          ['進入', '分析 agent 自己提了待答問題，或信心不足'],
          ['做什麼', '把問題丟給人回答'],
          ['往下', '答完 → 回分析關完整重跑（規格會整份重產）']
        ]
      });
      push({
        id: 'specreview', col: 3, row: 2, kind: 'gate', label: '等待規格確認',
        status: 'spec_review',
        detail: [
          ['進入', '規格需人工過目才開工'],
          ['做什麼', '人看規格：核准、或提修改意見'],
          ['往下', '核准 → 建立分支（**不重跑分析**）'],
          ['分支', '提意見 → spec-review agent 就地改 analysis.yaml，不重入分析關']
        ]
      });
      push({
        id: 'branch', col: 4, row: 1, kind: 'sys', label: '建立分支',
        status: 'branch_pending',
        detail: [
          ['進入', '規格已定稿（上面三條路的共同出口）'],
          ['做什麼', '每個 repo 建任務 worktree（切點 ai-dev）並跟上最新 ai-dev'],
          ['往下', '開發'],
          ['注意', '持專案鎖，與 merge／deploy／analysis 序列化']
        ]
      });

      if (this.specTour) {
        push({
          id: 'spectour', col: 5, row: 0, kind: 'agent', label: '先寫 E2E 考題', flagged: 'spec',
          status: 'spec_tour', agent: 'playwright-spec',
          detail: [
            ['進入', '規格 tour 模式開啟，且任務剛進入建立分支'],
            ['做什麼', '依定稿的 acceptance 先寫 Odoo tour（實作之前定稿），無狀態、不續接分析 session'],
            ['往下', '開發（worktree 內已有考題，coding 不得為了讓測試過而改測試檔）'],
            ['失敗', 'best-effort：產不出來不擋推進，但會在時間軸留下原因，E2E 關屆時自行產生']
          ]
        });
      }

      push({
        id: 'coding', col: 6, row: 1, kind: 'agent', label: '開發',
        status: 'coding_running', agent: 'coding-project',
        detail: [
          ['進入', '分支建好，或被 QA／部署／E2E／分診退回'],
          ['做什麼', '無狀態：每輪 fresh 重送規格，讀 worktree 既有碼做增量修'],
          ['往下', 'QA 審查'],
          ['守衛', '帶著失敗回饋卻一個 commit 都沒產生 → 直接停下（放行只會重現同一個失敗）'],
          this.specTour
            ? ['本模式', 'worktree 內已有 tour＝驗收標準；考題寫錯要指出，不得逕自改測試檔']
            : ['注意', 'retry_feedback（上一輪失敗訊息）會餵進 prompt，推進成功才消費']
        ]
      });
      push({
        id: 'qa', col: 7, row: 1, kind: 'agent', label: 'QA 審查',
        status: 'qa_running', agent: 'qa',
        detail: [
          ['進入', '開發完成'],
          ['做什麼', '對照 analysis.yaml 審查 diff（基底是 ai-dev，不是 main）'],
          ['往下', 'pass → 併入測試；整組計數器歸零並寫下未解清單的分界'],
          ['失敗', 'fail → 退開發，qa_retry_count+1，滿 5 次停下'],
          ['分支', '判規格歧義 → 走裁決閘門問人（最多 2 輪）'],
          ['熔斷', '自上輪 QA 後分支沒有新 commit → 判僵局，停下交人工']
        ]
      });
      push({
        id: 'merge', col: 8, row: 1, kind: 'sys', label: '併入測試',
        status: 'merge_running',
        detail: [
          ['進入', 'QA 通過'],
          ['做什麼', '把任務分支併進 testing（測試區 addons 來源）'],
          ['往下', '部署測試區'],
          ['分支', '撞衝突 → 合併衝突（全程停在該狀態，不退回重做）']
        ]
      });
      push({
        id: 'conflict', col: 8, row: 0, kind: 'gate', label: '合併衝突',
        status: 'merge_conflict',
        detail: [
          ['進入', '併入 testing 時兩段碼撞同幾行'],
          ['做什麼', 'merge → merge-explain → merge-clarify 三支各司其職，人做最後裁決'],
          ['往下', '解完續行；退回重做不會消除衝突，所以流程不分叉']
        ]
      });
      push({
        id: 'deploy', col: 9, row: 1, kind: 'sys', label: '部署測試區',
        status: 'deploy_testing',
        detail: [
          ['進入', '已併入 testing'],
          ['做什麼', '在測試區安裝／升級模組——語法錯、invalid field、view 繼承錯、缺 depends 都在這裡把關'],
          ['往下', this.e2eEnabled ? 'E2E 測試' : '等待審核（E2E 已停用）'],
          ['失敗', '判 code → 退開發，deploy_retry_count+1，滿 3 次停下；判 env → 直接停下不退開發'],
          ['診斷', 'asset 編不出來時附上容器 log 尾端的真 traceback 給開發關']
        ]
      });

      if (this.e2eEnabled) {
        push({
          id: 'e2e', col: 10, row: 1, kind: 'agent', label: 'E2E 測試',
          status: 'playwright_running', agent: this.specTour ? '（不產生，只執行）' : 'playwright',
          detail: [
            ['進入', '部署成功，且專案未停用 E2E'],
            ['做什麼', this.specTour
              ? '不重產 tour（重產等於照著完成的實作重寫考題），併入 testing 後直接跑 odoo-bin --test-enable'
              : '產生 tour 測試檔 → 併入 testing → 跑 odoo-bin --test-enable'],
            ['往下', '通過 → 等待審核'],
            ['失敗', '退開發，pw_retry_count+1，滿 3 次停下'],
            ['防假綠燈', 'log 內沒有 odoo.tests 命名空間＝匹配 0 個測試，一律當失敗'],
            this.specTour
              ? ['守衛', '模式開著但 worktree 內查無 tour 檔 → 降級由本關自行產生，並在時間軸留下原因']
              : ['注意', 'tour 是照著已完成的實作寫的，測試容易遷就實作']
          ]
        });
      }

      push({
        id: 'review', col: 11, row: 1, kind: 'gate', label: '等待審核',
        status: 'review_pending',
        detail: [
          ['進入', 'E2E 通過，或 E2E 已停用時部署成功即到'],
          ['做什麼', '人工驗收「有沒有做到真正想要的事」——這是驗真意的最終防線'],
          ['往下', '核准 → 更新 Wiki → 完成'],
          ['分支', '退回 → 分診']
        ]
      });
      push({
        id: 'triage', col: 11, row: 2, kind: 'agent', label: '分診',
        status: 'reject_triage', agent: 'analysis-reject',
        detail: [
          ['進入', '人工退回，或任務卡住需要判斷下一步'],
          ['做什麼', '把退回原因拆成獨立錯誤項並分類，決定往哪走'],
          ['往下', 'fix → 開發（帶著分診結論）／resume → 回原關／advance → 放行推進／respec → 規格層重做'],
          ['注意', '這一關刻意不吃彈跳額度——每一輪都是人主動退回換來的，帶著新資訊']
        ]
      });
      push({
        id: 'respec', col: 9, row: 2, kind: 'agent', label: '規格層重做',
        status: 'respec_running', agent: 'respec-patch',
        detail: [
          ['進入', '途中追加需求，或分診判定要動規格'],
          ['做什麼', '增量 patch 進 analysis.yaml（不重讀整包碼），維持單一規格來源'],
          ['往下', '開發（需求同時寫進 retry_feedback，coding 每輪都讀）']
        ]
      });
      push({
        id: 'wiki', col: 12, row: 1, kind: 'agent', label: '更新 Wiki',
        status: 'wiki_updating', agent: 'library',
        detail: [
          ['進入', '人工審核核准'],
          ['做什麼', '產出／更新功能頁，必要時往上補模組頁與總覽'],
          ['往下', '完成']
        ]
      });
      push({
        id: 'done', col: 13, row: 1, kind: 'end', label: '完成',
        status: 'done',
        detail: [['進入', 'Wiki 更新完畢'], ['做什麼', '任務結案，成果留在 ai-dev 等待「上正式」']]
      });
      push({
        id: 'stopped', col: 7, row: 2, kind: 'stop', label: '失敗待確認',
        status: 'stopped',
        detail: [
          ['進入', '任一關觸頂、環境錯誤、或 agent 沒吐出有效結果'],
          ['做什麼', '停下等人工，blocker_content 說明原因'],
          ['往下', '人工填修正指示 → 分診決定下一步'],
          ['彈跳上限', '跨關總彈跳 MAX_REENTRY=2，跌倒即停不硬撐']
        ]
      });
      return n;
    },
    // 連線：[from, to, 類型]。dashed＝失敗／退回路徑。
    edges() {
      const e = [
        ['new', 'cs', 'alt'], ['new', 'analysis', 'main'], ['cs', 'analysis', 'main'],
        ['analysis', 'confirm', 'alt'], ['analysis', 'specreview', 'alt'], ['analysis', 'branch', 'main'],
        ['confirm', 'analysis', 'back'], ['specreview', 'branch', 'main'],
        ['coding', 'qa', 'main'], ['qa', 'merge', 'main'], ['qa', 'coding', 'back'],
        ['merge', 'deploy', 'main'], ['merge', 'conflict', 'alt'],
        ['deploy', 'coding', 'back'], ['deploy', 'stopped', 'back'],
        ['qa', 'stopped', 'back'],
        ['review', 'triage', 'back'], ['triage', 'coding', 'back'], ['triage', 'respec', 'back'],
        ['respec', 'coding', 'main'], ['review', 'wiki', 'main'], ['wiki', 'done', 'main']
      ];
      if (this.specTour) { e.push(['branch', 'spectour', 'main'], ['spectour', 'coding', 'main']); }
      else { e.push(['branch', 'coding', 'main']); }
      if (this.e2eEnabled) { e.push(['deploy', 'e2e', 'main'], ['e2e', 'review', 'main'], ['e2e', 'coding', 'back']); }
      else { e.push(['deploy', 'review', 'main']); }
      return e;
    },
    nodeById() { return Object.fromEntries(this.nodes.map(n => [n.id, n])); },
    // 版面：欄距／列距固定，SVG 尺寸由最大座標推導
    layout() {
      const CW = 138, CH = 130, PAD = 20, W = 118, H = 62;
      const pos = {};
      for (const n of this.nodes) pos[n.id] = { x: PAD + n.col * CW, y: PAD + n.row * CH, w: W, h: H };
      const maxCol = Math.max(...this.nodes.map(n => n.col));
      const maxRow = Math.max(...this.nodes.map(n => n.row));
      // 底部要多留 DIP_ROOM：退回線走「繞到節點下方再折回」，最後一列的繞行高度會超出最後一列的
      // 底緣，不留的話那幾條線會被裁掉，畫面上看到的是一條斷在半空中的線。
      const DIP_ROOM = 46;
      return { pos, w: PAD * 2 + maxCol * CW + W, h: PAD * 2 + maxRow * CH + H + DIP_ROOM, W, H };
    },
    // 目前 hover 的節點（含其相鄰邊，供打亮用）
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
    // 連線路徑：同列走直線，跨列走圓角折線（先水平到中點、再垂直、再水平）
    edgePath(from, to) {
      const p = this.layout.pos, a = p[from], b = p[to];
      if (!a || !b) return '';
      const ax = a.x + a.w, ay = a.y + a.h / 2;
      const bx = b.x, by = b.y + b.h / 2;
      if (Math.abs(ay - by) < 1) {
        // 反向（退回）走下方繞行，避免與正向線重疊看不出方向
        if (bx < ax) {
          const dip = Math.max(a.y, b.y) + a.h + 26;
          return `M ${a.x + a.w / 2} ${a.y + a.h} V ${dip} H ${b.x + b.w / 2} V ${b.y + b.h}`;
        }
        return `M ${ax} ${ay} H ${bx}`;
      }
      const mid = bx > ax ? (ax + bx) / 2 : a.x + a.w / 2;
      if (bx > ax) return `M ${ax} ${ay} H ${mid} V ${by} H ${bx}`;
      const dip = Math.max(a.y, b.y) + a.h + 26;
      return `M ${a.x + a.w / 2} ${a.y + a.h} V ${dip} H ${b.x + b.w / 2} V ${b.y + b.h}`;
    },
    dim(id) { return this.hovered && id !== this.hovered && !this.activeNeighbours.has(id); },
    edgeDim(a, b) { return this.hovered && !this.activeEdges.has(a + '>' + b); }
  },
  template: `
    <div class="page">
      <div class="page-header">
        <h1 class="page-title">Pipeline 流程圖</h1>
        <p style="color:var(--text-muted);font-size:var(--fs-sm);margin-top:var(--space-1)">
          滑鼠移到節點上會打亮它與相鄰的路徑，並在右側顯示這一關的邏輯。
          下方開關是<strong>推演用</strong>——只改這張圖，不會動到任何專案的設定。
        </p>
      </div>

      <div style="display:flex;gap:var(--space-4);flex-wrap:wrap;align-items:center;margin-bottom:var(--space-3)">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none">
          <div class="switch">
            <input type="checkbox" v-model="e2eEnabled" />
            <div class="switch-track"></div>
            <div class="switch-knob"></div>
          </div>
          <span style="font-size:var(--fs-md);color:var(--text)">E2E 測試{{ e2eEnabled ? '啟用' : '停用' }}</span>
        </label>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none">
          <div class="switch">
            <input type="checkbox" v-model="specTour" />
            <div class="switch-track"></div>
            <div class="switch-knob"></div>
          </div>
          <span style="font-size:var(--fs-md);color:var(--text)">依規格先寫測試{{ specTour ? '（啟用）' : '（停用）' }}</span>
        </label>
        <span style="font-size:var(--fs-sm);color:var(--text-muted)">
          兩個開關對應專案設定的 <code>e2e_disabled</code> 與 <code>spec_tour_enabled</code>。
        </span>
      </div>

      <div style="display:flex;gap:var(--space-4);align-items:flex-start;flex-wrap:wrap">
        <div style="flex:1 1 620px;min-width:0;overflow-x:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-2)">
          <svg :width="layout.w" :height="layout.h" :viewBox="'0 0 ' + layout.w + ' ' + layout.h"
               style="display:block;max-width:none">
            <defs>
              <marker id="pf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" />
              </marker>
            </defs>
            <g>
              <path v-for="[a,b,kind] in edges" :key="a+'>'+b"
                    :d="edgePath(a,b)" fill="none"
                    :stroke="kind === 'back' ? 'var(--danger)' : 'var(--text-muted)'"
                    :stroke-width="activeEdges.has(a+'>'+b) ? 2.5 : 1.4"
                    :stroke-dasharray="kind === 'main' ? '' : '5 4'"
                    :opacity="edgeDim(a,b) ? 0.15 : (activeEdges.has(a+'>'+b) ? 1 : 0.55)"
                    marker-end="url(#pf-arrow)" style="transition:opacity .15s, stroke-width .15s" />
            </g>
            <g v-for="n in nodes" :key="n.id"
               @mouseenter="hovered = n.id" @mouseleave="hovered = null"
               :opacity="dim(n.id) ? 0.28 : 1"
               style="cursor:pointer;transition:opacity .15s">
              <rect :x="layout.pos[n.id].x" :y="layout.pos[n.id].y"
                    :width="layout.pos[n.id].w" :height="layout.pos[n.id].h" rx="8"
                    :fill="hovered === n.id ? 'var(--primary-light)' : 'var(--card-bg)'"
                    :stroke="hovered === n.id ? 'var(--primary)' : (n.kind === 'stop' ? 'var(--danger)' : 'var(--border-strong)')"
                    :stroke-width="hovered === n.id ? 2.5 : 1.2"
                    style="transition:fill .15s, stroke .15s" />
              <text :x="layout.pos[n.id].x + layout.pos[n.id].w/2" :y="layout.pos[n.id].y + 26"
                    text-anchor="middle" fill="var(--text)"
                    style="font-size:13px;font-weight:600">{{ n.label }}</text>
              <text :x="layout.pos[n.id].x + layout.pos[n.id].w/2" :y="layout.pos[n.id].y + 44"
                    text-anchor="middle" fill="var(--text-muted)"
                    style="font-size:10px;font-family:var(--font-mono, monospace)">{{ n.status }}</text>
              <text v-if="n.flagged" :x="layout.pos[n.id].x + layout.pos[n.id].w - 8" :y="layout.pos[n.id].y + 14"
                    text-anchor="end" fill="var(--primary)" style="font-size:10px">先出考題</text>
            </g>
          </svg>
          <div style="display:flex;gap:var(--space-3);flex-wrap:wrap;margin-top:var(--space-2);font-size:var(--fs-xs);color:var(--text-muted)">
            <span>—— 主線</span>
            <span>- - - 分支／條件</span>
            <span style="color:var(--danger)">- - - 退回／失敗</span>
          </div>
        </div>

        <div style="flex:0 1 340px;min-width:280px;position:sticky;top:var(--space-3)">
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-3);min-height:220px">
            <template v-if="active">
              <h3 style="font-size:var(--fs-md);font-weight:var(--fw-semibold);margin-bottom:var(--space-1)">{{ active.label }}</h3>
              <div style="font-size:var(--fs-xs);color:var(--text-muted);font-family:var(--font-mono, monospace);margin-bottom:var(--space-2)">
                {{ active.status }}<template v-if="active.agent"> · agent: {{ active.agent }}</template>
              </div>
              <dl style="margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px var(--space-2);font-size:var(--fs-sm)">
                <template v-for="(row, i) in active.detail.filter(Boolean)" :key="i">
                  <dt style="color:var(--text-muted);white-space:nowrap">{{ row[0] }}</dt>
                  <dd style="margin:0;color:var(--text)">{{ row[1] }}</dd>
                </template>
              </dl>
            </template>
            <div v-else style="color:var(--text-muted);font-size:var(--fs-sm)">
              把滑鼠移到左邊任一個節點上，這裡會顯示那一關的進入條件、做什麼、成功與失敗各往哪走。
            </div>
          </div>
        </div>
      </div>
    </div>
  `
});
