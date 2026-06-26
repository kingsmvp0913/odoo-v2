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
      expandedTasks: {}
    };
  },
  computed: {
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
    }
  },
  async created() {
    this.projects = await Api.get('projects').catch(() => []);
    await this.load();
  },
  methods: {
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
    },
    fmtNum(n) { return Number(n || 0).toLocaleString(); },
    toggleTask(key) {
      this.expandedTasks[key] = !this.expandedTasks[key];
    },
    agentColor(type) {
      const map = { cs: '#7c3aed', triage: '#6b7280', analysis: '#2563eb', coding: '#059669',
                    qa: '#d97706', merge: '#db2777', deploy_fix: '#dc2626', wiki: '#0891b2', chat: '#f59e0b' };
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
    // SVG line chart
    linePoints(daily) {
      if (!daily?.length) return '';
      const maxV = Math.max(...daily.map(d => d.tokens), 1);
      const w = 400, h = 120, pad = 20;
      return daily.map((d, i) => {
        const x = pad + (i / Math.max(daily.length - 1, 1)) * (w - 2 * pad);
        const y = h - pad - (d.tokens / maxV) * (h - 2 * pad);
        return `${x},${y}`;
      }).join(' ');
    }
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
            <div style="font-size:24px;font-weight:700;color:var(--primary)">{{ fmtNum(report.summary.total_tokens) }}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px">總 Token 數</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--success)">{{ fmtNum(report.summary.total_tasks) }}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px">任務數</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:var(--warning)">{{ fmtNum(report.summary.avg_tokens_per_task) }}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px">平均每任務</div>
          </div>
        </div>

        <!-- 圖表區 -->
        <div style="display:grid;grid-template-columns:180px 180px 1fr;gap:16px;margin-bottom:20px">

          <!-- Agent 圓餅圖 -->
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">Agent 類型</div>
            <svg width="180" height="180" v-if="report.by_agent.length">
              <path v-for="s in piePath(report.by_agent.map(r=>({value:r.tokens,color:agentColor(r.agent_type),label:r.agent_type})))"
                :key="s.label" :d="s.d" :fill="s.color" opacity="0.9">
                <title>{{ s.label }}: {{ fmtNum(s.value) }}</title>
              </path>
            </svg>
            <div v-for="r in report.by_agent" :key="r.agent_type"
              style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:4px">
              <span :style="{width:'10px',height:'10px',borderRadius:'50%',background:agentColor(r.agent_type),display:'inline-block'}"></span>
              {{ r.agent_type }}: {{ fmtNum(r.tokens) }}
            </div>
          </div>

          <!-- 專案圓餅圖 -->
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">專案分布</div>
            <svg width="180" height="180" v-if="report.by_project.length">
              <path v-for="(s,i) in piePath(report.by_project.map(r=>({value:r.tokens,color:'hsl('+(i*60)+',60%,50%)',label:r.project_name})))"
                :key="s.label" :d="s.d" :fill="s.color" opacity="0.9">
                <title>{{ s.label }}: {{ fmtNum(s.value) }}</title>
              </path>
            </svg>
            <div v-for="(r,i) in report.by_project" :key="r.project_id"
              style="display:flex;align-items:center;gap:6px;font-size:11px;margin-top:4px">
              <span :style="{width:'10px',height:'10px',borderRadius:'50%',background:'hsl('+(i*60)+',60%,50%)',display:'inline-block'}"></span>
              {{ r.project_name }}: {{ fmtNum(r.tokens) }}
            </div>
          </div>

          <!-- 折線圖 -->
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px">
            <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-secondary)">每日趨勢</div>
            <svg width="400" height="120" v-if="report.daily.length > 1">
              <polyline :points="linePoints(report.daily)"
                fill="none" stroke="var(--primary)" stroke-width="2" />
              <circle v-for="(d,i) in report.daily" :key="d.date"
                :cx="20 + (i/Math.max(report.daily.length-1,1))*360"
                :cy="120 - 20 - (d.tokens/Math.max(...report.daily.map(x=>x.tokens),1))*80"
                r="3" fill="var(--primary)">
                <title>{{ d.date }}: {{ fmtNum(d.tokens) }}</title>
              </circle>
            </svg>
            <div v-else style="font-size:12px;color:var(--text-muted);padding:20px 0;text-align:center">資料不足</div>
          </div>
        </div>

        <!-- 明細表 -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="background:var(--border);font-weight:600;font-size:12px">
                <th style="padding:8px 12px;text-align:left">任務</th>
                <th style="padding:8px 12px;text-align:left">專案</th>
                <th style="padding:8px 12px;text-align:left">用戶</th>
                <th style="padding:8px 12px;text-align:right">Token 數</th>
                <th style="padding:8px 12px;text-align:left">記錄時間</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="t in report.tasks" :key="t.task_id || t.project_id">
                <tr style="border-top:1px solid var(--border);cursor:pointer"
                  @click="toggleTask(t.task_id || t.project_id)">
                  <td style="padding:8px 12px">
                    <span style="margin-right:6px;color:var(--text-muted)">
                      {{ expandedTasks[t.task_id || t.project_id] ? '▾' : '▸' }}
                    </span>
                    {{ t.title || t.task_id || '（無標題）' }}
                  </td>
                  <td style="padding:8px 12px;color:var(--text-muted)">{{ t.project_name || '—' }}</td>
                  <td style="padding:8px 12px;color:var(--text-muted)">{{ t.username || '—' }}</td>
                  <td style="padding:8px 12px;text-align:right;font-weight:600">{{ fmtNum(t.total_tokens) }}</td>
                  <td style="padding:8px 12px;color:var(--text-muted);font-size:11px">
                    {{ new Date(t.last_recorded_at).toLocaleString('zh-TW') }}
                  </td>
                </tr>
                <tr v-if="expandedTasks[t.task_id || t.project_id]"
                  style="background:#f8fafc">
                  <td colspan="5" style="padding:4px 12px 8px 32px">
                    <div v-for="a in t.agents" :key="a.agent_type"
                      style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px;color:var(--text-secondary)">
                      <span :style="{width:'8px',height:'8px',borderRadius:'50%',background:agentColor(a.agent_type),display:'inline-block'}"></span>
                      {{ a.agent_type }}: {{ fmtNum(a.tokens) }}
                      <span v-if="a.duration_ms" style="color:var(--text-muted)">({{ (a.duration_ms/1000).toFixed(1) }}s)</span>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <div v-if="!report.tasks.length" style="text-align:center;padding:32px;color:var(--text-muted)">
            本期間無 Token 使用記錄
          </div>
        </div>

      </template>
    </div>
  `
});
