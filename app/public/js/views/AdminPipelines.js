// 進行中 Pipeline 監控（跨使用者，僅 admin）。資料以後端 _inFlight 為準＝真正在跑的，非 status。
const AP_STATUS_LABELS = {
  new:                '待分類',
  cs_running:         '客服處理',
  analysis_running:   '分析中',
  confirm_answered:   '已回覆',
  branch_pending:     '建立分支',
  coding_running:     '開發中',
  qa_running:         'QA 審查中',
  merge_running:      '併入測試中',
  deploy_testing:     '部署測試區',
  playwright_running: 'E2E 測試中',
  wiki_updating:      '更新 Wiki',
  reject_triage:      '退回分診中'
};

function apFmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

window.AdminPipelinesView = Vue.defineComponent({
  name: 'AdminPipelinesView',
  data() {
    return { rows: [], loading: true, pausingId: null, _timer: null };
  },
  async mounted() {
    await this.load();
    this._timer = setInterval(() => this.load(), 3000);
  },
  unmounted() {
    if (this._timer) clearInterval(this._timer);
  },
  methods: {
    async load() {
      try {
        const list = await Api.get('admin/pipeline/active');
        list.sort((a, b) => b.elapsed_ms - a.elapsed_ms); // 保險：執行最久在最上
        this.rows = list;
      } catch (e) {
        // 單次輪詢失敗保留上一批，避免閃爍；下次自動恢復
        if (this.loading) showToast(e.message, 'error');
      } finally {
        this.loading = false;
      }
    },
    statusLabel(s) { return AP_STATUS_LABELS[s] || s; },
    fmtElapsed(ms) { return apFmtElapsed(ms); },
    userName(r) { return r.display_name || r.username || `#${r.user_id}`; },
    async pause(row) {
      if (!await confirmDialog({ title: '暫停行程', message: `確定暫停並中止「${row.title || row.task_id}」正在執行的行程？`, danger: true, confirmText: '暫停並中止' })) return;
      this.pausingId = row.id;
      try {
        await Api.post(`admin/pipeline/tasks/${row.id}/pause`);
        showToast('已暫停並中止行程', 'success');
        await this.load();
      } catch (e) {
        showToast(e.message, 'error');
        await this.load();
      } finally {
        this.pausingId = null;
      }
    }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/admin')" style="margin-right:var(--space-3)">← 返回</button>
      <h1>進行中 Pipeline</h1>
    </div>
    <div class="content">
      <div v-if="loading" style="max-width:1000px">
        <div class="settings-section">
          <h2 class="section-title">真正執行中的任務</h2>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>專案</th><th>任務</th><th>使用者</th><th>目前階段</th><th>已執行時間</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="i in 3" :key="i">
                  <td><Skeleton width="80px" /></td>
                  <td><Skeleton width="160px" /></td>
                  <td><Skeleton width="70px" /></td>
                  <td><Skeleton width="90px" /></td>
                  <td><Skeleton width="60px" /></td>
                  <td><Skeleton width="60px" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div v-else style="max-width:1000px">
        <div class="settings-section">
          <h2 class="section-title">真正執行中的任務（{{ rows.length }}）</h2>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>專案</th>
                  <th>任務</th>
                  <th>使用者</th>
                  <th>目前階段</th>
                  <th>已執行時間</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rows" :key="r.id">
                  <td>{{ r.project_name || '—' }}</td>
                  <td style="font-weight:var(--fw-semibold)">
                    <a style="cursor:pointer" @click="$router.push('/task/' + r.id)">{{ r.title || r.task_id }}</a>
                  </td>
                  <td>{{ userName(r) }}</td>
                  <td>{{ statusLabel(r.status) }}</td>
                  <td style="font-variant-numeric:tabular-nums">{{ fmtElapsed(r.elapsed_ms) }}</td>
                  <td>
                    <button class="btn btn-outline btn-sm" style="color:var(--error)"
                      :disabled="pausingId === r.id" @click="pause(r)">
                      {{ pausingId === r.id ? '處理中...' : '暫停' }}
                    </button>
                  </td>
                </tr>
                <tr v-if="rows.length === 0" class="empty-row">
                  <td colspan="6">目前沒有執行中的 pipeline</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `
});
