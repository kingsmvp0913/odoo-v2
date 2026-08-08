// 收件匣：「發生過什麼」的事件流。
//
// 與導覽列「輪到你」badge 刻意並存、語意不同：badge 是**當前狀態的快照**（現在有幾張等你），
// 收件匣是**事件流**（這段時間發生過什麼）。離開兩小時回來看到任務停在「開發中」看起來正常，
// 但這兩小時它可能被 QA 退一次、重跑、又被部署退一次——badge 上完全看不出來。
window.InboxView = Vue.defineComponent({
  name: 'InboxView',
  data() {
    return { items: [], loading: true, showAll: false };
  },
  computed: {
    // 同一任務連續的 bounce 收合成一則並顯示次數。不收合的話，鬼打牆的任務會用重複訊息洗版
    // 整個收件匣——而「它到底退了幾次」正是要凸顯的訊號，不是要被自己的噪音淹掉。
    // 只收合「連續」的：中間夾了別的事件就分開，時間順序才不會被壓扁。
    grouped() {
      const out = [];
      for (const it of this.items) {
        const prev = out[out.length - 1];
        if (prev && prev.kind === 'bounce' && it.kind === 'bounce' && prev.task_id === it.task_id) {
          prev.count += 1;
          prev.ids.push(it.id);
          continue;
        }
        out.push({ ...it, count: 1, ids: [it.id] });
      }
      return out;
    },
    // 篩選頁籤上的數字與側欄 badge 必須是同一個數，所以同樣只認後端的 COUNT 端點。
    // 從本頁 items 數未讀會犯與 syncBadge 一樣的錯：showAll=true 時 items 是「最近 100 筆」
    // 含已讀，切一下頁籤數字就變一個——而使用者正在比對的就是這兩個數字。
    unreadTotal() { return window.inboxUnread ? window.inboxUnread.value : 0; },
  },
  async created() { await this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try {
        this.items = await Api.get(`inbox${this.showAll ? '?all=1' : ''}`) || [];
        this.syncBadge();
      } catch (e) {
        showToast(e.message || '收件匣載入失敗', 'error');
      } finally {
        this.loading = false;
      }
    },
    async toggleAll() { this.showAll = !this.showAll; await this.load(); },
    // 頁籤式篩選：點已選中的那個不該重打一次 API（任務列表的頁籤同樣是設值而非切換）。
    async setShowAll(v) { if (this.showAll !== v) await this.toggleAll(); },
    // badge 一律問後端的 COUNT 端點，不用本頁的 items 推算：showAll=true 時 items 是「最近 100 筆」
    // （含已讀），從中數未讀等於換一種算法 → 按一下切換鈕 badge 就變一個數。
    syncBadge() { if (window.loadInboxUnread) window.loadInboxUnread(); },
    statusLabel(s) { return (window.STATUS_LABELS || {})[s] || s || ''; },
    fmtTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      return isNaN(d.getTime()) ? '' : d.toLocaleString('zh-TW', { hour12: false });
    },
    // 點整則＝我要去處理它：標記已讀再跳任務詳情，回來時它不會還掛在未讀清單上
    async open(row) {
      await this.markRead(row);
      location.hash = `#/task/${row.task_id}`;
    },
    async markRead(row) {
      const unread = row.ids.filter((id) => {
        const it = this.items.find((x) => x.id === id);
        return it && !it.read_at;
      });
      if (!unread.length) return;
      // 逐筆送：批次端點對收合後的多筆沒有對應語意，而這裡最多是同一任務連續退回的那幾則
      await Promise.all(unread.map((id) => Api.post(`inbox/${id}/read`).catch(() => {})));
      await this.load();
    },
    async readAll() {
      try {
        await Api.post('inbox/read-all');
        await this.load();
      } catch (e) { showToast(e.message || '操作失敗', 'error'); }
    },
    async snooze(row, kind) {
      if (!kind) return;
      const d = new Date();
      if (kind === '1h') d.setHours(d.getHours() + 1);
      else if (kind === 'later') d.setHours(d.getHours() + 4);
      else { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
      try {
        await Promise.all(row.ids.map((id) => Api.post(`inbox/${id}/snooze`, { until: d.toISOString() })));
        await this.load();
      } catch (e) { showToast(e.message || '延後失敗', 'error'); }
    },
  },
  template: `
    <div class="topbar">
      <h1>📥 收件匣</h1>
      <button v-if="unreadTotal > 0" class="btn btn-outline btn-sm" @click="readAll">全部標記已讀</button>
    </div>
    <div class="content">
      <div class="filter-row">
        <button class="btn btn-sm" :class="!showAll ? 'btn-primary' : 'btn-outline'" @click="setShowAll(false)">
          只看未處理<span v-if="unreadTotal > 0" class="tab-badge" :class="!showAll ? 'tab-badge-active' : ''">{{ unreadTotal }}</span>
        </button>
        <button class="btn btn-sm" :class="showAll ? 'btn-primary' : 'btn-outline'" @click="setShowAll(true)">全部</button>
      </div>

      <div v-if="loading" class="task-card">載入中…</div>

      <div v-else-if="!grouped.length" class="task-card" style="color:var(--text-muted)">
        {{ showAll ? '收件匣是空的。' : '沒有待處理的項目——被退回或需要你處理時會出現在這裡。' }}
      </div>

      <div v-else>
        <div v-for="row in grouped" :key="row.id" class="task-card"
          :style="row.read_at ? 'opacity:.6' : 'border-left:3px solid var(--primary)'">
          <div style="display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap">
            <span class="pill" :class="row.kind === 'action' ? 'pill-warn' : 'pill-danger'">
              {{ row.kind === 'action' ? '要你處理' : '被退回' }}
            </span>
            <span v-if="row.count > 1" class="badge" :title="'連續 ' + row.count + ' 次'">×{{ row.count }}</span>
            <a href="javascript:void(0)" @click="open(row)" style="font-weight:600">
              {{ row.title || row.task_ref || ('任務 ' + row.task_id) }}
            </a>
            <span v-if="row.status" class="pill">{{ statusLabel(row.status) }}</span>
            <span style="margin-left:auto;color:var(--text-muted);font-size:var(--fs-sm)">{{ fmtTime(row.created_at) }}</span>
          </div>
          <div v-if="row.summary" style="margin-top:6px;color:var(--text-muted);font-size:var(--fs-sm)">
            {{ row.summary }}
          </div>
          <div style="margin-top:8px;display:flex;gap:var(--space-2);align-items:center">
            <button class="btn btn-sm btn-outline" @click="open(row)">前往任務</button>
            <button v-if="!row.read_at" class="btn btn-sm btn-outline" @click="markRead(row)">標記已讀</button>
            <select v-if="!row.read_at" class="form-control" style="width:auto;font-size:var(--fs-base);padding:5px 10px;height:32px"
              @change="snooze(row, $event.target.value); $event.target.value=''" title="稍後再提醒我">
              <option value="">延後…</option>
              <option value="1h">1 小時後</option>
              <option value="later">今天稍後</option>
              <option value="tomorrow">明天早上</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  `,
});
