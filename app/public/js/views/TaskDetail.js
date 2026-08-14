const ANSWER_ALLOWED = ['confirm_pending', 'clarify_pending'];
// 機器輸入型訊息的前綴與收合文案在 js/machine-logs.js（後端寫入端 require 同一份）——本檔不得自帶第二份。
window.TaskDetailView = Vue.defineComponent({
  name: 'TaskDetailView',
  data() {
    return { task: null, logs: [], loading: true, resolution: '', csAnswers: {}, odooUrl: '', serviceUrl: '', submitting: false, approving: false, archiving: false, rejecting: false, rejectReason: '', conflictResolving: false, conflictChoices: {}, submittingConflicts: false, clarifying: {}, clarifyText: {}, csConfirming: false, csRetrying: false, csFollowup: '', csFollowingUp: false, resolving: false, error: '', serverConfirmedRunning: false, testMode: false, stepping: false, events: [], eventsHasMore: true, eventsLoading: false, editingContent: false, editText: '', savingContent: false, taskMessages: [], sendingMessage: false, newMessageText: '', writebackEnabled: false, messageWriteback: false, ticketAttachments: [], newMessageFiles: [], diffOpen: false, diffLoading: false, diffError: '', diffData: null, clarification: { summary: '', questions: [] }, answerFields: {}, answerExtra: {}, clarTab: 'qa', askText: '', askSubmitting: false, expandedLogs: {}, convVisible: 5, downloadingZip: false, spec: null, specFeedback: '', specApproving: false, specRevising: false, specReqOpen: false };
  },
  computed: {
    isAdmin() { return window.UserStore.role === 'admin'; },
    // 新手教程的示範任務（/task/demo）：整頁資料改由 tour-demo.js 供應，一律不打 API。
    // 課程換關卡＝換 demoStatus，watcher 會把動作區重新套用，人才看得到同一個位置換不同的事要做。
    isTourDemo() { return !!(window.TourDemo && window.TourDemo.isTask(this.$route.params.id)); },
    tourDemoStatus() { return window.TourDemo ? window.TourDemo.status : null; },
    canAnswer() { return this.task && ANSWER_ALLOWED.includes(this.task.status); },
    canEditContent() { return this.task && this.task.status === 'new'; },
    // 時間軸底下的單一動作區依 status 切成一種 mode；有主動作的狀態各自 render，其餘走通用留言
    timelineActionMode() {
      const s = this.task?.status;
      if (s === 'confirm_pending' || s === 'clarify_pending')  return 'answer';
      // AI 回話期間仍留在 answer 區（輸入元件會 disable）：整塊換成通用留言框的話，
      // 使用者每問一句就被踢出「提問」頁籤，AI 答完還要自己切回去。後端只在澄清情境回題目。
      if (s === 'clarify_chat_running' && this.clarQuestions.length) return 'answer';
      if (s === 'spec_review')      return 'spec_review';
      if (s === 'review_pending')   return 'review';
      if (s === 'merge_conflict')   return 'conflict';
      if (s === 'cs_reply_pending') return 'cs_reply';
      if (s === 'cs_data_needed')   return 'cs_data';
      if (s === 'stopped')          return 'blocker';
      if (s === 'done')             return 'archive';
      return 'message';
    },
    statusLabel() { return this.task ? (STATUS_LABELS[this.task.status] || this.task.status) : ''; },
    // merge_conflict 的結構化衝突資料（後端 merge_conflict_data，可能為 JSON 字串）
    conflictData() {
      if (!this.task?.merge_conflict_data) return null;
      try {
        return typeof this.task.merge_conflict_data === 'string'
          ? JSON.parse(this.task.merge_conflict_data) : this.task.merge_conflict_data;
      } catch { return null; }
    },
    // 逐檔裁決卡片：[{repo, file, key, detail}]；detail 可能為 null（舊資料／AI 分析失敗＝無建議）
    conflictItems() {
      const cd = this.conflictData;
      if (!cd || !Array.isArray(cd.repos)) return [];
      const items = [];
      for (const r of cd.repos) {
        for (const f of (r.files || [])) {
          items.push({ repo: r.repo, file: f, key: r.repo + '||' + f, detail: (r.details && r.details[f]) || null });
        }
      }
      return items;
    },
    // 重建 testing 引發的衝突沿用舊「已手動解決」流程（不走逐檔裁決）
    isRebuildConflict() { return !!(this.conflictData && this.conflictData.rebuild); },
    // 此次衝突來自「把 main 的新 commit 拉進 ai-dev」而非任務分支併 testing——
    // 兩側的意義完全不同，裁決文案必須跟著換，否則使用者會選反邊
    isSyncConflict() { return !!(this.conflictData && this.conflictData.sync); },
    conflictAllChosen() {
      return this.conflictItems.length > 0 && this.conflictItems.every(i => !!this.conflictChoices[i.key]);
    },
    csQuestions() {
      if (!this.task?.cs_question) return [];
      try { return JSON.parse(this.task.cs_question); } catch { return [this.task.cs_question]; }
    },
    csAllAnswered() {
      return this.csQuestions.length > 0 && this.csQuestions.every(q => (this.csAnswers[q] || '').trim());
    },
    // confirm_pending 的分析澄清問題（來自後端解析 analysis_yaml）；逐題各一回答框
    clarQuestions() { return this.clarification?.questions || []; },
    // intro 是白話說明段，不是題目：不編號、不必答，顯示在題目上方
    clarIntro() { return this.clarification?.intro || ''; },
    // AI 正在回話：兩個頁籤的輸入都鎖住（後端此時也會 400），但版面留著不換走
    clarBusy() { return this.task?.status === 'clarify_chat_running'; },
    clarAllAnswered() {
      return this.clarVisible().every(q => !q.required || this.clarAnswerText(q));
    },
    // 合併「外部溝通紀錄」與「對話紀錄」成一條依時間排序的時間軸（含人工審核事件，因為 approve/reject 都會寫 task_logs）
    timeline() {
      const msgs = (this.taskMessages || []).map(m => ({
        _key: 'msg-' + m.id, ts: m.occurred_at, kind: 'message', source: m.source,
        author: m.author, content: m.content, synced_to_odoo: m.synced_to_odoo, attachments: m.attachments
      }));
      const logs = (this.logs || []).map(l => ({
        _key: 'log-' + l.id, ts: l.created_at, kind: 'log', role: l.role, content: l.content
      }));
      return [...msgs, ...logs].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    },
    // 只渲染末 N 筆（最新）；往上捲再增量載入更早的，避免整條歷史撐開版面
    visibleTimeline() { return this.timeline.slice(-this.convVisible); },
    hasMoreConv() { return this.timeline.length > this.convVisible; },
    // 留言模式（非回覆 AI 問題）且任務有外部來源、管理者開了回寫開關時，才顯示「回寫 Odoo」勾選框
    showWritebackOption() {
      return !this.canAnswer && this.writebackEnabled && !!this.task && (this.task.source === 'odoo' || this.task.source === 'service');
    }
  },
  async created() {
    await this.load();
    Api.get('system/config').then(r => {
      this.odooUrl = r.odoo_url || '';
      this.serviceUrl = r.service_url || '';
      this.testMode = !!r.test_mode;
      this.writebackEnabled = !!r.writeback_odoo_notes;
    }).catch(() => {});
    this.checkInflight();
    this.loadEvents();
    this.loadTaskMessages();
  },
  mounted() {
    // 訂閱狀態更新：pipeline 推 task:updated 時靜默重抓，讓狀態/阻塞原因即時更新（免手動重整）
    const sock = window._socket;
    this._onTaskUpdated = (data) => {
      if (this.task && data && data.taskId === this.task.id) {
        this.refresh().catch(() => {});
        this.checkInflight();
      }
    };
    if (sock) sock.on('task:updated', this._onTaskUpdated);
    // 即時歷程：pipeline 推 terminal:output 時直接 append 到本頁記錄
    this._onTermOutput = (data) => {
      if (this.task && data && data.taskId === this.task.id) {
        const c = this.$refs.eventsBox;
        const atBottom = c ? (c.scrollHeight - c.scrollTop - c.clientHeight < 30) : true;
        this.events.push({ id: null, content: data.data, _live: true });
        if (atBottom) this.$nextTick(() => this.scrollEventsToBottom());
      }
    };
    if (sock) sock.on('terminal:output', this._onTermOutput);
  },
  beforeUnmount() {
    const sock = window._socket;
    if (sock && sock.off) {
      if (this._onTaskUpdated) sock.off('task:updated', this._onTaskUpdated);
      if (this._onTermOutput) sock.off('terminal:output', this._onTermOutput);
    }
  },
  watch: {
    // 對話時間軸：只要目前釘在底部（初始／或使用者停在底部）就隨新內容貼底看最新；
    // 使用者一往上捲，onConvScroll 會解除釘住，之後新訊息不再打斷閱讀
    'timeline.length'(n) {
      if (n && this._convPinBottom !== false) this.$nextTick(() => this.scrollConvToBottom());
    },
    tourDemoStatus() { if (this.isTourDemo) this.refresh(); }
  },
  methods: {
    async openEnv() {
      // JWT 走 Authorization header，瀏覽器導航不會帶上 → 先 fetch SSO 端點拿免密登入 URL 再開。
      // popup-blocker：window.open 必須在 click handler 內同步開，不能等 await 後才開。
      const w = window.open('about:blank', '_blank');
      // 環境可能已被閒置回收，後端會自動起並回 starting；首建可達數分鐘，
      // 空白分頁乾等會被當成當掉，故先在分頁裡寫一句話再輪詢。
      if (w) {
        try {
          w.document.write('<p style="font-family:sans-serif;padding:2rem">測試區建立中，請稍候…</p>');
        } catch (e) { console.debug('about:blank document.write 被瀏覽器擋下，不影響後續導向:', e && e.message); }
      }
      try {
        const url = await pollEnvSso(this.task.project_id);
        if (w) w.location = url; else window.location = url;
      } catch (e) {
        if (w) w.close();
        showToast(e.message || '無法開啟測試區', 'error');
      }
    },
    async load() {
      this._convPinBottom = true; this.convVisible = 5;
      this.loading = true;
      try {
        await this.refresh();
      } catch (e) { this.error = e.message; }
      finally { this.loading = false; }
    },
    // 分頁撈完整對話 log（task_logs），避免 detail 端點只回末 5 筆而截斷對話時間軸。
    // 順序不重要——timeline() 會依 ts 重排；每頁 ≤100，撈到不足一頁為止（cap 防呆）。
    async fetchAllLogs() {
      const all = [];
      const PAGE = 100;
      for (let offset = 0; offset < 2000; offset += PAGE) {
        const rows = await Api.get(`tasks/${this.$route.params.id}/logs?limit=${PAGE}&offset=${offset}`);
        if (!Array.isArray(rows) || rows.length === 0) break;
        all.push(...rows);
        if (rows.length < PAGE) break;
      }
      return all;
    },
    // 靜默重抓任務＋logs（不切 loading，避免即時更新時整頁閃「載入中」）
    // 併發合併：送出類動作送完會自己重抓，而後端在同一個請求裡就推了 task:updated，
    // socket handler 又抓一次 → 兩輪並行、誰後回來誰蓋上去（可能蓋回舊快照）。
    // 飛行中再進來的只記一次尾隨重抓：保證事件之後的資料仍會抓到，但同時只有一輪在跑。
    async refresh() {
      if (this._refreshing) { this._refreshPending = true; return this._refreshing; }
      this._refreshing = (async () => {
        try {
          do {
            this._refreshPending = false;
            await this._refreshOnce();
          } while (this._refreshPending);
        } finally { this._refreshing = null; this._refreshPending = false; }
      })();
      return this._refreshing;
    },
    async _refreshOnce() {
      // detail 與 logs 互不相依（logs 只吃路由上的 id）→ 並行發，省掉一趟序列往返
      const [data, allLogs] = this.isTourDemo
        ? [window.TourDemo.detail(), window.TourDemo.logs()]
        : await Promise.all([
          Api.get(`tasks/${this.$route.params.id}`),
          this.fetchAllLogs().catch(() => null),
        ]);
      this.task = data.task || data;
      // 對話時間軸要完整歷史：用分頁全量 log，撈失敗（null）才退回 detail 的末 5 筆快照
      this.logs = allLogs || data.logs || this.logs || [];
      this.ticketAttachments = data.attachments || [];
      this.clarification = data.clarification || { summary: '', questions: [] };
      this.spec = data.spec || null; // spec_review 審核頁的規格（後端已 parse analysis_yaml）
      // Init answer fields for each cs question
      const qs = (() => { try { return JSON.parse(this.task.cs_question || '[]'); } catch { return []; } })();
      const init = {};
      qs.forEach(q => { if (!(q in this.csAnswers)) init[q] = ''; });
      this.csAnswers = { ...this.csAnswers, ...init };
      // Init answer fields for each clarification question（逐題各一框，以題目 id 為鍵）
      // q.answer 是 clarify-chat 依對話預填的答案：使用者已經講過的事不該再要他打一次，
      // 但只當初值——他隨時可以改掉。已有輸入時不覆蓋（避免打字打到一半被重抓的資料洗掉）。
      // 選擇題的預填值若不是任何一個選項（AI 從對話抓到的是自由敘述），落到補充框而不是被丟掉
      // 題目會被 clarify-chat 依對話就地改寫：題目或預填答案一變就把輸入整組丟掉重建，
      // 否則「不覆蓋既有輸入」會讓畫面停在舊題目的舊答案上，新結論永遠顯示不出來。
      const clarSig = JSON.stringify(this.clarification.questions.map(q => [q.id, q.answer || '']));
      if (clarSig !== this._clarSig) {
        this._clarSig = clarSig;
        this.answerFields = {};
        this.answerExtra = {};
      }
      const clarInit = {}, extraInit = {};
      this.clarification.questions.forEach(q => {
        if (q.id in this.answerFields) return;
        const pre = q.answer || '';
        const isOpt = (q.options || []).some(o => o.key === pre);
        if (q.type === 'choice' && pre && !isOpt) { clarInit[q.id] = ''; extraInit[q.id] = pre; }
        else clarInit[q.id] = pre;
      });
      this.answerFields = { ...this.answerFields, ...clarInit };
      this.answerExtra = { ...this.answerExtra, ...extraInit };
      // 逐檔裁決：預設落在 AI 建議（無建議則留 manual，強迫使用者自己選）
      const REC = ['take_theirs', 'take_ours', 'manual'];
      const cc = {};
      this.conflictItems.forEach(i => {
        if (!(i.key in this.conflictChoices)) {
          cc[i.key] = REC.includes(i.detail?.recommendation) ? i.detail.recommendation : 'manual';
        }
      });
      this.conflictChoices = { ...this.conflictChoices, ...cc };
    },
    // depends_on 條件不滿足 → 該題收起，不顯示也不擋送出。條件指向不存在的題目時照常顯示（fail open）。
    clarVisible() {
      const byId = new Map(this.clarQuestions.map(q => [q.id, q]));
      return this.clarQuestions.filter(q => {
        const dep = q.depends_on;
        if (!dep || !byId.has(dep.question)) return true;
        return String(this.answerFields[dep.question] ?? '') === String(dep.equals);
      });
    },
    // 一題最終送出的答案字串。選擇題除了選項外還有一個補充框（可寫選項以外的答案）：
    // 兩邊都填就併成「A（補充：…）」，只填補充就直接當答案 → 必答判定也吃這個結果。
    clarAnswerText(q) {
      const pick = String(this.answerFields[q.id] ?? '').trim();
      if (q.type !== 'choice') return pick;
      const extra = String(this.answerExtra[q.id] ?? '').trim();
      if (pick && extra) return `${pick}（補充：${extra}）`;
      return pick || extra;
    },
    async submitAnswer() {
      // 結構化題目模式：改送 answers 物件（後端 Task 5 已支援），不再自己拼 Q1:／A1: 文字；
      // 無解析問題時（如 clarify_pending，AI 提問在時間軸）沿用單一留言框（舊 user_answer 契約）。
      if (this.clarBusy) return;
      let payload;
      if (this.clarQuestions.length) {
        if (!this.clarAllAnswered) return;
        // 只送看得見的題目：被 depends_on 收起來的題目不該把殘留輸入帶去給 AI
        const answers = {};
        this.clarVisible().forEach(q => { answers[q.id] = this.clarAnswerText(q); });
        payload = { answers };
      } else {
        const t = this.newMessageText.trim();
        if (!t) return;
        payload = { user_answer: t };
      }
      this.submitting = true;
      try {
        await Api.post(`tasks/${this.task.id}/answer`, payload);
        this.newMessageText = '';
        this.answerFields = {};
        this.answerExtra = {};
        showToast('回覆已送出，AI 正在確認', 'success');
        // 用 refresh 不用 load：load 會切 loading＝整個內容區被換成「載入中...」再重建，
        // 送出後畫面整塊消失一下、已展開的對話還被收回 5 筆，看起來就像當掉。
        // 這裡只要靜默換資料，再把對話釘到最新讓自己剛送出的內容看得到。
        this._convPinBottom = true;
        await this.refresh();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.submitting = false; }
    },
    async submitAsk() {
      const question = this.askText.trim();
      if (!question || this.clarBusy) return;
      this.askSubmitting = true;
      try {
        await Api.post(`tasks/${this.task.id}/clarify-ask`, { question });
        this.askText = '';
        showToast('已送出提問，任務不會往下跑', 'success');
        this._convPinBottom = true;   // 同 submitAnswer：靜默重抓，不整頁閃「載入中」
        await this.refresh();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.askSubmitting = false; }
    },
    async togglePause() {
      if (!this.task) return;
      try {
        const r = await Api.put(`tasks/${this.task.id}/pause`, {});
        this.task.is_paused = r.is_paused;
        showToast(r.is_paused ? '任務已暫停，Pipeline 將跳過' : '任務已恢復', r.is_paused ? 'warn' : 'success');
      } catch (err) { showToast(err.message, 'error'); }
    },
    startEditContent() {
      this.editText = this.task.original_text || '';
      this.editingContent = true;
    },
    cancelEditContent() { this.editingContent = false; },
    async saveContent() {
      if (!this.editText.trim()) return;
      this.savingContent = true;
      try {
        await Api.put(`tasks/${this.task.id}`, { original_text: this.editText });
        this.editingContent = false;
        showToast('內容已更新', 'success');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingContent = false; }
    },
    async loadTaskMessages() {
      if (this.isTourDemo) { this.taskMessages = window.TourDemo.messages(); return; }
      try {
        this.taskMessages = await Api.get(`tasks/${this.$route.params.id}/messages`);
        // 初載完成後貼底看最新（此時 logs 已載入、conv-panel 確定已掛載，補上 watch 首次時序可能落空的貼底）
        if (this._convPinBottom !== false) this.$nextTick(() => this.scrollConvToBottom());
      } catch { /* best-effort */ }
    },
    async sendTaskMessage() {
      if (!this.newMessageText.trim()) return;
      this.sendingMessage = true;
      try {
        const fd = new FormData();
        fd.append('content', this.newMessageText.trim());
        fd.append('writeback', this.messageWriteback ? 'true' : 'false');
        this.newMessageFiles.forEach(f => fd.append('files', f));
        await Api.postForm(`tasks/${this.task.id}/messages`, fd);
        this.newMessageText = '';
        this.newMessageFiles = [];
        if (this.$refs.messageFileInput) this.$refs.messageFileInput.value = '';
        await this.loadTaskMessages();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.sendingMessage = false; }
    },
    onMessageFilesSelected(e) {
      this.newMessageFiles = Array.from(e.target.files || []);
    },
    formatSize(bytes) {
      if (!bytes) return '0 B';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    },
    async downloadAttachment(attId, filename) {
      try {
        const res = await fetch(`${BASE_PATH}api/tasks/${this.task.id}/attachments/${attId}/download`, {
          headers: { Authorization: `Bearer ${Api.getToken()}` }
        });
        if (!res.ok) {
          // 後端對空檔/找不到會回 JSON 錯誤訊息，讀出來讓使用者知道真因
          const msg = await res.json().then(j => j.error).catch(() => '下載失敗');
          throw new Error(msg || '下載失敗');
        }
        const blob = await res.blob();
        if (!blob.size) throw new Error('此附件無內容（0 bytes），無法開啟');
        const url = URL.createObjectURL(blob);
        // 用 <a download> 觸發下載，保住原始檔名與副檔名；window.open(blobUrl) 會存成無副檔名亂數檔而打不開
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || 'attachment';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (e) { showToast(e.message, 'error'); }
    },
    async toggleDiff() {
      if (this.diffOpen) { this.diffOpen = false; return; }
      this.diffError = '';
      if (!this.diffData) {
        this.diffLoading = true;
        try {
          this.diffData = await Api.get(`tasks/${this.task.id}/diff`);
        } catch (e) {
          this.diffError = e.message;
          this.diffLoading = false;
          return;
        }
        this.diffLoading = false;
      }
      this.diffOpen = true;
    },
    diffLines(diff) {
      return diff.split('\n').map(text => {
        let cls = '';
        if (text.startsWith('diff --git') || text.startsWith('index ') || text.startsWith('+++') || text.startsWith('---')) cls = 'diff-meta';
        else if (text.startsWith('@@')) cls = 'diff-hunk';
        else if (text.startsWith('+')) cls = 'diff-add';
        else if (text.startsWith('-')) cls = 'diff-del';
        return { text, cls };
      });
    },
    async approve() {
      if (!await confirmDialog({ title: '審核通過', message: '確定審核通過？這張任務會納入待上正式清單並更新文件；要真正在正式區生效，還要到專案頁按「🚀 上正式」。', confirmText: '確認通過' })) return;
      this.approving = true;
      try {
        await Api.post(`tasks/${this.task.id}/approve`, {});
        showToast('已審核通過，正在併入 ai-dev', 'success');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.approving = false; }
    },
    async downloadCodeZip() {
      this.downloadingZip = true;
      let url = null;
      try {
        const { blob, headers } = await Api.getBlob(`tasks/${this.task.id}/code-zip`);
        // header 於伺服器端編碼過（非 ASCII 檔名會生出無效 header）；解不開就當沒有，不擋下載。
        const readList = (name) => {
          try { return JSON.parse(decodeURIComponent(headers.get(name) || '')) || []; }
          catch { return []; }
        };
        url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.task.task_id}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        const entries = readList('X-Zip-Entries');
        const deleted = readList('X-Zip-Deleted');
        const stale = readList('X-Zip-Stale');
        // 覆蓋風險必須當下就講：stale＝這些檔在任務切點之後也被別人改過，直接覆蓋會蓋掉對方的改動；
        // deleted＝zip 表達不了刪除，不講的話正式區會永遠留著本該移除的檔。兩者都用警示色，不混在成功訊息裡。
        showToast(`已下載 ${entries.length} 個改動檔`, 'success');
        if (stale.length) {
          showToast(`⚠️ 這 ${stale.length} 個檔在本任務之後也被改過，覆蓋會蓋掉對方的改動：${stale.join('、')}`, 'error');
        }
        if (deleted.length) {
          showToast(`⚠️ 本任務刪除了這些檔，請自行到正式區移除：${deleted.join('、')}`, 'error');
        }
      } catch (e) { showToast(e.message, 'error'); }
      finally {
        // 撤銷必須晚於 click：過早撤掉會讓瀏覽器抓不到內容，下載靜默失敗。
        if (url) setTimeout(() => URL.revokeObjectURL(url), 10000);
        this.downloadingZip = false;
      }
    },
    async reject() {
      if (!this.rejectReason.trim()) return;
      this.rejecting = true;
      try {
        await Api.post(`tasks/${this.task.id}/reject`, { reason: this.rejectReason.trim() });
        showToast('已退回，任務回到開發依原因修正', 'success');
        this.rejectReason = '';
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.rejecting = false; }
    },
    // MODE_B 規格審核閘門——確認規格沒問題，開始實作
    async specApprove() {
      if (!await confirmDialog({ title: '規格審核通過', message: '確定規格沒問題，開始實作？', confirmText: '開始實作' })) return;
      this.specApproving = true;
      try {
        await Api.post(`tasks/${this.task.id}/spec-approve`, {});
        showToast('規格審核通過，開始實作', 'success');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.specApproving = false; }
    },
    // MODE_B 規格審核閘門——送出修改意見，交給 AI 依意見更新規格後回到審核頁
    async specRevise() {
      if (!this.specFeedback.trim()) return;
      this.specRevising = true;
      try {
        await Api.post(`tasks/${this.task.id}/spec-revise`, { feedback: this.specFeedback.trim() });
        showToast('已送出修改意見，AI 正在更新規格', 'success');
        this.specFeedback = '';
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.specRevising = false; }
    },
    sourceUrl() {
      if (!this.task) return null;
      const id = (this.task.task_id || '').match(/(\d+)$/)?.[1];
      if (!id) return null;
      if (this.task.source === 'odoo' && this.odooUrl)
        return `${this.odooUrl}/web#id=${id}&action=524&model=project.task&view_type=form`;
      if (this.task.source === 'service' && this.serviceUrl)
        return `${this.serviceUrl}/web?debug=0#action=114&cids=1&id=${id}&menu_id=87&model=service.question.feedback&view_type=form`;
      return null;
    },
    sourceLabel() {
      if (!this.task) return '';
      return this.task.source === 'odoo' ? 'Odoo' : this.task.source === 'service' ? 'eService' : this.task.source === 'manual' ? '手動增加' : this.task.source;
    },
    sourceBadgeClass() {
      if (!this.task) return 'src-badge src-default';
      if (this.task.source === 'odoo') return 'src-badge src-odoo';
      if (this.task.source === 'service') return 'src-badge src-service';
      return 'src-badge src-default';
    },
    roleClass(role) { return role === 'ai' ? 'ai' : role === 'user' ? 'user' : 'system'; },
    roleLabel(role) { return role === 'ai' ? '🤖 AI' : role === 'user' ? '👤 你' : '⚙️ 系統'; },
    // 時間軸項目來自 task_logs 沿用 roleClass；來自 task_messages 用 source 對應到既有 ai/user 泡泡樣式
    // （sync=外部進來的訊息，靠左走 ai 樣式；manual=你自己留言，靠右走 user 樣式，不新增 CSS class）
    timelineClass(item) {
      if (item.kind === 'log') return this.roleClass(item.role);
      return item.source === 'manual' ? 'user' : 'ai';
    },
    timelineMeta(item) {
      if (item.kind === 'log') return this.roleLabel(item.role);
      return item.source === 'manual' ? (item.author || '你') : '（同步）';
    },
    // 只有「使用者自己貼的」（右側 manual）長 LOG 才收合；AI／系統／同步訊息不收（本就該整理過）。
    // 判定＝內容命中 log 特徵 且 夠長（>8 行或 >400 字），啟發式，誤收成本僅多點一下展開。
    isErrorLog(item) {
      if (item.kind !== 'message' || item.source !== 'manual') return false;
      const c = item.content || '';
      if (c.length <= 400 && (c.match(/\n/g) || []).length + 1 <= 8) return false;
      return /Traceback \(most recent call last\)|File ".*", line \d+|^\s*at |\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\b(?:ERROR|WARNING|CRITICAL|Exception)\b|\bError:/m.test(c);
    },
    // 命中 registry 的機器輸入型訊息 → 回傳該收合成的那句人話，否則 null（照常整段顯示）。
    // 前綴與 role 都要對：只比前綴的話，使用者把那則整段複製、貼進提問框問「這是什麼意思」，
    // 他自己的發言（role='user'，同樣進 task_logs、同樣被映成 kind:'log'）會被折成 AI 的那句人話。
    machineLogHint(item) {
      if (item.kind !== 'log') return null;
      return window.machineLogHint(item.role, item.content);
    },
    logLineCount(item) { return (String(item.content || '').match(/\n/g) || []).length + 1; },
    toggleLog(key) { this.expandedLogs[key] = !this.expandedLogs[key]; },
    formatTime(ts) {
      if (!ts) return '';
      return new Date(ts).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
    async archive() {
      this.archiving = true;
      try {
        await Api.post(`tasks/${this.task.id}/archive`, {});
        showToast('任務已封存', 'success');
        this.$router.push('/');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.archiving = false; }
    },
    recLabel(action) {
      // take_ours = merge 的目標分支（stage 2）、take_theirs = 被併入的來源分支（stage 3）。
      // 普通 merge：目標 testing、來源 task 分支。sync：目標 ai-dev（AI 的碼）、來源 main（工程師的碼）。
      const m = this.isSyncConflict
        ? { take_theirs: '取工程師版（main 新進）', take_ours: '取 AI 版（ai-dev 現況）', manual: '我自己手解' }
        : { take_theirs: '取新版（任務分支）', take_ours: '取舊版（testing 現況）', manual: '我自己手解' };
      return m[action] || action;
    },
    async submitConflictResolutions() {
      if (!this.conflictAllChosen) return;
      this.submittingConflicts = true;
      try {
        const resolutions = this.conflictItems.map(i => ({ repo: i.repo, file: i.file, action: this.conflictChoices[i.key] }));
        const r = await Api.post(`tasks/${this.task.id}/resolve-conflicts`, { resolutions });
        if (r && r.done) showToast('衝突已依裁決套用，繼續部署', 'success');
        else showToast('已套用；仍有選「手解」的檔，請在 Repo 解完後按下方「已手動解決」收尾', 'warn', 9000);
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.submittingConflicts = false; }
    },
    // 逐檔追問：問 AI，答覆塞進來源資料讓卡片即時顯示（不整頁 reload）；AI 改建議時同步 ★建議與 radio 預選
    async submitClarify(it) {
      const q = (this.clarifyText[it.key] || '').trim();
      if (!q || this.clarifying[it.key]) return;
      this.clarifying = { ...this.clarifying, [it.key]: true };
      try {
        const r = await Api.post(`tasks/${this.task.id}/merge-clarify`, { repo: it.repo, file: it.file, question: q });
        const cd = this.conflictData;
        const repoEntry = cd && Array.isArray(cd.repos) && cd.repos.find(x => x.repo === it.repo);
        if (repoEntry) {
          repoEntry.details = repoEntry.details || {};
          const d = repoEntry.details[it.file] = repoEntry.details[it.file] || {};
          d.qa = d.qa || [];
          d.qa.push({ q, a: r.answer });
          if (r.changed) { d.recommendation = r.recommendation; d.rationale = r.rationale; }
          this.task.merge_conflict_data = cd; // 觸發 conflictItems 重算
          if (r.changed) this.conflictChoices = { ...this.conflictChoices, [it.key]: r.recommendation };
        }
        this.clarifyText = { ...this.clarifyText, [it.key]: '' };
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.clarifying = { ...this.clarifying, [it.key]: false }; }
    },
    async markConflictResolved() {
      this.conflictResolving = true;
      try {
        const r = await Api.post(`tasks/${this.task.id}/mark-conflict-resolved`, {});
        showToast('衝突已標記為解決，可繼續更新正式', 'success');
        (r && r.warnings || []).forEach(w => showToast(w, 'warn', 9000));
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.conflictResolving = false; }
    },
    async csConfirm() {
      this.csConfirming = true;
      try {
        await Api.post(`tasks/${this.task.id}/cs-confirm`, {});
        showToast('回覆已確認送出，任務完成', 'success');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.csConfirming = false; }
    },
    async csDataSubmit() {
      if (!this.csAllAnswered) return;
      this.csRetrying = true;
      try {
        // 只送「當前這輪」的問題答案——csAnswers 以問題文字為 key 且跨 refresh 累積，
        // 直接整包送會夾帶上一輪已答過的舊題（值被 refresh 清成空）→ 時間軸出現整塊空 A。
        const answers = {};
        this.csQuestions.forEach(q => { answers[q] = this.csAnswers[q] || ''; });
        await Api.post(`tasks/${this.task.id}/cs-data-submit`, { answers });
        this.csAnswers = {};
        showToast('已補充資料，重新送入分析', 'success');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.csRetrying = false; }
    },
    // 客服回覆這關追問：送出後 cs 依「原問題＋前一版草稿＋這次追問」重新處理（修草稿／釐清後轉補資料或開發）
    async csFollowupSubmit() {
      if (this.csFollowingUp) return;
      if (!this.csFollowup.trim()) return;
      this.csFollowingUp = true;
      try {
        await Api.post(`tasks/${this.task.id}/cs-followup`, { note: this.csFollowup.trim() });
        showToast('已送出，客服正在重新處理', 'success');
        this.csFollowup = '';
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.csFollowingUp = false; }
    },
    handleCsEnter(idx) {
      const nextIdx = idx + 1;
      if (nextIdx < this.csQuestions.length) {
        const next = this.$refs['csInput_' + nextIdx];
        const el = Array.isArray(next) ? next[0] : next;
        if (el) el.focus();
      } else if (this.csAllAnswered) {
        this.csDataSubmit();
      }
    },
    // 分析澄清問題逐題填答：Enter 跳下一題，最後一題全答完則送出（Shift+Enter 換行由 .exact 放行）
    handleClarEnter(idx) {
      const nextIdx = idx + 1;
      if (nextIdx < this.clarQuestions.length) {
        const next = this.$refs['clarInput_' + nextIdx];
        const el = Array.isArray(next) ? next[0] : next;
        if (el) el.focus();
      } else if (this.clarAllAnswered) {
        this.submitAnswer();
      }
    },
    async resolveBlocker() {
      if (!this.resolution.trim()) return;
      this.resolving = true;
      try {
        await Api.post(`tasks/${this.task.id}/resolve-blocker`, { resolution: this.resolution });
        this.resolution = '';
        showToast('已送出，從中斷處重試', 'success');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.resolving = false; }
    },
    async checkInflight() {
      if (!this.task || this.isTourDemo) return;
      try {
        const data = await Api.get('pipeline/inflight');
        this.serverConfirmedRunning = (data.inflight || []).includes(this.task.id);
      } catch { this.serverConfirmedRunning = false; }
    },
    back() { this.$router.push('/'); },
    async stepPipeline() {
      this.stepping = true;
      try {
        await Api.post('pipeline/step', {});
        showToast('已觸發推進，處理中…（進度即時更新）', 'info');
        await this.refresh();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.stepping = false; }
    },
    // 把後端標的灰階 ANSI（\x1b[90m…\x1b[0m，工具呼叫/回傳）包成預設收合的 <details>，其餘文字照常顯示；
    // 其他未知 ANSI code 直接丟棄。內容先 escape 再包 HTML，避免 tool input/output 帶 HTML 造成 XSS。
    ansiToHtml(s) {
      const raw = String(s == null ? '' : s);
      const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const wrapDim = chunk => {
        if (!chunk) return '';
        const lines = chunk.split('\n').length;
        return `<details style="display:inline"><summary style="cursor:pointer;user-select:none;color:#888;display:inline">▶ 次要內容（${lines} 行）</summary><span style="opacity:.7">${esc(chunk)}</span></details>`;
      };
      let out = '', dim = false, last = 0, m;
      const re = /\x1b\[(\d+)m/g;
      while ((m = re.exec(raw))) {
        const chunk = raw.slice(last, m.index);
        if (chunk) out += dim ? wrapDim(chunk) : esc(chunk);
        if (m[1] === '90') dim = true;
        else if (m[1] === '0') dim = false;
        last = re.lastIndex;
      }
      const tail = raw.slice(last);
      if (tail) out += dim ? wrapDim(tail) : esc(tail);
      return out;
    },
    scrollEventsToBottom() { const c = this.$refs.eventsBox; if (c) c.scrollTop = c.scrollHeight; },
    scrollConvToBottom() { const c = this.$refs.convPanel; if (c) c.scrollTop = c.scrollHeight; },
    // 捲到頂→載入更早，並補回捲動位移讓畫面不跳（新內容撐高後維持原本閱讀點）
    loadMoreConv() {
      const c = this.$refs.convPanel;
      const prevH = c ? c.scrollHeight : 0;
      this.convVisible += 10;
      this.$nextTick(() => { if (c) c.scrollTop += c.scrollHeight - prevH; });
    },
    onConvScroll(e) {
      const el = e.target;
      // 跟隨使用者位置：停在底部→維持釘住（新訊息貼底）；往上捲→解除釘住
      this._convPinBottom = (el.scrollHeight - el.scrollTop - el.clientHeight < 40);
      if (el.scrollTop <= 8 && this.hasMoreConv) this.loadMoreConv();
    },
    async loadEvents() {
      if (this.isTourDemo) { this.events = window.TourDemo.events(); this.eventsHasMore = false; return; }
      try {
        const rows = await Api.get(`tasks/${this.$route.params.id}/events?limit=10`);
        this.events = Array.isArray(rows) ? rows : [];
        this.eventsHasMore = this.events.length >= 10;
        this.$nextTick(() => this.scrollEventsToBottom());
      } catch { /* best-effort */ }
    },
    async loadOlderEvents() {
      if (this.eventsLoading || !this.eventsHasMore) return;
      const oldest = this.events.find(e => e.id);
      if (!oldest) return;
      this.eventsLoading = true;
      const c = this.$refs.eventsBox;
      const prevHeight = c ? c.scrollHeight : 0;
      try {
        const rows = await Api.get(`tasks/${this.$route.params.id}/events?limit=10&before=${oldest.id}`);
        const older = Array.isArray(rows) ? rows : [];
        this.eventsHasMore = older.length >= 10;
        this.events = [...older, ...this.events];
        this.$nextTick(() => { if (c) c.scrollTop = c.scrollHeight - prevHeight; }); // 維持捲動位置
      } catch { /* best-effort */ }
      finally { this.eventsLoading = false; }
    },
    onEventsScroll(e) { if (e.target.scrollTop <= 4) this.loadOlderEvents(); }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="back" style="margin-right:var(--space-3)">← 返回</button>
      <h1>任務詳情</h1>
      <span v-if="testMode" class="pill pill-warn" style="font-size:var(--fs-sm);padding:2px 8px">🧪 測試模式</span>
      <button v-if="testMode" class="btn btn-primary btn-sm" @click="stepPipeline" :disabled="stepping" style="margin-left:var(--space-2)">
        {{ stepping ? '執行中...' : '▶ 推進 Pipeline' }}
      </button>
      <button v-if="task && task.status !== 'stopped' && task.status !== 'done'" class="btn btn-ghost btn-sm"
        :style="{ color: task.is_paused ? 'var(--warning)' : 'var(--text-muted)', fontSize: 'var(--fs-sm)', padding: '2px 8px', marginLeft: 'var(--space-2)' }"
        @click="togglePause" :title="task.is_paused ? '點擊恢復' : '點擊暫停'">
        {{ task.is_paused ? '▐▐ 已暫停' : '⏸ 暫停' }}
      </button>
      <a v-if="task && task.env_status" href="#" @click.prevent="openEnv" class="env-chip" style="margin-left:var(--space-2)">🖥 測試機</a>
      <button v-if="isAdmin && task && task.git_branch" class="btn btn-outline btn-sm" style="margin-left:auto"
        @click="downloadCodeZip" :disabled="downloadingZip" title="下載本任務改動檔的 zip（內含 <repo>/<原路徑> 結構，可直接覆蓋到正式區 addons）">
        {{ downloadingZip ? '打包中...' : '📦 下載程式碼 zip' }}
      </button>
    </div>
    <div class="content">
      <div v-if="loading" class="loading">載入中...</div>
      <div v-else-if="error" class="error-msg">{{ error }}</div>
      <div v-else-if="task">
        <div class="detail-card">
          <div class="detail-title">{{ task.title || task.task_id }}</div>
          <div class="detail-meta">
            <span class="status-badge" :class="task.status">{{ statusLabel }}</span>
            <span v-if="serverConfirmedRunning" class="pill pill-info"
              style="display:inline-flex;align-items:center;gap:var(--space-1);padding:2px 8px;font-weight:var(--fw-semibold)">
              <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;animation:pulseDot 1.4s ease-in-out infinite"></span>伺服器確認處理中
            </span>
            <a v-if="sourceUrl()" :href="sourceUrl()" target="_blank" :class="sourceBadgeClass()">{{ sourceLabel() }}</a>
            <span v-else :class="sourceBadgeClass()">{{ sourceLabel() }}</span>
            <span v-if="task.stage_label" class="pill" style="padding:2px 8px">🏷 {{ task.stage_label }}</span>
            <span v-if="task.classification_label" class="pill" style="padding:2px 8px">📂 {{ task.classification_label }}</span>
            <span v-if="task.has_attachment" class="pill pill-info" style="padding:2px 8px">📎 含附件</span>
            <span v-if="task.module">模組：{{ task.module }}</span>
            <span v-if="task.created_at" style="color:var(--text-muted);font-size:var(--fs-xs)">建立時間：{{ formatTime(task.created_at) }}</span>
            <span style="color:var(--text-muted);font-size:var(--fs-xs)">最後更新：{{ formatTime(task.updated_at) }}</span>
          </div>

          <div class="form-section td-section-row">
            <span>需求內容</span>
            <button v-if="canEditContent && !editingContent" class="btn btn-outline btn-sm" @click="startEditContent">✎ 編輯</button>
          </div>
          <div v-if="!editingContent" data-tour="td-content" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;font-size:var(--fs-base);white-space:pre-wrap;margin-bottom:var(--space-4)">{{ task.original_text || '（無內容）' }}</div>
          <div v-else style="margin-bottom:var(--space-4)">
            <textarea v-model="editText" style="width:100%;height:140px;padding:var(--space-2);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--fs-base);line-height:1.6;resize:vertical;box-sizing:border-box"></textarea>
            <div class="td-save-actions">
              <button class="btn btn-primary btn-sm" @click="saveContent" :disabled="savingContent || !editText.trim()">
                {{ savingContent ? '儲存中...' : '儲存' }}
              </button>
              <button class="btn btn-outline btn-sm" @click="cancelEditContent" :disabled="savingContent">取消</button>
            </div>
          </div>

          <div v-if="ticketAttachments.length" style="margin-bottom:16px">
            <div class="form-section" style="margin-bottom:6px">主附件</div>
            <div v-for="a in ticketAttachments" :key="a.id" style="font-size:13px;margin-bottom:4px">
              📎 <a href="#" @click.prevent="downloadAttachment(a.id, a.filename)" style="color:var(--primary)">{{ a.filename }}</a>
              <span v-if="a.size" style="color:var(--text-muted);font-size:var(--fs-xs);margin-left:6px">（{{ formatSize(a.size) }}）</span>
            </div>
          </div>

          <div class="form-section" style="margin:var(--space-4) 0 var(--space-2)">對話時間軸</div>
          <div v-if="timeline.length" class="conv-panel" ref="convPanel" @scroll="onConvScroll">
            <div class="conv-log">
              <button v-if="hasMoreConv" type="button" class="conv-loadmore" @click="loadMoreConv">▲ 載入更早的對話（還有 {{ timeline.length - convVisible }} 筆）</button>
              <div v-for="item in visibleTimeline" :key="item._key" class="conv-row" :class="timelineClass(item)">
                <template v-if="isErrorLog(item)">
                  <button type="button" class="conv-log-chip" @click="toggleLog(item._key)">
                    {{ expandedLogs[item._key] ? '▾' : '▸' }} [錯誤LOG · {{ logLineCount(item) }} 行]
                  </button>
                  <pre v-if="expandedLogs[item._key]" class="conv-log-pre">{{ item.content }}</pre>
                </template>
                <template v-else-if="machineLogHint(item)">
                  <button type="button" class="conv-log-chip" @click="toggleLog(item._key)">
                    {{ expandedLogs[item._key] ? '▾' : '▸' }} {{ machineLogHint(item) }}（技術細節 {{ logLineCount(item) }} 行）
                  </button>
                  <pre v-if="expandedLogs[item._key]" class="conv-log-pre">{{ item.content }}</pre>
                </template>
                <div v-else class="conv-msg" :class="timelineClass(item)">{{ item.content }}</div>
                <div v-if="item.attachments && item.attachments.length" class="conv-msg-meta" :style="{ textAlign: timelineClass(item) === 'user' ? 'right' : 'left' }">
                  <span v-for="a in item.attachments" :key="a.id" style="margin-right:8px">
                    📎 <a href="#" @click.prevent="downloadAttachment(a.id, a.filename)" style="color:var(--primary)">{{ a.filename }}</a>
                  </span>
                </div>
                <div class="conv-msg-meta" :style="{ textAlign: timelineClass(item) === 'user' ? 'right' : 'left' }">
                  {{ timelineMeta(item) }} · {{ formatTime(item.ts) }}
                </div>
              </div>
            </div>
          </div>
          <div v-else style="color:var(--text-muted);font-size:var(--fs-base);margin:var(--space-4) 0">尚無對話記錄</div>
          <div class="timeline-action" data-tour="td-action" style="margin-top:var(--space-3);margin-bottom:var(--space-4)">

            <!-- answer：AI 有問題等你回覆 -->
            <template v-if="timelineActionMode === 'answer'">
              <!-- 分析澄清問題：頁籤拆「規格書 QA」與「提問」，依題型渲染 -->
              <template v-if="clarQuestions.length">
                <div class="td-clar-tabs">
                  <button class="btn btn-sm" :class="clarTab === 'qa' ? 'btn-primary' : 'btn-ghost'" @click="clarTab = 'qa'">規格書 QA</button>
                  <button class="btn btn-sm" :class="clarTab === 'ask' ? 'btn-primary' : 'btn-ghost'" @click="clarTab = 'ask'">提問</button>
                </div>
                <div v-if="clarBusy && clarTab === 'ask'" style="font-size:var(--fs-sm);color:var(--text-secondary);margin-bottom:var(--space-3)">💬 AI 正在回覆，稍候一下…</div>

                <template v-if="clarTab === 'qa'">
                  <!-- 送出回答後任務轉 clarify_chat_running：收起整組問題，改顯示處理中卡片，避免空白答案框被誤會成沒送出 -->
                  <div v-if="clarBusy" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:var(--space-4);margin-bottom:var(--space-3);text-align:center">
                    <div style="font-size:var(--fs-base);font-weight:var(--fw-semibold);color:var(--success);margin-bottom:6px">✓ 回覆已送出，AI 正在確認…</div>
                    <div style="font-size:var(--fs-sm);color:var(--text-secondary)">AI 判斷後會回到這裡：可能直接往下跑，或把問題更新後再請你補答。</div>
                  </div>
                  <template v-else>
                  <div v-if="clarIntro" style="background:var(--surface);color:var(--text-secondary);border-radius:6px;padding:var(--space-3);margin-bottom:var(--space-3);white-space:pre-wrap;font-size:var(--fs-sm)">{{ clarIntro }}</div>
                  <div v-for="(q, idx) in clarVisible()" :key="q.id" style="margin-bottom:14px">
                    <div class="td-q-header">
                      <span style="background:var(--primary);color:#fff;border-radius:50%;width:18px;height:18px;font-size:var(--fs-xs);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">{{ idx + 1 }}</span>
                      <span style="white-space:pre-wrap">{{ q.text }}</span>
                      <span v-if="!q.required" style="color:var(--text-muted);font-size:var(--fs-xs);flex-shrink:0">選填</span>
                    </div>
                    <div v-if="q.type === 'choice'" class="opt-list" style="margin-bottom:6px">
                      <label v-for="opt in q.options" :key="opt.key" class="opt-card" :class="{ selected: answerFields[q.id] === opt.key }">
                        <input type="radio" :name="'clar_' + q.id" :value="opt.key" v-model="answerFields[q.id]">
                        <span class="opt-card-dot"></span>
                        <span>{{ opt.label }}</span>
                      </label>
                      <textarea v-model="answerExtra[q.id]" class="form-control" rows="2"
                        placeholder="以上選項都不合適？也可以直接寫你的答案或補充說明"></textarea>
                    </div>
                    <textarea v-else v-model="answerFields[q.id]"
                      class="form-control" rows="3"
                      :class="{ 'form-control-error': q.required && !String(answerFields[q.id] || '').trim() }"
                      placeholder="請輸入你的回答..."></textarea>
                  </div>
                  <div v-if="!clarAllAnswered" style="font-size:var(--fs-sm);color:var(--danger);margin-bottom:10px">⚠ 還有必答的問題沒回答</div>
                  <div style="text-align:right">
                    <button class="btn btn-primary btn-sm" @click="submitAnswer" :disabled="clarBusy || submitting || !clarAllAnswered">
                      {{ submitting ? '送出中...' : '送出回答' }}
                    </button>
                  </div>
                  </template>
                </template>

                <template v-else>
                  <div style="font-size:var(--fs-sm);color:var(--text-secondary);margin-bottom:var(--space-2)">
                    看不懂、要補充、或方向要改都在這裡講。問問題不會讓任務往下跑；談出結論時 AI 會順手把「規格書 QA」那頁的題目改成最新的。
                  </div>
                  <textarea v-model="askText" class="form-control" rows="3" :disabled="clarBusy"
                    placeholder="例如：我測試好像正常，要怎麼重現這個情況？（Enter 送出，Shift+Enter 換行）"
                    @keydown.enter.exact.prevent="submitAsk"></textarea>
                  <div style="margin-top:6px;text-align:right">
                    <button class="btn btn-primary btn-sm" @click="submitAsk" :disabled="clarBusy || askSubmitting || !askText.trim()">
                      {{ askSubmitting ? '送出中...' : '送出提問' }}
                    </button>
                  </div>
                </template>
              </template>
              <!-- 無解析問題（如退回對話，AI 提問已在時間軸）：單一回覆框 -->
              <template v-else>
                <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--text-secondary);margin-bottom:var(--space-2)">AI 有問題等待你回覆</div>
                <textarea v-model="newMessageText" class="form-control" placeholder="輸入你的回覆...（Enter 送出，Shift+Enter 換行）" rows="4"
                  @keydown.enter.exact.prevent="submitAnswer"></textarea>
                <div style="margin-top:6px;text-align:right">
                  <button class="btn btn-primary btn-sm" @click="submitAnswer" :disabled="submitting || !newMessageText.trim()">
                    {{ submitting ? '送出中...' : '送出回覆並繼續' }}
                  </button>
                </div>
              </template>
            </template>

            <!-- spec_review：MODE_B 規格審核閘門（看過規格 → 確認開工／寫意見改規格） -->
            <template v-else-if="timelineActionMode === 'spec_review'">
              <div class="form-section">規格審核</div>
              <p style="font-size:var(--fs-base);color:var(--text-muted);margin-bottom:var(--space-3)">
                以下是 AI 分析出的規格，請確認沒問題後開始實作。下方可提問或要求調整規格：提問時 AI 會直接在時間軸回答、規格不變；判定要改時才重產規格再回到這裡。
              </p>
              <div v-if="spec" style="border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);margin-bottom:var(--space-3);background:var(--surface)">
                <div v-if="spec.summary" style="margin-bottom:var(--space-3)">
                  <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--text-secondary);margin-bottom:var(--space-1)">摘要</div>
                  <div style="font-size:var(--fs-base);white-space:pre-wrap">{{ spec.summary }}</div>
                </div>
                <div v-if="spec.module" style="margin-bottom:var(--space-3)">
                  <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--text-secondary);margin-bottom:var(--space-1)">模組</div>
                  <code>{{ spec.module }}</code>
                </div>
                <div v-if="spec.requirements && spec.requirements.length" style="margin-bottom:var(--space-3)">
                  <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--text-secondary);margin-bottom:var(--space-1);cursor:pointer;user-select:none"
                    @click="specReqOpen = !specReqOpen">
                    {{ specReqOpen ? '▾' : '▸' }} 實作項（給 AI 的施工細節，共 {{ spec.requirements.length }} 項）
                  </div>
                  <ul v-if="specReqOpen" style="margin:0;padding-left:var(--space-4);font-size:var(--fs-base)">
                    <li v-for="(r, i) in spec.requirements" :key="'req'+i" style="white-space:pre-wrap;margin-bottom:2px">{{ r }}</li>
                  </ul>
                </div>
                <div v-if="spec.acceptance && spec.acceptance.length" style="margin-bottom:var(--space-3)">
                  <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--text-secondary);margin-bottom:var(--space-1)">驗收項</div>
                  <ul style="margin:0;padding-left:var(--space-4);font-size:var(--fs-base)">
                    <li v-for="(a, i) in spec.acceptance" :key="'acc'+i" style="white-space:pre-wrap;margin-bottom:2px">{{ a }}</li>
                  </ul>
                </div>
                <div v-if="spec.permissions && spec.permissions.trim()">
                  <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--text-secondary);margin-bottom:var(--space-1)">權限</div>
                  <div style="font-size:var(--fs-base);white-space:pre-wrap">{{ spec.permissions }}</div>
                </div>
              </div>
              <textarea v-model="specFeedback" class="form-control" rows="3"
                placeholder="可提問或要求調整規格（例：為什麼備註欄唯讀？／備註欄位改成多行、加一個匯出按鈕）。Enter 送出，Shift+Enter 換行"
                @keydown.enter.exact.prevent="specRevise"></textarea>
              <div class="td-form-actions">
                <button class="btn btn-secondary btn-sm" @click="specRevise" :disabled="specRevising || specApproving || !specFeedback.trim()">
                  {{ specRevising ? '送出中...' : '送出' }}
                </button>
                <button class="btn btn-success btn-sm" @click="specApprove" :disabled="specApproving || specRevising">
                  {{ specApproving ? '處理中...' : '✓ 確認沒問題，開始實作' }}
                </button>
              </div>
            </template>

            <!-- review：最終人工審核（退回原因 → 退回／審核通過同列，通過在右且綠色） -->
            <template v-else-if="timelineActionMode === 'review'">
              <div class="form-section">最終人工審核</div>
              <p style="font-size:var(--fs-base);color:var(--text-muted);margin-bottom:var(--space-3)">
                已通過 QA、測試區部署與 E2E 測試。確認後這張任務即完成驗收，會納入待上正式清單並更新文件；要真正在正式區生效，再到專案頁按「🚀 上正式」。
              </p>
              <div style="margin-bottom:var(--space-3)">
                <button class="btn btn-secondary btn-sm" @click="toggleDiff" :disabled="diffLoading">
                  {{ diffLoading ? '載入中...' : (diffOpen ? '收合程式變更' : '查看程式變更 diff') }}
                </button>
              </div>
              <div v-if="diffError" class="error-msg" style="margin-bottom:var(--space-3)">{{ diffError }}</div>
              <div v-if="diffOpen && diffData">
                <div v-for="r in diffData.repos" :key="r.label" style="margin-bottom:var(--space-3)">
                  <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--text-secondary);margin-bottom:var(--space-1)">{{ r.label }}</div>
                  <div v-if="r.missing" style="color:var(--text-muted);font-size:var(--fs-sm)">分支已清理，無法取得 diff</div>
                  <div v-else-if="!r.diff" style="color:var(--text-muted);font-size:var(--fs-sm)">此 repo 無變更</div>
                  <div v-else class="diff-view"><div v-for="(ln, i) in diffLines(r.diff)" :key="i" :class="['diff-line', ln.cls]">{{ ln.text }}</div></div>
                  <div v-if="r.truncated" style="color:var(--text-muted);font-size:var(--fs-sm);margin-top:var(--space-1)">（diff 過大已截斷，完整內容請至 repo 檢視）</div>
                </div>
              </div>
              <textarea v-model="rejectReason" class="form-control" rows="4"
                placeholder="填寫退回原因（可一次列多個問題，系統會自動分類歸檔供工作流程健檢）。Enter 送出，Shift+Enter 換行"
                @keydown.enter.exact.prevent="reject"></textarea>
              <div class="td-form-actions">
                <button class="btn btn-primary btn-sm" @click="reject" :disabled="rejecting || !rejectReason.trim()">
                  {{ rejecting ? '退回中...' : '確認退回，回開發依原因修正' }}
                </button>
                <button class="btn btn-success btn-sm" @click="approve" :disabled="approving || rejecting">
                  {{ approving ? '處理中...' : '✓ 審核通過，納入待上正式' }}
                </button>
              </div>
            </template>

            <!-- conflict：合併衝突，秀出實際錯誤 -->
            <template v-else-if="timelineActionMode === 'conflict'">
              <div class="form-section">合併衝突 — 請逐檔裁決</div>

              <!-- 逐檔裁決卡片（新流程）：有結構化衝突資料且非重建來源時 -->
              <template v-if="conflictItems.length && !isRebuildConflict">
                <p style="font-size:var(--fs-base);color:var(--text-muted);margin-bottom:14px">
                  自動合併有 {{ conflictItems.length }} 個檔需要你決定。每個檔已附原因與 AI 建議（預設已選建議），確認後送出即可。
                </p>
                <div v-if="isSyncConflict" style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:10px">
                  這張任務開工前要把 main 上工程師改的程式拉進來，但和 AI 已改過的地方撞到了。
                  裁決完會回到分析重跑，不會直接進部署。
                </div>
                <div v-for="(it, idx) in conflictItems" :key="it.key"
                  style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;margin-bottom:14px;background:var(--surface)">
                  <div class="td-q-header">
                    <span style="background:var(--primary);color:#fff;border-radius:50%;width:18px;height:18px;font-size:var(--fs-xs);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px">{{ idx + 1 }}</span>
                    <span><code>{{ it.repo }} / {{ it.file }}</code></span>
                  </div>
                  <div v-if="it.detail" style="font-size:var(--fs-sm);color:var(--text-muted);margin:0 0 8px 24px">
                    <div><b>衝突型態：</b>{{ it.detail.classification }}</div>
                    <div v-if="it.detail.reason"><b>原因：</b>{{ it.detail.reason }}</div>
                    <div v-if="it.detail.rationale"><b>AI 建議：</b>{{ recLabel(it.detail.recommendation) }} — {{ it.detail.rationale }}</div>
                  </div>
                  <div v-else style="font-size:var(--fs-sm);color:var(--text-muted);margin:0 0 8px 24px">（無法自動分析此檔，請自行判斷或選「我自己手解」）</div>
                  <div class="td-conflict-choices">
                    <label v-for="act in ['take_theirs','take_ours','manual']" :key="act"
                      class="td-conflict-choice">
                      <input type="radio" :name="'conflict_' + idx" :value="act" v-model="conflictChoices[it.key]">
                      <span>{{ recLabel(act) }}<span v-if="it.detail && it.detail.recommendation === act" style="color:var(--primary)"> ★建議</span></span>
                    </label>
                  </div>

                  <!-- 追問區：非工程師看不懂時先問 AI，問清楚再裁決（有結構化 detail 才顯示） -->
                  <div v-if="it.detail" style="margin:12px 0 0 24px;padding-top:10px;border-top:1px dashed var(--border)">
                    <div v-if="it.detail.qa && it.detail.qa.length" style="margin-bottom:8px">
                      <div v-for="(qa, qi) in it.detail.qa" :key="qi" style="margin-bottom:8px">
                        <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--text)">你：{{ qa.q }}</div>
                        <div style="font-size:var(--fs-sm);color:var(--text-muted);white-space:pre-wrap;margin-top:2px">AI：{{ qa.a }}</div>
                      </div>
                    </div>
                    <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-bottom:4px">不確定怎麼選？可以先問 AI，問清楚再決定。</div>
                    <textarea v-model="clarifyText[it.key]" rows="2"
                      placeholder="看不懂這個衝突？問問看，例如：這兩個版本差在哪？我選「取新版」會失去什麼？"
                      style="width:100%;font-size:var(--fs-sm);padding:6px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);resize:vertical;box-sizing:border-box"></textarea>
                    <div style="text-align:right;margin-top:6px">
                      <button class="btn btn-secondary" @click="submitClarify(it)"
                        :disabled="clarifying[it.key] || !(clarifyText[it.key] || '').trim()" style="font-size:var(--fs-sm)">
                        {{ clarifying[it.key] ? '思考中...' : '送出追問' }}
                      </button>
                    </div>
                  </div>
                </div>
                <div style="text-align:right">
                  <button class="btn btn-primary" @click="submitConflictResolutions" :disabled="submittingConflicts || !conflictAllChosen">
                    {{ submittingConflicts ? '處理中...' : '✓ 送出裁決，繼續' }}
                  </button>
                </div>
              </template>

              <!-- 舊流程 fallback：無結構化資料（舊任務）或重建來源衝突 → 手動解決後收尾 -->
              <template v-else>
                <div v-if="task.blocker_content" class="error-msg" style="white-space:pre-wrap;margin-bottom:var(--space-3)">{{ task.blocker_content }}</div>
                <p style="font-size:var(--fs-base);color:var(--text-muted);margin-bottom:var(--space-3)">
                  自動合併失敗，請手動在 Repo 解決 Git 衝突後，點擊下方按鈕繼續。
                </p>
                <div style="text-align:right">
                  <button class="btn btn-primary" @click="markConflictResolved" :disabled="conflictResolving">
                    {{ conflictResolving ? '處理中...' : '✓ 已手動解決衝突，繼續' }}
                  </button>
                </div>
              </template>

              <!-- 逐檔裁決後仍剩「手解」檔時，用這顆收尾 -->
              <div v-if="conflictItems.length && !isRebuildConflict" style="text-align:right;margin-top:10px">
                <button class="btn btn-secondary" @click="markConflictResolved" :disabled="conflictResolving"
                  style="font-size:var(--fs-sm)">
                  {{ conflictResolving ? '處理中...' : '已在 Repo 手動解完剩餘檔，收尾繼續' }}
                </button>
              </div>
            </template>

            <!-- cs_reply：客服回覆草稿（確認結案，或追問讓客服依脈絡重新處理） -->
            <template v-else-if="timelineActionMode === 'cs_reply'">
              <div class="form-section">客服回覆草稿</div>
              <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;font-size:var(--fs-base);white-space:pre-wrap;margin-bottom:var(--space-3)">{{ task.cs_reply }}</div>
              <p style="font-size:var(--fs-base);color:var(--text-muted);margin-bottom:var(--space-3)">AI 已生成操作問題的回覆草稿，確認內容後送出結案；若要調整或有疑問，於下方追問，客服會依此重新處理（釐清後若需改程式會自動轉開發）。</p>
              <textarea v-model="csFollowup" class="form-control" rows="3"
                placeholder="可追問或要求調整回覆（例：客戶用的是 17.0／回覆再客氣些）。Enter 送出，Shift+Enter 換行"
                @keydown.enter.exact.prevent="csFollowupSubmit"></textarea>
              <div class="td-form-actions">
                <button class="btn btn-secondary btn-sm" @click="csFollowupSubmit" :disabled="csFollowingUp || csConfirming || !csFollowup.trim()">
                  {{ csFollowingUp ? '送出中...' : '送出' }}
                </button>
                <button class="btn btn-success btn-sm" @click="csConfirm" :disabled="csConfirming || csFollowingUp">
                  {{ csConfirming ? '處理中...' : '✓ 確認送出，結案' }}
                </button>
              </div>
            </template>

            <!-- cs_data：需補充資料，逐題填答 -->
            <template v-else-if="timelineActionMode === 'cs_data'">
              <div class="form-section">需補充資料</div>
              <p style="font-size:var(--fs-base);color:var(--text-muted);margin-bottom:14px">請填寫以下所有問題後送出，AI 將重新分析。</p>
              <div v-for="(q, idx) in csQuestions" :key="idx" style="margin-bottom:14px">
                <div class="td-q-header">
                  <span style="background:var(--primary);color:#fff;border-radius:50%;width:18px;height:18px;font-size:var(--fs-xs);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">{{ idx + 1 }}</span>
                  <span>{{ q }}</span>
                </div>
                <textarea v-model="csAnswers[q]"
                  :ref="'csInput_' + idx"
                  :placeholder="'請填寫第 ' + (idx + 1) + ' 題...（Enter 跳下題' + (idx === csQuestions.length - 1 ? '／送出' : '') + '，Shift+Enter 換行）'"
                  class="form-control" :class="{ 'form-control-error': !(csAnswers[q] && csAnswers[q].trim()) }"
                  rows="4"
                  @keydown.enter.exact.prevent="handleCsEnter(idx)">
                </textarea>
              </div>
              <div v-if="!csAllAnswered" style="font-size:var(--fs-sm);color:var(--danger);margin-bottom:10px">⚠ 請填寫所有問題才能送出</div>
              <div style="text-align:right">
                <button class="btn btn-primary" @click="csDataSubmit" :disabled="csRetrying || !csAllAnswered">
                  {{ csRetrying ? '處理中...' : '↺ 送出補充資料，重新分析' }}
                </button>
              </div>
            </template>

            <!-- blocker：處理失敗／中斷，醒目秀出錯誤內容 -->
            <template v-else-if="timelineActionMode === 'blocker'">
              <div class="form-section">處理失敗 — 需人工介入</div>
              <div class="error-msg" style="white-space:pre-wrap;margin-bottom:var(--space-3)">{{ task.blocker_content || '任務分診失敗或執行中斷' }}</div>
              <div style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--text-secondary);margin-bottom:var(--space-2)">說明你的修正方向，任務將回到失敗的那一關重試</div>
              <textarea v-model="resolution" class="form-control" rows="4"
                placeholder="例：改用報表方式呈現，不需要新增欄位；或：忽略該錯誤，直接繼續...（Enter 送出，Shift+Enter 換行）"
                @keydown.enter.exact.prevent="resolveBlocker">
              </textarea>
              <div style="text-align:right;margin-top:var(--space-2)">
                <button class="btn btn-primary btn-sm" @click="resolveBlocker" :disabled="resolving || !resolution.trim()">
                  {{ resolving ? '處理中...' : '↺ 送出並從中斷處繼續' }}
                </button>
              </div>
            </template>

            <!-- archive：任務已完成 -->
            <template v-else-if="timelineActionMode === 'archive'">
              <div class="form-section">任務已完成</div>
              <p style="font-size:var(--fs-base);color:var(--text-muted);margin-bottom:var(--space-3)">此任務已完成並更新文件。可手動封存，或滿一個月後自動封存。</p>
              <div style="text-align:right">
                <button class="btn btn-outline" @click="archive" :disabled="archiving">
                  {{ archiving ? '封存中...' : '🗄 封存任務' }}
                </button>
              </div>
            </template>

            <!-- message：無主動作的狀態，通用留言（回寫預設不勾） -->
            <template v-else>
              <!-- 執行中卻被別張任務的同步衝突擋住：狀態沒變（仍是分析中），原因要看得見，否則會靜默卡好幾天。
                   只認 sync_wait，避免把「分診中」等狀態殘留的上次停下原因也當成當前錯誤秀出來 -->
              <div v-if="task.blocker_type === 'sync_wait' && task.blocker_content" class="error-msg" style="white-space:pre-wrap;margin-bottom:var(--space-3)">{{ task.blocker_content }}</div>
              <textarea v-model="newMessageText" class="form-control" placeholder="新增留言...（Enter 送出，Shift+Enter 換行）" rows="4"
                @keydown.enter.exact.prevent="sendTaskMessage"></textarea>
              <input ref="messageFileInput" type="file" multiple @change="onMessageFilesSelected" style="display:block;margin-top:6px;font-size:var(--fs-xs)" />
              <div v-if="newMessageFiles.length" style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:4px">已選擇：{{ newMessageFiles.map(f => f.name).join('、') }}</div>
              <div class="td-msg-send-row">
                <label v-if="showWritebackOption" class="td-writeback-label">
                  <input type="checkbox" v-model="messageWriteback"> 同時回寫 Odoo 備註
                </label>
                <button class="btn btn-primary btn-sm" @click="sendTaskMessage"
                  :disabled="sendingMessage || !newMessageText.trim()">
                  {{ sendingMessage ? '送出中...' : '送出留言' }}
                </button>
              </div>
            </template>
          </div>

          <div class="form-section td-section-row">
            <span>即時歷程記錄</span>
            <span v-if="eventsLoading" style="font-size:var(--fs-xs);color:var(--text-muted)">載入中…</span>
          </div>
          <div ref="eventsBox" data-tour="td-events" @scroll="onEventsScroll"
            style="height:320px;overflow-y:auto;background:#1a1a1a;color:#e0e0e0;font-family:Consolas,monospace;font-size:var(--fs-sm);line-height:1.5;padding:10px;border-radius:var(--radius-sm);white-space:pre-wrap;word-break:break-word">
            <div v-if="!events.length" style="color:#888">尚無執行紀錄</div>
            <template v-else>
              <div v-if="!eventsHasMore" style="color:#666;text-align:center;font-size:var(--fs-xs);margin-bottom:6px">— 已到最前 —</div>
              <span v-for="(ev, i) in events" :key="ev.id || ('live'+i)" v-html="ansiToHtml(ev.content)"></span>
            </template>
          </div>
        </div>
      </div>
    </div>
  `
});
