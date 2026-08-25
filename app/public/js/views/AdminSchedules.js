window.AdminSchedulesView = Vue.defineComponent({
  name: 'AdminSchedulesView',
  data() { return { schedules: [], loading: true }; },
  async created() { await this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try { this.schedules = await Api.get('admin/schedules'); }
      catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    nextText(s) {
      if (!s.enabled) return '已停用';
      if (!s.nextRunAt) return '依條件執行';
      return new Date(s.nextRunAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    }
  },
  template: `
    <div class="page-header">
      <div class="page-header-inner"><h1 class="page-title">排程</h1></div>
    </div>
    <div class="page-body">
      <div v-if="loading" class="loading">載入中...</div>
      <div v-else class="settings-layout">
        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">背景排程總覽</div>
            <div class="setting-block-desc">顯示由平台 cron 派送的全部背景工作；時間一律以臺灣時間呈現。</div>
          </div>
          <div class="setting-block-body">
            <div v-for="s in schedules" :key="s.id" class="schedule-row">
              <div>
                <div style="font-weight:600;color:var(--text)">{{ s.name }}</div>
                <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:var(--space-1)">{{ s.note }}</div>
              </div>
              <div class="schedule-meta">
                <span>{{ s.timing }}</span>
                <span :style="{ color: s.enabled ? 'var(--success)' : 'var(--text-muted)' }">{{ s.enabled ? '啟用中' : '已停用' }}</span>
                <span>下次：{{ nextText(s) }}</span>
              </div>
            </div>
          </div>
          <div class="setting-block-footer">
            <button class="btn btn-secondary btn-sm" @click="load">重新整理</button>
          </div>
        </div>
      </div>
    </div>
  `
});
