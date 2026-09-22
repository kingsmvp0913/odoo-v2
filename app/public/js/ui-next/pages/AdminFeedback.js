(function () {
  const STATUS_LABEL = { new: '待審核', approved: '已核准', rejected: '已駁回', done: '已完成' };
  // 顏色照「事情走到哪」給，不是照字面：
  //   待審核 = 中性藍、已核准 = 還沒做完的琥珀、已駁回 = 紅、已完成 = 綠。
  // 原本 approved 給綠、done 給黃，語意剛好相反——綠色會讓人以為那條已經做完了。
  // ⚠ UiNextApp.js 的 myFeedbackStatusPill 是同一份對照的第二份寫死副本（前端無共用模組機制），
  //    由 frontend-feedback-status-pill.test.js 防漂移。改這裡要一起改那裡。
  const STATUS_PILL = { new: 'pill-info', approved: 'pill-warn', rejected: 'pill-danger', done: 'pill-success' };
  const LAYER_LABEL = { code: '程式', prompt: '提示詞', observability: '可觀測性', env: '環境', unclear: '看不懂' };

  // 修正列的狀態字面，沿用健檢頁那份的子集（只會走到稽核軌跡裡的幾種）。
  // 2026-09-22 隨「待更版」清單從已刪除的更版頁搬進來：更版是這一頁的流程的最後一步
  // （提案 → 核准 → 夜間批次改碼 → 合併 → 生效），把最後一步切成另一頁等於把流程砍一半。
  const FIX_STATUS = {
    running: '改碼中', ready: '待審', adopted: '已採用', pushed: '已推上 GitHub',
    merged: '已合併，待更版', released: '已更版', rejected: '被退回', failed: '失敗',
    no_change: '判定不用改',
  };

  // 一次載幾筆。整頁原本一口氣撈 200 筆，每筆的附件縮圖還要逐張 fetch（最壞 1000 張往返），
  // 開頁面要等很久才看得到第一列。改成先載一頁、捲到接近底部才續載。
  const PAGE_SIZE = 15;
  // 距離底部多少 px 就開始載下一頁。抓一個視窗高度左右：等真的捲到底才發請求，
  // 使用者會先看到一段空白再看到新列。
  const NEAR_BOTTOM_PX = 600;

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
        hasMore: true,     // 後端還有下一頁（用「這次拿滿了 limit」推斷，端點不回總筆數）
        loadingMore: false,// 續載中（與初次 loading 分開：初次要蓋掉整張表，續載只在底部轉圈）
        _scrollEl: null,   // 監聽捲動的元素（ui-next 真正在捲的是 .ui-next-main，不是 window）
        _onScroll: null,
        startingBatch: false, // 手動觸發改善批次送出中（只是「送出這一下」，不是整個批次）
        batchRunning: false,  // 批次正在跑（輪詢 /api/maintenance 得知）
        _batchTimer: null,
        // 更版（流程最後一步）。整包來自 GET /api/admin/release，後端未因這次搬家改動。
        release: null,
        releasing: false,
        // 立刻更版的兩個旋鈕。預設都關：兩個都是「明知會付出代價還是要做」的選項。
        abortInflight: false,
        skipTests: false,
        trailOpen: {},    // { [fixId]: true } 展開這一筆的稽核軌跡
        trail: {},        // { [findingId]: [...] } 抓過就留著
        trailLoading: {},
        diffOpen: {},     // { [historyRowId]: true }
      };
    },
    computed: {
      // 待更版＝已合併但還沒生效的修正。沒有它，核准完的提案在畫面上看起來就是「做完了」，
      // 但平台其實還跑著舊碼。
      releasePending() { return (this.release && this.release.pending) || []; },
      releaseInflight() { return (this.release && this.release.inflight) || []; },
      releaseNextText() {
        const at = this.release && this.release.window && this.release.window.nextWindowAt;
        return at ? new Date(at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '未設定';
      },
      // statusLabel 不再是 computed：狀態欄改由 stateOf 產生（要把翻譯失敗併進來一起顯示），
      // 那裡直接讀 STATUS_LABEL 常數，留著 computed 就是沒人讀的死碼。
      layerLabel() { return LAYER_LABEL; },
    },
    async created() {
      await this.load(); await this.loadHealth(); await this.loadRelease();
      // 批次可能是別人按的、或是每晚 22:00 排程跑的——不能只在「自己按下去」之後才輪詢，
      // 否則同一件事在不同人的畫面上有不同的樣子。一進頁面就開始盯。
      await this.pollBatch();
      this._batchTimer = setInterval(() => this.pollBatch(), 15000);
    },
    mounted() {
      // ⚠ 捲動的是 .ui-next-main，不是 window 也不是 .content（見 ui-next.css：
      // .ui-next-shell 是 overflow:hidden 的固定高外殼，只有 .ui-next-main 有 overflow:auto）。
      // 掛在 window 上的 scroll 監聽在這個外殼下永遠不會觸發。
      // 舊外殼（?ui=legacy）沒有這個元素，那邊就退回「只顯示第一頁 + 底部按鈕」。
      this._scrollEl = document.querySelector('.ui-next-main');
      if (!this._scrollEl) return;
      this._onScroll = () => {
        const el = this._scrollEl;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) this.loadMore();
      };
      this._scrollEl.addEventListener('scroll', this._onScroll, { passive: true });
    },
    beforeUnmount() {
      Object.values(this.attachUrls).forEach(url => URL.revokeObjectURL(url));
      if (this._batchTimer) clearInterval(this._batchTimer);
      if (this._scrollEl && this._onScroll) this._scrollEl.removeEventListener('scroll', this._onScroll);
    },
    methods: {
      pillClass(status) { return STATUS_PILL[status] || 'pill-info'; },
      /**
       * 健檢自己開的單是拿同一段 diagnosis 同時當 content 與 triage_detail（見
       * health-check-runner 的 openFeedbackForFinding 與 db.js 的補單 SQL），而 agent_label
       * 又常常就是 diagnosis 的第一行。整段照印的話同一段話會在同一畫面上出現三次：
       * 內容欄、展開區的標題、展開區的內文——使用者說的「點開來就是一大堆文字」有一半是這個。
       * 一樣就不印；整塊都沒有新資訊時連標籤都不出現。
       */
      firstLine(t) { return String(t || '').split('\n').map(l => l.trim()).find(Boolean) || ''; },
      showTriageTitle(r) { return !!r.triage_title && r.triage_title.trim() !== this.firstLine(r.content); },
      showTriageDetail(r) { return !!r.triage_detail && r.triage_detail.trim() !== String(r.content || '').trim(); },
      showTriageBlock(r) { return this.showTriageTitle(r) || this.showTriageDetail(r) || !!r.triage_layer; },
      fmtTime(ts) { return new Date(ts).toLocaleString('zh-TW'); },
      // 健檢自己開的單，content 是整段診斷（好幾百字）。攤開的話一列就吃掉整個畫面高度，
      // 「這頁有幾筆待審」完全看不出來。長的先切短、點那一列就展開。
      // ⚠ 判長短只能量 DOM 不能估字數：中英混排與換行讓同樣字數高度差很多（健檢頁那邊用字數
      // 估，實測有一半的按鈕按下去畫面完全不動）。6.4 要與 app.css 的 .hc-body-clamp 一致。
      /**
       * 內容欄一律維持收合，**不因為展開而解除**。
       *
       * 原本展開時就地放全文，而那一欄只有 ~300px 寬：健檢開的單內文動輒一兩千字，於是變成
       * 一條又窄又高的文字柱（使用者：「點開來看到的就是一大堆文字」）。改成欄位永遠只給
       * 兩行預覽，全文改由展開區用整列寬度呈現——同一段話仍然只出現一次（見下面 showRaw）。
       */
      bodyClamped(r) { return this.bodyLong[r.id] === true; },
      // 只有「欄位真的被切掉」時才在展開區補全文；短內容上面那格已經看得完，補了就是重複。
      showRaw(r) { return this.bodyLong[r.id] === true; },
      // 整列可點：按鈕與附件縮圖各自 @click.stop，否則按「駁回」會順手把列也展開／收合。
      toggleRow(r) { this.bodyOpen = { ...this.bodyOpen, [r.id]: !this.bodyOpen[r.id] }; },
      // 狀態欄要說的是「這筆現在卡在哪」，而不只是人工裁決的那個欄位值：試過沒成、被機器踢
      // 回來這兩種，status 欄位都看不出來，只印「已核准／待審核」等於把過程藏起來。
      stateOf(r) {
        const note = r.triage_note || '';
        // 夜間批次的機器退場（連續失敗達門檻／layer 不可自動修）：status 被寫回 'new'，
        // 只印「待審核」會看起來像使用者剛提的新意見，完全看不出它跑過又被踢回來。
        // ⚠ 這個前綴與後端 retire-prefix.js 的 MACHINE_RETIRE_PREFIX 是兩份寫死的字面值，
        // 靠 frontend-nightly-retire-prefix.test.js 防漂移（前後端無共用模組機制是已裁決的
        // 取捨）。改字（含把全形冒號打成半形）會讓這個狀態靜默消失，那支測試會紅。
        // 「改碼那關讀完程式碼判定不該做」也走這條（no_change → retireToHuman），
        // 所以拿掉翻譯關之後這仍是機器退場的唯一出口。
        // ⚠ 條件要連 status 一起看：retireToHuman 只把 status 寫回 'new'（nightly-fix.js:469），
        // 人後來核准／駁回／標完成時**不會清掉 triage_note**（feedback-routes.js 的 PATCH 只寫
        // status／verdict_note）。少了這個條件，已經修完合併的那幾筆會永遠掛著「待人工」——
        // 2026-09-21 實際踩到：#37／#38 早已 done，列表仍顯示自動退場待人工，看起來像沒人處理。
        if (r.status === 'new' && note.startsWith('自動退場：')) {
          return { label: '自動退場，待人工', pill: 'pill-warn', hint: note };
        }
        // 「今晚連跑都沒跑到」與「跑了沒成功」是兩件事，狀態欄不能混為一談：前者還在隊伍裡、
        // 什麼都沒發生，後者已經燒過一輪 token 並失敗。後端寫進 last_attempt_note 的前綴是
        // nightly-fix.js 四條「本批次不跑」出口共用的（來源常數 retire-prefix.js 的
        // NIGHTLY_SKIP_PREFIX）。
        // ⚠ 這條必須排在上面「自動退場」那條**之後**：frontend-nightly-retire-prefix.test.js
        // 抓的是 stateOf 裡的**第一個** startsWith，插到前面會讓那支既有守衛改抓到這個前綴。
        if (r.status === 'approved' && (r.last_attempt_note || '').startsWith('本批次未執行：')) {
          return { label: '已核准，本批次未執行', pill: 'pill-info', hint: r.last_attempt_note };
        }
        // 已核准但夜間批次試過沒成：只印「已核准」的話，這一列跟「今晚還沒輪到它」長得一模一樣。
        // 原因以前只進 console.error（本平台的 pipeline console 不落檔＝等於沒寫），要累計三次
        // 退場了才由 triage_note 講出來——前兩次一樣是無聲的。後端 last_attempt_note 補的就是這段。
        if (r.status === 'approved' && r.last_attempt_note) {
          return { label: '改善中，上次未完成', pill: 'pill-warn', hint: r.last_attempt_note };
        }
        return { label: STATUS_LABEL[r.status] || r.status, pill: this.pillClass(r.status), hint: '' };
      },
      // 縮圖是 objectURL（附件端點要帶 token，<img src> 直連拿不到）。放大走全域跳窗
      // （js/image-preview.js），與對話頁、任務詳情同一套；原本是另開分頁。
      openImage(fileId, filename) {
        const url = this.attachUrls[fileId];
        if (url) window.previewImage({ src: url, alt: filename || '' });
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
      // 更版狀態。讀不到就不畫那一區（多半是沒有平台管理員權限），不讓它把整頁變成錯誤畫面。
      async loadRelease() {
        try {
          const r = await Api.get('admin/release');
          this.release = r;
          this.releasing = !!r.running;
        } catch (_) { this.release = null; }
      },
      /**
       * 立刻更版：把已合併的修正真的放上去。放在「立即執行改善」旁邊是因為兩者是同一條流程的
       * 相鄰兩步（改善批次把碼合進 master，更版才讓它生效），而且都是「會重啟平台」的那種按鈕。
       */
      async releaseNow() {
        const parts = [`會把 ${this.releasePending.length} 筆已合併的修正真的放上去，平台重啟約 30 秒。`];
        if (this.releaseInflight.length) {
          parts.push(this.abortInflight
            ? `⚠ ${this.releaseInflight.length} 條在飛任務會被當場中止（改到一半的碼留在任務分支，重啟後自動從同一關重跑）。`
            : `⚠ 現在有 ${this.releaseInflight.length} 條任務在飛，沒有勾「一併中止」的話按下去會被擋下來。`);
        }
        parts.push(this.skipTests
          ? '⚠ 你選了跳過重啟前全跑——這一次更版不會留下任何測試證據。'
          : '重啟前會先對 master 跑一次全套測試，約 2 分鐘；紅了就不重啟，碼留到下一次。');
        if (!await confirmDialog({ title: '立刻更版', message: parts.join('\n'), confirmText: '立刻更版' })) return;
        this.releasing = true;
        try {
          await Api.post('admin/release/now', { abortInflight: this.abortInflight, skipTests: this.skipTests });
          showToast(this.skipTests ? '更版已開始' : '更版已開始，先跑全套測試（約 2 分鐘）', 'success');
          await this.loadRelease();
        } catch (e) {
          this.releasing = false;
          showToast(e.message, 'error');
        }
      },
      /**
       * 稽核軌跡：這段碼是依據哪段文字改的、誰審過、複檢動了什麼。
       * 用既有的 GET admin/health-check/findings/:id/fix——它已經回整段歷史（新到舊），
       * 所以「被退回過一輪、重修才通過」也看得到，不只是最後那一筆。
       * 沒有人在合併前讀過這些碼，這是唯一的人工稽核材料。
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
      // 模板裡不寫 function 字面值：那種寫法在既有頁面只出現在 methods 裡。
      inflightIds() { return this.releaseInflight.map(t => t.taskId).join('、#'); },
      fixStatus(s) { return FIX_STATUS[s] || s; },
      fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : ''; },
      shortSha(s) { return s ? String(s).slice(0, 8) : ''; },
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
        // 更版狀態跟著同一個 15 秒節奏刷新：批次合併完會多出待更版的筆數，而更版跑起來之後
        // 這個行程隨時可能被自己的重啟帶走，畫面不會收到任何事件——輪詢是唯一看得到結果的方式。
        await this.loadRelease();
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
      // 端點不回總筆數，只能用「這次拿滿了 limit」推斷還有下一頁。
      // 拿不滿＝到底了；剛好拿滿而其實沒有下一頁時，只會多發一次回空陣列的請求，然後收手。
      query(limit, offset) {
        const p = [`limit=${limit}`, `offset=${offset}`];
        if (this.statusFilter) p.push(`status=${this.statusFilter}`);
        return `admin/feedback?${p.join('&')}`;
      },
      /**
       * 重抓第一頁。
       *
       * ⚠ limit 取「目前已載入的筆數」而不是固定 PAGE_SIZE：批次在跑的時候 pollBatch 每 15 秒
       * 會呼叫一次 load()，用 PAGE_SIZE 重抓的話使用者往下捲了五頁、下一個 tick 整個縮回 15 筆，
       * 捲動位置也跟著跳。換篩選才是真的要從頭來（走 resetAndLoad）。
       */
      async load() {
        this.loading = true;
        try {
          const limit = Math.min(Math.max(PAGE_SIZE, this.rows.length), 200);
          const rows = await Api.get(this.query(limit, 0));
          this.rows = rows;
          this.hasMore = rows.length === limit;
          // 換了資料就要重量：哪幾列長到需要收合，只有渲染出來才知道
          this.measureBodies();
          await this.loadAttachmentThumbs();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.loading = false; }
      },
      // 換篩選：真的從第一頁重來（已載入的是別的條件的資料，留著沒有意義）
      async resetAndLoad() {
        this.rows = [];
        this.hasMore = true;
        await this.load();
      },
      async loadMore() {
        if (this.loadingMore || this.loading || !this.hasMore) return;
        this.loadingMore = true;
        try {
          const rows = await Api.get(this.query(PAGE_SIZE, this.rows.length));
          // 併發保險：載入期間若有人按了核准（觸發 load() 重抓第一頁），這批的 offset 就過期了。
          // 用 id 去重，寧可少一筆也不要同一列出現兩次（Vue 的 :key 撞號會渲染錯亂）。
          const seen = new Set(this.rows.map(r => r.id));
          this.rows = this.rows.concat(rows.filter(r => !seen.has(r.id)));
          this.hasMore = rows.length === PAGE_SIZE;
          this.measureBodies();
          await this.loadAttachmentThumbs();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.loadingMore = false; }
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
      /**
       * 人工標完成：「這條我自己動手修好了」。
       *
       * 留在 approved 的話夜間批次每晚會重撿一次（重付 triage、重跑兩次全套測試），改成駁回
       * 又等於謊稱「決定不做」——2026-09-10 就是因為沒有這條路，只能繞過 API 直接改資料庫。
       */
      async markDone(row) {
        const what = row.triage_title || (row.content || '').slice(0, 30);
        if (!await confirmDialog({
          title: '標記為已完成',
          message: `確定把「${what}」標成已完成？夜間批次不會再撿它，之後也不能刪除。`,
          confirmText: '標為完成'
        })) return;
        this.deciding = { ...this.deciding, [row.id]: true };
        try {
          await Api.patch(`admin/feedback/${row.id}`, { status: 'done', verdict_note: '人工處理完成' });
          showToast('已標記完成', 'success');
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
        <!-- 流程的最後一步：已合併但還沒生效的修正。2026-09-22 使用者裁決把獨立的「平台更版」頁
             收進這一頁——提案 → 核准 → 夜間批次改碼 → 合併 → 生效是同一條流程，最後一步切成
             另一頁的話，核准完的人只會看到「已完成」，不知道平台其實還跑著舊碼。
             時段設定（星期幾、幾點）不在這裡，它是系統設定的一種，在「系統設定 → 進階」。 -->
        <div v-if="release" class="settings-section">
          <div class="arj-header-row">
            <h2 class="section-title" style="margin:0">待更版 {{ releasePending.length }} 筆・下一次維護時段 {{ releaseNextText }}</h2>
            <!-- 立刻更版擺在「立即執行改善」正上方：兩者是相鄰的兩步，也都是會重啟平台的按鈕。
                 沒有待更版的碼時不必重啟，所以那時鈕是停用的。 -->
            <button class="btn btn-outline btn-sm" :disabled="releasing || !releasePending.length" @click="releaseNow"
              title="把已合併的修正真的放上去（平台會重啟，約 30 秒）">
              <span v-if="releasing" class="spinner"></span>{{ releasing ? '更版中…' : '立刻更版' }}
            </button>
          </div>
          <div v-if="!release.window.configured" style="font-size:var(--fs-sm);color:var(--warning-strong);margin-bottom:var(--space-2)">
            ⚠ 沒有設定維護時段，平台不會自動更版——這些碼會一直停在這裡。時段在「系統設定 → 進階」設定。
          </div>
          <div v-else style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:var(--space-2)">
            時段：{{ release.window.label }}<span v-if="release.window.inWindow">（<strong style="color:var(--warning-strong)">現在就在時段內</strong>）</span>。
            重啟前對 master 跑一次全套測試，紅了就不重啟、碼留到下一個時段；時段內若還有任務在飛，
            離時段結束剩 {{ release.abortMinutes }} 分鐘時會<strong>強制中止</strong>它們並照常重啟（那些任務重啟後自動從同一關重跑）。
          </div>
          <div v-if="release.maintenance" style="font-size:var(--fs-sm);color:var(--warning-strong);margin-bottom:var(--space-2)">
            目前正在維護中（多半是改善批次還沒收工）。等它結束再按「立刻更版」——中途重啟會讓它的 git push 停在半途。
          </div>
          <div v-if="releaseInflight.length" style="font-size:var(--fs-sm);color:var(--warning-strong);margin-bottom:var(--space-2)">
            現在有 {{ releaseInflight.length }} 條任務在飛：#{{ inflightIds() }}
          </div>
          <div v-if="releasePending.length" style="display:flex;flex-direction:column;gap:4px;margin-bottom:var(--space-2)">
            <label style="display:flex;align-items:center;gap:var(--space-2);font-size:var(--fs-sm);color:var(--text)">
              <input type="checkbox" v-model="abortInflight">
              一併中止在飛任務（它們會在平台重啟後自動從同一關重跑）
            </label>
            <label style="display:flex;align-items:center;gap:var(--space-2);font-size:var(--fs-sm);color:var(--text)">
              <input type="checkbox" v-model="skipTests">
              跳過重啟前全跑（只省約 2 分鐘，<strong style="color:var(--danger)">這一次更版不會留下任何測試證據</strong>）
            </label>
          </div>
          <div v-if="!releasePending.length" class="empty-state" style="padding:var(--space-4)">
            沒有待更版的修正。這種時候時段到了也不會重啟——不打擾客戶是刻意的。
          </div>
          <div v-for="row in releasePending" :key="row.id"
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
        <div class="settings-section">
          <div class="arj-header-row">
            <!-- 端點不回總筆數（見 feedback-routes.js），所以這裡只講「已載入幾筆」——
                 寫成「共 N 筆」在分頁之下必定說謊：捲一次數字就變一次。 -->
            <h2 class="section-title" style="margin:0">使用者意見（已載入 {{ rows.length }} 筆{{ hasMore ? '，往下捲載入更多' : '' }}）</h2>
            <select v-model="statusFilter" class="form-control" style="width:auto" @change="resetAndLoad">
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
                          :src="attachUrls[file.id]" :alt="file.filename" :title="'點擊放大：' + file.filename"
                          @click.stop="openImage(file.id,file.filename)"
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
                    <!-- 操作欄一列最多兩顆鈕，而且只留「這個狀態下真的有意義」的那幾顆。
                         原本每列固定三顆（核准／駁回／刪除），整張表就是一面按鈕牆，而其中
                         有些在該狀態下按下去等於沒事發生（已核准再按核准＝把同一個狀態寫一次，
                         畫面毫無變化，看起來像沒存到）。
                         刪除搬進展開區：它是唯一不可復原的動作，不該跟日常裁決並排在同一排、
                         被誤點的機率相同。點該列展開就看得到。
                         各狀態的可用動作：
                           待審核 new       → 核准 ／ 駁回
                           已核准 approved  → 標為完成（自己動手修好了）／ 駁回（反悔擋掉，批次還沒跑）
                           已駁回 rejected  → 核准（改變心意、重新開放）
                           已完成 done      → 無。碼已經合併，再改任何狀態都會讓批次重跑做完的事。 -->
                    <td data-label="操作" @click.stop>
                      <div style="display:flex;gap:6px;flex-wrap:wrap">
                        <button v-if="r.status === 'new' || r.status === 'rejected'" class="btn btn-primary btn-sm" :disabled="deciding[r.id]" @click="approve(r)">核准</button>
                        <button v-if="r.status === 'approved'" class="btn btn-primary btn-sm" :disabled="deciding[r.id]" @click="markDone(r)">標為完成</button>
                        <button v-if="r.status === 'new' || r.status === 'approved'" class="btn btn-outline btn-sm" style="color:var(--danger)" :disabled="deciding[r.id]" @click="openReject(r)">駁回</button>
                        <span v-if="r.status === 'done'" style="color:var(--text-muted)">—</span>
                      </div>
                    </td>
                  </tr>
                  <!-- 展開區＝「這一列上面看不到的東西」。
                       ⚠ 不再重印原文：上面那格的收合（.hc-body-clamp）在展開時就解除了（見
                       bodyClamped），全文本來就在同一畫面上，再印一次等於同一段話出現兩次，
                       把真正只有這裡才看得到的東西（駁回原因、上次為什麼沒過）擠到下面。 -->
                  <tr v-if="bodyOpen[r.id]" class="empty-row">
                    <td colspan="6" style="background:var(--bg);text-align:left;padding:var(--space-3) var(--space-4)">
                      <!-- 左標右值的兩欄清單（樣式見 07-admin.css 的 .afb-detail）。
                           標籤一律短，長的補充說明放進值裡的 <small>，否則左欄被撐開、
                           同一頁不同列的對齊線會各自不同。 -->
                      <dl class="afb-detail">
                        <!-- 全文。上面那格永遠只給兩行預覽（見 bodyClamped），所以這裡不是重複——
                             它是同一段話唯一完整呈現的地方，而且用的是整列寬度，不是 300px 的窄欄。 -->
                        <template v-if="showRaw(r)">
                          <dt>原文</dt>
                          <dd class="hc-body">{{ r.content }}</dd>
                        </template>
                        <!-- triage_* 有兩種來源，標籤要分清楚，否則使用者會以為自己的意見被健檢改寫過：
                             ① 健檢自己開的單（user_id 為 NULL）——health-check-runner 開單時直接填好；
                             ② 2026-09-09 之前使用者提的意見——當時還有一關 agent 把原文翻成規格，
                                那一關已經拿掉（platform-fix 直接讀原文），新的意見不會再有值。 -->
                        <template v-if="showTriageBlock(r)">
                          <dt>{{ r.user_id ? 'AI 描述' : '健檢描述' }}</dt>
                          <dd>
                            <strong v-if="showTriageTitle(r)">{{ r.triage_title }}</strong>
                            <div v-if="showTriageDetail(r)" class="hc-body" :style="showTriageTitle(r) ? 'margin-top:4px' : ''">{{ r.triage_detail }}</div>
                            <small v-if="r.triage_layer">分類：{{ layerLabel[r.triage_layer] || r.triage_layer }}</small>
                            <small v-if="r.user_id">舊資料——把原文翻成規格的那一關已於 2026-09-09 移除</small>
                          </dd>
                        </template>
                        <!-- 人工裁決時打的字（駁回原因／標完成的說明）。它是這一頁唯一存得下「為什麼
                             做這個決定」的地方，原本卻整個沒有畫出來——打了字、存進資料庫，
                             然後在畫面上永遠找不到。 -->
                        <template v-if="r.verdict_note">
                          <dt>{{ r.status === 'rejected' ? '駁回原因' : '裁決說明' }}</dt>
                          <dd class="hc-body">{{ r.verdict_note }}</dd>
                        </template>
                        <!-- 上次批次為什麼沒過／沒跑到。原本只掛在狀態標籤的 title（滑鼠停留才看得到），
                             而那顆標籤上寫的正是「上次未完成」——問「為什麼」的人找不到答案。 -->
                        <template v-if="r.last_attempt_note">
                          <dt>上次改善</dt>
                          <dd class="hc-body">{{ r.last_attempt_note }}</dd>
                        </template>
                        <!-- triage_note 是「為什麼被機器退回人工」的唯一說明。
                             ⚠ 不可用 .pill：那是 inline-block 短標籤，欄位一窄就被壓成一個字一行的
                             直條（實測「執行失敗：claude exited with code 1」變成 6 行寬 1 字）。 -->
                        <template v-if="r.triage_note">
                          <dt>退回人工</dt>
                          <dd class="hc-body afb-warn">{{ r.triage_note }}</dd>
                        </template>
                      </dl>
                      <!-- 四塊都空又不能刪（已完成）時整格會是空白，看起來像展開壞掉。 -->
                      <div v-if="!showRaw(r) && !showTriageBlock(r) && !r.verdict_note && !r.last_attempt_note && !r.triage_note && r.status === 'done'"
                        style="font-size:var(--fs-sm);color:var(--text-muted)">沒有其他資訊</div>
                      <!-- 刪除放這裡而不是操作欄：不可復原（連附件實體檔一起刪），要多一個
                           「點開這一列」的動作才碰得到。已完成的不給刪——碼已經合併進 master，
                           刪掉等於把「這件事為什麼做」的唯一紀錄清掉（後端也擋，見 feedback-routes.js）。 -->
                      <div v-if="r.status !== 'done'" style="margin-top:var(--space-3);text-align:right">
                        <button class="btn btn-ghost btn-sm" style="color:var(--danger)"
                          :disabled="removing[r.id]" @click.stop="remove(r)">刪除這筆</button>
                      </div>
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
                <!-- 續載中的提示。捲動監聽掛在 .ui-next-main（見 mounted），舊外殼沒有那個元素，
                     所以還留一顆手動的鈕當退路——不然那邊永遠只看得到第一頁。 -->
                <tr v-if="loadingMore" class="empty-row">
                  <td colspan="6" style="text-align:center;color:var(--text-muted)"><span class="spinner"></span>載入中…</td>
                </tr>
                <tr v-else-if="hasMore && !loading && rows.length" class="empty-row">
                  <td colspan="6" style="text-align:center">
                    <button class="btn btn-outline btn-sm" @click="loadMore">載入更多</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `
  });
})();
