// 全域確認對話框（取代原生 confirm/prompt）。
// 用法：if (!await confirmDialog({ title, message, danger, confirmText })) return;
// 危險刪除可傳 requireText，需輸入相符字串才能確認。
const { reactive } = Vue;

const dialogState = reactive({
  open: false,
  title: '請確認',
  message: '',
  confirmText: '確定',
  cancelText: '取消',
  danger: false,
  requireText: null,
  _input: '',
  _resolve: null,
});
window.dialogState = dialogState;

function confirmDialog(opts = {}) {
  return new Promise((resolve) => {
    // 若已有開啟中的對話框，先取消它，避免 resolve 遺失
    if (dialogState._resolve) dialogState._resolve(false);
    dialogState.title = opts.title || '請確認';
    dialogState.message = opts.message || '';
    dialogState.danger = !!opts.danger;
    dialogState.confirmText = opts.confirmText || (opts.danger ? '刪除' : '確定');
    dialogState.cancelText = opts.cancelText || '取消';
    dialogState.requireText = opts.requireText || null;
    dialogState._input = '';
    dialogState._resolve = resolve;
    dialogState.open = true;
  });
}
window.confirmDialog = confirmDialog;

window.ConfirmDialogHost = {
  name: 'ConfirmDialogHost',
  setup() { return { s: dialogState }; },
  computed: {
    canConfirm() {
      if (!this.s.requireText) return true;
      return this.s._input.trim() === this.s.requireText;
    }
  },
  methods: {
    settle(val) {
      if (!this.s.open) return;
      this.s.open = false;
      const r = this.s._resolve;
      this.s._resolve = null;
      if (r) r(val);
    },
    onConfirm() { if (this.canConfirm) this.settle(true); },
    onCancel() { this.settle(false); },
    onKeydown(e) {
      if (!this.s.open) return;
      if (e.key === 'Escape') { e.preventDefault(); this.onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); this.onConfirm(); }
    }
  },
  watch: {
    's.open'(open) {
      if (!open) return;
      this.$nextTick(() => {
        const el = this.s.requireText ? this.$refs.input : this.$refs.confirmBtn;
        if (el) el.focus();
      });
    }
  },
  mounted() { window.addEventListener('keydown', this.onKeydown); },
  unmounted() { window.removeEventListener('keydown', this.onKeydown); },
  template: `
    <transition name="modal-fade">
      <div v-if="s.open" class="modal-overlay" @mousedown.self="onCancel">
        <div class="modal" role="dialog" aria-modal="true" @mousedown.stop>
          <div class="modal-title">{{ s.title }}</div>
          <div class="modal-body">
            <p style="white-space:pre-wrap;margin:0">{{ s.message }}</p>
            <div v-if="s.requireText" style="margin-top:var(--space-4)">
              <label class="field-label" style="display:block;margin-bottom:var(--space-2)">
                請輸入 <code>{{ s.requireText }}</code> 以確認
              </label>
              <input ref="input" class="form-control" v-model="s._input" :placeholder="s.requireText" autocomplete="off" />
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn btn-outline" @click="onCancel">{{ s.cancelText }}</button>
            <button ref="confirmBtn" class="btn" :class="s.danger ? 'btn-danger' : 'btn-primary'"
              :disabled="!canConfirm" @click="onConfirm">{{ s.confirmText }}</button>
          </div>
        </div>
      </div>
    </transition>
  `
};
