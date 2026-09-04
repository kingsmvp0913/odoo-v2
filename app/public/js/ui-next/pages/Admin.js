(function () {
  window.UiNextAdminView = Vue.defineComponent({
    name: "UiNextAdminView",
    data() { return { cards: [
      { to: "/admin/settings", title: "系統設定", detail: "Odoo／eService 連線、Teams、Claude 與 Codex 憑證、用量閘門、context7、語意索引" },
      { to: "/admin/users", title: "使用者管理", detail: "帳號、角色與核准狀態" },
      { to: "/admin/agents", title: "Agent 管理", detail: "模型、提示詞與執行設定" },
      { to: "/admin/schedules", title: "排程", detail: "背景工作與執行週期" },
      { to: "/admin/health", title: "改善提案", detail: "健檢與意見回饋產生的待辦提案" },
      { to: "/admin/rejections", title: "退回原因", detail: "人工退回與分類" },
      { to: "/admin/classify-samples", title: "失敗分類樣本", detail: "待人工歸納的案例" },
      { to: "/admin/prompt-logs", title: "Prompt 記錄", detail: "送往 AI 的提示詞" },
      { to: "/admin/port-pool", title: "測試區 Port 池", detail: "Port 租用與狀態" },
      { to: "/admin/enterprise", title: "企業版來源", detail: "Enterprise addons 同步" },
      { to: "/admin/feedback", title: "意見回饋管理", detail: "使用者提交的意見與核准／駁回" },
    ] }; },
    template: `<section class="ui-next-page ui-next-admin-page"><header class="ui-next-page-head"><div><h1>管理員設定</h1><p>從工具卡進入特定維運工作，避免在首頁同時載入互不相關的設定表單。</p></div></header><section class="ui-next-admin-cards"><router-link v-for="card in cards" :key="card.to" :to="card.to" class="ui-next-panel"><h2>{{ card.title }}</h2><p>{{ card.detail }}</p></router-link></section></section>`,
  });
})();
