// 全域圖片放大跳窗。用法：previewImage({ src, alt, onDownload })
//
// 為什麼要統一一支：平台原本有三種「點圖」行為，而且三種都不是放大——
//   對話／意見回饋：window.open(objectURL) 另開分頁（離開現在這一頁）
//   任務詳情附件  ：直接觸發下載
//   題庫截圖      ：只有它自己有 lightbox（.ui-next-exam-lightbox）
// 而剛貼上、還沒送出的縮圖是 54px／34px，點了什麼都不會發生——看不清楚自己貼了什麼。
//
// 掛在兩套 shell 的根（同 confirm-dialog-host）：任何頁面、任何 component 都能直接呼叫，
// 不必把狀態一層層傳下去。CSS 放 app.css（兩套 UI 都載得到），不放 ui-next-pages/。
// ⚠ 整支包在 IIFE 裡：這是 classic script，頂層的 const 會落在全域。dialog.js 也寫了
// `const { reactive } = Vue`，兩支同名頂層 const ＝ SyntaxError，整支檔不執行、
// window.previewImage 永遠是 undefined，症狀是「點圖沒反應」而畫面其餘完全正常。
(function () {
const { reactive } = Vue;

const imagePreviewState = reactive({
  open: false,
  src: '',
  alt: '',
  onDownload: null,
  _trigger: null,
});
window.imagePreviewState = imagePreviewState;

function previewImage(opts = {}) {
  if (!opts.src) return;
  imagePreviewState.src = opts.src;
  imagePreviewState.alt = opts.alt || '';
  // 有 onDownload 才顯示下載鈕：待傳的縮圖還沒有檔案 id，下載無從談起。
  imagePreviewState.onDownload = typeof opts.onDownload === 'function' ? opts.onDownload : null;
  imagePreviewState._trigger = document.activeElement;
  imagePreviewState.open = true;
}
window.previewImage = previewImage;

window.ImagePreviewHost = {
  name: 'ImagePreviewHost',
  setup() { return { s: imagePreviewState }; },
  methods: {
    close() {
      if (!this.s.open) return;
      this.s.open = false;
      this.s.src = '';
      this.s.onDownload = null;
      // 焦點還原：不還原的話，關掉之後 Tab 會從頁面最前面重來一次。
      const trigger = this.s._trigger;
      this.s._trigger = null;
      if (trigger && trigger.focus) this.$nextTick(() => trigger.focus());
    },
    onDownload() {
      const fn = this.s.onDownload;
      if (fn) fn();
    },
    onKeydown(e) {
      if (!this.s.open) return;
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    },
  },
  watch: {
    's.open'(open) {
      if (!open) return;
      this.$nextTick(() => this.$refs.closeBtn && this.$refs.closeBtn.focus());
    },
  },
  mounted() { window.addEventListener('keydown', this.onKeydown); },
  unmounted() { window.removeEventListener('keydown', this.onKeydown); },
  template: `
    <transition name="modal-fade">
      <div v-if="s.open" class="img-lightbox" role="dialog" aria-modal="true" :aria-label="s.alt || '圖片預覽'" @mousedown.self="close">
        <img :src="s.src" :alt="s.alt" @mousedown.stop />
        <div class="img-lightbox-bar" @mousedown.stop>
          <span>{{ s.alt }}</span>
          <button v-if="s.onDownload" type="button" @click="onDownload">下載</button>
          <button ref="closeBtn" type="button" @click="close">關閉</button>
        </div>
      </div>
    </transition>
  `,
};
})();
