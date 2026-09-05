(function () {
  const STATUS_LABEL = { new: '待審核', approved: '已核准', rejected: '已駁回', done: '已完成' };
  const STATUS_PILL = { new: 'pill-info', approved: 'pill-success', rejected: 'pill-danger', done: 'pill-warn' };
  const LAYER_LABEL = { code: '程式', prompt: '提示詞', observability: '可觀測性', env: '環境', unclear: '看不懂' };

  window.UiNextAdminFeedbackView = Vue.defineComponent({
    name: "UiNextAdminFeedbackView",
    data() {
      return {
        rows: [],
        loading: true,
        statusFilter: '',
        deciding: {},      // { [id]: true } 送出核准／駁回中
        rejecting: {},     // { [id]: true } 該列正在展開駁回原因輸入
        rejectNote: {},    // { [id]: string }
        attachUrls: {},    // { [attachmentId]: objectURL }
        healthFailed: null,// 最新一輪健檢若失敗就放那一列，用來顯示警示
        bodyOpen: {},      // { [id]: true } 展開這一列的原文全文與翻譯結果
        bodyLong: {},      // { [id]: true } 這一列長到需要收合（量 DOM 得來，見 measureBodies）
        removing: {},      // { [id]: true } 刪除送出中
        startingBatch: false, // 手動觸發改善批次送出中（只是「送出這一下」，不是整個批次）
        batchRunning: false,  // 批次正在跑（輪詢 /api/maintenance 得知）
        _batchTimer: null,
      };
    },
    computed: {
      // statusLabel 不再是 computed：狀態欄改由 stateOf 產生（要把翻譯失敗併進來一起顯示），
      // 那裡直接讀 STATUS_LABEL 常數，留著 computed 就是沒人讀的死碼。
      layerLabel() { return LAYER_LABEL; },
    },
    async created() {
      await this.load(); await this.loadHealth();
      // 批次可能是別人按的、或是每晚 22:00 排程跑的——不能只在「自己按下去」之後才輪詢，
      // 否則同一件事在不同人的畫面上有不同的樣子。一進頁面就開始盯。
      await this.pollBatch();
      this._batchTimer = setInterval(() => this.pollBatch(), 15000);
    },
    beforeUnmount() {
      Object.values(this.attachUrls).forEach(url => URL.revokeObjectURL(url));
      if (this._batchTimer) clearInterval(this._batchTimer);
    },
    methods: {
      pillClass(status) { return STATUS_PILL[status] || 'pill-info'; },
      fmtTime(ts) { return new Date(ts).toLocaleString('zh-TW'); },
      // 健檢自己開的單，content 是整段診斷（好幾百字）。攤開的話一列就吃掉整個畫面高度，
      // 「這頁有幾筆待審」完全看不出來。長的先切短、點那一列就展開。
      // ⚠ 判長短只能量 DOM 不能估字數：中英混排與換行讓同樣字數高度差很多（健檢頁那邊用字數
      // 估，實測有一半的按鈕按下去畫面完全不動）。6.4 要與 app.css 的 .hc-body-clamp 一致。
      bodyClamped(r) { return this.bodyLong[r.id] === true && !this.bodyOpen[r.id]; },
      // 整列可點：按鈕與附件縮圖各自 @click.stop，否則按「駁回」會順手把列也展開／收合。
      toggleRow(r) { this.bodyOpen = { ...this.bodyOpen, [r.id]: !this.bodyOpen[r.id] }; },
      // 狀態欄要說的是「這筆現在卡在哪」，而不只是人工裁決的那個欄位值。翻譯掛掉時
      // status 仍是 approved（見 feedback-triage.js：執行失敗刻意不動 status 以便重試），
      // 只印「已核准」等於把失敗藏起來——使用者要的正是「失敗的那筆要看得出失敗」。
      // 判準：rejectBack 與執行失敗都會清空／不寫 triage_title 而只留 triage_note，
      // 所以「沒有 triage_title 但有 triage_note」就是這一輪翻譯沒成功。
      stateOf(r) {
        const note = r.triage_note || '';
        // 夜間批次的機器退場（連續失敗達門檻／layer 不可自動修）：status 被寫回 'new'，
        // 只印「待審核」會看起來像使用者剛提的新意見，完全看不出它跑過又被踢回來。
        // ⚠ 這個前綴與後端 retire-prefix.js 的 MACHINE_RETIRE_PREFIX 是兩份寫死的字面值，
        // 靠 frontend-nightly-retire-prefix.test.js 防漂移（前後端無共用模組機制是已裁決的
        // 取捨）。改字（含把全形冒號打成半形）會讓這個狀態靜默消失，那支測試會紅。
        // 判斷放在最前面且不看 triage_title：retireToHuman 只覆寫 status 與 triage_note，
        // 上一輪翻譯成功留下的 triage_title 還在，落到下面那個分支就會被漏掉。
        if (note.startsWith('自動退場：')) {
          return { label: '自動退場，待人工', pill: 'pill-warn', hint: note };
        }
        if (!r.triage_title && note) {
          return /^執行失敗/.test(note)
            ? { label: '翻譯失敗', pill: 'pill-danger', hint: note }
            : { label: '看不懂，已退回', pill: 'pill-warn', hint: note };
        }
        // 已核准但夜間批次試過沒成：只印「已核准」的話，這一列跟「今晚還沒輪到它」長得一模一樣。
        // 原因以前只進 console.error（本平台的 pipeline console 不落檔＝等於沒寫），要累計三次
        // 退場了才由 triage_note 講出來——前兩次一樣是無聲的。後端 last_attempt_note 補的就是這段。
        if (r.status === 'approved' && r.last_attempt_note) {
          return { label: '改善中，上次未完成', pill: 'pill-warn', hint: r.last_attempt_note };
        }
        return { label: STATUS_LABEL[r.status] || r.status, pill: this.pillClass(r.status), hint: '' };
      },
      // 縮圖是 objectURL（附件端點要帶 token，<img src> 直連拿不到）。開新分頁看原圖，
      // 與專案對話頁的附件同一個做法，不另外造一套燈箱。
      openImage(fileId) {
        const url = this.attachUrls[fileId];
        if (url) window.open(url, '_blank');
      },
      // 手動補跑一次改善批次。端點（POST /api/admin/nightly-fix）早就有，但前端從來沒有入口
      // ——已核准的提案只能等每晚 22:00，想當場驗一次「改善通道通不通」完全沒辦法。
      // ⚠ 這會真的改平台自己的程式、跑測試、審核、合併，並可能重啟平台，所以：
      // (1) 走確認對話框且把後果講白；(2) fire-and-forget——批次動輒數十分鐘到數小時，
      //     端點本身也是不 await 的，這裡不能假裝有進度可等。
      async runBatch() {
        const approved = this.rows.filter(r => r.status === 'approved').length;
        if (!await confirmDialog({
          title: '立即執行改善',
          message: `會把目前已核准的 ${approved} 筆提案送去自動改碼、跑測試、審核後合併，`
            + '過程可能重啟平台（畫面會短暫斷線）。整個批次要數十分鐘到數小時，'
            + '沒有進度條——結果去「健檢紀錄」看標著「改善批次」的那一列。',
          danger: true, confirmText: '開始執行'
        })) return;
        this.startingBatch = true;
        try {
          await Api.post('admin/nightly-fix', {});
          showToast('改善批次已開始', 'success');
          // 端點是 fire-and-forget，回來得很快；不立刻查一次的話，畫面要等到下一個
          // 15 秒 tick 才會出現「執行中」，中間那段看起來像按了沒反應。
          await this.pollBatch();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.startingBatch = false; }
      },
      // 批次在跑的期間會掛上維護旗標（nightly-fix 開頭 enterMaintenance），這是唯一能從外面
      // 看出「正在跑」的訊號——批次前段（等在飛任務排空、triage）還沒建 health_check_runs 列，
      // 只看那張表會有一段長達十幾分鐘的空窗，畫面上完全沒有動靜。
      // ⚠ 旗標本身只說「系統在維護中」，不保證是改善批次（理論上其他東西也能掛），
      // 所以文案不寫死成「你按的那個批次」。
      async pollBatch() {
        let running = false;
        try { running = !!(await Api.get('maintenance')).maintenance; }
        catch { return; }   // 單次查詢失敗保留上一個狀態，不要閃一下又回來
        const was = this.batchRunning;
        this.batchRunning = running;
        // 跑完那一刻要把清單重抓：提案狀態會變成「已完成」，不重抓就停在舊的
        if (was && !running) { showToast('改善批次已結束', 'success'); await this.load(); }
        else if (running) { await this.load(); }
      },
      async remove(r) {
        const what = r.triage_title || (r.content || '').slice(0, 30);
        if (!await confirmDialog({
          title: '刪除這筆提案',
          message: `確定刪除「${what}」？附件會一併刪除，無法復原。`,
          danger: true, confirmText: '刪除'
        })) return;
        this.removing = { ...this.removing, [r.id]: true };
        try {
          await Api.delete(`admin/feedback/${r.id}`);
          showToast('已刪除', 'success');
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.removing = { ...this.removing, [r.id]: false }; }
      },
      measureBodies() {
        this.$nextTick(() => {
          const next = {};
          for (const el of document.querySelectorAll('.hc-body[data-fbid]')) {
            const long = el.scrollHeight - 6.4 * parseFloat(getComputedStyle(el).fontSize) > 4;
            // 一列有原文與翻譯兩塊，任一塊過長就整列收合（兩塊各自收合會讓同一列出現兩顆按鈕）
            next[el.dataset.fbid] = next[el.dataset.fbid] || long;
          }
          this.bodyLong = next;
        });
      },
      // 只取最新一輪判斷有沒有失敗。失敗不擋主清單：這是附註，沒有它整頁照樣可用。
      async loadHealth() {
        try {
          const h = await Api.get('admin/health-check');
          this.healthFailed = (h && h.length && h[0].status === 'error') ? h[0] : null;
        } catch (e) { this.healthFailed = null; }
      },
      async load() {
        this.loading = true;
        try {
          const q = this.statusFilter ? `?status=${this.statusFilter}` : '';
          this.rows = await Api.get(`admin/feedback${q}`);
          // 換了資料就要重量：哪幾列長到需要收合，只有渲染出來才知道
          this.measureBodies();
          await this.loadAttachmentThumbs();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.loading = false; }
      },
      // 附件端點要帶 Authorization header，<img src> 直連拿不到 token → 逐張 fetch 成 objectURL。
      // 列表 LIMIT 200 × 每筆最多 5 張＝最壞 1000 張縮圖。原本逐張 await 會序列跑完全部 1000 次
      // 往返才解開 loading，改成固定併發窗口平行跑，同時不會一次開千條連線打爆瀏覽器。
      async loadAttachmentThumbs() {
        const tasks = [];
        for (const row of this.rows) {
          for (const file of (row.attachments || [])) {
            if (this.attachUrls[file.id]) continue;
            tasks.push(file.id);
          }
        }
        const CONCURRENCY = 6;
        const loadOne = async (fileId) => {
          try {
            const res = await fetch(`${BASE_PATH}api/feedback/attachments/${fileId}`, {
              headers: { Authorization: `Bearer ${Api.getToken()}` }
            });
            if (!res.ok) return;
            const blob = await res.blob();
            if (blob.size) this.attachUrls[fileId] = URL.createObjectURL(blob);
          } catch { /* 單張載不出來就不畫這張 */ }
        };
        let cursor = 0;
        const worker = async () => {
          while (cursor < tasks.length) {
            const fileId = tasks[cursor++];
            await loadOne(fileId);
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
      },
      async approve(row) {
        this.deciding = { ...this.deciding, [row.id]: true };
        try {
          await Api.patch(`admin/feedback/${row.id}`, { status: 'approved' });
          showToast('已核准', 'success');
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.deciding = { ...this.deciding, [row.id]: false }; }
      },
      openReject(row) {
        this.rejectNote = { ...this.rejectNote, [row.id]: this.rejectNote[row.id] || '' };
        this.rejecting = { ...this.rejecting, [row.id]: true };
      },
      cancelReject(row) {
        this.rejecting = { ...this.rejecting, [row.id]: false };
      },
      async confirmReject(row) {
        this.deciding = { ...this.deciding, [row.id]: true };
        try {
          await Api.patch(`admin/feedback/${row.id}`, {
            status: 'rejected',
            verdict_note: (this.rejectNote[row.id] || '').trim() || null,
          });
          showToast('已駁回', 'success');
          this.rejecting = { ...this.rejecting, [row.id]: false };
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.deciding = { ...this.deciding, [row.id]: false }; }
      },
    },
    template: `
      <div class="topbar ui-next-admin-head">
        <h1>改善提案</h1>
        <div class="ui-next-admin-head-actions"><button class="btn btn-outline btn-sm" @click="$router.push('/admin')">← 返回</button></div>
      </div>
      <div class="content">
        <!-- 健檢掛掉時它一筆單都不會開，這一頁看起來就跟「今天本來就沒事」一模一樣（此 repo 踩過：
             夜班空轉 98 輪無人察覺）。改善提案已收斂到這一頁，所以警示也要在這裡，不能只留在
             健檢紀錄頁——那頁現在是當 log 看的，沒事不會有人點進去。 -->
        <div v-if="healthFailed" class="error-msg" style="margin-bottom:var(--space-3)">
          ⚠ 上一輪 AI 健檢失敗（{{ new Date(healthFailed.created_at).toLocaleString() }}），這一輪沒有產生任何提案。
          <span v-if="healthFailed.error">原因：{{ healthFailed.error }}</span>
          <!-- 不吃 error-msg 的紅：連結在紅底上是紅字，實測幾乎看不到。用 --text 加底線，
               在深淺兩色主題下都讀得到（配色一律走變數，不寫死顏色）。 -->
          <a href="#/admin/health" style="margin-left:var(--space-2);color:var(--text);text-decoration:underline">看健檢紀錄 →</a>
        </div>
        <!-- 這裡不再自己掛橫幅：「批次在跑」已經由全站右上角的緞帶負責（見 UiNextApp.js
             的 .ui-next-ribbon）。同一件事在兩處各講一次，兩邊文案遲早會漂掉。
             這一頁只保留跟「按鈕」有關的本地回饋：執行中時鈕變成「執行中…」並鎖住。 -->
        <div class="settings-section">
          <div class="arj-header-row">
            <!-- 後端 GET /api/admin/feedback 有 LIMIT 200（feedback-routes.js），rows.length 在
                 超過上限時恆為 200、不代表真實總筆數；改用「最多顯示 N 筆」避免這個數字說謊。 -->
            <h2 class="section-title" style="margin:0">使用者意見（{{ rows.length >= 200 ? '最多顯示 200 筆' : ('共 ' + rows.length + ' 筆') }}）</h2>
            <select v-model="statusFilter" class="form-control" style="width:auto" @change="load">
              <option value="">全部狀態</option>
              <option value="new">待審核</option>
              <option value="approved">已核准</option>
              <option value="rejected">已駁回</option>
              <option value="done">已完成</option>
            </select>
            <!-- 只在真的有東西可跑時出現：沒有已核准的提案時按下去，批次會在「沒有候選」
                 那個早退分支立刻結束，連一列紀錄都不會留，看起來就像按了沒反應。 -->
            <button v-if="rows.some(r => r.status === 'approved') || batchRunning" class="btn btn-outline btn-sm"
              :disabled="startingBatch || batchRunning" @click="runBatch"
              title="把已核准的提案送去自動改碼、跑測試、審核後合併（可能重啟平台）">
              <span v-if="batchRunning" class="spinner"></span>{{ batchRunning ? '執行中…' : '立即執行改善' }}
            </button>
          </div>
          <div class="table-wrap table-cards-sm">
            <table class="data-table">
              <thead>
                <tr>
                  <!-- 原文是唯一的長文欄，其餘全是短欄。不給寬度的話瀏覽器會依內容平均分配，
                       把長文欄擠成細長條（實測「執行失敗：…」那欄窄到一個字一行）。
                       翻譯結果不在這裡：它同樣是長文，兩個長文欄並排等於兩邊都被壓扁，而且
                       日常只需要知道「這筆現在什麼狀態」——全文收進展開區，點該列就看得到。 -->
                  <th style="width:110px">時間</th>
                  <th style="width:100px">提交者</th>
                  <th>內容</th>
                  <th style="width:70px">附件</th>
                  <th style="width:120px">狀態</th>
                  <th style="width:190px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="loading" class="empty-row"><td colspan="6" style="text-align:center;color:var(--text-muted)">載入中...</td></tr>
                <tr v-else-if="rows.length === 0" class="empty-row"><td colspan="6">目前沒有意見</td></tr>
                <template v-for="r in rows" :key="r.id">
                  <!-- 整列可點開／收合。.clickable 同時給了 cursor 與 hover 底色，是這張表既有的
                       慣例（健檢歷史表也用它），不另外造一套「可點」的視覺提示。 -->
                  <tr class="clickable" @click="toggleRow(r)">
                    <td data-label="時間" style="font-size:var(--fs-sm);color:var(--text-muted)">{{ fmtTime(r.created_at) }}</td>
                    <!-- user_id 為 NULL＝健檢自己開的單（見 health-check-runner.js 的
                         openFeedbackForFinding）。顯示 '—' 會讓人以為是哪個使用者的帳號被刪了。 -->
                    <!-- pill 預設會斷行：在窄欄裡「AI 健檢」被拆成兩行、「已核准」被拆成三行的
                         直條（實測）。標籤本來就該整塊呈現，這兩處一律 nowrap。 -->
                    <td data-label="提交者">
                      <span v-if="!r.user_id" class="pill pill-info" style="white-space:nowrap">AI 健檢</span>
                      <span v-else>{{ r.user_name || '—' }}</span>
                    </td>
                    <td data-label="內容" style="font-size:var(--fs-sm)">
                      <div class="hc-body" :data-fbid="r.id" :class="{ 'hc-body-clamp': bodyClamped(r) }">{{ r.content }}</div>
                    </td>
                    <td data-label="附件">
                      <div v-if="(r.attachments||[]).length" style="display:flex;gap:6px;flex-wrap:wrap">
                        <!-- @click.stop：點圖是「看大圖」，不該順手把整列收合掉 -->
                        <img v-for="file in r.attachments" :key="file.id" v-show="attachUrls[file.id]"
                          :src="attachUrls[file.id]" :alt="file.filename" :title="'點開看原圖：' + file.filename"
                          @click.stop="openImage(file.id)"
                          style="width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid var(--border);cursor:zoom-in">
                      </div>
                      <span v-else style="color:var(--text-muted)">—</span>
                    </td>
                    <!-- 狀態要說「這筆現在卡在哪」：翻譯掛掉時 status 仍是 approved，只印
                         「已核准」等於把失敗藏起來。stateOf 把翻譯失敗／看不懂併進來一起顯示。 -->
                    <!-- 批次正在做這一筆時，狀態欄換成轉圈＋做到哪一步。最上面那條橫幅只說得出
                         「有東西在跑」，而一輪動輒數十分鐘，使用者要的是「現在在處理哪一筆」。
                         ⚠ 用 .spinner（app.css 既有）不要自己刻，深色模式的邊框色已經在那裡處理過。 -->
                    <td data-label="狀態">
                      <span v-if="r.batch_stage" style="display:inline-flex;align-items:center;white-space:nowrap;color:var(--info)">
                        <span class="spinner"></span>{{ r.batch_stage }}
                      </span>
                      <span v-else class="pill" :class="stateOf(r).pill" :title="stateOf(r).hint" style="white-space:nowrap">{{ stateOf(r).label }}</span>
                    </td>
                    <td data-label="操作" @click.stop>
                      <div style="display:flex;gap:6px;flex-wrap:wrap">
                        <!-- 核准鈕只在「還沒核准」時出現。已經是 approved 還留著它，按下去是把
                             同一個狀態再寫一次——畫面沒有任何變化，看起來像沒反應／沒存到。
                             done（已合併）更不能按：會把它塞回 approved，夜間批次重跑整條已經做完的鏈。
                             rejected 仍可核准（人工改變心意、重新開放）。
                             駁回鈕的條件不同：已核准但還沒跑的可以反悔擋掉，所以只擋 done。 -->
                        <button v-if="r.status !== 'approved' && r.status !== 'done'" class="btn btn-primary btn-sm" :disabled="deciding[r.id]" @click="approve(r)">核准</button>
                        <button v-if="r.status !== 'done'" class="btn btn-outline btn-sm" style="color:var(--danger)" :disabled="deciding[r.id]" @click="openReject(r)">駁回</button>
                        <!-- 刪除是唯一不可復原的動作（連附件實體檔一起刪），所以永遠可用但走
                             確認對話框。駁回只是改狀態，兩者不可混為一談。 -->
                        <button class="btn btn-ghost btn-sm" style="color:var(--danger)"
                          :disabled="removing[r.id]" @click="remove(r)">刪除</button>
                      </div>
                    </td>
                  </tr>
                  <!-- 展開區：原文全文與翻譯結果。翻譯結果從表格欄位移到這裡——它是長文，
                       跟原文並排會把兩邊都壓扁，而日常只需要看狀態欄那顆標籤。 -->
                  <tr v-if="bodyOpen[r.id]" class="empty-row">
                    <td colspan="6" style="background:var(--bg);text-align:left;padding:var(--space-3) var(--space-4)">
                      <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:4px">原文</div>
                      <div class="hc-body" style="font-size:var(--fs-sm);margin-bottom:var(--space-3)">{{ r.content }}</div>
                      <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:4px">翻譯結果</div>
                      <template v-if="r.triage_title">
                        <div style="font-size:var(--fs-sm)"><strong>{{ r.triage_title }}</strong></div>
                        <div v-if="r.triage_layer" style="font-size:var(--fs-sm);color:var(--text-muted)">{{ layerLabel[r.triage_layer] || r.triage_layer }}</div>
                        <div v-if="r.triage_detail" class="hc-body" style="font-size:var(--fs-sm)">{{ r.triage_detail }}</div>
                      </template>
                      <div v-else style="font-size:var(--fs-sm);color:var(--text-muted)">尚未翻譯</div>
                      <!-- triage_note 是「為什麼沒翻成功」的唯一說明（rejectBack 與執行失敗都只寫
                           這欄、triage_title 留空）。⚠ 不可用 .pill：那是 inline-block 短標籤，
                           欄位一窄就被壓成一個字一行的直條（實測「執行失敗：claude exited with
                           code 1」變成 6 行寬 1 字，就是使用者說的跑版）。 -->
                      <div v-if="r.triage_note" class="hc-body"
                        style="margin-top:6px;padding-left:6px;border-left:2px solid var(--warning-strong);font-size:var(--fs-xs);color:var(--warning-strong)">{{ r.triage_note }}</div>
                    </td>
                  </tr>
                  <tr v-if="rejecting[r.id]" class="empty-row">
                    <td colspan="6" style="background:var(--bg);text-align:left" @click.stop>
                      <div style="display:flex;gap:8px;align-items:flex-start">
                        <textarea v-model="rejectNote[r.id]" class="form-control" placeholder="駁回原因（選填）" style="flex:1;min-height:60px"></textarea>
                        <div style="display:flex;flex-direction:column;gap:6px">
                          <button class="btn btn-primary btn-sm" :disabled="deciding[r.id]" @click="confirmReject(r)">確認駁回</button>
                          <button class="btn btn-outline btn-sm" @click="cancelReject(r)">取消</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `
  });
})();
