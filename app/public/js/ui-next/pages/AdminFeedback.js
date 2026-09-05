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
        bodyOpen: {},      // { [id]: true } 展開這一列的原文／翻譯全文
        bodyLong: {},      // { [id]: true } 這一列長到需要收合（量 DOM 得來，見 measureBodies）
      };
    },
    computed: {
      statusLabel() { return STATUS_LABEL; },
      layerLabel() { return LAYER_LABEL; },
    },
    async created() { await this.load(); await this.loadHealth(); },
    beforeUnmount() {
      Object.values(this.attachUrls).forEach(url => URL.revokeObjectURL(url));
    },
    methods: {
      pillClass(status) { return STATUS_PILL[status] || 'pill-info'; },
      fmtTime(ts) { return new Date(ts).toLocaleString('zh-TW'); },
      // 健檢自己開的單，content 是整段診斷（好幾百字），翻譯結果那欄同樣是長文。兩欄一起攤開，
      // 一列就吃掉整個畫面高度，「這頁有幾筆待審」完全看不出來。長的先切短、要看再點開。
      // ⚠ 判長短只能量 DOM 不能估字數：中英混排與換行讓同樣字數高度差很多（健檢頁那邊用字數
      // 估，實測有一半的按鈕按下去畫面完全不動）。6.4 要與 app.css 的 .hc-body-clamp 一致。
      bodyClamped(r) { return this.bodyLong[r.id] === true && !this.bodyOpen[r.id]; },
      isLongBody(r) { return this.bodyLong[r.id] === true; },
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
          </div>
          <div class="table-wrap table-cards-sm">
            <table class="data-table">
              <thead>
                <tr>
                  <!-- 原文與翻譯結果是這張表唯一的長文欄，其餘全是短欄。不給寬度的話瀏覽器會
                       依內容平均分配，把兩個長文欄擠成細長條（實測翻譯結果欄窄到一個字一行）。 -->
                  <th style="width:110px">時間</th>
                  <th style="width:100px">提交者</th>
                  <th style="width:33%">原文</th>
                  <th style="width:70px">附件</th>
                  <th style="width:100px">狀態</th>
                  <th style="width:33%">翻譯結果</th>
                  <th style="width:150px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="loading" class="empty-row"><td colspan="7" style="text-align:center;color:var(--text-muted)">載入中...</td></tr>
                <tr v-else-if="rows.length === 0" class="empty-row"><td colspan="7">目前沒有意見</td></tr>
                <template v-for="r in rows" :key="r.id">
                  <tr>
                    <td data-label="時間" style="font-size:var(--fs-sm);color:var(--text-muted)">{{ fmtTime(r.created_at) }}</td>
                    <!-- user_id 為 NULL＝健檢自己開的單（見 health-check-runner.js 的
                         openFeedbackForFinding）。顯示 '—' 會讓人以為是哪個使用者的帳號被刪了。 -->
                    <!-- pill 預設會斷行：在窄欄裡「AI 健檢」被拆成兩行、「已核准」被拆成三行的
                         直條（實測）。標籤本來就該整塊呈現，這兩處一律 nowrap。 -->
                    <td data-label="提交者">
                      <span v-if="!r.user_id" class="pill pill-info" style="white-space:nowrap">AI 健檢</span>
                      <span v-else>{{ r.user_name || '—' }}</span>
                    </td>
                    <td data-label="原文" style="font-size:var(--fs-sm)">
                      <div class="hc-body" :data-fbid="r.id" :class="{ 'hc-body-clamp': bodyClamped(r) }">{{ r.content }}</div>
                    </td>
                    <td data-label="附件">
                      <div v-if="(r.attachments||[]).length" style="display:flex;gap:6px;flex-wrap:wrap">
                        <img v-for="file in r.attachments" :key="file.id" v-show="attachUrls[file.id]"
                          :src="attachUrls[file.id]" :alt="file.filename" :title="file.filename"
                          style="width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid var(--border)">
                      </div>
                      <span v-else style="color:var(--text-muted)">—</span>
                    </td>
                    <td data-label="狀態"><span class="pill" :class="pillClass(r.status)" style="white-space:nowrap">{{ statusLabel[r.status] || r.status }}</span></td>
                    <td data-label="翻譯結果" style="font-size:var(--fs-sm)">
                      <template v-if="r.triage_title">
                        <div><strong>{{ r.triage_title }}</strong></div>
                        <div v-if="r.triage_layer" style="color:var(--text-muted)">{{ layerLabel[r.triage_layer] || r.triage_layer }}</div>
                        <div v-if="r.triage_detail" class="hc-body" :data-fbid="r.id" :class="{ 'hc-body-clamp': bodyClamped(r) }">{{ r.triage_detail }}</div>
                      </template>
                      <span v-else style="color:var(--text-muted)">尚未翻譯</span>
                      <!-- triage_note 不能綁在 triage_title 底下：AI 看不懂／解析失敗／agent 執行失敗
                           時 rejectBack 只寫 triage_note、triage_title 是 NULL，這句話是唯一告訴
                           管理員「為什麼退回」的地方，藏起來等於管理員永遠看不到原因。 -->
                      <!-- ⚠ 不可用 .pill：pill 是 inline-block 的短標籤，套在這種整句訊息上，
                           欄位一窄就被壓成一個字一行的直條（實測「執行失敗：claude exited with
                           code 1」在這欄變成 6 行寬 1 字的長條，就是使用者說的跑版）。
                           改用一般文字塊＋左側色條表示警示，語意一樣但寬度吃得下。 -->
                      <div v-if="r.triage_note" class="hc-body"
                        style="margin-top:4px;padding-left:6px;border-left:2px solid var(--warning-strong);font-size:var(--fs-xs);color:var(--warning-strong)">{{ r.triage_note }}</div>
                    </td>
                    <td data-label="操作">
                      <div style="display:flex;gap:6px;flex-wrap:wrap">
                        <!-- 核准鈕只在「還沒核准」時出現。已經是 approved 還留著它，按下去是把
                             同一個狀態再寫一次——畫面沒有任何變化，看起來像沒反應／沒存到。
                             done（已合併）更不能按：會把它塞回 approved，夜間批次重跑整條已經做完的鏈。
                             rejected 仍可核准（人工改變心意、重新開放）。
                             駁回鈕的條件不同：已核准但還沒跑的可以反悔擋掉，所以只擋 done。 -->
                        <button v-if="r.status !== 'approved' && r.status !== 'done'" class="btn btn-primary btn-sm" :disabled="deciding[r.id]" @click="approve(r)">核准</button>
                        <button v-if="r.status !== 'done'" class="btn btn-outline btn-sm" style="color:var(--danger)" :disabled="deciding[r.id]" @click="openReject(r)">駁回</button>
                        <!-- 只在真的被切到時才出現：沒被切還掛按鈕，按下去畫面完全不動＝騙人的按鈕 -->
                        <button v-if="isLongBody(r)" class="btn btn-ghost btn-sm"
                          @click="bodyOpen[r.id] = !bodyOpen[r.id]">{{ bodyOpen[r.id] ? '▾ 收合' : '▸ 看全文' }}</button>
                      </div>
                    </td>
                  </tr>
                  <tr v-if="rejecting[r.id]" class="empty-row">
                    <td colspan="7" style="background:var(--bg);text-align:left">
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
