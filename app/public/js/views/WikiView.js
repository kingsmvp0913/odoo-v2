window.WikiNode = Vue.defineComponent({
  name: 'wiki-node',
  props: ['node', 'depth', 'currentSlug', 'refreshing'],
  emits: ['open', 'refresh', 'remove'],
  template: `
    <div>
      <div style="display:flex;align-items:center;gap:4px;padding:6px 8px;border-radius:4px;cursor:pointer;font-size:13px"
        :style="{ background: currentSlug === node.slug ? 'var(--border)' : 'transparent', paddingLeft: (8 + depth*14) + 'px' }"
        @click="$emit('open', node.slug)">
        <span style="opacity:.6">{{ node.node_type === 'module' ? '📁' : node.node_type === 'overview' ? '🏠' : '📄' }}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ node.title }}</span>
        <button class="btn btn-outline btn-sm" style="padding:0 5px;font-size:11px"
          :disabled="refreshing === node.slug"
          @click.stop="$emit('refresh', node.slug)" title="重新生成">
          {{ refreshing === node.slug ? '…' : '⟳' }}
        </button>
        <button class="btn btn-outline btn-sm" style="padding:0 5px;font-size:11px;color:var(--error)"
          @click.stop="$emit('remove', node.slug)" title="刪除">✕</button>
      </div>
      <wiki-node v-for="c in node.children" :key="c.id" :node="c" :depth="depth+1"
        :current-slug="currentSlug" :refreshing="refreshing"
        @open="$emit('open', $event)" @refresh="$emit('refresh', $event)" @remove="$emit('remove', $event)"></wiki-node>
    </div>
  `
});

window.WikiView = Vue.defineComponent({
  name: 'WikiView',
  components: { 'wiki-node': window.WikiNode },
  data() {
    return {
      pages: [],
      current: null,
      loading: true,
      editing: false,
      editContent: '',
      saving: false,
      refreshing: ''
    };
  },
  async created() {
    await this.loadPages();
    const slug = this.$route.params.slug;
    if (slug) await this.loadPage(slug);
    else if (this.pages.length > 0) await this.loadPage(this.pages[0].slug);
  },
  computed: {
    renderedContent() {
      if (!this.current) return '';
      return window.marked ? window.marked.parse(this.current.content) : this.current.content;
    },
    tree() {
      const byId = {};
      this.pages.forEach(p => { byId[p.id] = { ...p, children: [] }; });
      const roots = [];
      this.pages.forEach(p => {
        if (p.parent_id && byId[p.parent_id]) byId[p.parent_id].children.push(byId[p.id]);
        else roots.push(byId[p.id]);
      });
      roots.sort((a, b) => (a.node_type === 'overview' ? -1 : 0) - (b.node_type === 'overview' ? -1 : 0));
      return roots;
    }
  },
  methods: {
    async loadPages() {
      this.loading = true;
      try { this.pages = await Api.get(`projects/${this.$route.params.id}/wiki`); }
      catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    async loadPage(slug) {
      try {
        this.current = await Api.get(`projects/${this.$route.params.id}/wiki/${slug}`);
        this.editContent = this.current.content;
        this.editing = false;
        this.$router.replace(`/projects/${this.$route.params.id}/wiki/${slug}`);
      } catch (e) { showToast(e.message, 'error'); }
    },
    async save() {
      if (!this.current) return;
      this.saving = true;
      try {
        this.current = await Api.put(`projects/${this.$route.params.id}/wiki/${this.current.slug}`, { content: this.editContent });
        this.editing = false;
        showToast('已儲存', 'success');
        await this.loadPages();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.saving = false; }
    },
    async addPage() {
      const slug = prompt('輸入頁面 slug（英文小寫+連字號）：');
      if (!slug) return;
      const title = prompt('輸入頁面標題：');
      if (!title) return;
      try {
        await Api.post(`projects/${this.$route.params.id}/wiki`, { slug, title, content: `# ${title}\n\n` });
        await this.loadPages();
        await this.loadPage(slug);
        showToast('已新增頁面', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    async removePage(slug) {
      if (!confirm(`刪除「${slug}」？`)) return;
      try {
        await Api.delete(`projects/${this.$route.params.id}/wiki/${slug}`);
        await this.loadPages();
        this.current = null;
        showToast('已刪除', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    async refreshNode(slug) {
      this.refreshing = slug;
      try {
        await Api.post(`projects/${this.$route.params.id}/wiki/${slug}/refresh`);
        showToast('已重新生成', 'success');
        await this.loadPages();
        if (this.current && this.current.slug === slug) await this.loadPage(slug);
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.refreshing = ''; }
    },
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/projects/' + $route.params.id)" style="margin-right:12px">← 返回專案</button>
      <h1>Wiki</h1>
      <button class="btn btn-outline btn-sm" style="margin-left:auto" @click="addPage">+ 新增頁面</button>
    </div>
    <div style="display:flex;height:calc(100vh - 56px);overflow:hidden">
      <div style="width:220px;border-right:1px solid var(--border);overflow-y:auto;padding:8px;flex-shrink:0">
        <div v-if="loading" style="color:var(--text-muted);font-size:13px;padding:8px">載入中...</div>
        <template v-else>
          <wiki-node v-for="n in tree" :key="n.id" :node="n" :depth="0"
            :current-slug="current && current.slug"
            :refreshing="refreshing"
            @open="loadPage" @refresh="refreshNode" @remove="removePage"></wiki-node>
          <div v-if="pages.length === 0" style="color:var(--text-muted);font-size:12px;padding:8px">尚無頁面</div>
        </template>
      </div>
      <div style="flex:1;overflow-y:auto;padding:24px">
        <div v-if="!current" style="color:var(--text-muted)">選擇或新增頁面</div>
        <template v-else>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
            <h2 style="margin:0">{{ current.title }}</h2>
            <div>
              <button v-if="!editing" class="btn btn-outline btn-sm" @click="editing=true;editContent=current.content">編輯</button>
              <template v-else>
                <button class="btn btn-primary btn-sm" @click="save" :disabled="saving">儲存</button>
                <button class="btn btn-outline btn-sm" style="margin-left:8px" @click="editing=false">取消</button>
              </template>
            </div>
          </div>
          <div v-if="!editing" v-html="renderedContent" style="line-height:1.7;font-size:14px"></div>
          <textarea v-else v-model="editContent" style="width:100%;height:60vh;font-family:monospace;font-size:13px;padding:8px;border:1px solid var(--border);border-radius:4px;resize:vertical;box-sizing:border-box"></textarea>
        </template>
      </div>
    </div>
  `
});
