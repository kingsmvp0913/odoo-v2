// 考試作戰台：外部程式 POST 截圖與作答，server 自動審題；本頁只負責即時看結果、
// 投票與設定最後答案。題庫整理是 ExamBank 的責任，兩頁不要混在一起。
window.UiNextExamRunView = Vue.defineComponent({
  name: 'UiNextExamRunView',
  components: { UiNextIcon: window.UiNextIcon },
  data() {
    return {
      banks: [], bankId: null, bank: null,
      uploads: [], attempts: [], loading: true, err: '',
      filter: 'all', clearing: false,
      finalDraft: {}, savingFinal: {},
      archiveOpen: false, archivePages: [], archiving: false, archiveResult: null,
      retrying: {},
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
    // 走 SocketManager.onSocket，不要自己去摸 window._socket——那個全域根本不存在
    // （_socket 是 socket.js 那個 IIFE 的區域變數），舊寫法從第一天起就沒綁上過，
    // 而且「綁不到就每 300ms 重試」變成一個永不停止的計時器。
    // 失敗是靜默的：畫面只是退回 5 秒輪詢，沒有任何錯誤訊息。
    this._offSocket = window.SocketManager
      && window.SocketManager.onSocket('exam-progress', this._onProgress);
    // socket 只是加速通知；工作進度的真相仍在 DB。
    // 即使目前清單是空的也固定回查：外部 POST 可能發生在頁面開啟之後；若那一刻
    // socket 正在重連，只在「已有 pending」時輪詢會讓新資料永遠不出現。
    this._pollTimer = setInterval(() => this.refresh(), 5000);
  },
  beforeUnmount() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    if (this._offSocket) this._offSocket();
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
      // 測試資料一律不顯示：統計本來就把它排除，讓它在清單出現只會讓兩個數字對不起來。
      return this.uploadGroups
        .filter(g => !g.is_test)
        .map(g => ({ ...g, questions: this.visibleQuestions(g) }))
        // 篩選時整頁都沒問題就連頁一起收掉，剩下的才是真的要處理的
        .filter(g => this.filter !== 'check' || g.questions.length);
    },
    stats() {
      // 還在跑的那一頁不計入。作答是在審查完成**之前**就建好的（saveVerdicts 要靠
      // 它們對應題號），所以題目會先冒出來、判斷卻還沒寫進去——那時候把它算進
      // 統計，「需確認」會先跳一個假數字再自己變回去，看起來像判錯又改口。
      const groups = this.uploadGroups.filter(g => !g.is_test && !this.isBusy(g));
      const questions = groups.flatMap(g => g.questions);
      const check = questions.filter(q => this.needsCheck(q)).length;
      const judged = questions.filter(q => q.review_source).length;
      return { total: questions.length, check, ok: judged - check };
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
    async retryPage(g) {
      if (!await confirmDialog({
        title: `重跑 P${g.page}`,
        message: '會先清掉這一頁已建的作答再重新判題（不清的話會變成兩份重複的）。'
          + '原本的截圖與作答不受影響。',
        confirmText: '重跑',
      })) return;
      this.retrying = { ...this.retrying, [g.id]: true };
      try {
        await Api.post(`exam/uploads/${g.id}/retry`, {});
        await this.refresh();
        showToast(`P${g.page} 已排入重跑`, 'success');
      } catch (e) { showToast(e.message, 'error', 0); }
      finally { this.retrying = { ...this.retrying, [g.id]: false }; }
    },
    queueRefresh() {
      if (this._refreshTimer) return;
      this._refreshTimer = setTimeout(() => { this._refreshTimer = null; this.refresh(); }, 500);
    },
    sameAnswer(a, b) {
      const norm = x => (Array.isArray(x) ? [...x].map(String).sort().join(',') : '');
      return !!norm(a) && norm(a) === norm(b);
    },
    // 目前檯面上的答案。answer_final 在建立作答時預設就等於輸入答案，所以一開始
    // 兩者相同；人在這一頁改過之後才有差，而「改過了沒」正是要不要再確認的關鍵。
    current(q) {
      return (Array.isArray(q.answer_final) && q.answer_final.length) ? q.answer_final : q.answer_their;
    },
    // 審查有意見：它給的答案跟現在檯面上的不一樣。
    // 比對 answer_final 而不是 answer_their——照審查改完之後這題就該退出清單，
    // 不然清單永遠不會變短，等於沒有「處理完」這件事。
    isMismatch(q) { return !!q.review_source && !this.sameAnswer(this.current(q), q.review_answer); },
    // 又踩到同一個坑：上次考試選這個、而且已經標成大概率錯，現在又選它。
    // 這種題審查可能毫無異議（它跟上次一樣被騙），所以光看不一致抓不到。
    repeatsKnownWrong(q) {
      return !!q.history_wrong && this.sameAnswer(this.current(q), q.history_answer);
    },
    needsCheck(q) { return this.isMismatch(q) || this.repeatsKnownWrong(q); },
    groupNeedsCheck(g) { return g.questions.some(q => this.needsCheck(q)); },
    visibleQuestions(g) {
      return this.filter === 'check' ? g.questions.filter(q => this.needsCheck(q)) : g.questions;
    },
    answerText(a) { return Array.isArray(a) ? a.join(',') : ''; },
    async clearAll() {
      if (!await confirmDialog({
        title: '清空目前的題目',
        message: `確定清空「${this.bank ? this.bank.label : ''}」這一場的 ${this.stats.total} 題？`
          + '題庫累積的題目與審查結果會保留，只清掉這次的上傳與作答。',
        danger: true, confirmText: '清空',
      })) return;
      this.clearing = true;
      try {
        const out = await Api.delete(`exam/banks/${this.bankId}/attempts`);
        await this.refresh();
        showToast(`已清空 ${out.attempts} 題`, 'success');
      } catch (e) { showToast(e.message, 'error', 0); }
      finally { this.clearing = false; }
    },
    async openArchive() {
      this.archiveOpen = !this.archiveOpen;
      if (!this.archiveOpen) return;
      this.archiveResult = null;
      try {
        const data = await Api.get(`exam/banks/${this.bankId}/archive`);
        this.archivePages = (data.pages || []).map(p => ({ ...p, noWrong: false }));
      } catch (e) { showToast(e.message, 'error', 0); this.archiveOpen = false; }
    },
    archiveTicked() { return this.archivePages.filter(p => p.noWrong); },
    // 沒填章節名的勾選會被 server 整頁略過，先在畫面上講，不要等送出才發現
    archiveBlocked() { return this.archiveTicked().filter(p => !String(p.section || '').trim()); },
    async doArchive() {
      const ticked = this.archiveTicked();
      const lock = ticked.reduce((n, p) => n + p.answered, 0);
      if (!await confirmDialog({
        title: '歸檔這場考試',
        message: `將把 ${ticked.length} 個章節共 ${lock} 題鎖成官方正解，信心度 100%。`
          + '這一步不可逆——鎖上之後那些題不會再被審查。確定嗎？',
        danger: true, confirmText: '歸檔',
      })) return;
      this.archiving = true;
      try {
        this.archiveResult = await Api.post(`exam/banks/${this.bankId}/archive`, {
          pages: this.archivePages.map(p => ({ page: p.page, section: p.section, noWrong: p.noWrong })),
        });
        await this.refresh();
        showToast(`已鎖定 ${this.archiveResult.locked} 題`, 'success');
      } catch (e) { showToast(e.message, 'error', 0); }
      finally { this.archiving = false; }
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
    // 判題要跑好幾分鐘，靜止的文字看起來像當掉——實測一頁 4 題約 3 分鐘，
    // 這段時間畫面上必須有東西在動，否則使用者會以為沒反應而重傳。
    isBusy(g) { return g.status === 'pending' || g.status === 'running'; },
    // 收合時也要看得出「這題不用花時間看」——判準與題庫頁的勾勾同一套
    // （審查過、沒異議、信心 ≥ 70），兩頁不會各說各話。
    isSettled(q) {
      return !!q.review_source && !this.needsCheck(q)
        && Number.isFinite(q.review_confidence) && q.review_confidence >= 70;
    },
    statusText(g) {
      if (g.status === 'pending') return '等待審題';
      if (g.status === 'running') return '審題中';
      if (g.status === 'failed') return `失敗：${g.error || '未說明'}`;
      return this.groupNeedsCheck(g)
        ? `${g.questions.filter(q => this.needsCheck(q)).length} 題需確認` : '全部沒問題';
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
        <button :class="['btn','btn-sm', archiveOpen ? 'btn-primary' : 'btn-outline']"
                :disabled="!stats.total" @click="openArchive">歸檔</button>
        <button class="btn btn-outline btn-sm" :disabled="clearing || !stats.total" @click="clearAll">
          {{ clearing ? '清空中…' : '清空' }}
        </button>
        <button class="btn btn-outline btn-sm" @click="$router.push('/exam-bank')">題庫</button>
      </div>
    </div>
    <div class="content">
      <div v-if="loading" class="ui-next-exam-empty">載入中…</div>
      <div v-else-if="!banks.length" class="ui-next-exam-empty">還沒有題庫，外部 POST 前需先指定題庫。</div>
      <template v-else>
        <div class="ui-next-exam-run-stats">
          <button @click="filter='all'" :class="['ui-next-exam-run-stat',filter==='all' && 'is-on']"><b>{{ stats.total }}</b><span>正式題數</span></button>
          <button @click="filter='check'" :class="['ui-next-exam-run-stat',stats.check && 'is-bad',filter==='check' && 'is-on']"><b>{{ stats.check }}</b><span>需確認</span></button>
          <div class="ui-next-exam-run-stat is-ok"><b>{{ stats.ok }}</b><span>沒問題</span></div>
        </div>
        <div class="ui-next-exam-run-toolbar">
          <button :class="['ui-next-exam-chip',filter==='all' && 'is-on']" @click="filter='all'">全部</button>
          <button :class="['ui-next-exam-chip',filter==='check' && 'is-on']" @click="filter='check'">只看需確認</button>
        </div>
        <div v-if="archiveOpen" class="ui-next-exam-arch">
          <div class="ui-next-exam-arch-intro">
            對著官方成績圖，把<b>沒有答錯題目</b>的章節勾起來。勾起來的章節，你答的每一題都會被當成正解永久鎖定。
            <span class="ui-next-exam-arch-warn">未作答的題不會被鎖（沒答不算對也不算錯）。</span>
          </div>
          <div class="ui-next-exam-arch-row is-head">
            <span>頁</span><span>章節名稱</span><span>題數</span><span>沒答錯</span>
          </div>
          <div v-for="p in archivePages" :key="p.page" class="ui-next-exam-arch-row">
            <span class="ui-next-exam-arch-page">P{{ p.page }}</span>
            <input class="ui-next-exam-arch-name" v-model="p.section" placeholder="例：Sales" />
            <span class="ui-next-exam-arch-n">
              {{ p.answered }}/{{ p.total }}
              <small v-if="p.answered < p.total">未答 {{ p.total - p.answered }}</small>
              <small v-if="p.locked" class="ui-next-exam-arch-locked">已鎖 {{ p.locked }}</small>
            </span>
            <label class="ui-next-exam-arch-tick"><input type="checkbox" v-model="p.noWrong" /></label>
          </div>
          <div v-if="archiveBlocked().length" class="ui-next-exam-arch-block">
            這幾頁勾了但沒填章節名，會被略過：{{ archiveBlocked().map(p => 'P' + p.page).join('、') }}
          </div>
          <div class="ui-next-exam-arch-foot">
            <span>已勾 {{ archiveTicked().length }} 個章節</span>
            <button class="btn btn-primary btn-sm" :disabled="archiving || !archiveTicked().length"
                    @click="doArchive">{{ archiving ? '歸檔中…' : '確認歸檔' }}</button>
          </div>
          <div v-if="archiveResult" class="ui-next-exam-arch-result">
            <div>鎖定 {{ archiveResult.locked }} 題，寫入 {{ archiveResult.sections }} 個章節結果。</div>
            <div v-for="s in archiveResult.skipped" :key="s" class="ui-next-exam-arch-skip">{{ s }}</div>
            <div v-for="c in archiveResult.conflicts" :key="c" class="ui-next-exam-arch-conflict">{{ c }}</div>
          </div>
        </div>
        <div v-if="err" class="ui-next-exam-run-err">{{ err }}</div>
        <details v-for="g in visibleGroups" :key="g.id" :open="!isBusy(g) && groupNeedsCheck(g)"
                 :class="['ui-next-exam-run-card',g.status==='failed' && 'is-failed']">
          <summary class="ui-next-exam-run-card-head">
            <b>P{{ g.page }}</b>
            <span><i v-if="isBusy(g)" class="spinner"></i>{{ statusText(g) }}</span>
            <time>{{ shortTime(g.created_at) }}</time>
            <!-- 中斷（重啟、逾時、模型格式跑掉）之後靠這顆救回來，不必請同事重傳。
                 .prevent 是必要的：summary 內的按鈕不擋掉預設行為會順手收合／展開。 -->
            <button class="ui-next-exam-run-retry" :disabled="isBusy(g) || retrying[g.id]"
                    @click.stop.prevent="retryPage(g)">
              {{ retrying[g.id] ? '重試中…' : '重試' }}
            </button>
          </summary>
          <template v-for="q in g.questions" :key="q.attempt_id">
            <div v-if="q.review_source==='official'" class="ui-next-exam-run-question ui-next-exam-run-official">
              <h3><span><ui-next-icon name="lock" class="ui-next-exam-run-mark is-lock"/>{{ q.no }}.</span> {{ q.question_zh || q.question_en }}</h3>
              <small>官方確認 · {{ answerText(q.review_answer) }}</small>
            </div>
            <details v-else :open="needsCheck(q)" :class="['ui-next-exam-run-question',needsCheck(q) && 'is-mismatch']">
              <summary>
                <h3>
                  <span>
                    <ui-next-icon v-if="isSettled(q)" name="check" class="ui-next-exam-run-mark is-ok"/>{{ q.no }}.
                  </span> {{ q.question_zh || q.question_en }}
                </h3>
                <div v-if="q.question_zh" class="ui-next-exam-run-en">{{ q.question_en }}</div>
              </summary>
              <div class="ui-next-exam-run-options">
                <div v-for="option in q.options" :key="option.letter" :class="['ui-next-exam-run-option',
                     isFinalSelected(q,option.letter) && 'is-selected']">
                  <label>
                    <!-- 輸入答案不另外標：worker 寫入時 answer_final 預設就等於作答答案，
                         勾選狀態本身就是它。改過之後才靠 title 查得回原本輸入什麼。 -->
                    <input type="checkbox" :title="hasAnswer(q.answer_their,option.letter) ? '正式答案（這是原本輸入的答案）' : '正式答案'" :checked="isFinalSelected(q,option.letter)" :disabled="savingFinal[q.attempt_id]" @change="toggleFinal(q,option.letter,$event.target.checked)" />
                    <b>{{ option.letter }}</b>
                    <span class="ui-next-exam-run-opt-text">
                      {{ option.text_zh || option.text }}
                      <!-- 四個訊號各一種形狀，不用讀文字就分得出來：
                           ★ 審查　讚 投票　✓/✗ 歷史（我上次的最終答案／已知大概率錯） -->
                      <span v-if="hasAnswer(q.review_answer,option.letter)" class="ui-next-exam-run-sig is-review" title="審查答案">
                        <ui-next-icon name="star-filled"/><em v-if="q.review_confidence != null">{{ q.review_confidence }}%</em>
                      </span>
                      <span v-if="topVote(q).answer===option.letter" class="ui-next-exam-run-sig is-vote" title="投票最高">
                        <ui-next-icon name="thumb-up"/><em>{{ topVote(q).pct }}%</em>
                      </span>
                      <span v-if="hasAnswer(q.history_answer,option.letter)"
                            :class="['ui-next-exam-run-sig', q.history_wrong ? 'is-past-bad' : 'is-past']"
                            :title="q.history_wrong ? '上次考試我選這個，已知大概率錯' : '上次考試我選這個'">
                        <!-- 可信的歷史答案用問號而不是勾：它只是「上次我這樣答」，
                             沒有任何官方背書，用勾勾看起來跟已確認的一樣篤定。 -->
                        <ui-next-icon v-if="q.history_wrong" name="close"/>
                        <template v-else><i>?</i><em v-if="q.review_confidence != null">{{ q.review_confidence }}%</em></template>
                      </span>
                      <!-- 英文原文：考題原文是英文，中譯只是輔助。看不到原文就沒辦法
                           確認翻譯有沒有把語意帶偏（題幹已經這樣做，選項也要一致）。 -->
                      <span v-if="option.text_zh && option.text" class="ui-next-exam-run-opt-en">{{ option.text }}</span>
                    </span>
                  </label>
                  <button v-if="!q.has_voted" class="ui-next-exam-run-vote" @click="vote(q,option.letter)">投票</button>
                </div>
              </div>
            </details>
          </template>
        </details>
        <div v-if="!visibleGroups.length" class="ui-next-exam-empty">沒有需要確認的題目。</div>
      </template>
    </div>
  `,
});
