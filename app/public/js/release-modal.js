// 上正式確認彈窗：專案詳細頁與專案列表頁共用（文案／衝突細節只有這一份，改一處兩邊生效）。
// 用法：<ReleaseModal v-if="releaseProjectId" :project-id="releaseProjectId" @close="releaseProjectId = null" />
// 掛載即抓待上正式清單；抓失敗直接關窗（錯誤走 toast），避免留一個空殼彈窗。
window.ReleaseModal = {
  name: 'ReleaseModal',
  props: { projectId: { type: [Number, String], required: true } },
  emits: ['close'],
  data() {
    return { pending: [], loading: true, working: false, repos: null };
  },
  async created() {
    try {
      const data = await Api.get(`projects/${this.projectId}/pending-release`);
      this.pending = data.tasks || [];
    } catch (e) {
      showToast(e.message, 'error');
      this.$emit('close');
    } finally { this.loading = false; }
  },
  methods: {
    async doRelease() {
      this.working = true;
      this.repos = null;
      try {
        const data = await Api.post(`projects/${this.projectId}/release`, {});
        if (data.ok) {
          const n = (data.tasks || []).length;
          this.$emit('close');
          // ok 只代表「沒有任何 repo 失敗」；ai-dev 不存在時也是 ok，但實際什麼都沒上
          showToast(n ? `已上正式，${n} 張任務` : '沒有任何變更需要上正式', n ? 'success' : 'info');
        } else {
          // 失敗細節留在彈窗裡攤開，不縮成一句 toast
          this.repos = data.repos || [];
        }
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.working = false; }
    }
  },
  template: `
    <div class="modal-overlay" @mousedown.self="$emit('close')" @keyup.esc="$emit('close')">
      <div class="modal modal-elevated" role="dialog" aria-modal="true" style="width:600px">
        <div class="modal-title">合併到正式（main）</div>
        <div class="modal-body">
          <div v-if="loading" class="loading">載入中...</div>
          <template v-else>
            <div v-if="pending.length === 0" style="color:var(--text-muted);font-size:var(--fs-base)">
              目前沒有待上正式的任務。
            </div>
            <template v-else>
              <div style="font-size:var(--fs-base);margin-bottom:var(--space-3)">
                以下 {{ pending.length }} 張任務已核准、尚未上正式：
              </div>
              <div style="max-height:280px;overflow-y:auto">
                <div v-for="t in pending" :key="t.task_id"
                  style="display:flex;gap:var(--space-2);align-items:baseline;padding:6px 0;border-bottom:1px solid var(--border)">
                  <span style="font-weight:var(--fw-semibold);flex-shrink:0">#{{ t.task_id }}</span>
                  <span style="flex:1;min-width:0">{{ t.title }}</span>
                  <span style="font-size:var(--fs-xs);color:var(--text-muted);flex-shrink:0">{{ t.status }}</span>
                </div>
              </div>
              <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:var(--space-3)">
                ⚠ 會把整條 ai-dev 一次合併到 main，無法只挑其中幾張。
              </div>
            </template>
            <!-- 失敗細節：哪個 repo、哪些檔案衝突，完整攤開 -->
            <div v-if="repos" style="margin-top:var(--space-3)">
              <div v-for="r in repos" :key="r.label" style="margin-bottom:var(--space-2)">
                <div style="font-size:var(--fs-base);font-weight:var(--fw-semibold)">{{ r.label }}</div>
                <div v-if="r.hasConflicts" class="error-msg">
                  <div>合併衝突，未上正式。main 有平台以外的改動，請先在 GitHub 上處理。</div>
                  <div style="margin-top:4px">衝突檔案：</div>
                  <div v-for="f in r.conflictFiles" :key="f" style="font-family:monospace;font-size:var(--fs-xs)">{{ f }}</div>
                </div>
                <div v-else-if="r.error" class="error-msg" style="white-space:pre-wrap">{{ r.error }}</div>
                <div v-else-if="r.merged" style="font-size:var(--fs-sm);color:var(--text-muted)">已合併</div>
                <div v-else style="font-size:var(--fs-sm);color:var(--text-muted)">無 ai-dev 分支，略過</div>
                <div v-if="r.restoreFailed" class="error-msg" style="white-space:pre-wrap;margin-top:4px">主 clone 未能切回 testing 分支，請到專案頁的「Odoo 測試環境」重建環境後再部署。</div>
              </div>
            </div>
          </template>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="$emit('close')" :disabled="working">取消</button>
          <button class="btn btn-primary" @click="doRelease"
            :disabled="working || loading || pending.length === 0">
            <span v-if="working" class="spinner"></span>{{ working ? '合併中…' : '確認合併' }}
          </button>
        </div>
      </div>
    </div>
  `
};
