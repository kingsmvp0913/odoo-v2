// 上正式確認彈窗：專案詳細頁與專案列表頁共用（文案／衝突細節只有這一份，改一處兩邊生效）。
// 用法：<ReleaseModal v-if="releaseProjectId" :project-id="releaseProjectId" @close="releaseProjectId = null" />
// 掛載即抓待上正式清單；抓失敗直接關窗（錯誤走 toast），避免留一個空殼彈窗。
window.ReleaseModal = {
  name: 'ReleaseModal',
  props: { projectId: { type: [Number, String], required: true } },
  emits: ['close'],
  data() {
    return {
      pending: [], loading: true, working: false, repos: null, deploy: null,
      deploySkipped: false, deploySkipReason: null,
      // 後端說「這一按會不會動到客戶正式機」。預設當成不會，抓失敗時才不會憑空嚇人。
      prodDeploy: { autoDeploy: false, targets: 0, canRelease: false },
      confirmDeploy: false,
    };
  },
  computed: {
    // 會真的部署到客戶正式區才需要那道確認。條件與後端的閘門一致，
    // 否則畫面要人勾一個後端根本不看的框，或反過來沒勾就被擋（看起來像壞掉）。
    willDeployProd() {
      const p = this.prodDeploy || {};
      return !!(p.autoDeploy && p.targets > 0 && p.canRelease);
    },
    // 有目標可部署、但這個人沒權限：合併照做，正式區不會動。要先講，不要等按完才說。
    prodNeedsAdmin() {
      const p = this.prodDeploy || {};
      return !!(p.autoDeploy && p.targets > 0 && !p.canRelease);
    },
    // 沒勾確認時不把按鈕鎖住，改成讓標籤說實話：想只合併不部署是合理需求，
    // 鎖住按鈕會讓那個人以為畫面壞了，而且沒有別的地方可以只合併。
    actionLabel() {
      if (!this.willDeployProd) return '確認合併';
      return this.confirmDeploy ? '合併並部署正式區' : '只合併到 main（不部署）';
    },
  },
  async created() {
    try {
      const data = await Api.get(`projects/${this.projectId}/pending-release`);
      this.pending = data.tasks || [];
      if (data.prodDeploy) this.prodDeploy = data.prodDeploy;
    } catch (e) {
      showToast(e.message, 'error');
      this.$emit('close');
    } finally { this.loading = false; }
  },
  methods: {
    async doRelease() {
      this.working = true;
      this.repos = null; this.deploy = null; this.deploySkipped = false; this.deploySkipReason = null;
      try {
        const data = await Api.post(`projects/${this.projectId}/release`,
          { confirmDeploy: this.confirmDeploy === true });
        if (data.ok) {
          const n = (data.tasks || []).length;
          this.deploySkipped = !!data.deploySkipped;
          this.deploySkipReason = data.deploySkipReason || null;
          const failed = (data.deploy || []).filter((d) => !d.ok);
          if (failed.length) {
            // 部署失敗留在彈窗裡攤開。碼已經上 main 了，這時候關掉視窗等於把失敗藏起來——
            // 使用者會以為一切正常，但客戶正式區其實沒更新（且已回滾過一次）。
            this.deploy = data.deploy;
            showToast('已上正式，但正式區部署失敗', 'error', 0);
            return;
          }
          this.$emit('close');
          // ok 只代表「沒有任何 repo 失敗」；ai-dev 不存在時也是 ok，但實際什麼都沒上
          const base = n ? `已上正式，${n} 張任務` : '沒有任何變更需要上正式';
          if (this.deploySkipReason) {
            // 碼上了 main 但客戶正式區沒動，是兩件不同的事。這種半套結果要黏著不自動消失，
            // 否則使用者只會記得「成功了」，然後以為客戶已經在用新版。
            showToast(`${base}。${this.deploySkipReason}`, 'warn', 0);
            return;
          }
          const tail = (data.deploy || []).length ? '，正式區已部署' : '';
          showToast(base + tail, n ? 'success' : 'info');
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
      <div class="modal modal-elevated release-modal-width" role="dialog" aria-modal="true">
        <div class="modal-title">{{ prodDeploy.canRelease?'合併到正式（main）':'待上正式清單' }}</div>
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
                  class="release-task-row">
                  <span style="font-weight:var(--fw-semibold);flex-shrink:0">#{{ t.task_id }}</span>
                  <span style="flex:1;min-width:0">{{ t.title }}<br>
                    <small>{{ t.submitter_name }}<template v-if="t.submitter_company">（{{ t.submitter_company }}）</template> · {{ new Date(t.approved_at).toLocaleString('zh-TW') }} 核准</small>
                  </span>
                </div>
              </div>
              <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:var(--space-3)">
                ⚠ 會把整條 ai-dev 一次合併到 main，無法只挑其中幾張。
              </div>
              <!-- 會不會動到客戶正在用的系統，必須在按下去之前講，而且要講不可逆的那一半。
                   套 .error-msg 是為了拿它的 dark-mode 配色，不另外寫死顏色。 -->
              <div v-if="willDeployProd" class="error-msg" style="margin-top:var(--space-3)">
                <div><strong>這會直接部署到客戶的正式區</strong>（{{ prodDeploy.targets }} 個目標）。</div>
                <div style="margin-top:4px">
                  部署期間客戶會短暫斷線。升級失敗時程式檔案會自動還原，但<strong>資料庫的改動無法還原</strong>——平台不會備份客戶資料庫。
                </div>
                <label style="display:flex;align-items:flex-start;gap:6px;margin-top:8px;cursor:pointer">
                  <input type="checkbox" v-model="confirmDeploy" style="margin-top:3px;flex-shrink:0">
                  <span>我了解失敗時資料庫救不回來，確認一併部署到正式區</span>
                </label>
              </div>
              <div v-else-if="prodDeploy.canRelease && prodNeedsAdmin"
                style="font-size:var(--fs-sm);color:var(--text-muted);margin-top:var(--space-3)">
                此專案有啟用中的正式區部署目標，但部署到客戶正式區需要管理員權限。
                這次只會合併到 main，客戶正式區不會更新。
              </div>
            </template>
            <!-- 部署失敗細節：碼已經上 main 了，這裡不攤開就等於藏起來 -->
            <div v-if="deploy" style="margin-top:var(--space-3)">
              <div v-for="(d, i) in deploy" :key="i" style="margin-bottom:var(--space-2)">
                <div v-if="d.ok" style="font-size:var(--fs-sm);color:var(--text-muted)">
                  正式區已部署：{{ (d.modules || []).join(', ') || '無模組變更' }}
                </div>
                <div v-else class="error-msg" style="white-space:pre-wrap">
                  <div>程式已上 main，但<strong>正式區部署失敗</strong>：{{ d.error || '未知原因' }}</div>
                  <div style="margin-top:4px">程式檔案已還原並重啟，<strong>資料庫的改動不會還原</strong>。細節見專案頁的「自動部署」分頁。</div>
                </div>
              </div>
            </div>
            <!-- 失敗細節：哪個 repo、哪些檔案衝突，完整攤開 -->
            <div v-if="repos" style="margin-top:var(--space-3)">
              <div v-for="r in repos" :key="r.label" style="margin-bottom:var(--space-2)">
                <div style="font-size:var(--fs-base);font-weight:var(--fw-semibold)">{{ r.label }}</div>
                <div v-if="r.hasConflicts" class="error-msg">
                  <div>程式合併遇到衝突，尚未上正式。平台管理員處理中。</div>
                  <div v-if="r.conflictFiles.length" style="margin-top:4px">衝突檔案：</div>
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
          <button v-if="prodDeploy.canRelease" class="btn btn-primary" @click="doRelease"
            :disabled="working || loading || pending.length === 0">
            <span v-if="working" class="spinner"></span>{{ working ? '合併中…' : actionLabel }}
          </button>
        </div>
      </div>
    </div>
  `
};
