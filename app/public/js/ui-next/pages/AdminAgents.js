  window.UiNextAdminAgentsView = Vue.defineComponent({
    name: "UiNextAdminAgentsView",
    data() {
      return {
        agents: [],
        loading: true,
        selected: null,        // { name, label, description, provider, model, effort, stage, prompt }
        form: { provider: '', model: '', effort: '', prompt: '' },
        saving: false,
        providers: {}
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
          (this.form.provider !== this.selected.provider || this.form.model !== this.selected.model ||
           this.form.effort !== (this.selected.effort || '') || this.form.prompt !== this.selected.prompt);
      },
      providerSpec() { return this.providers[this.form.provider] || null; },
      models() { return this.providerSpec?.models || []; },
      modelSpec() { return this.models.find(m => m.id === this.form.model) || null; },
      efforts() { return this.modelSpec?.efforts || []; }
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
      } else {
        // 首次進入先顯示全域規則，讓管理員可立即查看 CLAUDE.md。
        await this.select({ name: 'CLAUDE' });
      }
    },
    methods: {
      async load() {
        this.loading = true;
        try {
          const [agents, providers] = await Promise.all([Api.get('admin/agents'), Api.get('admin/providers')]);
          this.agents = agents;
          this.providers = providers;
        }
        catch (e) { showToast(e.message, 'error'); }
        finally { this.loading = false; }
      },
      async select(a) {
        try {
          const full = await Api.get('admin/agents/' + a.name);
          this.selected = full;
          this.form = { provider: full.provider || 'claude', model: full.model, effort: full.effort || '', prompt: full.prompt };
        } catch (e) { showToast(e.message, 'error'); }
      },
      async save() {
        if (!this.selected) return;
        this.saving = true;
        try {
          const updated = await Api.put('admin/agents/' + this.selected.name, {
            provider: this.form.provider,
            model: this.form.model,
            effort: this.form.effort || undefined,
            prompt: this.form.prompt
          });
          this.selected = updated;
          this.form = { provider: updated.provider || 'claude', model: updated.model, effort: updated.effort || '', prompt: updated.prompt };
          const item = this.agents.find(x => x.name === updated.name);
          if (item) Object.assign(item, { model: updated.model, provider: updated.provider, effort: updated.effort });
          showToast('已儲存「' + updated.label + '」', 'success');
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.saving = false; }
      },
      changeProvider() {
        const first = this.models[0];
        this.form.model = first ? first.id : '';
        this.form.effort = first?.efforts?.includes('medium') ? 'medium' : (first?.efforts?.[0] || '');
      },
      changeModel() {
        if (!this.efforts.includes(this.form.effort)) this.form.effort = this.efforts.includes('medium') ? 'medium' : (this.efforts[0] || '');
      }
    },
    template: `
      <div class="topbar ui-next-admin-head">
        <h1>Agent 管理</h1>
        <div class="ui-next-admin-head-actions"><button class="btn btn-outline btn-sm" @click="$router.push('/admin')">← 返回</button></div>
      </div>
      <div class="content">
        <div v-if="loading" class="loading">載入中...</div>
        <div v-else class="aa-layout">

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
                <div class="aa-list-item-row">
                  <span style="font-family:monospace">{{ a.name }}</span>
                  <span v-if="a.model" style="font-size:var(--fs-xs);padding:1px 6px;border-radius:4px;background:var(--border);color:var(--text-secondary)">{{ a.provider === 'codex' ? a.provider + '/' + a.model + ':' + a.effort : a.model }}</span>
                </div>
                <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:2px">{{ a.description }}</div>
              </div>
            </div>
          </div>

          <!-- 右：編輯 -->
          <div v-if="selected" class="aa-editor" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:var(--space-4)">
            <div class="aa-detail-title-row">
              <h2 style="margin:0;font-size:16px">{{ selected.label }}</h2>
              <span style="font-family:monospace;font-size:var(--fs-sm);color:var(--text-muted)">{{ selected.name }}</span>
            </div>
            <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:var(--space-4)">{{ selected.description }}</div>

            <template v-if="selected.model !== null">
              <div style="display:flex;gap:var(--space-2);margin-bottom:var(--space-3);flex-wrap:wrap">
                <label style="font-size:var(--fs-sm);font-weight:var(--fw-semibold)">AI
                  <select v-model="form.provider" @change="changeProvider" class="form-control aa-model-select">
                    <option v-for="(p, id) in providers" :key="id" :value="id" :disabled="id === 'codex' && !selected.codexEligible">{{ p.label }}</option>
                  </select>
                </label>
                <label style="font-size:var(--fs-sm);font-weight:var(--fw-semibold)">模型
                  <select v-model="form.model" @change="changeModel" class="form-control aa-model-select">
                    <option v-for="m in models" :key="m.id" :value="m.id">{{ m.id }}</option>
                  </select>
                </label>
                <label v-if="efforts.length" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold)">推理強度
                  <select v-model="form.effort" class="form-control aa-model-select">
                    <option v-for="e in efforts" :key="e" :value="e">{{ e }}</option>
                  </select>
                </label>
              </div>
              <div v-if="!selected.codexEligible" style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:calc(-1 * var(--space-2));margin-bottom:var(--space-3)">
                Codex 尚未開放：此 agent 尚未具備對等的掃碟守衛與執行前提。
              </div>
            </template>

            <label style="display:block;font-size:var(--fs-sm);font-weight:var(--fw-semibold);margin-bottom:var(--space-1)">提示詞（雙大括號包住的佔位符為動態資料，請勿刪改）</label>
            <textarea v-model="form.prompt" class="form-control"
              style="width:100%;min-height:420px;font-family:monospace;font-size:var(--fs-sm);line-height:1.5;resize:vertical"></textarea>

            <div class="aa-save-row">
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
