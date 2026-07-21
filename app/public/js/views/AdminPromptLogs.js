window.AdminPromptLogsView = Vue.defineComponent({
  name: 'AdminPromptLogsView',
  data() {
    return {
      rows: [],
      loading: true,
      limit: 20,
      expanded: {}   // { [id]: true } prompt 展開全文
    };
  },
  async created() { await this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try {
        this.rows = await Api.get(`admin/prompt-logs?limit=${this.limit}`);
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    toggleExpand(id) { this.expanded = { ...this.expanded, [id]: !this.expanded[id] }; },
    truncate(s) { s = s || ''; return s.length > 200 ? s.slice(0, 200) + '…' : s; },
    fmtTime(ts) { return new Date(ts).toLocaleString('zh-TW'); },
    async copy(s) {
      try { await navigator.clipboard.writeText(s || ''); showToast('已複製 prompt', 'success'); }
      catch (_) { showToast('複製失敗', 'error'); }
    }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/admin')" style="margin-right:var(--space-3)">← 返回</button>
      <h1>Prompt 送出記錄</h1>
    </div>
    <div class="content">
      <div>
        <div class="settings-section">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3)">
            <h2 class="section-title" style="margin:0">最近送給 AI 的 prompt（最新 {{ limit }} 筆）</h2>
            <button class="btn btn-outline btn-sm" :disabled="loading" @click="load">
              {{ loading ? '載入中...' : '重新整理' }}
            </button>
          </div>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:150px">時間</th>
                  <th style="width:110px">Agent</th>
                  <th style="width:110px">Model</th>
                  <th style="width:90px">任務 ID</th>
                  <th style="width:70px">字數</th>
                  <th>Prompt 內容</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="loading"><td colspan="6" style="text-align:center;color:var(--text-muted)">載入中...</td></tr>
                <tr v-else-if="rows.length === 0" class="empty-row"><td colspan="6">目前沒有送出記錄</td></tr>
                <tr v-for="r in rows" :key="r.id">
                  <td style="font-size:var(--fs-sm);color:var(--text-muted)">{{ fmtTime(r.created_at) }}</td>
                  <td style="font-size:var(--fs-sm)">{{ r.agent_type || '—' }}</td>
                  <td style="font-size:var(--fs-sm)">{{ r.model || '—' }}</td>
                  <td style="font-size:var(--fs-sm)">{{ r.task_id || '—' }}</td>
                  <td style="font-size:var(--fs-sm);text-align:right">{{ r.char_len }}</td>
                  <td style="font-size:var(--fs-sm)">
                    <pre style="white-space:pre-wrap;word-break:break-word;margin:0;font-family:var(--font-mono, monospace)">{{ expanded[r.id] ? r.prompt : truncate(r.prompt) }}</pre>
                    <div style="margin-top:4px;display:flex;gap:var(--space-3)">
                      <a v-if="(r.prompt || '').length > 200" @click="toggleExpand(r.id)"
                        style="cursor:pointer;color:var(--sidebar-accent);white-space:nowrap">
                        {{ expanded[r.id] ? '收合' : '展開全文' }}
                      </a>
                      <a @click="copy(r.prompt)" style="cursor:pointer;color:var(--sidebar-accent);white-space:nowrap">複製</a>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `
});
