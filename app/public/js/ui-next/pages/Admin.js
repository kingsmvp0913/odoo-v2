(function () {
  window.UiNextAdminView = Vue.defineComponent({
    name: "UiNextAdminView",
    data() { return {
      // 更版狀態。已拍板的通知方式是「只在畫面上」，而 2026-09-22 使用者裁決把獨立的
      // 「平台更版」頁收掉（時段設定併進系統設定、待更版清單與「立刻更版」併進改善提案）之後，
      // **這一頁就是那條通知唯一的落點**：週一早上進來的人落在這裡，不會自己去翻設定頁。
      // 所以這裡不能只掛一顆紅點連過去——失敗的全文、該怎麼辦、以及「沒有任何東西會通知你」
      // 都必須在不點任何東西的情況下看得到。
      release: null,
      cards: [
      { to: "/admin/feedback", title: "改善提案", detail: "使用者意見與 AI 健檢提出的待辦，核准後當晚自動實作；已合併的修正在這裡按「立刻更版」讓它生效" },
      { to: "/admin/settings", title: "系統設定", detail: "Odoo／eService 連線、Teams、Claude 與 Codex 憑證、用量閘門、context7、語意索引、維護時段" },
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
      // 拿它判會把「跳過全跑但有重啟」誤報成失敗，也會把「根本沒跑起來」誤報成沒事。
      releaseFailed() { return !!this.last && this.last.restarted !== true; },
      envRevive() { return (this.last && this.last.envRevive) || null; },
      // 測試區沒救回來＝那幾台「開著但什麼都不動」（Odoo 的排程執行緒在平台重啟時死掉）。
      // 客戶要好幾天才會發現，所以即使更版本身成功也要在這裡講一句。
      envReviveFailed() {
        const e = this.envRevive;
        return !!e && ((e.failed || 0) + (e.overBudget || 0)) > 0;
      },
      envReviveFailures() { return (this.envRevive && this.envRevive.failures) || []; },
      // 「沒有任何東西會通知你」是讀資料得來的結論，不是寫死的一句文案：端點回的
      // notify.channels 是空陣列（本機沒有 webhook／Teams）。哪天真的接了通知管道，
      // 改的是後端那一個欄位，這一頁自己就會改口，不必有人記得回來改文案。
      notify() { return (this.release && this.release.notify) || null; },
      noNotifyChannels() {
        const n = this.notify;
        return !!n && Array.isArray(n.channels) && n.channels.length === 0;
      },
      pendingCount() { return (this.release && this.release.pending && this.release.pending.length) || 0; },
      lastAt() {
        const t = this.last && (this.last.windowStart || this.last.at);
        return t ? new Date(t).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '';
      },
      nextWindowText() {
        const at = this.release && this.release.window && this.release.window.nextWindowAt;
        return at ? new Date(at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '未設定（沒有設定時段，平台不會自己更版）';
      },
    },
    template: `<section class="ui-next-page ui-next-admin-page"><header class="ui-next-page-head"><div><h1>管理員設定</h1><p>從工具卡進入特定維運工作，避免在首頁同時載入互不相關的設定表單。</p></div></header>
      <!-- 上一次更版沒有成功／測試區沒救回來。整段攤開不收合：半夜兩點沒有人在，看到這段的人
           多半是隔了幾天才來的，只丟一句「失敗了」等於把問題再丟回去。 -->
      <div v-if="release && (releaseFailed || envReviveFailed)" class="ui-next-panel"
        :style="{ marginBottom:'14px', borderLeft:'3px solid var(--danger)' }">
        <strong :style="{ color:'var(--danger)' }">
          <template v-if="releaseFailed">⚠ 上一次更版沒有成功——平台還跑著舊碼</template>
          <template v-else>⚠ 上一次更版後有測試區沒有重開成功</template>
        </strong>
        <p :style="{ margin:'4px 0 0', color:'var(--text-muted)', fontSize:'13px', lineHeight:'1.45' }">
          {{ lastAt }}<span v-if="releaseFailed">・{{ last.reason || '原因未記錄' }}（待更版 {{ pendingCount }} 筆）</span>
        </p>
        <!-- 更版失敗的四步。第 3 步指的是「改善提案」頁——更版頁已經不存在，
             那一頁才有待更版清單與「立刻更版」。 -->
        <ol v-if="releaseFailed" :style="{ margin:'8px 0 0', paddingLeft:'1.2em', color:'var(--text)', fontSize:'13px', lineHeight:'1.8' }">
          <li>碼已經在 master、沒有遺失，只是還沒生效——平台現在跑的是舊碼。</li>
          <li>到平台主 clone 的 <code>app/</code> 下跑 <code>npm run test:quiet</code>，看是哪幾支紅的。</li>
          <li>修好並合併之後，到<router-link to="/admin/feedback">改善提案</router-link>按「立刻更版」，或等下一個維護時段（{{ nextWindowText }}）自己再試一次。</li>
          <li>確定紅燈與這批修正無關、非上不可時，才在那一頁勾「跳過重啟前全跑」——那一次不會留下測試證據。</li>
        </ol>
        <!-- 測試區沒救回來：那幾台的症狀是「開著但什麼都不動」，客戶不會來反映，
             所以要講到「是哪幾台、要做什麼」為止。這份紀錄（release_last_result.envRevive）
             除了這裡沒有第二個地方讀得到。 -->
        <div v-if="envReviveFailed" :style="{ marginTop:'8px', color:'var(--text)', fontSize:'13px', lineHeight:'1.6' }">
          重啟後有 {{ (envRevive.failed || 0) + (envRevive.overBudget || 0) }} 個測試區沒有重開成功（那一次共要重開 {{ envRevive.total || 0 }} 個）。
          它們現在「開著但什麼都不動」——Odoo 的排程（cron）執行緒在平台重啟時死掉了，只有整個測試區重開才會回來，
          而畫面上一切正常，客戶不會來反映。請到下列專案的環境頁把它們<strong>手動重啟</strong>：
          <div v-for="f in envReviveFailures" :key="f.projectId" :style="{ marginTop:'2px' }">
            ・專案 #{{ f.projectId }}：{{ f.error }}
          </div>
        </div>
      </div>
      <!-- 沒有任何東西會通知你。這句話不是註腳，是上面那張卡片存在的前提：
           以為會被通知的人不會自己來看，而半夜兩點全跑紅掉、碼停在 master 沒生效這件事，
           會就這樣安靜地放到下個週末。所以它一律顯示，不只在失敗時才出現。 -->
      <p v-if="release && noNotifyChannels" :style="{ margin:'0 0 14px', color:'var(--text-muted)', fontSize:'13px', lineHeight:'1.5' }">
        <strong :style="{ color:'var(--warning-strong)' }">沒有任何東西會通知你</strong>：{{ notify.note }}
        更版失敗不會寄信、不會跳通知、不會有人被叫起來——只有你自己回到這一頁才會知道。
        下一次維護時段 {{ nextWindowText }}，建議週一上班時看一眼。<span v-if="pendingCount">目前有 {{ pendingCount }} 筆已合併的修正等著生效。</span>
      </p>
      <p v-else-if="release" :style="{ margin:'0 0 14px', color:'var(--text-muted)', fontSize:'13px', lineHeight:'1.5' }">
        更版結果會送到：{{ notify.channels.join('、') }}。下一次維護時段 {{ nextWindowText }}。
      </p>
      <section data-tour="admin-tools" class="ui-next-admin-cards"><router-link v-for="card in cards" :key="card.to" :to="card.to" class="ui-next-panel"><h2>{{ card.title }}</h2><p>{{ card.detail }}</p></router-link></section></section>`,
  });
})();
