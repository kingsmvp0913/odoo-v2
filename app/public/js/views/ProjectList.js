window.ProjectListView = Vue.defineComponent({
  name: 'ProjectListView',
  data() {
    return {
      projects: [],
      loading: true,
      search: '',
      showAddForm: false,
      newProject: { name: '', folder_name: '', odoo_version: '', description: '', edition: 'community' },
      saving: false,
      releaseId: null   // 開著上正式彈窗的專案 id
    };
  },
  computed: {
    // 新手教程要有一張專案卡可以指，但新帳號一個專案都沒有 → 教程開著時插一張示範專案
    // （只在畫面上，不進 this.projects，也不會被送出或刪除）。刪掉 tour-demo.js 即自動消失。
    allProjects() {
      // 我的最愛置頂：stable sort，同組內維持後端回傳的 name ASC 次序。
      const sorted = [...this.projects].sort((a, b) => (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0));
      const demo = window.TourDemo;
      return demo && demo.active ? [demo.project(), ...sorted] : sorted;
    },
    filteredProjects() {
      const q = this.search.toLowerCase();
      if (!q) return this.allProjects;
      return this.allProjects.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        p.odoo_version.toLowerCase().includes(q)
      );
    }
  },
  async created() { await this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try {
        this.projects = await Api.get('projects');
        for (const p of this.projects) {
          UnreadStore.byProject[String(p.id)] = p.unread_count || 0;
        }
      }
      catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    async add() {
      if (!this.newProject.name || !this.newProject.odoo_version) return showToast('請填寫專案名稱和版本', 'error');
      this.saving = true;
      try {
        await Api.post('projects', { ...this.newProject });
        this.newProject = { name: '', folder_name: '', odoo_version: '', description: '', edition: 'community' };
        this.showAddForm = false;
        await this.load();
        showToast('已新增專案', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.saving = false; }
    },
    async remove(p) {
      const ok = await confirmDialog({
        title: '刪除專案',
        message: `此動作會連帶刪除「${p.name}」下所有 repo 的本機程式碼，且無法復原。`,
        danger: true,
        requireText: p.name,
        confirmText: '刪除專案'
      });
      if (!ok) return;
      try {
        await Api.delete(`projects/${p.id}`);
        await this.load();
        showToast('已刪除', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    async toggleFavorite(p) {
      const next = !p.is_favorite;
      p.is_favorite = next;   // 樂觀更新：立即反映愛心與置頂排序
      try {
        if (next) await Api.post(`projects/${p.id}/favorite`, {});
        else await Api.delete(`projects/${p.id}/favorite`);
      } catch (e) {
        p.is_favorite = !next;   // 失敗還原
        showToast(e.message || '更新我的最愛失敗', 'error');
      }
    },
    unread(id) { return UnreadStore.byProject[String(id)] || 0; },
    go(id) { this.$router.push(`/projects/${id}`); },
    goWiki(id) { this.$router.push(`/projects/${id}/wiki`); },
    goChat(id) { this.$router.push(`/projects/${id}/chat`); },
    goDb(id) { this.$router.push(`/projects/${id}/db`); },
    async openEnv(id) {
      // 與 ProjectDetail.openEnv 同：popup 必須在 click handler 內同步開；首建可達數分鐘，先寫字再輪詢 SSO URL。
      const w = window.open('about:blank', '_blank');
      if (w) {
        try { w.document.write('<p style="font-family:sans-serif;padding:2rem">測試區建立中，請稍候…</p>'); }
        catch (e) { console.debug('about:blank document.write 被瀏覽器擋下，不影響後續導向:', e && e.message); }
      }
      try {
        const url = await pollEnvSso(id);
        if (w) w.location = url; else window.location = url;
      } catch (e) {
        if (w) w.close();
        showToast(e.message || '無法開啟測試區', 'error');
      }
    },
    async initWiki(id) {
      try {
        await Api.post(`projects/${id}/wiki/init`, {});
        showToast('Wiki 初始化完成', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    isAdmin() { return window.UserStore.role === 'admin'; }
  },
  template: `
    <div class="topbar">
      <h1>專案管理</h1>
      <button class="btn btn-primary btn-sm" data-tour="proj-add" @click="showAddForm = !showAddForm">
        {{ showAddForm ? '取消' : '+ 新增專案' }}
      </button>
    </div>
    <div class="content">
      <div v-if="showAddForm" class="settings-section" data-tour="proj-form" style="margin-bottom:var(--space-5)">
        <h2 class="section-title">新增專案</h2>
        <div class="proj-form-grid">
          <div class="form-group" style="margin:0">
            <label>專案名稱</label>
            <input v-model="newProject.name" placeholder="例：my-odoo" class="form-control" />
          </div>
          <div class="form-group" style="margin:0">
            <label>Odoo 版本</label>
            <input v-model="newProject.odoo_version" placeholder="例：17.0" class="form-control" />
          </div>
          <div class="form-group" style="margin:0">
            <label>英文資料夾名稱 <span style="font-size:var(--fs-xs);color:var(--text-muted)">中文名稱必填此欄</span></label>
            <input v-model="newProject.folder_name" placeholder="例：hong-jiu（留空則用專案名稱）" class="form-control" />
          </div>
          <div class="form-group" style="margin:0">
            <label>版本類型</label>
            <select v-model="newProject.edition" class="form-control">
              <option value="community">社群版（Community）</option>
              <option value="enterprise">企業版（Enterprise）</option>
            </select>
          </div>
          <div class="form-group" style="margin:0;grid-column:span 2">
            <label>說明（選填）</label>
            <input v-model="newProject.description" placeholder="專案描述..." class="form-control" />
          </div>
        </div>
        <div class="proj-form-actions">
          <button class="btn btn-primary btn-sm" @click="add" :disabled="saving">{{ saving ? '建立中...' : '建立專案' }}</button>
          <button class="btn btn-outline btn-sm" @click="showAddForm = false">取消</button>
        </div>
      </div>

      <div style="margin-bottom:var(--space-4)">
        <input v-model="search" placeholder="搜尋專案名稱或版本..." class="form-control proj-search-input" />
      </div>

      <div v-if="loading">
        <div class="project-card" v-for="i in 3" :key="i">
          <div style="flex:1;min-width:0">
            <Skeleton width="180px" height="16px" />
            <div style="margin-top:8px"><Skeleton width="240px" height="13px" /></div>
            <div class="proj-skeleton-row">
              <Skeleton width="72px" height="26px" radius="6px" />
              <Skeleton width="72px" height="26px" radius="6px" />
            </div>
          </div>
        </div>
      </div>
      <div v-else>
        <div v-if="filteredProjects.length === 0" style="color:var(--text-muted);padding:var(--space-4) 0">
          {{ search ? '沒有符合的專案' : '尚無專案，點擊「新增專案」開始建立' }}
        </div>
        <div v-for="p in filteredProjects" :key="p.id" class="project-card" @click="go(p.id)">
          <div style="flex:1;min-width:0">
            <div class="project-card-name">{{ p.name }}</div>
            <div v-if="p.folder_name" style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:2px">資料夾：{{ p.folder_name }}</div>
            <div style="font-size:var(--fs-base);color:var(--text-muted);margin-top:4px">Odoo {{ p.odoo_version }} · {{ p.repo_count }} 個 repo</div>
            <div v-if="p.description" style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:4px">{{ p.description }}</div>
            <div class="proj-card-actions" @click.stop>
              <button class="btn btn-outline btn-sm" @click="goChat(p.id)">💬 Chat
                <span v-if="unread(p.id)" style="display:inline-block;min-width:16px;padding:0 5px;margin-left:var(--space-1);border-radius:var(--radius);background:var(--error,#e5484d);color:#fff;font-size:var(--fs-xs);line-height:16px;text-align:center">{{ unread(p.id) }}</span>
              </button>
              <button class="btn btn-outline btn-sm" @click="openEnv(p.id)" title="開啟此專案的測試區">🧪 測試區</button>
              <button class="btn btn-outline btn-sm" data-tour="proj-release" @click="releaseId = p.id" :disabled="!p.repo_count"
                title="把 ai-dev 上已核准的任務合併到 main">🚀 上正式</button>
              <button class="btn btn-outline btn-sm" @click="goDb(p.id)">資料庫查詢</button>
              <button class="btn btn-outline btn-sm" @click="goWiki(p.id)">📖 Wiki</button>
              <button v-if="!p.has_wiki" class="btn btn-outline btn-sm" @click="initWiki(p.id)">🔄 初始化 Wiki</button>
            </div>
          </div>
          <div class="proj-card-icons" @click.stop>
            <button v-if="p.id !== 'demo'" class="btn btn-ghost btn-sm"
              :style="{ fontSize: 'var(--fs-lg)', lineHeight: 1, color: p.is_favorite ? 'var(--danger)' : 'var(--text-muted)' }"
              :title="p.is_favorite ? '取消我的最愛' : '加入我的最愛'"
              @click="toggleFavorite(p)">{{ p.is_favorite ? '♥' : '♡' }}</button>
            <button v-if="isAdmin()" class="btn btn-ghost btn-sm" style="color:var(--danger)" @click="remove(p)">刪除</button>
          </div>
        </div>
      </div>
      <!-- 上正式：與專案詳細頁共用同一個彈窗元件 -->
      <ReleaseModal v-if="releaseId" :key="releaseId" :project-id="releaseId" @close="releaseId = null" />
    </div>
  `
});
