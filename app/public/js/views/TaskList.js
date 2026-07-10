const NEEDS_ACTION = ['confirm_pending', 'cs_data_needed', 'cs_reply_pending', 'merge_conflict', 'review_pending', 'stopped'];
const STATUS_LABELS = {
  new:                '待分類',
  analysis_running:   '分析中',
  branch_pending:     '建立分支',
  confirm_pending:    '等待確認',
  confirm_answered:   '已回覆',
  coding_running:     '開發中',
  qa_running:         'QA 審查中',
  merge_running:      '併入測試中',
  merge_conflict:     '合併衝突',
  deploy_testing:     '部署測試區',
  playwright_running: 'E2E 測試中',
  review_pending:     '等待審核',
  wiki_updating:      '更新 Wiki',
  cs_running:         '客服處理',
  cs_reply_pending:   '等待回覆確認',
  cs_data_needed:     '需補資料',
  done:               '完成',
  stopped:            '失敗待確認'
};

const FLOW_DEV = [
  { label: '分析',  statuses: ['analysis_running', 'branch_pending'] },
  { label: '確認',  statuses: ['confirm_pending', 'confirm_answered'] },
  { label: '開發',  statuses: ['coding_running'] },
  { label: 'QA',    statuses: ['qa_running', 'merge_running'] },
  { label: '測試',  statuses: ['deploy_testing', 'playwright_running'] },
  { label: '審核',  statuses: ['review_pending', 'wiki_updating'] },
  { label: '完成',  statuses: ['done'] },
];
const FLOW_CS = [
  { label: '客服',   statuses: ['cs_running'] },
  { label: '補資料', statuses: ['cs_data_needed'] },
  { label: '確認',   statuses: ['cs_reply_pending'] },
  { label: '完成',   statuses: ['done'] },
];
const STOPPED_STATUSES = ['stopped', 'merge_conflict'];

