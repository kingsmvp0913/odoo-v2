// 進行中 Pipeline 監控（跨使用者，僅 admin）。資料以後端 _inFlight 為準＝真正在跑的，非 status。
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
    return { rows: [], chats: [], loading: true, pausingId: null, _timer: null };
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
        // 兩區一起取：任一失敗就整批保留上一批（同下方 catch 的理由），不做只更新一半的中間態
        const [list, chats] = await Promise.all([
          Api.get('admin/pipeline/active'),
          Api.get('admin/chat/active')
        ]);
        list.sort((a, b) => b.elapsed_ms - a.elapsed_ms); // 保險：執行最久在最上
        this.rows = list;
        this.chats = chats;
      } catch (e) {
        // 單次輪詢失敗保留上一批，避免閃爍；下次自動恢復
        if (this.loading) showToast(e.message, 'error');
      } finally {
        this.loading = false;
      }
    },
    statusLabel(s) { return STATUS_LABELS[s] || s; },
    fmtElapsed(ms) { return apFmtElapsed(ms); },
    userName(r) { return r.display_name || r.username || `#${r.user_id}`; },
    openChat(c) { this.$router.push(`/projects/${c.project_id}/chat/${c.id}`); },
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
      <div v-if="loading" class="admin-pipelines-wrap">
        <div class="settings-section">
          <h2 class="section-title">真正執行中的任務</h2>
          <!-- 載入態與載入完的表要走同一種手機版型（table-cards-sm），否則骨架先排成
               橫捲的六欄表、資料一到又整個跳成卡片。既然卡片化，每個 td 就得帶 data-label
               ——屬性缺席時 ::before 仍佔位，那 88px 的欄名縮排會空在骨架左邊。 -->
          <div class="table-wrap table-cards-sm">
            <table class="data-table">
              <thead><tr><th>專案</th><th>任務</th><th>使用者</th><th>目前階段</th><th>已執行時間</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="i in 3" :key="i">
                  <td data-label="專案"><Skeleton width="80px" /></td>
                  <td data-label="任務"><Skeleton width="160px" /></td>
                  <td data-label="使用者"><Skeleton width="70px" /></td>
                  <td data-label="目前階段"><Skeleton width="90px" /></td>
                  <td data-label="已執行時間"><Skeleton width="60px" /></td>
                  <td data-label="操作"><Skeleton width="60px" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="settings-section">
          <h2 class="section-title">進行中的排障對話</h2>
          <div class="table-wrap table-cards-sm">
            <table class="data-table">
              <thead><tr><th>專案</th><th>對話</th><th>發問者</th><th>已等待</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="i in 2" :key="i">
                  <td data-label="專案"><Skeleton width="80px" /></td>
                  <td data-label="對話"><Skeleton width="160px" /></td>
                  <td data-label="發問者"><Skeleton width="70px" /></td>
                  <td data-label="已等待"><Skeleton width="60px" /></td>
                  <td data-label="操作"><Skeleton width="60px" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div v-else class="admin-pipelines-wrap">
        <div class="settings-section">
          <h2 class="section-title">真正執行中的任務（{{ rows.length }}）</h2>
          <div class="table-wrap table-cards-sm">
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
                  <td data-label="專案">{{ r.project_name || '—' }}</td>
                  <td data-label="任務" style="font-weight:var(--fw-semibold)">
                    <a style="cursor:pointer" @click="$router.push('/task/' + r.id)">{{ r.title || r.task_id }}</a>
                  </td>
                  <td data-label="使用者">{{ userName(r) }}</td>
                  <td data-label="目前階段">{{ statusLabel(r.status) }}</td>
                  <td data-label="已執行時間" style="font-variant-numeric:tabular-nums">{{ fmtElapsed(r.elapsed_ms) }}</td>
                  <td data-label="操作">
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
        <!-- 排障對話不經 runner，判定走 reply_pending；等太久的通常是卡住的 pending，不是還在想 -->
        <div class="settings-section">
          <h2 class="section-title">進行中的排障對話（{{ chats.length }}）</h2>
          <div class="table-wrap table-cards-sm">
            <table class="data-table">
              <thead>
                <tr>
                  <th>專案</th>
                  <th>對話</th>
                  <th>發問者</th>
                  <th>已等待</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in chats" :key="c.id">
                  <td data-label="專案">{{ c.project_name || '—' }}</td>
                  <td data-label="對話" style="font-weight:var(--fw-semibold)">
                    <a style="cursor:pointer" @click="openChat(c)">{{ c.title }}</a>
                  </td>
                  <td data-label="發問者">{{ userName(c) }}</td>
                  <td data-label="已等待" style="font-variant-numeric:tabular-nums">{{ fmtElapsed(c.waited_ms) }}</td>
                  <td data-label="操作">
                    <button class="btn btn-outline btn-sm" @click="openChat(c)">查看</button>
                  </td>
                </tr>
                <tr v-if="chats.length === 0" class="empty-row">
                  <td colspan="5">目前沒有進行中的排障對話</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `
});
