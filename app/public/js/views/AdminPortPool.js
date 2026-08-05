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
    },
    // 對外子網域網址取主機名（odoo-ai-test-N.…）；拿不到就原樣回傳。
    hostOf(url) { try { return new URL(url).host; } catch { return url; } }
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
              ⚠ 這段埠只綁在宿主給反向代理連，<strong>不對外開放</strong>，改範圍不需要維運配合。
              上限＝同時最多幾個測試區活著（含 pipeline 在跑的），拉高前先確認主機記憶體吃得下。
              平台只能偵測「宿主能否綁定」，該埠被機器上其他服務佔用時會顯示無法綁定。
            </div>
            <button class="btn btn-primary btn-sm" @click="save" :disabled="saving">
              {{ saving ? '儲存中...' : '儲存範圍' }}
            </button>
          </div>
        </div>

        <div class="setting-block">
          <div class="setting-block-head">
            <div class="setting-block-title">槽位狀態</div>
            <div class="setting-block-desc">
              有人在瀏覽的測試區走<strong>子網域</strong>對外曝露（顯示 odoo-ai-test-N 網址）；只有內部埠、沒人在看的是 pipeline 在跑，僅內網可達。「宿主無法綁定」通常代表該埠被機器上其他服務佔用。
            </div>
          </div>
          <div class="setting-block-body">
            <div v-for="s in slots" :key="s.port"
                 style="display:flex;align-items:center;gap:var(--space-4);padding:var(--space-2) 0;border-bottom:1px solid var(--border)">
              <code style="min-width:220px;color:var(--text);font-size:var(--fs-sm)">
                <template v-if="s.external_url">{{ hostOf(s.external_url) }}</template>
                <template v-else>:{{ s.port }}</template>
              </code>
              <span style="min-width:120px;font-size:var(--fs-sm);color:var(--text)">{{ stateLabel(s) }}</span>
              <span style="flex:1;font-size:var(--fs-sm);color:var(--text-muted)">
                <template v-if="s.state === 'leased'">
                  <span v-if="s.external_url" style="color:var(--success,#30a46c)">🌐 對外曝露</span>
                  <span v-else>🔒 內網</span>
                  · 內部埠 {{ s.port }} · {{ s.project_name }} — {{ idleText(s) }}
                </template>
              </span>
            </div>
          </div>
        </div>

      </div>
    </div>
  `
});
