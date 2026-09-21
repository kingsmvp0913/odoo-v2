window.UnreadStore = Vue.reactive({ byProject: {} });
// 身分旗標集中放這裡。既有的 isAdmin 散落在殼層與 5 個分頁各算一次（歷史包袱，本版不動），
// 但新加的旗標一律只在這裡有一份——不要再複製第 6 份出來。
window.UserStore = Vue.reactive({
  role: '',
  isInternal: false,
  companyId: null,
  companyName: '',
  features: {},
});
