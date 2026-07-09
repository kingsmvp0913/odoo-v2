window.AdminAgentsView = Vue.defineComponent({
  name: 'AdminAgentsView',
  data() {
    return {
      agents: [],
      loading: true,
      selected: null,        // { name, label, description, model, stage, prompt }
      form: { model: '', prompt: '' },
      saving: false,
      models: ['haiku', 'sonnet', 'opus', 'fable']
    };
  },
  computed: {
    // 按角色 label 分組
    grouped() {
      const g = {};
      for (const a of this.agents) (g[a.label] = g[a.label] || []).push(a);
      return Object.entries(g).map(([label, items]) => ({ label, items }));
    },
    dirty() {
      return this.selected &&
        (this.form.model !== this.selected.model || this.form.prompt !== this.selected.prompt);
    }
  },
  async created() {
    await this.load();
    // 健檢「帶入編輯器」：帶 ?prefill=<name> 進來時自動選該 agent 並填入建議 prompt（人工審後才儲存）
    const name = this.$route.query.prefill;
    if (name) {
      const stash = sessionStorage.getItem('agentPrefill');
      sessionStorage.removeItem('agentPrefill');
      await this.select({ name });
      if (this.selected && stash) {
        try {
          const { name: n, prompt } = JSON.parse(stash);
          if (n === this.selected.name && prompt) this.form.prompt = prompt;  // 留 dirty，提示「尚未儲存」
        } catch (_) { /* 壞資料忽略 */ }
      }
    }
  },
  methods: {
    async load() {
      this.loading = true;
      try { this.agents = await Api.get('admin/agents'); }
      catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    async select(a) {
      try {
        const full = await Api.get('admin/agents/' + a.name);
        this.selected = full;
        this.form = { model: full.model, prompt: full.prompt };
      } catch (e) { showToast(e.message, 'error'); }
    },
    async save() {
      if (!this.selected) return;
      this.saving = true;
      try {
        const updated = await Api.put('admin/agents/' + this.selected.name, {
          model: this.form.model,
          prompt: this.form.prompt
        });
        this.selected = updated;
        this.form = { model: updated.model, prompt: updated.prompt };
        const item = this.agents.find(x => x.name === updated.name);
        if (item) item.model = updated.model;
        showToast('已儲存「' + updated.label + '」', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.saving = false; }
    }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/admin')" style="margin-right:var(--space-3)">← 返回</button>
      <h1>Agent 管理</h1>
    </div>
    <div class="content">
      <div v-if="loading" class="loading">載入中...</div>
      <div v-else style="display:grid;grid-template-columns:280px 1fr;gap:var(--space-4);align-items:start">

        <!-- 左：按角色分組列表 -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
          <div v-for="grp in grouped" :key="grp.label">
            <div style="padding:6px var(--space-3);font-size:var(--fs-sm);font-weight:var(--fw-semibold);background:var(--border);color:var(--text-secondary)">
              {{ grp.label }}
            </div>
            <div v-for="a in grp.items" :key="a.name"
              @click="select(a)"
              :style="{padding:'var(--space-2) var(--space-3)',cursor:'pointer',borderTop:'1px solid var(--border)',
                       background: selected && selected.name===a.name ? 'rgba(99,102,241,0.10)' : 'transparent'}">
              <div style="font-size:var(--fs-base);display:flex;justify-content:space-between;align-items:center;gap:var(--space-2)">
                <span style="font-family:monospace">{{ a.name }}</span>
                <span v-if="a.model" style="font-size:var(--fs-xs);padding:1px 6px;border-radius:4px;background:var(--border);color:var(--text-secondary)">{{ a.model }}</span>
              </div>
              <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:2px">{{ a.description }}</div>
            </div>
          </div>
        </div>

        <!-- 右：編輯 -->
        <div v-if="selected" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-4)">
          <div style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-1)">
            <h2 style="margin:0;font-size:16px">{{ selected.label }}</h2>
            <span style="font-family:monospace;font-size:var(--fs-sm);color:var(--text-muted)">{{ selected.name }}</span>
          </div>
          <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:var(--space-4)">{{ selected.description }}</div>

          <template v-if="selected.model !== null">
            <label style="display:block;font-size:var(--fs-sm);font-weight:var(--fw-semibold);margin-bottom:var(--space-1)">模型</label>
            <select v-model="form.model" class="form-control" style="width:160px;height:32px;font-size:var(--fs-base);margin-bottom:var(--space-4)">
              <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
            </select>
          </template>

          <label style="display:block;font-size:var(--fs-sm);font-weight:var(--fw-semibold);margin-bottom:var(--space-1)">提示詞（雙大括號包住的佔位符為動態資料，請勿刪改）</label>
          <textarea v-model="form.prompt" class="form-control"
            style="width:100%;min-height:420px;font-family:monospace;font-size:var(--fs-sm);line-height:1.5;resize:vertical"></textarea>

          <div style="margin-top:var(--space-3);display:flex;gap:var(--space-2);align-items:center">
            <button class="btn btn-primary btn-sm" @click="save" :disabled="saving || !dirty">
              {{ saving ? '儲存中...' : '儲存' }}
            </button>
            <span v-if="dirty" style="font-size:var(--fs-sm);color:var(--warning)">尚未儲存</span>
          </div>
        </div>
        <div v-else style="color:var(--text-muted);padding:var(--space-8);text-align:center">
          從左側選擇一個 agent 進行編輯
        </div>
      </div>
    </div>
  `
});
