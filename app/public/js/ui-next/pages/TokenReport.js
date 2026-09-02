(function () {
  const { fmtNumber, fmtCompact, fmtUSD, agentColor, catColor, usageLevel, usageTime, usageWindowLabel } = window.UiNextShared;
  const DETAIL_PAGE = 20;
  const TABS = [
    { key: "overview", label: "總覽" },
    { key: "usage", label: "用量報表" },
    { key: "quality", label: "品質報表" },
    { key: "detail", label: "明細" },
  ];

  window.UiNextTokenReportView = Vue.defineComponent({
    name: "UiNextTokenReportView",
    components: { UiNextIcon: window.UiNextIcon },
    data() {
      return {
        loading: true,
        loadError: "",
        report: null,
        projects: [],
        labels: {},
        expanded: {},
        claudeUsage: null,
        codexUsage: null,
        tab: "overview",
        // 明細先畫 20 筆，捲到底再續 20。原本一次畫 100 筆、超過就只印一行「僅顯示前 100 筆」，
        // 後面的資料看不到也載不到。
        detailLimit: DETAIL_PAGE,
        detailObserver: null,
        // 折線圖用實際像素畫，不用 viewBox 拉伸——被拉伸的 SVG 連文字都會變形，
        // 而這張圖現在要放刻度與日期。尺寸由 ResizeObserver 量繪圖區得來。
        chartW: 800,
        chartH: 220,
        chartObserver: null,
        // 同時只會 hover 一個地方，所以三張卡共用一個 key（key 本身已帶卡片別）。
        hoverShare: "",
        filters: {
          range: "30",
          start: "",
          end: "",
          project_id: "",
          task_id: "",
          showAll: false,
        },
      };
    },
    computed: {
      dateRange() {
        const now = new Date(),
          end = now.toISOString().slice(0, 10);
        if (this.filters.range === "today") {
          const start = new Date(now);
          start.setHours(0, 0, 0, 0);
          return { start: start.toISOString(), end: now.toISOString() };
        }
        if (this.filters.range === "7") {
          const start = new Date(now);
          start.setDate(start.getDate() - 7);
          return { start: start.toISOString().slice(0, 10), end };
        }
        if (this.filters.range === "30") {
          const start = new Date(now);
          start.setDate(start.getDate() - 30);
          return { start: start.toISOString().slice(0, 10), end };
        }
        return { start: this.filters.start, end: this.filters.end };
      },
      // ⚠ 四列一律講「剩 X%」。原本 Claude 講「47% 已使用」、Codex 講「剩 9%」，同一張卡兩種
      // 基準——Codex 那條長條畫的是已使用的 91%，旁邊卻寫「剩 9%」，讀起來像是只用了 9%。
      // 側欄左下角講的也是「剩」，統一才對得起來。
      quotaRows() {
        const rows = [];
        const claude = this.claudeUsage || {};
        [
          ["5 小時", claude.five_hour],
          ["7 天", claude.seven_day],
        ].forEach(([label, item]) => {
          if (item && item.utilization != null) {
            const used = Math.round(item.utilization);
            rows.push({
              provider: "Claude",
              label,
              used,
              remaining: Math.max(0, 100 - used),
              resetsAt: item.resets_at,
              updatedAt: claude.updated_at,
              // API 自己標的：這份快照已經不新鮮（見 lib/claude-usage.js）。不顯示的話，
              // 畫面上是一個看起來很確定的數字，實際可能是幾小時前的。
              stale: !!claude.stale,
            });
          }
        });
        const codex = this.codexUsage || {};
        [codex.primary, codex.secondary].forEach((item) => {
          if (item && item.used_percent != null)
            rows.push({
              provider: "Codex",
              // 「主要額度／週額度」看不出是多長的窗；API 給了分鐘數就照著寫。
              label: usageWindowLabel(item.window_minutes) || "額度",
              used: Math.round(item.used_percent),
              remaining: Math.round(item.remaining_percent),
              resetsAt: item.resets_at,
              updatedAt: codex.updated_at,
              stale: false,
            });
        });
        return rows;
      },
      // 一家一欄（Claude 左、Codex 右）。原本是 2×2 row-major，同一列並排的是
      // 「Claude 的 5 小時」和「Claude 的 7 天」，而上下相鄰的才是同一種視窗——
      // 兩個維度都在，眼睛不知道該橫著讀還是直著讀。
      quotaGroups() {
        const groups = [];
        this.quotaRows.forEach((row) => {
          const hit = groups.find((g) => g.provider === row.provider);
          if (hit) hit.rows.push(row);
          else groups.push({ provider: row.provider, rows: [row] });
        });
        return groups;
      },
      // title＝未縮寫的完整數字。卡片顯示的是 K/M 縮寫與四捨五入後的金額，沒有 title 就再也查不到原值。
      summaryCards() {
        const s = this.report && this.report.summary;
        if (!s) return [];
        return [
          { label: "總 Token 數", value: fmtCompact(s.total_tokens), note: "含 Cache", title: fmtNumber(s.total_tokens) },
          { label: "Cache 總數", value: fmtCompact(s.cache_tokens), note: "重複讀取部分", title: fmtNumber(s.cache_tokens) },
          { label: "實際 Token", value: fmtCompact(s.actual_tokens), note: "扣除 Cache 後", title: fmtNumber(s.actual_tokens) },
          { label: "平均每任務", value: fmtCompact(s.avg_tokens_per_task), note: "實際 Token ÷ 任務數", title: fmtNumber(Math.round(s.avg_tokens_per_task || 0)) },
          { label: "任務數", value: fmtNumber(s.total_tasks), note: "本期間有記錄", title: fmtNumber(s.total_tasks) },
          { label: "完成任務", value: fmtNumber(s.done_tasks), note: "已完成交付", title: fmtNumber(s.done_tasks) },
          { label: "實際花費", value: fmtUSD(s.cost_usd), note: "本期間累計", title: `$${Number(s.cost_usd || 0).toFixed(6)}` },
          { label: "每張交付成本", value: fmtUSD(s.avg_cost_per_task), note: `期間總花費 ÷ 完成任務數 ${s.done_tasks}`, title: `$${Number(s.avg_cost_per_task || 0).toFixed(6)}` },
        ];
      },
      // 明細表最多顯示 100 筆；下方另有「共 N 筆」提示，否則看不出被截斷
      tabs() { return TABS; },
      allTasks() { return (this.report && this.report.tasks) || []; },
      visibleTasks() { return this.allTasks.slice(0, this.detailLimit); },
      hasMoreTasks() { return this.allTasks.length > this.detailLimit; },
      // Legacy 用三張 SVG 圓餅呈現 Agent／專案／使用者的占比。這裡改成「百分比＋顏色」清單版：
      // 資訊等價（顏色沿用同一份對照），少一套繪圖與放大 modal 的碼。
      agentShares() {
        return this.shareRows(this.report && this.report.by_agent, (row) => this.agentLabel(row.agent_type), (row) => agentColor(row.agent_type), "agent");
      },
      projectShares() {
        return this.shareRows(this.report && this.report.by_project, (row) => row.project_name, (row, index) => catColor(index), "project");
      },
      userShares() {
        return this.shareRows(this.report && this.report.by_user, (row) => row.username, (row, index) => catColor(index), "user");
      },
      agentPie() { return this.pieSlices(this.agentShares); },
      projectPie() { return this.pieSlices(this.projectShares); },
      userPie() { return this.pieSlices(this.userShares); },
      // 幾何比照 Legacy 版：左側留 48px 給數量刻度，首點再內縮 16px，否則第一個日期標籤
      // 會壓在 y 軸的 0 上。
      chartData() {
        const daily = (this.report && this.report.daily) || [];
        if (daily.length < 2) return null;
        const left = 48, top = 16, bottom = this.chartH - 28;
        const plotLeft = left + 16, plotRight = this.chartW - 24;
        const max = Math.max(...daily.map((row) => Number(row.tokens || 0)), 1);
        const dots = daily.map((row, index) => ({
          x: plotLeft + (index / (daily.length - 1)) * (plotRight - plotLeft),
          y: bottom - (Number(row.tokens || 0) / max) * (bottom - top),
          date: row.date,
          tokens: Number(row.tokens || 0),
        }));
        // 每天都標日期會糊成一團：最多 10 個標籤，但最後一天一定要有。
        const step = Math.max(1, Math.ceil(daily.length / 10));
        const labels = dots
          .filter((_, index) => index % step === 0 || index === daily.length - 1)
          .map((dot) => ({ x: dot.x, label: this.fmtMD(dot.date) }));
        const TICKS = 4;
        const yTicks = [];
        for (let i = 0; i <= TICKS; i++) {
          const value = (max / TICKS) * i;
          yTicks.push({ y: bottom - (value / max) * (bottom - top), label: fmtCompact(Math.round(value)) });
        }
        return { points: dots.map((dot) => `${dot.x},${dot.y}`).join(" "), dots, labels, yTicks, left, right: plotRight };
      },
      trendPoints() {
        const rows = (this.report && this.report.daily) || [];
        if (rows.length < 2) return "";
        const max = Math.max(...rows.map((row) => Number(row.tokens || 0)), 1);
        return rows
          .map(
            (row, index) =>
              `${8 + index * (284 / (rows.length - 1))},${80 - (Number(row.tokens || 0) / max) * 66}`,
          )
          .join(" ");
      },
    },
    async created() {
      const [projects, labels, claude, codex] = await Promise.all([
        Api.get("projects").catch(() => []),
        Api.get("agents/labels").catch(() => ({})),
        Api.get("claude-usage").catch(() => null),
        Api.get("codex-usage").catch(() => null),
      ]);
      this.projects = projects;
      this.labels = labels;
      this.claudeUsage = claude;
      this.codexUsage = codex;
      await this.load();
    },
    beforeUnmount() { this.teardownDetailObserver(); this.teardownChartObserver(); },
    watch: {
      // 換頁籤／換篩選都要回到第一頁：留著舊的 limit 會讓新資料一進來就畫幾百筆。
      tab() { this.detailLimit = DETAIL_PAGE; this.$nextTick(() => { this.syncDetailObserver(); this.observeChart(); }); },
      report() { this.detailLimit = DETAIL_PAGE; this.$nextTick(() => { this.syncDetailObserver(); this.observeChart(); }); },
    },
    methods: {
      fmtNumber,
      fmtCompact,
      fmtUSD,
      usageLevel,
      usageTime,
      agentColor,
      agentLabel(type) {
        return this.labels[type] || type;
      },
      // date 可能是 Date 物件（pg）或 'YYYY-MM-DD' 字串（pg-mem）→ 統一輸出本地 MM-DD
      fmtMD(value) {
        const date = value instanceof Date ? value : new Date(`${String(value)}T00:00:00`);
        return Number.isNaN(date.getTime())
          ? String(value).slice(5, 10)
          : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      },
      measureChart() {
        const el = this.$refs.trendBox;
        if (!el) return;
        this.chartW = Math.max(320, el.clientWidth);
        this.chartH = Math.max(180, el.clientHeight);
      },
      // ResizeObserver 而不是 nextTick：切到這個頁籤時版面還在定型，量到的是中間態寬度。
      // SVG 是絕對定位、不撐高容器，所以量測不會回饋成無限循環。
      observeChart() {
        this.teardownChartObserver();
        const el = this.$refs.trendBox;
        if (!el || typeof ResizeObserver === "undefined") return;
        this.chartObserver = new ResizeObserver(() => this.measureChart());
        this.chartObserver.observe(el);
        this.measureChart();
      },
      teardownChartObserver() {
        if (this.chartObserver) this.chartObserver.disconnect();
        this.chartObserver = null;
      },
      // 用 IntersectionObserver 而不是監聽捲動：真正在捲的是 .ui-next-main（不是這個區塊，
      // 也不是 window），綁錯對象的話事件一次都不會來。哨兵看得見＝使用者捲到清單尾巴了。
      syncDetailObserver() {
        this.teardownDetailObserver();
        const sentinel = this.$refs.detailSentinel;
        if (!sentinel || typeof IntersectionObserver === "undefined") return;
        this.detailObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) this.loadMoreTasks();
        }, { rootMargin: "200px" });
        this.detailObserver.observe(sentinel);
      },
      teardownDetailObserver() {
        if (this.detailObserver) this.detailObserver.disconnect();
        this.detailObserver = null;
      },
      loadMoreTasks() {
        if (!this.hasMoreTasks) return;
        this.detailLimit += DETAIL_PAGE;
        // 續載之後哨兵還在原地（畫面又長高了），下一次進入視野才會再觸發；
        // 一次多筆 entries 也只加一頁，靠 hasMoreTasks 收尾。
        this.$nextTick(() => this.syncDetailObserver());
      },
      // 扇形路徑。幾何與 Legacy 版同源，包含那個「整圓」的特例：只有一筆資料時起訖點重合，
      // A 弧會退化成畫不出來（畫面一片空白），要改用上下兩段半弧拼成整圓。
      // 只有同一張卡裡「不是被指到的那一塊」才變暗。
      isDimmed(key) {
        if (!this.hoverShare || this.hoverShare === key) return false;
        return this.hoverShare.split("::")[0] === key.split("::")[0];
      },
      pieSlices(rows) {
        const total = rows.reduce((sum, row) => sum + row.tokens, 0);
        if (!total) return [];
        const radius = 70, cx = 90, cy = 90;
        let angle = -Math.PI / 2;
        return rows.map((row) => {
          const frac = row.tokens / total;
          const a0 = angle;
          angle += frac * 2 * Math.PI;
          const a1 = angle;
          if (frac >= 1) {
            return { ...row, d: `M${cx - radius},${cy} A${radius},${radius},0,1,1,${cx + radius},${cy} A${radius},${radius},0,1,1,${cx - radius},${cy}Z` };
          }
          const x0 = cx + radius * Math.cos(a0), y0 = cy + radius * Math.sin(a0);
          const x1 = cx + radius * Math.cos(a1), y1 = cy + radius * Math.sin(a1);
          return { ...row, d: `M${cx},${cy} L${x0},${y0} A${radius},${radius},0,${frac > 0.5 ? 1 : 0},1,${x1},${y1}Z` };
        });
      },
      shareRows(rows, labelOf, colorOf, card) {
        const list = rows || [];
        const total = list.reduce((sum, row) => sum + Number(row.tokens || 0), 0);
        return list.map((row, index) => ({
          // key 帶卡片別：三張卡共用一個 hover 狀態，不分家的話指著專案那張，
          // 另外兩張的扇形也會一起變暗。
          key: `${card}::${labelOf(row, index)}#${index}`,
          label: labelOf(row, index),
          tokens: Number(row.tokens || 0),
          color: colorOf(row, index),
          pct: total ? (Number(row.tokens || 0) / total) * 100 : 0,
        }));
      },
      // 明細列顯示名稱：不能只用 title——chat 要看得出是對話、已刪除的要講清楚，
      // 而 wiki／workflow_health 這種專案層級記錄根本沒有 title，只有關卡代號。
      taskLabel(task) {
        if (task.kind === "chat") return `chat > ${task.deleted ? "(已刪除)" : task.title || "(舊對話)"}`;
        if (task.kind === "task") return task.title || (task.deleted ? "(已刪除任務)" : task.task_id || "（無標題）");
        const label = this.agentLabel(task.kind);
        return task.project_name ? `${task.project_name} > ${label}` : label;
      },
      fmtTime(value) {
        return value ? new Date(value).toLocaleString("zh-TW") : "—";
      },
      toggle(key) {
        this.expanded[key] = !this.expanded[key];
      },
      taskLink(task) {
        if (!task.linkable) return "";
        return task.kind === "chat"
          ? `/projects/${task.project_id}/chat/${task.chat_id}`
          : task.task_row_id != null
            ? `/task/${task.task_row_id}`
            : "";
      },
      async load() {
        this.loading = true;
        this.loadError = "";
        try {
          const p = new URLSearchParams(),
            range = this.dateRange;
          if (range.start) p.set("start", range.start);
          if (range.end) p.set("end", range.end);
          if (this.filters.project_id)
            p.set("project_id", this.filters.project_id);
          if (this.filters.task_id) p.set("task_id", this.filters.task_id);
          if (this.filters.showAll) p.set("all", "true");
          this.report = await Api.get(`token-report?${p}`);
        } catch (error) {
          // 只發 toast 的話 toast 消失後畫面只剩篩選列，看起來像「這期間沒資料」
          this.loadError = error.message || "無法載入用量報表";
          showToast(this.loadError, "error", 0);
        } finally {
          this.loading = false;
        }
      },
    },
    template: `
      <section class="ui-next-page ui-next-usage-page">
        <header class="ui-next-page-head">
<div>
<h1>用量報表</h1>
<p>查看額度、成本與交付品質；篩選只影響下方分析資料。</p>
</div>
</header>
        <div class="ui-next-filterbar">
<select v-model="filters.range">
<option value="today">今天</option>
<option value="7">最近 7 天</option>
<option value="30">最近 30 天</option>
<option value="custom">自訂期間</option>
</select>
<template v-if="filters.range==='custom'">
<input v-model="filters.start" type="date">
<span>至</span>
<input v-model="filters.end" type="date">
</template>
<select v-model="filters.project_id">
<option value="">全部專案</option>
<option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
</select>
<input v-model="filters.task_id" placeholder="任務 ID">
<label>
<input v-model="filters.showAll" type="checkbox" @change="load"> 全部使用者</label>
<button class="ui-next-primary" @click="load" :disabled="loading">{{ loading ? '更新中…' : '更新報表' }}</button>
</div>
        <div class="ui-next-page-tabs" role="tablist">
<button v-for="item in tabs" :key="item.key" type="button" role="tab" :aria-selected="tab===item.key ? 'true' : 'false'" @click="tab=item.key">{{ item.label }}</button>
</div>
        <div v-show="tab==='overview'" class="ui-next-quota-card">
<div class="ui-next-card-title">
<div>
<h2>目前額度</h2>
<p>長條畫的是「已使用」的比例，數字寫的是「還剩多少」；顏色只是狀態提醒。</p>
</div>
</div>
<div class="ui-next-quota-list">
<section v-for="group in quotaGroups" :key="group.provider" class="ui-next-quota-group">
<h3>{{ group.provider }}</h3>
<div v-for="row in group.rows" :key="row.provider + row.label">
<div>
<b>{{ row.label }}</b>
<span>剩 {{ row.remaining }}%</span>
</div>
<i>
<em :class="usageLevel(row.used)" :style="{width:row.used+'%'}">
</em>
</i>
<small>重置 {{ usageTime(row.resetsAt) }} · 更新 {{ usageTime(row.updatedAt) }}<template v-if="row.stale"> · 這份快照可能已過期</template></small>
</div>
</section>
<p v-if="!quotaRows.length" class="ui-next-empty-inline">目前無法取得訂閱額度。</p>
</div>
</div>
        <template v-if="loading">
<div class="ui-next-loading-card">載入報表中…</div>
</template>
<div v-else-if="loadError" class="ui-next-loading-card ui-next-error-text">{{ loadError }} <button type="button" @click="load">重試</button></div>
<template v-else-if="report">
<template v-if="tab==='overview'">
<div class="ui-next-metric-grid">
<article v-for="card in summaryCards" :key="card.label">
<span>{{ card.label }}</span>
<strong :title="card.title">{{ card.value }}</strong>
<small>{{ card.note }}</small>
</article>
</div>
</template>
<template v-if="tab==='usage'">
<article class="ui-next-panel ui-next-trend-panel">
<h2>每日趨勢</h2>
<div ref="trendBox" class="ui-next-trend-box">
<svg v-if="chartData" :width="chartW" :height="chartH">
<line v-for="(tick,index) in chartData.yTicks" :key="'g'+index" :x1="chartData.left" :y1="tick.y" :x2="chartData.right" :y2="tick.y" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 3"/>
<text v-for="(tick,index) in chartData.yTicks" :key="'y'+index" :x="chartData.left - 6" :y="tick.y + 3" font-size="9" fill="var(--text-muted)" text-anchor="end">{{ tick.label }}</text>
<polyline :points="chartData.points" fill="none" stroke="var(--primary)" stroke-width="2"/>
<circle v-for="dot in chartData.dots" :key="'d'+dot.date" :cx="dot.x" :cy="dot.y" r="3" fill="var(--primary)"><title>{{ fmtMD(dot.date) }}：{{ fmtNumber(dot.tokens) }} Token</title></circle>
<text v-for="(item,index) in chartData.labels" :key="'x'+index" :x="item.x" :y="chartH - 8" font-size="10" fill="var(--text-muted)" text-anchor="middle">{{ item.label }}</text>
</svg>
<p v-else class="ui-next-empty-inline">本期間資料不足，尚無趨勢。</p>
</div>
</article>
<div class="ui-next-usage-grid">
<article class="ui-next-panel">
<h2>依專案</h2>
<div class="ui-next-share-body">
<svg v-if="projectPie.length" class="ui-next-share-pie" viewBox="0 0 184 184" width="210" height="210" role="img" :aria-label="'依專案占比圖'">
<path v-for="slice in projectPie" :key="slice.key" :d="slice.d" :style="{fill:slice.color}" :class="{'is-active':hoverShare===slice.key,'is-dim':isDimmed(slice.key)}" @mouseenter="hoverShare=slice.key" @mouseleave="hoverShare=''"><title>{{ slice.label }}：{{ fmtNumber(slice.tokens) }}（{{ slice.pct.toFixed(1) }}%）</title></path>
</svg>
<div class="ui-next-share-legend">
<div class="ui-next-share-row" v-for="row in projectShares" :key="row.key" :class="{'is-active':hoverShare===row.key}" @mouseenter="hoverShare=row.key" @mouseleave="hoverShare=''">
<i :style="{background:row.color}"></i>
<span :title="row.label">{{ row.label }}</span>
<b :title="fmtNumber(row.tokens)">{{ fmtCompact(row.tokens) }}</b>
<em>{{ row.pct.toFixed(1) }}%</em>
</div>
</div>
</div>
<p v-if="!projectShares.length" class="ui-next-empty-inline">尚無專案資料。</p>
</article>
<article class="ui-next-panel">
<h2>依 Agent</h2>
<div class="ui-next-share-body">
<svg v-if="agentPie.length" class="ui-next-share-pie" viewBox="0 0 184 184" width="210" height="210" role="img" :aria-label="'依 Agent占比圖'">
<path v-for="slice in agentPie" :key="slice.key" :d="slice.d" :style="{fill:slice.color}" :class="{'is-active':hoverShare===slice.key,'is-dim':isDimmed(slice.key)}" @mouseenter="hoverShare=slice.key" @mouseleave="hoverShare=''"><title>{{ slice.label }}：{{ fmtNumber(slice.tokens) }}（{{ slice.pct.toFixed(1) }}%）</title></path>
</svg>
<div class="ui-next-share-legend">
<div class="ui-next-share-row" v-for="row in agentShares" :key="row.key" :class="{'is-active':hoverShare===row.key}" @mouseenter="hoverShare=row.key" @mouseleave="hoverShare=''">
<i :style="{background:row.color}"></i>
<span :title="row.label">{{ row.label }}</span>
<b :title="fmtNumber(row.tokens)">{{ fmtCompact(row.tokens) }}</b>
<em>{{ row.pct.toFixed(1) }}%</em>
</div>
</div>
</div>
<p v-if="!agentShares.length" class="ui-next-empty-inline">尚無 Agent 資料。</p>
</article>
<article class="ui-next-panel">
<h2>依使用者</h2>
<div class="ui-next-share-body">
<svg v-if="userPie.length" class="ui-next-share-pie" viewBox="0 0 184 184" width="210" height="210" role="img" :aria-label="'依使用者占比圖'">
<path v-for="slice in userPie" :key="slice.key" :d="slice.d" :style="{fill:slice.color}" :class="{'is-active':hoverShare===slice.key,'is-dim':isDimmed(slice.key)}" @mouseenter="hoverShare=slice.key" @mouseleave="hoverShare=''"><title>{{ slice.label }}：{{ fmtNumber(slice.tokens) }}（{{ slice.pct.toFixed(1) }}%）</title></path>
</svg>
<div class="ui-next-share-legend">
<div class="ui-next-share-row" v-for="row in userShares" :key="row.key" :class="{'is-active':hoverShare===row.key}" @mouseenter="hoverShare=row.key" @mouseleave="hoverShare=''">
<i :style="{background:row.color}"></i>
<span :title="row.label">{{ row.label }}</span>
<b :title="fmtNumber(row.tokens)">{{ fmtCompact(row.tokens) }}</b>
<em>{{ row.pct.toFixed(1) }}%</em>
</div>
</div>
</div>
<p v-if="!userShares.length" class="ui-next-empty-inline">尚無使用者資料（未勾「全部使用者」時只會有你自己）。</p>
</article>
</div>
</template>
<template v-if="tab==='quality'">
<div class="tr-table-card" v-if="report.by_agent.length">
<h2 class="ui-next-table-title">各關卡成本與失敗率<small>失敗率高的關卡＝重跑成本集中處，是省 token 的第一優先目標</small></h2>
<table class="tr-table">
<thead>
<tr><th>關卡</th><th class="ui-next-num">實際 Token 數</th><th class="ui-next-num">花費</th><th class="ui-next-num">呼叫數</th><th class="ui-next-num">平均每任務呼叫</th><th class="ui-next-num">失敗數</th><th class="ui-next-num">失敗率</th></tr>
</thead>
<tbody>
<tr v-for="row in report.by_agent" :key="'ag-'+row.agent_type">
<td><i class="ui-next-dot" :style="{background:agentColor(row.agent_type)}"></i>{{ agentLabel(row.agent_type) }}</td>
<td class="ui-next-num" :title="fmtNumber(row.tokens)">{{ fmtCompact(row.tokens) }}</td>
<td class="ui-next-num">{{ fmtUSD(row.cost_usd) }}</td>
<td class="ui-next-num">{{ row.calls }}</td>
<td class="ui-next-num" :style="{color: row.avg_calls_per_task >= 2 ? 'var(--danger)' : (row.avg_calls_per_task > 1.2 ? 'var(--warning)' : 'var(--text-muted)')}">{{ row.avg_calls_per_task.toFixed(2) }}</td>
<td class="ui-next-num">{{ row.failed_calls }}</td>
<td class="ui-next-num" :style="{color: row.fail_rate >= 0.2 ? 'var(--danger)' : (row.fail_rate > 0 ? 'var(--warning)' : 'var(--text-muted)')}">{{ (row.fail_rate * 100).toFixed(0) }}%</td>
</tr>
</tbody>
</table>
</div>
<div class="tr-table-card" v-if="report.project_stats && report.project_stats.length">
<h2 class="ui-next-table-title">專案品質統計<small>本期間完成的任務；一次過關＝分析／開發／QA／E2E 四關都沒重跑</small></h2>
<table class="tr-table">
<thead>
<tr><th>專案</th><th class="ui-next-num">完成任務</th><th class="ui-next-num">一次過關率</th><th class="ui-next-num">人工退回率</th><th>主要退回原因</th></tr>
</thead>
<tbody>
<tr v-for="row in report.project_stats" :key="'ps-'+(row.project_id||'none')">
<td>{{ row.project_name }}</td>
<td class="ui-next-num">{{ row.done_tasks }}</td>
<td class="ui-next-num" :style="{color: row.first_pass_rate < 0.5 ? 'var(--danger)' : (row.first_pass_rate < 0.8 ? 'var(--warning)' : 'var(--success)')}">{{ (row.first_pass_rate * 100).toFixed(0) }}%</td>
<td class="ui-next-num" :style="{color: row.reject_rate >= 0.3 ? 'var(--danger)' : (row.reject_rate > 0 ? 'var(--warning)' : 'var(--text-muted)')}">{{ (row.reject_rate * 100).toFixed(0) }}%</td>
<td>{{ row.top_reject_category ? row.top_reject_category + '（' + row.top_reject_count + '）' : '—' }}</td>
</tr>
</tbody>
</table>
</div>
<p v-else class="ui-next-empty-inline">本期間沒有已完成的任務，尚無品質統計。</p>
</template>
<section v-if="tab==='detail'" class="ui-next-panel ui-next-usage-detail">
<div class="ui-next-card-title">
<div>
<h2>使用明細</h2>
<p>點選列可展開各 Agent 的模型、用量與耗時。</p>
</div>
<span>共 {{ report.tasks.length }} 筆</span>
</div>
<div class="ui-next-data-list">
<article v-for="task in visibleTasks" :key="task.ref_key" role="button" tabindex="0" :aria-expanded="!!expanded[task.ref_key]" @click="toggle(task.ref_key)" @keydown.enter.prevent="toggle(task.ref_key)" @keydown.space.prevent="toggle(task.ref_key)">
<div>
<b :title="taskLabel(task)">{{ taskLabel(task) }}</b>
<span>{{ task.project_name || '未分類專案' }} · {{ task.username || '—' }} · {{ fmtTime(task.last_recorded_at) }}</span>
</div>
<div>
<strong :title="'$'+Number(task.total_cost||0).toFixed(6)">{{ fmtUSD(task.total_cost) }}</strong>
<span :title="fmtNumber(task.total_tokens)">{{ fmtCompact(task.total_tokens) }} Token</span>
</div>
<span class="ui-next-disclosure"><ui-next-icon :name="expanded[task.ref_key] ? 'chevron-up' : 'chevron-down'"/></span>
<div v-if="expanded[task.ref_key]" class="ui-next-detail-row">
<router-link v-if="taskLink(task)" :to="taskLink(task)" @click.stop>前往來源</router-link>
<span v-for="agent in task.agents" :key="agent.agent_type + agent.model">{{ agentLabel(agent.agent_type) }}<template v-if="agent.model"> · {{ agent.model }}</template>：{{ fmtCompact(agent.tokens) }} / {{ fmtUSD(agent.cost) }}<template v-if="agent.duration_ms">（{{ (agent.duration_ms / 1000).toFixed(1) }}s）</template></span>
</div>
</article>
<p v-if="!report.tasks.length" class="ui-next-empty-inline">本期間無 Token 使用記錄。</p>
</div>
<div ref="detailSentinel" class="ui-next-detail-sentinel" aria-hidden="true"></div>
<p v-if="hasMoreTasks" class="ui-next-more-hint">已顯示 {{ visibleTasks.length }} / {{ allTasks.length }} 筆，繼續往下捲會自動載入</p>
</section>
</template>
      </section>`,
  });

})();
