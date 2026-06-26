window.AdminUsersView = Vue.defineComponent({
  name: 'AdminUsersView',
  data() {
    return {
      users: [],
      loading: true,
      newUser: { username: '', password: '', display_name: '', role: 'user' },
      savingUser: false,
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
    }
  },
  async created() { await this.loadUsers(); },
  methods: {
    async loadUsers() {
      this.loading = true;
      try { this.users = await Api.get('admin/users'); }
      catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    async addUser() {
      if (!this.newUser.username || !this.newUser.password) return showToast('請填寫帳號和密碼', 'error');
      if (this.newUser.password.length < 8) return showToast('密碼至少 8 個字元', 'error');
      this.savingUser = true;
      try {
        await Api.post('admin/users', { ...this.newUser });
        this.newUser = { username: '', password: '', display_name: '', role: 'user' };
        await this.loadUsers();
        showToast('已新增使用者', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.savingUser = false; }
    },
    async toggleRole(user) {
      const newRole = user.role === 'admin' ? 'user' : 'admin';
      try {
        await Api.put(`admin/users/${user.id}`, { role: newRole });
        await this.loadUsers();
      } catch (e) { showToast(e.message, 'error'); }
    },
    async deleteUser(user) {
      if (!confirm(`確定刪除使用者「${user.display_name || user.username}」？`)) return;
      try {
        await Api.delete(`admin/users/${user.id}`);
        await this.loadUsers();
        showToast('已刪除使用者', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/admin')" style="margin-right:12px">← 返回</button>
      <h1>使用者管理</h1>
    </div>
    <div class="content">
      <div v-if="loading" class="loading">載入中...</div>
      <div v-else style="max-width:900px">

        <!-- 搜尋 -->
        <div style="margin-bottom:16px">
          <input v-model="search" placeholder="搜尋帳號或顯示名稱..." class="form-control" style="max-width:320px" />
        </div>

        <!-- 使用者列表 -->
        <div class="admin-section" style="margin-bottom:20px">
          <h2 class="section-title">使用者列表（{{ filteredUsers.length }}）</h2>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="border-bottom:1px solid var(--border);text-align:left">
                <th style="padding:8px 10px">帳號</th>
                <th style="padding:8px 10px">顯示名稱</th>
                <th style="padding:8px 10px">角色</th>
                <th style="padding:8px 10px">建立時間</th>
                <th style="padding:8px 10px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in filteredUsers" :key="u.id" style="border-bottom:1px solid var(--border)">
                <td style="padding:8px 10px;font-weight:600">{{ u.username }}</td>
                <td style="padding:8px 10px">{{ u.display_name }}</td>
                <td style="padding:8px 10px">
                  <span :style="{ color: u.role === 'admin' ? 'var(--sidebar-accent)' : 'var(--text-muted)', fontWeight: 600 }">
                    {{ u.role === 'admin' ? '管理員' : '一般' }}
                  </span>
                </td>
                <td style="padding:8px 10px;font-size:12px;color:var(--text-muted)">
                  {{ new Date(u.created_at).toLocaleDateString('zh-TW') }}
                </td>
                <td style="padding:8px 10px">
                  <div style="display:flex;gap:6px">
                    <button class="btn btn-outline btn-sm" @click="toggleRole(u)">
                      {{ u.role === 'admin' ? '降為一般' : '升為管理員' }}
                    </button>
                    <button class="btn btn-outline btn-sm" style="color:var(--error)" @click="deleteUser(u)">刪除</button>
                  </div>
                </td>
              </tr>
              <tr v-if="filteredUsers.length === 0">
                <td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted)">沒有符合的使用者</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 新增使用者 -->
        <div class="admin-section">
          <h2 class="section-title">新增使用者</h2>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
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
                <option value="admin">管理員</option>
              </select>
            </div>
          </div>
          <button class="btn btn-primary btn-sm" @click="addUser" :disabled="savingUser">
            {{ savingUser ? '新增中...' : '+ 新增使用者' }}
          </button>
        </div>

      </div>
    </div>
  `
});
