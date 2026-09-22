(function () {
  window.UiNextAdminView = Vue.defineComponent({
    name: "UiNextAdminView",
    data() { return {
      // 更版狀態。已拍板的通知方式是「只在畫面上」，而那條裁決有兩半：更版頁標紅「上週未成功」，
      // **管理員首頁掛一條**。只有後者是「不必事先知道要去哪裡看」的入口——週一早上進來的人
      // 落在這一頁，不會自己去開下拉選單裡的「平台更版」。少了這一條，半夜兩點全跑紅掉、
      // 碼停在 master 沒生效這件事就會安安靜靜地放到下個週末。
      release: null,
      cards: [
      { to: "/admin/feedback", title: "改善提案", detail: "使用者意見與 AI 健檢提出的待辦，核准後當晚自動實作" },
      { to: "/admin/release", title: "平台更版", detail: "已合併的修正什麼時候真的生效、上一次更版成功了沒、維護時段設定" },
      { to: "/admin/settings", title: "系統設定", detail: "Odoo／eService 連線、Teams、Claude 與 Codex 憑證、用量閘門、context7、語意索引" },
      { to: "/admin/companies", title: "公司管理", detail: "客戶公司的建立、使用期間、功能開關與 GIT 憑證" },
      { to: "/admin/users", title: "使用者管理", detail: "帳號、角色與啟用狀態" },
      { to: "/admin/agents", title: "Agent 管理", detail: "模型、提示詞與執行設定" },
      { to: "/admin/schedules", title: "排程", detail: "背景工作與執行週期" },
      { to: "/admin/rejections", title: "退回原因", detail: "人工退回與分類" },
      { to: "/admin/classify-samples", title: "失敗分類樣本", detail: "待人工歸納的案例" },
      { to: "/admin/prompt-logs", title: "Prompt 記錄", detail: "送往 AI 的提示詞" },
      { to: "/admin/port-pool", title: "測試區 Port 池", detail: "Port 租用與狀態" },
      { to: "/admin/enterprise", title: "企業版來源", detail: "Enterprise addons 同步" },
      { to: "/admin/health", title: "健檢紀錄", detail: "每輪健檢跑了什麼、有沒有失敗（當 log 看）" },
    ] }; },
    // 讀不到就不掛任何東西（多半是沒有平台管理員權限，那種帳號本來就不該看到更版狀態）：
    // 這一條是附加資訊，不該讓整頁因為它而變成錯誤畫面。
    async created() {
      try { this.release = await Api.get('admin/release'); } catch (e) { this.release = null; }
    },
    computed: {
      last() { return (this.release && this.release.last) || null; },
      // 判準只看 restarted：testsPassed 是三態而 null 不是通過（release.js 的契約），
      // 拿它判會把「跳過全跑但有重啟」誤報成失敗。與更版頁的 lastFailed 同一條規則。
      releaseFailed() { return !!this.last && this.last.restarted !== true; },
      // 測試區沒救回來＝那幾台「開著但什麼都不動」（Odoo 的排程執行緒在平台重啟時死掉）。
      // 客戶要好幾天才會發現，所以即使更版本身成功也要在這裡講一句。
      envReviveFailed() {
        const e = this.last && this.last.envRevive;
        return !!e && ((e.failed || 0) + (e.overBudget || 0)) > 0;
      },
      pendingCount() { return (this.release && this.release.pending && this.release.pending.length) || 0; },
      lastAt() {
        const t = this.last && (this.last.windowStart || this.last.at);
        return t ? new Date(t).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '';
      },
    },
    template: `<section class="ui-next-page ui-next-admin-page"><header class="ui-next-page-head"><div><h1>管理員設定</h1><p>從工具卡進入特定維運工作，避免在首頁同時載入互不相關的設定表單。</p></div></header>
      <router-link v-if="release && (releaseFailed || envReviveFailed)" to="/admin/release" class="ui-next-panel"
        :style="{ display:'block', marginBottom:'14px', color:'inherit', textDecoration:'none', borderLeft:'3px solid var(--danger)' }">
        <strong :style="{ color:'var(--danger)' }">
          <template v-if="releaseFailed">⚠ 上一次更版沒有成功——平台還跑著舊碼</template>
          <template v-else>⚠ 上一次更版後有測試區沒有重開成功</template>
        </strong>
        <p :style="{ margin:'4px 0 0', color:'var(--text-muted)', fontSize:'13px', lineHeight:'1.45' }">
          <template v-if="releaseFailed">{{ lastAt }}・{{ last.reason || '原因未記錄' }}（待更版 {{ pendingCount }} 筆）</template>
          <template v-else>{{ lastAt }}・那幾個測試區現在「開著但什麼都不動」（Odoo 的排程執行緒已經死了），要人工重啟才會回來。</template>
          點這裡看「平台更版」——沒有任何東西會通知你，只有自己來看才會知道。
        </p>
      </router-link>
      <section data-tour="admin-tools" class="ui-next-admin-cards"><router-link v-for="card in cards" :key="card.to" :to="card.to" class="ui-next-panel"><h2>{{ card.title }}</h2><p>{{ card.detail }}</p></router-link></section></section>`,
  });
})();