function statusLabel(status) { return STATUS_LABELS[status] || status; }
function timeAgo(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return '剛剛';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分鐘前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小時前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

const CS_ACTIVE_STATUSES = ['cs_running', 'cs_data_needed', 'cs_reply_pending'];

const StatusBar = Vue.defineComponent({
  name: 'StatusBar',
  props: { status: String, source: String },
  computed: {
    isNew()     { return this.status === 'new'; },
    isStopped() { return STOPPED_STATUSES.includes(this.status); },
    flow() {
      if (CS_ACTIVE_STATUSES.includes(this.status)) return FLOW_CS;
      if (this.status === 'done' && this.source === 'service') return FLOW_CS;
      return FLOW_DEV;
    },
    activeIdx() {
      if (this.status === 'done') return this.flow.length;
      const idx = this.flow.findIndex(s => s.statuses.includes(this.status));
      return idx === -1 ? 0 : idx;
    }
  },
  template: `
    <div v-if="!isNew" class="stepper">
      <template v-for="(step, i) in flow" :key="i">
        <div class="step-node" :class="{
          'sn-done':   !isStopped && i < activeIdx,
          'sn-active': !isStopped && i === activeIdx,
          'sn-error':  isStopped,
          'sn-future': !isStopped && i > activeIdx
        }">
          <div class="step-circle">
            <span v-if="isStopped">✕</span>
            <span v-else-if="i < activeIdx">✓</span>
            <span v-else>{{ i + 1 }}</span>
          </div>
          <div class="step-label">{{ step.label }}</div>
        </div>
        <div v-if="i < flow.length - 1" class="step-connector"
          :class="{ 'sc-done': !isStopped && i < activeIdx, 'sc-error': isStopped }">
        </div>
      </template>
    </div>
  `
});

window.TaskListView = Vue.defineComponent({
  name: 'TaskListView',
  components: { StatusBar },
  data() {
    return {
      tasks: [],
      archivedTasks: [],
      filter: 'needs_action',
      search: '',
      loading: true,
      syncing: false,
      testMode: false,
      stepping: false,
      odooUrl: '',
      serviceUrl: '',
      isAdmin: false,
      batchMode: false,
      selectedIds: [],
      batchWorking: false,
      showAdd: false,
      adding: false,
      projects: [],
      newTask: { title: '', original_text: '', project_id: '' }
    };
  },
  computed: {
    filteredTasks() {
      let list;
      if (this.filter === 'archived')          list = this.archivedTasks;
      else if (this.filter === 'paused')       list = this.tasks.filter(t => t.is_paused);
      else if (this.filter === 'needs_action') list = this.tasks.filter(t => NEEDS_ACTION.includes(t.status) && (t.status === 'stopped' || !t.is_paused));
      else if (this.filter === 'review_pending') list = this.tasks.filter(t => t.status === 'review_pending' && !t.is_paused);
      else                                     list = this.tasks; // 全部 = 含暫停中
      const q = this.search.toLowerCase().trim();
      if (!q) return list;
      return list.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.task_id || '').toLowerCase().includes(q) ||
        (t.source || '').toLowerCase().includes(q) ||
        (t.module || '').toLowerCase().includes(q) ||
        (t.project_name || '').toLowerCase().includes(q)
      );
    },
    needsActionCount() { return this.tasks.filter(t => NEEDS_ACTION.includes(t.status) && (t.status === 'stopped' || !t.is_paused)).length; },
    reviewPendingCount() { return this.tasks.filter(t => t.status === 'review_pending' && !t.is_paused).length; },
    pausedCount() { return this.tasks.filter(t => t.is_paused).length; },
    allCount()    { return this.tasks.length; },
    allSelected() {
      return this.filteredTasks.length > 0 && this.filteredTasks.every(t => this.selectedIds.includes(t.id));
    }
  },
  watch: {
    needsActionCount(v) { window.needsActionCount.value = v; },
    filter() { this.selectedIds = []; this.batchMode = false; this.load(); }
  },
  async created() {
    await this.load();
    Api.get('system/config').then(r => {
      this.testMode = !!r.test_mode;
      this.odooUrl = r.odoo_url || '';
      this.serviceUrl = r.service_url || '';
    }).catch(() => {});
    Api.get('auth/me').then(r => { this.isAdmin = r.role === 'admin'; }).catch(() => {});
    Api.get('projects').then(r => { this.projects = r || []; }).catch(() => {});
  },
  mounted() { SocketManager.setRefreshCallback(this.refresh.bind(this)); },
  beforeUnmount() { SocketManager.setRefreshCallback(null); },
  methods: {
    async load() {
      this.loading = true;
      try {
        if (this.filter === 'archived') {
          const data = await Api.get('tasks?archived=true');
          this.archivedTasks = data.tasks || data;
        } else {
          const data = await Api.get('tasks');
          this.tasks = data.tasks || data;
          window.needsActionCount.value = this.needsActionCount;
        }
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    needsAction(t) { return NEEDS_ACTION.includes(t.status); },
    isProcessing(t) {
      return ['analysis_running','coding_running','qa_running','merge_running','deploy_testing','playwright_running','wiki_updating','cs_running','branch_pending','confirm_answered'].includes(t.status);
    },
    isStopped(t) { return ['stopped'].includes(t.status); },
    statusLabel,
    timeAgo,
    openTask(t) { this.$router.push(`/task/${t.id}`); },
    openAdd() {
      this.newTask = { title: '', original_text: '', project_id: '' };
      this.showAdd = true;
    },
    async submitAdd() {
      if (!this.newTask.project_id) return showToast('請選擇專案', 'error');
      if (!this.newTask.title.trim()) return showToast('請填寫標題', 'error');
      if (!this.newTask.original_text.trim()) return showToast('請填寫內容', 'error');
      this.adding = true;
      try {
        await Api.post('tasks', {
          title: this.newTask.title.trim(),
          original_text: this.newTask.original_text,
          project_id: this.newTask.project_id || null
        });
        this.showAdd = false;
        this.filter = 'all';
        await this.load();
        showToast('已新增任務，將於下輪 pipeline 自動分診', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.adding = false; }
    },
    async syncNow() {
      this.syncing = true;
      try {
        const res = await Api.post('sync/now', {});
        const total = (res.odoo?.added || 0) + (res.service?.added || 0);
        const errors = [
          res.odoo?.error    ? `Odoo：${res.odoo.error}`    : null,
          res.service?.error ? `客服：${res.service.error}` : null
        ].filter(Boolean);
        if (errors.length) {
          showToast(`同步失敗 — ${errors.join('；')}`, 'error');
        } else {
          const detail = [
            res.odoo?.found    != null ? `Odoo 找到 ${res.odoo.found} 筆`    : null,
            res.service?.found != null ? `客服 找到 ${res.service.found} 筆`  : null
          ].filter(Boolean).join('，');
          showToast(`同步完成，新增 ${total} 筆${detail ? `（${detail}）` : ''}`, total > 0 ? 'success' : 'info');
        }
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.syncing = false; }
    },
    async togglePause(t, e) {
      e.stopPropagation();
      try {
        const r = await Api.put(`tasks/${t.id}/pause`, {});
        t.is_paused = r.is_paused;
        showToast(r.is_paused ? '任務已暫停，Pipeline 將跳過' : '任務已恢復', r.is_paused ? 'warn' : 'success');
      } catch (err) { showToast(err.message, 'error'); }
    },
    async stepPipeline() {
      this.stepping = true;
      try {
        await Api.post('pipeline/step', {});
        showToast('已觸發推進，處理中…（進度即時更新）', 'info');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.stepping = false; }
    },
    sourceUrl(t) {
      const id = (t.task_id || '').match(/(\d+)$/)?.[1];
      if (!id) return null;
      if (t.source === 'odoo' && this.odooUrl)
        return `${this.odooUrl}/web#id=${id}&action=524&model=project.task&view_type=form`;
      if (t.source === 'service' && this.serviceUrl)
        return `${this.serviceUrl}/web?debug=0#action=114&cids=1&id=${id}&menu_id=87&model=service.question.feedback&view_type=form`;
      return null;
    },
    sourceLabel(source) {
      return source === 'odoo' ? 'Odoo' : source === 'service' ? 'eService' : source === 'manual' ? '手動增加' : source;
    },
    sourceBadgeClass(source) {
      if (source === 'odoo')    return 'src-badge src-odoo';
      if (source === 'service') return 'src-badge src-service';
      return 'src-badge src-default';
    },
    async archiveTask(t, e) {
      e.stopPropagation();
      if (!await confirmDialog({ title: '封存任務', message: `確定要封存任務「${t.title || t.task_id}」？封存後可在「已封存」分頁查看。`, confirmText: '封存' })) return;
      try {
        await Api.post(`tasks/${t.id}/archive`, {});
        this.tasks = this.tasks.filter(x => x.id !== t.id);
        showToast('任務已封存', 'warn');
      } catch (err) { showToast(err.message, 'error'); }
    },
    async unarchiveTask(t, e) {
      e.stopPropagation();
      try {
        await Api.post(`tasks/${t.id}/unarchive`, {});
        this.archivedTasks = this.archivedTasks.filter(x => x.id !== t.id);
        showToast('任務已解除封存', 'success');
      } catch (err) { showToast(err.message, 'error'); }
    },
    async deleteTask(t, e) {
      e.stopPropagation();
      if (!await confirmDialog({ title: '永久刪除任務', message: `確定要永久刪除任務「${t.title || t.task_id}」？刪除後可重新同步匯入。`, danger: true, confirmText: '刪除' })) return;
      try {
        const r = await Api.delete(`tasks/${t.id}`);
        this.tasks = this.tasks.filter(x => x.id !== t.id);
        showToast('任務已刪除，重新同步可重新匯入', 'warn');
        (r.warnings || []).forEach(w => showToast(w, 'warn', 9000));
      } catch (err) { showToast(err.message, 'error'); }
    },
    toggleBatchMode() {
      this.batchMode = !this.batchMode;
      if (!this.batchMode) this.selectedIds = [];
    },
    toggleSelect(id, e) {
      e.stopPropagation();
      const idx = this.selectedIds.indexOf(id);
      if (idx === -1) this.selectedIds.push(id);
      else this.selectedIds.splice(idx, 1);
    },
    toggleSelectAll() {
      if (this.allSelected) this.selectedIds = [];
      else this.selectedIds = this.filteredTasks.map(t => t.id);
    },
    async batchDelete() {
      if (!this.selectedIds.length) return;
      if (!await confirmDialog({ title: '批次刪除', message: `確定永久刪除選取的 ${this.selectedIds.length} 筆任務？`, danger: true, confirmText: '刪除' })) return;
      this.batchWorking = true;
      try {
        const r = await Api.post('tasks/batch/delete', { ids: this.selectedIds });
        showToast(`已刪除 ${r.affected} 筆任務`, 'warn');
        (r.warnings || []).forEach(w => showToast(w, 'warn', 9000));
        this.selectedIds = [];
        await this.load();
      } catch (err) { showToast(err.message, 'error'); }
      finally { this.batchWorking = false; }
    },
    async batchPause() {
      if (!this.selectedIds.length) return;
      this.batchWorking = true;
      try {
        const r = await Api.post('tasks/batch/pause', { ids: this.selectedIds, paused: true });
        showToast(`已暫停 ${r.affected} 筆任務`, 'warn');
        this.selectedIds = [];
        await this.load();
      } catch (err) { showToast(err.message, 'error'); }
      finally { this.batchWorking = false; }
    },
    async batchArchive() {
      if (!this.selectedIds.length) return;
      if (!await confirmDialog({ title: '批次封存', message: `確定封存選取的 ${this.selectedIds.length} 筆任務？`, confirmText: '封存' })) return;
      this.batchWorking = true;
      try {
        const r = await Api.post('tasks/batch/archive', { ids: this.selectedIds });
        showToast(`已封存 ${r.affected} 筆任務`, 'warn');
        this.selectedIds = [];
        await this.load();
      } catch (err) { showToast(err.message, 'error'); }
      finally { this.batchWorking = false; }
    },
    async batchUnarchive() {
      if (!this.selectedIds.length) return;
      this.batchWorking = true;
      try {
        const r = await Api.post('tasks/batch/unarchive', { ids: this.selectedIds });
        showToast(`已解除封存 ${r.affected} 筆任務`, 'success');
        this.selectedIds = [];
        await this.load();
      } catch (err) { showToast(err.message, 'error'); }
      finally { this.batchWorking = false; }
    },
    refresh() {
      Api.get('tasks').then(data => {
        this.tasks = data.tasks || data;
        window.needsActionCount.value = this.needsActionCount;
      }).catch(() => {});
      if (this.filter === 'archived') {
        Api.get('tasks?archived=true').then(data => { this.archivedTasks = data.tasks || data; }).catch(() => {});
      }
    }
  },
  template: `
    <div class="topbar">
      <h1>任務列表</h1>
      <button class="btn btn-primary btn-sm" @click="openAdd">＋ 新增任務</button>
      <span v-if="testMode" class="pill pill-warn" style="font-size:var(--fs-sm);padding:2px 8px">🧪 測試模式</span>
      <button v-if="testMode" class="btn btn-primary btn-sm" @click="stepPipeline" :disabled="stepping">
        {{ stepping ? '執行中...' : '▶ 推進 Pipeline' }}
      </button>
      <button v-if="isAdmin" class="btn btn-sm" :class="batchMode ? 'btn-primary' : 'btn-outline'" @click="toggleBatchMode">
        {{ batchMode ? '✕ 取消批次' : '☑ 批次' }}
      </button>
      <button class="btn btn-outline btn-sm" @click="syncNow" :disabled="syncing">
        {{ syncing ? '同步中...' : '⟳ 手動同步' }}
      </button>
    </div>
    <div class="content">
      <div style="display:flex;gap:var(--space-2);margin-bottom:var(--space-3);flex-wrap:wrap;align-items:center">
        <button class="btn btn-sm" :class="filter==='needs_action' ? 'btn-primary' : 'btn-outline'" @click="filter='needs_action'">
          需回覆<span v-if="needsActionCount > 0" class="tab-badge" :class="filter==='needs_action' ? 'tab-badge-active' : ''">{{ needsActionCount }}</span>
        </button>
        <button class="btn btn-sm" :class="filter==='review_pending' ? 'btn-primary' : 'btn-outline'" @click="filter='review_pending'">
          待審核<span v-if="reviewPendingCount > 0" class="tab-badge" :class="filter==='review_pending' ? 'tab-badge-active' : ''">{{ reviewPendingCount }}</span>
        </button>
        <button class="btn btn-sm" :class="filter==='all' ? 'btn-primary' : 'btn-outline'" @click="filter='all'">
          全部<span class="tab-badge" :class="filter==='all' ? 'tab-badge-active' : ''">{{ allCount }}</span>
        </button>
        <button class="btn btn-sm" :class="filter==='paused' ? 'btn-primary' : 'btn-outline'" @click="filter='paused'">
          暫停中<span v-if="pausedCount > 0" class="tab-badge" :class="filter==='paused' ? 'tab-badge-active' : ''">{{ pausedCount }}</span>
        </button>
        <button class="btn btn-sm" :class="filter==='archived' ? 'btn-primary' : 'btn-outline'" @click="filter='archived'">已封存</button>
        <input v-model="search" placeholder="搜尋任務標題、來源..." class="form-control"
          style="width:240px;font-size:var(--fs-base);padding:5px 10px;height:32px" />
      </div>

      <div v-if="batchMode" style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-2);padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--fs-base)">
        <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" style="width:16px;height:16px;cursor:pointer">
        <span style="color:var(--text-muted)">{{ allSelected ? '取消全選' : '全選' }}（已選 {{ selectedIds.length }} / {{ filteredTasks.length }} 筆）</span>
      </div>

      <div v-if="loading">
        <div class="task-card" v-for="i in 4" :key="i">
          <div class="task-header">
            <Skeleton width="220px" height="16px" />
          </div>
          <div style="display:flex;gap:6px">
            <Skeleton width="56px" height="18px" radius="10px" />
            <Skeleton width="90px" height="18px" radius="10px" />
          </div>
        </div>
      </div>
      <div v-else-if="filteredTasks.length === 0" class="empty-state">
        <div style="font-size:32px">📭</div>
        <p>{{ search ? '沒有符合搜尋的任務' : filter === 'needs_action' ? '沒有待回覆的任務' : filter === 'review_pending' ? '沒有待審核的任務' : '沒有任務' }}</p>
      </div>
      <div v-else>
        <div v-for="t in filteredTasks" :key="t.id"
          class="task-card"
          :class="{ 'needs-action': needsAction(t) && !isStopped(t) && !t.is_paused && !batchMode, 'stopped': isStopped(t), 'paused': t.is_paused, 'processing': isProcessing(t) && !t.is_paused, 'batch-selected': batchMode && selectedIds.includes(t.id) }"
          @click="batchMode ? toggleSelect(t.id, $event) : openTask(t)">
          <div class="task-header">
            <div class="task-title" style="display:flex;align-items:center;gap:var(--space-2)">
              <input v-if="batchMode" type="checkbox" :checked="selectedIds.includes(t.id)"
                @click.stop="toggleSelect(t.id, $event)"
                style="width:16px;height:16px;cursor:pointer;flex-shrink:0">
              <span v-if="!batchMode && isProcessing(t) && !t.is_paused" class="spinner"></span>
              <span v-else-if="!batchMode && needsAction(t) && !isStopped(t) && !t.is_paused" class="pulse-dot"></span>
              {{ t.title || t.task_id }}
            </div>
            <div v-if="!batchMode" style="display:flex;align-items:center;gap:6px">
              <button v-if="!isStopped(t) && t.status !== 'done'" class="btn btn-ghost btn-sm"
                :style="{ color: t.is_paused ? 'var(--warning)' : 'var(--text-muted)', fontSize: 'var(--fs-sm)', padding: '2px 8px' }"
                @click="togglePause(t, $event)"
                :title="t.is_paused ? '點擊恢復' : '點擊暫停'">
                {{ t.is_paused ? '▐▐ 已暫停' : '⏸ 暫停' }}
              </button>
              <template v-if="isAdmin && filter !== 'archived'">
                <button class="btn btn-ghost btn-sm"
                  style="color:var(--text-muted);font-size:var(--fs-sm);padding:2px 8px"
                  @click="archiveTask(t, $event)" title="封存任務">⊞ 封存</button>
                <button v-if="!t.approved_at" class="btn btn-ghost btn-sm"
                  style="color:var(--danger);font-size:var(--fs-sm);padding:2px 8px"
                  @click="deleteTask(t, $event)" title="永久刪除（可重新同步匯入）">✕ 刪除</button>
              </template>
              <template v-if="isAdmin && filter === 'archived'">
                <button class="btn btn-ghost btn-sm"
                  style="color:var(--success);font-size:var(--fs-sm);padding:2px 8px"
                  @click="unarchiveTask(t, $event)" title="解除封存，回到主列表">↩ 解封存</button>
                <button v-if="!t.approved_at" class="btn btn-ghost btn-sm"
                  style="color:var(--danger);font-size:var(--fs-sm);padding:2px 8px"
                  @click="deleteTask(t, $event)" title="永久刪除（可重新同步匯入）">✕ 刪除</button>
              </template>
              <div class="task-meta">{{ timeAgo(t.updated_at || t.created_at) }}</div>
            </div>
          </div>
          <div class="task-source" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <a v-if="sourceUrl(t)" :href="sourceUrl(t)" target="_blank" @click.stop
               :class="sourceBadgeClass(t.source)">{{ sourceLabel(t.source) }}</a>
            <span v-else :class="sourceBadgeClass(t.source)">{{ sourceLabel(t.source) }}</span>
            <span v-if="t.project_id && t.project_name" class="proj-chip"
                  @click.stop="$router.push('/projects/' + t.project_id)">
              {{ t.project_name }}
            </span>
            <a v-if="t.env_url" :href="t.env_url" target="_blank" @click.stop class="env-chip">
              🖥 測試機
            </a>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <div style="display:flex;align-items:center;gap:6px">
              <span class="status-badge" :class="t.status">{{ statusLabel(t.status) }}</span>
              <span v-if="t.is_paused" class="pill pill-warn">暫停中</span>
            </div>
            <span v-if="t.module" style="font-size:var(--fs-xs);color:var(--text-muted)">{{ t.module }}</span>
          </div>
          <StatusBar :status="t.status" :source="t.source" />
        </div>
      </div>

      <!-- Batch action bar -->
      <div v-if="batchMode && selectedIds.length > 0"
        style="position:fixed;bottom:20px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:var(--space-2);background:#1e293b;color:#fff;border-radius:var(--radius-lg);padding:10px 18px;box-shadow:0 4px 20px rgba(0,0,0,0.3);z-index:200;font-size:var(--fs-base);white-space:nowrap">
        <span style="margin-right:var(--space-1);font-weight:var(--fw-semibold)">{{ selectedIds.length }} 筆已選</span>
        <button class="btn btn-sm" style="background:var(--warning);color:#fff;border:none"
          @click="batchPause" :disabled="batchWorking">⏸ 暫停</button>
        <template v-if="filter !== 'archived'">
          <button class="btn btn-sm" style="background:#64748b;color:#fff;border:none"
            @click="batchArchive" :disabled="batchWorking">⊞ 封存</button>
        </template>
        <template v-else>
          <button class="btn btn-sm" style="background:var(--success);color:#fff;border:none"
            @click="batchUnarchive" :disabled="batchWorking">↩ 解封存</button>
        </template>
        <button class="btn btn-sm" style="background:var(--danger);color:#fff;border:none"
          @click="batchDelete" :disabled="batchWorking">✕ 刪除</button>
      </div>
    </div>

    <!-- 新增任務 modal -->
    <div v-if="showAdd" @click.self="showAdd=false"
      style="position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:1000">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:28px;width:640px;max-width:94vw;max-height:90vh;overflow:auto;box-shadow:0 12px 48px rgba(0,0,0,0.4)">
        <h2 style="margin:0 0 20px;font-size:var(--fs-xl)">新增任務</h2>

        <label style="display:block;font-size:var(--fs-base);font-weight:var(--fw-semibold);margin-bottom:6px">專案 <span style="color:var(--danger)">*</span></label>
        <select v-model="newTask.project_id" class="form-control" style="width:100%;height:36px;font-size:var(--fs-md);margin-bottom:18px">
          <option value="" disabled>請選擇專案</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>

        <label style="display:block;font-size:var(--fs-base);font-weight:var(--fw-semibold);margin-bottom:6px">標題 <span style="color:var(--danger)">*</span></label>
        <input v-model="newTask.title" class="form-control" placeholder="任務標題"
          style="width:100%;height:36px;font-size:var(--fs-md);margin-bottom:18px" @keyup.enter="submitAdd" />

        <label style="display:block;font-size:var(--fs-base);font-weight:var(--fw-semibold);margin-bottom:6px">內容 <span style="color:var(--danger)">*</span></label>
        <textarea v-model="newTask.original_text" class="form-control" placeholder="需求描述（給分診/分析 Agent 參考）"
          style="width:100%;min-height:180px;font-size:var(--fs-md);line-height:1.6;resize:vertical;margin-bottom:20px"></textarea>

        <div style="display:flex;justify-content:flex-end;gap:var(--space-2)">
          <button class="btn btn-outline btn-sm" @click="showAdd=false" :disabled="adding">取消</button>
          <button class="btn btn-primary btn-sm" @click="submitAdd" :disabled="adding">
            {{ adding ? '新增中...' : '新增' }}
          </button>
        </div>
      </div>
    </div>
  `
});
