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
      retrying: {}, job: null, resuming: false, pausing: false,
      apiOpen: false, token: null, tokenExpiresAt: null, tokenExpired: false, issuing: false,
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
    isAdmin() { return window.UserStore.role === 'admin'; },
    // 正式答案的勾：平台管理員與公司管理員（2026-09-24 裁決，公司管理員限自家場次）。
    // 「自家」由後端判（scope.js 的 bankOwnerForActor），前端只管要不要畫得出來——
    // 作戰台本來就只列得出自己看得到的場次，一般使用者仍然只能投票。
    canFinalize() { return this.isAdmin || window.UserStore.role === 'company_admin'; },
    userStore() { return window.UserStore; },
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
    // 判題現在到底怎麼了。分四種，因為使用者要做的事不一樣：
    //   running 等就好／stuck 要按繼續／failed 要看錯誤／null 沒事
    //
    // 「卡住」＝有頁在等但沒有工作在跑。這是重啟打斷後最常見的狀態，而畫面上
    // 原本完全看不出來——每一頁都顯示「等待審題」轉圈，跟正常排隊一模一樣。
    jobState() {
      const pending = this.uploads.filter(u => !u.is_test && u.status === 'pending').length;
      const failed = this.uploads.filter(u => !u.is_test && u.status === 'failed');
      const j = this.job;
      // 暫停要排在最前面，而且**沒有待處理的頁也要顯示**。判斷順序放後面的話，
      // 暫停中會被歸成「卡住」，畫面叫人去按「繼續判題」——而那顆按了不會動
      // （取頁那一關被旗標擋著），看起來就是系統壞了。
      // 全部跑完時也照顯示：不然取消暫停的按鈕會消失，之後傳的圖永遠不會判。
      if (this.bank && this.bank.paused) {
        return { kind: 'paused', text: pending ? `判題已暫停，${pending} 頁在等` : '判題已暫停' };
      }
      if (j && j.status === 'running') {
        return { kind: 'running', text: `${j.phase || '判題中'}　${j.pages_done}/${j.pages_total} 頁` };
      }
      if (pending) {
        return { kind: 'stuck', pending,
          text: j && j.status === 'interrupted'
            ? `上次判題被中斷（多半是平台重啟），還有 ${pending} 頁沒跑`
            : `有 ${pending} 頁在等，但目前沒有工作在跑` };
      }
      if (failed.length) {
        return { kind: 'failed', text: `${failed.length} 頁判題失敗：${failed[0].error || '未說明'}` };
      }
      return null;
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
        // 只看還沒歸檔的。歸檔＝這場考完了，畫面要空出來等下一場；原本拿最新一場，
        // 歸檔完那場還掛在畫面上，得手動按清空——而清空會刪作答紀錄，跨場推導錯題
        // （deduce.js）與章節校準都靠已歸檔場次的作答，刪了就再也推不出來。
        // 所以這裡只換畫面，資料一筆不動，題庫頁照樣看得到。
        const open = this.banks.filter(b => b.status !== 'archived');
        // 先挑自己這一邊的（is_mine，後端算的）。租戶隔離上線後，內部這支會回傳所有客戶的
        // 場次，不分的話「最新的那一場」就變成「全平台最後一個開場的客戶」——內部同事打開
        // 作戰台看到的是客戶那場，自己的完全不見，而本頁沒有切換場次的方法。
        // 退回 open[0] 是為了「自己這邊一場都沒有」時畫面不要整個空掉。
        const latest = (open.find(b => b.is_mine) || open[0] || {}).id ?? null;
        if (latest !== this.bankId) {
          this.bankId = latest;
          // 歸檔面板的頁與草稿屬於上一場，留著會拿去對新的一場
          this.archiveOpen = false; this.archivePages = [];
          // 換場了，上一場的草稿留著會對到別場的 attempt id
          this.finalDraft = {}; this.savingFinal = {};
          this.uploads = []; this.attempts = [];
          // 清空會連場次一起刪，一場都不剩時下面直接 return，舊的 bank／job 會一直掛在畫面上
          this.bank = null; this.job = null;
        }
      } catch (e) { this.err = e.message; }
      if (!this.bankId) return;
      try {
        // 判題狀態與看板一起抓（並行，不多一輪輪詢）。
        // 沒有這個，「還在跑」與「跑到一半死了」在畫面上長得一模一樣——
        // 兩者都是每一頁顯示「等待審題」轉圈，等多久都不會變。
        const [data, jobs] = await Promise.all([
          Api.get(`exam/dashboard?bank=${this.bankId}`),
          Api.get(`exam/jobs?bank=${this.bankId}`).catch(() => []),
        ]);
        this.job = (jobs || [])[0] || null;
        this.bank = data.bank; this.uploads = data.uploads || []; this.attempts = data.attempts || [];
        const next = { ...this.finalDraft };
        for (const a of this.attempts) if (!this.savingFinal[a.attempt_id]) {
          next[a.attempt_id] = Array.isArray(a.answer_final) ? [...a.answer_final] : [];
        }
        this.finalDraft = next;
      } catch (e) { this.err = e.message; }
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
    // 卡住時把佇列重新推起來。POST /api/exam/run 本來就在，只是沒有任何地方按得到。
    async resumeJob() {
      this.resuming = true;
      try {
        const r = await Api.post('exam/run', { bank: this.bankId });
        await this.refresh();
        showToast(`已重新排入判題（${r.pending} 頁）`, 'success');
      } catch (e) { showToast(e.message, 'error', 0); }
      finally { this.resuming = false; }
    },
    // 暫停／繼續。正在審的那一頁會跑完才停——中途砍掉會留下沒有判斷的孤兒作答，
    // 得整頁刪掉重來，反而更浪費。
    async togglePause() {
      const next = !(this.bank && this.bank.paused);
      this.pausing = true;
      try {
        const r = await Api.post(`exam/banks/${this.bankId}/pause`, { paused: next });
        await this.refresh();
        showToast(next
          ? (r.pending ? `已暫停，${r.pending} 頁留在佇列` : '已暫停判題')
          : '已繼續判題', 'success');
      } catch (e) { showToast(e.message, 'error', 0); }
      finally { this.pausing = false; }
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
    // 改過答案沒有：正式答案（含清成留白）跟原本輸入的不一樣。
    changedFromInput(q) {
      return Array.isArray(q.answer_their) && q.answer_their.length > 0
        && !this.sameAnswer(q.answer_final, q.answer_their);
    },
    // 改選別的之後原答案的勾就消失了，要在畫面上標回來（2026-09-14 使用者要求）
    showOriginal(q, letter) { return this.changedFromInput(q) && q.answer_their.includes(letter); },
    // 題號前那一欄＝現在勾的答案，不管改過沒有。留白就畫破折號，不退回推薦或原答案。
    finalText(q) {
      return Array.isArray(q.answer_final) && q.answer_final.length ? q.answer_final.join('') : '—';
    },
    finalWhy(q) {
      const text = this.finalText(q) === '—' ? '正式答案留白' : `正式答案 ${this.finalText(q)}`;
      return this.changedFromInput(q) ? `${text}（原答案 ${q.answer_their.join('')}）` : text;
    },
    // 審查有意見：它給的答案跟原本輸入的、或現在檯面上的不一樣。
    // 兩個都比：原本只比現在的，照審查改完這題就退出清單——但改過答案正是要回頭
    // 再看的題，使用者要它留在需確認（2026-09-14）。
    isMismatch(q) {
      return !!q.review_source && (!this.sameAnswer(q.answer_their, q.review_answer)
        || !this.sameAnswer(this.current(q), q.review_answer));
    },
    // 又踩到同一個坑：上次考試選這個、而且已經標成大概率錯，原本或現在又選它。
    // 這種題審查可能毫無異議（它跟上次一樣被騙），所以光看不一致抓不到。
    repeatsKnownWrong(q) {
      return !!q.history_wrong && (this.sameAnswer(q.answer_their, q.history_answer)
        || this.sameAnswer(this.current(q), q.history_answer));
    },
    // 官方確認的題不列入：它是鎖住、點不開的區塊，正解已經印在鎖頭旁邊，沒有東西
    // 可以確認。算進去的話數字卡多出幾題，點開卻找不到是哪幾題。
    needsCheck(q) {
      return q.review_source !== 'official' && (this.isMismatch(q) || this.repeatsKnownWrong(q));
    },
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
        // 表格上人打的章節名一起送，否則上傳時沒帶章節名的場次永遠對不上
        fd.append('sections', JSON.stringify(
          Object.fromEntries(this.archivePages.map(p => [p.page, p.section || '']))));
        const r = await Api.postForm(`exam/banks/${this.bankId}/read-sections`, fd);
        const byPage = new Map(r.filled.map(f => [String(f.page), f.wrong]));
        // 沒填章節名的場次，後端照成績單順序配好了，一起填回表格
        const named = r.sections || {};
        this.archivePages = this.archivePages.map(p => {
          const q = named[p.page] && !String(p.section || '').trim() ? { ...p, section: named[p.page] } : p;
          return byPage.has(String(p.page)) ? { ...q, wrong: String(byPage.get(String(p.page))) } : q;
        });
        // 對不上的一定要講。靜靜少填幾章的話，人會以為「這幾章成績單上沒有」，
        // 而真因通常是章節名沒填或拼法不同。
        const bits = [`已填 ${r.filled.length} 章`];
        if (r.sections) bits.push('章節名是照成績單順序填的，請對一眼');
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
    // 最高票**可能不只一個**，平手時全部都要標。
    //
    // 原本回單一字母，平手就只留字母序最前的那個——兩個人各投一票時（實測 bank 19
    // 的 attempt 657：C 與 D 各一票）畫面上只看得到 C，另一票整個消失。看起來像
    // 「投票只算我自己的」「別人投了畫面也不動」，其實票都在，只是被顯示邏輯吃掉了。
    topVotes(q) {
      if (!q.vote_total) return [];
      const order = this.voteLetters(q);
      const max = Math.max(...order.map(letter => this.voteCount(q, letter)));
      return max > 0 ? order.filter(letter => this.voteCount(q, letter) === max) : [];
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
      // 已證明答錯要講得出「怎麼證明的」。只顯示一個 0 的話跟「系統覺得不可能」
      // 分不出來，而這兩件事的可信度差很多。
      if ((q.wrong_answers || []).some(w => Array.isArray(w) && w.length === 1 && w[0] === letter)) {
        bits.push('已證明答錯（由各場考試的官方章節錯題數推出）');
      }
      if (this.hasAnswer(q.history_answer, letter)) {
        bits.push(q.history_wrong ? '上次選這個，你標過大概率錯' : '上次也選這個');
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
          <!-- 題庫管理是內部的事（規格 §1：客戶用得到考試，但不管理題庫）。不掛條件的話
               客戶看得到這顆鈕，按下去必定 403——入口存在但進不去，比沒有入口更糟。 -->
          <button v-if="userStore.isInternal" @click="$router.push('/exam-bank')">題庫</button>
          <button :disabled="clearing || !stats.total" @click="clearAll">
            {{ clearing ? '清空中…' : '清空' }}
          </button>
          <button :class="apiOpen && 'ui-next-primary'" @click="openApi">串接說明</button>
          <button class="ui-next-primary ui-next-cta" :disabled="!stats.total"
                  @click="openArchive">歸檔</button>
        </div>
      </header>
    <div v-if="apiOpen" class="ui-next-task-modal-backdrop" @mousedown.self="apiOpen=false">
      <section class="ui-next-task-modal ui-next-exam-api" role="dialog" aria-modal="true" aria-labelledby="exam-api-title">
        <header class="ui-next-exam-api-head">
          <div>
            <h2 id="exam-api-title">上傳串接說明</h2>
            <p>給沒有平台帳號的同事：拿一組通行碼就能傳截圖。不必先開考試——第一張圖進來就會自動開一場。</p>
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
            <dt>page</dt><dd>頁碼，例 10<i>必填</i></dd>
            <dt>answer</dt><dd>作答，逗號分隔，例 C,C,B<i>必填</i></dd>
            <dt>screenshot</dt><dd>圖片檔（batch 改放 image，base64）<i>必填</i></dd>
            <dt>section</dt><dd>章節名，例 Project（歸檔時要對成績單，建議填）</dd>
            <dt>bank</dt><dd>指定題庫 id 或名稱。<b>不填就自動放進進行中的那一場</b>，沒有就開一場新的</dd>
          </dl>

          <p class="ui-next-exam-api-note">
            認證帶 <code>X-Token: 通行碼</code>。送出立刻回 queued，不等判題完成——結果會自己出現在本頁。
            批次裡單筆壞掉不會讓整批失敗，會具名回報在 rejected。
          </p>
        </div>
      </section>
    </div>
      <div v-if="loading" class="ui-next-exam-empty">載入中…</div>
      <div v-else-if="!bankId" class="ui-next-exam-empty">
        目前沒有進行中的考試，外部 POST 第一頁就會自動開一場。
        <!-- 歸檔完畫面就清空了，略過／矛盾的訊息不能跟著消失——那是「成績單哪一格抄錯」的唯一線索 -->
        <div v-if="archiveResult" class="ui-next-exam-arch-result">
          <div>上一場已歸檔：鎖定 {{ archiveResult.locked }} 題，寫入 {{ archiveResult.sections }} 個章節結果。</div>
          <div v-for="s in archiveResult.skipped" :key="s" class="ui-next-exam-arch-skip">{{ s }}</div>
          <div v-for="c in archiveResult.conflicts" :key="c" class="ui-next-exam-arch-conflict">{{ c }}</div>
        </div>
      </div>
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
        <div v-if="jobState" :class="['ui-next-exam-job','is-'+jobState.kind]">
          <i v-if="jobState.kind==='running'" class="spinner"></i>
          <span>{{ jobState.text }}</span>
          <button v-if="jobState.kind==='stuck'" class="ui-next-exam-btn"
                  :disabled="resuming" @click="resumeJob">
            {{ resuming ? '啟動中…' : '繼續判題' }}
          </button>
          <!-- 暫停是整場的開關，所以放在這條狀態列而不是每一頁旁邊：
               一頁一頁按會漏掉還沒傳上來的那些。 -->
          <button class="ui-next-exam-btn" :disabled="pausing" @click="togglePause">
            {{ pausing ? '處理中…' : (jobState.kind==='paused' ? '恢復判題' : '暫停判題') }}
          </button>
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
            <!-- 勾選的答案放在題號**前面**、固定寬度一欄：不展開就要看得出「這題選哪個」，
                 而且整份清單的字母要對得齊才能一路掃下來。留白的畫破折號，
                 空著會讓那一行的題號往左跑，看起來像另一個層級。
                 原本放推薦分數最高的字母，改成勾選的答案（2026-09-14 使用者拍板）：
                 勾了 A 前面卻寫 B，看起來像沒勾到。推薦改看選項上的分數與 title。 -->
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
                  <span :class="['ui-next-exam-run-sug', finalText(q) === '—' ? 'is-none' : 'is-rec']"
                        :title="finalWhy(q) + (topScore(q) ? '・推薦 ' + topScore(q).letter + '（' + topScore(q).score + ' 分）' : '')">{{ finalText(q) }}</span>
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
                    <!-- 沒改過時勾選狀態本身就是原答案（answer_final 預設等於作答答案）；
                         改過之後選項文字後面會掛「原答案」標記。 -->
                    <input type="checkbox" :title="(canFinalize ? '' : '只有管理員能改，請用投票・') + (hasAnswer(q.answer_their,option.letter) ? '正式答案（這是原本輸入的答案）' : '正式答案')" :checked="isFinalSelected(q,option.letter)" :disabled="!canFinalize || savingFinal[q.attempt_id]" @change="toggleFinal(q,option.letter,$event.target.checked)" />
                    <b>{{ option.letter }}</b>
                    <span class="ui-next-exam-run-opt-text">
                      <!-- 只有兩個標記：推薦分數與投票。
                           原本另外三個（★ 審查答案／? 上次我選這個／✗ 上次已知答錯）
                           全部折進分數裡了——審查與信心度就是分數的來源，已知答錯的
                           那個會被歸零。它們的原始資訊改掛 title，滑過去看得到，
                           不佔版面。 -->
                      {{ option.text_zh || option.text }}
                      <!-- 沒改過不標（勾選狀態本身就是原答案）；改選別的或清成留白之後才標 -->
                      <span v-if="showOriginal(q,option.letter)" class="ui-next-exam-run-sig is-orig">原答案</span>
                      <!-- 分數排在選項文字**後面**、投票前面（2026-09-07 使用者要求）。
                           擺前面時它會把每一行的文字往右推一格，四個選項讀起來像有縮排；
                           而分數與投票是同一類東西（都是「哪個選項比較可能」的訊號），
                           擺在一起才掃得出來。 -->
                      <span v-if="scoreOf(q,option.letter) !== null"
                            :class="['ui-next-exam-run-score',
                                     scoreOf(q,option.letter) >= 50 && 'is-high',
                                     scoreOf(q,option.letter) === 0 && 'is-zero']"
                            :title="scoreWhy(q,option.letter) || '沒有證據支持，但也沒被排除過'">
                        {{ scoreOf(q,option.letter) }}
                      </span>
                      <span v-if="topVotes(q).includes(option.letter)" class="ui-next-exam-run-sig is-vote"
                            :title="topVotes(q).length > 1 ? '投票最高（平手）' : '投票最高'">
                        <ui-next-icon name="thumb-up"/><em>{{ votePct(q,option.letter) }}%</em>
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
