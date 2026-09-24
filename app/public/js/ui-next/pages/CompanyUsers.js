(function () {
  // 公司管理員管自家帳號（規格 §5.3、§8 P6，後端 company-routes.js 3a Task 6 已上線）。
  //
  // 外殼用 .ui-next-page／.ui-next-page-head（跟任務列表、用量報表同一套），不是
  // .topbar + .content：那個殼是給 /admin/* 子頁的，這頁不在 /admin 底下（見 ExamBank.js
  // 同款理由的註解）。
  //
  // 三個坑，任一個漏了都是回頭工：
  // 1. 沒有刪除端點（規格 §8 P6：只能停用，刪除會讓帳號建過的任務／留過的訊息失去歸屬）。
  //    畫面上不放「刪除」字樣，也不用垃圾桶圖示做停用——那個圖示暗示資料會不見。
  // 2. 停用是「approved 設 false」，verifyToken 每次請求都查 DB 的這個欄位，所以停用
  //    會立即讓對方手上還沒過期的 token 失效，不是「下次登入才擋」。確認文字必須講清楚。
  // 3. 角色只能在 user／company_admin 之間切，不能出現 admin 選項——後端 ASSIGNABLE
  //    白名單本來就會拒絕，但畫面不該讓人以為可以選、送出後才被拒。
  window.UiNextCompanyUsersView = Vue.defineComponent({
    name: "UiNextCompanyUsersView",
    data() {
      return {
        users: [],
        loading: true,
        loadError: "",
        newUser: { username: "", password: "", display_name: "", role: "user" },
        savingUser: false,
        addUserOpen: false,
        taskBudgetInput: "",
        internalCompany: false,
        activeUntil: null,
        savingBudget: false,
        // Claude 認證憑證：只存「有沒有設」，永遠不放原文（後端也不回傳）
        keyConfigured: false,
        keyStatusError: "",   // 讀不到狀態時不可以顯示成「未設定」
        keyInput: "",
        savingKey: false,
        clearingKey: false,
        keyError: "",
      };
    },
    computed: {
      expiryWarning() {
        if (this.internalCompany || !this.activeUntil) return false;
        const remaining = new Date(this.activeUntil).getTime() - Date.now();
        return remaining > 0 && remaining <= 14 * 86400000;
      },
    },
    async created() { await this.loadUsers(); },
    methods: {
      async loadUsers() {
        this.loading = true;
        this.loadError = "";
        try {
          // 不帶任何公司參數：後端一律從 req.actor 取自己的公司，帶了也不算數（規格重點）。
          const [users, budget, subscription] = await Promise.all([
            Api.get("company/users"), Api.get("company/task-budget"), Api.get("company/subscription"),
          ]);
          this.users = users;
          this.taskBudgetInput = budget.task_budget_usd == null ? "" : String(budget.task_budget_usd);
          this.internalCompany = !!budget.is_internal;
          this.activeUntil = subscription.active_until;
        } catch (e) {
          this.loadError = e.message || "無法載入帳號列表";
        } finally {
          this.loading = false;
        }
        // ⚠ key 狀態**刻意不併進上面那個 Promise.all**：併進去的話，這一支失敗會讓
        // 整頁只剩一行錯誤——帳號列表、花費上限全部不見。實測過（新端點還沒上線時
        // 回 404，整頁變成紅字 Not found）。這一塊壞掉只該讓這一塊壞掉。
        try {
          const key = await Api.get("company/anthropic-key");
          this.keyConfigured = !!key.configured;
          this.keyStatusError = "";
        } catch (e) {
          // 不知道有沒有設定時，不可以顯示成「未設定」——那會讓人以為要重貼一把。
          this.keyStatusError = e.message || "無法讀取憑證狀態";
        }
      },
      async saveTaskBudget() {
        const amount = String(this.taskBudgetInput).trim() === "" ? null : Number(this.taskBudgetInput);
        if (amount !== null && (!Number.isFinite(amount) || amount < 0.01 || Math.abs(amount * 100 - Math.round(amount * 100)) >= 1e-8)) {
          return showToast("請輸入正數美元金額，最多小數兩位；留空表示不設定上限", "error");
        }
        this.savingBudget = true;
        try {
          const result = await Api.put("company/task-budget", { task_budget_usd: amount });
          this.taskBudgetInput = result.task_budget_usd == null ? "" : String(result.task_budget_usd);
          showToast("已儲存任務花費上限", "success");
        } catch (e) { showToast(e.message || "儲存任務花費上限失敗", "error"); }
        finally { this.savingBudget = false; }
      },
      // 客戶自己換 key（2026-09-24 裁決「兩邊都要能填」）。key 會過期、會旋轉，
      // 每次都要找平台代填等於把客戶卡在我們的工時上。
      async saveKey() {
        if (!this.keyInput) return showToast("請貼上 Claude 認證憑證", "error");
        this.savingKey = true;
        this.keyError = "";
        try {
          // 不帶任何公司參數：後端一律從 req.actor 取自己的公司（同 task-budget）。
          const r = await Api.put("company/anthropic-key", { api_key: this.keyInput });
          this.keyInput = "";          // 存好就清掉，畫面上不留明碼
          this.keyConfigured = true;
          // warning＝存進去了但沒驗成功。「已儲存」與「已儲存且驗過」是兩件事，要講出來。
          showToast(r && r.warning ? r.warning : "已更新憑證", r && r.warning ? "error" : "success");
        } catch (e) {
          this.keyError = e.message || "儲存失敗";
        } finally { this.savingKey = false; }
      },
      async clearKey() {
        const ok = await confirmDialog({
          title: "清除 Claude 認證憑證？",
          message: "清除後貴公司的 AI 會直接停止運作，直到重新設定為止。",
          danger: true,
          confirmText: "清除",
        });
        if (!ok) return;
        this.clearingKey = true;
        try {
          await Api.delete("company/anthropic-key");
          this.keyConfigured = false;
          this.keyInput = "";
          this.keyError = "";
          showToast("已清除憑證", "success");
        } catch (e) { showToast(e.message || "清除失敗", "error", 0); }
        finally { this.clearingKey = false; }
      },
      async addUser() {
        if (!this.newUser.username || !this.newUser.password) return showToast("請填寫帳號和密碼", "error");
        if (this.newUser.password.length < 8) return showToast("密碼至少 8 個字元", "error");
        this.savingUser = true;
        try {
          // 同上：這裡完全不送 company_id——連個佔位鍵都不留，避免下一個讀這段程式的人
          // 以為改個數字就能指定公司。
          await Api.post("company/users", { ...this.newUser });
          this.newUser = { username: "", password: "", display_name: "", role: "user" };
          this.addUserOpen = false;
          await this.loadUsers();
          showToast("已新增帳號", "success");
        } catch (e) { showToast(e.message, "error"); }
        finally { this.savingUser = false; }
      },
      async toggleRole(user) {
        const newRole = user.role === "company_admin" ? "user" : "company_admin";
        const verb = newRole === "company_admin" ? "升為公司管理員" : "降為一般使用者";
        if (!await confirmDialog({ title: "變更權限", message: `確定將「${user.display_name || user.username}」${verb}？`, confirmText: "確定" })) return;
        try {
          await Api.put(`company/users/${user.id}`, { role: newRole });
          await this.loadUsers();
          showToast(`已${verb}`, "success");
        } catch (e) { showToast(e.message, "error"); }
      },
      // 停用：確認文字必須講清楚「立即」——這個帳號手上還沒過期的登入憑證會馬上失效，
      // 不是下次登入才擋。少講這一句，管理員會以為同事還能撐完手上的工作再被踢出。
      async toggleActive(user) {
        const active = user.approved === false;
        if (active) {
          if (!await confirmDialog({
            title: "啟用帳號",
            message: `確定啟用「${user.display_name || user.username}」？啟用後即可登入使用。`,
            confirmText: "啟用",
          })) return;
        } else {
          if (!await confirmDialog({
            title: "停用帳號",
            message: `確定停用「${user.display_name || user.username}」？\n\n停用會立即讓這個帳號現有的登入失效——即使他手上的登入還沒過期、正在操作中，也會馬上被踢出，不是等他下次登入才擋。\n\n停用不會刪除他建立的任務或留下的訊息，之後仍可重新啟用。`,
            danger: true,
            confirmText: "停用",
          })) return;
        }
        try {
          await Api.put(`company/users/${user.id}/active`, { active });
          await this.loadUsers();
          showToast(active ? "已啟用" : "已停用", "success");
        } catch (e) { showToast(e.message, "error"); }
      },
    },
    template: `
      <section class="ui-next-page ui-next-company-users-page">
        <header class="ui-next-page-head">
          <div>
            <h1>公司帳號</h1>
            <p>管理自家公司的帳號——新增、調整角色、停用／啟用。看不到其他公司的帳號。</p>
          </div>
          <button class="btn btn-primary btn-sm" @click="addUserOpen = true">＋ 新增帳號</button>
        </header>

        <div v-if="expiryWarning" class="ui-next-subscription-warning" role="status">
          <strong>公司使用期間即將到期</strong>
          <p>{{ String(activeUntil).slice(0, 10) }} 到期，請聯絡平台管理員續期。</p>
        </div>

        <p v-if="loadError" class="ui-next-error-text">{{ loadError }}</p>

        <div v-if="!loading && !loadError && !internalCompany" class="settings-section">
          <h2 class="section-title">任務花費上限</h2>
          <p class="ui-next-field-note">每張任務的美元上限；留空表示暫不啟用。已達上限的任務會停下來，調高後可按繼續。</p>
          <div class="field-item field-item-narrow">
            <label class="field-label" for="company-task-budget">每張任務上限（USD）</label>
            <input id="company-task-budget" v-model="taskBudgetInput" type="number" min="0.01" step="0.01" class="field-input" placeholder="尚未設定" />
          </div>
          <div class="ui-next-panel-actions"><button class="btn btn-primary btn-sm" :disabled="savingBudget" @click="saveTaskBudget">{{ savingBudget ? '儲存中…' : '儲存上限' }}</button></div>
        </div>

        <!-- 排在花費上限後面：兩者都是「貴公司的 AI 花費」設定，放一起才找得到。
             內部公司不顯示（後端也會擋）——內部用平台訂閱，沒有自己的 key。 -->
        <div v-if="!loading && !loadError && !internalCompany" class="settings-section">
          <h2 class="section-title">Claude 認證憑證</h2>
          <p class="ui-next-field-note">
            目前狀態：
            <span v-if="keyStatusError" class="pill pill-warn">讀不到狀態</span>
            <span v-else class="pill" :class="keyConfigured ? 'pill-success' : 'pill-warn'">{{ keyConfigured ? '已設定' : '未設定' }}</span>
          </p>
          <div v-if="keyStatusError" class="error-msg">{{ keyStatusError }}</div>
          <p class="ui-next-field-note">
            貴公司的 AI 用量算在這把憑證所屬的 Claude 訂閱上。憑證請在貴公司的電腦上執行 <code>claude setup-token</code> 產生（<strong>不是</strong> Console 開的按量計費 API key）。儲存前系統會拿它實跑一次驗證，可能需要幾秒到一分鐘；系統從不回傳已儲存的憑證，要更換請重新貼上完整的一把。
          </p>
          <p class="ui-next-field-note">
            <strong>沒有設定或清除之後，貴公司的 AI 會直接停止運作。</strong>
          </p>
          <div class="field-item">
            <label class="field-label" for="company-anthropic-key">Claude 認證憑證</label>
            <input id="company-anthropic-key" v-model="keyInput" type="password" class="field-input" placeholder="重新貼上完整的憑證才會更新" />
          </div>
          <div v-if="keyError" class="error-msg">{{ keyError }}</div>
          <div class="ui-next-panel-actions">
            <button class="btn btn-primary btn-sm" :disabled="savingKey" @click="saveKey">{{ savingKey ? '驗證並儲存中…' : '儲存憑證' }}</button>
            <button v-if="keyConfigured" class="btn btn-outline btn-sm" :disabled="clearingKey" @click="clearKey">{{ clearingKey ? '清除中…' : '清除憑證' }}</button>
          </div>
        </div>

        <div v-if="!loadError" class="settings-section">
          <h2 class="section-title">帳號列表（{{ users.length }}）</h2>
          <div class="table-wrap table-cards-sm">
            <table class="data-table">
              <thead>
                <tr><th>帳號</th><th>顯示名稱</th><th>角色</th><th>狀態</th><th>操作</th></tr>
              </thead>
              <tbody v-if="loading">
                <tr v-for="i in 3" :key="i">
                  <td data-label="帳號"><Skeleton width="90px" /></td>
                  <td data-label="顯示名稱"><Skeleton width="110px" /></td>
                  <td data-label="角色"><Skeleton width="70px" /></td>
                  <td data-label="狀態"><Skeleton width="50px" /></td>
                  <td data-label="操作"><Skeleton width="140px" /></td>
                </tr>
              </tbody>
              <tbody v-else>
                <tr v-for="u in users" :key="u.id">
                  <td data-label="帳號" style="font-weight:var(--fw-semibold)">{{ u.username }}</td>
                  <td data-label="顯示名稱">{{ u.display_name }}</td>
                  <td data-label="角色">{{ u.role === 'company_admin' ? '公司管理員' : '一般使用者' }}</td>
                  <td data-label="狀態">
                    <span class="pill" :class="u.approved === false ? 'pill-danger' : 'pill-success'">
                      {{ u.approved === false ? '已停用' : '使用中' }}
                    </span>
                  </td>
                  <td data-label="操作">
                    <div class="admin-users-row-actions">
                      <button class="btn btn-outline btn-sm" @click="toggleRole(u)">
                        {{ u.role === 'company_admin' ? '降為一般' : '升為管理員' }}
                      </button>
                      <button class="btn btn-outline btn-sm" @click="toggleActive(u)">
                        {{ u.approved === false ? '啟用' : '停用' }}
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="users.length === 0" class="empty-row">
                  <td colspan="5">還沒有其他帳號</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="addUserOpen" class="ui-next-task-modal-backdrop" @click.self="addUserOpen = false">
          <section class="ui-next-user-create" role="dialog" aria-modal="true" aria-labelledby="ui-next-company-user-create-title">
            <header><h2 id="ui-next-company-user-create-title">新增帳號</h2><button type="button" @click="addUserOpen = false" aria-label="關閉新增帳號視窗">關閉</button></header>
            <div class="admin-users-form-grid">
              <div class="form-group" style="margin:0">
                <label>帳號</label>
                <input v-model="newUser.username" placeholder="username" class="form-control" />
              </div>
              <div class="form-group" style="margin:0">
                <label>顯示名稱</label>
                <input v-model="newUser.display_name" placeholder="王小明" class="form-control" />
              </div>
              <div class="form-group" style="margin:0">
                <label>密碼（至少 8 碼）</label>
                <input v-model="newUser.password" type="password" placeholder="••••••••" class="form-control" />
              </div>
              <div class="form-group" style="margin:0">
                <label>角色</label>
                <!-- 只有這兩個選項：後端 ASSIGNABLE 白名單本來就會擋 admin，這裡不列出來，
                     避免使用者選了才被拒——畫面不該暗示自己能建平台管理員。 -->
                <select v-model="newUser.role" class="form-control">
                  <option value="user">一般使用者</option>
                  <option value="company_admin">公司管理員</option>
                </select>
              </div>
            </div>
            <footer>
              <button class="btn btn-outline btn-sm" @click="addUserOpen = false" :disabled="savingUser">取消</button>
              <button class="btn btn-primary btn-sm" @click="addUser" :disabled="savingUser">{{ savingUser ? '新增中...' : '+ 新增帳號' }}</button>
            </footer>
          </section>
        </div>
      </section>
    `,
  });
})();
