window.TokenReportView = Vue.defineComponent({
  name: 'TokenReportView',
  data() {
    return {
      loading: false,
      report: null,
      projects: [],
      filters: {
        range: '30',     // '7' | '30' | 'custom'
        start: '',
        end: '',
        project_id: '',
        task_id: ''
      },
      expandedTasks: {},
      labels: {},
      chartW: 800,
      chartH: 200,
      zoom: null,      // { title, slices } — 圓餅放大 modal
      hoverIdx: null   // modal 內滑鼠指到的扇形 index
    };
  },
  computed: {
    // 折線圖幾何：依量測到的 chartW 自適應填滿整列
    chartData() {
      const daily = this.report?.daily;
      if (!daily || daily.length < 2) return null;
      // 左側留 48px 給 y 軸數量刻度
      const left = 48, w = this.chartW, top = 16, bottom = this.chartH - 28, n = daily.length;
      // 首點離 y 軸再內縮 16px，避免第一個 x 軸標籤壓在 y 軸 0 刻度上
      const plotLeft = left + 16, plotRight = w - 24;
      const maxV = Math.max(...daily.map(d => d.tokens), 1);
      const dots = daily.map((d, i) => ({
        x: plotLeft + (i / (n - 1)) * (plotRight - plotLeft),
        y: bottom - (d.tokens / maxV) * (bottom - top),
        date: d.date,
        tokens: d.tokens
      }));
      const step = Math.max(1, Math.ceil(n / 10));
      const labels = dots.filter((_, i) => i % step === 0 || i === n - 1)
                         .map(p => ({ x: p.x, label: this.fmtMD(p.date) }));
      // y 軸刻度（0 到 maxV 均分 4 段），含格線位置
      const TICKS = 4;
      const yTicks = [];
      for (let i = 0; i <= TICKS; i++) {
        const v = (maxV / TICKS) * i;
        yTicks.push({ y: bottom - (v / maxV) * (bottom - top), label: this.fmtShort(Math.round(v)) });
      }
      return { points: dots.map(p => `${p.x},${p.y}`).join(' '), dots, labels, yTicks, left, right: plotRight };
    },
    dateRange() {
      const now = new Date();
      const end = now.toISOString().slice(0, 10);
      if (this.filters.range === '7') {
        const s = new Date(now); s.setDate(s.getDate() - 7);
        return { start: s.toISOString().slice(0, 10), end };
      }
      if (this.filters.range === '30') {
        const s = new Date(now); s.setDate(s.getDate() - 30);
        return { start: s.toISOString().slice(0, 10), end };
      }
      return { start: this.filters.start, end: this.filters.end };
    },
    // 明細表最多顯示前 100 筆，其餘靠容器垂直捲動不再往下撐高頁面
    visibleTasks() {
      return (this.report?.tasks || []).slice(0, 100);
    },
    // 三張圓餅的扇形（含 frac 百分比）：小圖與放大 modal 共用同一份，顏色不重覆
    agentSlices() {
      if (!this.report) return [];
      return this.piePath(this.report.by_agent.map(r => ({ value: r.tokens, color: this.agentColor(r.agent_type), label: this.agentLabel(r.agent_type) })));
    },
    projectSlices() {
      if (!this.report) return [];
      return this.piePath(this.report.by_project.map((r, i) => ({ value: r.tokens, color: this.catColor(i), label: r.project_name })));
    },
    userSlices() {
      if (!this.report) return [];
      return this.piePath(this.report.by_user.map((r, i) => ({ value: r.tokens, color: this.catColor(i), label: r.username })));
    }
  },
  async created() {
    this.projects = await Api.get('projects').catch(() => []);
    this.labels = await Api.get('agents/labels').catch(() => ({}));
    await this.load();
  },
  methods: {
    agentLabel(type) { return this.labels[type] || type; },
    // 明細列顯示名稱
    taskLabel(t) {
      if (t.kind === 'chat') {
        const name = t.deleted ? '(已刪除)' : (t.title || '(舊對話)');
        return `chat > ${name}`;
      }
      if (t.kind === 'task') {
        if (t.title) return t.title;
        if (t.deleted) return '(已刪除任務)';
        return t.task_id || '（無標題）';
      }
      // wiki／workflow_health 等專案層級記錄：kind 即 agent stage，套中文對照表
      // 無所屬專案（如 workflow_health）不加「— >」前綴，直接顯示名稱
      const label = this.agentLabel(t.kind);
      return t.project_name ? `${t.project_name} > ${label}` : label;
    },
    // 可連結時回傳路由：task → 任務頁、chat → 對話頁；已刪除或無 id 則回 null（不連結）
    taskLink(t) {
      if (!t.linkable) return null;
      if (t.kind === 'task' && t.task_row_id != null) return `/task/${t.task_row_id}`;
      if (t.kind === 'chat' && t.chat_id != null) return `/projects/${t.project_id}/chat/${t.chat_id}`;
      return null;
    },
    async load() {
      this.loading = true;
      try {
        const p = new URLSearchParams();
        const { start, end } = this.dateRange;
        if (start) p.set('start', start);
        if (end)   p.set('end', end);
        if (this.filters.project_id) p.set('project_id', this.filters.project_id);
        if (this.filters.task_id)    p.set('task_id', this.filters.task_id);
        this.report = await Api.get(`token-report?${p.toString()}`);
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
      // loading=false 後 trendBox 才會 render，此時才量得到正確容器尺寸
      await this.$nextTick();
      this.measureChart();
      this.observeChart();
    },
    fmtNum(n) { return Number(n || 0).toLocaleString(); },
    // USD 金額：大額用 K、$1 以上兩位、小額多留精度（cent 以下對話成本也看得到）
    fmtUSD(n) {
      n = Number(n || 0);
      if (n >= 1000) return '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
      if (n >= 1)    return '$' + n.toFixed(2);
      if (n >= 0.01) return '$' + n.toFixed(3);
      if (n > 0)     return '$' + n.toFixed(5);
      return '$0';
    },
    fmtShort(n) {
      n = Number(n || 0);
      if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
      return String(Math.round(n));
    },
    toggleTask(key) {
      this.expandedTasks[key] = !this.expandedTasks[key];
    },
    // agent 語意固定色：全報表（圓餅／表格／展開列）一致；改為相鄰易辨的十色，去掉原本紫紫、橘橘撞色
    agentColor(type) {
      const map = { analysis: '#2a78d6', coding: '#1baf7a', qa: '#eda100', cs: '#4a3aa7',
                    merge: '#e87ba4', deploy_fix: '#e34948', wiki: '#0891b2', chat: '#eb6834',
                    triage: '#6b7280', workflow_health: '#008300' };
      return map[type] || '#94a3b8';
    },
    // 專案／使用者圓餅：依序取 20 色類別盤（隨主題切換深淺）；超過 20 筆才用黃金角補色，仍保持可辨
    catColor(i) {
      return i < 20 ? `var(--cat-${i + 1})` : `hsl(${Math.round((i * 137.508) % 360)}, 65%, 55%)`;
    },
    openZoom(title, slices) {
      if (!slices || !slices.length) return;
      this.hoverIdx = null;
      this.zoom = { title, slices };
    },
    // SVG pie chart
    piePath(slices) {
      const total = slices.reduce((s, r) => s + r.value, 0);
      if (!total) return [];
      let angle = -Math.PI / 2;
      const r = 70, cx = 90, cy = 90;
      return slices.map(s => {
        const frac = s.value / total;
        const a0 = angle;
        angle += frac * 2 * Math.PI;
        const a1 = angle;
        // 單一資料＝整圓：起訖點重合會讓 A 弧退化成畫不出來（畫面空白）→ 改用上下兩段半弧填滿整圓
        if (frac >= 1) {
          return { ...s, frac, d: `M${cx - r},${cy} A${r},${r},0,1,1,${cx + r},${cy} A${r},${r},0,1,1,${cx - r},${cy}Z` };
        }
        const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
        const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
        const large = frac > 0.5 ? 1 : 0;
        return { ...s, frac, d: `M${cx},${cy} L${x0},${y0} A${r},${r},0,${large},1,${x1},${y1}Z` };
      });
    },
    // date 可能是 Date 物件（pg）或 'YYYY-MM-DD' 字串（pg-mem）→ 統一輸出本地 MM-DD
    fmtMD(v) {
      const dt = (v instanceof Date) ? v : new Date(String(v) + 'T00:00:00');
      if (isNaN(dt.getTime())) return String(v).slice(5, 10);
      return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    },
    // 量測繪圖區 wrapper 的寬高，讓 SVG（絕對定位）填滿它
    // wrapper 高度由 grid stretch 決定、不受 SVG 影響，故量測穩定不會回饋循環
    measureChart() {
      const el = this.$refs.trendBox;
      if (el) {
        this.chartW = Math.max(320, el.clientWidth);
        this.chartH = Math.max(180, el.clientHeight);
      }
    },
    // 用 ResizeObserver 在容器最終 layout 定型後才量測，避免 nextTick 量到中間態導致寬度不滿版
    observeChart() {
      const el = this.$refs.trendBox;
      if (!el || this._ro) return;
      this._ro = new ResizeObserver(() => this.measureChart());
      this._ro.observe(el);
    }
  },
  mounted() {
    this.measureChart();
    window.addEventListener('resize', this.measureChart);
  },
  beforeUnmount() {
    window.removeEventListener('resize', this.measureChart);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
  },
  template: `
    <div class="topbar"><h1>用量報表</h1></div>
    <div class="content">

      <!-- 篩選列 -->
      <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;margin-bottom:var(--space-4);align-items:center">
        <select v-model="filters.range" class="form-control" style="width:100px;font-size:var(--fs-base);height:32px;padding:var(--space-1) var(--space-2)">
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
          <option value="custom">自訂</option>
        </select>
        <template v-if="filters.range==='custom'">
          <input v-model="filters.start" type="date" class="form-control" style="width:140px;font-size:var(--fs-base);height:32px;padding:var(--space-1) var(--space-2)" />
          <span style="font-size:var(--fs-base);color:var(--text-muted)">至</span>
          <input v-model="filters.end" type="date" class="form-control" style="width:140px;font-size:var(--fs-base);height:32px;padding:var(--space-1) var(--space-2)" />
        </template>
        <select v-model="filters.project_id" class="form-control" style="width:160px;font-size:var(--fs-base);height:32px;padding:var(--space-1) var(--space-2)">
          <option value="">全部專案</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <input v-model="filters.task_id" placeholder="任務 ID" class="form-control"
          style="width:160px;font-size:var(--fs-base);height:32px;padding:var(--space-1) var(--space-2)" />
        <button class="btn btn-primary btn-sm" @click="load" :disabled="loading">
          {{ loading ? '查詢中...' : '查詢' }}
        </button>
      </div>

      <div v-if="loading" class="loading">載入中...</div>
      <template v-else-if="report">

        <!-- 摘要卡片 -->
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:var(--space-3);margin-bottom:var(--space-5)">
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-4);text-align:center">
            <div style="font-size:24px;font-weight:var(--fw-bold);color:var(--primary)" :title="fmtNum(report.summary.total_tokens)">{{ fmtShort(report.summary.total_tokens) }}</div>
            <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:var(--space-1)">總 Token 數</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-4);text-align:center">
            <div style="font-size:24px;font-weight:var(--fw-bold);color:var(--text-muted)" :title="fmtNum(report.summary.cache_tokens)">{{ fmtShort(report.summary.cache_tokens) }}</div>
            <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:var(--space-1)">Cache 總數</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-4);text-align:center">
            <div style="font-size:24px;font-weight:var(--fw-bold);color:var(--success)">{{ fmtNum(report.summary.total_tasks) }}</div>
            <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:var(--space-1)">任務數</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-4);text-align:center">
            <div style="font-size:24px;font-weight:var(--fw-bold);color:var(--primary)" :title="fmtNum(report.summary.actual_tokens)">{{ fmtShort(report.summary.actual_tokens) }}</div>
            <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:var(--space-1)">實際 Token 數</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-4);text-align:center">
            <div style="font-size:24px;font-weight:var(--fw-bold);color:var(--warning)" :title="fmtNum(report.summary.avg_tokens_per_task)">{{ fmtShort(report.summary.avg_tokens_per_task) }}</div>
            <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:var(--space-1)">平均每任務</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-4);text-align:center">
            <div style="font-size:24px;font-weight:var(--fw-bold);color:var(--info)" :title="'$'+Number(report.summary.cost_usd||0).toFixed(6)">{{ fmtUSD(report.summary.cost_usd) }}</div>
            <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:var(--space-1)">實際花費</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-4);text-align:center">
            <div style="font-size:24px;font-weight:var(--fw-bold);color:var(--warning)" :title="'$'+Number(report.summary.avg_cost_per_task||0).toFixed(6)">{{ fmtUSD(report.summary.avg_cost_per_task) }}</div>
            <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:var(--space-1)">平均每任務</div>
          </div>
        </div>

        <!-- 圖表區 -->
        <div style="display:grid;grid-template-columns:180px 180px 180px 1fr;gap:var(--space-4);margin-bottom:var(--space-5)">

          <!-- Agent 圓餅圖 -->
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);cursor:zoom-in" @click="openZoom('Agent 類型', agentSlices)">
            <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);margin-bottom:var(--space-2);color:var(--text-secondary)">Agent 類型 <span style="font-weight:var(--fw-normal);color:var(--text-muted);font-size:var(--fs-2xs)">（點擊放大）</span></div>
            <svg viewBox="0 0 180 180" width="154" height="154" v-if="agentSlices.length">
              <path v-for="s in agentSlices"
                :key="s.label" :d="s.d" :style="{fill:s.color}" opacity="0.9">
                <title>{{ s.label }}: {{ fmtNum(s.value) }}（{{ (s.frac*100).toFixed(1) }}%）</title>
              </path>
            </svg>
            <div v-for="r in report.by_agent" :key="r.agent_type"
              style="display:flex;align-items:center;gap:6px;font-size:var(--fs-xs);margin-top:var(--space-1)">
              <span :style="{width:'10px',height:'10px',borderRadius:'50%',background:agentColor(r.agent_type),display:'inline-block'}"></span>
              {{ agentLabel(r.agent_type) }}: {{ fmtShort(r.tokens) }}
            </div>
          </div>

          <!-- 專案圓餅圖 -->
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);cursor:zoom-in" @click="openZoom('專案分布', projectSlices)">
            <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);margin-bottom:var(--space-2);color:var(--text-secondary)">專案分布 <span style="font-weight:var(--fw-normal);color:var(--text-muted);font-size:var(--fs-2xs)">（點擊放大）</span></div>
            <svg viewBox="0 0 180 180" width="154" height="154" v-if="projectSlices.length">
              <path v-for="s in projectSlices"
                :key="s.label" :d="s.d" :style="{fill:s.color}" opacity="0.9">
                <title>{{ s.label }}: {{ fmtNum(s.value) }}（{{ (s.frac*100).toFixed(1) }}%）</title>
              </path>
            </svg>
            <div v-for="(r,i) in report.by_project" :key="r.project_id"
              style="display:flex;align-items:center;gap:6px;font-size:var(--fs-xs);margin-top:var(--space-1)">
              <span :style="{width:'10px',height:'10px',borderRadius:'50%',background:catColor(i),display:'inline-block'}"></span>
              {{ r.project_name }}: {{ fmtShort(r.tokens) }}
            </div>
          </div>

          <!-- 使用者圓餅圖 -->
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);cursor:zoom-in" @click="openZoom('使用者分布', userSlices)">
            <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);margin-bottom:var(--space-2);color:var(--text-secondary)">使用者分布 <span style="font-weight:var(--fw-normal);color:var(--text-muted);font-size:var(--fs-2xs)">（點擊放大）</span></div>
            <svg viewBox="0 0 180 180" width="154" height="154" v-if="userSlices.length">
              <path v-for="s in userSlices"
                :key="s.label" :d="s.d" :style="{fill:s.color}" opacity="0.9">
                <title>{{ s.label }}: {{ fmtNum(s.value) }}（{{ (s.frac*100).toFixed(1) }}%）</title>
              </path>
            </svg>
            <div v-for="(r,i) in report.by_user" :key="r.user_id"
              style="display:flex;align-items:center;gap:6px;font-size:var(--fs-xs);margin-top:var(--space-1)">
              <span :style="{width:'10px',height:'10px',borderRadius:'50%',background:catColor(i),display:'inline-block'}"></span>
              {{ r.username }}: {{ fmtShort(r.tokens) }}
            </div>
          </div>

          <!-- 折線圖（填滿第四欄） -->
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);display:flex;flex-direction:column">
            <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);margin-bottom:var(--space-2);color:var(--text-secondary)">每日趨勢</div>
            <!-- 繪圖區：flex:1 撐滿卡片剩餘高度；SVG 絕對定位填滿它，不反過來撐高容器（避免 ResizeObserver 循環） -->
            <div ref="trendBox" style="flex:1;min-height:180px;position:relative">
            <svg :width="chartW" :height="chartH" v-if="chartData" style="position:absolute;top:0;left:0">
              <!-- y 軸格線與數量刻度 -->
              <line v-for="(t,i) in chartData.yTicks" :key="'g'+i"
                :x1="chartData.left" :y1="t.y" :x2="chartData.right" :y2="t.y"
                stroke="var(--border)" stroke-width="1" stroke-dasharray="2 3" />
              <text v-for="(t,i) in chartData.yTicks" :key="'y'+i"
                :x="chartData.left - 6" :y="t.y + 3" font-size="9" fill="var(--text-muted)" text-anchor="end">{{ t.label }}</text>
              <polyline :points="chartData.points"
                fill="none" stroke="var(--primary)" stroke-width="2" />
              <circle v-for="d in chartData.dots" :key="d.date" :cx="d.x" :cy="d.y" r="3" fill="var(--primary)">
                <title>{{ fmtMD(d.date) }}: {{ fmtNum(d.tokens) }}</title>
              </circle>
              <text v-for="(l,i) in chartData.labels" :key="i"
                :x="l.x" :y="chartH - 8" font-size="10" fill="var(--text-muted)" text-anchor="middle">{{ l.label }}</text>
            </svg>
            <div v-else style="font-size:var(--fs-sm);color:var(--text-muted);padding:var(--space-5) 0;text-align:center">資料不足</div>
            </div>
          </div>

        </div>

        <!-- 各關卡成本與失敗率：失敗率高的關卡＝重跑成本集中處，是省 token 的第一優先目標 -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:var(--space-5)" v-if="report.by_agent.length">
          <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);padding:var(--space-3) var(--space-3) 0;color:var(--text-secondary)">各關卡成本與失敗率</div>
          <table style="width:100%;border-collapse:collapse;font-size:var(--fs-sm)">
            <thead>
              <tr style="font-weight:var(--fw-semibold);font-size:var(--fs-xs);color:var(--text-muted)">
                <th style="padding:var(--space-2) var(--space-3);text-align:left">關卡</th>
                <th style="padding:var(--space-2) var(--space-3);text-align:right">實際 Token 數</th>
                <th style="padding:var(--space-2) var(--space-3);text-align:right">花費</th>
                <th style="padding:var(--space-2) var(--space-3);text-align:right">呼叫數</th>
                <th style="padding:var(--space-2) var(--space-3);text-align:right">失敗數</th>
                <th style="padding:var(--space-2) var(--space-3);text-align:right">失敗率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in report.by_agent" :key="'ag-'+r.agent_type" style="border-top:1px solid var(--border)">
                <td style="padding:var(--space-2) var(--space-3)">
                  <span :style="{width:'10px',height:'10px',borderRadius:'50%',background:agentColor(r.agent_type),display:'inline-block',marginRight:'6px'}"></span>{{ agentLabel(r.agent_type) }}
                </td>
                <td style="padding:var(--space-2) var(--space-3);text-align:right" :title="fmtNum(r.tokens)">{{ fmtShort(r.tokens) }}</td>
                <td style="padding:var(--space-2) var(--space-3);text-align:right">{{ fmtUSD(r.cost_usd) }}</td>
                <td style="padding:var(--space-2) var(--space-3);text-align:right">{{ r.calls }}</td>
                <td style="padding:var(--space-2) var(--space-3);text-align:right">{{ r.failed_calls }}</td>
                <td style="padding:var(--space-2) var(--space-3);text-align:right"
                  :style="{color: r.fail_rate >= 0.2 ? 'var(--danger)' : (r.fail_rate > 0 ? 'var(--warning)' : 'var(--text-muted)')}">
                  {{ (r.fail_rate * 100).toFixed(0) }}%
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 明細表 -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
          <div style="max-height:520px;overflow-y:auto">
          <table style="width:100%;border-collapse:collapse;font-size:var(--fs-base);table-layout:fixed">
            <thead>
              <tr style="background:var(--border);font-weight:var(--fw-semibold);font-size:var(--fs-sm);position:sticky;top:0;z-index:1">
                <th style="padding:var(--space-2) var(--space-3);text-align:left;background:var(--border);width:28%">任務</th>
                <th style="padding:var(--space-2) var(--space-3);text-align:left;background:var(--border);width:16%">專案</th>
                <th style="padding:var(--space-2) var(--space-3);text-align:right;background:var(--border);width:11%">實際 Token 數</th>
                <th style="padding:var(--space-2) var(--space-3);text-align:right;background:var(--border);width:11%">花費</th>
                <th style="padding:var(--space-2) var(--space-3);text-align:left;background:var(--border);width:12%">用戶</th>
                <th style="padding:var(--space-2) var(--space-3);text-align:left;background:var(--border);width:22%">記錄時間</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="t in visibleTasks" :key="t.ref_key">
                <tr style="border-top:1px solid var(--border);cursor:pointer"
                  @click="toggleTask(t.ref_key)">
                  <td style="padding:var(--space-2) var(--space-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" :title="taskLabel(t)">
                    <span style="margin-right:6px;color:var(--text-muted)">
                      {{ expandedTasks[t.ref_key] ? '▾' : '▸' }}
                    </span>
                    <router-link v-if="taskLink(t)" :to="taskLink(t)" @click.stop
                      style="color:var(--primary);text-decoration:none">{{ taskLabel(t) }}</router-link>
                    <span v-else>{{ taskLabel(t) }}</span>
                  </td>
                  <td style="padding:var(--space-2) var(--space-3);color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" :title="t.project_name || '—'">{{ t.project_name || '—' }}</td>
                  <td style="padding:var(--space-2) var(--space-3);text-align:right" :title="fmtNum(t.total_tokens)">{{ fmtShort(t.total_tokens) }}</td>
                  <td style="padding:var(--space-2) var(--space-3);text-align:right;font-weight:var(--fw-semibold)" :title="'$'+Number(t.total_cost||0).toFixed(6)">{{ fmtUSD(t.total_cost) }}</td>
                  <td style="padding:var(--space-2) var(--space-3);color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" :title="t.username || '—'">{{ t.username || '—' }}</td>
                  <td style="padding:var(--space-2) var(--space-3);color:var(--text-muted);font-size:var(--fs-xs);white-space:nowrap">
                    {{ new Date(t.last_recorded_at).toLocaleString('zh-TW') }}
                  </td>
                </tr>
                <tr v-if="expandedTasks[t.ref_key]"
                  style="background:var(--bg)">
                  <td colspan="6" style="padding:var(--space-1) var(--space-3) var(--space-2) var(--space-8)">
                    <div v-for="(a,ai) in t.agents" :key="ai"
                      style="display:inline-flex;align-items:center;gap:var(--space-1);margin-right:var(--space-3);font-size:var(--fs-xs);color:var(--text-secondary)">
                      <span :style="{width:'8px',height:'8px',borderRadius:'50%',background:agentColor(a.agent_type),display:'inline-block'}"></span>
                      {{ agentLabel(a.agent_type) }}<span v-if="a.model" style="color:var(--text-muted)">·{{ a.model }}</span>: <span :title="fmtNum(a.tokens)">{{ fmtShort(a.tokens) }}</span> / <span :title="'$'+Number(a.cost||0).toFixed(6)">{{ fmtUSD(a.cost) }}</span>
                      <span v-if="a.duration_ms" style="color:var(--text-muted)">({{ (a.duration_ms/1000).toFixed(1) }}s)</span>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          </div>
          <div v-if="!report.tasks.length" style="text-align:center;padding:var(--space-8);color:var(--text-muted)">
            本期間無 Token 使用記錄
          </div>
          <div v-else-if="report.tasks.length > 100"
            style="text-align:center;padding:var(--space-2);font-size:var(--fs-xs);color:var(--text-muted);border-top:1px solid var(--border)">
            僅顯示前 100 筆(共 {{ report.tasks.length }} 筆)
          </div>
        </div>

      </template>

      <!-- 圓餅放大 modal：點小圖開啟，滑鼠移到扇形／圖例顯示百分比 -->
      <div v-if="zoom" class="pie-modal-overlay" @click="zoom=null">
        <div class="pie-modal" @click.stop>
          <div class="pie-modal-head">
            <span>{{ zoom.title }}</span>
            <button class="pie-modal-close" @click="zoom=null" title="關閉">✕</button>
          </div>
          <div class="pie-modal-body">
            <svg viewBox="0 0 180 180" width="320" height="320" style="max-width:70vw;height:auto">
              <path v-for="(s,i) in zoom.slices" :key="i" :d="s.d" class="pie-slice"
                :style="{fill:s.color, opacity: hoverIdx===null || hoverIdx===i ? 1 : 0.3}"
                @mouseenter="hoverIdx=i" @mouseleave="hoverIdx=null">
                <title>{{ s.label }}: {{ fmtNum(s.value) }}（{{ (s.frac*100).toFixed(1) }}%）</title>
              </path>
            </svg>
            <div class="pie-modal-caption">
              <template v-if="hoverIdx!==null">
                <span :style="{width:'12px',height:'12px',borderRadius:'50%',background:zoom.slices[hoverIdx].color,display:'inline-block'}"></span>
                {{ zoom.slices[hoverIdx].label }} — {{ fmtNum(zoom.slices[hoverIdx].value) }}（<strong style="margin:0 2px">{{ (zoom.slices[hoverIdx].frac*100).toFixed(1) }}%</strong>）
              </template>
              <span v-else class="caption-hint">滑鼠移到扇形或圖例可看百分比</span>
            </div>
            <div class="pie-modal-legend">
              <div v-for="(s,i) in zoom.slices" :key="i"
                :class="{'lg-active': hoverIdx===i}"
                @mouseenter="hoverIdx=i" @mouseleave="hoverIdx=null">
                <span :style="{width:'10px',height:'10px',borderRadius:'50%',background:s.color,display:'inline-block',flexShrink:0}"></span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ s.label }}</span>
                <span style="color:var(--text-muted)">{{ (s.frac*100).toFixed(1) }}%</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
});
