window.ProjectListView = Vue.defineComponent({
  name: 'ProjectListView',
  data() {
    return {
      projects: [],
      loading: true,
      search: '',
      showAddForm: false,
      newProject: { name: '', folder_name: '', odoo_version: '', description: '' },
      saving: false
    };
  },
  computed: {
    filteredProjects() {
      const q = this.search.toLowerCase();
      if (!q) return this.projects;
      return this.projects.filter(p =>
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
        this.newProject = { name: '', folder_name: '', odoo_version: '', description: '' };
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
    unread(id) { return UnreadStore.byProject[String(id)] || 0; },
    go(id) { this.$router.push(`/projects/${id}`); },
    goWiki(id) { this.$router.push(`/projects/${id}/wiki`); },
    goChat(id) { this.$router.push(`/projects/${id}/chat`); }
  },
  template: `
    <div class="topbar">
      <h1>專案管理</h1>
      <button class="btn btn-primary btn-sm" @click="showAddForm = !showAddForm">
        {{ showAddForm ? '取消' : '+ 新增專案' }}
      </button>
    </div>
    <div class="content">
      <div v-if="showAddForm" class="settings-section" style="margin-bottom:20px">
        <h2 class="section-title">新增專案</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div class="form-group" style="margin:0">
            <label>專案名稱</label>
            <input v-model="newProject.name" placeholder="例：my-odoo" class="form-control" />
          </div>
          <div class="form-group" style="margin:0">
            <label>Odoo 版本</label>
            <input v-model="newProject.odoo_version" placeholder="例：17.0" class="form-control" />
          </div>
          <div class="form-group" style="margin:0">
            <label>英文資料夾名稱 <span style="font-size:11px;color:var(--text-muted)">中文名稱必填此欄</span></label>
            <input v-model="newProject.folder_name" placeholder="例：hong-jiu（留空則用專案名稱）" class="form-control" />
          </div>
          <div class="form-group" style="margin:0;grid-column:span 2">
            <label>說明（選填）</label>
            <input v-model="newProject.description" placeholder="專案描述..." class="form-control" />
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" @click="add" :disabled="saving">{{ saving ? '建立中...' : '建立專案' }}</button>
          <button class="btn btn-outline btn-sm" @click="showAddForm = false">取消</button>
        </div>
      </div>

      <div style="margin-bottom:16px">
        <input v-model="search" placeholder="搜尋專案名稱或版本..." class="form-control" style="max-width:320px" />
      </div>

      <div v-if="loading">
        <div class="project-card" v-for="i in 3" :key="i">
          <div style="flex:1;min-width:0">
            <Skeleton width="180px" height="16px" />
            <div style="margin-top:8px"><Skeleton width="240px" height="13px" /></div>
            <div style="margin-top:10px;display:flex;gap:6px">
              <Skeleton width="72px" height="26px" radius="6px" />
              <Skeleton width="72px" height="26px" radius="6px" />
            </div>
          </div>
        </div>
      </div>
      <div v-else>
        <div v-if="filteredProjects.length === 0" style="color:var(--text-muted);padding:16px 0">
          {{ search ? '沒有符合的專案' : '尚無專案，點擊「新增專案」開始建立' }}
        </div>
        <div v-for="p in filteredProjects" :key="p.id" class="project-card" @click="go(p.id)">
          <div style="flex:1;min-width:0">
            <div class="project-card-name">{{ p.name }}</div>
            <div v-if="p.folder_name" style="font-size:12px;color:var(--text-muted);margin-top:2px">資料夾：{{ p.folder_name }}</div>
            <div style="font-size:13px;color:var(--text-muted);margin-top:4px">Odoo {{ p.odoo_version }} · {{ p.repo_count }} 個 repo</div>
            <div v-if="p.description" style="font-size:12px;color:var(--text-muted);margin-top:4px">{{ p.description }}</div>
            <div style="margin-top:10px;display:flex;gap:6px" @click.stop>
              <button class="btn btn-outline btn-sm" @click="goWiki(p.id)">📖 Wiki</button>
              <button class="btn btn-outline btn-sm" @click="goChat(p.id)">💬 Chat
                <span v-if="unread(p.id)" style="display:inline-block;min-width:16px;padding:0 5px;margin-left:4px;border-radius:8px;background:var(--error,#e5484d);color:#fff;font-size:11px;line-height:16px;text-align:center">{{ unread(p.id) }}</span>
              </button>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger);flex-shrink:0;align-self:flex-start" @click.stop="remove(p)">刪除</button>
        </div>
      </div>
    </div>
  `
});
