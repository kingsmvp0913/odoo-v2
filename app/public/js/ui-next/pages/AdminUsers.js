(function () {
  window.UiNextAdminUsersView = Vue.defineComponent({
    name: "UiNextAdminUsersView",
    data() {
      return {
        users: [],
        locks: [],
        loading: true,
        newUser: { username: '', password: '', display_name: '', role: 'user', company_id: null },
        savingUser: false,
        addUserOpen: false,
        // 公司清單：建帳號與改角色都必須指定公司，兩處共用這一份。
        companies: [],
        companiesError: '',
        // 變更角色的小視窗。原本是 user↔admin 的兩段切換，三個角色表達不了；
        // 而且改成 user／company_admin 時一定要同時指定公司，一顆切換鈕塞不下。
        roleEdit: null, // { user, role, company_id }
        savingRole: false,
        search: ''
      };
    },
    computed: {
      filteredUsers() {
        const q = this.search.toLowerCase();
        if (!q) return this.users;
        return this.users.filter(u =>
          u.username.toLowerCase().includes(q) || u.display_name.toLowerCase().includes(q)
        );
      },
      // 每個帳號目前有幾個來源被鎖／被封鎖。後端 listLocks 已經濾掉自然過期的，這裡不用再判時間。
      lockMap() {
        const m = {};
        for (const l of this.locks) {
          if (!m[l.username]) m[l.username] = { locked: 0, blocked: 0, sources: [] };
          if (l.blocked) m[l.username].blocked += 1; else m[l.username].locked += 1;
          m[l.username].sources.push(l);
        }
        return m;
      }
    },
    async created() { await Promise.all([this.loadUsers(), this.loadLocks(), this.loadCompanies()]); },
    methods: {
      async loadUsers() {
        this.loading = true;
        try { this.users = await Api.get('admin/users'); }
        catch (e) { showToast(e.message, 'error'); }
        finally { this.loading = false; }
      },
      // 登入鎖定：鎖的是 (帳號, 來源) 這一對，所以同一個帳號可能同時有好幾個來源被鎖
      async loadLocks() {
        try { this.locks = await Api.get('admin/login-locks'); }
        catch (e) { showToast(e.message, 'error'); }
      },
      // 公司清單沿用公司管理頁（CompanyAdmin.js）用的同一個端點，不另開新的——
      // 兩頁的公司若來自不同來源，就會出現「那邊建好的公司這裡選不到」。
      async loadCompanies() {
        try { this.companies = await Api.get('admin/companies'); }
        catch (e) { this.companiesError = e.message || '無法載入公司清單'; }
      },
      // 三個角色的中文名只有這一份。company_admin 的字面照抄 CompanyUsers.js 的角色下拉，
      // 同一個角色不能在兩個畫面叫兩個名字。admin 叫「平台管理員」而不是舊的「管理員」：
      // 有了公司管理員之後，「管理員」三個字已經分不出是哪一種。
      roleLabel(role) {
        if (role === 'admin') return '平台管理員';
        if (role === 'company_admin') return '公司管理員';
        return '一般使用者';
      },
      companyName(id) {
        const co = this.companies.find(c => c.id === id);
        return co ? co.name : '';
      },
      async unlock(user) {
        const info = this.lockMap[user.username];
        if (!info) return;
        const list = info.sources
          .map(s => `${s.source}（${s.blocked ? '已封鎖' : '鎖定中'}，錯 ${s.fail_count} 次）`)
          .join('\n');
        if (!await confirmDialog({
          title: '解除登入鎖定',
          message: `確定解除「${user.display_name || user.username}」的登入鎖定？\n\n${list}`,
          confirmText: '解除'
        })) return;
        try {
          for (const s of info.sources) {
            const qs = `username=${encodeURIComponent(user.username)}&source=${encodeURIComponent(s.source)}`;
            await Api.delete(`admin/login-locks?${qs}`);
          }
          await this.loadLocks();
          showToast('已解除登入鎖定', 'success');
        } catch (e) { showToast(e.message, 'error'); }
      },
      async addUser() {
        if (!this.newUser.username || !this.newUser.password) return showToast('請填寫帳號和密碼', 'error');
        if (this.newUser.password.length < 8) return showToast('密碼至少 8 個字元', 'error');
        // 角色↔公司的規則由後端 lib/tenant-access.js 的 validateRoleCompany 說了算，
        // 這裡只是把「一定會被拒絕」的組合擋在表單內：少這一道，使用者按下送出只會收到一個 400 toast。
        if (this.newUser.role !== 'admin' && !this.newUser.company_id) return showToast('請選擇所屬公司', 'error');
        this.savingUser = true;
        try {
          const { username, password, display_name, role, company_id } = this.newUser;
          const payload = { username, password, display_name, role };
          // 平台管理員不能屬於任何公司，連 company_id 這個鍵都不送出去——
          // 表單殘留的舊值若跟著送，後端會直接回「平台管理員不能屬於任何公司」。
          if (role !== 'admin') payload.company_id = company_id;
          await Api.post('admin/users', payload);
          this.newUser = { username: '', password: '', display_name: '', role: 'user', company_id: null };
          this.addUserOpen = false;
          await this.loadUsers();
          showToast('已新增使用者', 'success');
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.savingUser = false; }
      },
      // 列表端點（GET /api/admin/users）現在回 company_id（LEFT JOIN companies），
      // 所以預選得出「他現在在哪家公司」。原本一律留空是因為那個欄位當時拿不到，
      // 逼得管理員只改角色也得把公司重挑一次——重挑才是真正會把人搬去別家公司的那一步。
      openRoleEdit(user) {
        this.roleEdit = { user, role: user.role, company_id: user.company_id || null };
      },
      async submitRoleEdit() {
        const { user, role, company_id } = this.roleEdit;
        if (role !== 'admin' && !company_id) return showToast('請選擇所屬公司', 'error');
        const label = this.roleLabel(role);
        const who = user.display_name || user.username;
        // 改別人的權限一律先問一次：改完立刻生效，沒有復原鍵。
        const co = role === 'admin' ? '' : `\n\n所屬公司：${this.companyName(company_id)}`;
        if (!await confirmDialog({ title: '變更角色', message: `確定將「${who}」改為${label}？${co}`, confirmText: '確定' })) return;
        this.savingRole = true;
        try {
          // company_id 一定要送：後端看的是「body 裡有沒有這個鍵」，沒帶＝沿用舊公司。
          // 升成平台管理員時得明確送 null 才會把舊公司清掉，否則會被擋成
          // 「平台管理員不能屬於任何公司」。
          await Api.put(`admin/users/${user.id}`, { role, company_id: role === 'admin' ? null : company_id });
          this.roleEdit = null;
          await this.loadUsers();
          showToast(`已改為${label}`, 'success');
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.savingRole = false; }
      },
      // 自助註冊已經關閉，approved=false 只剩一個意思：被公司管理員停用（詞彙與
      // CompanyUsers.js 同一套）。這頁原本只有單向的「核准」：平台管理員一按就把對方公司
      // 剛停用的人放回來，而且這頁沒有任何反向動作收得回去，所以啟用與停用必須成對。
      async toggleActive(user) {
        const active = user.approved === false;
        if (active) {
          if (!await confirmDialog({
            title: '啟用帳號',
            message: `確定啟用「${user.display_name || user.username}」？啟用後即可登入使用。\n\n這個帳號多半是被他們自己公司的管理員停用的——啟用等於推翻那個決定。`,
            confirmText: '啟用',
          })) return;
        } else {
          if (!await confirmDialog({
            title: '停用帳號',
            message: `確定停用「${user.display_name || user.username}」？\n\n停用會立即讓這個帳號現有的登入失效——即使他手上的登入還沒過期、正在操作中，也會馬上被踢出，不是等他下次登入才擋。\n\n停用不會刪除他建立的任務或留下的訊息，之後仍可重新啟用。`,
            danger: true,
            confirmText: '停用',
          })) return;
        }
        try {
          // 只送 approved：後端 PUT 沒帶 role／company_id 就沿用舊值，不會順手動到歸屬。
          await Api.put(`admin/users/${user.id}`, { approved: active });
          await this.loadUsers();
          showToast(active ? '已啟用' : '已停用', 'success');
        } catch (e) { showToast(e.message, 'error'); }
      },
      async deleteUser(user) {
        if (!await confirmDialog({ title: '刪除使用者', message: `確定刪除使用者「${user.display_name || user.username}」？`, danger: true, confirmText: '刪除' })) return;
        try {
          await Api.delete(`admin/users/${user.id}`);
          await this.loadUsers();
          showToast('已刪除使用者', 'success');
        } catch (e) { showToast(e.message, 'error'); }
      }
    },
    template: `
      <div class="topbar ui-next-admin-head">
        <h1>使用者管理</h1>
        <div class="ui-next-admin-head-actions"><button class="btn btn-primary btn-sm" @click="addUserOpen=true">＋ 新增</button><button class="btn btn-outline btn-sm" @click="$router.push('/admin')">← 返回</button></div>
      </div>
      <div class="content">
        <div v-if="loading" class="admin-users-list">
          <div class="settings-section">
            <h2 class="section-title">使用者列表</h2>
            <!-- 載入態與載入完的表要走同一種手機版型（table-cards-sm），否則骨架先排成
                 橫捲的五欄表、資料一到又整個跳成卡片。既然卡片化，每個 td 就得帶 data-label
                 ——屬性缺席時 ::before 仍佔位，那 88px 的欄名縮排會空在骨架左邊。 -->
            <div class="table-wrap table-cards-sm">
              <table class="data-table">
                <thead><tr><th>帳號</th><th>顯示名稱</th><th>角色</th><th>所屬公司</th><th>建立時間</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="i in 4" :key="i">
                    <td data-label="帳號"><Skeleton width="90px" /></td>
                    <td data-label="顯示名稱"><Skeleton width="110px" /></td>
                    <td data-label="角色"><Skeleton width="50px" /></td>
                    <td data-label="所屬公司"><Skeleton width="70px" /></td>
                    <td data-label="建立時間"><Skeleton width="80px" /></td>
                    <td data-label="操作"><Skeleton width="140px" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div v-else class="admin-users-list">

          <!-- 搜尋 -->
          <div style="margin-bottom:var(--space-4)">
            <input v-model="search" placeholder="搜尋帳號或顯示名稱..." class="form-control admin-users-search-input" />
          </div>

          <!-- 使用者列表 -->
          <div class="settings-section" style="margin-bottom:var(--space-5)">
            <h2 class="section-title">使用者列表（{{ filteredUsers.length }}）</h2>
            <div class="table-wrap table-cards-sm">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>帳號</th>
                    <th>顯示名稱</th>
                    <th>角色</th>
                    <th>所屬公司</th>
                    <th>建立時間</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="u in filteredUsers" :key="u.id">
                    <td data-label="帳號" style="font-weight:var(--fw-semibold)">{{ u.username }}</td>
                    <td data-label="顯示名稱">{{ u.display_name }}</td>
                    <td data-label="角色">
                      <span :style="{ color: u.role === 'admin' ? 'var(--sidebar-accent)' : 'var(--text-muted)', fontWeight: 'var(--fw-semibold)' }">
                        {{ roleLabel(u.role) }}
                      </span>
                      <!-- 自助註冊已關閉，approved=false 只剩「被公司管理員停用」一個意思。
                           說成「待審核」會讓平台管理員以為這是等他處理的新申請。 -->
                      <span v-if="u.approved === false" class="pill pill-danger" style="margin-left:6px">已停用</span>
                      <!-- 登入鎖定：鎖的是 (帳號, 來源) 這一對，所以顯示的是「幾個來源」而非布林 -->
                      <span v-if="lockMap[u.username] && lockMap[u.username].locked" class="pill pill-warn" style="margin-left:6px">鎖定 {{ lockMap[u.username].locked }}</span>
                      <span v-if="lockMap[u.username] && lockMap[u.username].blocked" class="pill pill-danger" style="margin-left:6px">封鎖 {{ lockMap[u.username].blocked }}</span>
                    </td>
                    <!-- 平台管理員沒有公司是設計如此（validateRoleCompany：admin 必須沒有公司），
                         所以寫成「全平台」而不是留白或破折號——留白讀起來像資料掉了。
                         反過來說，非管理員沒有公司才真的是壞資料（後端現在建不出這種帳號，
                         只可能是遷移前的殘留），那個才該標紅要人去處理。 -->
                    <td data-label="所屬公司">
                      <span v-if="u.role === 'admin'" style="color:var(--text-muted)">全平台</span>
                      <span v-else-if="u.company_name">{{ u.company_name }}</span>
                      <span v-else class="pill pill-danger">未指定公司</span>
                    </td>
                    <td data-label="建立時間" style="font-size:var(--fs-sm);color:var(--text-muted)">
                      {{ new Date(u.created_at).toLocaleDateString('zh-TW') }}
                    </td>
                    <td data-label="操作">
                      <div class="admin-users-row-actions">
                        <button class="btn btn-outline btn-sm" @click="openRoleEdit(u)">變更角色</button>
                        <button class="btn btn-outline btn-sm" @click="toggleActive(u)">
                          {{ u.approved === false ? '啟用' : '停用' }}
                        </button>
                        <button v-if="lockMap[u.username]" class="btn btn-outline btn-sm" @click="unlock(u)">解除鎖定</button>
                        <button class="btn btn-outline btn-sm" style="color:var(--error)" @click="deleteUser(u)">刪除</button>
                      </div>
                    </td>
                  </tr>
                  <tr v-if="filteredUsers.length === 0" class="empty-row">
                    <td colspan="6">沒有符合的使用者</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="addUserOpen" class="ui-next-task-modal-backdrop" @click.self="addUserOpen=false">
          <section class="ui-next-user-create" role="dialog" aria-modal="true" aria-labelledby="ui-next-user-create-title">
            <header><h2 id="ui-next-user-create-title">新增使用者</h2><button type="button" @click="addUserOpen=false" aria-label="關閉新增使用者視窗">關閉</button></header>
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
                <select v-model="newUser.role" class="form-control">
                  <option value="user">一般使用者</option>
                  <option value="company_admin">公司管理員</option>
                  <option value="admin">平台管理員</option>
                </select>
              </div>
              <!-- 公司選單只在非平台管理員時出現：後端規定平台管理員不能屬於任何公司，
                   留著它只是讓人選了之後才被 400 打回來。 -->
              <div v-if="newUser.role !== 'admin'" class="form-group" style="margin:0">
                <label>所屬公司</label>
                <select v-model="newUser.company_id" class="form-control">
                  <option :value="null">請選擇公司</option>
                  <option v-for="c in companies" :key="c.id" :value="c.id">{{ c.name }}</option>
                </select>
                <p v-if="companiesError" class="ui-next-error-text">{{ companiesError }}</p>
              </div>
            </div>
            <footer><button class="btn btn-outline btn-sm" @click="addUserOpen=false" :disabled="savingUser">取消</button><button class="btn btn-primary btn-sm" @click="addUser" :disabled="savingUser">
              {{ savingUser ? '新增中...' : '+ 新增使用者' }}
            </button></footer>
          </section></div>

          <!-- 變更角色：三個角色＋公司一起改。後端看的是「body 有沒有 company_id 這個鍵」，
               所以這個視窗送出時一定帶著它。 -->
          <div v-if="roleEdit" class="ui-next-task-modal-backdrop" @click.self="roleEdit=null">
          <section class="ui-next-user-create" role="dialog" aria-modal="true" aria-labelledby="ui-next-user-role-title">
            <header><h2 id="ui-next-user-role-title">變更角色</h2><button type="button" @click="roleEdit=null" aria-label="關閉變更角色視窗">關閉</button></header>
            <div class="admin-users-form-grid">
              <div class="form-group" style="margin:0">
                <label>帳號</label>
                <p style="margin:0;font-weight:var(--fw-semibold)">{{ roleEdit.user.display_name || roleEdit.user.username }}</p>
              </div>
              <div class="form-group" style="margin:0">
                <label>角色</label>
                <select v-model="roleEdit.role" class="form-control">
                  <option value="user">一般使用者</option>
                  <option value="company_admin">公司管理員</option>
                  <option value="admin">平台管理員</option>
                </select>
              </div>
              <!-- 目前的公司由 openRoleEdit 從列表的 company_id 預選好，只改角色時不必重挑。 -->
              <div v-if="roleEdit.role !== 'admin'" class="form-group" style="margin:0">
                <label>所屬公司</label>
                <select v-model="roleEdit.company_id" class="form-control">
                  <option :value="null">請選擇公司</option>
                  <option v-for="c in companies" :key="c.id" :value="c.id">{{ c.name }}</option>
                </select>
                <p v-if="companiesError" class="ui-next-error-text">{{ companiesError }}</p>
              </div>
            </div>
            <footer><button class="btn btn-outline btn-sm" @click="roleEdit=null" :disabled="savingRole">取消</button><button class="btn btn-primary btn-sm" @click="submitRoleEdit" :disabled="savingRole">
              {{ savingRole ? '變更中...' : '確定變更' }}
            </button></footer>
          </section></div>

        </div>
      </div>
    `
  });
})();
