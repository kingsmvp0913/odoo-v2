window.AdminRejectionsView = Vue.defineComponent({
  name: 'AdminRejectionsView',
  data() {
    return {
      rows: [],
      total: 0,
      loading: true,
      deleting: false,
      limit: 50,
      offset: 0,
      selected: {},   // { [id]: true }
      expanded: {}    // { [id]: true } 原因展開全文
    };
  },
  computed: {
    selectedIds() { return Object.keys(this.selected).filter(id => this.selected[id]).map(Number); },
    allChecked() { return this.rows.length > 0 && this.rows.every(r => this.selected[r.id]); },
    statusLabel() { return { new: '待分類', classified: '已分類', error: '分類失敗' }; }
  },
  async created() { await this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try {
        const data = await Api.get(`admin/rejections?limit=${this.limit}&offset=${this.offset}`);
        this.rows = data.rows || [];
        this.total = data.total || 0;
        this.selected = {};
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    toggleAll(e) {
      const on = e.target.checked;
      const next = {};
      if (on) this.rows.forEach(r => { next[r.id] = true; });
      this.selected = next;
    },
    toggleExpand(id) { this.expanded = { ...this.expanded, [id]: !this.expanded[id] }; },
    truncate(s) { s = s || ''; return s.length > 120 ? s.slice(0, 120) + '…' : s; },
    fmtTime(ts) { return new Date(ts).toLocaleString('zh-TW'); },
    async prev() { if (this.offset > 0) { this.offset = Math.max(0, this.offset - this.limit); await this.load(); } },
    async next() { if (this.offset + this.limit < this.total) { this.offset += this.limit; await this.load(); } },
    async deleteSelected() {
      const ids = this.selectedIds;
      if (!ids.length) return;
      if (!await confirmDialog({ title: '刪除退回紀錄', message: `確定刪除選取的 ${ids.length} 筆退回原因？分類條目會一併清除，且無法復原。`, danger: true, confirmText: '刪除' })) return;
      this.deleting = true;
      try {
        const r = await Api.post('admin/rejections/delete', { ids });
        await this.load();
        showToast(`已刪除 ${r.deleted} 筆`, 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.deleting = false; }
    }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/admin')" style="margin-right:var(--space-3)">← 返回</button>
      <h1>退回原因管理</h1>
    </div>
    <div class="content">
      <div>
        <div class="settings-section">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3)">
            <h2 class="section-title" style="margin:0">退回紀錄（共 {{ total }}）</h2>
            <button class="btn btn-outline btn-sm" style="color:var(--error)"
              :disabled="selectedIds.length === 0 || deleting" @click="deleteSelected">
              {{ deleting ? '刪除中...' : '刪除選取（' + selectedIds.length + '）' }}
            </button>
          </div>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:32px"><input type="checkbox" :checked="allChecked" @change="toggleAll" /></th>
                  <th style="width:150px">時間</th>
                  <th>專案</th>
                  <th>任務 ID</th>
                  <th>原因</th>
                  <th style="width:80px">狀態</th>
                  <th style="width:60px">來源</th>
                  <th style="width:60px">條目</th>
                  <th>分類明細</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="loading"><td colspan="9" style="text-align:center;color:var(--text-muted)">載入中...</td></tr>
                <tr v-else-if="rows.length === 0" class="empty-row"><td colspan="9">目前沒有退回紀錄</td></tr>
                <tr v-for="r in rows" :key="r.id">
                  <td><input type="checkbox" :checked="!!selected[r.id]" @change="selected = { ...selected, [r.id]: $event.target.checked }" /></td>
                  <td style="font-size:var(--fs-sm);color:var(--text-muted)">{{ fmtTime(r.created_at) }}</td>
                  <td>{{ r.project_name || '—' }}</td>
                  <td style="font-size:var(--fs-sm)">{{ r.task_id }}</td>
                  <td style="font-size:var(--fs-sm)">
                    <span style="white-space:pre-wrap;word-break:break-word">{{ expanded[r.id] ? r.reason : truncate(r.reason) }}</span>
                    <a v-if="(r.reason || '').length > 120" @click="toggleExpand(r.id)"
                      style="cursor:pointer;color:var(--sidebar-accent);margin-left:6px;white-space:nowrap">
                      {{ expanded[r.id] ? '收合' : '展開' }}
                    </a>
                  </td>
                  <td style="font-size:var(--fs-sm)">{{ statusLabel[r.status] || r.status }}</td>
                  <td style="font-size:var(--fs-sm)">{{ r.source === 'qa' ? 'QA' : '人工' }}</td>
                  <td style="text-align:center">{{ r.item_count }}</td>
                  <td style="font-size:var(--fs-sm)">
                    <span v-if="!(r.items && r.items.length)" style="color:var(--text-muted)">—</span>
                    <div v-for="(it, i) in r.items" :key="i"
                      style="display:flex;gap:var(--space-2);align-items:baseline;padding:2px 0">
                      <span class="pill pill-info" style="flex-shrink:0">{{ it.category }}</span>
                      <span style="white-space:pre-wrap;word-break:break-word">{{ it.description }}</span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="total > limit" style="display:flex;align-items:center;gap:var(--space-3);margin-top:var(--space-3)">
            <button class="btn btn-outline btn-sm" :disabled="offset === 0" @click="prev">← 上一頁</button>
            <span style="font-size:var(--fs-sm);color:var(--text-muted)">{{ offset + 1 }}–{{ Math.min(offset + limit, total) }} / {{ total }}</span>
            <button class="btn btn-outline btn-sm" :disabled="offset + limit >= total" @click="next">下一頁 →</button>
          </div>
        </div>
      </div>
    </div>
  `
});
