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
      chartH: 200
    };
  },
  computed: {
    // 折線圖幾何：依量測到的 chartW 自適應填滿整列
    chartData() {
      const daily = this.report?.daily;
      if (!daily || daily.length < 2) return null;
      // 左側留 48px 給 y 軸數量刻度
      const left = 48, w = this.chartW, top = 16, bottom = this.chartH - 28, n = daily.length;
      const maxV = Math.max(...daily.map(d => d.tokens), 1);
      const dots = daily.map((d, i) => ({
        x: left + (i / (n - 1)) * (w - left - 24),
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
      return { points: dots.map(p => `${p.x},${p.y}`).join(' '), dots, labels, yTicks, left, right: w - 24 };
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
        return `${t.project_name || '—'} > chat > ${name}`;
      }
      if (t.kind === 'task') {
        if (t.title) return t.title;
        if (t.deleted) return '(已刪除任務)';
        return t.task_id || '（無標題）';
      }
      // wiki 等專案層級記錄
      return `${t.project_name || '—'} > ${t.kind}`;
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
        await this.$nextTick();
        this.measureChart();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    fmtNum(n) { return Number(n || 0).toLocaleString(); },
    fmtShort(n) {
      n = Number(n || 0);
      if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
      return String(Math.round(n));
    },
    toggleTask(key) {
      this.expandedTasks[key] = !this.expandedTasks[key];
    },
    agentColor(type) {
      const map = { cs: '#7c3aed', triage: '#6b7280', analysis: '#2563eb', coding: '#059669',
                    qa: '#d97706', merge: '#db2777', deploy_fix: '#dc2626', wiki: '#0891b2', chat: '#f59e0b',
                    workflow_health: '#7e22ce' };
      return map[type] || '#6b7280';
    },
    // SVG pie chart
    piePath(slices) {
      const total = slices.reduce((s, r) => s + r.value, 0);
      if (!total) return [];
      let angle = -Math.PI / 2;
      return slices.map(s => {
        const frac = s.value / total;
        const a0 = angle;
        angle += frac * 2 * Math.PI;
        const a1 = angle;
        const r = 70;
        const cx = 90, cy = 90;
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
    // 量測折線圖容器寬度，讓 SVG 填滿整列
    measureChart() {
      const el = this.$refs.trendBox;
      if (el) {
        this.chartW = Math.max(320, el.clientWidth);
        // 卡片被左側圖例撐高 → 折線圖填滿整列（扣掉標題與 padding）
        this.chartH = Math.max(180, el.clientHeight - 50);
      }
    }
  },
  mounted() {
    this.measureChart();
    window.addEventListener('resize', this.measureChart);
  },
  beforeUnmount() {
    window.removeEventListener('resize', this.measureChart);
  },
  template: `
    <div class="topbar"><h1>用量報表</h1></div>
    <div class="content">

      <!-- 篩選列 -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
        <select v-model="filters.range" class="form-control" style="width:100px;font-size:13px;height:32px;padding:4px 8px">
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
          <option value="custom">自訂</option>
        </select>
        <template v-if="filters.range==='custom'">
          <input v-model="filters.start" type="date" class="form-control" style="width:140px;font-size:13px;height:32px;padding:4px 8px" />
          <span style="font-size:13px;color:var(--text-muted)">至</span>
          <input v-model="filters.end" type="date" class="form-control" style="width:140px;font-size:13px;height:32px;padding:4px 8px" />
        </template>
        <select v-model="filters.project_id" class="form-control" style="width:160px;font-size:13px;height:32px;padding:4px 8px">
          <option value="">全部專案</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <input v-model="filters.task_id" placeholder="任務 ID" class="form-control"
          style="width:160px;font-size:13px;height:32px;padding:4px 8px" />
        <button class="btn btn-primary btn-sm" @click="load" :disabled="loading">
          {{ loading ? '查詢中...' : '查詢' }}
        </button>
      </div>

      <div v-if="loading" class="loading">載入中...</div>
      <template v-else-if="report">

        <!-- 摘要卡片 -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--primary)" :title="fmtNum(report.summary.total_tokens)">{{ fmtShort(report.summary.total_tokens) }}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px">總 Token 數</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--success)">{{ fmtNum(report.summary.total_tasks) }}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px">任務數</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--warning)" :title="fmtNum(report.summary.avg_tokens_per_task)">{{ fmtShort(report.summary.avg_tokens_per_task) }}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px">平均每任務</div>
          </div>
        </div>

        <!-- 圖表區 -->
        <div style="display:grid;grid-template-columns:180px 180px 1fr;gap:16px;margin-bottom:20px">

          <!-- Agent 圓餅圖 -->
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">Agent 類型</div>
            <svg viewBox="0 0 180 180" width="154" height="154" v-if="report.by_agent.length">
              <path v-for="s in piePath(report.by_agent.map(r=>({value:r.tokens,color:agentColor(r.agent_type),label:agentLabel(r.agent_type)})))"
                :key="s.label" :d="s.d" :fill="s.color" opacity="0.9">
                <title>{{ s.label }}: {{ fmtNum(s.value) }}</title>
              </path>
            </svg>
            <div v-for="r in report.by_agent" :key="r.agent_type"
              style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:4px">
              <span :style="{width:'10px',height:'10px',borderRadius:'50%',background:agentColor(r.agent_type),display:'inline-block'}"></span>
              {{ agentLabel(r.agent_type) }}: {{ fmtShort(r.tokens) }}
            </div>
          </div>

          <!-- 專案圓餅圖 -->
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">專案分布</div>
            <svg viewBox="0 0 180 180" width="154" height="154" v-if="report.by_project.length">
              <path v-for="(s,i) in piePath(report.by_project.map((r,i)=>({value:r.tokens,color:'hsl('+(i*60)+',60%,50%)',label:r.project_name})))"
                :key="s.label" :d="s.d" :fill="s.color" opacity="0.9">
                <title>{{ s.label }}: {{ fmtNum(s.value) }}</title>
              </path>
            </svg>
            <div v-for="(r,i) in report.by_project" :key="r.project_id"
              style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:4px">
              <span :style="{width:'10px',height:'10px',borderRadius:'50%',background:'hsl('+(i*60)+',60%,50%)',display:'inline-block'}"></span>
              {{ r.project_name }}: {{ fmtShort(r.tokens) }}
            </div>
          </div>

          <!-- 折線圖（填滿第三欄） -->
          <div ref="trendBox" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">每日趨勢</div>
            <svg :width="chartW" :height="chartH" v-if="chartData">
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
            <div v-else style="font-size:12px;color:var(--text-muted);padding:20px 0;text-align:center">資料不足</div>
          </div>

        </div>

        <!-- 明細表 -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <div style="max-height:520px;overflow-y:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed">
            <thead>
              <tr style="background:var(--border);font-weight:600;font-size:12px;position:sticky;top:0;z-index:1">
                <th style="padding:8px 12px;text-align:left;background:var(--border);width:32%">任務</th>
                <th style="padding:8px 12px;text-align:left;background:var(--border);width:20%">專案</th>
                <th style="padding:8px 12px;text-align:right;background:var(--border);width:12%">Token 數</th>
                <th style="padding:8px 12px;text-align:left;background:var(--border);width:14%">用戶</th>
                <th style="padding:8px 12px;text-align:left;background:var(--border);width:22%">記錄時間</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="t in visibleTasks" :key="t.ref_key">
                <tr style="border-top:1px solid var(--border);cursor:pointer"
                  @click="toggleTask(t.ref_key)">
                  <td style="padding:8px 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" :title="taskLabel(t)">
                    <span style="margin-right:6px;color:var(--text-muted)">
                      {{ expandedTasks[t.ref_key] ? '▾' : '▸' }}
                    </span>
                    <router-link v-if="taskLink(t)" :to="taskLink(t)" @click.stop
                      style="color:var(--primary);text-decoration:none">{{ taskLabel(t) }}</router-link>
                    <span v-else>{{ taskLabel(t) }}</span>
                  </td>
                  <td style="padding:8px 12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" :title="t.project_name || '—'">{{ t.project_name || '—' }}</td>
                  <td style="padding:8px 12px;text-align:right;font-weight:600" :title="fmtNum(t.total_tokens)">{{ fmtShort(t.total_tokens) }}</td>
                  <td style="padding:8px 12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" :title="t.username || '—'">{{ t.username || '—' }}</td>
                  <td style="padding:8px 12px;color:var(--text-muted);font-size:11px;white-space:nowrap">
                    {{ new Date(t.last_recorded_at).toLocaleString('zh-TW') }}
                  </td>
                </tr>
                <tr v-if="expandedTasks[t.ref_key]"
                  style="background:#f8fafc">
                  <td colspan="5" style="padding:4px 12px 8px 32px">
                    <div v-for="a in t.agents" :key="a.agent_type"
                      style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px;color:var(--text-secondary)">
                      <span :style="{width:'8px',height:'8px',borderRadius:'50%',background:agentColor(a.agent_type),display:'inline-block'}"></span>
                      {{ agentLabel(a.agent_type) }}: <span :title="fmtNum(a.tokens)">{{ fmtShort(a.tokens) }}</span>
                      <span v-if="a.duration_ms" style="color:var(--text-muted)">({{ (a.duration_ms/1000).toFixed(1) }}s)</span>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          </div>
          <div v-if="!report.tasks.length" style="text-align:center;padding:32px;color:var(--text-muted)">
            本期間無 Token 使用記錄
          </div>
          <div v-else-if="report.tasks.length > 100"
            style="text-align:center;padding:8px;font-size:11px;color:var(--text-muted);border-top:1px solid var(--border)">
            僅顯示前 100 筆(共 {{ report.tasks.length }} 筆)
          </div>
        </div>

      </template>
    </div>
  `
});
