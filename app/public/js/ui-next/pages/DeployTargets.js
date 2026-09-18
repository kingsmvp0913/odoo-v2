(function () {
  // 自動部署目標：評估客戶機 → 人指認哪個 instance 是測試／正式 → 存成設定。
  //
  // 只做「評估與指認」，不做部署動作（那在後續 Task）。
  // 這頁一定是專案頁的內嵌分頁，外層用主要頁面外殼，不是 Admin 子頁外殼。
  window.UiNextDeployTargetsView = Vue.defineComponent({
    name: "UiNextDeployTargetsView",
    props: { embedded: { type: Boolean, default: false } },
    data() {
      return {
        targets: [], conns: [], loading: true, loadError: "",
        probing: false, probeError: "", probe: null, probeConnId: null,
        showRaw: false,
        // 指認表單：一個候選一份，key 是候選索引
        assign: {}, saving: false,
        runs: [], runsLoading: false, openRun: null, deploying: 0,
        repos: [], editingId: 0, editForm: null, savingEdit: false,
      };
    },
    computed: {
      projectId() { return this.$route.params.id; },
      // 有登記 SSH 的連線才探得動；direct 模式（DBeaver 式直連）沒有 SSH 欄位
      sshConns() { return this.conns.filter((c) => c.ssh_host && c.ssh_user); },
    },
    async created() { await this.load(); await this.loadRuns(); },
    methods: {
      async load() {
        this.loading = true; this.loadError = "";
        try {
          const [t, c, r] = await Promise.all([
            Api.get(`projects/${this.projectId}/deploy-targets`),
            Api.get(`projects/${this.projectId}/db-connections`).catch(() => ({ connections: [] })),
            Api.get(`projects/${this.projectId}/repos`).catch(() => []),
          ]);
          this.targets = t.targets || [];
          this.conns = c.connections || c || [];
          this.repos = (Array.isArray(r) ? r : []).filter((x) => x.clone_status === "done");
          if (!this.probeConnId && this.sshConns.length) this.probeConnId = this.sshConns[0].id;
        } catch (e) {
          this.loadError = e.message || "無法載入部署設定";
        } finally { this.loading = false; }
      },
      async loadRuns() {
        this.runsLoading = true;
        try {
          const r = await Api.get(`projects/${this.projectId}/deploy-runs`);
          this.runs = r.runs || [];
        } catch (e) { /* 歷史讀不到不該擋住主功能 */ } finally { this.runsLoading = false; }
      },
      async toggleEnabled(t) {
        try {
          await Api.patch(`projects/${this.projectId}/deploy-targets/${t.id}`, { enabled: !t.enabled });
          await this.load();
        } catch (e) { showToast(e.message || '切換失敗', 'error', 0); }
      },
      startEdit(t) {
        this.editingId = t.id;
        this.editForm = {
          env: t.env, repo_id: t.repo_id || "", conn_id: t.conn_id || "",
          addons_dir: t.addons_dir || "", conf_path: t.conf_path || "",
          odoo_bin: t.odoo_bin || "",
          db_name: t.db_name || "", http_port: t.http_port || "",
          modules: (t.modules || []).join(", "),
        };
      },
      cancelEdit() { this.editingId = 0; this.editForm = null; },
      async saveEdit(t) {
        const f = this.editForm;
        this.savingEdit = true;
        try {
          const r = await Api.patch(`projects/${this.projectId}/deploy-targets/${t.id}`, {
            env: f.env,
            repo_id: Number(f.repo_id) || null,
            conn_id: Number(f.conn_id) || null,
            addons_dir: f.addons_dir,
            conf_path: f.conf_path,
            odoo_bin: f.odoo_bin,
            db_name: f.db_name,
            http_port: Number(f.http_port) || null,
            modules: f.modules.split(",").map((m) => m.trim()).filter(Boolean),
          });
          // resetSha 是「下次會整包重送」，不講的話使用者看不出為什麼那次部署特別久
          showToast(r.resetSha
            ? `已更新，來源分支 ${r.branch}。改到了部署位置，下次會整包重送一次`
            : `已更新，來源分支 ${r.branch}`, "success");
          this.cancelEdit();
          await this.load();
        } catch (e) { showToast(e.message || "更新失敗", "error", 0); }
        finally { this.savingEdit = false; }
      },
      async deleteTarget(t) {
        const n = t.run_count || 0;
        const ok = await confirmDialog({
          title: "刪除這個部署目標？",
          message: `${this.envLabel(t.env)}／${t.db_name}`
            + (n ? `。這會連同 ${n} 筆部署紀錄一起刪掉，救不回來。` : "。它還沒有部署紀錄。")
            + "客戶機上的檔案不會被動到。",
          danger: true,
          confirmText: "刪除",
        });
        if (!ok) return;
        try {
          const r = await Api.delete(`projects/${this.projectId}/deploy-targets/${t.id}`);
          showToast(r.deletedRuns ? `已刪除，連帶移除 ${r.deletedRuns} 筆部署紀錄` : "已刪除", "success");
          await Promise.all([this.load(), this.loadRuns()]);
        } catch (e) { showToast(e.message || "刪除失敗", "error", 0); }
      },
      async deployNow(t) {
        if (t.env === 'prod') {
          const ok = await confirmDialog({
            title: '確定要部署到正式區？',
            message: `這會直接更新客戶正在使用的系統（${this.addrOf(t)} / ${t.db_name}）。`
              + '失敗時只會還原程式檔案，資料庫的改動不會還原。',
            danger: true,
            confirmText: '部署到正式區',
          });
          if (!ok) return;
        }
        this.deploying = t.id;
        try {
          const r = await Api.post(`projects/${this.projectId}/deploy-targets/${t.id}/deploy`,
            t.env === 'prod' ? { confirm: true } : {});
          if (r.ok) {
            showToast(r.modules && r.modules.length ? `部署完成：${r.modules.join(', ')}` : '沒有模組變更，略過', 'success');
          } else {
            showToast(`部署失敗：${r.error || '未知原因'}`, 'error', 0);
          }
          await Promise.all([this.load(), this.loadRuns()]);
        } catch (e) {
          showToast(e.message || '部署失敗', 'error', 0);
        } finally { this.deploying = 0; }
      },
      async runProbe() {
        if (!this.probeConnId) return;
        this.probing = true; this.probeError = ""; this.probe = null; this.assign = {};
        try {
          const r = await Api.post(`projects/${this.projectId}/deploy-probe`, { conn_id: Number(this.probeConnId) });
          if (!r.ok) { this.probeError = r.error || "評估失敗"; return; }
          this.probe = r;
          const repos = r.repos || [];
          (r.candidates || []).forEach((c, i) => {
            const best = (c.addonsCandidates || [])[0];
            // 只有一個 repo 就不必問；多 repo 專案（萊峰19）才留給人選
            const repoId = repos.length === 1 ? repos[0].id : "";
            this.assign[i] = {
              env: "", repo_id: repoId,
              addons_dir: best ? best.dir : "",
              addonsManual: !best,
              conf_path: c.confPath || "",
              odoo_bin: c.odooBin || "",
              modules: this.modulesOf(repoId).join(", "),
              db_name: c.dbName || "",
            };
          });
        } catch (e) {
          this.probeError = e.message || "評估失敗";
        } finally { this.probing = false; }
      },
      // 資料庫選項＝連線設定的值＋conf 讀到的。conf 只有一個且與連線不符時（dbMismatch）
      // 也必須列出來，否則畫面警告「這台管的不是這個 db」卻沒有地方讓人改。
      dbChoices(c) {
        return [...new Set([
          c.dbName,
          ...(c.linkedConns || []).map((x) => x.dbName),
          ...(c.confDbNames || []),
        ].filter(Boolean))];
      },
      matchedCount(c, dir) {
        const a = (c.addonsCandidates || []).find((x) => x.dir === dir);
        return a ? a.matched.length : 0;
      },
      // repo 決定「碼從哪來」，也決定模組清單。換 repo 就重填模組。
      modulesOf(repoId) {
        const r = ((this.probe && this.probe.repos) || []).find((x) => x.id === Number(repoId));
        return r ? r.modules : [];
      },
      onRepoChange(i) {
        this.assign[i].modules = this.modulesOf(this.assign[i].repo_id).join(", ");
      },
      async saveTarget(i) {
        const c = this.probe.candidates[i];
        const a = this.assign[i];
        if (!a.env) { showToast("請先指認這是測試區還是正式區", "error"); return; }
        if (!a.repo_id) { showToast("請選擇要從哪個 repo 拿碼部署", "error"); return; }
        if (!a.addons_dir) { showToast("請填 addons 目錄", "error"); return; }
        this.saving = true;
        try {
          const saved = await Api.post(`projects/${this.projectId}/deploy-targets`, {
            env: a.env,
            repo_id: Number(a.repo_id),
            conn_id: Number(this.probeConnId),
            runtime: c.runtime,
            compose_dir: c.composeDir,
            compose_service: c.composeService,
            service_name: c.serviceName,
            container_name: c.containerName,
            addons_dir: a.addons_dir.trim(),
            conf_path: a.conf_path.trim() || null,
            odoo_bin: (a.odoo_bin || "").trim() || null,
            db_name: a.db_name,
            http_port: this.portOf(c),
            modules: a.modules.split(",").map((m) => m.trim()).filter(Boolean),
            sudo_mode: c.sudoMode,
            probe_json: { candidate: c, diskAvailGb: this.probe.diskAvailGb },
          });
          showToast(`已存成部署目標，來源分支 ${saved.branch}（預設停用，確認無誤再啟用）`, "success");
          await this.load();
        } catch (e) {
          showToast(e.message || "存檔失敗", "error", 0);
        } finally { this.saving = false; }
      },
      // 健康檢查在**宿主**上 curl，所以要的是對外那個 port。
      // docker：conf 寫的是容器內的（8069），對外是 ports 映射出來的（8101），要用後者。
      // systemd：沒有映射，conf 的就是對外的；conf 沒寫時 Odoo 用預設 8069——
      // 這不是猜，是 Odoo 的預設值。少了這個退路，systemd 專案（慈雲那台）會因為
      // http_port 是 null，在 buildHealthCmd 直接拋「http_port 不合法」。
      portOf(c) {
        if (c.runtime === "docker" && c.ports) return this.guessPort(c.ports) || c.httpPort || 8069;
        return c.httpPort || 8069;
      },
      // docker ports 形如 "8071-8072/tcp, 0.0.0.0:8101->8069/tcp"，取對外那個
      guessPort(ports) {
        const m = /:(\d+)->/.exec(String(ports || ""));
        return m ? Number(m[1]) : null;
      },
      envLabel(e) { return e === "prod" ? "正式區" : "測試區"; },
      statusLabel(s) { return { running: '執行中', success: '成功', failed: '失敗', rolled_back: '已回滾' }[s] || s; },
      statusColor(s) { return s === 'success' ? 'var(--success)' : (s === 'running' ? 'var(--text-muted)' : 'var(--danger)'); },
      addrOf(t) { return t.runtime === "docker" ? (t.compose_service || t.container_name) : t.service_name; },
    },
    template: `
<div class="ui-next-deploy-page">
  <div v-if="loading" class="ui-next-loading-card">載入中…</div>
  <div v-else-if="loadError" class="ui-next-panel"><div class="error-msg">{{ loadError }}</div></div>

  <template v-else>
    <section class="ui-next-panel">
      <h2>自動部署目標</h2>
      <p class="ui-next-deploy-hint">先評估客戶機長什麼形狀，再由你指認哪一個 instance 是這個專案的測試區／正式區。<strong>新建的目標一律停用</strong>，確認無誤後再手動啟用。</p>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>環境</th><th>形式</th><th>服務</th><th>資料庫</th><th>addons 目錄</th><th>分支</th><th>上次部署</th><th>狀態</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-if="!targets.length" class="empty-row"><td colspan="9">尚未設定任何部署目標。</td></tr>
            <template v-for="t in targets" :key="t.id">
            <tr>
              <td>{{ envLabel(t.env) }}</td>
              <td>{{ t.runtime }}</td>
              <td><code>{{ addrOf(t) }}</code></td>
              <td><code>{{ t.db_name }}</code></td>
              <td class="ui-next-deploy-path" :title="t.addons_dir"><code>{{ t.addons_dir }}</code></td>
              <td><code>{{ t.branch }}</code></td>
              <td>{{ t.last_deployed_sha ? t.last_deployed_sha.slice(0,8) : '—' }}</td>
              <td><span :style="{color: t.enabled ? 'var(--success)' : 'var(--text-muted)'}">{{ t.enabled ? '已啟用' : '停用' }}</span></td>
              <td>
                <div class="ui-next-deploy-actions">
                  <button class="btn btn-outline btn-sm" @click="toggleEnabled(t)">{{ t.enabled ? '停用' : '啟用' }}</button>
                  <button class="btn btn-outline btn-sm" :disabled="deploying === t.id" @click="deployNow(t)">
                    {{ deploying === t.id ? '部署中…' : '立即部署' }}
                  </button>
                  <button class="btn btn-outline btn-sm" @click="editingId === t.id ? cancelEdit() : startEdit(t)">
                    {{ editingId === t.id ? '收合' : '編輯' }}</button>
                  <button class="btn btn-outline btn-sm" @click="deleteTarget(t)">刪除</button>
                </div>
              </td>
            </tr>
            <tr v-if="editingId === t.id"><td colspan="9">
              <div class="conn-fields">
                <div class="field-item field-item-narrow">
                  <label class="field-label">環境</label>
                  <select v-model="editForm.env" class="field-input">
                    <option value="test">測試區</option>
                    <option value="prod">正式區</option>
                  </select>
                  <span class="ui-next-deploy-hint" style="margin:0">改這個，來源分支會跟著重推</span>
                </div>
                <div class="field-item field-item-narrow">
                  <label class="field-label">從哪個 repo 拿碼</label>
                  <select v-model="editForm.repo_id" class="field-input">
                    <option v-for="r in repos" :key="r.id" :value="r.id">{{ r.label }}</option>
                  </select>
                </div>
                <div class="field-item field-item-narrow">
                  <label class="field-label">用哪條連線</label>
                  <select v-model="editForm.conn_id" class="field-input">
                    <option v-for="c in sshConns" :key="c.id" :value="c.id">{{ c.name }}</option>
                  </select>
                </div>
                <div class="field-item field-item-narrow">
                  <label class="field-label">資料庫</label>
                  <input v-model="editForm.db_name" class="field-input" />
                </div>
                <div class="field-item">
                  <label class="field-label">addons 目錄（客戶機宿主上的絕對路徑）</label>
                  <input v-model="editForm.addons_dir" class="field-input" />
                </div>
                <div class="field-item">
                  <label class="field-label">conf 路徑</label>
                  <input v-model="editForm.conf_path" class="field-input" />
                </div>
                <div v-if="t.runtime === 'systemd'" class="field-item">
                  <label class="field-label">odoo 執行檔（絕對路徑）</label>
                  <input v-model="editForm.odoo_bin" class="field-input" placeholder="/odoo/odoo-server/odoo-bin" />
                  <span class="ui-next-deploy-hint" style="margin:0">留空＝直接叫 odoo-bin，只有它在 PATH 上才行得通</span>
                </div>
                <div class="field-item">
                  <label class="field-label">我們管的模組（逗號分隔）</label>
                  <input v-model="editForm.modules" class="field-input" />
                </div>
                <div class="field-item field-item-narrow">
                  <label class="field-label">對外 port（健康檢查用）</label>
                  <input v-model="editForm.http_port" class="field-input" />
                </div>
              </div>
              <p class="ui-next-deploy-hint" style="margin:10px 0 0">
                形式、服務名、compose 位置是評估時偵測到的，這裡不給改——要換 instance 請重新評估。
              </p>
              <div style="margin-top:var(--space-3)">
                <button class="btn btn-primary btn-sm" :disabled="savingEdit" @click="saveEdit(t)">儲存</button>
                <button class="btn btn-outline btn-sm" style="margin-left:6px" @click="cancelEdit">取消</button>
              </div>
            </td></tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <section class="ui-next-panel">
      <h2>部署歷史</h2>
      <div v-if="runsLoading" class="ui-next-empty-state">載入中…</div>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead><tr><th>時間</th><th>環境</th><th>觸發</th><th>模組</th><th>版本</th><th>結果</th><th></th></tr></thead>
          <tbody>
            <tr v-if="!runs.length" class="empty-row"><td colspan="7">還沒有部署紀錄。</td></tr>
            <template v-for="r in runs" :key="r.id">
              <tr>
                <td>{{ new Date(r.started_at).toLocaleString() }}</td>
                <td>{{ envLabel(r.env) }}</td>
                <td>{{ r.trigger }}</td>
                <td>{{ (r.modules || []).join(', ') || '—' }}</td>
                <td><code>{{ r.to_sha ? r.to_sha.slice(0,8) : '—' }}</code></td>
                <td><span :style="{color: statusColor(r.status)}">{{ statusLabel(r.status) }}</span></td>
                <td><button class="btn btn-outline btn-sm" @click="openRun = openRun === r.id ? null : r.id">
                  {{ openRun === r.id ? '收合' : '看輸出' }}</button></td>
              </tr>
              <tr v-if="openRun === r.id"><td colspan="7"><pre class="ui-next-log-pre">{{ r.log || '（無輸出）' }}</pre></td></tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <section class="ui-next-panel">
      <h2>評估客戶機</h2>
      <p v-if="!sshConns.length" class="ui-next-deploy-hint">
        這個專案沒有登記 SSH 的連線設定。請先到「連線設定」分頁新增一筆（direct 模式不經 SSH，評估不了）。
      </p>
      <template v-else>
        <div class="conn-fields">
          <div class="field-item">
            <label class="field-label">要評估哪一條連線</label>
            <select v-model="probeConnId" class="field-input">
              <option v-for="c in sshConns" :key="c.id" :value="c.id">{{ c.name }}（{{ c.ssh_user }}@{{ c.ssh_host }} / {{ c.db_name }}）</option>
            </select>
          </div>
        </div>
        <button class="btn btn-primary" style="margin-top:var(--space-3)" :disabled="probing" @click="runProbe">
          {{ probing ? '評估中…' : '開始評估' }}
        </button>
        <p class="ui-next-deploy-hint" style="margin-top:8px">唯讀，不會改動客戶機。</p>
        <div v-if="probeError" class="error-msg" style="margin-top:var(--space-3)">{{ probeError }}</div>
      </template>

      <template v-if="probe">
        <h3>評估結果</h3>
        <p v-if="probe.diskAvailGb" class="ui-next-deploy-hint">磁碟可用 {{ probe.diskAvailGb }} GB。</p>
        <div v-if="!probe.candidates.length" style="color:var(--warning)">
          沒有偵測到 Odoo instance。展開下方原始輸出核對。
        </div>

        <div v-for="(c, i) in probe.candidates" :key="i" class="ui-next-panel" style="margin-top:var(--space-4)">
          <div><strong>{{ c.runtime === 'docker' ? (c.composeService || c.containerName) : c.serviceName }}</strong>
            <span style="color:var(--text-muted)">（{{ c.runtime }}{{ c.ports ? '，' + c.ports : '' }}）</span></div>
          <div style="font-size:var(--fs-sm);color:var(--text-muted)">
            資料庫 <code>{{ assign[i].db_name }}</code>ㆍsudo {{ c.sudoMode === 'nopasswd' ? '免密碼' : '需密碼（平台已存）' }}
            <template v-if="c.odooVersion">ㆍ{{ c.odooVersion }}</template>ㆍ健康檢查打 :{{ portOf(c) }}
            <template v-if="c.composeDir">ㆍcompose <code>{{ c.composeDir }}</code></template>
          </div>
          <div v-if="(c.linkedConns || []).length" class="ui-next-deploy-linked">
            這個 instance 服務的資料庫，你的連線設定裡已經指名過：
            <span v-for="l in c.linkedConns" :key="l.id"><b>{{ l.name }}</b>（<code>{{ l.dbName }}</code>）</span>
            <br>依據是那幾條連線的「log 容器」都指向這裡。
          </div>
          <div v-if="c.dbMismatch" class="error-msg" style="margin-top:var(--space-3)">
            這個 instance 的 conf 裡沒有 <code>{{ c.dbName }}</code>，它管的是
            <code v-for="d in c.confDbNames" :key="d" style="margin-right:6px">{{ d }}</code>
            ——可能不是這條連線對應的 instance。下面請核對資料庫再存。
          </div>

          <div class="conn-fields" style="margin-top:var(--space-3)">
            <div class="field-item field-item-narrow">
              <label class="field-label">這是哪一區 <span style="color:var(--danger)">*</span></label>
              <select v-model="assign[i].env" class="field-input">
                <option value="">（不指認，略過）</option>
                <option value="test">測試區</option>
                <option value="prod">正式區</option>
              </select>
              <span class="ui-next-deploy-hint" style="margin:0">來源分支由這裡決定，不用另外填</span>
            </div>
            <div class="field-item field-item-narrow" v-if="(probe.repos || []).length > 1">
              <label class="field-label">從哪個 repo 拿碼 <span style="color:var(--danger)">*</span></label>
              <select v-model="assign[i].repo_id" class="field-input" @change="onRepoChange(i)">
                <option value="">（請選擇）</option>
                <option v-for="r in probe.repos" :key="r.id" :value="r.id">{{ r.label }}（{{ r.modules.length }} 個模組）</option>
              </select>
            </div>
            <div class="field-item field-item-narrow" v-if="dbChoices(c).length > 1">
              <label class="field-label">要升級哪一個資料庫</label>
              <select v-model="assign[i].db_name" class="field-input">
                <option v-for="d in dbChoices(c)" :key="d" :value="d">{{ d }}</option>
              </select>
            </div>
            <div class="field-item">
              <label class="field-label">addons 目錄</label>
              <select v-if="!assign[i].addonsManual" v-model="assign[i].addons_dir" class="field-input">
                <option v-for="a in c.addonsCandidates" :key="a.dir" :value="a.dir">{{ a.dir }}</option>
              </select>
              <input v-else v-model="assign[i].addons_dir" class="field-input" placeholder="/home/arich/DockerData/odoo/Data/odoo-tst/addons" />
              <span class="ui-next-deploy-hint" style="margin:0">
                <template v-if="c.addonsCandidates.length">
                  從客戶機的 conf 讀出來的，已換算成宿主路徑，這個目錄裡有 {{ matchedCount(c, assign[i].addons_dir) }} 個我們的模組。
                  <a href="#" @click.prevent="assign[i].addonsManual = !assign[i].addonsManual">
                    {{ assign[i].addonsManual ? '改用偵測到的' : '都不對，我自己填' }}</a>
                </template>
                <template v-else>conf 讀不到，請自己填（絕對路徑，客戶機宿主上的位置）</template>
              </span>
            </div>
            <div class="field-item">
              <label class="field-label">conf 路徑</label>
              <input v-model="assign[i].conf_path" class="field-input" placeholder="/etc/odoo/odoo.conf" />
            </div>
            <div v-if="c.runtime === 'systemd'" class="field-item">
              <label class="field-label">odoo 執行檔（絕對路徑）</label>
              <input v-model="assign[i].odoo_bin" class="field-input" placeholder="/odoo/odoo-server/odoo-bin" />
              <span class="ui-next-deploy-hint" style="margin:0">
                <template v-if="c.odooBin">從服務的啟動指令讀出來的</template>
                <template v-else>啟動指令讀不到，請自己填——留空會直接叫 odoo-bin，那台機器上不一定找得到</template>
              </span>
            </div>
            <div class="field-item">
              <label class="field-label">我們管的模組（逗號分隔）</label>
              <input v-model="assign[i].modules" class="field-input" placeholder="idx_hj, idx_scan" />
              <span class="ui-next-deploy-hint" style="margin:0">來自 repo 裡有 __manifest__.py 的目錄，不用問客戶機</span>
            </div>
          </div>
          <button class="btn btn-primary btn-sm" style="margin-top:var(--space-3)" :disabled="saving" @click="saveTarget(i)">存成部署目標</button>
        </div>

        <div style="margin-top:var(--space-5)">
          <button class="btn btn-outline btn-sm" @click="showRaw = !showRaw">{{ showRaw ? '收合' : '展開' }}原始輸出（已遮罩密碼）</button>
          <pre v-if="showRaw" class="ui-next-log-pre" style="margin-top:var(--space-3)">{{ probe.raw }}</pre>
        </div>
      </template>
    </section>
  </template>
</div>`,
  });
})();
