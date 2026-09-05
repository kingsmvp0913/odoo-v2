(function () {
  // 執行歷程每批筆數。⚠ 不能太小：跳窗是固定高度，首批要撐得出捲軸，否則「捲到頂載更早」
  // 永遠觸發不了（實測首批 10 筆時 1796 筆的任務只看得到 10 筆）。
  const EVENTS_PAGE = 30;
  // 任務詳情的資料、輪詢、附件與每種 Pipeline 動作均沿用既有實作；新版只重組資訊層級。
  window.UiNextTaskDetailView = Vue.defineComponent({
    name: "UiNextTaskDetailView",
    components: { UiNextIcon: window.UiNextIcon },
    data() {
      return { task: null, logs: [], loading: true, resolution: '', csAnswers: {}, odooUrl: '', serviceUrl: '', submitting: false, approving: false, archiving: false, rejecting: false, rejectReason: '', rejectFiles: [], conflictResolving: false, conflictChoices: {}, submittingConflicts: false, clarifying: {}, clarifyText: {}, csConfirming: false, csRetrying: false, csFollowup: '', csFollowingUp: false, resolving: false, error: '', serverConfirmedRunning: false, testMode: false, stepping: false, events: [], eventsOpen: false, eventsHasMore: true, eventsLoading: false, eventsError: '', expandedEvents: {}, editingContent: false, editText: '', savingContent: false, taskMessages: [], sendingMessage: false, newMessageText: '', writebackEnabled: false, messageWriteback: false, writebackOpen: false, ticketAttachments: [], newMessageFiles: [], diffOpen: false, diffLoading: false, diffError: '', diffData: null, clarification: { summary: '', questions: [] }, answerFields: {}, answerExtra: {}, answerFiles: [], clarTab: 'qa', clarIdx: 0, askText: '', askSubmitting: false, askFiles: [], expandedLogs: {}, attachUrls: {}, taskActionCollapsed: false, downloadingZip: false, spec: null, specs: [], specFeedback: '', specApproving: false, specRevising: false };
    },
    computed: {
      isAgentRunning() { return !!this.task && !this.task.is_paused && (window.RUNNABLE_STATUSES || []).includes(this.task.status); },
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
      actionModeLabel() {
        return { answer:'等待回答', spec:'規格審核', review:'人工審核', conflict:'合併衝突', csReply:'客服回覆', csData:'補充資料', blocker:'需要介入', archive:'任務完成', message:'新增留言' }[
          ({ spec_review:'spec', cs_reply:'csReply', cs_data:'csData' }[this.timelineActionMode] || this.timelineActionMode)
        ];
      },
      statusLabel() { return this.task ? (STATUS_LABELS[this.task.status] || this.task.status) : ''; },
      // 這個輸入框是自由文字，但它餵的分診 agent 要產出的是 {decision, target} 結構化決策，
      // 而畫面上從來沒有一處提示過這件事。散文「推進到 QA」會被判成 fix，coding 進去無事可做就 stop，
      // 使用者再填一次又繞回來（實測連續五輪白跑）。這幾顆把契約詞彙填成可照抄的句子——填入而非
      // 直接送出，使用者仍能接著補自己的上下文。
      blockerShortcuts() {
        return [
          { label: '碼我自己改好了，重新審查', text: '程式碼我已經自行修正完成，請回傳 decision="advance"、target="qa"。' },
          { label: '環境已排除，重跑部署', text: '環境問題已排除，程式碼未變動，請回傳 decision="advance"、target="deploy"。' },
          { label: '這是誤判，直接送人工審核', text: '這是誤判，不需再修改，請回傳 decision="advance"、target="review"。' }
        ];
      },
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
        const blocker = (this.task && this.task.status === 'stopped' && this.task.blocker_content)
          ? [{ _key: 'blocker', ts: this.task.updated_at, kind: 'log', role: 'blocker', content: this.task.blocker_content }]
          : [];
        // 需求本文就是對話的第一則（原本獨立在「需求內容」頁籤）：它是客戶提的那段話，
        // 放進時間軸才讀得出「他要什麼 → 我們怎麼回」的順序。主附件跟著這一則走。
        const req = (this.task && this.task.original_text)
          ? [{ _key: 'req', ts: this.task.created_at, kind: 'message', source: 'sync',
               content: this.task.original_text, attachments: this.ticketAttachments, isRequirement: true }]
          : [];
        // 人工審核那關：程式變更本身是「要讀的東西」，排在對話最後一則，動作面板只留退回／通過。
        // 走 kind:'log'+role:'ai' 是為了直接吃既有的 ai 樣式與頭像；content 留空，
        // isErrorLog／machineLogHint 都判不到它，不會被誤折成收合列。
        const diff = (this.timelineActionMode === 'review')
          ? [{ _key: 'diff', ts: this.task.updated_at, kind: 'log', role: 'ai', content: '', isDiff: true }]
          : [];
        return [...req, ...msgs, ...logs, ...blocker, ...diff].sort((a, b) => new Date(a.ts) - new Date(b.ts));
      },
      // ⚠ 整條歷史一次渲染完，不要分批：資料本來就全在前端（fetchAllLogs 已分頁撈完），
      // 分批只省渲染成本，卻換來一個死結——訊息不夠高就沒有捲軸，沒有捲軸就觸發不了
      // 「往上捲載入更早」，剩下的那幾則永遠出不來。實測 task_logs 最多的一張是 56 則。
      visibleTimeline() { return this.timeline; },
      // 比照專案對話：跨天處插一條日期分隔。時間軸項目直接攤平進 row，模板才不必多一層 row.item。
      visibleRows() {
        const rows = [];
        let lastDay = '';
        for (const item of this.visibleTimeline) {
          const day = item.ts ? new Date(item.ts).toDateString() : '';
          if (day && day !== lastDay) { rows.push({ divider: true, _key: 'day-' + day, label: window.UiNextShared.dayLabel(item.ts) }); lastDay = day; }
          rows.push({ ...item, divider: false });
        }
        return rows;
      },
      // 留言模式（非回覆 AI 問題）且任務有外部來源、管理者開了回寫開關時，才顯示「回寫 Odoo」勾選框
      showWritebackOption() {
        return !this.canAnswer && this.writebackEnabled && !!this.task && (this.task.source === 'odoo' || this.task.source === 'service');
      }
    },
    async created() {
      await this.load();
      this.$nextTick(() => this.bindConvScroll());
      Api.get('system/config').then(r => {
        this.odooUrl = r.odoo_url || '';
        this.serviceUrl = r.service_url || '';
        this.testMode = !!r.test_mode;
        this.writebackEnabled = !!r.writeback_odoo_notes;
      }).catch(() => {});
      this.checkInflight();
      this.loadTaskMessages();
      this.markInboxRead();
    },
    mounted() {
      // ⚠ window._socket 在 mounted 當下通常還是 undefined：initSocket 掛在 app.js 那支
      // Api.get('auth/me').then() 裡，比元件掛載晚。原本直接 `const sock = window._socket`
      // ＋ `if (sock)` 的寫法會整組靜默跳過——實測 terminal:output 的 listener 數是 0，
      // 即時歷程從來沒生效過。改成輪詢等它出現再訂閱。
      this._onTaskUpdated = (data) => {
        if (this.task && data && data.taskId === this.task.id) {
          this.refresh().catch(() => {});
          this.checkInflight();
        }
      };
      // 即時歷程：pipeline 推 terminal:output 時直接 append 到本頁記錄
      this._onTermOutput = (data) => {
        if (this.task && data && data.taskId === this.task.id) {
          const c = this.$refs.eventsBox;
          const atBottom = c ? (c.scrollHeight - c.scrollTop - c.clientHeight < 30) : true;
          this.events.push({ id: null, content: data.data, _live: true });
          if (atBottom) this.$nextTick(() => this.scrollEventsToBottom());
        }
      };
      const bind = () => {
        const sock = window._socket;
        if (!sock) return false;
        sock.on('task:updated', this._onTaskUpdated);
        sock.on('terminal:output', this._onTermOutput);
        return true;
      };
      if (!bind()) {
        this._sockTimer = setInterval(() => { if (bind()) { clearInterval(this._sockTimer); this._sockTimer = null; } }, 300);
      }
      // 點到別處就收起回寫下拉：它是 chip 自己 toggle 的，沒有這行的話點畫面其他地方選單會留著
      this._onDocClick = (event) => {
        if (this.writebackOpen && !event.target.closest('.ui-next-source-picker')) this.writebackOpen = false;
      };
      document.addEventListener('click', this._onDocClick);
    },
    beforeUnmount() { this.unbindConvScroll();
      if (this._sockTimer) clearInterval(this._sockTimer);
      Object.values(this.attachUrls).forEach(url => URL.revokeObjectURL(url));
      if (this._onDocClick) document.removeEventListener('click', this._onDocClick);
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
        this.loadAttachmentThumbs();   // 新訊息帶圖時也要顯示
      },
      tourDemoStatus() { if (this.isTourDemo) this.refresh(); },
    },
    methods: {
      // 執行歷程改成跳窗：開的時候才抓，關掉不保留（它是除錯用的終端輸出，不是常駐內容）
      openEvents() { this.eventsOpen = true; this.loadEvents(); },
      // 收合時整條標題列都能展開；已展開時不做事，否則點標題旁的來源連結會誤收
      expandActionIfCollapsed() { if (this.taskActionCollapsed) this.taskActionCollapsed = false; },
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
      // 打開任務頁＝這件事已經看到了，不該還掛在收件匣等你回去點。後端的自動消解只涵蓋
      // kind='action' 且任務已離開等人狀態的那部分，退回事件（bounce）完全不在其中——不從這裡
      // 清，沒經收件匣進來的人就永遠清不掉。清完要順手校正 badge，否則數字要等下次換頁才更新。
      // 靜默失敗：收件匣不是本頁的關鍵路徑（教程的假任務 id 也會走到這裡並被後端擋成 404）。
      async markInboxRead() {
        try {
          await Api.post(`inbox/task/${this.$route.params.id}/read`);
          if (window.loadInboxUnread) window.loadInboxUnread();
        } catch (e) { /* 靜默：badge 不是關鍵路徑 */ }
      },
      async load() {
        this._convPinBottom = true; this.taskActionCollapsed = false;
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
        // 維護中橫幅：搭既有 refresh 週期一起查，不額外開 setInterval 輪詢
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
        // 每一版規格（task_specs）。時間軸上的規格書靠它掛版本，與上面那份「現在要你審的」分開：
        // 共用一份的話，規格被退回改寫過的任務，舊的那一則會跟著顯示最新規格＝改動完全無痕。
        this.specs = Array.isArray(data.specs) ? data.specs : [];
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
          this.clarIdx = 0; // 題目整組換過了，停在舊的第 3 題會看到一題不存在的題目
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
      // AI 對這題建議的答案。choice 題的 recommended 存的是 option 的 key，畫面要換成 label——
      // 顯示「建議：A」等於沒講。找不到對應 option（text 題，或 key 打錯）就原樣顯示。
      // 選用欄位：純屬「使用者要什麼」的題目 AI 刻意不填（它沒有依據），回空字串＝那一行不渲染。
      clarRecommend(q) {
        const rec = String(q.recommended ?? '').trim();
        if (!rec) return '';
        const opt = (q.options || []).find(o => o.key === rec);
        const label = (opt && opt.label) ? opt.label : rec;
        const why = String(q.recommended_why ?? '').trim();
        return why ? `${label}（${why}）` : label;
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
          // 有夾帶檔案才改走 multipart：後端兩種都吃，但 JSON 路徑是既有行為，沒必要為沒附件的回覆換掉
          if (this.answerFiles.length) {
            const fd = new FormData();
            if (payload.answers) fd.append('answers', JSON.stringify(payload.answers));
            else fd.append('user_answer', payload.user_answer);
            this.answerFiles.forEach(f => fd.append('files', f));
            await Api.postForm(`tasks/${this.task.id}/answer`, fd);
          } else {
            await Api.post(`tasks/${this.task.id}/answer`, payload);
          }
          this.newMessageText = '';
          this.answerFiles = [];
          if (this.$refs.answerFileInput) this.$refs.answerFileInput.value = '';
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
          // 同 submitAnswer：有夾帶檔案才改走 multipart，沒附件時沿用既有 JSON 路徑
          if (this.askFiles.length) {
            const fd = new FormData();
            fd.append('question', question);
            this.askFiles.forEach(f => fd.append('files', f));
            await Api.postForm(`tasks/${this.task.id}/clarify-ask`, fd);
          } else {
            await Api.post(`tasks/${this.task.id}/clarify-ask`, { question });
          }
          this.askText = '';
          this.askFiles = [];
          if (this.$refs.askFileInput) this.$refs.askFileInput.value = '';
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
          showToast(r.is_paused ? '已取消本輪執行' : '已繼續執行', r.is_paused ? 'warn' : 'success');
          // 後端在暫停／繼續時各寫一則 system 訊息，重讀對話才看得到；
          // 這一頁的方法叫 loadTaskMessages（loadMessages 是聊天頁那支，在這裡是 undefined）。
          await this.loadTaskMessages();
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
      autoResize(event) {
        const el = event.currentTarget;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
      },
      // 截圖直接貼上：畫面類問題用截圖說明比打字快，而下游只讀得到程式碼 diff。
      // target 指定塞進哪個附件清單——這一頁的回答／提問／退回／留言各有各的。
      onPasteFiles(event, target) {
        const files = Array.from((event.clipboardData || {}).files || []).filter((f) => /^image\//.test(f.type));
        if (!files.length) return;
        event.preventDefault();
        const list = this[target];
        if (!Array.isArray(list)) return;
        files.forEach((f) => { if (f.size <= 10 * 1024 * 1024 && list.length < 5) list.push(f); });
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
          // autoResize 寫的是 inline height：清空文字它不會自己縮，欄位會一直停在
          // 上一則留言撐開的高度。清掉 inline 值讓它退回 CSS 的 min-height。
          if (this.$refs.messageInput) this.$refs.messageInput.style.height = '';
          await this.loadTaskMessages();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.sendingMessage = false; }
      },
      onMessageFilesSelected(e) {
        this.newMessageFiles = Array.from(e.target.files || []);
      },
      onAnswerFilesSelected(e) {
        this.answerFiles = Array.from(e.target.files || []);
      },
      onAskFilesSelected(e) {
        this.askFiles = Array.from(e.target.files || []);
      },
      formatSize(bytes) {
        if (!bytes) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(1) + ' MB';
      },
      isImageAttachment(file) {
        return /^image\//.test(file.mimetype || '') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.filename || '');
      },
      imageAttachments(row) { return (row.attachments || []).filter(f => this.isImageAttachment(f)); },
      fileAttachments(row) { return (row.attachments || []).filter(f => !this.isImageAttachment(f)); },
      // 附件端點要帶 Authorization header，<img src> 直連拿不到 → 逐張 fetch 成 objectURL。
      // 少了這一步 attachUrls 恆空、模板那個 v-show 恆為 false ⇒ 一張圖都不會顯示。
      async loadAttachmentThumbs() {
        if (!this.task) return;
        for (const file of this.timeline.flatMap(row => this.imageAttachments(row))) {
          if (this.attachUrls[file.id]) continue;
          try {
            const res = await fetch(`${BASE_PATH}api/tasks/${this.task.id}/attachments/${file.id}/download`, {
              headers: { Authorization: `Bearer ${Api.getToken()}` }
            });
            if (!res.ok) continue;
            const blob = await res.blob();
            if (blob.size) this.attachUrls[file.id] = URL.createObjectURL(blob);
          } catch { /* 單張載不出來就不畫這張 */ }
        }
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
      // 底排那顆 code 鈕：diff 渲染在對話流最後一則，展開後要自己捲過去，否則按了看起來像沒反應
      // （新增的內容在畫面外、又被 sticky 的動作面板擋住）。
      async showDiff() {
        await this.toggleDiff();
        if (!this.diffOpen) return;
        this.$nextTick(() => {
          const panel = document.querySelector('.ui-next-main');
          if (panel) panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' });
        });
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
      // 下載本體（含 stale／deleted 兩則覆蓋風險警示）在 UiNextShared：側欄的任務右鍵選單
      // 也有同一個動作，各寫一份遲早只剩一邊有警示。這裡只負責按鈕的「打包中」狀態。
      async downloadCodeZip() {
        this.downloadingZip = true;
        try { await window.UiNextShared.downloadTaskCodeZip(this.task); }
        finally { this.downloadingZip = false; }
      },
      async reject() {
        if (!this.rejectReason.trim()) return;
        this.rejecting = true;
        try {
          // 走 FormData 夾帶截圖：視覺類退回（本站佔 22%）用文字描述不清楚，而截圖是下游三關
          // （分診／respec／coding）唯一能看到「審核者實際看到什麼」的管道——它們讀的是 diff，看不到畫面。
          const fd = new FormData();
          fd.append('reason', this.rejectReason.trim());
          this.rejectFiles.forEach(f => fd.append('files', f));
          await Api.postForm(`tasks/${this.task.id}/reject`, fd);
          showToast('已退回，任務回到開發依原因修正', 'success');
          this.rejectReason = '';
          this.rejectFiles = [];
          if (this.$refs.rejectFileInput) this.$refs.rejectFileInput.value = '';
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.rejecting = false; }
      },
      onRejectFilesSelected(e) {
        this.rejectFiles = Array.from(e.target.files || []);
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
      // stage＝runner 寫的「→ 換關」單行紀錄。沿用 system 的灰字，但另掛 is-stage 拿掉虛線框：
      // 一張任務會有十來行，每行都包一個框會把真正的對話擠成配角。
      roleClass(role) {
        if (role === 'blocker') return 'system is-blocker';
        if (role === 'stage') return 'system is-stage';
        return role === 'ai' ? 'ai' : role === 'user' ? 'user' : 'system';
      },
      roleLabel(role) {
        if (role === 'blocker') return '執行中斷';
        if (role === 'stage') return '流程';
        return role === 'ai' ? 'AI' : role === 'user' ? '你' : '系統';
      },
      // 時間軸項目來自 task_logs 沿用 roleClass；來自 task_messages 用 source 對應到既有 ai/user 泡泡樣式
      // （sync=外部進來的訊息，靠左走 ai 樣式；manual=你自己留言，靠右走 user 樣式，不新增 CSS class）
      timelineClass(item) {
        if (item.kind === 'log') return this.roleClass(item.role);
        return item.source === 'manual' ? 'user' : 'ai';
      },
      timelineMeta(item) {
        if (item.isRequirement) return '需求';
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
      // 規格審核的那則 AI log（analysis.js 寫入時固定這個前綴）。比對 role 的理由同 machineLogHint：
      // 使用者把那段整則複製、貼進提問框問「這是什麼意思」，只比前綴就會把他的發言也當成規格書。
      isSpecLog(item) {
        return item.kind === 'log' && item.role === 'ai' && String(item.content || '').startsWith('[等待你審核規格]');
      },
      // 這一則掛哪一版規格。第 2 版起，runner 把版號寫進標頭列的全形括號（[等待你審核規格]（第 3 版））；
      // 沒有括號的就是第 1 版。對不到版本時退回 spec（動作面板那份）——task_specs 是後來才加的表，
      // 既有任務一筆版本都沒有，不退回的話它們的規格書會整個從畫面上消失。
      specForLog(item) {
        if (!this.isSpecLog(item)) return null;
        const m = String(item.content || '').match(/^\[等待你審核規格\]（第\s*(\d+)\s*版）/);
        const version = m ? Number(m[1]) : 1;
        return (this.specs || []).find(s => s.version === version) || this.spec || null;
      },
      // 最新那一版才直接攤開。用「時間軸上最後一則規格 log」而不是「specs 的最大版號」：
      // 版號寫在 log 內容裡，兩邊本來就對得起來，而以 log 為準才不會在 specs 為空（舊任務）時
      // 把唯一那一則也判成舊版收起來。
      isLatestSpecLog(item) {
        const specLogs = this.timeline.filter(r => this.isSpecLog(r));
        return !specLogs.length || specLogs[specLogs.length - 1]._key === item._key;
      },
      logLineCount(item) { return (String(item.content || '').match(/\n/g) || []).length + 1; },
      toggleLog(key) { this.expandedLogs[key] = !this.expandedLogs[key]; },
      formatTime(ts) {
        if (!ts) return '';
        return new Date(ts).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      },
      renderTaskMessage(value) { return window.renderNextMarkdown(value); },
      handleTaskMessageClick(event) { return window.copyNextCode(event); },
      async archive() {
        this.archiving = true;
        try {
          const r = await Api.post(`tasks/${this.task.id}/archive`, {});
          // 封存會順帶把這張任務的碼從 testing 收回去（best-effort）。收不回來一定要講：
          // 靜默失敗的話，下一張任務併 testing 時才撞衝突，那時已經看不出是這次封存留下的
          (r && r.warnings || []).forEach(w => showToast(w, 'warn', 9000));
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
          // 題目切成頁籤後，只 focus 是不夠的：下一題還藏在別的頁籤裡，
          // 畫面不會動，看起來像 Enter 沒反應。先換頁籤，等它顯示出來再 focus。
          this.clarIdx = nextIdx;
          this.$nextTick(() => {
            const next = this.$refs['clarInput_' + nextIdx];
            const el = Array.isArray(next) ? next[0] : next;
            if (el) el.focus();
          });
        } else if (this.clarAllAnswered) {
          this.submitAnswer();
        }
      },
      // 接在既有內容後面而不是覆蓋：使用者常是先打完自己的說明，才想到要指定回哪一關
      // 直接送出：這三句已經帶好分診 agent 要的判斷詞彙，填進框裡再讓人按一次沒有意義。
      // 若輸入框已有內容就併進去一起送（使用者可能想補充上下文）。
      async submitResolutionShortcut(text) {
        if (this.resolving) return;
        const cur = this.resolution.trim();
        this.resolution = cur ? `${cur}\n${text}` : text;
        await this.resolveBlocker();
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
      back() {
        // 原本一律回首頁——從任務列表點進來的人按「返回」會跑到問答頁，等於找不到路。
        // 帶回來時的頁籤；深連結（通知、分享網址）沒有 from，就退回預設清單。
        const from = this.$route.query.from;
        const tabs = ["needs_action", "pending", "paused", "all", "archived"];
        this.$router.push(tabs.includes(from) ? `/tasks?tab=${from}` : "/tasks");
      },
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
          // ▶ 保留：它是 <details> 的 disclosure 標記（summary 設 display:inline 會拿掉瀏覽器原生三角），
          // 不是操作按鈕；而且這裡是 JS 產生的 HTML 字串，塞不進 <ui-next-icon>，硬改成 inline SVG
          // 只是在一段有 XSS escape 契約的字串裡多埋一段標籤，換不到任何東西。
          // color 不可寫死 #888：深色模式下與 --code-bg 對比不足，改吃主題變數。
          return `<details style="display:inline"><summary style="cursor:pointer;user-select:none;color:var(--text-muted);display:inline">▶ 次要內容（${lines} 行）</summary><span style="opacity:.7">${esc(chunk)}</span></details>`;
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
      eventSummary(event) { const text = String(event.content || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '執行輸出'; return text.length > 160 ? `${text.slice(0, 160)}…` : text; },
      eventKind(event) { const text = String(event.content || ''); return /(?:❌|error|failed|失敗|錯誤)/i.test(text) ? 'error' : /(?:▶|start|開始|執行)/i.test(text) ? 'stage' : 'output'; },
      toggleEvent(event) { const key = event.id || event.content; this.expandedEvents[key] = !this.expandedEvents[key]; },
      scrollConvToBottom() { const c = this._convScroller || document.querySelector(".ui-next-main"); if (c) c.scrollTop = c.scrollHeight; },
      // 捲到頂→載入更早，並補回捲動位移讓畫面不跳（新內容撐高後維持原本閱讀點）
      // 捲軸統一在最外面之後，實際在捲的是 .ui-next-main；綁在對話清單上不會觸發。
      bindConvScroll() {
        this._convScroller = document.querySelector('.ui-next-main');
        if (!this._convScroller || this._onConvScrollBound) return;
        this._onConvScrollBound = () => this.onConvScroll({ target: this._convScroller });
        this._convScroller.addEventListener('scroll', this._onConvScrollBound, { passive: true });
      },
      unbindConvScroll() {
        if (this._convScroller && this._onConvScrollBound) {
          this._convScroller.removeEventListener('scroll', this._onConvScrollBound);
          this._onConvScrollBound = null;
        }
      },
      onConvScroll(e) {
        const el = e.target;
        // 跟隨使用者位置：停在底部→維持釘住（新訊息貼底）；往上捲→解除釘住
        this._convPinBottom = (el.scrollHeight - el.scrollTop - el.clientHeight < 40);
      },
      async loadEvents() {
        if (this.isTourDemo) { this.events = window.TourDemo.events(); this.eventsHasMore = false; return; }
        this.eventsError = '';
        try {
          // ⚠ 首批一定要多到撐出捲軸（跳窗是固定 80dvh）：原本首批 10 筆時內容比視窗矮，
          // 沒有捲軸就觸發不了下面那個「捲到頂載更早」，1796 筆的任務永遠停在 10 筆。
          const rows = await Api.get(`tasks/${this.$route.params.id}/events?limit=${EVENTS_PAGE}`);
          this.events = Array.isArray(rows) ? rows : [];
          this.eventsHasMore = this.events.length >= EVENTS_PAGE;
          this.$nextTick(() => this.scrollEventsToBottom());
        } catch (error) { this.eventsError = error.message || '無法載入執行歷程'; }
      },
      async loadOlderEvents() {
        if (this.eventsLoading || !this.eventsHasMore) return;
        const oldest = this.events.find(e => e.id);
        if (!oldest) return;
        this.eventsLoading = true;
        const box = this.$refs.eventsBox;
        const prevHeight = box ? box.scrollHeight : 0;
        try {
          const rows = await Api.get(`tasks/${this.$route.params.id}/events?limit=${EVENTS_PAGE}&before=${oldest.id}`);
          const older = Array.isArray(rows) ? rows : [];
          this.eventsHasMore = older.length >= EVENTS_PAGE;
          this.events = [...older, ...this.events];
          // 維持視線位置：接在最前面會把原本看的那幾筆往下推，不補回捲動位置就會整個跳掉
          this.$nextTick(() => { if (box) box.scrollTop = box.scrollHeight - prevHeight; });
        } catch (error) { this.eventsError = error.message || '無法載入更早的執行歷程'; }
        finally { this.eventsLoading = false; }
      },
      onEventsScroll(e) { if (e.target.scrollTop <= 4) this.loadOlderEvents(); },
    },
    template: `
      <section class="ui-next-page ui-next-task-detail">
<div v-if="loading" class="ui-next-loading-card">載入任務中…</div>
<div v-else-if="error" class="ui-next-loading-card ui-next-error-text">{{ error }}</div>
<template v-else-if="task">
<!-- 頂欄固定在頁面上方：名稱、來源／狀態／階段，動作按鈕。原本這裡是「大標題 ＋ 一整排
     六個標籤 ＋ 三個頁籤」三層，佔掉整個第一屏；標籤砍到只剩看了會做決定的那三個。 -->
<header class="ui-next-page-head ui-next-detail-head ui-next-task-topbar">
<div class="ui-next-task-topbar-main">
<button class="ui-next-back" @click="back" aria-label="返回"><ui-next-icon name="arrow-left"/></button>
<h1>{{ task.title || task.task_id }}</h1>
<span v-if="serverConfirmedRunning" class="is-live">處理中</span>
</div>
<div class="ui-next-detail-actions">
<!-- 全改成圖示鈕：最多同時 5 顆，一排文字按鈕會把標題擠掉。文案移進 title／aria-label，
     每顆都保有「執行中」的 disabled 狀態（原本靠文字換成「打包中…」表達，圖示鈕改用 disabled）。 -->
<button v-if="testMode" class="ui-next-icon-button" @click="stepPipeline" :disabled="stepping" :title="stepping?'執行中…':'推進 Pipeline'" :aria-label="stepping?'執行中':'推進 Pipeline'"><ui-next-icon name="flow"/></button>
<button v-if="task.status!=='stopped'&&task.status!=='done'" class="ui-next-icon-button" @click="togglePause" :title="task.is_paused?'恢復任務':'暫停任務'" :aria-label="task.is_paused?'恢復任務':'暫停任務'"><ui-next-icon :name="task.is_paused?'play':'pause'"/></button>
<button v-if="task.env_status" class="ui-next-icon-button" @click="openEnv" title="測試機" aria-label="開啟測試機"><ui-next-icon name="grid"/></button>
<button class="ui-next-icon-button" @click="openEvents" title="執行歷程" aria-label="執行歷程"><ui-next-icon name="terminal"/></button>
<button v-if="isAdmin&&task.git_branch" class="ui-next-icon-button" @click="downloadCodeZip" :disabled="downloadingZip" :title="downloadingZip?'打包中…':'下載程式碼'" :aria-label="downloadingZip?'打包中':'下載程式碼'"><ui-next-icon name="download"/></button>
<button v-if="isAdmin&&task.status==='done'&&!task.is_hidden" class="ui-next-icon-button" @click="archive" :disabled="archiving" :title="archiving?'封存中…':'封存'" :aria-label="archiving?'封存中':'封存'"><ui-next-icon name="archive"/></button>
</div>
</header>
<div class="ui-next-task-detail-grid is-tab-conversation">
<div class="ui-next-task-content-column">
<section tabindex="-1" class="ui-next-panel ui-next-conversation">
<div ref="convPanel" class="ui-next-conv-list" @click="handleTaskMessageClick">
<template v-for="row in visibleRows" :key="row._key"><div v-if="row.divider" class="ui-next-day-divider"><span>{{ row.label }}</span></div>
<article v-else :class="timelineClass(row)">
<!-- 錯誤 LOG 與機器 log 分開標示：兩者合併成一句「技術紀錄」時，畫面上看不出這則是不是錯誤，
     而使用者貼的錯誤訊息正是最需要一眼認出來的那種。 -->
<template v-if="row.isDiff">
<button :disabled="diffLoading" @click="toggleDiff">{{ diffLoading?'載入中…':(diffOpen?'收合':'展開') }} 這一輪的程式變更</button>
<p v-if="diffError" class="ui-next-error-text">{{ diffError }}</p>
<!-- 逐行著色而非把所有 repo 併成一行：join(' | ') 的版本讀不出哪幾行是加、哪幾行是刪，
     而這一關要人決定的就是「這些改動能不能上」。 -->
<div v-if="diffOpen&&diffData">
<div v-for="repo in diffData.repos" :key="repo.label" class="ui-next-diff-repo">
<b>{{ repo.label }}</b>
<span v-if="repo.missing">分支已清理，無法取得 diff</span>
<span v-else-if="!repo.diff">此 repo 無變更</span>
<div v-else class="diff-view"><div v-for="(line,index) in diffLines(repo.diff)" :key="index" :class="['diff-line',line.cls]">{{ line.text }}</div></div>
<span v-if="repo.truncated">（diff 過大已截斷，完整內容請至 repo 檢視）</span>
</div>
</div>
</template>
<template v-else-if="isErrorLog(row)">
<button @click="toggleLog(row._key)">{{ expandedLogs[row._key]?'收合':'展開' }} 錯誤 LOG（{{ logLineCount(row) }} 行）</button>
<pre v-if="expandedLogs[row._key]">{{ row.content }}</pre>
</template>
<template v-else-if="machineLogHint(row)">
<button @click="toggleLog(row._key)">{{ expandedLogs[row._key]?'收合':'展開' }} {{ machineLogHint(row) }}（技術細節 {{ logLineCount(row) }} 行）</button>
<pre v-if="expandedLogs[row._key]">{{ row.content }}</pre>
</template>
<!-- 需求那則就地編輯（任務還在 new 時可改）：原本的入口在「需求內容」頁籤的編輯鈕，
     那個頁籤沒了，入口要跟著需求本文搬進對話裡，否則功能還在但永遠按不到。 -->
<template v-else-if="row.isRequirement&&editingContent">
<textarea v-model="editText" @input="autoResize">
</textarea>
<div class="ui-next-inline-actions">
<button class="ui-next-primary" @click="saveContent" :disabled="savingContent||!editText.trim()">{{ savingContent?'儲存中…':'儲存' }}</button>
<button @click="cancelEditContent">取消</button>
</div>
</template>
<template v-else>
<div v-html="renderTaskMessage(row.content)"></div>
<!-- 規格審核那則 log 只寫得下摘要。模組／實作項／驗收／權限接在同一則底下，
     這一關過了之後（動作面板消失）也還看得到規格是什麼。
     規格被退回改寫過的任務會有多則：每一則掛自己那一版（specForLog），且只有最新那一版
     直接攤開——舊版收成一顆按鈕。全部攤開的話同一頁會出現三份長得很像的規格，
     使用者反而分不出正在審的是哪一份。 -->
<div v-if="specForLog(row)" class="ui-next-spec-box ui-next-spec-inline">
<b v-if="!isLatestSpecLog(row)" class="ui-next-spec-toggle" @click="toggleLog('spec'+row._key)">{{ expandedLogs['spec'+row._key]?'▾':'▸' }} 第 {{ specForLog(row).version||1 }} 版規格（已被後來的版本取代）</b>
<template v-if="isLatestSpecLog(row)||expandedLogs['spec'+row._key]">
<template v-if="specForLog(row).module"><b>模組</b><p><code>{{ specForLog(row).module }}</code></p></template>
<template v-if="specForLog(row).requirements&&specForLog(row).requirements.length">
<b class="ui-next-spec-toggle" @click="toggleLog('req'+row._key)">{{ expandedLogs['req'+row._key]?'▾':'▸' }} 實作項（給 AI 的施工細節，共 {{ specForLog(row).requirements.length }} 項）</b>
<ul v-if="expandedLogs['req'+row._key]"><li v-for="(item,index) in specForLog(row).requirements" :key="'req'+index">{{ item }}</li></ul>
</template>
<template v-if="specForLog(row).acceptance&&specForLog(row).acceptance.length">
<b>驗收項</b>
<ul><li v-for="(item,index) in specForLog(row).acceptance" :key="'acc'+index">{{ item }}</li></ul>
</template>
<!-- 權限是審核者唯一能看到「誰能用、能做什麼」的地方：不渲染就等於這一關沒得審，
     而下游 QA 的判準正是拿實作去比對這一段。 -->
<template v-if="specForLog(row).permissions&&specForLog(row).permissions.trim()"><b>權限</b><p>{{ specForLog(row).permissions }}</p></template>
</template>
</div>
<!-- 圖片直接顯示縮圖（同聊天頁）：一排「淺底大字檔名」的下載鈕在深色下最刺眼，
     而且看不到內容還得先下載。非圖片才走檔案列，縮成一行小字。 -->
<div v-if="imageAttachments(row).length" class="ui-next-conv-images">
<img v-for="file in imageAttachments(row)" :key="file.id" v-show="attachUrls[file.id]" :src="attachUrls[file.id]" :alt="file.filename" :title="file.filename" @click="downloadAttachment(file.id,file.filename)">
</div>
<div v-if="fileAttachments(row).length" class="ui-next-conv-files">
<button v-for="file in fileAttachments(row)" :key="file.id" @click="downloadAttachment(file.id,file.filename)"><ui-next-icon name="download"/>{{ file.filename }}<small v-if="file.size">{{ formatSize(file.size) }}</small></button>
</div>
<button v-if="row.isRequirement&&canEditContent" class="ui-next-req-edit" @click="startEditContent">編輯需求</button>
</template>
<small>{{ timelineMeta(row) }} · {{ formatTime(row.ts) }}</small>
<!-- 頭像放在最後：CSS 用 grid 把它定位回左上角。放最前面會讓內容 div 不再是 :first-child，
     而 markdown 的整套排版規則（09-later-patches）都掛在 div:first-child 那條選擇器上。 -->
<span v-if="timelineClass(row)==='ai'" class="ui-next-msg-avatar" aria-hidden="true"><img src="favicon.svg" alt=""></span>
</article></template>
<!-- 處理中動畫比照聊天頁：任務正在跑時，對話最底出現三顆脈動的點。
     serverConfirmedRunning＝server 確認這張在飛；isAgentRunning＝狀態可跑但可能還在排隊，
     兩者聯集才能涵蓋整段處理窗（剛送出、排隊、真的在跑）。 -->
<div v-if="serverConfirmedRunning||isAgentRunning" class="ui-next-ai-thinking"><i></i><i></i><i></i> AI 正在處理</div>
<p v-if="!timeline.length&&!(serverConfirmedRunning||isAgentRunning)" class="ui-next-empty-state">尚無對話記錄。</p>
</div>
</section>

</div>
<aside class="ui-next-task-side">
<!-- 規格問答的頁籤掛在框外上方：一層就好（題目 1..n 在前、「提問」在最後），
     原本是「規格書 QA／提問」外面再包一層題目數字，兩層疊在框裡分不出哪層是哪層。 -->
<div v-if="timelineActionMode==='answer'&&clarQuestions.length&&!taskActionCollapsed" class="ui-next-q-tabs" role="tablist">
<button v-for="(q,index) in clarVisible()" :key="'qtab'+q.id" type="button" role="tab" :class="{active:clarTab==='qa'&&clarIdx===index,done:!!clarAnswerText(q)}" :aria-selected="(clarTab==='qa'&&clarIdx===index).toString()" :title="q.text" @click="clarTab='qa';clarIdx=index">{{ index+1 }}<ui-next-icon v-if="clarAnswerText(q)" name="check"/></button>
<button type="button" role="tab" class="ui-next-q-tab-ask" :class="{active:clarTab==='ask'}" :aria-selected="(clarTab==='ask').toString()" @click="clarTab='ask'">提問</button>
</div>
<section class="ui-next-panel ui-next-task-action" :class="{'is-collapsed':taskActionCollapsed}">
<!-- 收合時整條標題列都是展開的入口：只有右邊那顆 24px 的箭頭可點，等於把面板收起來之後
     要瞄準一個很小的目標才打得開。展開狀態不掛 handler，否則點標題旁的來源連結會誤收。 -->
<div class="ui-next-task-action-head" :class="{'is-clickable':taskActionCollapsed}" @click="expandActionIfCollapsed">
<h2>{{ actionModeLabel }}</h2>
<!-- 來源／狀態接在小標題後面：它們說明的是「這張任務現在停在哪、從哪來」，
     與這一區要你做的事是同一件事的兩面。頂欄只留名稱與階段。 -->
<a v-if="sourceUrl()" :href="sourceUrl()" target="_blank" :class="sourceBadgeClass()" @click.stop>{{ sourceLabel() }}</a>
<span v-else :class="sourceBadgeClass()">{{ sourceLabel() }}</span>
<!-- clarify_chat_running（「AI 回覆中」）時不重印狀態徽章：對話框已有「AI 正在處理」動畫、
     QA 頁籤內也有「回覆已送出，AI 正在確認」灰框，頂欄再掛一個字只是第三次講同一件事。 -->
<span v-if="!clarBusy" :class="['ui-next-status-badge',task.status]">{{ statusLabel }}</span>
<span class="ui-next-head-spacer"></span>
<button type="button" class="ui-next-task-action-collapse" :aria-label="taskActionCollapsed?'展開任務對話框':'縮小任務對話框'" :title="taskActionCollapsed?'展開':'縮小'" :aria-expanded="(!taskActionCollapsed).toString()" @click.stop="taskActionCollapsed=!taskActionCollapsed"><ui-next-icon :name="taskActionCollapsed?'chevron-up':'chevron-down'"/></button>
</div>
<template v-if="!taskActionCollapsed">
<!-- 已完成：面板留著但只當資訊列，沒有輸入框也沒有送出——整塊消失的話畫面下半部會空掉，
     而且看不出這張任務已經結案了。 -->
<template v-if="timelineActionMode==='archive'">
<p class="ui-next-field-note">這張任務已完成，不再接受新的留言。</p>
</template>
<template v-else-if="timelineActionMode==='answer'">
<!-- intro 不在這裡重印：analysis 已把它整段寫進對話流那則「[需要你回答]」。
     頁籤（含「提問」——看不懂題目時問清楚再答的唯一入口）移到框外上方。 -->
<template v-if="clarQuestions.length">
<!-- 只在「提問」頁籤提示：QA 頁籤送出後已換成下方「回覆已送出，AI 正在確認」灰框，
     這行再出現就是同一則訊息疊兩次（legacy 版本本來就限定 clarTab==='ask'）。 -->
<p v-if="clarBusy&&clarTab==='ask'" class="ui-next-field-note">AI 正在回覆，稍候一下…</p>
<template v-if="clarTab==='qa'">
<!-- 送出後任務轉 clarify_chat_running：整組題目收起來換成這張卡。只把按鈕 disable 的話，
     空白的答案框留在原地，看起來像根本沒送出去。 -->
<div v-if="clarBusy" class="ui-next-help-box">
<b>回覆已送出，AI 正在確認…</b>
<p>AI 判斷後會回到這裡：可能直接往下跑，或把問題更新後再請你補答。</p>
</div>
<template v-else>
<!-- v-show 而非 v-if：切頁籤時保住 textarea 被 autoResize 撐開的高度與捲動位置。 -->
<div v-for="(q,index) in clarVisible()" v-show="index===clarIdx" :key="q.id" class="ui-next-question ui-next-question-solo">
<b>{{ index+1 }}. {{ q.text }}<template v-if="!q.required"> · 選填</template></b>
<!-- 選錯的代價用標記呈現，不寫進題目文字。只標 costly，reversible 不渲染——沒有標記＝不必特別小心。 -->
<span v-if="q.impact==='costly'" class="ui-next-warning-text" title="這題選錯要退回重寫規格與程式，請多看一眼">選錯難改</span>
<!-- AI 的建議答案：只有它推導得出依據的題目才有，純偏好題刻意留空＝這一行不渲染 -->
<span v-if="clarRecommend(q)">建議：{{ clarRecommend(q) }}</span>
<template v-if="q.type==='choice'">
<div class="ui-next-qa-options">
<label v-for="opt in q.options" :key="opt.key" :class="{selected:answerFields[q.id]===opt.key}">
<input type="radio" :name="'answer_'+q.id" :value="opt.key" v-model="answerFields[q.id]"><i aria-hidden="true"></i><span>{{ opt.label }}<em v-if="q.recommended===opt.key">建議</em></span></label>
</div>
<!-- 說明放 placeholder，不另立標題行：它與上面兩張選項卡是同一層級，多一行標題就比選項高一截 -->
<label class="ui-next-qa-custom-answer">
<textarea v-model="answerExtra[q.id]" placeholder="以上選項都不適合？直接寫下你的答案或補充說明" @input="autoResize"></textarea>
</label>
</template>
<textarea v-else v-model="answerFields[q.id]" :ref="'clarInput_'+index" placeholder="輸入回答…（Enter 跳下題／送出，Shift+Enter 換行）" @keydown.enter.exact.prevent="handleClarEnter(index)" @input="autoResize">
</textarea>
</div>
<!-- 問卷這裡不放附件：要貼圖說明的情境走「提問」頁籤。
     ⚠ 另一個 answerFileInput 在下方「無解析題目」的自由回答分支，那個要留——
     停在該閘門時留言框與退回框都被本面板取代，那是唯一能補圖的地方。 -->
<!-- 送出走與其他關卡同一個底排：靠右、膠囊、同高。原本是佔滿一行的方按鈕，
     同一個面板裡兩種按鈕長不一樣。必答提示拿掉——按鈕本來就 disabled，多一行紅字只是噪音。 -->
<div class="ui-next-action-foot">
<span></span>
<div class="ui-next-inline-actions">
<button class="ui-next-primary" @click="submitAnswer" :disabled="submitting||clarBusy||!clarAllAnswered">{{ submitting?'送出中…':'送出回答' }}</button>
</div>
</div>
</template>
</template>
<template v-else>
<form @submit.prevent="submitAsk">
<textarea v-model="askText" :disabled="clarBusy" placeholder="例如：我測試好像正常，要怎麼重現這個情況？" @keydown.enter.exact.prevent="submitAsk" @input="autoResize" @paste="onPasteFiles($event,'askFiles')">
</textarea>
<div class="ui-next-qa-ask-foot">
<label class="ui-next-icon-button" title="附加截圖"><ui-next-icon name="paperclip"/><input ref="askFileInput" type="file" multiple aria-label="附加截圖" @change="onAskFilesSelected"></label>
<span v-if="askFiles.length">已附加 {{ askFiles.length }} 個檔案</span>
<button type="submit" class="ui-next-primary" :disabled="clarBusy||askSubmitting||!askText.trim()">{{ askSubmitting?'送出中…':'送出提問' }}</button>
</div>
</form>
</template>
</template>
<template v-else>
<!-- 綁 newMessageText 而非 resolution：submitAnswer 的無解析題目分支讀的是 newMessageText
     （見本檔 submitAnswer 的 else 分支），resolution 是 blocker mode 的 resolveBlocker 在用。
     綁錯的後果是靜默失效——打字讓按鈕亮起，點下去在那個 "沒文字就 return" 的早退直接返回，
     沒有 toast、沒有錯誤，而 clarify_pending 狀態下這是唯一的回覆入口。 -->
<textarea v-model="newMessageText" placeholder="回答 AI 的問題或補充說明…可直接貼上截圖" @keydown.enter.exact.prevent="submitAnswer" @input="autoResize" @paste="onPasteFiles($event,'newMessageFiles')">
</textarea>
<!-- 停在這個閘門時留言框與退回框都被本面板取代，這裡是唯一能補圖的地方 -->
<p class="ui-next-field-note">可附圖說明（截圖上標註比打字快，AI 這一關讀得到）</p>
<label class="ui-next-upload ui-next-upload-inline"><input ref="answerFileInput" type="file" multiple @change="onAnswerFilesSelected"><span class="ui-next-upload-drop"><ui-next-icon name="paperclip"/><b>附加截圖</b></span></label>
<button class="ui-next-primary" @click="submitAnswer" :disabled="submitting||!newMessageText.trim()">{{ submitting?'送出中…':'送出回答' }}</button>
</template>
</template>
<template v-else-if="timelineActionMode==='spec_review'">
<!-- 規格書不在這裡重印：它就是上方對話流那則「等待你審核規格」（見 isSpecLog，模組／實作項／
     驗收／權限接在同一則底下）。面板只管「寫」，內層那個 composer 框因此不再需要——
     面板本身已經是 composer，兩層框正是它最不像聊天頁的地方。 -->
<textarea v-model="specFeedback" placeholder="規格在上方對話裡。可提問或要求調整（例：為什麼備註欄唯讀？／備註欄位改成多行）——提問時 AI 直接在對話回答、規格不變；判定要改才重產規格回到這裡" @keydown.enter.exact.prevent="specRevise" @input="autoResize">
</textarea>
<div class="ui-next-action-foot">
<span></span>
<div class="ui-next-inline-actions">
<button @click="specRevise" :disabled="specRevising||!specFeedback.trim()">{{ specRevising?'送出中…':'要求調整' }}</button>
<button class="ui-next-primary" @click="specApprove" :disabled="specApproving">{{ specApproving?'處理中…':'確認開工' }}</button>
</div>
</div>
</template>
<template v-else-if="timelineActionMode==='review'">
<!-- 程式變更移到上方對話流的最後一則（見 row.isDiff）：它是「要讀的東西」，
     和退回原因這個「要寫的地方」擠在同一個框裡時，看不出哪裡是讀哪裡是寫。 -->
<textarea v-model="rejectReason" placeholder="填寫退回原因，可一次列多個問題，可直接貼上截圖" @keydown.enter.exact.prevent="reject" @input="autoResize" @paste="onPasteFiles($event,'rejectFiles')">
</textarea>
<div class="ui-next-action-foot">
<div class="ui-next-action-tools">
<label class="ui-next-icon-button" :title="'附加截圖（選填，最多 5 個）——下游只讀得到程式碼 diff，看不到畫面'"><ui-next-icon name="paperclip"/><input ref="rejectFileInput" type="file" multiple @change="onRejectFilesSelected"></label>
<!-- diff 本身在對話流最後一則，但那裡被輸入框擋著、不是人會去找的地方：底排留一個入口，
     點了展開並捲過去。狀態與那則卡片共用同一個 diffOpen，兩邊不會各開各的。 -->
<button type="button" class="ui-next-icon-button" :class="{active:diffOpen}" :disabled="diffLoading" :aria-label="diffOpen?'收合程式變更':'查看程式變更'" :title="diffOpen?'收合程式變更':'查看程式變更'" @click="showDiff"><ui-next-icon name="code"/></button>
<small v-if="rejectFiles.length">已選 {{ rejectFiles.length }} 個附件</small>
</div>
<div class="ui-next-inline-actions">
<button @click="reject" :disabled="rejecting||!rejectReason.trim()">{{ rejecting?'退回中…':'退回修正' }}</button>
<button class="ui-next-primary" @click="approve" :disabled="approving">{{ approving?'處理中…':'審核通過' }}</button>
</div>
</div>
</template>
<template v-else-if="timelineActionMode==='conflict'">
<!-- 重建 testing 造成的衝突沒有逐檔資料可裁決，硬導進裁決流程會讓人對著空清單無事可做 → 分流到手解收尾。 -->
<template v-if="conflictItems.length&&!isRebuildConflict">
<p>自動合併有 {{ conflictItems.length }} 個檔需要你決定。每個檔已附原因與 AI 建議（預設已選建議），確認後送出即可。</p>
<p v-if="isSyncConflict" class="ui-next-field-note">這張任務開工前要把 main 上工程師改的程式拉進來，但和 AI 已改過的地方撞到了。裁決完會回到分析重跑，不會直接進部署。</p>
<div v-for="(item,index) in conflictItems" :key="item.key" class="ui-next-question">
<b>{{ index+1 }}. {{ item.repo }} / {{ item.file }}</b>
<template v-if="item.detail">
<span>衝突型態：{{ item.detail.classification }}</span>
<span v-if="item.detail.reason">原因：{{ item.detail.reason }}</span>
<span v-if="item.detail.rationale">AI 建議：{{ recLabel(item.detail.recommendation) }} — {{ item.detail.rationale }}</span>
</template>
<span v-else>（無法自動分析此檔，請自行判斷或選「我自己手解」）</span>
<label v-for="choice in ['take_theirs','take_ours','manual']" :key="choice">
<input type="radio" :name="'conflict_'+index" :value="choice" v-model="conflictChoices[item.key]"> {{ recLabel(choice) }}<template v-if="item.detail&&item.detail.recommendation===choice"> ★建議</template>
</label>
<!-- 追問區：非工程師看不懂衝突時先問 AI，問清楚再裁決（有結構化 detail 才問得出東西） -->
<template v-if="item.detail">
<div v-for="(qa,qi) in (item.detail.qa||[])" :key="qi">
<b>你：{{ qa.q }}</b>
<span>AI：{{ qa.a }}</span>
</div>
<span>不確定怎麼選？可以先問 AI，問清楚再決定。</span>
<textarea v-model="clarifyText[item.key]" placeholder="看不懂這個衝突？問問看，例如：這兩個版本差在哪？我選「取新版」會失去什麼？">
</textarea>
<button @click="submitClarify(item)" :disabled="clarifying[item.key]||!(clarifyText[item.key]||'').trim()">{{ clarifying[item.key]?'思考中…':'送出追問' }}</button>
</template>
</div>
<button class="ui-next-primary" @click="submitConflictResolutions" :disabled="submittingConflicts||!conflictAllChosen">{{ submittingConflicts?'處理中…':'送出裁決，繼續' }}</button>
</template>
<template v-else>
<p v-if="task.blocker_content" class="ui-next-error-text">{{ task.blocker_content }}</p>
<p>自動合併失敗，請手動在 Repo 解決 Git 衝突後，點擊下方按鈕繼續。</p>
<button class="ui-next-primary" @click="markConflictResolved" :disabled="conflictResolving">{{ conflictResolving?'處理中…':'已手動解決衝突，繼續' }}</button>
</template>
<!-- 與裁決卡片並存而非互斥：選了「我自己手解」的檔沒有這顆按鈕就沒有任何收尾入口。 -->
<button v-if="conflictItems.length&&!isRebuildConflict" @click="markConflictResolved" :disabled="conflictResolving">{{ conflictResolving?'處理中…':'已在 Repo 手動解完剩餘檔，收尾繼續' }}</button>
</template>
<template v-else-if="timelineActionMode==='cs_reply'">
<!-- 回覆全文不在這裡重印：cs-agent 已把它寫進 task_logs（[客服回覆]），左側對話流看得到。
     面板只留「追問／確認結案」這兩個動作。 -->
<textarea v-model="csFollowup" placeholder="確認回覆內容後按「確認結案」；要調整就在這裡追問（例：客戶用的是 17.0／回覆再客氣些）" @keydown.enter.exact.prevent="csFollowupSubmit">
</textarea>
<div class="ui-next-inline-actions">
<button @click="csFollowupSubmit" :disabled="csFollowingUp||!csFollowup.trim()">送出</button>
<button class="ui-next-primary" @click="csConfirm" :disabled="csConfirming">確認結案</button>
</div>
</template>
<template v-else-if="timelineActionMode==='cs_data'">
<div v-for="(question,index) in csQuestions" :key="index" class="ui-next-question">
<b>{{ index+1 }}. {{ question }}</b>
<!-- ref 與 handleCsEnter 成對：少了 ref，Enter 找不到下一題的元素就靜默什麼都不做 -->
<textarea v-model="csAnswers[question]" :ref="'csInput_'+index" :placeholder="'請填寫第 '+(index+1)+' 題…（Enter 跳下題'+(index===csQuestions.length-1?'／送出':'')+'，Shift+Enter 換行）'" @keydown.enter.exact.prevent="handleCsEnter(index)">
</textarea>
</div>
<p v-if="!csAllAnswered" class="ui-next-error-text">請填寫所有問題才能送出</p>
<button class="ui-next-primary" @click="csDataSubmit" :disabled="csRetrying||!csAllAnswered">{{ csRetrying?'處理中…':'送出補充資料，重新分析' }}</button>
</template>
<template v-else-if="timelineActionMode==='blocker'">
<p v-if="!task.blocker_content" class="ui-next-error-text">任務分診失敗或執行中斷</p>
<textarea v-model="resolution" placeholder="例：改用報表方式呈現，不需要新增欄位；或：忽略該錯誤，直接繼續…" @keydown.enter.exact.prevent="resolveBlocker">
</textarea>
<div class="ui-next-action-foot">
<div class="ui-next-inline-actions ui-next-shortcut-row">
<button v-for="shortcut in blockerShortcuts" :key="shortcut.label" :title="shortcut.text" :disabled="resolving" @click="submitResolutionShortcut(shortcut.text)">{{ shortcut.label }}</button>
</div>
<div class="ui-next-inline-actions">
<button class="ui-next-primary" @click="resolveBlocker" :disabled="resolving||!resolution.trim()">{{ resolving?'處理中…':'從中斷處繼續' }}</button>
</div>
</div>
</template>
<template v-else>
<!-- 執行中卻被別張任務的同步衝突擋住：狀態沒變（仍是分析中），原因不秀出來就會靜默卡好幾天。
     只認 sync_wait，避免把「分診中」等狀態殘留的上次停下原因也當成當前錯誤秀出來。 -->
<p v-if="task.blocker_type==='sync_wait'&&task.blocker_content" class="ui-next-error-text">{{ task.blocker_content }}</p>
<!-- ref＋autoResize：這一格原本是固定高，多行留言只能在一個小窗裡捲。ref 是給送出後
     還原高度用的（autoResize 寫的是 inline height，清空文字它不會自己縮回去）。 -->
<!-- rows="1"：HTML 預設是 2，會讓空欄位固定佔兩行（39px）比 min-height 還高，
     一打字反而被 autoResize 縮回 32px，看起來像跳了一下。 -->
<textarea ref="messageInput" rows="1" v-model="newMessageText" placeholder="新增留言…可直接貼上截圖" @keydown.enter.exact.prevent="sendTaskMessage" @input="autoResize">
</textarea>
<!-- 附件與回寫收進底排（同人工審核那一關、同聊天頁的 composer）：原本「附加檔案」是一條
     滿寬的虛線放置區、回寫勾選又獨佔一行，兩者加起來佔掉面板一半的高度。
     ⚠ ref 對應 sendTaskMessage 送出後的 value 清空；沒有 ref 那行清空是死碼，
     檔名會留在欄位裡看起來像又要再送一次。 -->
<!-- disabled 只看文字，與 sendTaskMessage 第一行那個 "沒文字就 return" 的早退對齊。
     原本額外放行「只選了檔案」的情況，按鈕會亮但點下去被那行擋掉，靜默什麼都不發生。 -->
<div class="ui-next-action-foot">
<div class="ui-next-action-tools">
<label class="ui-next-icon-button" title="附加檔案"><ui-next-icon name="paperclip"/><input ref="messageFileInput" type="file" multiple @change="onMessageFilesSelected"></label>
<!-- 比照新對話那顆「資料來源」下拉：底排放原生 checkbox 在視覺上跟旁邊的圖示鈕是兩套東西。
     兩個選項各自說明後果，chip 上只留短標籤（「回寫來源」／「不回寫」）。 -->
<div v-if="showWritebackOption" class="ui-next-source-picker ui-next-composer-chip" @click="writebackOpen=!writebackOpen">
<ui-next-icon name="send"/>
<button type="button" class="ui-next-source-trigger" :aria-expanded="writebackOpen.toString()" aria-haspopup="listbox" aria-label="這則留言要不要回寫到來源系統">{{ messageWriteback?'回寫來源':'不回寫' }}</button>
<ui-next-icon name="chevron-down"/>
<div v-if="writebackOpen" class="ui-next-project-picker-options" role="listbox" aria-label="回寫設定" @click.stop>
<button type="button" role="option" :aria-selected="(!messageWriteback).toString()" @click="messageWriteback=false;writebackOpen=false">不回寫<small>只留在平台</small></button>
<button type="button" role="option" :aria-selected="messageWriteback.toString()" @click="messageWriteback=true;writebackOpen=false">回寫來源<small>同步寫回 Odoo／eService</small></button>
</div>
</div>
<small v-if="newMessageFiles.length">已選 {{ newMessageFiles.length }} 個附件</small>
</div>
<div class="ui-next-inline-actions">
<button v-if="isAgentRunning" class="ui-next-stop" @click="togglePause"><ui-next-icon name="close"/>停止</button>
<button class="ui-next-primary" @click="sendTaskMessage" :disabled="sendingMessage||!newMessageText.trim()">{{ sendingMessage?'送出中…':'送出留言' }}</button>
</div>
</div>
</template>
</template>
</section>
<!-- Enter 的說明比照聊天頁：放在框外下方一行，而不是塞進每個 placeholder。
     塞在 placeholder 裡的話，一開始打字它就消失，正是最需要它的時候。 -->
<small v-if="!taskActionCollapsed&&timelineActionMode!=='archive'" class="ui-next-thread-hint">Enter 送出，Shift + Enter 換行。</small>
</aside>
</div>
<!-- 執行歷程改成跳窗：它是持續 append 的終端輸出，量大又只在除錯時看，
     擺成第三個頁籤會讓每次進頁面都先看到一個空的分頁。 -->
<div v-if="eventsOpen" class="ui-next-task-modal-backdrop" @click.self="eventsOpen=false">
<div class="ui-next-events-modal" role="dialog" aria-modal="true" aria-label="執行歷程">
<header><h2>執行歷程</h2><button type="button" class="ui-next-icon-button" aria-label="關閉" @click="eventsOpen=false"><ui-next-icon name="close"/></button></header>
<div ref="eventsBox" @scroll="onEventsScroll">
<p v-if="eventsLoading" class="ui-next-field-note">載入更早的紀錄中…</p>
<p v-else-if="events.length&&!eventsHasMore" class="ui-next-field-note">— 已到最前 —</p>
<article v-for="event in events" :key="event.id||event.content" :class="['ui-next-event-summary',eventKind(event),{'is-open':!!expandedEvents[event.id||event.content]}]">
<button type="button" :aria-expanded="!!expandedEvents[event.id||event.content]" @click="toggleEvent(event)"><span>{{ eventKind(event)==='error' ? '錯誤' : eventKind(event)==='stage' ? '階段' : '輸出' }}</span><b>{{ eventSummary(event) }}</b><time v-if="event.created_at">{{ formatTime(event.created_at) }}</time></button>
<pre v-if="expandedEvents[event.id||event.content]" v-html="ansiToHtml(event.content)"></pre>
</article>
<p v-if="eventsError" class="ui-next-inline-error" role="alert">{{ eventsError }} <button type="button" @click="loadEvents">重試</button></p>
<p v-else-if="!events.length">尚無執行輸出。</p>
</div>
</div>
</div>
</template>
</section>`,
  });

})();
