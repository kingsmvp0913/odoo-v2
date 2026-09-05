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
      reading: false, readNote: '',
      retrying: {},
      apiOpen: false, token: null, tokenExpiresAt: null, tokenExpired: false, issuing: false,
      newOpen: false, creating: false, draft: { label: '', odoo_version: '', taken_at: '' },
    };
  },
  async created() {
    // 題庫清單與資料都在 refresh 裡抓，這裡不要再抓一次——兩處各抓一份的話，
    // 「跟到最新」的規則就有兩份實作，改了一邊另一邊會靜默走舊行為。
    await this.refresh();
    this.loading = false;
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
      // 依上傳順序由上而下（先傳的在上面）。考卷本來就是 P1、P2… 這樣走，
      // 倒著排會讓人在畫面上逆著找題號。
      // 在前端排而不是靠 API 的 ORDER BY：這樣不管後端回什麼順序都是對的。
      return this.uploads
        .map(u => ({ ...u, questions: questions.get(u.id) || [] }))
        .sort((a, b) => a.id - b.id);
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
      try {
        // 題庫清單每輪都重抓。本頁沒有選擇器，看的永遠是「最新的那一場」——
        // 但 created 只算一次，頁面開著時新建的題庫就永遠不會出現。
        // 症狀長得像 socket 壞掉：事件有到、refresh 也有跑，只是一直查同一個舊題庫。
        this.banks = await Api.get('exam/banks');
        const latest = this.banks.length ? this.banks[0].id : null;
        if (latest !== this.bankId) {
          this.bankId = latest;
          // 換場了，上一場的草稿留著會對到別場的 attempt id
          this.finalDraft = {}; this.savingFinal = {};
          this.uploads = []; this.attempts = [];
        }
      } catch (e) { this.err = e.message; }
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
    // 開一場新考試。名稱與日期都預填今天，版本沿用上一場——絕大多數情況三個欄位
    // 都不用改，直接按建立。
    openNew() {
      const today = new Date().toISOString().slice(0, 10);
      this.draft = {
        label: today,
        odoo_version: (this.bank && this.bank.odoo_version) || '19',
        taken_at: today,
      };
      this.newOpen = true;
    },
    async createBank() {
      this.creating = true;
      try {
        const b = await Api.post('exam/banks', this.draft);
        this.newOpen = false;
        // refresh 每輪跟到最新的題庫，新建的 id 最大 ⇒ 畫面自動切過去
        await this.refresh();
        showToast(`已開新考試「${b.label}」，現在可以開始傳截圖`, 'success');
      } catch (e) { showToast(e.message, 'error', 0); }
      finally { this.creating = false; }
    },
    async openApi() {
      this.apiOpen = !this.apiOpen;
      if (!this.apiOpen) return;
      try {
        const t = await Api.get('exam/upload-token');
        this.token = t.token || null;
        this.tokenExpiresAt = t.expires_at || null;
        this.tokenExpired = !!t.expired;
      } catch (e) { showToast(e.message, 'error', 0); }
    },
    async issueToken() {
      this.issuing = true;
      try {
        const t = await Api.post('exam/upload-token', {});
        this.token = t.token;
        this.tokenExpiresAt = t.expires_at;
        this.tokenExpired = false;
      } catch (e) { showToast(e.message, 'error', 0); }
      finally { this.issuing = false; }
    },
    copyToken() {
      if (!this.token) return;
      navigator.clipboard.writeText(this.token)
        .then(() => showToast('通行碼已複製', 'success'))
        .catch(() => showToast('複製失敗，請手動選取', 'error'));
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
        // wrong 用字串存：'' 是「還沒填」，'0' 是「這章沒答錯」，兩者意義完全不同。
        // 用 number 會讓空值變成 0，等於把沒填的章節全部當成全對去鎖，不可逆。
        this.archivePages = (data.pages || []).map(p => ({ ...p, wrong: '' }));
        this.readNote = '';
      } catch (e) { showToast(e.message, 'error', 0); this.archiveOpen = false; }
    },
    wrongOf(p) {
      const s = String(p.wrong ?? '').trim();
      if (!s) return null;
      const n = Number(s);
      return Number.isInteger(n) && n >= 0 ? n : null;
    },
    // 上傳官方成績單，讓 AI 把每章的錯題數讀出來填進表格。
    //
    // **只預填，不送出。** 歸檔不可逆（certain 取 OR，蓋不掉），而模型讀表格會
    // 看錯行——填完人要自己對一眼再按確認歸檔。
    async onScoreSheet(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';                       // 讓同一個檔可以再選一次
      if (!file) return;
      this.reading = true; this.readNote = '';
      try {
        const fd = new FormData();
        fd.append('screenshot', file);
        const r = await Api.postForm(`exam/banks/${this.bankId}/read-sections`, fd);
        const byPage = new Map(r.filled.map(f => [String(f.page), f.wrong]));
        this.archivePages = this.archivePages.map(p =>
          byPage.has(String(p.page)) ? { ...p, wrong: String(byPage.get(String(p.page))) } : p);
        // 對不上的一定要講。靜靜少填幾章的話，人會以為「這幾章成績單上沒有」，
        // 而真因通常是章節名沒填或拼法不同。
        const bits = [`已填 ${r.filled.length} 章`];
        if (r.unmatchedPages.length) bits.push(`對不上：${r.unmatchedPages.join('、')}`);
        if (r.unusedTitles.length) bits.push(`成績單上多出：${r.unusedTitles.join('、')}`);
        if (r.skipped && r.skipped.length) bits.push(`讀不出：${r.skipped.join('、')}`);
        this.readNote = bits.join('　·　');
        showToast(`成績單已讀出 ${r.filled.length} 章，請對一眼再送出`, 'success');
      } catch (err) { showToast(err.message, 'error', 0); }
      finally { this.reading = false; }
    },
    archiveFilled() { return this.archivePages.filter(p => this.wrongOf(p) != null); },
    // 沒填章節名的會被 server 整頁略過，先在畫面上講，不要等送出才發現
    archiveBlocked() { return this.archiveFilled().filter(p => !String(p.section || '').trim()); },
    // 填了但超過作答數的也會被略過，同樣先講
    archiveOverflow() { return this.archiveFilled().filter(p => this.wrongOf(p) > p.answered); },
    async doArchive() {
      const filled = this.archiveFilled();
      const clean = filled.filter(p => this.wrongOf(p) === 0);
      const lock = clean.reduce((n, p) => n + p.answered, 0);
      const withErr = filled.length - clean.length;
      if (!await confirmDialog({
        title: '歸檔這場考試',
        message: `${clean.length} 個章節共 ${lock} 題會被鎖成官方正解，信心度 100%——這一步不可逆。`
          + (withErr ? `另外 ${withErr} 個章節只記錄錯題數，不鎖任何題。` : '')
          + '確定嗎？',
        danger: true, confirmText: '歸檔',
      })) return;
      this.archiving = true;
      try {
        this.archiveResult = await Api.post(`exam/banks/${this.bankId}/archive`, {
          pages: this.archivePages.map(p => ({ page: p.page, section: p.section, wrong: this.wrongOf(p) })),
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
    // ── 推薦分數 ────────────────────────────────────────────────────────
    // 分數由**後端**算好，隨 dashboard 一起送過來（`option_scores`，公式與完整
    // 理由見 server/lib/exam/score.js）。前端只負責顯示。
    //
    // 為什麼不放這裡：那個公式最容易寫反（c 是「你的答案正確的機率」，不是
    // 「審查有多確定」），而寫反之後畫面照樣好好的，只是每題都推薦錯的那個選項。
    // 放在 View 檔裡就只能靠正則把函式挖出來測，等於沒有防線。
    //
    // 這裡只做顯示，不會替任何人勾選或送出答案（設計文件 §14 的硬規則）。
    scoreOf(q, letter) {
      const s = q.option_scores;
      return s && s[letter] != null ? s[letter] : null;
    },
    topScore(q) {
      const s = q.option_scores;
      if (!s) return null;
      let best = null;
      for (const k of Object.keys(s)) if (best === null || s[k] > s[best]) best = k;
      return best === null ? null : { letter: best, score: s[best] };
    },
    topText(q) { const t = this.topScore(q); return t ? t.letter : '—'; },
    // 分數哪來的——放 title 而不是畫在版面上。使用者要的是「兩個標記」，
    // 但把「你上次也選這個」這種資訊直接刪掉是損失，收進 tooltip 兩邊都顧到。
    scoreWhy(q, letter) {
      const bits = [];
      if (q.review_source === 'official') {
        bits.push(this.hasAnswer(q.review_answer, letter) ? '官方確認的正解' : '官方確認不是這個');
      } else {
        if (this.hasAnswer(q.review_answer, letter)) bits.push('審查主張這個');
        if (this.hasAnswer(this.current(q), letter)) bits.push('你這次填的');
      }
      if (this.hasAnswer(q.history_answer, letter)) {
        bits.push(q.history_wrong ? '上次選這個，已知大概率錯' : '上次也選這個');
      }
      return bits.join('・');
    },
    // 沒分數時要講得出為什麼。「—」本身沒有資訊量，使用者會以為系統壞了。
    noScoreWhy(q) {
      if (q.option_scores) return '';
      if (q.qtype === 'multi') return '複選題不算推薦分數（可以同時對兩個，機率分佈不成立）';
      if (!q.review_source) return '這題還沒審查過，沒有依據可以算';
      if (!(Array.isArray(q.review_answer) && q.review_answer.length)) return '審查沒有給出答案';
      return '這題沒有信心度，算不出分數';
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
    <!-- 外殼與按鈕都改走 ui-next 主要頁面那一套（.ui-next-page／.ui-next-page-head／
         .ui-next-head-tools）。原本是 Admin 子頁的 .topbar ＋ app.css 的 .btn btn-outline btn-sm，
         標題矮 6px、鈕小一號，跟同一個「更多工具」選單裡的架構圖／用量報表對不起來。 -->
    <section class="ui-next-page ui-next-exam-page">
      <header class="ui-next-page-head">
        <div>
          <h1>考試作戰台</h1>
          <p>外部 POST 後自動審題；這裡只看結果、投票與最後答案。</p>
        </div>
        <div class="ui-next-head-tools">
          <button @click="$router.push('/exam-bank')">題庫</button>
          <button :disabled="clearing || !stats.total" @click="clearAll">
            {{ clearing ? '清空中…' : '清空' }}
          </button>
          <button :class="apiOpen && 'ui-next-primary'" @click="openApi">串接說明</button>
          <button :class="archiveOpen && 'ui-next-primary'"
                  :disabled="!stats.total" @click="openArchive">歸檔</button>
          <button class="ui-next-primary ui-next-cta" @click="openNew">
            <ui-next-icon name="plus"/>新考試
          </button>
        </div>
      </header>
      <div v-if="newOpen" class="ui-next-task-modal-backdrop" @mousedown.self="newOpen=false">
        <section class="ui-next-task-modal ui-next-exam-new" role="dialog" aria-modal="true"
                 aria-labelledby="exam-new-title">
          <header><h2 id="exam-new-title">開一場新考試</h2></header>
          <label>名稱<input v-model="draft.label" placeholder="例：2026-10-01 秋季"></label>
          <label>Odoo 版本<input v-model="draft.odoo_version" inputmode="numeric" placeholder="19"></label>
          <label>考試日期<input v-model="draft.taken_at" type="date"></label>
          <p class="ui-next-exam-new-note">
            建立之後這一頁就會切到新的這場，接著把截圖傳進來即可。
            題庫累積的題目與答案不受影響——同一題再考到會自動接上。
          </p>
          <footer>
            <button type="button" @click="newOpen=false">取消</button>
            <button class="ui-next-primary" :disabled="creating || !draft.label.trim()"
                    @click="createBank">{{ creating ? '建立中…' : '建立' }}</button>
          </footer>
        </section>
      </div>
    <div v-if="apiOpen" class="ui-next-task-modal-backdrop" @mousedown.self="apiOpen=false">
      <section class="ui-next-task-modal ui-next-exam-api" role="dialog" aria-modal="true" aria-labelledby="exam-api-title">
        <header class="ui-next-exam-api-head">
          <div>
            <h2 id="exam-api-title">上傳串接說明</h2>
            <p>給沒有平台帳號的同事：拿一組通行碼就能傳截圖</p>
          </div>
          <button type="button" class="ui-next-exam-api-x" aria-label="關閉" @click="apiOpen=false">
            <ui-next-icon name="close"/>
          </button>
        </header>
        <div class="ui-next-exam-api-body">
          <div class="ui-next-exam-api-token">
            <div class="ui-next-exam-api-token-head">
              <b>上傳通行碼</b><span class="ui-next-exam-api-ttl">效期 3 小時</span>
              <span v-if="token && tokenExpiresAt" class="ui-next-exam-api-until">有效到 {{ shortTime(tokenExpiresAt) }}</span>
            </div>
            <div class="ui-next-exam-api-token-row">
              <code v-if="token">{{ token }}</code>
              <code v-else class="is-empty">{{ tokenExpired ? '上一組已過期' : '尚未產生' }}</code>
              <button v-if="token" class="ui-next-exam-btn" @click="copyToken">複製</button>
              <button class="ui-next-primary" :disabled="issuing" @click="issueToken">
                {{ issuing ? '產生中…' : (token ? '重產' : '產生') }}
              </button>
            </div>
            <p class="ui-next-exam-api-note">重產會讓上一組立刻失效。從本機（127.0.0.1）送的免帶。</p>
          </div>

          <div class="ui-next-exam-api-ep">
            <span class="ui-next-exam-api-verb">POST</span><code>/api/exam/submit</code>
            <em>單張，multipart，欄位直接放 form</em>
          </div>
          <div class="ui-next-exam-api-ep">
            <span class="ui-next-exam-api-verb">POST</span><code>/api/exam/batch</code>
            <em>多張，JSON，同樣的欄位放進 items[]，一次最多 50 筆</em>
          </div>

          <dl class="ui-next-exam-api-fields">
            <dt>bank</dt><dd>題庫 id 或 label<i>必填</i></dd>
            <dt>page</dt><dd>頁碼，例 10<i>必填</i></dd>
            <dt>answer</dt><dd>作答，逗號分隔，例 C,C,B<i>必填</i></dd>
            <dt>section</dt><dd>章節名，例 Project</dd>
            <dt>name</dt><dd>作答者</dd>
            <dt>screenshot</dt><dd>圖片檔（batch 改放 image，base64）<i>必填</i></dd>
          </dl>

          <p class="ui-next-exam-api-note">
            認證帶 <code>X-Token: 通行碼</code>。送出立刻回 queued，不等判題完成——結果會自己出現在本頁。
            批次裡單筆壞掉不會讓整批失敗，會具名回報在 rejected。
          </p>
        </div>
      </section>
    </div>
      <div v-if="loading" class="ui-next-exam-empty">載入中…</div>
      <div v-else-if="!banks.length" class="ui-next-exam-empty">還沒有題庫，外部 POST 前需先指定題庫。</div>
      <template v-else>
        <!-- 篩選只有這一組。原本數字卡底下還有一排「全部／只看需確認」頁籤，
             兩者改的是同一個 filter，點哪個都一樣——同一個狀態不該有兩顆開關。
             留數字卡而不是留頁籤：考試當下是瞄一眼就要讀到「還剩幾題要看」，
             頁籤沒有那個大數字。aria-pressed 讓讀螢幕的人也知道它是開關。 -->
        <div class="ui-next-exam-run-stats" role="group" aria-label="題目篩選">
          <button @click="filter='all'" :aria-pressed="filter==='all'"
                  :class="['ui-next-exam-run-stat',filter==='all' && 'is-on']"><b>{{ stats.total }}</b><span>正式題數</span></button>
          <button @click="filter='check'" :aria-pressed="filter==='check'"
                  :class="['ui-next-exam-run-stat',stats.check && 'is-bad',filter==='check' && 'is-on']"><b>{{ stats.check }}</b><span>需確認</span></button>
          <!-- 沒有「只看沒問題」這個篩選，所以這張不是按鈕，也不該長得像可以點 -->
          <div class="ui-next-exam-run-stat is-ok is-static"><b>{{ stats.ok }}</b><span>沒問題</span></div>
        </div>
        <div v-if="archiveOpen" class="ui-next-exam-arch">
          <div class="ui-next-exam-arch-intro">
            照著官方成績圖，填每一章錯幾題。
            <span class="ui-next-exam-arch-key"><b>0</b> 這章你答的每題都鎖成正解（不可逆）</span>
            <span class="ui-next-exam-arch-key"><b>1 以上</b> 只記錯幾題，不鎖</span>
            <span class="ui-next-exam-arch-key"><b>留白</b> 先不處理</span>
            <span class="ui-next-exam-arch-warn">未作答的題不會被鎖。</span>
          </div>
          <!-- 成績單本來就是一張圖，人再抄一次只是多一次出錯的機會，而抄錯會把
               錯的題永久鎖成正解。讀完只預填，人對過再按確認歸檔。 -->
          <label class="ui-next-exam-arch-read">
            <input type="file" accept="image/*" :disabled="reading" @change="onScoreSheet" />
            <span class="ui-next-exam-btn">{{ reading ? '讀取中…' : '上傳官方成績單自動填' }}</span>
            <em v-if="readNote">{{ readNote }}</em>
          </label>
          <div class="ui-next-exam-arch-row is-head">
            <span>頁</span><span>章節名稱</span><span>題數</span><span>錯幾題</span>
          </div>
          <div v-for="p in archivePages" :key="p.page" class="ui-next-exam-arch-row">
            <span class="ui-next-exam-arch-page">P{{ p.page }}</span>
            <input class="ui-next-exam-arch-name" v-model="p.section" placeholder="例：Sales" />
            <span class="ui-next-exam-arch-n">
              {{ p.answered }}/{{ p.total }}
              <small v-if="p.answered < p.total">未答 {{ p.total - p.answered }}</small>
              <small v-if="p.locked" class="ui-next-exam-arch-locked">已鎖 {{ p.locked }}</small>
            </span>
            <input class="ui-next-exam-arch-wrong" type="number" min="0" :max="p.answered"
                   v-model="p.wrong" placeholder="—" :aria-label="'P' + p.page + ' 官方說錯幾題'" />
          </div>
          <div v-if="archiveBlocked().length" class="ui-next-exam-arch-block">
            這幾頁填了錯題數但沒填章節名，會被略過：{{ archiveBlocked().map(p => 'P' + p.page).join('、') }}
          </div>
          <div v-if="archiveOverflow().length" class="ui-next-exam-arch-block">
            這幾頁的錯題數比有作答的題還多，會被略過：{{ archiveOverflow().map(p => 'P' + p.page).join('、') }}
          </div>
          <div class="ui-next-exam-arch-foot">
            <span>已填 {{ archiveFilled().length }} 個章節</span>
            <button class="ui-next-primary" :disabled="archiving || !archiveFilled().length"
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
            <!-- 建議的字母放在題號**前面**、固定寬度一欄：不展開就要看得出「這題選哪個」，
                 而且整份清單的字母要對得齊才能一路掃下來。沒建議的畫破折號，
                 空著會讓那一行的題號往左跑，看起來像另一個層級。 -->
            <!-- 最高分的字母放在題號**前面**、固定寬度一欄：不展開就要看得出「這題選哪個」，
                 而且整份清單的字母要對得齊才能一路掃下來。算不出分數的畫破折號，
                 空著會讓那一行的題號往左跑，看起來像另一個層級。 -->
            <div v-if="q.review_source==='official'" class="ui-next-exam-run-question ui-next-exam-run-official">
              <h3>
                <span class="ui-next-exam-run-sug is-sure" title="官方確認">
                  <ui-next-icon name="lock" class="ui-next-exam-run-mark"/>{{ topText(q) }}
                </span>
                <span class="ui-next-exam-run-no">{{ q.no }}.</span> {{ q.question_zh || q.question_en }}
              </h3>
              <small>官方確認</small>
            </div>
            <details v-else :open="needsCheck(q)" :class="['ui-next-exam-run-question',needsCheck(q) && 'is-mismatch']">
              <summary>
                <h3>
                  <span :class="['ui-next-exam-run-sug', topScore(q) ? 'is-rec' : 'is-none']"
                        :title="topScore(q) ? ('推薦 ' + topScore(q).score + ' 分') : noScoreWhy(q)">
                    {{ topText(q) }}<em v-if="topScore(q)">{{ topScore(q).score }}</em>
                  </span>
                  <span class="ui-next-exam-run-no">{{ q.no }}.</span> {{ q.question_zh || q.question_en }}
                </h3>
                <div v-if="q.question_zh" class="ui-next-exam-run-en">{{ q.question_en }}</div>
              </summary>
              <div class="ui-next-exam-run-options">
                <!-- 算不出分數時要講得出為什麼。只畫「—」等於沒說，使用者會以為
                     系統壞了，而不是「這題真的沒有依據可以算」。 -->
                <div v-if="noScoreWhy(q)" class="ui-next-exam-run-nosug">{{ noScoreWhy(q) }}</div>
                <div v-for="option in q.options" :key="option.letter" :class="['ui-next-exam-run-option',
                     isFinalSelected(q,option.letter) && 'is-selected',
                     scoreOf(q,option.letter) === topScore(q)?.score && 'is-suggested']">
                  <label>
                    <!-- 輸入答案不另外標：worker 寫入時 answer_final 預設就等於作答答案，
                         勾選狀態本身就是它。改過之後才靠 title 查得回原本輸入什麼。 -->
                    <input type="checkbox" :title="hasAnswer(q.answer_their,option.letter) ? '正式答案（這是原本輸入的答案）' : '正式答案'" :checked="isFinalSelected(q,option.letter)" :disabled="savingFinal[q.attempt_id]" @change="toggleFinal(q,option.letter,$event.target.checked)" />
                    <b>{{ option.letter }}</b>
                    <span class="ui-next-exam-run-opt-text">
                      <!-- 只有兩個標記：推薦分數與投票。
                           原本另外三個（★ 審查答案／? 上次我選這個／✗ 上次已知答錯）
                           全部折進分數裡了——審查與信心度就是分數的來源，已知答錯的
                           那個會被歸零。它們的原始資訊改掛 title，滑過去看得到，
                           不佔版面。 -->
                      <span v-if="scoreOf(q,option.letter) !== null"
                            :class="['ui-next-exam-run-score',
                                     scoreOf(q,option.letter) >= 50 && 'is-high',
                                     scoreOf(q,option.letter) === 0 && 'is-zero']"
                            :title="scoreWhy(q,option.letter) || '沒有證據支持，但也沒被排除過'">
                        {{ scoreOf(q,option.letter) }}
                      </span>
                      {{ option.text_zh || option.text }}
                      <span v-if="topVote(q).answer===option.letter" class="ui-next-exam-run-sig is-vote" title="投票最高">
                        <ui-next-icon name="thumb-up"/><em>{{ topVote(q).pct }}%</em>
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
    </section>
  `,
});
