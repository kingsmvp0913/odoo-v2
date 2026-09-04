  // 考試作戰台。設計文件：docs/superpowers/specs/2026-09-04-odoo-exam-platform-design.md
  //
  // 這一頁是考試「當天」用的，與題庫頁（ExamBank）的事後整理不同：上面是即時查題，
  // 下面是上傳與判題進度。順序刻意如此——考試當下每秒都在查題，上傳一天只做幾次。
  //
  // 兩條硬規則寫在這裡當提醒，因為它們看起來都像「少做了什麼」：
  //   1. 查題只顯示 100% 的答案。伺服器端就過濾掉其餘的（exam-routes.js 的 lookup），
  //      前端也不得自己補上「相似題」「上次答 B」之類的東西——讓人看到一個不確定的
  //      舊答案，就是拿它去錨定新的判斷，那正是這套系統花大力氣在防的事。
  //   2. 進度的真相在 /api/exam/jobs 與 /api/exam/uploads，socket 只是即時通道。
  //      廣播錯過了就沒了，重整一次前端記憶體就空的——所以載入時一定先拉一次現況，
  //      收到廣播也是回頭重拉，不是拿廣播內容當狀態。
  window.UiNextExamRunView = Vue.defineComponent({
    name: "UiNextExamRunView",
    data() {
      return {
        // 區塊 A：即時查題
        versions: [],
        version: localStorage.getItem('examRunVersion') || '19',
        q: '',
        looking: false,
        lookup: null,        // { confidence: 100, answer: [], source } 或 { confidence: null }
        lookupErr: '',
        // 區塊 B：上傳與判題
        banks: [],
        bankId: null,
        responder: localStorage.getItem('examRunName') || '',
        files: [],           // { name, page, answer, image, preview }
        dragging: false,
        sending: false,
        sendErr: '',
        accepted: [],
        rejected: [],
        uploads: [],
        jobs: [],
        live: [],            // socket 事件，只是「正在發生什麼」的跑馬燈
        starting: false,
        runErr: '',
        loading: true
      };
    },
    async created() {
      try {
        const [banks, versions] = await Promise.all([
          Api.get('exam/banks'),
          Api.get('exam/versions').catch(() => [])
        ]);
        this.banks = banks;
        this.versions = versions;
        if (banks.length) {
          this.bankId = banks[0].id;
          // 版本跟著題庫走：同一題在 Odoo 17 與 19 的答案可能不同，查錯版本比查不到更糟。
          if (!localStorage.getItem('examRunVersion')) this.version = banks[0].odoo_version;
          await this.refreshStatus();
        }
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    mounted() {
      // ⚠ window._socket 在 mounted 當下通常還是 undefined（initSocket 掛在 app.js 那支
      // Api.get('auth/me').then() 裡，比元件掛載晚）。直接 if (sock) 會整組靜默跳過。
      this._onProgress = (e) => {
        if (!e) return;
        this.live.unshift({ ...e, at: Date.now() });
        if (this.live.length > 30) this.live.pop();
        // 廣播不帶 bankId，所以不做過濾；反正只是觸發「回頭拉現況」，拉的是本頁選的題庫。
        this.queueRefresh();
      };
      const bind = () => {
        const sock = window._socket;
        if (!sock) return false;
        sock.on('exam-progress', this._onProgress);
        return true;
      };
      if (!bind()) {
        this._sockTimer = setInterval(() => { if (bind()) { clearInterval(this._sockTimer); this._sockTimer = null; } }, 300);
      }
      // socket 收不到也不能讓進度停在原地：有工作在跑時定期回頭問 DB。
      this._pollTimer = setInterval(() => { if (this.runningJob) this.refreshStatus(); }, 10000);
    },
    beforeUnmount() {
      if (this._sockTimer) clearInterval(this._sockTimer);
      if (this._pollTimer) clearInterval(this._pollTimer);
      if (this._lookupTimer) clearTimeout(this._lookupTimer);
      if (this._refreshTimer) clearTimeout(this._refreshTimer);
      const sock = window._socket;
      if (sock && sock.off && this._onProgress) sock.off('exam-progress', this._onProgress);
    },
    computed: {
      runningJob() { return this.jobs.find(j => j.status === 'running') || null; },
      lastJob() { return this.jobs[0] || null; },
      queueStat() {
        const s = { pending: 0, running: 0, done: 0, failed: 0 };
        for (const u of this.uploads) if (s[u.status] != null) s[u.status]++;
        return s;
      },
      failedUploads() { return this.uploads.filter(u => u.status === 'failed'); },
      canSend() { return !!this.bankId && this.files.length > 0 && !this.sending; }
    },
    watch: {
      q() { this.scheduleLookup(); },
      bankId() { this.accepted = []; this.rejected = []; this.runErr = ''; this.live = []; this.refreshStatus(); }
    },
    methods: {
      // ── 區塊 A ────────────────────────────────────────────────────────
      scheduleLookup() {
        if (this._lookupTimer) clearTimeout(this._lookupTimer);
        this._lookupTimer = setTimeout(() => this.doLookup(), 500);
      },
      setVersion(v) {
        this.version = v;
        localStorage.setItem('examRunVersion', v);
        this.doLookup();
      },
      async doLookup() {
        const q = this.q.trim();
        this.lookupErr = '';
        // 太短的片段查不到東西，只會讓畫面在打字途中一直閃「沒有確定答案」。
        if (q.length < 10) { this.lookup = null; this.looking = false; return; }
        const seq = (this._lookupSeq = (this._lookupSeq || 0) + 1);
        this.looking = true;
        try {
          const r = await Api.get(
            `exam/lookup?q=${encodeURIComponent(q)}&version=${encodeURIComponent(this.version)}`);
          if (seq !== this._lookupSeq) return;   // 打字比回應快，舊結果不得蓋掉新的
          this.lookup = r;
        } catch (e) {
          if (seq !== this._lookupSeq) return;
          this.lookup = null;
          this.lookupErr = e.message;
        } finally {
          if (seq === this._lookupSeq) this.looking = false;
        }
      },
      clearQ() { this.q = ''; this.lookup = null; this.lookupErr = ''; },

      // ── 區塊 B：選檔 ──────────────────────────────────────────────────
      onPick(ev) { this.addFiles(ev.target.files); ev.target.value = ''; },
      onDrop(ev) { this.dragging = false; this.addFiles(ev.dataTransfer && ev.dataTransfer.files); },
      async addFiles(list) {
        for (const f of Array.from(list || [])) {
          if (!/^image\//.test(f.type)) { showToast(`${f.name} 不是圖片，略過`, 'error'); continue; }
          let dataUrl;
          try { dataUrl = await this.readFile(f); }
          catch { showToast(`${f.name} 讀不到`, 'error'); continue; }
          this.files.push({
            name: f.name,
            // 檔名裡的第一組數字通常就是頁碼（screenshot 3.png）。猜錯改掉即可，
            // 但一次丟 20 張時省下逐張打字。
            page: (String(f.name).match(/\d+/) || [''])[0],
            answer: '',
            image: dataUrl,
            preview: dataUrl
          });
        }
      },
      readFile(file) {
        return new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error('讀不到檔案'));
          r.readAsDataURL(file);
        });
      },
      removeFile(i) { this.files.splice(i, 1); },

      async submit() {
        if (!this.canSend) return;
        this.sendErr = ''; this.accepted = []; this.rejected = [];
        const items = this.files.map(f => ({
          page: f.page, answer: f.answer, image: f.image, name: this.responder || undefined
        }));
        // 後端 body 上限 60mb；超過的話 express 回的是 413 而不是 JSON，訊息會變成
        // 沒頭沒尾的「HTTP 413」。在這裡先講清楚是哪個問題。
        const bytes = items.reduce((n, it) => n + (it.image ? it.image.length : 0), 0);
        if (bytes > 55 * 1024 * 1024) {
          this.sendErr = '這批圖片加起來太大（上限約 55MB），請分兩次送。';
          return;
        }
        this.sending = true;
        try {
          const r = await Api.post('exam/batch', { bank: this.bankId, items });
          this.accepted = r.accepted || [];
          this.rejected = r.rejected || [];
          // 被收下的才移出清單，被拒收的留著讓人就地改——整批重挑檔案最惹人厭。
          const badIdx = new Set(this.rejected.map(x => x.index));
          this.files = this.files.filter((_, i) => badIdx.has(i));
          if (this.accepted.length) showToast(`收下 ${this.accepted.length} 張`, 'success');
          if (this.responder) localStorage.setItem('examRunName', this.responder);
          await this.refreshStatus();
        } catch (e) {
          this.sendErr = e.message;
        } finally { this.sending = false; }
      },

      async startRun() {
        if (!this.bankId || this.starting) return;
        this.runErr = ''; this.starting = true;
        try {
          await Api.post('exam/run', { bank: this.bankId });
          showToast('已開始判題', 'success');
          await this.refreshStatus();
        } catch (e) {
          // 409 的訊息後端已經寫好「在跑什麼、多久、進度到哪」——原樣顯示，
          // 換成自己的「還在跑」等於把那份資訊丟掉。
          this.runErr = e.message;
        } finally { this.starting = false; }
      },

      // ── 現況 ─────────────────────────────────────────────────────────
      queueRefresh() {
        // 廣播一次一頁，密集時會連打；節流成最多兩秒一次。
        if (this._refreshTimer) return;
        this._refreshTimer = setTimeout(() => { this._refreshTimer = null; this.refreshStatus(); }, 2000);
      },
      async refreshStatus() {
        if (!this.bankId) return;
        try {
          const [jobs, uploads] = await Promise.all([
            Api.get(`exam/jobs?bank=${this.bankId}`),
            Api.get(`exam/uploads?bank=${this.bankId}`)
          ]);
          this.jobs = jobs; this.uploads = uploads;
        } catch (e) { showToast(e.message, 'error'); }
      },

      jobStatusText(j) {
        if (j.status === 'running') return j.phase || '處理中';
        if (j.status === 'interrupted') return '被平台重啟中斷，可重按開始判題續跑';
        if (j.status === 'failed') return j.phase || '失敗';
        return j.phase || '完成';
      },
      liveText(e) {
        if (e.progress) return `第 ${e.page} 頁：${e.progress}`;
        if (e.status === 'failed') return `第 ${e.page} 頁失敗：${e.error || ''}`;
        if (e.status === 'done' && e.page != null) return `第 ${e.page} 頁完成（${e.questions ?? '?'} 題）`;
        if (e.status === 'done') return `整批完成：成功 ${e.done ?? 0}、失敗 ${e.failed ?? 0}`;
        if (e.status === 'running') return `第 ${e.page} 頁開始`;
        return JSON.stringify(e);
      },
      shortTime(t) {
        if (!t) return '';
        const d = new Date(t);
        return isNaN(d) ? '' : d.toLocaleTimeString('zh-TW', { hour12: false });
      }
    },
    template: `
      <div class="topbar ui-next-admin-head">
        <h1>考試作戰台</h1>
        <div class="ui-next-admin-head-actions">
          <span v-if="versions.length <= 1" class="ui-next-exam-ver">Odoo {{ version }}</span>
          <select v-else v-model="version" @change="setVersion(version)" class="ui-next-exam-bank-pick">
            <option v-for="v in versions" :key="v.odoo_version" :value="v.odoo_version">
              Odoo {{ v.odoo_version }}（{{ v.n }} 題）
            </option>
          </select>
        </div>
      </div>
      <div class="content">
        <!-- ── 區塊 A：即時查題 ───────────────────────────────────────── -->
        <section class="ui-next-exam-run-lookup">
          <div class="ui-next-exam-run-head">
            <h2>查題</h2>
            <span class="ui-next-exam-run-sub">貼上題幹英文原文，停下打字就會查</span>
            <button v-if="q" class="ui-next-exam-chip" @click="clearQ">清空</button>
          </div>
          <textarea v-model="q" rows="4" class="ui-next-exam-run-q"
                    placeholder="把題目原文貼進來…"></textarea>

          <div v-if="lookupErr" class="ui-next-exam-run-err">{{ lookupErr }}</div>
          <div v-else-if="looking" class="ui-next-exam-run-idle">查詢中…</div>
          <!-- 命中：只有 100% 的題才回得到這裡（伺服器端就過濾掉其餘的）。 -->
          <div v-else-if="lookup && lookup.confidence === 100" class="ui-next-exam-run-hit">
            <div class="ui-next-exam-run-answer">{{ (lookup.answer || []).join('　') }}</div>
            <div class="ui-next-exam-run-src">🔒 官方確定 · {{ lookup.source }}</div>
          </div>
          <!-- 沒命中：只講「沒有」。不顯示任何數字、相似題或舊答案——那會錨定判斷。 -->
          <div v-else-if="lookup" class="ui-next-exam-run-miss">題庫沒有這題的確定答案</div>
          <div v-else class="ui-next-exam-run-idle">
            {{ q.trim().length ? '再多貼一點題幹…' : '等待輸入' }}
          </div>
        </section>

        <!-- ── 區塊 B：上傳與判題 ─────────────────────────────────────── -->
        <section class="ui-next-exam-run-batch">
          <div class="ui-next-exam-run-head">
            <h2>上傳與判題</h2>
            <select v-model="bankId" class="ui-next-exam-bank-pick">
              <option v-for="b in banks" :key="b.id" :value="b.id">
                {{ b.label }}（Odoo {{ b.odoo_version }}）
              </option>
            </select>
            <input v-model="responder" class="ui-next-exam-run-name" placeholder="作答者（可空）" />
          </div>

          <div v-if="loading" class="ui-next-exam-empty">載入中…</div>
          <div v-else-if="!banks.length" class="ui-next-exam-empty">還沒有任何題庫，先用 tools/exam-import.js 建一份。</div>
          <div v-else>
            <div :class="['ui-next-exam-run-drop', dragging && 'is-over']"
                 @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false"
                 @drop.prevent="onDrop">
              把截圖拖進來，或
              <label class="ui-next-exam-run-pick">
                選檔<input type="file" accept="image/*" multiple @change="onPick" hidden />
              </label>
            </div>

            <div v-for="(f, i) in files" :key="i" class="ui-next-exam-run-file">
              <img :src="f.preview" class="ui-next-exam-run-thumb" :alt="f.name" />
              <div class="ui-next-exam-run-fmeta">
                <div class="ui-next-exam-run-fname">{{ f.name }}</div>
                <div class="ui-next-exam-run-finputs">
                  <input v-model="f.page" class="ui-next-exam-run-page" placeholder="第幾頁" />
                  <input v-model="f.answer" class="ui-next-exam-run-answer-in"
                         placeholder="作答，如：第 1 題 B；第 2 題 A" />
                </div>
              </div>
              <button class="ui-next-exam-chip" @click="removeFile(i)">移除</button>
            </div>

            <div v-if="files.length" class="ui-next-exam-run-actions">
              <button class="ui-next-exam-run-send" :disabled="!canSend" @click="submit">
                {{ sending ? '上傳中…' : '送出 ' + files.length + ' 張' }}
              </button>
            </div>

            <div v-if="sendErr" class="ui-next-exam-run-err">{{ sendErr }}</div>
            <div v-if="accepted.length" class="ui-next-exam-run-ok">
              收下 {{ accepted.length }} 張：第 {{ accepted.map(a => a.page).join('、') }} 頁
            </div>
            <!-- 被拒收的一定要具名列出來。吞掉的話那幾張永遠不會被判題，而畫面上看不出少了誰。 -->
            <div v-if="rejected.length" class="ui-next-exam-run-rejected">
              <div class="ui-next-exam-run-rejected-head">{{ rejected.length }} 張沒收下：</div>
              <div v-for="r in rejected" :key="r.index" class="ui-next-exam-run-rejected-row">
                第 {{ r.index + 1 }} 張<template v-if="r.page">（第 {{ r.page }} 頁）</template>：{{ r.reason }}
              </div>
            </div>

            <!-- 現況：真相在 DB，載入與每次廣播都回頭拉一次。 -->
            <div class="ui-next-exam-run-queue">
              <div class="ui-next-exam-run-queue-head">
                <span>佇列：待處理 {{ queueStat.pending }}　處理中 {{ queueStat.running }}　完成 {{ queueStat.done }}　失敗 {{ queueStat.failed }}</span>
                <button class="ui-next-exam-run-start" :disabled="starting || !!runningJob" @click="startRun">
                  {{ runningJob ? '判題進行中' : (starting ? '啟動中…' : '開始判題') }}
                </button>
                <button class="ui-next-exam-chip" @click="refreshStatus">重新整理</button>
              </div>
              <div v-if="runErr" class="ui-next-exam-run-err">{{ runErr }}</div>

              <div v-if="lastJob" class="ui-next-exam-run-job">
                <span :class="['ui-next-exam-run-jstatus', 'is-' + lastJob.status]">{{ lastJob.status }}</span>
                <span>{{ jobStatusText(lastJob) }}</span>
                <span class="ui-next-exam-run-jprog">{{ lastJob.pages_done }}/{{ lastJob.pages_total }}</span>
                <span class="ui-next-exam-run-jtime">{{ shortTime(lastJob.updated_at || lastJob.started_at) }}</span>
              </div>

              <div v-if="failedUploads.length" class="ui-next-exam-run-rejected">
                <div class="ui-next-exam-run-rejected-head">判題失敗的頁：</div>
                <div v-for="u in failedUploads" :key="u.id" class="ui-next-exam-run-rejected-row">
                  第 {{ u.page }} 頁：{{ u.error || '（未說明）' }}
                </div>
              </div>

              <div v-if="live.length" class="ui-next-exam-run-live">
                <div v-for="(e, i) in live" :key="i" class="ui-next-exam-run-live-row">
                  <span class="ui-next-exam-run-jtime">{{ shortTime(e.at) }}</span>
                  <span>{{ liveText(e) }}</span>
                </div>
              </div>

              <div v-if="jobs.length > 1" class="ui-next-exam-run-history">
                <div class="ui-next-exam-run-rejected-head">工作歷程</div>
                <div v-for="j in jobs.slice(1)" :key="j.id" class="ui-next-exam-run-job">
                  <span :class="['ui-next-exam-run-jstatus', 'is-' + j.status]">{{ j.status }}</span>
                  <span>{{ jobStatusText(j) }}</span>
                  <span class="ui-next-exam-run-jprog">{{ j.pages_done }}/{{ j.pages_total }}</span>
                  <span class="ui-next-exam-run-jtime">{{ shortTime(j.started_at) }}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    `
  });
