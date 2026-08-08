window.WikiNode = Vue.defineComponent({
  name: 'wiki-node',
  props: ['node', 'depth', 'currentSlug', 'refreshing', 'editingSlug'],
  emits: ['open', 'refresh', 'remove'],
  template: `
    <div>
      <div :data-tour="'wiki-node-' + node.node_type"
        class="wiki-node-row"
        :style="{ background: currentSlug === node.slug ? 'var(--border)' : 'transparent', paddingLeft: (8 + depth*14) + 'px' }"
        @click="$emit('open', node.slug)">
        <span style="opacity:.6">{{ node.node_type === 'module' ? '📁' : node.node_type === 'overview' ? '🏠' : node.node_type === 'notes' ? '📝' : node.node_type === 'troubleshooting' ? '🔧' : '📄' }}</span>
        <span class="wiki-node-title">{{ node.title }}</span>
        <template v-if="node.node_type !== 'notes'">
          <button v-if="node.node_type !== 'troubleshooting'" class="btn btn-outline btn-sm" style="padding:0 5px;font-size:var(--fs-xs)"
            :disabled="refreshing === node.slug || editingSlug === node.slug"
            @click.stop="$emit('refresh', node.slug)"
            :title="editingSlug === node.slug ? '編輯中：請先儲存或取消，否則重新生成會蓋掉你正在打的內容' : '重新生成'">
            {{ refreshing === node.slug ? '…' : '⟳' }}
          </button>
          <button v-if="node.slug !== 'troubleshooting'" class="btn btn-outline btn-sm" style="padding:0 5px;font-size:var(--fs-xs);color:var(--error)"
            @click.stop="$emit('remove', node.slug)" title="刪除">✕</button>
        </template>
      </div>
      <wiki-node v-for="c in node.children" :key="c.id" :node="c" :depth="depth+1"
        :current-slug="currentSlug" :refreshing="refreshing" :editing-slug="editingSlug"
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
      loadError: '',
      editing: false,
      editContent: '',
      saving: false,
      refreshing: '',
      building: false,
      progress: { percent: 0, message: '', stage: '' },
      showAddModal: false,
      newPageTitle: '',
      newPageSlug: '',
      slugTouched: false,
      addingPage: false
    };
  },
  async created() {
    await this.loadPages();
    const slug = this.$route.params.slug;
    if (slug) await this.loadPage(slug);
    // 無指定頁時開排序後第一項（＝專案備註），讓進 Wiki 直接看到備註
    else if (this.tree.length > 0) await this.loadPage(this.tree[0].slug);
  },
  mounted() {
    this._progressHandler = (d) => this._onProgress(d);
    const sock = window._socket;
    if (sock) sock.on('wiki:progress', this._progressHandler);
  },
  beforeUnmount() {
    const sock = window._socket;
    if (sock && sock.off) sock.off('wiki:progress', this._progressHandler);
  },
  watch: {
    // 網址列的 slug 換了就換頁：元件不會為了 params 變化重建，少了這條，直接改網址（或教程導頁）
    // 只會換掉網址、內容停在舊頁。loadPage 內的 router.replace 是同一個 slug，不會遞迴。
    '$route.params.slug'(slug) {
      if (slug && (!this.current || this.current.slug !== slug)) this.loadPage(slug);
    }
  },
  computed: {
    renderedContent() {
      if (!this.current) return '';
      return renderMarkdown(this.current.content);
    },
    // 編輯中那一頁的 slug：重生完成後會 loadPage 覆寫 editContent，未儲存的內容會無聲消失，
    // 故編輯期間把該頁的 ⟳ 停用。空字串＝沒有任何頁在編輯。
    editingSlug() {
      return this.editing && this.current ? this.current.slug : '';
    },
    // 「建立 wiki」按下去會走 initProjectWiki，以骨架 ON CONFLICT DO UPDATE 覆寫概論與每一頁模組頁。
    // 清單載入失敗時 pages 停在 []，只看 !pages.length 會讓這顆按鈕在「其實有內容」的專案上冒出來，
    // 使用者看到空樹自然會按——一次網路抖動就換來整份累積內容被骨架蓋掉。
    canBuild() {
      return !this.pages.length && !this.loadError;
    },
    tree() {
      const byId = {};
      this.pages.forEach(p => { byId[p.id] = { ...p, children: [] }; });
      const roots = [];
      this.pages.forEach(p => {
        if (p.parent_id && byId[p.parent_id]) byId[p.parent_id].children.push(byId[p.id]);
        else roots.push(byId[p.id]);
      });
      roots.sort((a, b) => {
        // 專案備註排最前（人工維護、最常看），其次概論，其餘照原序
        if (a.node_type === 'notes') return -1;
        if (b.node_type === 'notes') return 1;
        if (a.node_type === 'overview') return -1;
        if (b.node_type === 'overview') return 1;
        return 0;
      });
      return roots;
    }
  },
  methods: {
    // 新手教程的示範專案：wiki 內容來自 tour-demo.js，不打 API
    isTourDemo() { return !!(window.TourDemo && window.TourDemo.isProject(this.$route.params.id)); },
    // 教程示範專案的 id 是字串 'demo'，送進 integer 型別的 project_id 一律 500。
    // 讀取路徑走 TourDemo 假資料，寫入路徑（儲存／⟳／✕）一律擋在前端並說明原因。
    tourDemoBlocked() {
      if (!this.isTourDemo()) return false;
      showToast('教程示範專案僅供瀏覽，不會實際變更', 'info');
      return true;
    },
    // 編輯中且內容與伺服器版本不同＝有未儲存的修改。notes 頁的 textarea 永遠是活的，
    // 靠 @input 把 editing 帶起來，否則 editing 永遠是 false、這裡永遠判不出髒。
    isDirty() {
      return !!(this.editing && this.current && this.editContent !== this.current.content);
    },
    async loadPages() {
      if (this.isTourDemo()) { this.pages = window.TourDemo.wikiPages(); this.loadError = ''; this.loading = false; return; }
      this.loading = true;
      try { this.pages = await Api.get(`projects/${this.$route.params.id}/wiki`); this.loadError = ''; }
      catch (e) { this.loadError = e.message; showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    async loadPage(slug) {
      // 切頁會直接覆寫 editContent 並把 editing 歸零，未儲存的內容無聲消失——點左樹任一節點或
      // 直接改網址都會中。同一頁重載（⟳ 之後）不攔，那條路徑已由樹上 ⟳ 的停用擋住。
      if (this.current && this.current.slug !== slug && this.isDirty()) {
        const discard = await confirmDialog({
          title: '尚未儲存', danger: true, confirmText: '放棄修改',
          message: `「${this.current.title}」有未儲存的修改，切換頁面後會遺失。要放棄修改嗎？`
        });
        if (!discard) {
          // 網址若已被帶到新 slug（改網址列／上一頁觸發 watcher），要導回原頁，否則畫面停在舊頁、
          // 網址卻是新頁。replace 回同一 slug 不會再觸發 watcher（條件是 current.slug !== slug）。
          this.$router.replace(`/projects/${this.$route.params.id}/wiki/${this.current.slug}`);
          return;
        }
      }
      try {
        this.current = this.isTourDemo()
          ? window.TourDemo.wikiPage(slug)
          : await Api.get(`projects/${this.$route.params.id}/wiki/${slug}`);
        this.editContent = this.current.content;
        this.editing = false;
        this.$router.replace(`/projects/${this.$route.params.id}/wiki/${slug}`);
      } catch (e) { showToast(e.message, 'error'); }
    },
    async save() {
      if (!this.current) return;
      if (this.tourDemoBlocked()) return;
      this.saving = true;
      try {
        this.current = await Api.put(`projects/${this.$route.params.id}/wiki/${this.current.slug}`, { content: this.editContent });
        this.editing = false;
        showToast('已儲存', 'success');
        await this.loadPages();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.saving = false; }
    },
    openAddPage() {
      this.newPageTitle = '';
      this.newPageSlug = '';
      this.slugTouched = false;
      this.showAddModal = true;
      this.$nextTick(() => this.$refs.newTitleInput && this.$refs.newTitleInput.focus());
    },
    onTitleInput() {
      if (this.slugTouched) return;
      this.newPageSlug = this.newPageTitle
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    },
    onSlugInput() { this.slugTouched = true; },
    async submitAddPage() {
      const title = this.newPageTitle.trim();
      const slug = this.newPageSlug.trim();
      if (!title || !slug) return showToast('請填寫 slug 與標題', 'error');
      if (this.tourDemoBlocked()) return;
      this.addingPage = true;
      try {
        await Api.post(`projects/${this.$route.params.id}/wiki`, { slug, title, content: `# ${title}\n\n` });
        this.showAddModal = false;
        await this.loadPages();
        await this.loadPage(slug);
        showToast('已新增頁面', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.addingPage = false; }
    },
    async removePage(slug) {
      if (this.tourDemoBlocked()) return;
      if (!await confirmDialog({ title: '刪除頁面', message: `確定刪除頁面「${slug}」？`, danger: true, confirmText: '刪除' })) return;
      try {
        await Api.delete(`projects/${this.$route.params.id}/wiki/${slug}`);
        await this.loadPages();
        this.current = null;
        showToast('已刪除', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    },
    async refreshNode(slug) {
      if (this.tourDemoBlocked()) return;
      this.refreshing = slug;
      try {
        await Api.post(`projects/${this.$route.params.id}/wiki/${slug}/refresh`);
        showToast('已重新生成', 'success');
        await this.loadPages();
        if (this.current && this.current.slug === slug) await this.loadPage(slug);
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.refreshing = ''; }
    },
    async buildWiki() {
      if (this.tourDemoBlocked()) return;   // 守衛要在 building 之前，否則會卡在轉圈
      this.building = true;
      this.progress = { percent: 0, message: '開始建立…', stage: 'scanning' };
      try {
        await Api.post(`projects/${this.$route.params.id}/wiki/init`, {});
        await this.loadPages();
        if (this.pages.length) await this.loadPage('overview');
        showToast('Wiki 已建立', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.building = false; }
    },
    _onProgress(data) {
      if (String(data.projectId) !== String(this.$route.params.id)) return;
      this.progress = { percent: data.percent || 0, message: data.message || '', stage: data.stage || '' };
    },
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/projects/' + $route.params.id)" style="margin-right:var(--space-3)">← 返回專案</button>
      <h1>Wiki</h1>
      <button v-if="canBuild" class="btn btn-primary btn-sm" style="margin-left:auto" @click="buildWiki" :disabled="building">
        {{ building ? '建立中…' : '建立 wiki' }}
      </button>
      <button class="btn btn-outline btn-sm" :style="canBuild ? 'margin-left:var(--space-2)' : 'margin-left:auto'" @click="openAddPage">+ 新增頁面</button>
    </div>
    <div v-if="showAddModal" class="modal-overlay" @mousedown.self="showAddModal=false" @keyup.esc="showAddModal=false">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">新增頁面</div>
        <div class="modal-body">
          <div class="field-item" style="margin-bottom:var(--space-4)">
            <label class="field-label">標題</label>
            <input ref="newTitleInput" class="form-control" v-model="newPageTitle" @input="onTitleInput"
              placeholder="例如：銷售訂單模組" @keyup.enter="submitAddPage" />
          </div>
          <div class="field-item">
            <label class="field-label">Slug（英文小寫＋連字號）</label>
            <input class="form-control" v-model="newPageSlug" @input="onSlugInput"
              placeholder="例如：sale-order" @keyup.enter="submitAddPage" />
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showAddModal=false">取消</button>
          <button class="btn btn-primary" :disabled="addingPage || !newPageTitle.trim() || !newPageSlug.trim()" @click="submitAddPage">
            {{ addingPage ? '新增中...' : '新增' }}
          </button>
        </div>
      </div>
    </div>
    <div v-if="building" style="padding:var(--space-2) var(--space-4);background:var(--surface);border-bottom:1px solid var(--border)">
      <div class="wiki-progress-row">
        <span>{{ progress.message || '建立中…' }}</span><span>{{ progress.percent }}%</span>
      </div>
      <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">
        <div :style="{ width: progress.percent + '%', height: '100%', background: 'var(--primary)', transition: 'width .3s' }"></div>
      </div>
    </div>
    <div class="wiki-body">
      <div data-tour="wiki-tree" class="wiki-tree-panel">
        <div v-if="loading" style="color:var(--text-muted);font-size:var(--fs-base);padding:var(--space-2)">載入中...</div>
        <div v-else-if="loadError" class="error-msg">
          頁面清單載入失敗：{{ loadError }}
          <div><button class="btn btn-outline btn-sm" style="margin-top:var(--space-2)" @click="loadPages">重試</button></div>
        </div>
        <template v-else>
          <wiki-node v-for="n in tree" :key="n.id" :node="n" :depth="0"
            :current-slug="current && current.slug"
            :refreshing="refreshing" :editing-slug="editingSlug"
            @open="loadPage" @refresh="refreshNode" @remove="removePage"></wiki-node>
          <div v-if="pages.length === 0" style="color:var(--text-muted);font-size:var(--fs-sm);padding:var(--space-2)">尚無頁面</div>
        </template>
      </div>
      <div data-tour="wiki-content" style="flex:1;overflow-y:auto;padding:var(--space-6)">
        <div v-if="!current" style="color:var(--text-muted)">選擇或新增頁面</div>
        <template v-else>
          <div class="wiki-content-header">
            <h2 style="margin:0">{{ current.title }}</h2>
            <div v-if="current.node_type !== 'notes'">
              <button v-if="!editing" class="btn btn-outline btn-sm" @click="editing=true;editContent=current.content">編輯</button>
              <template v-else>
                <button class="btn btn-primary btn-sm" @click="save" :disabled="saving">儲存</button>
                <button class="btn btn-outline btn-sm" style="margin-left:var(--space-2)" @click="editing=false">取消</button>
              </template>
            </div>
            <div v-else>
              <button class="btn btn-primary btn-sm" @click="save" :disabled="saving">儲存</button>
            </div>
          </div>
          <template v-if="current.node_type === 'notes'">
            <p style="color:var(--text-muted);font-size:var(--fs-sm);margin:0 0 var(--space-2)">
              在此記錄專案注意事項、部署環境、聯絡窗口等人工維護的資訊。此處內容會自動注入各開發關卡，供 AI 優先遵循。
            </p>
            <textarea v-model="editContent" @input="editing = true" style="width:100%;height:70vh;font-family:monospace;font-size:var(--fs-base);padding:var(--space-2);border:1px solid var(--border);border-radius:4px;resize:vertical;box-sizing:border-box"></textarea>
          </template>
          <template v-else>
            <div v-if="!editing" v-html="renderedContent" style="line-height:1.7;font-size:var(--fs-md)"></div>
            <textarea v-else v-model="editContent" style="width:100%;height:60vh;font-family:monospace;font-size:var(--fs-base);padding:var(--space-2);border:1px solid var(--border);border-radius:4px;resize:vertical;box-sizing:border-box"></textarea>
          </template>
        </template>
      </div>
    </div>
  `
});
