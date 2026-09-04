// 考試作戰台：外部程式 POST 截圖與作答，server 自動審題；本頁只負責即時看結果、
// 投票與設定最後答案。題庫整理是 ExamBank 的責任，兩頁不要混在一起。
window.UiNextExamRunView = Vue.defineComponent({
  name: 'UiNextExamRunView',
  data() {
    return {
      banks: [], bankId: null, bank: null,
      uploads: [], attempts: [], loading: true, err: '',
      filter: 'all', showTest: false,
      finalDraft: {}, savingFinal: {},
    };
  },
  async created() {
    try {
      this.banks = await Api.get('exam/banks');
      if (this.banks.length) { this.bankId = this.banks[0].id; await this.refresh(); }
    } catch (e) { this.err = e.message; }
    finally { this.loading = false; }
  },
  mounted() {
    this._onProgress = () => this.queueRefresh();
    const bind = () => {
      const sock = window._socket;
      if (!sock) return false;
      sock.on('exam-progress', this._onProgress);
      return true;
    };
    if (!bind()) this._sockTimer = setInterval(() => {
      if (bind()) { clearInterval(this._sockTimer); this._sockTimer = null; }
    }, 300);
    // socket 只是加速通知；工作進度的真相仍在 DB。
    // 即使目前清單是空的也固定回查：外部 POST 可能發生在頁面開啟之後；若那一刻
    // socket 正在重連，只在「已有 pending」時輪詢會讓新資料永遠不出現。
    this._pollTimer = setInterval(() => this.refresh(), 5000);
  },
  beforeUnmount() {
    if (this._sockTimer) clearInterval(this._sockTimer);
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    const sock = window._socket;
    if (sock && sock.off && this._onProgress) sock.off('exam-progress', this._onProgress);
  },
  computed: {
    uploadGroups() {
      const questions = new Map();
      for (const a of this.attempts) {
        if (!questions.has(a.upload_id)) questions.set(a.upload_id, []);
        questions.get(a.upload_id).push(a);
      }
      return this.uploads.map(u => ({ ...u, questions: questions.get(u.id) || [] }));
    },
    visibleGroups() {
      return this.uploadGroups.filter(g => {
        if (!this.showTest && g.is_test) return false;
        if (this.filter === 'pending') return g.status === 'pending' || g.status === 'running';
        if (this.filter === 'mismatch') return this.groupMismatch(g);
        return true;
      });
    },
    stats() {
      const groups = this.uploadGroups.filter(g => !g.is_test);
      const questions = groups.flatMap(g => g.questions);
      const mismatch = questions.filter(q => this.isMismatch(q)).length;
      const judged = questions.filter(q => q.review_source).length;
      return {
        total: questions.length, mismatch, match: judged - mismatch,
        pending: groups.filter(g => g.status === 'pending' || g.status === 'running').length,
      };
    },
  },
  methods: {
    async refresh() {
      if (!this.bankId) return;
      try {
        const data = await Api.get(`exam/dashboard?bank=${this.bankId}`);
        this.bank = data.bank; this.uploads = data.uploads || []; this.attempts = data.attempts || [];
        const next = { ...this.finalDraft };
        for (const a of this.attempts) if (!this.savingFinal[a.attempt_id]) {
          next[a.attempt_id] = Array.isArray(a.answer_final) ? [...a.answer_final] : [];
        }
        this.finalDraft = next;
      } catch (e) { this.err = e.message; }
    },
    queueRefresh() {
      if (this._refreshTimer) return;
      this._refreshTimer = setTimeout(() => { this._refreshTimer = null; this.refresh(); }, 500);
    },
    sameAnswer(a, b) {
      const norm = x => (Array.isArray(x) ? [...x].map(String).sort().join(',') : '');
      return !!norm(a) && norm(a) === norm(b);
    },
    isMismatch(q) { return !!q.review_source && !this.sameAnswer(q.answer_their, q.review_answer); },
    groupMismatch(g) { return g.questions.some(q => this.isMismatch(q)); },
    answerText(a) { return Array.isArray(a) ? a.join(',') : ''; },
    sourceText(q) {
      return q.review_source === 'official' ? '官方' : (q.review_source === 'review' ? '審查' : '等待中');
    },
    voteLetters(q) {
      const letters = (q.options || []).map(o => o.letter).filter(Boolean);
      return letters.length ? letters : ['A', 'B', 'C', 'D'];
    },
    voteCount(q, letter) { return Number((q.vote_options || {})[letter] || 0); },
    votePct(q, letter) { return q.vote_total ? Math.round(this.voteCount(q, letter) * 100 / q.vote_total) : 0; },
    topVote(q) {
      if (!q.vote_total) return { answer: '-', pct: null };
      const order = this.voteLetters(q);
      let answer = order[0];
      for (const letter of order) if (this.voteCount(q, letter) > this.voteCount(q, answer)) answer = letter;
      return { answer, pct: this.votePct(q, answer) };
    },
    isFinalSelected(q, letter) {
      return (this.finalDraft[q.attempt_id] || []).includes(letter);
    },
    hasAnswer(answer, letter) { return Array.isArray(answer) && answer.includes(letter); },
    async vote(q, letter) {
      q.has_voted = true;
      try {
        await Api.post(`exam/attempts/${q.attempt_id}/vote`, { answer: [letter] });
        await this.refresh();
      } catch (e) { q.has_voted = false; showToast(e.message, 'error'); }
    },
    async toggleFinal(q, letter, checked) {
      const current = [...(this.finalDraft[q.attempt_id] || [])];
      const next = !checked ? current.filter(x => x !== letter)
        : (q.qtype === 'multi' ? [...current, letter] : [letter]);
      this.finalDraft = { ...this.finalDraft, [q.attempt_id]: next };
      this.savingFinal = { ...this.savingFinal, [q.attempt_id]: true };
      try {
        const out = await Api.patch(`exam/attempts/${q.attempt_id}/final`, { answer: next });
        q.answer_final = out.answer;
        this.finalDraft = { ...this.finalDraft, [q.attempt_id]: Array.isArray(out.answer) ? [...out.answer] : [] };
        showToast(next.length ? '正式答案已儲存' : '正式答案已留白', 'success');
      } catch (e) {
        this.finalDraft = { ...this.finalDraft, [q.attempt_id]: current };
        showToast(e.message, 'error');
      }
      finally { this.savingFinal = { ...this.savingFinal, [q.attempt_id]: false }; }
    },
    statusText(g) {
      if (g.status === 'pending') return '等待審題';
      if (g.status === 'running') return '審題中';
      if (g.status === 'failed') return `失敗：${g.error || '未說明'}`;
      return this.groupMismatch(g) ? `${g.questions.filter(q => this.isMismatch(q)).length} 題不一致` : '全部一致';
    },
    shortTime(t) {
      if (!t) return '';
      const d = new Date(t);
      return isNaN(d) ? '' : d.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    },
  },
  template: `
    <div class="topbar ui-next-admin-head">
      <div><h1>考試作戰台</h1><div class="ui-next-exam-run-sub">外部 POST 後自動審題；這裡只看結果、投票與最後答案</div></div>
      <div class="ui-next-admin-head-actions">
        <button class="btn btn-outline btn-sm" @click="$router.push('/exam-bank')">題庫</button>
      </div>
    </div>
    <div class="content">
      <div v-if="loading" class="ui-next-exam-empty">載入中…</div>
      <div v-else-if="!banks.length" class="ui-next-exam-empty">還沒有題庫，外部 POST 前需先指定題庫。</div>
      <template v-else>
        <div class="ui-next-exam-run-stats">
          <button @click="filter='all'" :class="['ui-next-exam-run-stat',filter==='all' && 'is-on']"><b>{{ stats.total }}</b><span>正式題數</span></button>
          <button @click="filter='mismatch'" :class="['ui-next-exam-run-stat','is-bad',filter==='mismatch' && 'is-on']"><b>{{ stats.mismatch }}</b><span>不一致</span></button>
          <div class="ui-next-exam-run-stat is-ok"><b>{{ stats.match }}</b><span>一致</span></div>
          <button @click="filter='pending'" :class="['ui-next-exam-run-stat',filter==='pending' && 'is-on']"><b>{{ stats.pending }}</b><span>處理中（頁）</span></button>
        </div>
        <div class="ui-next-exam-run-toolbar">
          <button :class="['ui-next-exam-chip',filter==='all' && 'is-on']" @click="filter='all'">全部</button>
          <button :class="['ui-next-exam-chip',filter==='mismatch' && 'is-on']" @click="filter='mismatch'">只看不一致</button>
          <button :class="['ui-next-exam-chip',filter==='pending' && 'is-on']" @click="filter='pending'">處理中</button>
          <label><input type="checkbox" v-model="showTest" /> 顯示測試資料</label>
        </div>
        <div v-if="err" class="ui-next-exam-run-err">{{ err }}</div>
        <details v-for="g in visibleGroups" :key="g.id" :open="groupMismatch(g) || g.status!=='done'"
                 :class="['ui-next-exam-run-card',g.status==='failed' && 'is-failed']">
          <summary class="ui-next-exam-run-card-head">
            <b>P{{ g.page }}</b><span>{{ statusText(g) }}</span><span>{{ g.responder || '未具名' }}</span><time>{{ shortTime(g.created_at) }}</time>
          </summary>
          <div v-if="!g.questions.length" class="ui-next-exam-run-idle">{{ statusText(g) }}</div>
          <template v-for="q in g.questions" :key="q.attempt_id">
            <div v-if="q.review_source==='official'" class="ui-next-exam-run-question ui-next-exam-run-official">
              <h3><span>🔒 {{ q.no }}.</span> {{ q.question_zh || q.question_en }}</h3>
              <small>官方確認 · {{ answerText(q.review_answer) }}</small>
            </div>
            <details v-else :open="isMismatch(q)" :class="['ui-next-exam-run-question',isMismatch(q) && 'is-mismatch']">
              <summary>
                <h3><span>{{ q.no }}.</span> {{ q.question_zh || q.question_en }}</h3>
                <div v-if="q.question_zh" class="ui-next-exam-run-en">{{ q.question_en }}</div>
              </summary>
              <div class="ui-next-exam-run-options">
                <div v-for="option in q.options" :key="option.letter" :class="['ui-next-exam-run-option',
                     hasAnswer(q.review_answer,option.letter) && 'is-review',hasAnswer(q.answer_their,option.letter) && 'is-input',
                     isFinalSelected(q,option.letter) && 'is-selected']">
                  <label>
                    <input type="checkbox" title="正式答案" :checked="isFinalSelected(q,option.letter)" :disabled="savingFinal[q.attempt_id]" @change="toggleFinal(q,option.letter,$event.target.checked)" />
                    <b>{{ option.letter }}</b><span>{{ option.text_zh || option.text }}</span>
                    <small v-if="hasAnswer(q.answer_their,option.letter)" class="ui-next-exam-run-input-mark">輸入答案</small>
                    <small v-else-if="hasAnswer(q.review_answer,option.letter)" class="ui-next-exam-run-review-mark">審查答案</small>
                    <small v-if="topVote(q).answer===option.letter" class="ui-next-exam-run-vote-mark">投票 {{ topVote(q).pct }}%</small>
                  </label>
                  <button v-if="!q.has_voted" class="ui-next-exam-run-vote" @click="vote(q,option.letter)">投票</button>
                </div>
                <small v-if="!q.vote_total" class="ui-next-exam-run-vote-empty">投票 -</small>
              </div>
            </details>
          </template>
        </details>
        <div v-if="!visibleGroups.length" class="ui-next-exam-empty">沒有符合的考試資料。</div>
      </template>
    </div>
  `,
});
