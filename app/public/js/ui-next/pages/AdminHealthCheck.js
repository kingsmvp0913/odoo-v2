  window.UiNextAdminHealthCheckView = Vue.defineComponent({
    name: "UiNextAdminHealthCheckView",
    data() {
      return { runId: null, run: null, findings: [], proposals: [], history: [], schedule: null, running: false, cadence: 'daily', sinceDays: null, savingId: null, noteDraft: {}, statuses: HC_STATUS, fixes: {}, fixBusy: null, diffOpen: {}, bodyOpen: {}, _timer: null, _fixTimer: null };
    },
    async mounted() { await this.loadProposals(); await this.loadHistory(); await this.openFromQuery(); },
    unmounted() { if (this._timer) clearInterval(this._timer); if (this._fixTimer) clearInterval(this._fixTimer); },
    computed: {
      // 排程是每週自動跑（cron 每分鐘一 tick），所以顯示的是「最早會被執行的時刻」
      nextRunText() {
        const s = this.schedule;
        if (!s) return '';
        if (!s.enabled) return '已停用';
        if (s.running) return '本輪執行中';
        if (s.due) return '即將執行';
        return new Date(s.nextRunAt).toLocaleString();
      },
      // 已核准的提案什麼時候會被自動實作，一律引用排程 API 的真值。寫死「22:00」的話，同一畫面
      // 上方的「下次自動健檢」讀的是真值，兩個數字對不起來就是在說謊；而且下次改排程還會再漂一次。
      // 只回時間片語，動詞留在模板——拿不到排程資訊就回 null，寧可不講時間也不要講錯的時間。
      // 最新一輪。失敗橫幅要吃它而不是 run——run 只有點進某一輪才有值，而「健檢掛了」這件事
      // 必須一進頁面就看得到（掛掉時零提案，整頁跟「今天本來就沒事」長得一樣）。
      latestRun() { return this.history && this.history.length ? this.history[0] : null; },
      autoRunText() {
        const s = this.schedule;
        if (!s || !s.enabled) return null;
        if (s.running) return '本輪';
        if (s.due) return '即將';
        return new Date(s.nextRunAt).toLocaleString();
      }
    },
    methods: {
      async loadHistory() {
        try { this.history = await Api.get('admin/health-check'); }
        catch (e) { showToast(e.message, 'error'); }
        // 排程資訊失敗不擋歷史清單：它只是附註，沒有它整頁照樣可用
        try { this.schedule = await Api.get('admin/health-check-schedule'); }
        catch (e) { this.schedule = null; }
      },
      async start() {
        this.running = true; this.findings = []; this.run = null;
        try {
          // 不帶 sinceDays＝用預設的增量視窗（上一輪之後）；填了才是「回頭重掃這麼多天」。
          // 大健檢走 cadence：它不只是換個天數，30 天那份還會多帶一份上一期資料做趨勢比對，
          // 所以手動填 sinceDays=30 與選「30 天大健檢」是兩件不同的事。
          const body = this.cadence === 'daily'
            ? (this.sinceDays ? { sinceDays: this.sinceDays } : {})
            : { cadence: this.cadence };
          const { runId } = await Api.post('admin/health-check', body);
          this.runId = runId;
          this._timer = setInterval(() => this.poll(), 3000);
          await this.poll();
        } catch (e) { showToast(e.message, 'error'); this.running = false; }
      },
      async poll() {
        try {
          const { run, findings } = await Api.get('admin/health-check/' + this.runId);
          this.run = run; this.findings = findings;
          if (run.status !== 'running') {
            clearInterval(this._timer); this._timer = null; this.running = false;
            await this.loadHistory();
            // 這一輪產出的新提案要進主清單。只重載 findings 的話，跑完健檢畫面上的提案數不會動
            // ——新的那幾條要重整頁面才看得到，看起來像健檢什麼都沒做出來。
            await this.loadProposals();
          }
        } catch (e) { /* 單次輪詢失敗保留上批，下次恢復 */ }
      },
      async openRun(id) { this.runId = id; await this.poll(); await this.loadFixes(); },
      // 由任務詳情頁的「健檢這張任務」導過來（?run=N）：那支 run 已經在背景跑了，這裡直接盯著它，
      // 不必也不能再按一次「開始健檢」——按下去建的是另一支全平台健檢。
      async openFromQuery() {
        const id = parseInt(this.$route.query.run, 10);
        if (!id) return;
        this.runId = id;
        this.running = true;
        await this.poll();
        if (this.running) this._timer = setInterval(() => this.poll(), 3000);
      },
      scopeText(r) { return r && r.task_db_id ? ('任務 ' + (r.task_id || r.task_db_id)) : '全平台'; },
      layer(l) { return HC_LAYER[l] || null; },
      kindOf(f) { return f.kind || 'agent'; },
      // health-auditor 產出的 diagnosis 第一行就是標題本身（agent_label 取自同一句），照原樣印
      // 會讓每張卡的標題出現兩次。只在「首行與標題完全相同」時去掉，其餘一律原樣保留——
      // 用猜的（例如砍掉所有首行）會把真正的內文吃掉。
      bodyOf(f) {
        const d = String(f.diagnosis || '');
        const nl = d.indexOf('\n');
        const first = (nl === -1 ? d : d.slice(0, nl)).trim();
        if (first && first === String(f.agent_label || '').trim()) return d.slice(nl + 1).replace(/^\s+/, '');
        return d;
      },
      // health-auditor 的診斷動輒好幾百字（要寫出根因、證據、指標基線），一張卡就佔滿整個
      // 畫面，七條提案要捲很久才看得完「有哪些提案」。長的先切短、要看再點開。
      // 門檻用字數而非行數：短行很多的內文（條列）跟一整段長文一樣佔版面。
      isLongBody(f) { return this.bodyOf(f).length > 180; },
      bodyClamped(f) { return this.isLongBody(f) && !this.bodyOpen[f.id]; },
      // 提案的來源。agent_name 在這張表同時承載「哪一關」與「哪一種非 per-agent 的診斷」：
      // 'feedback' 是 nightly-fix 的 materializeGroup 寫的（使用者意見統整後落地），
      // '__task__' 是單張任務健檢，其餘（含 '__audit__'）都是平台健檢自己挖出來的。
      sourceText(f) {
        if (f.agent_name === 'feedback') return '意見回饋';
        if (f.agent_name === '__task__') return '任務健檢';
        return '平台健檢';
      },
      ofKind(k) { return this.findings.filter(f => this.kindOf(f) === k); },
      statusLabel(v) { return (HC_STATUS.find(s => s.value === v) || {}).label || v; },
      // 夜間批次退場（連續失敗／no_change／layer 不可自動修，都是同一個前綴）：
      // status='pending' 且 verdict_note 帶機器標記前綴（見 nightly-fix.js 的 MACHINE_RETIRE_PREFIX）。
      // 人工核准會寫 decided_by/decided_at，retireToHuman 一律清成 NULL，所以再加這個條件是免費的
      // 精準化：真機器退場恆成立、人的裁決恆不成立，能擋掉「管理員按『待處理』但沒清空輸入框，
      // 導致人工裁決的 note 沿用了機器寫的字串」那種情況。
      isMachineRetired(f) {
        return f.status === 'pending' && !f.decided_at
          && typeof f.verdict_note === 'string' && f.verdict_note.startsWith('自動退場：');
      },
      // 裁決：狀態一律連同備註一起送，備註是下一輪健檢會讀到的東西（「為什麼判不須調整」）。
      async setStatus(f, status) {
        this.savingId = f.id;
        try {
          const r = await Api.patch('admin/health-check/findings/' + f.id, {
            status, verdict_note: this.noteDraft[f.id] !== undefined ? this.noteDraft[f.id] : f.verdict_note
          });
          Object.assign(f, r);
          showToast('已記錄：' + this.statusLabel(status), 'success');
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.savingId = null; }
      },
      fixState(id) { return this.fixes[id] || null; },
      fixLabel(st) { return HC_FIX[st] || { label: st, color: 'var(--text-muted)' }; },
      // 測試結果不能全部一個灰色：紅燈跟「沒跑起來」都得跳出來，否則跟一堆灰字擠在同一行等於沒寫
      testTone(tr) {
        if (/^fail/.test(tr || '')) return 'var(--error)';
        if (/^unknown/.test(tr || '')) return 'var(--warning, #d97706)';
        return 'var(--text-muted)';
      },
      // 提案清單是這一頁的主體，跨輪撈。⚠ 不能用某一輪的 findings 當來源：最後一輪剛好失敗
      // （零 finding）整頁就會顯示「待處理 0 條」，而 DB 裡其實還有待辦——實測 run#19 就是這樣。
      async loadProposals() {
        try { this.proposals = await Api.get('admin/proposals'); }
        catch (e) { showToast(e.message, 'error'); }
        await this.loadFixes();
      },
      // 每次載入就把提案既有的修正狀態撈回來——不撈的話重新整理後看起來像沒修過，
      // 會有人再按一次而在同一條上開第二個工作區。
      async loadFixes() {
        for (const f of this.proposals) {
          try {
            const fx = await Api.get('admin/health-check/findings/' + f.id + '/fix');
            if (fx) this.fixes[f.id] = fx;
          } catch (e) { /* 單條失敗不擋整頁 */ }
        }
        this.watchRunningFixes();
      },
      watchRunningFixes() {
        const anyRunning = Object.values(this.fixes).some(x => x && x.status === 'running');
        if (anyRunning && !this._fixTimer) this._fixTimer = setInterval(() => this.loadFixes(), 4000);
        if (!anyRunning && this._fixTimer) { clearInterval(this._fixTimer); this._fixTimer = null; }
      },
      async startFix(f) {
        this.fixBusy = f.id;
        try {
          await Api.post('admin/health-check/findings/' + f.id + '/fix', {});
          await this.loadFixes();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.fixBusy = null; }
      },
      async fixAction(f, action) {
        const fx = this.fixes[f.id];
        if (!fx) return;
        this.fixBusy = f.id;
        try {
          const r = await Api.post('admin/fixes/' + fx.id + '/' + action, {});
          if (action === 'apply') {
            // 擋下時碼已經進主分支了，只差重啟——訊息要說清楚，否則人會以為整件事沒發生而重按
            showToast(r.restarted
              ? '已合併並推送，平台重啟中（約 30 秒後重新整理）'
              : ('已合併並推送，但還有 ' + r.inflight.length + ' 張任務在跑，暫不重啟：'
                 + r.inflight.map(function (t) { return '#' + t.taskId; }).join('、')),
              r.restarted ? 'success' : 'warning');
          } else {
            showToast(action === 'adopt' ? ('已提交到分支 ' + (r.branch || '')) : action === 'push' ? ('已推上 ' + (r.branch || '')) : '已捨棄', 'success');
          }
          await this.loadFixes();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.fixBusy = null; }
      },
      sev(s) { return HC_SEV[s] || HC_SEV.error; },
      // 歷史列的嚴重度＝本輪最嚴重的那一條（後端算的 severity_rank）。健檢自己失敗優先蓋過一切：
      // 那一輪的「最嚴重只有 low」是假的，它根本沒檢查完。
      histSev(h) {
        // 收掉「狀態」欄之後，這裡是畫面上唯一分辨得出「這一輪根本沒跑完」的地方。
        // 不特判的話 run#19（status='error'、零 finding）會顯示成「—」，跟「今天本來就沒事」
        // 長得一模一樣——正是這個 repo 踩過的靜默失敗。
        if (h.status === 'error') return HC_SEV.error;
        if (h.error_count > 0) return HC_SEV.error;
        if (h.severity_rank === null || h.severity_rank === undefined) return null;
        return HC_SEV[SEV_BY_RANK[Number(h.severity_rank) + 1]] || null;
      },
      // 處理狀態只看 medium 以上的待處理提案（後端的 open_count 已濾過）：輕微的放著不管是允許的，
      // 把它算進待辦會讓每一輪都掛著紅字，真正該處理的反而看不見。
      histTodo(h) {
        if (!h.proposal_count) return null;
        return h.open_count > 0
          ? { label: '待處理 ' + h.open_count, color: 'var(--warning-strong)' }
          : { label: '已處理完', color: 'var(--text-muted)' };
      },
      cadenceText(h) { return HC_CADENCE[h.cadence] || ''; },
      applyToEditor(f) {
        if (!f.suggested_prompt) return;
        // 帶入既有 agent 編輯器：以 sessionStorage 暫存建議 prompt，導到 /admin/agents 由該頁預填
        sessionStorage.setItem('agentPrefill', JSON.stringify({ name: f.agent_name, prompt: f.suggested_prompt }));
        this.$router.push('/admin/agents?prefill=' + encodeURIComponent(f.agent_name));
      }
    },
    template: `
      <div class="topbar ui-next-admin-head">
        <h1>健檢紀錄</h1>
        <div class="ui-next-admin-head-actions"><button class="btn btn-outline btn-sm" @click="$router.push('/admin')">← 返回</button></div>
      </div>
      <div class="content">
        <div class="hc-page">
          <!-- 這一頁的用途是「管理提案」。健檢只是提案的其中一個來源（另一個是使用者意見回饋），
               它的操作與紀錄一律收到頁尾的摺疊區——攤在最上面會讓「這頁要我做什麼」變成
               「這頁在跑什麼」。唯一留在上面的是「上一輪成功了沒」，理由見下一段。 -->
          <div class="settings-section hc-window-row" style="font-size:var(--fs-sm);color:var(--text-muted)">
            <span>待處理 {{ proposals.filter(f => f.status === 'pending').length }} 條
                  已核准 {{ proposals.filter(f => f.status === 'approved').length }} 條
                  <span v-if="!proposals.length">（目前沒有提案）</span></span>
            <span v-if="nextRunText" style="margin-left:auto">下次自動產生：{{ nextRunText }}</span>
          </div>

          <div v-if="proposals.some(f => f.status === 'approved')" class="settings-section"
            style="border-left:3px solid var(--warning-strong);margin-bottom:var(--space-3);font-size:var(--fs-sm);color:var(--text)">
            <!-- 3-I4：runAudit(...).finally(() => runNightlyFix(...))——健檢一寫完 approved 提案，
                 下一步就是批次，中間只隔一個 waitForDrain，沒有在飛任務時是 0 秒銜接。「要在那之前
                 按下擋下」暗示有一段可操作的等待窗，但那個「之前」不存在：批次是接在同一輪健檢
                 後面自動起跑的，不是等到隔天固定時刻。文案只能誠實說「隨時可能已經在執行」，
                 不能承諾「還來得及」。⚠ 不改行為——「預設核准」是已拍板的產品裁決。 -->
            ⏱ 已核准的提案<strong>沒有人會先看過</strong>，健檢一跑完就會緊接著自動實作並合併，沒有事後可攔截的等待期。不想讓某一條跑，請立刻按「擋下這條」。
          </div>

          <!-- 健檢自己掛掉的話，它一筆提案都不會產生——畫面上跟「今晚本來就沒事做」長得一模一樣
               （此 repo 踩過：夜班空轉 98 輪無人察覺）。這一頁收斂成只看提案之後，這是唯一分辨得
               出來的地方，所以要顯著、要帶原因（health_check_runs.error）。 -->
          <div v-if="latestRun && latestRun.status === 'error'" class="error-msg" style="margin-bottom:var(--space-3)">
            ⚠ 上一輪健檢失敗（{{ new Date(latestRun.created_at).toLocaleString() }}），沒有產生任何提案。<span v-if="latestRun.error">原因：{{ latestRun.error }}</span>
            <span v-else>（沒有記到原因——這輪是舊版留下的，新版失敗都會寫原因）</span>
          </div>

          <div v-for="f in ofKind('note')" :key="f.id" class="error-msg" style="margin-bottom:var(--space-3)">{{ f.diagnosis }}</div>

          <div v-for="f in proposals" :key="f.id"
            style="border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);margin-bottom:var(--space-3);background:var(--surface)">
            <div class="hc-finding-title-row">
              <span style="font-weight:var(--fw-semibold)">{{ f.agent_label }}</span>
              <!-- 來源：兩條路都落在同一張表、同一份清單裡（健檢的 health-auditor／單張任務健檢，
                   與使用者意見經 nightly-fix 的 materializeGroup 寫進來的 'feedback'）。不標的話
                   「這是誰要求的」在畫面上完全消失，而那正是判斷要不要放行時最先想問的事。 -->
              <span class="pill" :class="f.agent_name === 'feedback' ? 'pill-info' : ''"
                style="font-size:var(--fs-xs)">{{ sourceText(f) }}</span>
              <span v-if="layer(f.layer)" :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:layer(f.layer).color}">
                {{ layer(f.layer).label }}
              </span>
              <span :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:sev(f.severity).color}">
                {{ sev(f.severity).label }}
              </span>
              <span v-if="f.status === 'approved'" style="font-size:var(--fs-xs);padding:1px var(--space-2);border-radius:4px;color:#fff;background:var(--warning-strong)" title="沒有人會先審——排程一到就自動實作並合併">
                ⏱ <span v-if="autoRunText">{{ autoRunText }} </span>自動執行
              </span>
            </div>
            <div class="hc-body" :class="{ 'hc-body-clamp': bodyClamped(f) }"
              style="font-size:var(--fs-base);color:var(--text);margin-bottom:6px">{{ bodyOf(f) }}</div>
            <button v-if="isLongBody(f)" class="btn btn-ghost btn-sm" style="margin-bottom:6px"
              @click="bodyOpen[f.id] = !bodyOpen[f.id]">{{ bodyOpen[f.id] ? '▾ 收合說明' : '▸ 看完整說明' }}</button>
            <!-- 證據／建議做法／指標一律跟著主文收合：它們同樣是長文，展開時單獨留著等於沒收 -->
            <template v-if="!bodyClamped(f)">
              <div v-if="f.evidence" class="hc-body" style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:4px">證據：{{ f.evidence }}</div>
              <div v-if="f.rationale" class="hc-body" style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:4px">建議做法：{{ f.rationale }}</div>
              <div v-if="f.target_metric" class="hc-body" style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:6px">
                要動的指標：{{ f.target_metric }}（現值 {{ f.metric_baseline }}）
              </div>
            </template>
            <button v-if="f.suggested_prompt" class="btn btn-outline btn-sm" style="margin-bottom:6px" @click="applyToEditor(f)">帶入編輯器 →</button>

            <div class="hc-window-row" style="margin-top:6px">
              <span style="font-size:var(--fs-sm);color:var(--text-muted)">處置：</span>
              <button v-if="f.status !== 'no_change' && f.status !== 'done'" class="btn btn-danger btn-sm"
                :disabled="savingId === f.id" @click="setStatus(f, 'no_change')"
                title="預設核准後會在今晚自動執行；按這顆才會擋下，不會被排進去">🛑 擋下這條</button>
              <button v-if="f.status !== 'done'" class="btn btn-outline btn-sm" :disabled="fixBusy === f.id || (fixState(f.id) && ['running','ready','adopted'].includes(fixState(f.id).status))"
                @click="startFix(f)" title="在獨立工作區改碼並自己跑測試，改完給你看 diff，你點頭才提交">🔧 修這條</button>
              <button v-for="s in statuses" :key="s.value" class="btn btn-sm"
                :class="f.status === s.value ? 'btn-primary' : 'btn-outline'"
                :disabled="savingId === f.id" @click="setStatus(f, s.value)">{{ s.label }}</button>
              <input class="form-control" style="flex:1;min-width:180px" placeholder="裁決理由（下一輪健檢會讀到）"
                :value="noteDraft[f.id] !== undefined ? noteDraft[f.id] : (f.verdict_note || '')"
                @input="noteDraft[f.id] = $event.target.value" />
            </div>
            <div v-if="isMachineRetired(f)" class="pill pill-warn" style="margin-top:4px"
              title="夜間批次自動退場——不是有人核准後又改回待處理，原因見下方裁決理由">
              🤖 夜間批次自動退場
            </div>
            <div v-if="f.decided_at" style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:4px">
              已裁決 {{ new Date(f.decided_at).toLocaleString() }}<span v-if="f.applied_at">，套用於 {{ new Date(f.applied_at).toLocaleDateString() }}</span>
            </div>

            <div v-if="fixState(f.id)" style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
              <div class="hc-finding-title-row">
                <span style="font-size:var(--fs-sm);font-weight:var(--fw-semibold)">修正</span>
                <span :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:fixLabel(fixState(f.id).status).color}">
                  {{ fixLabel(fixState(f.id).status).label }}
                </span>
                <span v-if="fixState(f.id).test_result" :style="{fontSize:'var(--fs-xs)',color:testTone(fixState(f.id).test_result)}">測試：{{ fixState(f.id).test_result }}</span>
                <span v-if="fixState(f.id).branch" style="font-size:var(--fs-xs);color:var(--text-muted);font-family:monospace">{{ fixState(f.id).branch }}</span>
              </div>
              <div v-if="fixState(f.id).reject_reason" class="error-msg hc-body" style="margin:6px 0">{{ fixState(f.id).reject_reason }}</div>
              <div v-if="fixState(f.id).notes" class="hc-body" style="font-size:var(--fs-sm);color:var(--text);margin-bottom:6px">{{ fixState(f.id).notes }}</div>
              <!-- review_notes：fix-review 對這份修正的審核推理，approve／reject 兩條路徑都會寫（單元 2）。
                   這是無人監督閘門唯一的人類稽核材料——一份修正被自動合併進 master 或被 reject 兩次退場，
                   事後就靠這段字知道「它為什麼這樣判」，所以獨立一段顯示，不與上面的 notes（提案本身的說明）混在一起。 -->
              <div v-if="fixState(f.id).review_notes" class="hc-body" style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:6px;border-left:2px solid var(--border);padding-left:6px">
                審核意見：{{ fixState(f.id).review_notes }}
              </div>
              <div v-if="fixState(f.id).diff">
                <button class="btn btn-ghost btn-sm" @click="diffOpen[f.id] = !diffOpen[f.id]">
                  {{ diffOpen[f.id] ? '▾ 收合改動' : '▸ 看改了什麼' }}
                </button>
                <pre v-if="diffOpen[f.id]" style="max-height:360px;overflow:auto;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-2);font-size:var(--fs-xs)">{{ fixState(f.id).diff }}</pre>
              </div>
              <!-- 標成「處理完成」之後就不再給動作，只留紀錄（狀態、測試結果、diff）。狀態按鈕不藏，
                   才回得去。真的還差重啟時提案不會是 done（見 applyFix），所以那顆按鈕不會被藏掉。 -->
              <div v-if="f.status !== 'done'" class="hc-window-row" style="margin-top:6px">
                <button v-if="fixState(f.id).status === 'ready'" class="btn btn-primary btn-sm"
                  :disabled="fixBusy === f.id" @click="fixAction(f, 'adopt')">採用（提交到分支）</button>
                <button v-if="fixState(f.id).status === 'adopted'" class="btn btn-primary btn-sm"
                  :disabled="fixBusy === f.id" @click="fixAction(f, 'push')">推上 GitHub</button>
                <button v-if="['adopted','pushed','merged'].includes(fixState(f.id).status)" class="btn btn-primary btn-sm"
                  :disabled="fixBusy === f.id" @click="fixAction(f, 'apply')">
                  {{ fixState(f.id).status === 'merged' ? '重啟平台（碼已合併）' : '合併並套用（會重啟平台）' }}</button>
                <button v-if="['ready','adopted'].includes(fixState(f.id).status)" class="btn btn-outline btn-sm"
                  :disabled="fixBusy === f.id" @click="fixAction(f, 'discard')">捨棄</button>
              </div>
            </div>
          </div>

          <!-- 提案以外的輸出收進摺疊區。這一頁的用途已收斂成「管理提案」——提案才有決定要做
               （核准／擋下／修這條），總結與候選訊號是唯讀的背景資料，攤平在同一頁會把 7 筆
               要決定的東西埋在 90 幾筆不用決定的東西裡。收起來而不是刪掉：signal 是刻意保留的
               「證據還不夠」收納桶，砍掉等於承諾了一個不存在的去處。
               kind='agent'（逐關診斷）的區塊已整段移除——那條路徑（runHealthCheck）已退役，
               最後一次實際執行是 2026-08-20，舊資料留在 DB 但不再顯示。 -->
          <details v-if="ofKind('summary').length || ofKind('signal').length" class="settings-section">
            <summary style="cursor:pointer;font-size:var(--fs-sm);color:var(--text-muted)">
              本輪其他輸出（總結 {{ ofKind('summary').length }}、候選訊號 {{ ofKind('signal').length }}）
            </summary>
            <div v-for="f in ofKind('summary')" :key="f.id" style="margin-top:var(--space-3)">
              <div class="hc-finding-title-row">
                <span style="font-weight:var(--fw-semibold)">本輪總結</span>
                <span :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:sev(f.severity).color}">
                  {{ sev(f.severity).label }}
                </span>
              </div>
              <div class="hc-body" style="font-size:var(--fs-sm);color:var(--text)">{{ f.diagnosis }}</div>
            </div>
            <div v-for="f in ofKind('signal')" :key="f.id" class="hc-body" style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:6px">
              ・{{ f.diagnosis }}<span v-if="f.evidence">（{{ f.evidence }}）</span>
            </div>
          </details>

          <!-- 健檢的操作與紀錄。健檢是提案的來源之一，不是這一頁的主題，所以整組收在最後、預設關起來。
               ⚠ 唯一不收的是「上一輪失敗了」那則橫幅（在頁首）：健檢掛掉時它一筆提案都不會產生，
               整頁看起來就像「今天本來就沒事」，那是這個 repo 踩過的靜默失敗（夜班空轉 98 輪）。 -->
          <details class="settings-section">
            <summary style="cursor:pointer">
              <span class="section-title" style="display:inline">健檢執行</span>
              <span style="font-size:var(--fs-sm);color:var(--text-muted)">
                　手動跑一次、看歷史紀錄<span v-if="nextRunText">（下次自動：{{ nextRunText }}）</span>
              </span>
            </summary>

            <div class="hc-window-row" style="margin:var(--space-3) 0">
              <label style="font-size:var(--fs-base)" title="增量＝只看上一輪健檢之後的新資料。大健檢固定回看 7／30 天，30 天那份還會多帶上一期資料做趨勢比對。">
                節奏
                <select v-model="cadence" class="form-control" style="width:auto">
                  <option value="daily">增量</option>
                  <option value="weekly">7 天大健檢</option>
                  <option value="monthly">30 天大健檢（含趨勢比對）</option>
                </select>
              </label>
              <label v-if="cadence === 'daily'" style="font-size:var(--fs-base)" title="留空＝只看上一輪健檢之後的新資料（預設）。填數字＝回頭重掃這麼多天。">
                回溯
                <input type="number" v-model.number="sinceDays" min="1" placeholder="增量" style="width:72px" class="form-control" /> 天
              </label>
              <button class="btn btn-primary btn-sm" :disabled="running" @click="start">
                {{ running ? '健檢中...' : '開始健檢' }}
              </button>
              <span v-if="run" style="font-size:var(--fs-sm);color:var(--text-muted)">
                本輪：{{ run.task_db_id ? ('任務 ' + ((run.task && run.task.task_id) || run.task_db_id)) : '全平台' }}
                　{{ run.status }}（{{ ofKind('proposal').length }} 條提案）
                <span v-if="run.since_at">　視窗：{{ new Date(run.since_at).toLocaleString() }} 起</span>
              </span>
            </div>

            <div class="table-wrap">
              <table class="data-table">
                <!-- 這張表只回答兩個問題：昨天那輪是什麼等級、要不要進改善。範圍／視窗／狀態
                     三欄拿掉——每天看的人不會用它們分流，要細節點進去那一輪就有。狀態欄的資訊
                     沒有消失：失敗被 histSev 吸收成「健檢失敗」等級，原因跟在下面。 -->
                <thead><tr><th>時間</th><th>等級</th><th>要不要改善</th><th>提案數</th></tr></thead>
                <tbody>
                  <tr v-for="h in history" :key="h.id" class="clickable" @click="openRun(h.id)">
                    <td>
                      {{ new Date(h.created_at).toLocaleString() }}
                      <!-- 範圍與節奏降成副標，不各佔一欄：多數列是「全平台／增量」，每列都標等於
                           沒標；但大健檢（週／月）與任務健檢的等級跟日健檢不可比，看不出來會誤讀。 -->
                      <div v-if="h.task_db_id || cadenceText(h)" style="font-size:var(--fs-xs);color:var(--text-muted)">
                        <span v-if="h.task_db_id">{{ scopeText(h) }}</span>{{ cadenceText(h) }}
                      </div>
                    </td>
                    <td>
                      <span v-if="histSev(h)" :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:histSev(h).color}">
                        {{ histSev(h).label }}
                      </span>
                      <span v-else style="color:var(--text-muted)">—</span>
                      <!-- 失敗原因跟著等級走：要知道為什麼掛還得點進去的話，而失敗那輪點進去
                           又是空的（一筆 finding 都沒有），等於查不到。 -->
                      <div v-if="h.status === 'error' && h.error" class="hc-body"
                        style="font-size:var(--fs-xs);color:var(--danger)">{{ h.error }}</div>
                    </td>
                    <td>
                      <span v-if="histTodo(h)" :style="{fontSize:'var(--fs-sm)',color:histTodo(h).color}">{{ histTodo(h).label }}</span>
                      <span v-else style="color:var(--text-muted)">—</span>
                    </td>
                    <td>{{ h.proposal_count || 0 }}</td>
                  </tr>
                  <tr v-if="history.length === 0" class="empty-row"><td colspan="4">尚無健檢紀錄</td></tr>
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </div>
    `
  });
