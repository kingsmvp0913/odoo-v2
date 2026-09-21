window.UnreadStore = Vue.reactive({ byProject: {} });
// 身分旗標集中放這裡。既有的 isAdmin 散落在殼層與 5 個分頁各算一次（歷史包袱，本版不動），
// 但新加的旗標一律只在這裡有一份——不要再複製第 6 份出來。
window.UserStore = Vue.reactive({
  role: '',
  isInternal: false,
  companyId: null,
  companyName: '',
  features: {},
  // 公司停用／過期（後端 index.js 的公司不可用閘門）。預設 true：載入中或 auth/me 還沒回來時
  // 一律當可用，免得每個人進站都先閃一下「公司帳號已停用」的全屏說明。
  companyUsable: true,
});
