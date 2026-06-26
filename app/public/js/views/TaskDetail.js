const ANSWER_ALLOWED = ['confirm_pending', 'final_pending'];
const TD_STATUS_LABELS = {
  new:               '待分診',
  analysis_running:  '分析中',
  branch_pending:    '建立分支',
  confirm_pending:   '等待確認',
  final_pending:     '等待審核',
  confirm_answered:  '已回覆',
  coding_running:    '開發中',
  qa_running:        '測試中',
  merge_running:     '合併中',
  merge_conflict:    '合併衝突',
  deploy_ready:      '可部署正式',
  deploy_pending:    '部署中',
  deploy_fixing:     '修復部署',
  wiki_updating:     '更新 Wiki',
  cs_running:        '客服處理',
  cs_reply_pending:  '等待確認回覆',
  cs_data_needed:    '需補充資料',
  triage_running:    '分診中',
  done:              '完成',
  stopped:           '已停止',
  triage_blocked:    '分診阻塞'
};

window.TaskDetailView = Vue.defineComponent({
  name: 'TaskDetailView',
  data() {
    return { task: null, logs: [], loading: true, answer: '', resolution: '', csAnswers: {}, odooUrl: '', serviceUrl: '', submitting: false, approving: false, merging: false, conflictResolving: false, csConfirming: false, csRetrying: false, resolving: false, error: '', serverConfirmedRunning: false };
  },
  computed: {
    canAnswer() { return this.task && ANSWER_ALLOWED.includes(this.task.status); },
    canApprove() { return this.task && this.task.status === 'final_pending'; },
    canMergeToMain() { return this.task && this.task.status === 'deploy_ready' && this.task.project_id; },
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
    }).catch(() => {});
    this.checkInflight();
  },
  methods: {
    async load() {
      this.loading = true;
      try {
        const data = await Api.get(`tasks/${this.$route.params.id}`);
        this.task = data.task || data;
        this.logs = data.logs || [];
        // Init answer fields for each cs question
        const qs = (() => { try { return JSON.parse(this.task.cs_question || '[]'); } catch { return []; } })();
        const init = {};
        qs.forEach(q => { if (!(q in this.csAnswers)) init[q] = ''; });
        this.csAnswers = { ...this.csAnswers, ...init };
      } catch (e) { this.error = e.message; }
      finally { this.loading = false; }
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
    async approve() {
      this.approving = true;
      try {
        await Api.post(`tasks/${this.task.id}/approve`, {});
        showToast('已審核通過，加入實作佇列', 'success');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.approving = false; }
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
      return this.task.source === 'odoo' ? 'Odoo' : this.task.source === 'service' ? 'eService' : this.task.source;
    },
    roleClass(role) { return role === 'ai' ? 'ai' : role === 'user' ? 'user' : 'system'; },
    roleLabel(role) { return role === 'ai' ? '🤖 AI' : role === 'user' ? '👤 你' : '⚙️ 系統'; },
    formatTime(ts) {
      if (!ts) return '';
      return new Date(ts).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
    async mergeToMain() {
      if (!confirm('確認將此分支合併回主線並刪除？此動作無法復原。')) return;
      this.merging = true;
      try {
        await Api.post(`tasks/${this.task.id}/merge-to-main`, {});
        showToast('已合併回主線，開始更新 Wiki', 'success');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.merging = false; }
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
        showToast('阻塞已解決，任務重新排入分診', 'success');
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
    back() { this.$router.push('/'); }
  },
  template: `
    <div class="topbar">
      <h1>任務詳情</h1>
    </div>
    <div class="content">
      <div class="back-link" @click="back">← 返回列表</div>
      <div v-if="loading" class="loading">載入中...</div>
      <div v-else-if="error" class="error-msg">{{ error }}</div>
      <div v-else-if="task">
        <div class="detail-card">
          <div class="detail-title">{{ task.title || task.task_id }}</div>
          <div class="detail-meta">
            <span class="status-badge" :class="task.status">{{ statusLabel }}</span>
            <span v-if="serverConfirmedRunning"
              style="display:inline-flex;align-items:center;gap:4px;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600">
              <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#3b82f6;animation:pulseDot 1.4s ease-in-out infinite"></span>伺服器確認處理中
            </span>
            <a v-if="sourceUrl()" :href="sourceUrl()" target="_blank"
               style="color:var(--primary);text-decoration:none;font-weight:500">{{ sourceLabel() }}</a>
            <span v-else>{{ task.source }}</span>
            <span v-if="task.module">模組：{{ task.module }}</span>
            <span style="color:var(--text-muted);font-size:11px">最後更新：{{ formatTime(task.updated_at) }}</span>
          </div>

          <div v-if="task.blocker_content || ['stopped','triage_blocked'].includes(task.status)"
            style="border:1px solid #fc8181;border-radius:8px;overflow:hidden;margin-bottom:16px">
            <div style="background:#fff5f5;padding:10px 14px;font-size:13px;white-space:pre-wrap">
              <strong style="color:#c53030">⚠ 阻塞原因：</strong><br>{{ task.blocker_content || '任務分診失敗或執行中斷' }}
            </div>
            <div style="background:#fff;padding:12px 14px;border-top:1px solid #fed7d7">
              <div style="font-size:12px;font-weight:600;color:#744210;margin-bottom:8px">解決阻塞 — 說明你的指示或修正方向，任務將重新排入分診</div>
              <textarea v-model="resolution"
                placeholder="例：改用報表方式呈現，不需要新增欄位；或：忽略該錯誤，直接繼續..."
                style="width:100%;height:80px;padding:8px;border:1px solid #fc8181;border-radius:6px;font-size:13px;resize:vertical;box-sizing:border-box">
              </textarea>
              <div style="margin-top:8px">
                <button class="btn btn-primary btn-sm" @click="resolveBlocker" :disabled="resolving || !resolution.trim()">
                  {{ resolving ? '處理中...' : '↺ 送出並重新分診' }}
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

          <div v-if="['analysis_running','cs_running','coding_running','qa_running','merge_running','deploy_fixing','wiki_updating'].includes(task.status)"
               style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
            <router-link :to="'/task/' + task.id + '/terminal'" class="btn btn-outline btn-sm">
              🖥️ 查看 AI 執行歷程
            </router-link>
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

          <div v-if="canMergeToMain" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
            <div class="form-section">合併回主線</div>
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
              QA 已通過，主線已同步。確認後將分支 <code>{{ task.git_branch }}</code> 合併回主線並刪除。
            </p>
            <button class="btn btn-primary" @click="mergeToMain" :disabled="merging">
              {{ merging ? '合併中...' : '✓ 確認合併回主線並刪除分支' }}
            </button>
          </div>

          <div v-if="canApprove" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
            <div class="form-section">MODE_B 審核</div>
            <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">AI 已完成需求分析，等待你確認後才開始實作。</p>
            <button class="btn btn-primary" @click="approve" :disabled="approving">
              {{ approving ? '處理中...' : '✓ 審核通過，開始實作' }}
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
      </div>
    </div>
  `
});
