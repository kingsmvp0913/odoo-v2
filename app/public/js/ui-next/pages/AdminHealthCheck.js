  // 這一頁只做一件事：當健檢的 log 看。
  //
  // 它原本是「提案管理台」——七張提案卡片，每張掛著擋下／修這條／四顆裁決鈕＋裁決理由輸入框，
  // 底下再串「採用 → 推上 GitHub → 合併並重啟」。但提案的處置早就收斂到「改善提案」頁
  // （管理員 > 改善提案，資料源是 feedback 表，健檢提案會由 openFeedbackForFinding 開單進去），
  // 兩頁各有一套按鈕做同一件事，反而讓人不知道該在哪裡按。
  // 2026-09-05 使用者裁決：健檢頁只留 log，「修這條」那條手動改碼鏈直接移除——已核准的提案
  // 每晚 22:00 由夜間批次自動跑，不需要手動觸發的入口。
  window.UiNextAdminHealthCheckView = Vue.defineComponent({
    name: "UiNextAdminHealthCheckView",
    data() {
      return {
        history: [], schedule: null,
        rowOpen: {},        // { [runId]: true } 展開這一輪看它產出什麼
        runFindings: {},    // { [runId]: [...] } 展開時才抓，抓過就留著
        loadingRun: {},     // { [runId]: true } 該輪的內容抓取中
        // 手動跑一輪（收在頁尾摺疊區）。runId／running 只服務這條路徑。
        runId: null, running: false, cadence: 'daily', sinceDays: null, _timer: null,
      };
    },
    async mounted() { await this.loadHistory(); await this.openFromQuery(); },
    unmounted() { if (this._timer) clearInterval(this._timer); },
    computed: {
      // 排程是每日自動跑（cron 每分鐘一 tick），所以顯示的是「最早會被執行的時刻」
      nextRunText() {
        const s = this.schedule;
        if (!s) return '';
        if (!s.enabled) return '已停用';
        if (s.running) return '本輪執行中';
        if (s.due) return '即將執行';
        return new Date(s.nextRunAt).toLocaleString();
      },
      // 失敗橫幅吃最新一輪。健檢掛掉時它一筆提案都不會產生，整頁跟「今天本來就沒事」長得
      // 一模一樣——這個 repo 踩過（夜班空轉 98 輪無人察覺），所以要一進頁面就看得到。
      latestRun() { return this.history && this.history.length ? this.history[0] : null; },
    },
    methods: {
      async loadHistory() {
        try { this.history = await Api.get('admin/health-check'); }
        catch (e) { showToast(e.message, 'error'); }
        // 排程資訊失敗不擋歷史清單：它只是附註，沒有它整頁照樣可用
        try { this.schedule = await Api.get('admin/health-check-schedule'); }
        catch (e) { this.schedule = null; }
      },
      // 點整列展開，看那一輪產出了什麼（唯讀）。內容按需抓：一次列 20 輪，開頁就全抓等於
      // 20 個請求換一個多數人不會展開的區塊。
      async toggleRun(h) {
        const open = !this.rowOpen[h.id];
        this.rowOpen = { ...this.rowOpen, [h.id]: open };
        if (!open || this.runFindings[h.id]) return;
        this.loadingRun = { ...this.loadingRun, [h.id]: true };
        try {
          const { findings } = await Api.get('admin/health-check/' + h.id);
          this.runFindings = { ...this.runFindings, [h.id]: findings || [] };
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.loadingRun = { ...this.loadingRun, [h.id]: false }; }
      },
      async start() {
        this.running = true;
        try {
          // 不帶 sinceDays＝用預設的增量視窗（上一輪之後）；填了才是「回頭重掃這麼多天」。
          // 大健檢走 cadence：它不只是換個天數，30 天那份還會多帶一份上一期資料做趨勢比對，
          // 所以手動填 sinceDays=30 與選「30 天大健檢」是兩件不同的事。
          const body = this.cadence === 'daily'
            ? (this.sinceDays ? { sinceDays: this.sinceDays } : {})
            : { cadence: this.cadence };
          const { runId } = await Api.post('admin/health-check', body);
          this.runId = runId;
          this._timer = setInterval(() => this.poll(), 3000);
          await this.poll();
        } catch (e) { showToast(e.message, 'error'); this.running = false; }
      },
      // 只盯「跑完了沒」，跑完重載列表。內容要看就點那一列，不在這裡另外渲染一份。
      async poll() {
        try {
          const { run } = await Api.get('admin/health-check/' + this.runId);
          if (run.status !== 'running') {
            clearInterval(this._timer); this._timer = null; this.running = false;
            // 這一輪的內容可能已被展開過並快取住，清掉才不會顯示跑之前的舊結果
            this.runFindings = { ...this.runFindings, [this.runId]: undefined };
            await this.loadHistory();
          }
        } catch (e) { /* 單次輪詢失敗保留上批，下次恢復 */ }
      },
      // 由任務詳情頁的「健檢這張任務」導過來（?run=N）：那支 run 已經在背景跑了，這裡直接盯著它，
      // 不必也不能再按一次「開始健檢」——按下去建的是另一支全平台健檢。
      async openFromQuery() {
        const id = parseInt(this.$route.query.run, 10);
        if (!id) return;
        this.runId = id;
        this.running = true;
        await this.poll();
        if (this.running) this._timer = setInterval(() => this.poll(), 3000);
      },
      scopeText(r) { return r && r.task_db_id ? ('任務 ' + (r.task_id || r.task_db_id)) : '全平台'; },
      sev(s) { return HC_SEV[s] || HC_SEV.error; },
      layer(l) { return HC_LAYER[l] || null; },
      kindOf(f) { return f.kind || 'agent'; },
      // health-auditor 產出的 diagnosis 第一行就是標題本身（agent_label 取自同一句），照原樣印
      // 會讓每張卡的標題出現兩次。只在「首行與標題完全相同」時去掉，其餘一律原樣保留——
      // 用猜的（例如砍掉所有首行）會把真正的內文吃掉。
      bodyOf(f) {
        const d = String(f.diagnosis || '');
        const nl = d.indexOf('\n');
        const first = (nl === -1 ? d : d.slice(0, nl)).trim();
        if (first && first === String(f.agent_label || '').trim()) return d.slice(nl + 1).replace(/^\s+/, '');
        return d;
      },
      // 展開區只列「有內容可看」的三類：提案、候選訊號、本輪總結。
      // kind='agent'（逐關診斷）那條路徑（runHealthCheck）已退役，最後一次實際執行是
      // 2026-08-20，舊資料留在 DB 但不再顯示。
      shownFindings(runId) {
        const list = this.runFindings[runId] || [];
        return list.filter(f => ['proposal', 'signal', 'summary', 'note'].includes(this.kindOf(f)));
      },
      // 歷史列的嚴重度＝本輪最嚴重的那一條（後端算的 severity_rank）。
      // 健檢自己沒跑完優先蓋過一切：收掉「狀態」欄之後，這裡是畫面上唯一分辨得出
      // 「這一輪根本沒跑完」的地方。不特判的話 run#19（status='error'、零 finding）會顯示成
      // 「—」，跟「今天本來就沒事」長得一模一樣。
      histSev(h) {
        // 還在跑的那一輪（含夜間改善批次，它一開跑就先建列）：等級要等跑完才算得出來，
        // 不特判的話 severity_rank 是 NULL、這一格顯示「—」，跟「跑完了但什麼都沒查到」
        // 長得一模一樣——使用者實際回報「批次看不出來有沒有跑」就是卡在這裡。
        if (h.status === 'running') return { label: '執行中', color: 'var(--info)' };
        if (h.status === 'error') return HC_SEV.error;
        if (h.error_count > 0) return HC_SEV.error;
        if (h.severity_rank === null || h.severity_rank === undefined) return null;
        return HC_SEV[SEV_BY_RANK[Number(h.severity_rank) + 1]] || null;
      },
      // 處理狀態只看 medium 以上的待處理提案（後端的 open_count 已濾過）：輕微的放著不管是允許的，
      // 把它算進待辦會讓每一輪都掛著紅字，真正該處理的反而看不見。
      histTodo(h) {
        if (!h.proposal_count) return null;
        return h.open_count > 0
          ? { label: '待處理 ' + h.open_count, color: 'var(--warning-strong)' }
          : { label: '已處理完', color: 'var(--text-muted)' };
      },
      // 夜間改善批次自建的列也落在同一張表（cadence='nightly-fix'，見 nightly-fix.js 的
      // BATCH_CADENCE）。不特別標的話它長得像一輪什麼都沒查到的健檢：等級「—」、提案數 0，
      // 完全看不出「昨晚的改善跑過了」——而那正是這張 log 最該回答的事情之一。
      cadenceText(h) {
        if (h.cadence === 'nightly-fix') return '（改善批次）';
        return HC_CADENCE[h.cadence] || '';
      },
    },
    template: `
      <div class="topbar ui-next-admin-head">
        <h1>健檢紀錄</h1>
        <div class="ui-next-admin-head-actions"><button class="btn btn-outline btn-sm" @click="$router.push('/admin')">← 返回</button></div>
      </div>
      <div class="content">
        <div class="hc-page">
          <!-- 唯一留在列表之上的東西：上一輪掛了沒。理由見 latestRun 的註解。 -->
          <div v-if="latestRun && latestRun.status === 'error'" class="error-msg" style="margin-bottom:var(--space-3)">
            ⚠ 上一輪健檢失敗（{{ new Date(latestRun.created_at).toLocaleString() }}），沒有產生任何提案。<span v-if="latestRun.error">原因：{{ latestRun.error }}</span>
            <span v-else>（沒有記到原因——這輪是舊版留下的，新版失敗都會寫原因）</span>
          </div>

          <div class="settings-section">
            <div class="arj-header-row">
              <h2 class="section-title" style="margin:0">健檢紀錄（{{ history.length }} 輪）</h2>
              <span v-if="nextRunText" style="font-size:var(--fs-sm);color:var(--text-muted)">下次自動：{{ nextRunText }}</span>
            </div>
            <div class="table-wrap">
              <table class="data-table">
                <!-- 這張表只回答兩個問題：那一輪是什麼等級、要不要進改善。範圍／視窗／狀態
                     三欄拿掉——每天看的人不會用它們分流，要細節就點那一列。狀態欄的資訊沒有
                     消失：失敗被 histSev 吸收成「健檢失敗」等級，原因跟在下面。 -->
                <thead><tr><th>時間</th><th style="width:110px">等級</th><th style="width:110px">要不要改善</th><th style="width:90px">提案數</th></tr></thead>
                <tbody>
                  <template v-for="h in history" :key="h.id">
                    <tr class="clickable" @click="toggleRun(h)">
                      <td>
                        {{ new Date(h.created_at).toLocaleString() }}
                        <!-- 範圍與節奏降成副標，不各佔一欄：多數列是「全平台／增量」，每列都標等於
                             沒標；但大健檢（週／月）與任務健檢的等級跟日健檢不可比，看不出來會誤讀。 -->
                        <div v-if="h.task_db_id || cadenceText(h)" style="font-size:var(--fs-xs);color:var(--text-muted)">
                          <span v-if="h.task_db_id">{{ scopeText(h) }}</span>{{ cadenceText(h) }}
                        </div>
                      </td>
                      <td>
                        <span v-if="histSev(h)" :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:histSev(h).color,whiteSpace:'nowrap'}">
                          {{ histSev(h).label }}
                        </span>
                        <span v-else style="color:var(--text-muted)">—</span>
                        <!-- 失敗原因跟著等級走：要知道為什麼掛還得點進去的話，而失敗那輪點進去
                             又是空的（一筆 finding 都沒有），等於查不到。 -->
                        <div v-if="h.status === 'error' && h.error" class="hc-body"
                          style="font-size:var(--fs-xs);color:var(--danger)">{{ h.error }}</div>
                      </td>
                      <td>
                        <span v-if="histTodo(h)" :style="{fontSize:'var(--fs-sm)',color:histTodo(h).color,whiteSpace:'nowrap'}">{{ histTodo(h).label }}</span>
                        <span v-else style="color:var(--text-muted)">—</span>
                      </td>
                      <td>{{ h.proposal_count || 0 }}</td>
                    </tr>
                    <!-- 展開區：那一輪產出了什麼。純唯讀——處置（核准／駁回／刪除）一律在
                         「改善提案」頁，兩頁各放一套按鈕會讓人不知道該在哪按。 -->
                    <tr v-if="rowOpen[h.id]" class="empty-row">
                      <td colspan="4" style="background:var(--bg);text-align:left;padding:var(--space-3) var(--space-4)">
                        <div v-if="loadingRun[h.id]" style="color:var(--text-muted);font-size:var(--fs-sm)">載入中...</div>
                        <div v-else-if="!shownFindings(h.id).length" style="color:var(--text-muted);font-size:var(--fs-sm)">這一輪沒有產出任何內容。</div>
                        <div v-for="f in shownFindings(h.id)" :key="f.id" style="margin-bottom:var(--space-3)">
                          <div class="hc-finding-title-row">
                            <span style="font-weight:var(--fw-semibold);font-size:var(--fs-sm)">{{ f.agent_label || '本輪總結' }}</span>
                            <span v-if="layer(f.layer)" :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:layer(f.layer).color}">
                              {{ layer(f.layer).label }}
                            </span>
                            <span :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:sev(f.severity).color}">
                              {{ sev(f.severity).label }}
                            </span>
                          </div>
                          <div class="hc-body" style="font-size:var(--fs-sm);color:var(--text)">{{ bodyOf(f) }}</div>
                          <div v-if="f.evidence" class="hc-body" style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:2px">證據：{{ f.evidence }}</div>
                        </div>
                      </td>
                    </tr>
                  </template>
                  <tr v-if="history.length === 0" class="empty-row"><td colspan="4">尚無健檢紀錄</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 手動跑一輪。健檢本來就是排程自動跑的，手動只在查問題時用得到，所以收在頁尾。 -->
          <details class="settings-section">
            <summary style="cursor:pointer;font-size:var(--fs-sm);color:var(--text-muted)">手動跑一輪健檢</summary>
            <div class="hc-window-row" style="margin:var(--space-3) 0 0">
              <label style="font-size:var(--fs-base)" title="增量＝只看上一輪健檢之後的新資料。大健檢固定回看 7／30 天，30 天那份還會多帶上一期資料做趨勢比對。">
                節奏
                <select v-model="cadence" class="form-control" style="width:auto">
                  <option value="daily">增量</option>
                  <option value="weekly">7 天大健檢</option>
                  <option value="monthly">30 天大健檢（含趨勢比對）</option>
                </select>
              </label>
              <label v-if="cadence === 'daily'" style="font-size:var(--fs-base)" title="留空＝只看上一輪健檢之後的新資料（預設）。填數字＝回頭重掃這麼多天。">
                回溯
                <input type="number" v-model.number="sinceDays" min="1" placeholder="增量" style="width:72px" class="form-control" /> 天
              </label>
              <button class="btn btn-primary btn-sm" :disabled="running" @click="start">
                {{ running ? '健檢中...' : '開始健檢' }}
              </button>
            </div>
          </details>
        </div>
      </div>
    `
  });
