window.AdminPortPoolView = Vue.defineComponent({
  name: 'AdminPortPoolView',
  data() {
    return { min: null, max: null, slots: [], loading: true, saving: false };
  },
  async created() { await this.load(); },
  computed: {
    leasedCount() { return this.slots.filter(s => s.state === 'leased').length; }
  },
  methods: {
    async load() {
      this.loading = true;
      try {
        const d = await Api.get('admin/port-pool');
        this.min = d.min; this.max = d.max; this.slots = d.slots || [];
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    async save() {
      this.saving = true;
      try {
        await Api.put('admin/port-pool', { min: this.min, max: this.max });
        showToast('埠池範圍已儲存', 'success');
        await this.load();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.saving = false; }
    },
    idleText(s) {
      if (s.state !== 'leased') return '';
      if (!s.last_active_at) return '尚未偵測到活動';
      const min = Math.round((Date.now() - new Date(s.last_active_at).getTime()) / 60000);
      return min < 1 ? '剛剛活動' : `最後活動 ${min} 分鐘前`;
    },
    stateLabel(s) {
      return { leased: '🟢 使用中', free: '⚪ 空閒', blocked: '🔴 宿主無法綁定' }[s.state] || s.state;
    }
  },
  template: `
    <div class="page-header">
      <div class="page-header-inner">
        <h1 class="page-title">測試區 port 池</h1>
      </div>
    </div>
    <div class="page-body">
      <div v-if="loading" class="loading">載入中...</div>
      <div v-else class="settings-layout">

        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">池範圍</div>
            <div class="setting-block-desc">
              專案啟動測試區時從這段借一個埠、停止時歸還。專案總數不受限，同時運行數上限＝槽數。
            </div>
          </div>
          <div class="setting-block-body">
            <div class="conn-fields">
              <div class="field-item field-item-narrow">
                <label class="field-label">下限</label>
                <input v-model.number="min" type="number" min="1" max="65535" class="field-input" />
              </div>
              <div class="field-item field-item-narrow">
                <label class="field-label">上限</label>
                <input v-model.number="max" type="number" min="1" max="65535" class="field-input" />
              </div>
            </div>
            <div class="field-label-hint" style="margin-top:var(--space-3)">
              目前 {{ leasedCount }} / {{ slots.length }} 個槽使用中
            </div>
          </div>
          <div class="setting-block-footer warn">
            <div style="font-size:var(--fs-sm);color:var(--text);margin-bottom:var(--space-3)">
              ⚠ 修改範圍後必須請維運同步：nginx 容器重新 publish 新埠段、對外 NAT／防火牆放行新範圍。
              平台只能偵測「宿主能否綁定」，<strong>無法確認對外是否放行</strong>——設定超出放行範圍時，
              測試區會建得起來但外面連不進去。
            </div>
            <button class="btn btn-primary btn-sm" @click="save" :disabled="saving">
              {{ saving ? '儲存中...' : '儲存範圍' }}
            </button>
          </div>
        </div>

        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">槽位狀態</div>
            <div class="setting-block-desc">「宿主無法綁定」通常代表該埠被機器上其他服務佔用。</div>
          </div>
          <div class="setting-block-body">
            <div v-for="s in slots" :key="s.port"
                 style="display:flex;align-items:center;gap:var(--space-4);padding:var(--space-2) 0;border-bottom:1px solid var(--border)">
              <code style="min-width:64px;color:var(--text)">{{ s.port }}</code>
              <span style="min-width:140px;font-size:var(--fs-sm);color:var(--text)">{{ stateLabel(s) }}</span>
              <span style="flex:1;font-size:var(--fs-sm);color:var(--text-muted)">
                <template v-if="s.state === 'leased'">{{ s.project_name }} — {{ idleText(s) }}</template>
              </span>
            </div>
          </div>
        </div>

      </div>
    </div>
  `
});
