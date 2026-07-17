window.AdminClassifySamplesView = Vue.defineComponent({
  name: 'AdminClassifySamplesView',
  data() {
    return {
      days: 14,
      total: 0,
      byVerdict: [],
      topPatterns: [],
      recent: [],
      loading: true
    };
  },
  async created() { await this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try {
        const d = await Api.get(`admin/classify-samples?days=${this.days}`);
        this.total = d.total || 0;
        this.byVerdict = d.byVerdict || [];
        this.topPatterns = d.topPatterns || [];
        this.recent = d.recent || [];
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    fmtTime(ts) { return new Date(ts).toLocaleString('zh-TW'); },
    verdictLabel(v) { return { transient: '暫時性', env: '環境', code: '程式' }[v] || v; }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/admin')" style="margin-right:var(--space-3)">← 返回</button>
      <h1>失敗分類樣本</h1>
    </div>
    <div class="content">
      <div style="max-width:1000px">
        <div class="settings-section">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-3)">
            <p style="margin:0;font-size:var(--fs-sm);color:var(--text-muted)">
              regex 判不出、交 haiku 分類的案例。看高頻 pattern → 補進 failure-classifier 的 regex，讓 haiku 呼叫量下降。
            </p>
            <select v-model.number="days" @change="load" class="field-input" style="width:auto">
              <option :value="7">近 7 天</option>
              <option :value="14">近 14 天</option>
              <option :value="30">近 30 天</option>
              <option :value="90">近 90 天</option>
            </select>
          </div>

          <div v-if="loading" class="loading">載入中...</div>
          <div v-else-if="total === 0" class="empty-row" style="padding:var(--space-5);text-align:center;color:var(--text-muted)">
            這段期間沒有樣本——代表 regex 幾乎攔下所有失敗，haiku 很少被叫到（這是好事）。
          </div>
          <template v-else>

            <!-- 判定分佈 -->
            <h2 class="section-title" style="margin:0 0 var(--space-2)">判定分佈（共 {{ total }}）</h2>
            <div class="table-wrap" style="margin-bottom:var(--space-5)">
              <table class="data-table">
                <thead><tr><th>判定</th><th style="width:140px">haiku 是否判出</th><th style="width:80px">筆數</th></tr></thead>
                <tbody>
                  <tr v-for="(r, i) in byVerdict" :key="i">
                    <td>{{ verdictLabel(r.verdict) }}</td>
                    <td style="font-size:var(--fs-sm)">
                      <span v-if="r.agent_ok" style="color:var(--success)">✓ haiku 判定</span>
                      <span v-else style="color:var(--text-muted)">— 預設 env（haiku 沒判出）</span>
                    </td>
                    <td style="text-align:center">{{ r.n }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 高頻真因 -->
            <h2 class="section-title" style="margin:0 0 var(--space-2)">高頻真因（前 80 字）— 復發最多的優先補進 regex</h2>
            <div class="table-wrap" style="margin-bottom:var(--space-5)">
              <table class="data-table">
                <thead><tr><th style="width:60px">次數</th><th>錯誤文字（前 80 字）</th><th style="width:150px">最近一次</th></tr></thead>
                <tbody>
                  <tr v-for="(p, i) in topPatterns" :key="i">
                    <td style="text-align:center;font-weight:600">{{ p.n }}</td>
                    <td style="font-size:var(--fs-sm);font-family:monospace;word-break:break-word">{{ p.pattern }}</td>
                    <td style="font-size:var(--fs-sm);color:var(--text-muted)">{{ fmtTime(p.last_seen) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 近期樣本 -->
            <h2 class="section-title" style="margin:0 0 var(--space-2)">近期樣本（最新 50 筆）</h2>
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr><th style="width:150px">時間</th><th style="width:110px">任務</th><th style="width:70px">判定</th><th>錯誤文字</th></tr>
                </thead>
                <tbody>
                  <tr v-for="r in recent" :key="r.id">
                    <td style="font-size:var(--fs-sm);color:var(--text-muted)">{{ fmtTime(r.recorded_at) }}</td>
                    <td style="font-size:var(--fs-sm)">{{ r.task_id || '—' }}</td>
                    <td style="font-size:var(--fs-sm)">{{ verdictLabel(r.verdict) }}{{ r.agent_ok ? '' : '*' }}</td>
                    <td style="font-size:var(--fs-sm);font-family:monospace;white-space:pre-wrap;word-break:break-word">{{ r.error_text }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:var(--space-2)">判定後的 * 表示 haiku 沒判出、只落預設 env。</p>

          </template>
        </div>
      </div>
    </div>
  `
});
