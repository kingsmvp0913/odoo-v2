(function () {
  // 平台管理員的公司管理頁（3b Task 8）。後端契約見 server/company-admin-routes.js
  // （3a Task 3／4／5 已上線並審查通過，本頁不得改動它）。
  //
  // 這頁是客戶公司唯一的建立入口——在後端這批端點上線前，companies 表只被一次性
  // 遷移腳本寫過，平台上沒有任何地方能真正「建立一家客戶公司」。
  //
  // 三個坑，任一個漏了都是回頭工（brief 原文）：
  // 1. is_internal 後端永遠忽略、不可能靠 API 設定。畫面只標示「內部公司」，
  //    不放切換開關——放了等於騙人：使用者以為自己按得動，其實後端根本不理。
  // 2. 解除專案綁定會讓那家公司「立刻」看不到該專案與其中每一張任務，包含他們
  //    自己開的。GET .../projects 回的 task_count 就是為了讓確認對話框把數字唸出來。
  // 3. 公司 GIT 存檔前，後端會對這家公司綁到的每個 repo 真的跑一次 git ls-remote，
  //    所以不是瞬間完成；失敗時後端回的錯誤原文會指名哪個 repo 連不上，必須原文顯示，
  //    換成「儲存失敗」等於把唯一能查的線索吃掉。
  // 詳細畫面的四個分頁，一比一對應原本直排的四個區塊（沒有任何內容被收掉）。
  // 形狀抄個人設定頁（Settings.js 的 SETTINGS_TABS ＋ .ui-next-page-tabs），
  // 不自創第二種分頁寫法。
  const COMPANY_TABS = [
    { key: "basic", label: "基本資料" },
    { key: "features", label: "功能開關" },
    { key: "projects", label: "綁定的專案" },
    { key: "git", label: "GIT 憑證" },
  ];

  window.UiNextCompanyAdminView = Vue.defineComponent({
    name: "UiNextCompanyAdminView",
    data() {
      return {
        companies: [],
        tab: "basic",
        loading: true,
        loadError: "",
        featureDefs: [], // [{key,label}]，來自 GET /api/admin/companies/features

        // 目前點進去看的公司（null＝停在清單畫面）。
        selected: null,
        detailError: "",

        // 新增公司
        createOpen: false,
        newCompany: { name: "", is_active: true },
        savingCreate: false,

        // 基本資料表單
        form: { name: "", is_active: true, active_from: "", active_until: "" },
        savingBasic: false,
        taskBudgetInput: "",
        savingBudget: false,

        // 功能開關表單——後端整包覆蓋，所以這裡永遠保存「全部功能」的完整狀態，
        // 不是只記被使用者動過的那一個（見檔頭第 3 點的姊妹坑：wholesale replace）。
        featureForm: {},
        savingFeatures: false,

        // 綁定的專案
        boundProjects: [],
        allProjects: [],
        projectsLoading: false,
        bindProjectId: "",
        bindCanRelease: false,
        binding: false,
        releaseBusy: {}, // { [project_id]: true } 切換「可上正式」時鎖住那一列
        unbindBusy: {},

        // 公司 GIT
        gitForm: { pat: "", login: "", name: "", email: "" },
        savingGit: false,
        gitError: "",
        clearingGit: false,
      };
    },
    computed: {
      tabs() { return COMPANY_TABS; },
      expiringCompanies() {
        const now = Date.now();
        return this.companies.filter((c) => {
          const remaining = new Date(c.active_until).getTime() - now;
          return c.is_active && !c.is_internal && c.active_until && remaining > 0 && remaining <= 14 * 86400000;
        });
      },
      // 還沒綁給這家公司的專案，供「新增綁定」下拉選單用。
      unboundProjects() {
        const boundIds = new Set(this.boundProjects.map((p) => p.project_id));
        return this.allProjects.filter((p) => !boundIds.has(p.id));
      },
    },
    async created() {
      await Promise.all([this.loadCompanies(), this.loadFeatureDefs()]);
    },
    methods: {
      async loadCompanies() {
        this.loading = true;
        this.loadError = "";
        try {
          this.companies = await Api.get("admin/companies");
        } catch (e) {
          this.loadError = e.message || "無法載入公司列表";
        } finally {
          this.loading = false;
        }
      },
      async loadFeatureDefs() {
        try {
          this.featureDefs = await Api.get("admin/companies/features");
        } catch (e) {
          showToast(e.message || "無法載入功能清單", "error");
        }
      },
      async createCompany() {
        if (!this.newCompany.name.trim()) return showToast("請填寫公司名稱", "error");
        this.savingCreate = true;
        try {
          await Api.post("admin/companies", {
            name: this.newCompany.name,
            is_active: this.newCompany.is_active,
          });
          this.newCompany = { name: "", is_active: true };
          this.createOpen = false;
          await this.loadCompanies();
          showToast("已新增公司", "success");
        } catch (e) {
          showToast(e.message || "新增失敗", "error");
        } finally {
          this.savingCreate = false;
        }
      },

      // 日期欄位存的是 TIMESTAMPTZ，<input type="date"> 只吃 YYYY-MM-DD。
      dateOnly(ts) { return ts ? String(ts).slice(0, 10) : ""; },

      async openCompany(c) {
        this.selected = c;
        // 分頁一律回到第一頁：停在上一家公司看到的分頁，會讓人以為資料跟著人跑了
        //（點開 B 公司卻直接落在 GIT 憑證那頁，第一眼分不出那是誰的憑證）。
        this.tab = "basic";
        this.detailError = "";
        this.form = {
          name: c.name,
          is_active: c.is_active,
          active_from: this.dateOnly(c.active_from),
          active_until: this.dateOnly(c.active_until),
        };
        this.taskBudgetInput = c.task_budget_usd == null ? "" : String(c.task_budget_usd);
        this.featureForm = {};
        for (const f of this.featureDefs) this.featureForm[f.key] = !!(c.features || {})[f.key];
        // pat 永遠留空：後端從不回傳密文，這裡也不假裝知道原文。
        this.gitForm = { pat: "", login: c.git_login || "", name: c.git_name || "", email: c.git_email || "" };
        this.gitError = "";
        this.bindProjectId = "";
        this.bindCanRelease = false;
        await this.loadProjectsPanel();
      },
      closeCompany() { this.selected = null; },

      // 重新整理清單後把 selected 換成清單裡的最新版本，讓 user_count／project_count／
      // has_git_pat 這些「詳細畫面沒有自己表單、只顯示」的欄位跟著同步，不必手動拼欄位。
      async refreshSelectedFromList() {
        await this.loadCompanies();
        const fresh = this.companies.find((c) => c.id === this.selected.id);
        if (fresh) this.selected = fresh;
      },

      async loadProjectsPanel() {
        this.projectsLoading = true;
        this.detailError = "";
        try {
          const [bound, all] = await Promise.all([
            Api.get(`admin/companies/${this.selected.id}/projects`),
            Api.get("projects"),
          ]);
          this.boundProjects = bound;
          this.allProjects = all;
        } catch (e) {
          this.detailError = e.message || "無法載入綁定的專案";
        } finally {
          this.projectsLoading = false;
        }
      },

      async saveBasic() {
        if (!this.form.name.trim()) return showToast("請填寫公司名稱", "error");
        this.savingBasic = true;
        try {
          await Api.put(`admin/companies/${this.selected.id}`, {
            name: this.form.name,
            is_active: this.form.is_active,
            active_from: this.form.active_from || null,
            active_until: this.form.active_until || null,
          });
          await this.refreshSelectedFromList();
          showToast("已儲存", "success");
        } catch (e) {
          showToast(e.message || "儲存失敗", "error");
        } finally {
          this.savingBasic = false;
        }
      },

      async saveTaskBudget() {
        const amount = String(this.taskBudgetInput).trim() === "" ? null : Number(this.taskBudgetInput);
        if (amount !== null && (!Number.isFinite(amount) || amount < 0.01 || Math.abs(amount * 100 - Math.round(amount * 100)) >= 1e-8)) {
          return showToast("請輸入正數美元金額，最多小數兩位；留空表示不設定上限", "error");
        }
        this.savingBudget = true;
        try {
          await Api.put(`admin/companies/${this.selected.id}/task-budget`, { task_budget_usd: amount });
          await this.refreshSelectedFromList();
          showToast("已儲存任務花費上限", "success");
        } catch (e) { showToast(e.message || "儲存任務花費上限失敗", "error"); }
        finally { this.savingBudget = false; }
      },

      async saveFeatures() {
        this.savingFeatures = true;
        try {
          // 整包送出所有已知功能的目前狀態——後端是整包覆蓋，只送被改的那一個
          // 會把其餘功能全部靜默關掉（見檔頭第 3 點）。
          await Api.put(`admin/companies/${this.selected.id}`, { features: { ...this.featureForm } });
          await this.refreshSelectedFromList();
          showToast("已儲存功能設定", "success");
        } catch (e) {
          showToast(e.message || "儲存失敗", "error");
        } finally {
          this.savingFeatures = false;
        }
      },

      async bindProject() {
        if (!this.bindProjectId) return showToast("請選擇要綁定的專案", "error");
        this.binding = true;
        try {
          await Api.put(`admin/companies/${this.selected.id}/projects/${this.bindProjectId}`, {
            can_release: this.bindCanRelease,
          });
          this.bindProjectId = "";
          this.bindCanRelease = false;
          await this.loadProjectsPanel();
          await this.refreshSelectedFromList(); // project_count 變了
          showToast("已綁定專案", "success");
        } catch (e) {
          // 內部公司 + 可上正式 這個組合會被後端 400 擋下（規格 §4.3），原文顯示。
          showToast(e.message || "綁定失敗", "error", 0);
        } finally {
          this.binding = false;
        }
      },

      // 先改資料、失敗再改回來（形狀抄 ProjectDetail.js 的 saveAutoDeploy）。
      // 勾勾是單向的 :checked：後端拒絕時若 row.can_release 從頭到尾沒變過，
      // Vue 的 vnode 比對會判定「值沒變」而不重寫 DOM property，勾勾就停在使用者
      // 按出來的（錯的）狀態，直到別的原因害它重畫為止——畫面說了一件沒發生的事。
      async toggleCanRelease(row) {
        // 變數不叫 next：下面 finally 裡已經有一個 next（releaseBusy 的新值），同名會互相遮蔽。
        const wanted = !row.can_release;
        row.can_release = wanted;
        this.releaseBusy = { ...this.releaseBusy, [row.project_id]: true };
        try {
          await Api.put(`admin/companies/${this.selected.id}/projects/${row.project_id}`, {
            can_release: wanted,
          });
          await this.loadProjectsPanel();
        } catch (e) {
          row.can_release = !wanted;
          showToast(e.message || "更新失敗", "error", 0);
        } finally {
          const next = { ...this.releaseBusy };
          delete next[row.project_id];
          this.releaseBusy = next;
        }
      },

      // 解除綁定的後果必須在確認對話框裡唸出來——這是本頁三件事之一：
      // 這家公司的每個成員（含他們自己開的任務）會立刻看不到這個專案。
      async unbindProject(row) {
        const n = this.selected.user_count || 0;
        const ok = await confirmDialog({
          title: "解除專案綁定？",
          message: `解除之後，這家公司的 ${n} 位成員將看不到「${row.name}」專案與其中的 ${row.task_count} 張任務，包含他們自己開的任務。\n\n這個動作立即生效。`,
          danger: true,
          confirmText: "解除綁定",
        });
        if (!ok) return;
        this.unbindBusy = { ...this.unbindBusy, [row.project_id]: true };
        try {
          await Api.delete(`admin/companies/${this.selected.id}/projects/${row.project_id}`);
          await this.loadProjectsPanel();
          await this.refreshSelectedFromList(); // project_count 變了
          showToast("已解除綁定", "success");
        } catch (e) {
          showToast(e.message || "解除失敗", "error", 0);
        } finally {
          const next = { ...this.unbindBusy };
          delete next[row.project_id];
          this.unbindBusy = next;
        }
      },

      async saveGit() {
        if (!this.gitForm.pat) return showToast("請輸入 PAT", "error");
        this.savingGit = true;
        this.gitError = "";
        try {
          await Api.put(`admin/companies/${this.selected.id}/git`, {
            pat: this.gitForm.pat,
            login: this.gitForm.login || undefined,
            name: this.gitForm.name || undefined,
            email: this.gitForm.email || undefined,
          });
          this.gitForm.pat = ""; // 存好就清掉，畫面上不留明碼
          await this.refreshSelectedFromList();
          showToast("已更新 GIT 憑證", "success");
        } catch (e) {
          // 後端這裡的錯誤訊息會指名連不上哪個 repo，原文顯示——不要換成「儲存失敗」。
          this.gitError = e.message || "儲存失敗";
        } finally {
          this.savingGit = false;
        }
      },

      async clearGit() {
        const ok = await confirmDialog({
          title: "清除 GIT 憑證？",
          message: `確定清除「${this.selected.name}」的 GIT 憑證？清除後需要重新輸入 PAT 才能再次設定。`,
          danger: true,
          confirmText: "清除",
        });
        if (!ok) return;
        this.clearingGit = true;
        try {
          await Api.delete(`admin/companies/${this.selected.id}/git`);
          this.gitForm = { pat: "", login: "", name: "", email: "" };
          this.gitError = "";
          await this.refreshSelectedFromList();
          showToast("已清除 GIT 憑證", "success");
        } catch (e) {
          showToast(e.message || "清除失敗", "error", 0);
        } finally {
          this.clearingGit = false;
        }
      },
    },
    template: `
      <section class="ui-next-page ui-next-company-admin-page">
        <div v-if="expiringCompanies.length" class="ui-next-subscription-warning" role="status">
          <strong>公司使用期間即將到期</strong>
          <p v-for="c in expiringCompanies" :key="c.id">{{ c.name }}：{{ dateOnly(c.active_until) }} 到期，請確認是否續期。</p>
        </div>
        <template v-if="!selected">
          <header class="ui-next-page-head">
            <div>
              <h1>公司管理</h1>
              <p>建立與管理客戶公司——基本資料、功能開關、綁定的專案、GIT 憑證。</p>
            </div>
            <button class="btn btn-primary btn-sm" @click="createOpen = true">＋ 新增公司</button>
          </header>

          <p v-if="loadError" class="ui-next-error-text">{{ loadError }}</p>

          <div v-else class="settings-section">
            <h2 class="section-title">公司列表（{{ companies.length }}）</h2>
            <div class="table-wrap table-cards-sm">
              <table class="data-table">
                <thead>
                  <tr><th>公司</th><th>狀態</th><th>使用期間</th><th>使用者</th><th>專案</th><th>GIT</th><th></th></tr>
                </thead>
                <tbody v-if="loading">
                  <tr v-for="i in 3" :key="i">
                    <td data-label="公司"><Skeleton width="120px" /></td>
                    <td data-label="狀態"><Skeleton width="50px" /></td>
                    <td data-label="使用期間"><Skeleton width="140px" /></td>
                    <td data-label="使用者"><Skeleton width="30px" /></td>
                    <td data-label="專案"><Skeleton width="30px" /></td>
                    <td data-label="GIT"><Skeleton width="50px" /></td>
                    <td data-label=""><Skeleton width="60px" /></td>
                  </tr>
                </tbody>
                <tbody v-else>
                  <tr v-for="c in companies" :key="c.id">
                    <td data-label="公司" style="font-weight:var(--fw-semibold)">
                      {{ c.name }}
                      <span v-if="c.is_internal" class="pill pill-info" style="margin-left:6px">內部公司</span>
                    </td>
                    <td data-label="狀態">
                      <span class="pill" :class="c.is_active ? 'pill-success' : 'pill-danger'">
                        {{ c.is_active ? '啟用中' : '已停用' }}
                      </span>
                    </td>
                    <td data-label="使用期間">
                      <template v-if="c.active_from || c.active_until">{{ dateOnly(c.active_from) || '—' }} ～ {{ dateOnly(c.active_until) || '—' }}</template>
                      <template v-else>不限期間</template>
                    </td>
                    <td data-label="使用者">{{ c.user_count }}</td>
                    <td data-label="專案">{{ c.project_count }}</td>
                    <td data-label="GIT">
                      <span class="pill" :class="c.has_git_pat ? 'pill-success' : 'pill-warn'">
                        {{ c.has_git_pat ? '已設定' : '未設定' }}
                      </span>
                    </td>
                    <td data-label="">
                      <button class="btn btn-outline btn-sm" @click="openCompany(c)">管理</button>
                    </td>
                  </tr>
                  <tr v-if="companies.length === 0" class="empty-row">
                    <td colspan="7">還沒有任何公司</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="createOpen" class="ui-next-task-modal-backdrop" @click.self="createOpen = false">
            <section class="ui-next-user-create" role="dialog" aria-modal="true" aria-labelledby="ui-next-company-create-title">
              <header><h2 id="ui-next-company-create-title">新增公司</h2><button type="button" @click="createOpen = false" aria-label="關閉新增公司視窗">關閉</button></header>
              <div class="admin-users-form-grid">
                <div class="form-group" style="margin:0">
                  <label>公司名稱</label>
                  <input v-model="newCompany.name" placeholder="客戶公司名稱" class="form-control" />
                </div>
                <div class="form-group" style="margin:0">
                  <label><input type="checkbox" v-model="newCompany.is_active" style="width:auto;margin-right:6px" />建立後立即啟用</label>
                </div>
              </div>
              <footer>
                <button class="btn btn-outline btn-sm" @click="createOpen = false" :disabled="savingCreate">取消</button>
                <button class="btn btn-primary btn-sm" @click="createCompany" :disabled="savingCreate">{{ savingCreate ? '新增中...' : '+ 新增公司' }}</button>
              </footer>
            </section>
          </div>
        </template>

        <template v-else>
          <header class="ui-next-page-head">
            <div>
              <button class="btn btn-outline btn-sm ui-next-company-back" @click="closeCompany">← 返回列表</button>
              <h1>
                {{ selected.name }}
                <span v-if="selected.is_internal" class="pill pill-info">內部公司</span>
              </h1>
              <p v-if="selected.is_internal">內部公司的「內部」標記由後端一次性遷移設定，任何畫面都無法變更，此處僅供辨識。</p>
            </div>
          </header>

          <!-- 四個分頁一比一對應原本直排的四個區塊。切分頁不動任何資料：四份表單都還在
               同一個 component 的 data 裡，v-show 只是藏起來，切回去時填到一半的內容還在。 -->
          <div class="ui-next-page-tabs" role="tablist">
            <button v-for="item in tabs" :key="item.key" type="button" role="tab" :aria-selected="tab===item.key ? 'true' : 'false'" @click="tab=item.key">{{ item.label }}</button>
          </div>

          <p v-if="detailError" class="ui-next-error-text">{{ detailError }}</p>

          <section v-show="tab==='basic'" class="ui-next-panel">
            <h2>基本資料</h2>
            <div class="conn-fields">
              <div class="field-item">
                <label class="field-label">公司名稱</label>
                <input v-model="form.name" class="field-input" />
              </div>
              <div class="field-item field-item-narrow">
                <label class="field-label">啟用狀態</label>
                <label class="ui-next-toggle">
                  <input type="checkbox" v-model="form.is_active">
                  <span></span>啟用</label>
              </div>
              <div class="field-item field-item-narrow">
                <label class="field-label">使用起日</label>
                <input v-model="form.active_from" type="date" class="field-input" />
              </div>
              <div class="field-item field-item-narrow">
                <label class="field-label">使用迄日</label>
                <input v-model="form.active_until" type="date" class="field-input" />
                <span class="ui-next-field-note">目前僅能改成別的日期，無法清空回「不限期間」（後端已知限制）。</span>
              </div>
            </div>
            <div class="ui-next-panel-actions">
              <button class="btn btn-primary btn-sm" :disabled="savingBasic" @click="saveBasic">{{ savingBasic ? '儲存中…' : '儲存基本資料' }}</button>
            </div>
            <template v-if="!selected.is_internal">
              <h2>任務花費上限</h2>
              <p class="ui-next-field-note">每張任務的美元上限；留空表示暫不啟用。超額任務會停下，調高後可繼續。</p>
              <div class="field-item field-item-narrow">
                <label class="field-label" for="admin-company-task-budget">每張任務上限（USD）</label>
                <input id="admin-company-task-budget" v-model="taskBudgetInput" type="number" min="0.01" step="0.01" class="field-input" placeholder="尚未設定" />
              </div>
              <div class="ui-next-panel-actions"><button class="btn btn-primary btn-sm" :disabled="savingBudget" @click="saveTaskBudget">{{ savingBudget ? '儲存中…' : '儲存上限' }}</button></div>
            </template>
          </section>

          <section v-show="tab==='features'" class="ui-next-panel">
            <h2>功能開關</h2>
            <p class="ui-next-field-note">每次儲存會送出下方全部功能目前的狀態——後端整包覆蓋，不是只改被勾動的那一項。</p>
            <label v-for="f in featureDefs" :key="f.key" class="ui-next-toggle">
              <input type="checkbox" v-model="featureForm[f.key]">
              <span></span>{{ f.label }}</label>
            <p v-if="!featureDefs.length" class="ui-next-field-note">目前沒有可設定的功能。</p>
            <div class="ui-next-panel-actions">
              <button class="btn btn-primary btn-sm" :disabled="savingFeatures || !featureDefs.length" @click="saveFeatures">{{ savingFeatures ? '儲存中…' : '儲存功能設定' }}</button>
            </div>
          </section>

          <section v-show="tab==='projects'" class="ui-next-panel">
            <h2>綁定的專案</h2>
            <div class="table-wrap table-cards-sm">
              <table class="data-table">
                <thead><tr><th>專案</th><th>可上正式</th><th>任務數</th><th></th></tr></thead>
                <tbody v-if="projectsLoading">
                  <tr class="empty-row"><td colspan="4">載入中...</td></tr>
                </tbody>
                <tbody v-else>
                  <tr v-for="row in boundProjects" :key="row.project_id">
                    <td data-label="專案">{{ row.name }}</td>
                    <td data-label="可上正式">
                      <!-- 內部公司：後端不接受 can_release=true（400，規格 §4.3），所以這一欄
                           在 DB 裡永遠是 false。但顯示成「關」會讀成「內部公司不能上正式」，那是假的——
                           內部同仁裡有 9 個是平台管理員，而 canReleaseProject 對平台管理員直接回 true，
                           根本不看這個欄位。所以這裡刻意顯示成「開」並停用：畫面講的是「這家公司的人
                           上得了正式」這件事實，不是 DB 欄位的原值。
                           ⚠ 唯一的例外寫在 title 裡：內部公司若有 company_admin，他不吃平台管理員那條
                           捷徑，也就不受這個「開」的保護——那種帳號今天確實存在一個。 -->
                      <label class="ui-next-toggle"
                             :title="selected.is_internal ? '內部公司的成員多半是平台管理員，平台管理員不受這個開關限制，一律上得了正式；這個欄位因此不開放設定。若這家公司有「公司管理員」角色的帳號，他不在此列。' : null">
                        <input type="checkbox" :checked="selected.is_internal ? true : row.can_release"
                               :disabled="!!releaseBusy[row.project_id] || selected.is_internal"
                               @change="toggleCanRelease(row)">
                        <span></span>
                      </label>
                    </td>
                    <td data-label="任務數">{{ row.task_count }}</td>
                    <td data-label="">
                      <button class="btn btn-outline btn-sm" :disabled="!!unbindBusy[row.project_id]" @click="unbindProject(row)">
                        {{ unbindBusy[row.project_id] ? '處理中…' : '解除綁定' }}
                      </button>
                    </td>
                  </tr>
                  <tr v-if="boundProjects.length === 0" class="empty-row">
                    <td colspan="4">還沒有綁定任何專案</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="conn-fields">
              <div class="field-item">
                <label class="field-label">新增綁定</label>
                <select v-model="bindProjectId" class="field-input">
                  <option value="">（選擇專案）</option>
                  <option v-for="p in unboundProjects" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
              </div>
              <div class="field-item field-item-narrow">
                <label class="field-label">可上正式</label>
                <label class="ui-next-toggle">
                  <input type="checkbox" v-model="bindCanRelease" :disabled="selected.is_internal">
                  <span></span>
                  <span v-if="selected.is_internal" class="ui-next-field-note">內部公司的綁定不能勾這個</span>
                </label>
              </div>
            </div>
            <div class="ui-next-panel-actions">
              <button class="btn btn-primary btn-sm" :disabled="binding || !unboundProjects.length" @click="bindProject">
                {{ binding ? '綁定中…' : '綁定' }}
              </button>
            </div>
          </section>

          <section v-show="tab==='git'" class="ui-next-panel">
            <h2>GIT 憑證</h2>
            <p>
              目前狀態：
              <span class="pill" :class="selected.has_git_pat ? 'pill-success' : 'pill-warn'">{{ selected.has_git_pat ? '已設定' : '未設定' }}</span>
              <template v-if="selected.has_git_pat && selected.git_login">（登入：{{ selected.git_login }}）</template>
            </p>
            <p class="ui-next-field-note">
              儲存前後端會實際連線這家公司綁定的每個 repo 驗證這把 PAT，可能需要幾秒鐘；改任何一個欄位都要重新輸入完整 PAT（後端不接受只改個別欄位、也從不回傳密文原文）。
            </p>
            <div class="conn-fields">
              <div class="field-item">
                <label class="field-label">PAT</label>
                <input v-model="gitForm.pat" type="password" class="field-input" placeholder="重新輸入完整 PAT 才會更新" />
              </div>
              <div class="field-item field-item-narrow">
                <label class="field-label">Git 登入帳號</label>
                <input v-model="gitForm.login" class="field-input" />
              </div>
              <div class="field-item field-item-narrow">
                <label class="field-label">Commit 姓名</label>
                <input v-model="gitForm.name" class="field-input" />
              </div>
              <div class="field-item field-item-narrow">
                <label class="field-label">Commit Email</label>
                <input v-model="gitForm.email" class="field-input" />
              </div>
            </div>
            <!-- 這一塊必須是常駐的紅色區塊、而且是後端原文：訊息裡會指名連不上哪個 repo，
                 換成 toast 或「儲存失敗」等於把唯一能查的線索吃掉（見檔頭第 3 點）。 -->
            <div v-if="gitError" class="error-msg">{{ gitError }}</div>
            <div class="ui-next-panel-actions">
              <button class="btn btn-primary btn-sm" :disabled="savingGit" @click="saveGit">{{ savingGit ? '驗證並儲存中…' : '設定／更新 GIT 憑證' }}</button>
              <button v-if="selected.has_git_pat" class="btn btn-outline btn-sm" :disabled="clearingGit" @click="clearGit">{{ clearingGit ? '清除中…' : '清除 GIT 憑證' }}</button>
            </div>
          </section>
        </template>
      </section>
    `,
  });
})();
