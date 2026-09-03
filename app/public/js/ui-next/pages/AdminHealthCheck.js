  window.UiNextAdminHealthCheckView = Vue.defineComponent({
    name: "UiNextAdminHealthCheckView",
    data() {
      return { runId: null, run: null, findings: [], history: [], schedule: null, running: false, cadence: 'daily', sinceDays: null, savingId: null, noteDraft: {}, statuses: HC_STATUS, fixes: {}, fixBusy: null, diffOpen: {}, _timer: null, _fixTimer: null };
    },
    async mounted() { await this.loadHistory(); await this.openFromQuery(); },
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
            await this.loadFixes();
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
      ofKind(k) { return this.findings.filter(f => this.kindOf(f) === k); },
      statusLabel(v) { return (HC_STATUS.find(s => s.value === v) || {}).label || v; },
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
      // 每次打開一輪就把提案既有的修正狀態撈回來——不撈的話重新整理後看起來像沒修過，
      // 會有人再按一次而在同一條上開第二個工作區。
      async loadFixes() {
        for (const f of this.ofKind('proposal')) {
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
        <h1>系統健檢</h1>
        <div class="ui-next-admin-head-actions"><button class="btn btn-outline btn-sm" @click="$router.push('/admin')">← 返回</button></div>
      </div>
      <div class="content">
        <div class="hc-page">
          <div class="settings-section hc-window-row">
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
              範圍：{{ run.task_db_id ? ('任務 ' + ((run.task && run.task.task_id) || run.task_db_id)) : '全平台' }}　
              狀態：{{ run.status }}（{{ ofKind('proposal').length }} 條提案）
              <span v-if="run.since_at">　視窗：{{ new Date(run.since_at).toLocaleString() }} 起</span>
            </span>
            <span v-if="nextRunText" style="font-size:var(--fs-sm);color:var(--text-muted);margin-left:auto">
              下次自動健檢：{{ nextRunText }}
            </span>
          </div>

          <div v-if="ofKind('proposal').some(f => f.status === 'approved')" class="settings-section"
            style="border-left:3px solid var(--warning-strong);margin-bottom:var(--space-3);font-size:var(--fs-sm);color:var(--text)">
            ⏱ 已核准的提案**沒有人會先看過**，今晚 22:00 會自動實作並合併。不想讓某一條跑，要在那之前按「擋下這條」。
          </div>

          <div v-for="f in ofKind('note')" :key="f.id" class="error-msg" style="margin-bottom:var(--space-3)">{{ f.diagnosis }}</div>

          <div v-for="f in ofKind('summary')" :key="f.id"
            style="border:1px solid var(--border);border-left:3px solid var(--primary);border-radius:var(--radius);padding:var(--space-3);margin-bottom:var(--space-3);background:var(--surface)">
            <div class="hc-finding-title-row">
              <span style="font-weight:var(--fw-semibold)">本輪總結</span>
              <span :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:sev(f.severity).color}">
                {{ sev(f.severity).label }}
              </span>
            </div>
            <div style="font-size:var(--fs-base);color:var(--text);white-space:pre-wrap">{{ f.diagnosis }}</div>
          </div>

          <div v-for="f in ofKind('proposal')" :key="f.id"
            style="border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);margin-bottom:var(--space-3);background:var(--surface)">
            <div class="hc-finding-title-row">
              <span style="font-weight:var(--fw-semibold)">{{ f.agent_label }}</span>
              <span v-if="layer(f.layer)" :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:layer(f.layer).color}">
                {{ layer(f.layer).label }}
              </span>
              <span :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:sev(f.severity).color}">
                {{ sev(f.severity).label }}
              </span>
              <span v-if="f.status === 'approved'" style="font-size:var(--fs-xs);padding:1px var(--space-2);border-radius:4px;color:#fff;background:var(--warning-strong)" title="沒有人會先審——今晚 22:00 會被自動實作並合併">
                ⏱ 今晚 22:00 自動執行
              </span>
            </div>
            <div style="font-size:var(--fs-base);color:var(--text);margin-bottom:6px;white-space:pre-wrap">{{ f.diagnosis }}</div>
            <div v-if="f.evidence" style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:4px">證據：{{ f.evidence }}</div>
            <div v-if="f.rationale" style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:4px">建議做法：{{ f.rationale }}</div>
            <div v-if="f.target_metric" style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:6px">
              要動的指標：{{ f.target_metric }}（現值 {{ f.metric_baseline }}）
            </div>
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
              <div v-if="fixState(f.id).reject_reason" class="error-msg" style="white-space:pre-wrap;margin:6px 0">{{ fixState(f.id).reject_reason }}</div>
              <div v-if="fixState(f.id).notes" style="font-size:var(--fs-sm);color:var(--text);white-space:pre-wrap;margin-bottom:6px">{{ fixState(f.id).notes }}</div>
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

          <div v-if="ofKind('signal').length" class="settings-section">
            <h2 class="section-title">候選訊號（證據還不夠，累積中）</h2>
            <div v-for="f in ofKind('signal')" :key="f.id" style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:6px;white-space:pre-wrap">
              ・{{ f.diagnosis }}<span v-if="f.evidence">（{{ f.evidence }}）</span>
            </div>
          </div>

          <div v-for="f in ofKind('agent')" :key="f.id"
            style="border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-3);margin-bottom:var(--space-3);background:var(--surface)">
            <div class="hc-finding-title-row">
              <span style="font-family:monospace;font-weight:var(--fw-semibold)">{{ f.agent_label || f.agent_name }}</span>
              <span :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:sev(f.severity).color}">
                {{ sev(f.severity).label }}
              </span>
            </div>
            <div style="font-size:var(--fs-base);color:var(--text);margin-bottom:6px">{{ f.diagnosis }}</div>
            <div v-if="f.rationale" style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:6px">理由：{{ f.rationale }}</div>
            <button v-if="f.suggested_prompt" class="btn btn-outline btn-sm" @click="applyToEditor(f)">帶入編輯器 →</button>
          </div>

          <div class="settings-section">
            <h2 class="section-title">歷史健檢</h2>
            <div class="table-wrap">
              <table class="data-table">
                <thead><tr><th>時間</th><th>範圍</th><th>視窗</th><th>狀態</th><th>嚴重度</th><th>處理狀態</th><th>提案／診斷</th></tr></thead>
                <tbody>
                  <tr v-for="h in history" :key="h.id" class="clickable" @click="openRun(h.id)">
                    <td>{{ new Date(h.created_at).toLocaleString() }}</td>
                    <td>{{ scopeText(h) }}</td>
                    <td>{{ h.task_db_id ? '—' : h.window_days + ' 天' + cadenceText(h) }}</td>
                    <td>{{ h.status }}</td>
                    <td>
                      <span v-if="histSev(h)" :style="{fontSize:'var(--fs-xs)',padding:'1px var(--space-2)',borderRadius:'4px',color:'#fff',background:histSev(h).color}">
                        {{ histSev(h).label }}
                      </span>
                      <span v-else style="color:var(--text-muted)">—</span>
                    </td>
                    <td>
                      <span v-if="histTodo(h)" :style="{fontSize:'var(--fs-sm)',color:histTodo(h).color}">{{ histTodo(h).label }}</span>
                      <span v-else style="color:var(--text-muted)">—</span>
                    </td>
                    <td>{{ h.findings_count }}</td>
                  </tr>
                  <tr v-if="history.length === 0" class="empty-row"><td colspan="7">尚無健檢紀錄</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `
  });
