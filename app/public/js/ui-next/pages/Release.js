(function () {
  /**
   * 平台更版（管理員限定）。
   *
   * 管理員開這一頁是要回答三個問題，整頁就照那三個問題排，不是排成一張表格：
   *   1. 什麼在等著上去？ → 待更版清單（每一筆都點得開它的稽核軌跡）
   *   2. 什麼時候會上去？ → 下一次維護時段 ＋ 時段設定
   *   3. 上一次成功了嗎？ → 最上面那張卡片，失敗時整張變紅並直接寫出「該怎麼辦」
   *
   * ⚠ 已拍板：更版結果**只會出現在畫面上**——這台機器沒有 webhook 也沒有 Teams。
   * 所以「沒有任何東西會通知你」這句話本身要印在頁面上：以為會被通知的人不會自己來看，
   * 而半夜兩點全跑紅掉、碼停在 master 沒生效這件事，會就這樣安靜地放到下個週末。
   */
  const WEEKDAYS = [
    { v: 1, label: '一' }, { v: 2, label: '二' }, { v: 3, label: '三' }, { v: 4, label: '四' },
    { v: 5, label: '五' }, { v: 6, label: '六' }, { v: 0, label: '日' },
  ];

  // 修正列的狀態字面，沿用健檢頁那份的子集（只會走到這裡的幾種）。
  const FIX_STATUS = {
    running: '改碼中', ready: '待審', adopted: '已採用', pushed: '已推上 GitHub',
    merged: '已合併，待更版', released: '已更版', rejected: '被退回', failed: '失敗',
    no_change: '判定不用改',
  };

  window.UiNextReleaseView = Vue.defineComponent({
    name: "UiNextReleaseView",
    data() {
      return {
        data: null,
        loading: true,
        saving: false,
        releasing: false,
        form: { weekdays: [], startHour: 2, durationHours: 2 },
        // 立刻更版的兩個旋鈕。預設都關：兩個都是「明知會付出代價還是要做」的選項。
        abortInflight: false,
        skipTests: false,
        trailOpen: {},    // { [fixId]: true } 展開這一筆的稽核軌跡
        trail: {},        // { [findingId]: [...] } 抓過就留著
        trailLoading: {},
        diffOpen: {},     // { [historyRowId]: true }
        // 設定表單是否已經跟後端同步過一次。輪詢每 15 秒回寫一次的話，
        // 會把使用者打到一半的設定蓋掉，所以只在第一次（與存檔後）同步。
        _formReady: false,
        _timer: null,
      };
    },
    async created() {
      await this.load();
      // 更版跑起來之後這個行程隨時可能被自己的 docker restart 帶走，畫面不會收到任何事件。
      // 輪詢是唯一看得到「跑完了沒、結果是什麼」的方式（成功的話會斷線重連，那本身就是答案）。
      this._timer = setInterval(() => this.load(true), 15000);
    },
    unmounted() { if (this._timer) clearInterval(this._timer); },
    computed: {
      weekdayOptions() { return WEEKDAYS; },
      win() { return (this.data && this.data.window) || null; },
      pending() { return (this.data && this.data.pending) || []; },
      last() { return (this.data && this.data.last) || null; },
      inflight() { return (this.data && this.data.inflight) || []; },
      // 「上一次沒有成功」是這一頁最重要的一件事，判準只看 restarted：
      // testsPassed 是三態而 null 不是通過（release.js 的契約），拿它判會把「跳過全跑但有重啟」
      // 誤報成失敗，也會把「根本沒跑起來」誤報成沒事。
      lastFailed() { return !!this.last && this.last.restarted !== true; },
      nextText() {
        if (!this.win || !this.win.nextWindowAt) return '未設定';
        const at = new Date(this.win.nextWindowAt);
        return at.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
      },
    },
    methods: {
      async load(quiet) {
        if (!quiet) this.loading = true;
        try {
          const d = await Api.get('admin/release');
          this.data = d;
          this.releasing = !!d.running;
          // 設定表單只在使用者沒有正在編輯時（第一次載入）同步，否則 15 秒一次的輪詢
          // 會把打到一半的設定蓋掉。
          if (!this._formReady) {
            this.form = {
              weekdays: [...d.window.weekdays],
              startHour: d.window.startHour,
              durationHours: d.window.durationHours,
            };
            this._formReady = true;
          }
        } catch (e) { if (!quiet) showToast(e.message, 'error'); }
        finally { this.loading = false; }
      },
      toggleDay(v) {
        const i = this.form.weekdays.indexOf(v);
        if (i >= 0) this.form.weekdays.splice(i, 1); else this.form.weekdays.push(v);
      },
      async saveWindow() {
        this.saving = true;
        try {
          const r = await Api.put('admin/release/window', {
            weekdays: [...this.form.weekdays].sort(),
            startHour: Number(this.form.startHour),
            durationHours: Number(this.form.durationHours),
          });
          // 後端回的是「引擎實際讀到的設定」。它是 null 代表存進去了但機制其實是關的——
          // 那種情況必須當成錯誤講出來，不能顯示「已儲存」。
          if (!r.window) { showToast('設定存進去了，但更版引擎讀不到它——機制目前是關的，請回報', 'error'); }
          else showToast('已儲存：' + r.label, 'success');
          this._formReady = false;
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.saving = false; }
      },
      async clearWindow() {
        if (!await confirmDialog({
          title: '取消自動更版',
          message: '取消之後平台不會再自己重啟。已合併的碼會一直停在待更版，'
            + '直到有人回來按「立刻更版」為止——而沒有任何東西會提醒你。',
          danger: true, confirmText: '取消自動更版',
        })) return;
        this.saving = true;
        try {
          await Api.delete('admin/release/window');
          showToast('已取消自動更版', 'success');
          this._formReady = false;
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.saving = false; }
      },
      async releaseNow() {
        const parts = [`會把 ${this.pending.length} 筆已合併的修正真的放上去，平台重啟約 30 秒。`];
        if (this.inflight.length) {
          parts.push(this.abortInflight
            ? `⚠ ${this.inflight.length} 條在飛任務會被當場中止（改到一半的碼留在任務分支，重啟後自動從同一關重跑）。`
            : `⚠ 現在有 ${this.inflight.length} 條任務在飛，沒有勾「一併中止」的話按下去會被擋下來。`);
        }
        parts.push(this.skipTests
          ? '⚠ 你選了跳過重啟前全跑——這一次更版不會留下任何測試證據。'
          : '重啟前會先對 master 跑一次全套測試，約 15 分鐘；紅了就不重啟，碼留到下一次。');
        if (!await confirmDialog({ title: '立刻更版', message: parts.join('\n'), confirmText: '立刻更版' })) return;
        this.releasing = true;
        try {
          await Api.post('admin/release/now', {
            abortInflight: this.abortInflight, skipTests: this.skipTests,
          });
          showToast(this.skipTests ? '更版已開始' : '更版已開始，先跑全套測試（約 15 分鐘）', 'success');
          await this.load(true);
        } catch (e) {
          this.releasing = false;
          showToast(e.message, 'error');
        }
      },
      /**
       * 稽核軌跡：這段碼是依據哪段文字改的、誰審過、複檢動了什麼。
       * 用既有的 GET admin/health-check/findings/:id/fix——它已經回整段歷史（新到舊），
       * 所以「被退回過一輪、重修才通過」也看得到，不只是最後那一筆。
       */
      async toggleTrail(row) {
        const open = !this.trailOpen[row.id];
        this.trailOpen = { ...this.trailOpen, [row.id]: open };
        if (!open || this.trail[row.finding_id]) return;
        this.trailLoading = { ...this.trailLoading, [row.id]: true };
        try {
          const rows = await Api.get('admin/health-check/findings/' + row.finding_id + '/fix');
          this.trail = { ...this.trail, [row.finding_id]: rows || [] };
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.trailLoading = { ...this.trailLoading, [row.id]: false }; }
      },
      trailOf(row) { return this.trail[row.finding_id] || []; },
      // 模板裡不寫 function 字面值：那種寫法在既有頁面只出現在 methods 裡，
      // 放進模板等於多一種要維護的形狀。
      inflightIds() { return this.inflight.map(t => t.taskId).join('、#'); },
      fixStatus(s) { return FIX_STATUS[s] || s; },
      fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : ''; },
      shortSha(s) { return s ? String(s).slice(0, 8) : ''; },
    },
    template: `
      <div class="page-header ui-next-admin-page-head">
        <div class="page-header-inner">
          <h1 class="page-title">平台更版</h1>
          <button class="btn btn-outline btn-sm" @click="$router.push('/admin')">← 返回</button>
        </div>
      </div>
      <div class="page-body">
        <div v-if="loading" class="loading">載入中...</div>
        <div v-else-if="!data" class="empty-state">讀不到更版狀態，請重新整理。</div>
        <div v-else class="settings-layout">

          <!-- 裁決二：沒有任何東西會通知你。這句話不是註腳，是這一頁存在的前提。 -->
          <div class="setting-block" :style="{ borderLeft: '3px solid var(--warning-strong)' }">
            <div class="setting-block-head">
              <div class="setting-block-title" :style="{ color: 'var(--warning-strong)' }">沒有任何東西會通知你</div>
              <div class="setting-block-desc">
                {{ data.notify.note }}
                更版失敗（例如重啟前全跑紅了）不會寄信、不會跳通知、不會有人被叫起來——
                <strong>只有你自己回來看這一頁才會知道</strong>。維護時段是每週末，建議週一上班時看一眼。
              </div>
            </div>
          </div>

          <!-- 問題三：上一次成功了嗎 -->
          <div class="setting-block"
            :style="{ borderLeft: '3px solid ' + (last ? (lastFailed ? 'var(--danger)' : 'var(--success)') : 'var(--border)') }">
            <div class="setting-block-head">
              <div class="setting-block-title"
                :style="{ color: last ? (lastFailed ? 'var(--danger)' : 'var(--success)') : 'var(--text)' }">
                <template v-if="!last">還沒有任何更版紀錄</template>
                <template v-else-if="lastFailed">⚠ 上一次更版沒有成功——平台還跑著舊碼</template>
                <template v-else>上一次更版成功</template>
              </div>
              <div class="setting-block-desc">
                <template v-if="!last">這台平台還沒有跑過任何一次更版（自動或人工）。</template>
                <template v-else>
                  {{ fmt(last.at) }}
                  <span v-if="last.source === 'manual'">・人工觸發</span>
                  <span v-else>・自動時段</span>
                  <span v-if="last.windowStart">（時段 {{ fmt(last.windowStart) }}）</span>
                </template>
              </div>
            </div>
            <div v-if="last" class="setting-block-body">
              <div v-if="lastFailed" class="error-msg" style="white-space:pre-wrap">{{ last.reason || '原因未記錄' }}</div>
              <div v-else style="font-size:var(--fs-sm);color:var(--text)">
                讓 {{ last.released || 0 }} 筆修正生效。<span v-if="last.summary">測試：{{ last.summary }}</span>
                <span v-if="last.testsPassed === null">（這一次沒有跑重啟前全跑，沒有測試證據）</span>
              </div>
              <div v-if="last.aborted && last.aborted.length"
                style="font-size:var(--fs-sm);color:var(--warning-strong);margin-top:var(--space-2)">
                那一次中止了 {{ last.aborted.length }} 條在飛任務（#{{ last.aborted.join('、#') }}），它們會在重啟後自動從同一關重跑。
              </div>
              <!-- 「該怎麼辦」跟失敗訊息綁在一起。半夜兩點沒有人在，看到這段的人多半是隔了幾天
                   才來的，光說「失敗了」等於把問題丟回去。 -->
              <div v-if="lastFailed" style="margin-top:var(--space-3);font-size:var(--fs-sm);color:var(--text)">
                <div style="font-weight:var(--fw-semibold);margin-bottom:4px">該怎麼辦</div>
                <ol style="margin:0;padding-left:1.2em;line-height:1.8">
                  <li>碼已經在 master、沒有遺失，只是還沒生效——平台現在跑的是舊碼。</li>
                  <li>到平台主 clone 的 <code>app/</code> 下跑 <code>npm run test:quiet</code>，看是哪幾支紅的。</li>
                  <li>修好並合併之後，回到這一頁按「立刻更版」，或等下一個維護時段（{{ nextText }}）自己再試一次。</li>
                  <li>確定紅燈與這批修正無關、非上不可時，才用下面的「跳過重啟前全跑」——那一次不會留下測試證據。</li>
                </ol>
              </div>
            </div>
          </div>

          <!-- 問題一＋二：什麼在等、什麼時候會上去 -->
          <div class="setting-block">
            <div class="setting-block-head">
              <div class="setting-block-title">待更版 {{ pending.length }} 筆・下一次時段 {{ nextText }}</div>
              <div class="setting-block-desc">
                時段：{{ win.label }}<span v-if="win.inWindow">（<strong style="color:var(--warning-strong)">現在就在時段內</strong>）</span>。
                只有在有待更版的修正時才會重啟；重啟前對 master 跑一次全套測試，紅了就不重啟、碼留到下一個時段。
                <br>
                ⚠ 時段內若還有任務在飛，離時段結束剩 {{ data.abortMinutes }} 分鐘時會<strong>強制中止</strong>它們並照常重啟；
                被中止的任務改到一半的碼留在任務分支，平台重啟後自動從同一關重跑，不需要人工處理。
                <template v-if="!win.configured"><br><strong style="color:var(--warning-strong)">目前沒有設定時段，平台不會自動更版。</strong></template>
              </div>
            </div>
            <div class="setting-block-body">
              <div v-if="!pending.length" class="empty-state" style="padding:var(--space-4)">
                沒有待更版的修正。這種時候時段到了也不會重啟——不打擾客戶是刻意的。
              </div>
              <div v-for="row in pending" :key="row.id"
                style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-3);margin-bottom:var(--space-2);background:var(--surface)">
                <div class="hc-finding-title-row">
                  <span style="color:var(--text)">{{ row.diagnosis || ('提案 #' + row.finding_id) }}</span>
                  <span class="pill pill-warn">待更版</span>
                  <span v-if="row.severity" class="pill pill-info">{{ row.severity }}</span>
                </div>
                <div style="font-size:var(--fs-xs);color:var(--text-muted);font-family:monospace">
                  {{ row.branch }}<span v-if="row.commit_sha"> · {{ shortSha(row.commit_sha) }}</span> · 合併於 {{ fmt(row.created_at) }}
                </div>
                <div v-if="row.feedback_ids && row.feedback_ids.length"
                  style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:2px">
                  來源：使用者意見回饋 #{{ row.feedback_ids.join('、#') }}
                </div>
                <button class="btn btn-ghost btn-sm" style="margin-top:var(--space-2)" @click="toggleTrail(row)">
                  {{ trailOpen[row.id] ? '▾ 收合稽核軌跡' : '▸ 這段碼是誰寫的、誰審的' }}
                </button>
                <div v-if="trailOpen[row.id]" style="margin-top:var(--space-2)">
                  <div v-if="trailLoading[row.id]" class="loading">載入中...</div>
                  <div v-else-if="!trailOf(row).length" class="empty-state" style="padding:var(--space-3)">
                    查不到這條提案的修正歷史。
                  </div>
                  <!-- 整段歷史（新到舊）：被退回過一輪、重修才通過的那種，退回理由與上一輪的 diff
                       都在這裡。沒有人在合併前讀過這些碼，這就是唯一的人工稽核材料。 -->
                  <div v-for="h in trailOf(row)" :key="h.id"
                    style="border-left:2px solid var(--border);padding-left:var(--space-3);margin-bottom:var(--space-3)">
                    <div style="font-size:var(--fs-xs);color:var(--text-muted)">
                      #{{ h.id }} · {{ fixStatus(h.status) }} · {{ fmt(h.created_at) }}
                      <span v-if="h.commit_sha"> · {{ shortSha(h.commit_sha) }}</span>
                      <span v-if="h.test_result"> · 測試：{{ h.test_result }}</span>
                    </div>
                    <div v-if="h.reject_reason" class="error-msg" style="white-space:pre-wrap;margin:4px 0">
                      退回理由：{{ h.reject_reason }}
                    </div>
                    <div v-if="h.notes" style="font-size:var(--fs-sm);color:var(--text);white-space:pre-wrap;margin-top:4px">
                      改了什麼：{{ h.notes }}
                    </div>
                    <div v-if="h.review_notes" style="font-size:var(--fs-sm);color:var(--text-secondary);white-space:pre-wrap;margin-top:4px">
                      審查意見：{{ h.review_notes }}
                    </div>
                    <div v-if="h.verify_notes" style="font-size:var(--fs-sm);color:var(--text-secondary);white-space:pre-wrap;margin-top:4px">
                      合併前複檢：{{ h.verify_notes }}
                    </div>
                    <div v-if="h.diff" style="margin-top:4px">
                      <button class="btn btn-ghost btn-sm" @click="diffOpen = { ...diffOpen, [h.id]: !diffOpen[h.id] }">
                        {{ diffOpen[h.id] ? '▾ 收合改動' : '▸ 看改了什麼' }}
                      </button>
                      <pre v-if="diffOpen[h.id]"
                        style="max-height:360px;overflow:auto;background:var(--code-bg);color:var(--code-text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-2);font-size:var(--fs-xs)">{{ h.diff }}</pre>
                      <div v-if="diffOpen[h.id] && h.diff_truncated" style="font-size:var(--fs-xs);color:var(--text-muted)">
                        （diff 太長已截斷，全文用 git show {{ shortSha(h.commit_sha) }}）
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 立刻更版 -->
          <div class="setting-block">
            <div class="setting-block-head">
              <div class="setting-block-title">立刻更版</div>
              <div class="setting-block-desc">
                等不到下一個時段時用。重啟會當場砍掉在飛的 AI，也會讓測試區 Odoo 的 cron 執行緒永久死掉
                （客戶看到的是「測試區還開著但什麼都不動」），所以不是零成本的操作。
              </div>
            </div>
            <div class="setting-block-body">
              <div v-if="data.maintenance" style="font-size:var(--fs-sm);color:var(--warning-strong);margin-bottom:var(--space-2)">
                目前正在維護中（多半是夜間改善批次還沒收工）。等它結束再按——中途重啟會讓它的 git push 停在半途。
              </div>
              <div v-if="inflight.length" style="font-size:var(--fs-sm);color:var(--warning-strong);margin-bottom:var(--space-2)">
                現在有 {{ inflight.length }} 條任務在飛：#{{ inflightIds() }}
              </div>
              <label style="display:flex;align-items:center;gap:var(--space-2);font-size:var(--fs-sm);color:var(--text);margin-bottom:4px">
                <input type="checkbox" v-model="abortInflight">
                一併中止在飛任務（它們會在平台重啟後自動從同一關重跑）
              </label>
              <label style="display:flex;align-items:center;gap:var(--space-2);font-size:var(--fs-sm);color:var(--text)">
                <input type="checkbox" v-model="skipTests">
                跳過重啟前全跑（約省 15 分鐘，<strong style="color:var(--danger)">這一次更版不會留下任何測試證據</strong>）
              </label>
            </div>
            <div class="setting-block-footer">
              <button class="btn btn-primary btn-sm" :disabled="releasing || !pending.length" @click="releaseNow">
                {{ releasing ? '更版中…' : '立刻更版' }}
              </button>
              <span v-if="releasing" style="font-size:var(--fs-sm);color:var(--text-muted)">
                成功的話平台會重啟、這個畫面會短暫斷線；失敗的話結果會出現在上面那張卡片。
              </span>
              <span v-else-if="!pending.length" style="font-size:var(--fs-sm);color:var(--text-muted)">
                沒有待更版的碼，不必重啟。
              </span>
            </div>
          </div>

          <!-- 時段設定 -->
          <div class="setting-block">
            <div class="setting-block-head">
              <div class="setting-block-title">維護時段</div>
              <div class="setting-block-desc">
                平台只會在這個時段內自動重啟。時間是平台所在機器的本地時間（台北）。
                時段不能跨過午夜——跨午夜的設定目前會被判為無效，整條機制會靜默關閉。
              </div>
            </div>
            <div class="setting-block-body">
              <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;margin-bottom:var(--space-3)">
                <button v-for="d in weekdayOptions" :key="d.v" type="button"
                  :class="['btn', 'btn-sm', form.weekdays.includes(d.v) ? 'btn-primary' : 'btn-outline']"
                  @click="toggleDay(d.v)">{{ d.label }}</button>
              </div>
              <div style="display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap">
                <label style="font-size:var(--fs-sm);color:var(--text)">
                  開始
                  <input class="form-control" type="number" min="0" max="23" v-model.number="form.startHour"
                    style="width:5em;display:inline-block;margin-left:4px"> 點
                </label>
                <label style="font-size:var(--fs-sm);color:var(--text)">
                  長度
                  <input class="form-control" type="number" min="1" max="24" v-model.number="form.durationHours"
                    style="width:5em;display:inline-block;margin-left:4px"> 小時
                </label>
              </div>
            </div>
            <div class="setting-block-footer">
              <button class="btn btn-primary btn-sm" :disabled="saving" @click="saveWindow">儲存時段</button>
              <button class="btn btn-outline btn-sm" :disabled="saving || !win.configured" @click="clearWindow">取消自動更版</button>
            </div>
          </div>

        </div>
      </div>
    `
  });
})();
