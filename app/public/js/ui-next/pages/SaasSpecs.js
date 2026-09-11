(function () {
  // 產品化規格頁（只給平台管理員）。內容是 docs/ 裡一份自帶樣式與導覽的獨立 HTML，
  // 從帶 token 的 API 取回後放進 sandbox iframe：
  // - 不能讓 iframe 直接用 src 指到 API：瀏覽器載 iframe 不會帶 Authorization header，只會拿到 401
  // - sandbox 刻意只給 allow-scripts、不給 allow-same-origin：那份 HTML 會從外部 CDN 載入 markdown 函式庫，
  //   同源的話那段外部程式讀得到平台 localStorage 裡的登入 token
  window.UiNextSaasSpecsView = Vue.defineComponent({
    name: "UiNextSaasSpecsView",
    data() { return { html: "", error: "", loading: true }; },
    async created() {
      try {
        const { blob } = await Api.getBlob("docs/saas-specs");
        this.html = await blob.text();
      } catch (error) {
        this.error = error.message || "無法載入規格頁";
      } finally {
        this.loading = false;
      }
    },
    template: `<section class="ui-next-page ui-next-specs-page"><header class="ui-next-page-head"><div><h1>產品化規格</h1><p>平台 SaaS 化的總覽、開發順序與五塊規格。只有管理員看得到。</p></div></header><p v-if="error" class="ui-next-error-text">{{ error }}</p><p v-else-if="loading" class="ui-next-field-note">載入中…</p><iframe v-else class="ui-next-specs-frame" title="產品化規格" sandbox="allow-scripts" :srcdoc="html"></iframe></section>`,
  });
})();
