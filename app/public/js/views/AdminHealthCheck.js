// 工作流程健檢（子專案 2）：admin 一鍵，對每個 pipeline agent 出診斷＋建議 prompt。
// 配色一律走 app.css CSS 變數／dark-aware，禁寫死淺色底。
const HC_SEV = {
  ok:     { label: '正常', color: 'var(--success, #059669)' },
  low:    { label: '輕微', color: 'var(--warning, #d97706)' },
  medium: { label: '中等', color: 'var(--warning, #d97706)' },
  high:   { label: '嚴重', color: 'var(--error)' },
  error:  { label: '健檢失敗', color: '#6b7280' }
};

window.AdminHealthCheckView = Vue.defineComponent({
  name: 'AdminHealthCheckView',
  data() {
    return { runId: null, run: null, findings: [], history: [], running: false, windowDays: 30, _timer: null };
  },
  async mounted() { await this.loadHistory(); },
  unmounted() { if (this._timer) clearInterval(this._timer); },
  methods: {
    async loadHistory() {
      try { this.history = await Api.get('admin/health-check'); }
      catch (e) { showToast(e.message, 'error'); }
    },
    async start() {
      this.running = true; this.findings = []; this.run = null;
      try {
        const { runId } = await Api.post('admin/health-check', { windowDays: this.windowDays });
        this.runId = runId;
        this._timer = setInterval(() => this.poll(), 3000);
        await this.poll();
      } catch (e) { showToast(e.message, 'error'); this.running = false; }
    },
    async poll() {
      try {
        const { run, findings } = await Api.get('admin/health-check/' + this.runId);
        this.run = run; this.findings = findings;
        if (run.status !== 'running') {
          clearInterval(this._timer); this._timer = null; this.running = false;
          await this.loadHistory();
        }
      } catch (e) { /* 單次輪詢失敗保留上批，下次恢復 */ }
    },
    async openRun(id) { this.runId = id; await this.poll(); },
    sev(s) { return HC_SEV[s] || HC_SEV.error; },
    applyToEditor(f) {
      if (!f.suggested_prompt) return;
      // 帶入既有 agent 編輯器：以 sessionStorage 暫存建議 prompt，導到 /admin/agents 由該頁預填
      sessionStorage.setItem('agentPrefill', JSON.stringify({ name: f.agent_name, prompt: f.suggested_prompt }));
      this.$router.push('/admin/agents?prefill=' + encodeURIComponent(f.agent_name));
    }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/admin')" style="margin-right:12px">← 返回</button>
      <h1>工作流程健檢</h1>
    </div>
    <div class="content">
      <div style="max-width:1000px">
        <div class="settings-section" style="display:flex;align-items:center;gap:12px;margin-bottom:var(--space-5)">
          <label style="font-size:13px">近
            <input type="number" v-model.number="windowDays" min="1" style="width:64px" class="form-control" /> 天
          </label>
          <button class="btn btn-primary btn-sm" :disabled="running" @click="start">
            {{ running ? '健檢中...' : '開始健檢' }}
          </button>
          <span v-if="run" style="font-size:12px;color:var(--text-muted)">
            狀態：{{ run.status }}（{{ findings.length }} 個 agent 已診斷）
          </span>
        </div>

        <div v-for="f in findings" :key="f.id"
          style="border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);margin-bottom:var(--space-3);background:var(--surface)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-family:monospace;font-weight:600">{{ f.agent_label || f.agent_name }}</span>
            <span :style="{fontSize:'11px',padding:'1px 8px',borderRadius:'4px',color:'#fff',background:sev(f.severity).color}">
              {{ sev(f.severity).label }}
            </span>
          </div>
          <div style="font-size:13px;color:var(--text);margin-bottom:6px">{{ f.diagnosis }}</div>
          <div v-if="f.rationale" style="font-size:12px;color:var(--text-muted);margin-bottom:6px">理由：{{ f.rationale }}</div>
          <button v-if="f.suggested_prompt" class="btn btn-outline btn-sm" @click="applyToEditor(f)">帶入編輯器 →</button>
        </div>

        <div class="settings-section">
          <h2 class="section-title">歷史健檢</h2>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>時間</th><th>視窗</th><th>狀態</th><th>診斷數</th></tr></thead>
              <tbody>
                <tr v-for="h in history" :key="h.id" class="clickable" @click="openRun(h.id)">
                  <td>{{ new Date(h.created_at).toLocaleString() }}</td>
                  <td>{{ h.window_days }} 天</td>
                  <td>{{ h.status }}</td>
                  <td>{{ h.findings_count }}</td>
                </tr>
                <tr v-if="history.length === 0" class="empty-row"><td colspan="4">尚無健檢紀錄</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `
});
