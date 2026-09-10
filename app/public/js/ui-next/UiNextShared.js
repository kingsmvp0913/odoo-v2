// UiNextPages.js 原本是一個大 IIFE，這些 helper／常數／區域元件是那個閉包內的共用部分。
// 拆檔後改成掛在單一命名空間上，由需要的檔自行取用。
//
// 不直接放到全域：Legacy 的 js/views/*.js 也是 classic script，同名頂層 const 會是
// SyntaxError（整支檔不執行、畫面白掉），而 fmtNumber／elapsed 這種名字很容易撞。
(function () {
  const fmtNumber = (value) => Number(value || 0).toLocaleString("zh-TW");
  // 對話的日期分隔文字。專案對話與任務對話共用，各寫一份會漂移成兩種寫法。
  const dayLabel = (value) => {
    const at = new Date(value), now = new Date();
    const days = Math.round((new Date(now.toDateString()) - new Date(at.toDateString())) / 86400000);
    if (days === 0) return "今天";
    if (days === 1) return "昨天";
    return at.toLocaleDateString("zh-TW", { year: at.getFullYear() === now.getFullYear() ? undefined : "numeric", month: "long", day: "numeric" });
  };
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
  // 傳入的是「已用掉的百分比」：剩不到 25% 轉紅、剩不到 50% 轉橘。
  const usageLevel = (pct) =>
    pct >= 75 ? "critical" : pct >= 50 ? "warning" : "healthy";
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

  // 專案下拉的排序：我的最愛 → 最近有互動 → 其餘按中文名。三十幾個專案時，
  // 按 API 原始順序排等於每次都要從頭找。
  //
  // 「最近」的來源由呼叫端決定，因為兩處算法不同：首頁新對話只算最近有對話，
  // 建立任務彈窗還要把最近有任務算進去（同一專案取兩者較新的那個時間）。
  // recencyRows 為 { project_id, at } 的陣列，at 是任何 Date 吃得下的時間值。
  const sortProjectsForPicker = (projects, recencyRows) => {
    const recency = new Map();
    (recencyRows || []).forEach((row) => {
      if (!row) return;
      const key = String(row.project_id);
      const at = new Date(row.at || 0).getTime();
      if (at && at > (recency.get(key) || 0)) recency.set(key, at);
    });
    const lastAt = (project) => recency.get(String(project.id)) || 0;
    const rank = (project) => (project.is_favorite ? 0 : lastAt(project) ? 1 : 2);
    return [...(projects || [])].sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 1) return lastAt(b) - lastAt(a);
      return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant");
    });
  };

  // 可打字過濾的專案下拉。首頁新對話的 composer 有同一種東西（UiNextApp.js 內），
  // 那顆綁著新手教學錨點與 composer 版面，所以留在原地；這裡是「放進表單」的版本。
  // 排序不在元件內做：呼叫端傳已排好的 projects 進來（見 sortProjectsForPicker）。
  const UiNextProjectPicker = Vue.defineComponent({
    name: "UiNextProjectPicker",
    components: { UiNextIcon: window.UiNextIcon },
    props: {
      projects: { type: Array, default: () => [] },
      modelValue: { type: [String, Number], default: "" },
      placeholder: { type: String, default: "選擇專案" },
    },
    emits: ["update:modelValue"],
    data() { return { open: false, query: "" }; },
    computed: {
      selected() { return this.projects.find((project) => String(project.id) === String(this.modelValue)); },
      filtered() {
        const query = this.query.trim().toLowerCase();
        if (!query) return this.projects;
        return this.projects.filter((project) => String(project.name || "").toLowerCase().includes(query));
      },
    },
    mounted() {
      this._onOutside = (event) => { if (!this.$el.contains(event.target)) this.open = false; };
      document.addEventListener("pointerdown", this._onOutside);
    },
    beforeUnmount() { document.removeEventListener("pointerdown", this._onOutside); },
    methods: {
      // 整格可點：點圖示、箭頭或留白都要展開，不是只有點到文字才算。
      openPicker() {
        if (!this.projects.length) return;
        this.open = true;
        this.query = "";
        this.$nextTick(() => this.$refs.trigger?.focus());
      },
      select(project) {
        this.open = false;
        this.query = "";
        this.$emit("update:modelValue", String(project.id));
      },
      onKeydown(event) {
        // Escape 要就地攔下不往上冒泡：這顆常放在對話框裡，讓它傳上去會連對話框一起關掉，
        // 使用者填到一半的內容就沒了。
        if (event.key === "Escape") {
          if (!this.open) return;
          event.stopPropagation();
          this.open = false;
          this.query = "";
          this.$nextTick(() => this.$refs.trigger?.focus());
          return;
        }
        // 打完字直接 Enter 就選中第一筆——要求先按方向鍵才選得到，等於把「可以打字」做一半。
        if (event.key === "Enter" && this.open && document.activeElement === this.$refs.trigger) {
          const first = this.filtered[0];
          if (first) { event.preventDefault(); this.select(first); }
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!this.open) { this.open = true; return; }
          const options = this.$refs.options ? Array.from(this.$refs.options.querySelectorAll("button")) : [];
          const index = options.indexOf(document.activeElement);
          (options[index + (event.key === "ArrowDown" ? 1 : -1)] || options[event.key === "ArrowDown" ? 0 : options.length - 1])?.focus();
        }
      },
    },
    template: `<div class="ui-next-project-picker" @keydown="onKeydown" @click="openPicker">
      <input ref="trigger" type="text" class="ui-next-project-picker-trigger" role="combobox" aria-autocomplete="list" :aria-expanded="open" :value="open ? query : (selected ? selected.name : '')" :placeholder="projects.length ? (selected ? selected.name : placeholder) : '沒有可用專案'" :disabled="!projects.length" @focus="open=true;query=''" @input="query=$event.target.value;open=true">
      <ui-next-icon name="chevron-down"/>
      <div v-if="open" ref="options" class="ui-next-project-picker-options" role="listbox" aria-label="選擇專案" @click.stop>
        <button v-for="project in filtered" :key="project.id" type="button" role="option" :aria-selected="String(project.id)===String(modelValue)" @click="select(project)">{{ project.name }}</button>
        <p v-if="!filtered.length">找不到符合的專案</p>
      </div>
    </div>`,
  });

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
    template: `<div><div data-tour="wiki-node-menu" class="ui-next-wiki-row" :class="{active:currentSlug===node.slug,'has-menu':menuSlug===node.slug,'has-guide':depth>0}" :style="{'--wiki-depth':depth}" @contextmenu.prevent="node.node_type!=='notes'&&$emit('menu',node.slug)"><button type="button" :data-tour="'wiki-node-' + node.node_type" class="ui-next-wiki-node" :style="{paddingLeft:(10+depth*14)+'px'}" @click="$emit('open',node.slug)">{{ node.title }}</button><button v-if="node.node_type!=='notes'" type="button" class="ui-next-wiki-more" :aria-label="node.title+' 更多操作'" :aria-expanded="menuSlug===node.slug?'true':'false'" aria-haspopup="menu" @click.stop="$emit('menu',menuSlug===node.slug?'':node.slug)"><ui-next-icon name="dots"/></button><div v-if="menuSlug===node.slug" class="ui-next-wiki-menu" role="menu"><button type="button" role="menuitem" :disabled="refreshing===node.slug||editingSlug===node.slug" @click="$emit('refresh',node.slug);$emit('menu','')">重新生成</button><button v-if="node.slug!=='troubleshooting'" type="button" role="menuitem" class="danger" @click="$emit('remove',node.slug);$emit('menu','')">刪除</button></div></div><ui-next-wiki-node v-for="child in node.children" :key="child.id" :node="child" :depth="depth+1" :current-slug="currentSlug" :refreshing="refreshing" :editing-slug="editingSlug" :menu-slug="menuSlug" @open="$emit('open',$event)" @refresh="$emit('refresh',$event)" @remove="$emit('remove',$event)" @menu="$emit('menu',$event)"/></div>`,
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

  // 下載某張任務的改動檔 zip。任務頁的頂欄與側欄的右鍵選單都要這個動作，放在這裡是因為
  // 重點不在下載本身，而是 stale／deleted 那兩則警示：stale＝這些檔在任務切點之後也被別人
  // 改過，直接覆蓋會蓋掉對方的改動；deleted＝zip 表達不了刪除。各寫一份遲早只剩一邊有警示。
  async function downloadTaskCodeZip(task) {
    let url = null;
    try {
      const { blob, headers } = await Api.getBlob(`tasks/${task.id}/code-zip`);
      // header 於伺服器端編碼過（非 ASCII 檔名會生出無效 header）；解不開就當沒有，不擋下載。
      const readList = (name) => {
        try { return JSON.parse(decodeURIComponent(headers.get(name) || "")) || []; }
        catch { return []; }
      };
      url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${task.task_id}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      const entries = readList("X-Zip-Entries");
      const deleted = readList("X-Zip-Deleted");
      const stale = readList("X-Zip-Stale");
      showToast(`已下載 ${entries.length} 個改動檔`, "success");
      if (stale.length) showToast(`⚠️ 這 ${stale.length} 個檔在本任務之後也被改過，覆蓋會蓋掉對方的改動：${stale.join("、")}`, "error");
      if (deleted.length) showToast(`⚠️ 本任務刪除了這些檔，請自行到正式區移除：${deleted.join("、")}`, "error");
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      // 撤銷必須晚於 click：過早撤掉會讓瀏覽器抓不到內容，下載靜默失敗。
      if (url) setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  }

  window.UiNextShared = { fmtNumber, fmtCompact, fmtUSD, dayLabel, AGENT_COLOR, agentColor, catColor, elapsed, usageLevel, usageTime, usageWindowLabel, UiNextStatusBar, UiNextWikiNode, UiNextProjectPicker, sortProjectsForPicker, SOP_FILLABLE_PLACEHOLDERS, downloadTaskCodeZip };
})();
