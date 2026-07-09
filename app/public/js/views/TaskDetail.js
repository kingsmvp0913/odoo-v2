const ANSWER_ALLOWED = ['confirm_pending'];
const TD_STATUS_LABELS = {
  new:                 '待分類',
  analysis_running:    '分析中',
  branch_pending:      '建立分支',
  confirm_pending:     '等待確認',
  confirm_answered:    '已回覆',
  coding_running:      '開發中',
  qa_running:          'QA 審查中',
  merge_running:       '併入測試中',
  merge_conflict:      '合併衝突',
  deploy_testing:      '部署測試區',
  playwright_running:  'E2E 測試中',
  review_pending:      '等待審核',
  wiki_updating:       '更新 Wiki',
  cs_running:          '客服處理',
  cs_reply_pending:    '等待確認回覆',
  cs_data_needed:      '需補充資料',
  done:                '完成',
  stopped:             '失敗待確認'
};

window.TaskDetailView = Vue.defineComponent({
  name: 'TaskDetailView',
  data() {
    return { task: null, logs: [], loading: true, answer: '', resolution: '', csAnswers: {}, odooUrl: '', serviceUrl: '', submitting: false, approving: false, archiving: false, rejecting: false, showReject: false, rejectReason: '', conflictResolving: false, csConfirming: false, csRetrying: false, resolving: false, error: '', serverConfirmedRunning: false, testMode: false, stepping: false, events: [], eventsHasMore: true, eventsLoading: false, editingContent: false, editText: '', savingContent: false, taskMessages: [], sendingMessage: false, newMessageText: '' };
  },
  computed: {
    canAnswer() { return this.task && ANSWER_ALLOWED.includes(this.task.status); },
    canEditContent() { return this.task && this.task.status === 'new'; },
    canApprove() { return this.task && this.task.status === 'review_pending'; },
    canArchive() { return this.task && this.task.status === 'done'; },
    statusLabel() { return this.task ? (TD_STATUS_LABELS[this.task.status] || this.task.status) : ''; },
    csQuestions() {
      if (!this.task?.cs_question) return [];
      try { return JSON.parse(this.task.cs_question); } catch { return [this.task.cs_question]; }
    },
    csAllAnswered() {
      return this.csQuestions.length > 0 && this.csQuestions.every(q => (this.csAnswers[q] || '').trim());
    }
  },
  async created() {
    await this.load();
    Api.get('system/config').then(r => {
      this.odooUrl = r.odoo_url || '';
      this.serviceUrl = r.service_url || '';
      this.testMode = !!r.test_mode;
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
  methods: {
    async load() {
      this.loading = true;
      try {
        await this.refresh();
      } catch (e) { this.error = e.message; }
      finally { this.loading = false; }
    },
    // 靜默重抓任務＋logs（不切 loading，避免即時更新時整頁閃「載入中」）
    async refresh() {
      const data = await Api.get(`tasks/${this.$route.params.id}`);
      this.task = data.task || data;
      this.logs = data.logs || [];
      // Init answer fields for each cs question
      const qs = (() => { try { return JSON.parse(this.task.cs_question || '[]'); } catch { return []; } })();
      const init = {};
      qs.forEach(q => { if (!(q in this.csAnswers)) init[q] = ''; });
      this.csAnswers = { ...this.csAnswers, ...init };
    },
    async submitAnswer() {
      if (!this.answer.trim()) return;
      this.submitting = true;
      try {
        await Api.post(`tasks/${this.task.id}/answer`, { user_answer: this.answer });
        this.answer = '';
        showToast('回覆已送出', 'success');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.submitting = false; }
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
      try {
        this.taskMessages = await Api.get(`tasks/${this.$route.params.id}/messages`);
      } catch { /* best-effort */ }
    },
    async sendTaskMessage() {
      if (!this.newMessageText.trim()) return;
      this.sendingMessage = true;
      try {
        await Api.post(`tasks/${this.task.id}/messages`, { content: this.newMessageText.trim() });
        this.newMessageText = '';
        await this.loadTaskMessages();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.sendingMessage = false; }
    },
    async approve() {
      if (!confirm('確定審核通過，合併回主線？')) return;
      this.approving = true;
      try {
        await Api.post(`tasks/${this.task.id}/approve`, {});
        showToast('已審核通過，合併回主線並更新文件', 'success');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.approving = false; }
    },
    async reject() {
      if (!this.rejectReason.trim()) return;
      this.rejecting = true;
      try {
        await Api.post(`tasks/${this.task.id}/reject`, { reason: this.rejectReason.trim() });
        showToast('已退回，任務回到開發依原因修正', 'success');
        this.rejectReason = ''; this.showReject = false;
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.rejecting = false; }
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
    roleClass(role) { return role === 'ai' ? 'ai' : role === 'user' ? 'user' : 'system'; },
    roleLabel(role) { return role === 'ai' ? '🤖 AI' : role === 'user' ? '👤 你' : '⚙️ 系統'; },
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
    async markConflictResolved() {
      this.conflictResolving = true;
      try {
        await Api.post(`tasks/${this.task.id}/mark-conflict-resolved`, {});
        showToast('衝突已標記為解決，可繼續更新正式', 'success');
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
        await Api.post(`tasks/${this.task.id}/cs-data-submit`, { answers: { ...this.csAnswers } });
        this.csAnswers = {};
        showToast('已補充資料，重新送入分析', 'success');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.csRetrying = false; }
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
      if (!this.task) return;
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
    stripAnsi(s) { return String(s == null ? '' : s).replace(/\x1b\[[0-9;]*m/g, ''); },
    scrollEventsToBottom() { const c = this.$refs.eventsBox; if (c) c.scrollTop = c.scrollHeight; },
    async loadEvents() {
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
      <button class="btn btn-outline btn-sm" @click="back" style="margin-right:12px">← 返回</button>
      <h1>任務詳情</h1>
      <span v-if="testMode" class="pill pill-warn" style="font-size:12px;padding:2px 8px">🧪 測試模式</span>
      <button v-if="testMode" class="btn btn-primary btn-sm" @click="stepPipeline" :disabled="stepping" style="margin-left:8px">
        {{ stepping ? '執行中...' : '▶ 推進 Pipeline' }}
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
              style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;font-weight:600">
              <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;animation:pulseDot 1.4s ease-in-out infinite"></span>伺服器確認處理中
            </span>
            <a v-if="sourceUrl()" :href="sourceUrl()" target="_blank"
               style="color:var(--primary);text-decoration:none;font-weight:500">{{ sourceLabel() }}</a>
            <span v-else>{{ sourceLabel() }}</span>
            <span v-if="task.module">模組：{{ task.module }}</span>
            <span style="color:var(--text-muted);font-size:11px">最後更新：{{ formatTime(task.updated_at) }}</span>
          </div>

          <div class="form-section" style="display:flex;justify-content:space-between;align-items:center;margin:16px 0 8px">
            <span>需求內容</span>
            <button v-if="canEditContent && !editingContent" class="btn btn-outline btn-sm" @click="startEditContent">✎ 編輯</button>
          </div>
          <div v-if="!editingContent" style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px 14px;font-size:13px;white-space:pre-wrap;margin-bottom:16px">{{ task.original_text || '（無內容）' }}</div>
          <div v-else style="margin-bottom:16px">
            <textarea v-model="editText" style="width:100%;height:140px;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px;line-height:1.6;resize:vertical;box-sizing:border-box"></textarea>
            <div style="margin-top:8px;display:flex;gap:8px">
              <button class="btn btn-primary btn-sm" @click="saveContent" :disabled="savingContent || !editText.trim()">
                {{ savingContent ? '儲存中...' : '儲存' }}
              </button>
              <button class="btn btn-outline btn-sm" @click="cancelEditContent" :disabled="savingContent">取消</button>
            </div>
          </div>

          <div class="form-section" style="margin:16px 0 8px">外部溝通紀錄</div>
          <div style="border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin-bottom:16px">
            <div v-if="!taskMessages.length" style="color:var(--text-muted);font-size:13px">尚無溝通紀錄</div>
            <div v-for="m in taskMessages" :key="m.id" style="padding:8px 0;border-bottom:1px solid var(--border)">
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">
                {{ m.source === 'manual' ? (m.author || '你') : '（同步）' }} · {{ formatTime(m.occurred_at) }}
                <span v-if="m.source === 'manual' && m.synced_to_odoo" style="color:var(--success)">已回寫</span>
              </div>
              <div style="font-size:13px;white-space:pre-wrap">{{ m.content }}</div>
            </div>
            <div style="margin-top:12px">
              <textarea v-model="newMessageText" placeholder="新增留言..."
                style="width:100%;height:60px;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px;resize:vertical;box-sizing:border-box"></textarea>
              <button class="btn btn-primary btn-sm" style="margin-top:6px" @click="sendTaskMessage" :disabled="sendingMessage || !newMessageText.trim()">
                {{ sendingMessage ? '送出中...' : '送出留言' }}
              </button>
            </div>
          </div>

          <div v-if="task.blocker_content || task.status === 'stopped'"
            style="border:1px solid #fc8181;border-radius:8px;overflow:hidden;margin-bottom:16px">
            <div style="background:#fff5f5;padding:10px 14px;font-size:13px;white-space:pre-wrap;color:#742a2a">
              <strong style="color:#c53030">⚠ 失敗原因：</strong><br>{{ task.blocker_content || '任務分診失敗或執行中斷' }}
            </div>
            <div style="background:#fff;padding:12px 14px;border-top:1px solid #fed7d7">
              <div style="font-size:12px;font-weight:600;color:#744210;margin-bottom:8px">處理失敗 — 說明你的修正方向，任務將回到失敗的那一關重試</div>
              <textarea v-model="resolution"
                placeholder="例：改用報表方式呈現，不需要新增欄位；或：忽略該錯誤，直接繼續..."
                style="width:100%;height:80px;padding:8px;border:1px solid #fc8181;border-radius:6px;font-size:13px;resize:vertical;box-sizing:border-box">
              </textarea>
              <div style="margin-top:8px">
                <button class="btn btn-primary btn-sm" @click="resolveBlocker" :disabled="resolving || !resolution.trim()">
                  {{ resolving ? '處理中...' : '↺ 送出並從中斷處繼續' }}
                </button>
              </div>
            </div>
          </div>

          <div v-if="logs.length > 0" class="conv-log">
            <div v-for="log in logs" :key="log.id">
              <div class="conv-msg" :class="roleClass(log.role)">{{ log.content }}</div>
              <div class="conv-msg-meta" :style="{ textAlign: log.role === 'user' ? 'right' : 'left' }">
                {{ roleLabel(log.role) }} · {{ formatTime(log.created_at) }}
              </div>
            </div>
          </div>
          <div v-else style="color:var(--text-muted);font-size:13px;margin:16px 0">尚無對話記錄</div>

          <div v-if="canAnswer" class="answer-box">
            <div class="form-section">回覆 AI 問題</div>
            <textarea v-model="answer" placeholder="輸入你的回覆..." style="width:100%;height:80px;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:14px;resize:vertical"></textarea>
            <div class="answer-actions">
              <button class="btn btn-primary btn-sm" @click="submitAnswer" :disabled="submitting || !answer.trim()">
                {{ submitting ? '送出中...' : '送出回覆' }}
              </button>
            </div>
          </div>

          <div v-if="task.status === 'merge_conflict'" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
            <div class="form-section">合併衝突 — 需人工解決</div>
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
              自動合併失敗，請手動在 Repo 解決 Git 衝突後，點擊下方按鈕繼續。
            </p>
            <button class="btn btn-primary" @click="markConflictResolved" :disabled="conflictResolving">
              {{ conflictResolving ? '處理中...' : '✓ 已手動解決衝突，繼續' }}
            </button>
          </div>

          <div v-if="canApprove" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
            <div class="form-section">最終人工審核</div>
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
              已通過 QA、測試區部署與 E2E 測試。確認後將分支 <code>{{ task.git_branch }}</code> 合併回主線、更新文件。
            </p>
            <button class="btn btn-primary" @click="approve" :disabled="approving || rejecting">
              {{ approving ? '處理中...' : '✓ 審核通過，合併回主線' }}
            </button>
            <button class="btn btn-outline" style="margin-left:8px" @click="showReject = !showReject" :disabled="approving || rejecting">↩ 退回開發</button>
            <div v-if="showReject" style="margin-top:12px">
              <textarea v-model="rejectReason" class="form-control" rows="4"
                placeholder="填寫退回原因（可一次列多個問題，系統會自動分類歸檔供工作流程健檢）"></textarea>
              <button class="btn btn-primary btn-sm" style="margin-top:8px" @click="reject" :disabled="rejecting || !rejectReason.trim()">
                {{ rejecting ? '退回中...' : '確認退回，回開發依原因修正' }}
              </button>
            </div>
          </div>

          <div v-if="canArchive" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
            <div class="form-section">任務已完成</div>
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">此任務已完成並更新文件。可手動封存，或滿一個月後自動封存。</p>
            <button class="btn btn-outline" @click="archive" :disabled="archiving">
              {{ archiving ? '封存中...' : '🗄 封存任務' }}
            </button>
          </div>

          <div v-if="task.status === 'cs_reply_pending'" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
            <div class="form-section">客服回覆草稿</div>
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px 14px;font-size:13px;white-space:pre-wrap;margin-bottom:12px">{{ task.cs_reply }}</div>
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">AI 已生成操作問題的回覆草稿，請確認內容後送出。</p>
            <button class="btn btn-primary" @click="csConfirm" :disabled="csConfirming">
              {{ csConfirming ? '處理中...' : '✓ 確認送出，結案' }}
            </button>
          </div>

          <div v-if="task.status === 'cs_data_needed'" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
            <div class="form-section">需補充資料</div>
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:14px">請填寫以下所有問題後送出，AI 將重新分析。</p>
            <div v-for="(q, idx) in csQuestions" :key="idx" style="margin-bottom:14px">
              <div style="font-size:13px;font-weight:600;margin-bottom:6px;display:flex;gap:6px;align-items:flex-start">
                <span style="background:var(--primary);color:#fff;border-radius:50%;width:18px;height:18px;font-size:11px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px">{{ idx + 1 }}</span>
                <span>{{ q }}</span>
              </div>
              <textarea v-model="csAnswers[q]"
                :ref="'csInput_' + idx"
                :placeholder="'請填寫第 ' + (idx + 1) + ' 題...（Enter 跳下題' + (idx === csQuestions.length - 1 ? '／送出' : '') + '）'"
                style="width:100%;height:72px;padding:8px;border:1px solid;border-color:csAnswers[q] && csAnswers[q].trim() ? 'var(--border)' : '#fc8181';border-radius:6px;font-size:13px;resize:vertical"
                :style="{ borderColor: csAnswers[q] && csAnswers[q].trim() ? 'var(--border)' : '#fc8181' }"
                @keydown.enter.prevent="handleCsEnter(idx)">
              </textarea>
            </div>
            <div v-if="!csAllAnswered" style="font-size:12px;color:var(--danger);margin-bottom:10px">⚠ 請填寫所有問題才能送出</div>
            <button class="btn btn-primary" @click="csDataSubmit" :disabled="csRetrying || !csAllAnswered">
              {{ csRetrying ? '處理中...' : '↺ 送出補充資料，重新分析' }}
            </button>
          </div>
        </div>

        <div class="detail-card" style="margin-top:16px">
          <div class="form-section" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span>即時歷程記錄</span>
            <span v-if="eventsLoading" style="font-size:11px;color:var(--text-muted)">載入中…</span>
          </div>
          <div ref="eventsBox" @scroll="onEventsScroll"
            style="height:320px;overflow-y:auto;background:#1a1a1a;color:#e0e0e0;font-family:Consolas,monospace;font-size:12px;line-height:1.5;padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-word">
            <div v-if="!events.length" style="color:#888">尚無執行紀錄</div>
            <template v-else>
              <div v-if="!eventsHasMore" style="color:#666;text-align:center;font-size:11px;margin-bottom:6px">— 已到最前 —</div>
              <span v-for="(ev, i) in events" :key="ev.id || ('live'+i)">{{ stripAnsi(ev.content) }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>
  `
});
