// UiNextPages.js 原本是一個大 IIFE，這些 helper／常數／區域元件是那個閉包內的共用部分。
// 拆檔後改成掛在單一命名空間上，由需要的檔自行取用。
//
// 不直接放到全域：Legacy 的 js/views/*.js 也是 classic script，同名頂層 const 會是
// SyntaxError（整支檔不執行、畫面白掉），而 fmtNumber／elapsed 這種名字很容易撞。
(function () {
  const fmtNumber = (value) => Number(value || 0).toLocaleString("zh-TW");
  const fmtCompact = (value) => {
    const n = Number(value || 0);
    if (n >= 1e6)
      return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
    if (n >= 1e3)
      return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "")}K`;
    return String(Math.round(n));
  };
  // 小額多留精度：對話成本常落在 cent 以下，一律 4 位會把 $0.00003 印成 $0.0000（看起來像沒花錢）
  const fmtUSD = (value) => {
    const n = Number(value || 0);
    if (n >= 1000) return `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
    if (n >= 1) return `$${n.toFixed(2)}`;
    if (n >= 0.01) return `$${n.toFixed(3)}`;
    return n ? `$${n.toFixed(5)}` : "$0";
  };
  // agent 語意固定色：用量報表的占比清單、關卡表與展開列共用同一份，跨區塊顏色一致
  const AGENT_COLOR = {
    analysis: "#2a78d6", coding: "#1baf7a", qa: "#eda100", cs: "#4a3aa7",
    merge: "#e87ba4", deploy_fix: "#e34948", wiki: "#0891b2", chat: "#eb6834",
    triage: "#6b7280", workflow_health: "#008300",
  };
  const agentColor = (type) => AGENT_COLOR[type] || "#94a3b8";
  // 專案／使用者無語意色：依序取 20 色類別盤（隨主題切換深淺），超過 20 筆才用黃金角補色
  const catColor = (index) =>
    index < 20 ? `var(--cat-${index + 1})` : `hsl(${Math.round((index * 137.508) % 360)}, 65%, 55%)`;
  const elapsed = (value) => {
    const seconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
    if (seconds >= 3600)
      return `${Math.floor(seconds / 3600)} 小時 ${Math.floor((seconds % 3600) / 60)} 分`;
    if (seconds >= 60)
      return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    return `${seconds} 秒`;
  };
  const usageLevel = (pct) =>
    pct >= 90 ? "critical" : pct >= 70 ? "warning" : "healthy";
  // 額度視窗的重置／更新時刻。5 小時的窗常跨到隔天凌晨，只印時分會被讀成「早就過了」，
  // 所以不同天就把日期帶上。左下角與用量報表共用同一份，措辭不會各自漂移。
  const usageTime = (value) => {
    if (!value) return "—";
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return "—";
    const time = at.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
    return at.toDateString() === new Date().toDateString() ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`;
  };
  // Codex 的額度視窗長度由 API 給分鐘數（300／10080），Claude 則是固定的兩種窗。
  const usageWindowLabel = (minutes) => {
    const value = Number(minutes);
    if (!value) return "";
    if (value % 1440 === 0) return `${value / 1440} 天`;
    if (value % 60 === 0) return `${value / 60} 小時`;
    return `${value} 分鐘`;
  };

  // 任務清單的流程列獨立由狀態 registry 推導，不依賴 Legacy View。
  const UiNextStatusBar = Vue.defineComponent({
    name: "UiNextStatusBar",
    components: { UiNextIcon: window.UiNextIcon },
    props: { status: String, source: String, gitBranch: String, e2eDisabled: Boolean },
    computed: { isNew() { return this.status === "new"; }, isStopped() { return ["stopped", "merge_conflict"].includes(this.status); }, flow() { const dev = [{ label: "分析", statuses: ["analysis_running", "branch_pending"] }, { label: "確認", statuses: ["confirm_pending", "confirm_answered", "clarify_pending", "clarify_answered", "spec_review"] }, { label: "開發", statuses: ["coding_running"] }, { label: "QA", statuses: ["qa_running", "merge_running"] }, { label: "部署", statuses: ["deploy_testing"] }, { label: "測試", statuses: ["playwright_running"] }, { label: "審核", statuses: ["review_pending", "wiki_updating"] }, { label: "完成", statuses: ["done"] }]; const customer = [{ label: "客服", statuses: ["cs_running"] }, { label: "確認", statuses: ["cs_reply_pending"] }, { label: "完成", statuses: ["done"] }]; const customerData = [{ label: "客服", statuses: ["cs_running"] }, { label: "補資料", statuses: ["cs_data_needed"] }, { label: "確認", statuses: ["cs_reply_pending"] }, { label: "完成", statuses: ["done"] }]; if (this.status === "cs_data_needed") return customerData; if (["cs_running", "cs_reply_pending"].includes(this.status)) return customer; if (this.status === "done" && this.source === "service" && !this.gitBranch) return customer; const steps = this.source === "service" ? [{ label: "客服", statuses: ["cs_running"] }, ...dev] : dev; return this.e2eDisabled ? steps.filter((step) => step.label !== "測試") : steps; }, activeIdx() { if (this.status === "done") return this.flow.length; const index = this.flow.findIndex((step) => step.statuses.includes(this.status)); return index === -1 ? 0 : index; } },
    template: `<div v-if="!isNew" class="stepper" :aria-label="'任務進度：'+status"><template v-for="(step,index) in flow" :key="step.label"><div class="step-node" :class="{'sn-done':!isStopped&&index<activeIdx,'sn-active':!isStopped&&index===activeIdx,'sn-error':isStopped,'sn-future':!isStopped&&index>activeIdx}" :aria-current="!isStopped&&index===activeIdx ? 'step' : null"><div class="step-circle"><ui-next-icon v-if="isStopped" name="alert"/><ui-next-icon v-else-if="index<activeIdx" name="check"/><span v-else>{{ index + 1 }}</span></div><div class="step-label">{{ step.label }}</div></div><div v-if="index<flow.length-1" class="step-connector" :class="{'sc-done':!isStopped&&index<activeIdx,'sc-error':isStopped}"></div></template></div>`,
  });
  const UiNextWikiNode = Vue.defineComponent({
    name: "UiNextWikiNode", components: { UiNextIcon: window.UiNextIcon }, props: { node: Object, depth: Number, currentSlug: String, refreshing: String, editingSlug: String, menuSlug: String }, emits: ["open", "refresh", "remove", "menu"],
    template: `<div><div class="ui-next-wiki-row" :class="{active:currentSlug===node.slug,'has-menu':menuSlug===node.slug,'has-guide':depth>0}" :style="{'--wiki-depth':depth}" @contextmenu.prevent="node.node_type!=='notes'&&$emit('menu',node.slug)"><button type="button" class="ui-next-wiki-node" :style="{paddingLeft:(10+depth*14)+'px'}" @click="$emit('open',node.slug)">{{ node.title }}</button><button v-if="node.node_type!=='notes'" type="button" class="ui-next-wiki-more" :aria-label="node.title+' 更多操作'" :aria-expanded="menuSlug===node.slug?'true':'false'" aria-haspopup="menu" @click.stop="$emit('menu',menuSlug===node.slug?'':node.slug)"><ui-next-icon name="dots"/></button><div v-if="menuSlug===node.slug" class="ui-next-wiki-menu" role="menu"><button type="button" role="menuitem" :disabled="refreshing===node.slug||editingSlug===node.slug" @click="$emit('refresh',node.slug);$emit('menu','')">重新生成</button><button v-if="node.slug!=='troubleshooting'" type="button" role="menuitem" class="danger" @click="$emit('remove',node.slug);$emit('menu','')">刪除</button></div></div><ui-next-wiki-node v-for="child in node.children" :key="child.id" :node="child" :depth="depth+1" :current-slug="currentSlug" :refreshing="refreshing" :editing-slug="editingSlug" :menu-slug="menuSlug" @open="$emit('open',$event)" @refresh="$emit('refresh',$event)" @remove="$emit('remove',$event)" @menu="$emit('menu',$event)"/></div>`,
  });
  // 複製鈕守衛的判準：只擋「頁面上有對應輸入欄、使用者填了就會消失」的佔位。
  //
  // 認定方式＝這個字串是不是 v()／dbOf()／newAddonsDir() 在欄位留空時填進去的預設值。是的話
  // 就有欄位能消掉它，擋住才有意義——Legacy 完全無守衛，會讓人複製出
  // `sudo sed -i "s#<舊 addons 路徑>#…"` 這種跑下去會改錯檔的指令。
  //
  // 反之，步驟 1 的 <服務名>／<設定檔路徑>／<addons 路徑> 與步驟 4 的 <repo 網址>／
  // <該頁給的 token>／<該頁給的下載網址> 是硬寫死在指令裡的操作指示：本來就要人自己看著填，
  // 沒有任何欄位能讓它消失。用通用的 /<[^>]+>/ 去擋，那兩顆鈕就永久按不下去。
  //
  // 第二欄是 disabled 時要告訴使用者去填哪一欄——按不下去卻不說原因，跟壞掉沒兩樣。
  const SOP_FILLABLE_PLACEHOLDERS = [
    ["<正式 addons 路徑>", "正式區的「目前 addons 路徑」"],
    ["<舊 addons 路徑>", "測試區的「目前 addons 路徑」"],
    ["<新的 addons 路徑>", "正式／測試區的「目前 addons 路徑」"],
    ["<正式設定檔>", "正式區的「設定檔路徑」"],
    ["<測試設定檔>", "測試區的「設定檔路徑」"],
    ["<測試設定檔路徑>", "測試區的「設定檔路徑」"],
    ["<正式服務名>", "正式區的「systemd 服務名」"],
    ["<測試服務名>", "測試區的「systemd 服務名」"],
    ["<資料庫名稱>", "兩區的「連線」"],
    ["<登入帳號>", "正式區的「連線」"],
    ["<repo URL>", "「Repo URL」"],
    ["<模組名>", "「自訂模組名稱」"],
  ];


  window.UiNextShared = { fmtNumber, fmtCompact, fmtUSD, AGENT_COLOR, agentColor, catColor, elapsed, usageLevel, usageTime, usageWindowLabel, UiNextStatusBar, UiNextWikiNode, SOP_FILLABLE_PLACEHOLDERS };
})();
