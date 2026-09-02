(function () {
  window.UiNextLoginView = Vue.defineComponent({
    name: "UiNextLoginView",
    data() {
      return {
        mode: "login",
        step: 1,
        form: { username: "", password: "", displayName: "" },
        credentials: {
          odooUsername: "",
          odooPassword: "",
          odooUserId: "",
          serviceUsername: "",
          servicePassword: "",
          serviceUserId: "",
        },
        git: { pat: "", login: "", pending: false, configured: false },
        odoo: { pending: false, configured: false },
        service: { pending: false, configured: false },
        notification: { supported: !!(window.NotifyManager && NotifyManager.supported), configured: false },
        loading: false,
        error: "",
      };
    },
    computed: {
      steps() {
        return ["建立帳號", "Git 認證", "Odoo 帳密", "eService 帳密", "桌面通知", "完成"];
      },
      patLink() {
        return "https://github.com/settings/tokens/new?scopes=repo&description=aidev-platform";
      },
    },
    async created() {
      const status = await Api.checkSetup().catch(() => ({ setup_done: false }));
      if (!status.setup_done) this.mode = "setup";
    },
    methods: {
      resetError() {
        this.error = "";
      },
      async submitLogin() {
        this.loading = true;
        this.resetError();
        try {
          const endpoint = this.mode === "setup" ? "auth/setup" : "auth/login";
          const payload = this.mode === "setup"
            ? { username: this.form.username, password: this.form.password, display_name: this.form.displayName }
            : { username: this.form.username, password: this.form.password };
          const result = await Api.post(endpoint, payload);
          Api.setToken(result.token);
          const redirect = this.$route.query.redirect;
          this.$router.push(typeof redirect === "string" && redirect.startsWith("/") ? redirect : "/");
        } catch (error) {
          this.error = error.message || "無法登入，請確認帳號與密碼。";
        } finally {
          this.loading = false;
        }
      },
      startRegister() {
        this.mode = "register";
        this.step = 1;
        this.resetError();
      },
      backToLogin() {
        Api.clearToken();
        this.mode = "login";
        this.step = 1;
        this.resetError();
      },
      async registerAccount() {
        if (!this.form.username || !this.form.password || !this.form.displayName) {
          this.error = "請填寫顯示名稱、帳號與密碼。";
          return;
        }
        if (this.form.password.length < 8) {
          this.error = "密碼至少需要 8 個字元。";
          return;
        }
        this.loading = true;
        this.resetError();
        try {
          const result = await Api.post("auth/register", {
            username: this.form.username,
            password: this.form.password,
            display_name: this.form.displayName,
          });
          Api.setToken(result.token);
          this.step = 2;
        } catch (error) {
          this.error = error.message || "無法建立帳號。";
        } finally {
          this.loading = false;
        }
      },
      async verifyGit() {
        if (!this.git.pat.trim()) {
          this.error = "請貼上 GitHub PAT。";
          return;
        }
        this.git.pending = true;
        this.resetError();
        try {
          const result = await Api.post("settings/github-pat", { pat: this.git.pat.trim() });
          this.git.login = result.login || "已連結帳號";
          this.git.pat = "";
          this.git.configured = true;
        } catch (error) {
          this.error = error.message || "PAT 驗證失敗。";
        } finally {
          this.git.pending = false;
        }
      },
      async verifyOdoo() {
        if (!this.credentials.odooUsername || !this.credentials.odooPassword) {
          this.error = "請填寫 Odoo 帳號和密碼。";
          return;
        }
        this.odoo.pending = true;
        this.resetError();
        try {
          const result = await Api.post("settings/verify-odoo", {
            odoo_username: this.credentials.odooUsername,
            odoo_password: this.credentials.odooPassword,
          });
          this.credentials.odooUserId = String(result.uid);
          await this.saveCredentials();
          this.credentials.odooPassword = "";
          this.odoo.configured = true;
          this.step = 4;
        } catch (error) {
          this.error = error.message || "Odoo 帳密驗證失敗。";
        } finally {
          this.odoo.pending = false;
        }
      },
      async verifyService() {
        if (!this.credentials.serviceUsername || !this.credentials.servicePassword) {
          this.error = "請填寫 eService 帳號和密碼。";
          return;
        }
        this.service.pending = true;
        this.resetError();
        try {
          const result = await Api.post("settings/verify-service", {
            service_username: this.credentials.serviceUsername,
            service_password: this.credentials.servicePassword,
          });
          this.credentials.serviceUserId = String(result.uid);
          await this.saveCredentials();
          this.credentials.servicePassword = "";
          this.service.configured = true;
          this.step = 5;
        } catch (error) {
          this.error = error.message || "eService 帳密驗證失敗。";
        } finally {
          this.service.pending = false;
        }
      },
      async saveCredentials() {
        await Api.put("settings", {
          odoo_settings: {
            odoo_username: this.credentials.odooUsername,
            odoo_password: this.credentials.odooPassword,
            odoo_user_id: this.credentials.odooUserId,
            service_username: this.credentials.serviceUsername,
            service_password: this.credentials.servicePassword,
            service_user_id: this.credentials.serviceUserId,
          },
        });
      },
      async enableNotification() {
        this.resetError();
        try {
          const result = await NotifyManager.enable();
          this.notification.configured = !!(result && result.ok);
          if (this.notification.configured) this.step = 6;
          else this.error = "瀏覽器未授權通知；你可稍後在設定頁開啟。";
        } catch {
          this.error = "無法開啟通知；你可略過並稍後設定。";
        }
      },
      goStep(step) {
        this.step = step;
        this.resetError();
      },
    },
    template: `
      <main class="ui-next-login" data-ui="next" aria-labelledby="ui-next-login-title">
        <section class="ui-next-login-card" :aria-busy="loading">
          <header>
            <img src="favicon.svg" alt="OAA">
            <p>Odoo AI 自動開發平台</p>
            <h1 id="ui-next-login-title">{{ mode === 'setup' ? '建立管理帳號' : mode === 'register' ? '註冊帳號' : '登入工作台' }}</h1>
          </header>
          <p v-if="error" class="ui-next-login-error" role="alert">{{ error }}</p>

          <form v-if="mode !== 'register'" @submit.prevent="submitLogin">
            <label v-if="mode === 'setup'">顯示名稱<input v-model.trim="form.displayName" required autocomplete="name"></label>
            <label>帳號<input v-model.trim="form.username" required autocomplete="username"></label>
            <label>密碼<input v-model="form.password" type="password" required autocomplete="current-password"></label>
            <button class="ui-next-primary" type="submit" :disabled="loading">{{ loading ? '處理中…' : mode === 'setup' ? '建立帳號' : '登入' }}</button>
          </form>

          <template v-else>
            <ol class="ui-next-register-steps" aria-label="註冊步驟">
              <li v-for="(label, index) in steps" :key="label" :class="{ active: step === index + 1, done: step > index + 1 }">{{ index + 1 }}. {{ label }}</li>
            </ol>
            <section v-if="step === 1" class="ui-next-register-panel">
              <label>顯示名稱<input v-model.trim="form.displayName" autocomplete="name"></label>
              <label>帳號<input v-model.trim="form.username" autocomplete="username"></label>
              <label>密碼<input v-model="form.password" type="password" autocomplete="new-password" aria-describedby="register-password-help"></label>
              <small id="register-password-help">密碼至少 8 個字元。</small>
              <button class="ui-next-primary" type="button" :disabled="loading" @click="registerAccount">{{ loading ? '建立中…' : '下一步' }}</button>
            </section>
            <section v-else-if="step === 2" class="ui-next-register-panel">
              <p>GitHub PAT 會加密保存，只用於你授權的 clone、commit 與 push 操作。</p>
              <a :href="patLink" target="_blank" rel="noopener noreferrer">建立 GitHub PAT（需要 repo 權限）</a>
              <p v-if="git.configured" class="ui-next-login-success">已連結 GitHub 帳號：{{ git.login }}</p>
              <label v-else>GitHub PAT<input v-model="git.pat" type="password" autocomplete="off"></label>
              <button v-if="!git.configured" class="ui-next-primary" type="button" :disabled="git.pending" @click="verifyGit">{{ git.pending ? '驗證中…' : '驗證並儲存' }}</button>
              <div class="ui-next-login-actions"><button type="button" @click="goStep(1)">上一步</button><button type="button" @click="goStep(3)">{{ git.configured ? '下一步' : '略過，稍後設定' }}</button></div>
            </section>
            <section v-else-if="step === 3" class="ui-next-register-panel">
              <p>平台會用這組帳密同步你負責的 Odoo 工單。</p>
              <label>Odoo 帳號<input v-model.trim="credentials.odooUsername" autocomplete="username"></label>
              <label>Odoo 密碼<input v-model="credentials.odooPassword" type="password" autocomplete="current-password"></label>
              <button class="ui-next-primary" type="button" :disabled="odoo.pending" @click="verifyOdoo">{{ odoo.pending ? '驗證中…' : '驗證並繼續' }}</button>
              <div class="ui-next-login-actions"><button type="button" @click="goStep(2)">上一步</button><button type="button" @click="goStep(4)">略過，稍後設定</button></div>
            </section>
            <section v-else-if="step === 4" class="ui-next-register-panel">
              <p>平台會用這組帳密同步你的 eService 客服工單。</p>
              <label>eService 帳號<input v-model.trim="credentials.serviceUsername" autocomplete="username"></label>
              <label>eService 密碼<input v-model="credentials.servicePassword" type="password" autocomplete="current-password"></label>
              <button class="ui-next-primary" type="button" :disabled="service.pending" @click="verifyService">{{ service.pending ? '驗證中…' : '驗證並繼續' }}</button>
              <div class="ui-next-login-actions"><button type="button" @click="goStep(3)">上一步</button><button type="button" @click="goStep(5)">略過，稍後設定</button></div>
            </section>
            <section v-else-if="step === 5" class="ui-next-register-panel">
              <p>開啟桌面通知後，任務需要處理時瀏覽器會即時提醒你。</p>
              <p v-if="!notification.supported" class="ui-next-login-error">此瀏覽器不支援桌面通知，可略過。</p>
              <p v-else-if="notification.configured" class="ui-next-login-success">桌面通知已開啟。</p>
              <button v-else class="ui-next-primary" type="button" @click="enableNotification">開啟桌面通知</button>
              <div class="ui-next-login-actions"><button type="button" @click="goStep(4)">上一步</button><button type="button" @click="goStep(6)">略過，完成</button></div>
            </section>
            <section v-else class="ui-next-register-panel">
              <h2>註冊完成</h2>
              <p>帳號已建立，等待管理員核准後即可登入。</p>
              <button class="ui-next-primary" type="button" @click="backToLogin">前往登入頁</button>
            </section>
            <button class="ui-next-login-link" type="button" @click="goStep(6)" v-if="step >= 2 && step <= 5">全部略過，稍後在設定頁完成</button>
          </template>

          <p v-if="mode === 'login'" class="ui-next-login-footer">還沒有帳號？<button class="ui-next-login-link" type="button" @click="startRegister">註冊新帳號</button></p>
          <button v-if="mode === 'register'" class="ui-next-login-link" type="button" @click="backToLogin">返回登入</button>
        </section>
      </main>
    `,
  });

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

  window.UiNextTokenReportView = Vue.defineComponent({
    name: "UiNextTokenReportView",
    components: { UiNextIcon: window.UiNextIcon },
    data() {
      return {
        loading: true,
        loadError: "",
        report: null,
        projects: [],
        labels: {},
        expanded: {},
        claudeUsage: null,
        codexUsage: null,
        filters: {
          range: "30",
          start: "",
          end: "",
          project_id: "",
          task_id: "",
          showAll: false,
        },
      };
    },
    computed: {
      dateRange() {
        const now = new Date(),
          end = now.toISOString().slice(0, 10);
        if (this.filters.range === "today") {
          const start = new Date(now);
          start.setHours(0, 0, 0, 0);
          return { start: start.toISOString(), end: now.toISOString() };
        }
        if (this.filters.range === "7") {
          const start = new Date(now);
          start.setDate(start.getDate() - 7);
          return { start: start.toISOString().slice(0, 10), end };
        }
        if (this.filters.range === "30") {
          const start = new Date(now);
          start.setDate(start.getDate() - 30);
          return { start: start.toISOString().slice(0, 10), end };
        }
        return { start: this.filters.start, end: this.filters.end };
      },
      quotaRows() {
        const rows = [];
        const claude = this.claudeUsage || {};
        [
          ["Claude · 5 小時", claude.five_hour],
          ["Claude · 本週", claude.seven_day],
        ].forEach(([label, item]) => {
          if (item && item.utilization != null)
            rows.push({
              label,
              used: Math.round(item.utilization),
              note: `${Math.round(item.utilization)}% 已使用`,
            });
        });
        const codex = this.codexUsage || {};
        [
          ["Codex · 主要額度", codex.primary],
          ["Codex · 週額度", codex.secondary],
        ].forEach(([label, item]) => {
          if (item && item.used_percent != null)
            rows.push({
              label,
              used: Math.round(item.used_percent),
              note: `剩 ${Math.round(item.remaining_percent)}%`,
            });
        });
        return rows;
      },
      // title＝未縮寫的完整數字。卡片顯示的是 K/M 縮寫與四捨五入後的金額，沒有 title 就再也查不到原值。
      summaryCards() {
        const s = this.report && this.report.summary;
        if (!s) return [];
        return [
          { label: "總 Token 數", value: fmtCompact(s.total_tokens), note: "含 Cache", title: fmtNumber(s.total_tokens) },
          { label: "Cache 總數", value: fmtCompact(s.cache_tokens), note: "重複讀取部分", title: fmtNumber(s.cache_tokens) },
          { label: "實際 Token", value: fmtCompact(s.actual_tokens), note: "扣除 Cache 後", title: fmtNumber(s.actual_tokens) },
          { label: "平均每任務", value: fmtCompact(s.avg_tokens_per_task), note: "實際 Token ÷ 任務數", title: fmtNumber(Math.round(s.avg_tokens_per_task || 0)) },
          { label: "任務數", value: fmtNumber(s.total_tasks), note: "本期間有記錄", title: fmtNumber(s.total_tasks) },
          { label: "完成任務", value: fmtNumber(s.done_tasks), note: "已完成交付", title: fmtNumber(s.done_tasks) },
          { label: "實際花費", value: fmtUSD(s.cost_usd), note: "本期間累計", title: `$${Number(s.cost_usd || 0).toFixed(6)}` },
          { label: "每張交付成本", value: fmtUSD(s.avg_cost_per_task), note: `期間總花費 ÷ 完成任務數 ${s.done_tasks}`, title: `$${Number(s.avg_cost_per_task || 0).toFixed(6)}` },
        ];
      },
      // 明細表最多顯示 100 筆；下方另有「共 N 筆」提示，否則看不出被截斷
      visibleTasks() {
        return ((this.report && this.report.tasks) || []).slice(0, 100);
      },
      // Legacy 用三張 SVG 圓餅呈現 Agent／專案／使用者的占比。這裡改成「百分比＋顏色」清單版：
      // 資訊等價（顏色沿用同一份對照），少一套繪圖與放大 modal 的碼。
      agentShares() {
        return this.shareRows(this.report && this.report.by_agent, (row) => this.agentLabel(row.agent_type), (row) => agentColor(row.agent_type));
      },
      projectShares() {
        return this.shareRows(this.report && this.report.by_project, (row) => row.project_name, (row, index) => catColor(index));
      },
      userShares() {
        return this.shareRows(this.report && this.report.by_user, (row) => row.username, (row, index) => catColor(index));
      },
      trendPoints() {
        const rows = (this.report && this.report.daily) || [];
        if (rows.length < 2) return "";
        const max = Math.max(...rows.map((row) => Number(row.tokens || 0)), 1);
        return rows
          .map(
            (row, index) =>
              `${8 + index * (284 / (rows.length - 1))},${80 - (Number(row.tokens || 0) / max) * 66}`,
          )
          .join(" ");
      },
    },
    async created() {
      const [projects, labels, claude, codex] = await Promise.all([
        Api.get("projects").catch(() => []),
        Api.get("agents/labels").catch(() => ({})),
        Api.get("claude-usage").catch(() => null),
        Api.get("codex-usage").catch(() => null),
      ]);
      this.projects = projects;
      this.labels = labels;
      this.claudeUsage = claude;
      this.codexUsage = codex;
      await this.load();
    },
    methods: {
      fmtNumber,
      fmtCompact,
      fmtUSD,
      usageLevel,
      agentColor,
      agentLabel(type) {
        return this.labels[type] || type;
      },
      shareRows(rows, labelOf, colorOf) {
        const list = rows || [];
        const total = list.reduce((sum, row) => sum + Number(row.tokens || 0), 0);
        return list.map((row, index) => ({
          key: `${labelOf(row, index)}#${index}`,
          label: labelOf(row, index),
          tokens: Number(row.tokens || 0),
          color: colorOf(row, index),
          pct: total ? (Number(row.tokens || 0) / total) * 100 : 0,
        }));
      },
      // 明細列顯示名稱：不能只用 title——chat 要看得出是對話、已刪除的要講清楚，
      // 而 wiki／workflow_health 這種專案層級記錄根本沒有 title，只有關卡代號。
      taskLabel(task) {
        if (task.kind === "chat") return `chat > ${task.deleted ? "(已刪除)" : task.title || "(舊對話)"}`;
        if (task.kind === "task") return task.title || (task.deleted ? "(已刪除任務)" : task.task_id || "（無標題）");
        const label = this.agentLabel(task.kind);
        return task.project_name ? `${task.project_name} > ${label}` : label;
      },
      fmtTime(value) {
        return value ? new Date(value).toLocaleString("zh-TW") : "—";
      },
      toggle(key) {
        this.expanded[key] = !this.expanded[key];
      },
      taskLink(task) {
        if (!task.linkable) return "";
        return task.kind === "chat"
          ? `/projects/${task.project_id}/chat/${task.chat_id}`
          : task.task_row_id != null
            ? `/task/${task.task_row_id}`
            : "";
      },
      async load() {
        this.loading = true;
        this.loadError = "";
        try {
          const p = new URLSearchParams(),
            range = this.dateRange;
          if (range.start) p.set("start", range.start);
          if (range.end) p.set("end", range.end);
          if (this.filters.project_id)
            p.set("project_id", this.filters.project_id);
          if (this.filters.task_id) p.set("task_id", this.filters.task_id);
          if (this.filters.showAll) p.set("all", "true");
          this.report = await Api.get(`token-report?${p}`);
        } catch (error) {
          // 只發 toast 的話 toast 消失後畫面只剩篩選列，看起來像「這期間沒資料」
          this.loadError = error.message || "無法載入用量報表";
          showToast(this.loadError, "error", 0);
        } finally {
          this.loading = false;
        }
      },
    },
    template: `
      <section class="ui-next-page ui-next-usage-page">
        <header class="ui-next-page-head">
<div>
<p class="ui-next-eyebrow">分析工具</p>
<h1>用量報表</h1>
<p>查看額度、成本與交付品質；篩選只影響下方分析資料。</p>
</div>
</header>
        <div class="ui-next-filterbar">
<select v-model="filters.range">
<option value="today">今天</option>
<option value="7">最近 7 天</option>
<option value="30">最近 30 天</option>
<option value="custom">自訂期間</option>
</select>
<template v-if="filters.range==='custom'">
<input v-model="filters.start" type="date">
<span>至</span>
<input v-model="filters.end" type="date">
</template>
<select v-model="filters.project_id">
<option value="">全部專案</option>
<option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
</select>
<input v-model="filters.task_id" placeholder="任務 ID">
<label>
<input v-model="filters.showAll" type="checkbox" @change="load"> 全部使用者</label>
<button class="ui-next-primary" @click="load" :disabled="loading">{{ loading ? '更新中…' : '更新報表' }}</button>
</div>
        <div class="ui-next-quota-card">
<div class="ui-next-card-title">
<div>
<h2>目前額度</h2>
<p>顏色只用於額度狀態提醒。</p>
</div>
</div>
<div class="ui-next-quota-list">
<div v-for="row in quotaRows" :key="row.label">
<div>
<b>{{ row.label }}</b>
<span>{{ row.note }}</span>
</div>
<i>
<em :class="usageLevel(row.used)" :style="{width:row.used+'%'}">
</em>
</i>
</div>
<p v-if="!quotaRows.length" class="ui-next-empty-inline">目前無法取得訂閱額度。</p>
</div>
</div>
        <template v-if="loading">
<div class="ui-next-loading-card">載入報表中…</div>
</template>
<div v-else-if="loadError" class="ui-next-loading-card ui-next-error-text">{{ loadError }} <button type="button" @click="load">重試</button></div>
<template v-else-if="report">
<div class="ui-next-metric-grid">
<article v-for="card in summaryCards" :key="card.label">
<span>{{ card.label }}</span>
<strong :title="card.title">{{ card.value }}</strong>
<small>{{ card.note }}</small>
</article>
</div>
<div class="ui-next-usage-grid">
<article class="ui-next-panel">
<h2>每日趨勢</h2>
<svg viewBox="0 0 300 92" preserveAspectRatio="none" v-if="trendPoints">
<polyline :points="trendPoints" fill="none" stroke="currentColor" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
</svg>
<p v-else class="ui-next-empty-inline">本期間資料不足，尚無趨勢。</p>
</article>
<article class="ui-next-panel">
<h2>依專案</h2>
<div class="ui-next-share-row" v-for="row in projectShares" :key="row.key">
<i :style="{background:row.color}"></i>
<span :title="row.label">{{ row.label }}</span>
<b :title="fmtNumber(row.tokens)">{{ fmtCompact(row.tokens) }}</b>
<em>{{ row.pct.toFixed(1) }}%</em>
</div>
<p v-if="!projectShares.length" class="ui-next-empty-inline">尚無專案資料。</p>
</article>
<article class="ui-next-panel">
<h2>依 Agent</h2>
<div class="ui-next-share-row" v-for="row in agentShares" :key="row.key">
<i :style="{background:row.color}"></i>
<span :title="row.label">{{ row.label }}</span>
<b :title="fmtNumber(row.tokens)">{{ fmtCompact(row.tokens) }}</b>
<em>{{ row.pct.toFixed(1) }}%</em>
</div>
<p v-if="!agentShares.length" class="ui-next-empty-inline">尚無 Agent 資料。</p>
</article>
<article class="ui-next-panel">
<h2>依使用者</h2>
<div class="ui-next-share-row" v-for="row in userShares" :key="row.key">
<i :style="{background:row.color}"></i>
<span :title="row.label">{{ row.label }}</span>
<b :title="fmtNumber(row.tokens)">{{ fmtCompact(row.tokens) }}</b>
<em>{{ row.pct.toFixed(1) }}%</em>
</div>
<p v-if="!userShares.length" class="ui-next-empty-inline">尚無使用者資料（未勾「全部使用者」時只會有你自己）。</p>
</article>
</div>
<div class="tr-table-card" v-if="report.by_agent.length">
<h2 class="ui-next-table-title">各關卡成本與失敗率<small>失敗率高的關卡＝重跑成本集中處，是省 token 的第一優先目標</small></h2>
<table class="tr-table">
<thead>
<tr><th>關卡</th><th class="ui-next-num">實際 Token 數</th><th class="ui-next-num">花費</th><th class="ui-next-num">呼叫數</th><th class="ui-next-num">平均每任務呼叫</th><th class="ui-next-num">失敗數</th><th class="ui-next-num">失敗率</th></tr>
</thead>
<tbody>
<tr v-for="row in report.by_agent" :key="'ag-'+row.agent_type">
<td><i class="ui-next-dot" :style="{background:agentColor(row.agent_type)}"></i>{{ agentLabel(row.agent_type) }}</td>
<td class="ui-next-num" :title="fmtNumber(row.tokens)">{{ fmtCompact(row.tokens) }}</td>
<td class="ui-next-num">{{ fmtUSD(row.cost_usd) }}</td>
<td class="ui-next-num">{{ row.calls }}</td>
<td class="ui-next-num" :style="{color: row.avg_calls_per_task >= 2 ? 'var(--danger)' : (row.avg_calls_per_task > 1.2 ? 'var(--warning)' : 'var(--text-muted)')}">{{ row.avg_calls_per_task.toFixed(2) }}</td>
<td class="ui-next-num">{{ row.failed_calls }}</td>
<td class="ui-next-num" :style="{color: row.fail_rate >= 0.2 ? 'var(--danger)' : (row.fail_rate > 0 ? 'var(--warning)' : 'var(--text-muted)')}">{{ (row.fail_rate * 100).toFixed(0) }}%</td>
</tr>
</tbody>
</table>
</div>
<div class="tr-table-card" v-if="report.project_stats && report.project_stats.length">
<h2 class="ui-next-table-title">專案品質統計<small>本期間完成的任務；一次過關＝分析／開發／QA／E2E 四關都沒重跑</small></h2>
<table class="tr-table">
<thead>
<tr><th>專案</th><th class="ui-next-num">完成任務</th><th class="ui-next-num">一次過關率</th><th class="ui-next-num">人工退回率</th><th>主要退回原因</th></tr>
</thead>
<tbody>
<tr v-for="row in report.project_stats" :key="'ps-'+(row.project_id||'none')">
<td>{{ row.project_name }}</td>
<td class="ui-next-num">{{ row.done_tasks }}</td>
<td class="ui-next-num" :style="{color: row.first_pass_rate < 0.5 ? 'var(--danger)' : (row.first_pass_rate < 0.8 ? 'var(--warning)' : 'var(--success)')}">{{ (row.first_pass_rate * 100).toFixed(0) }}%</td>
<td class="ui-next-num" :style="{color: row.reject_rate >= 0.3 ? 'var(--danger)' : (row.reject_rate > 0 ? 'var(--warning)' : 'var(--text-muted)')}">{{ (row.reject_rate * 100).toFixed(0) }}%</td>
<td>{{ row.top_reject_category ? row.top_reject_category + '（' + row.top_reject_count + '）' : '—' }}</td>
</tr>
</tbody>
</table>
</div>
<section class="ui-next-panel ui-next-usage-detail">
<div class="ui-next-card-title">
<div>
<h2>使用明細</h2>
<p>點選列可展開各 Agent 的模型、用量與耗時。</p>
</div>
<span>共 {{ report.tasks.length }} 筆</span>
</div>
<div class="ui-next-data-list">
<article v-for="task in visibleTasks" :key="task.ref_key" role="button" tabindex="0" :aria-expanded="!!expanded[task.ref_key]" @click="toggle(task.ref_key)" @keydown.enter.prevent="toggle(task.ref_key)" @keydown.space.prevent="toggle(task.ref_key)">
<div>
<b :title="taskLabel(task)">{{ taskLabel(task) }}</b>
<span>{{ task.project_name || '未分類專案' }} · {{ task.username || '—' }} · {{ fmtTime(task.last_recorded_at) }}</span>
</div>
<div>
<strong :title="'$'+Number(task.total_cost||0).toFixed(6)">{{ fmtUSD(task.total_cost) }}</strong>
<span :title="fmtNumber(task.total_tokens)">{{ fmtCompact(task.total_tokens) }} Token</span>
</div>
<span class="ui-next-disclosure"><ui-next-icon :name="expanded[task.ref_key] ? 'chevron-up' : 'chevron-down'"/></span>
<div v-if="expanded[task.ref_key]" class="ui-next-detail-row">
<router-link v-if="taskLink(task)" :to="taskLink(task)" @click.stop>前往來源</router-link>
<span v-for="agent in task.agents" :key="agent.agent_type + agent.model">{{ agentLabel(agent.agent_type) }}<template v-if="agent.model"> · {{ agent.model }}</template>：{{ fmtCompact(agent.tokens) }} / {{ fmtUSD(agent.cost) }}<template v-if="agent.duration_ms">（{{ (agent.duration_ms / 1000).toFixed(1) }}s）</template></span>
</div>
</article>
<p v-if="!report.tasks.length" class="ui-next-empty-inline">本期間無 Token 使用記錄。</p>
</div>
<p v-if="report.tasks.length > 100" class="ui-next-more-hint">僅顯示前 100 筆（共 {{ report.tasks.length }} 筆）</p>
</section>
</template>
      </section>`,
  });

  window.UiNextPipelineView = Vue.defineComponent({
    name: "UiNextPipelineView",
    components: { UiNextIcon: window.UiNextIcon },
    data() {
      return {
        rows: [],
        chats: [],
        loading: true,
        rowsError: false,
        chatsError: false,
        refreshing: false,
        lastUpdated: null,
        pausingId: null,
        timer: null,
      };
    },
    computed: {
      offline() { return this.rowsError || this.chatsError; },
      lastUpdatedText() { return this.lastUpdated ? new Date(this.lastUpdated).toLocaleTimeString() : "—"; },
    },
    async mounted() {
      await this.load();
      this._onVisibility = () => {
        if (document.hidden) this.stopPolling();
        else { this.load(); this.startPolling(); }
      };
      document.addEventListener("visibilitychange", this._onVisibility);
      this.startPolling();
    },
    beforeUnmount() {
      this.stopPolling();
      document.removeEventListener("visibilitychange", this._onVisibility);
    },
    methods: {
      elapsed,
      statusLabel(status) {
        return window.STATUS_LABELS[status] || status;
      },
      startPolling() {
        if (!document.hidden && !this.timer) this.timer = setInterval(() => this.load(), 3000);
      },
      stopPolling() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
      },
      // 兩區各自吞自己的錯，不共用一個 try：常駐 server 若還沒載入某個端點（部署到重啟之間就是
      // 這個狀態），共用的話那支失敗會連帶讓另一區停止更新。但「吞掉」不等於「不講」——
      // 端點掛掉時畫面若只寫「目前沒有執行中的 Pipeline」，就與真的沒任務完全無法分辨。
      // 單次失敗一律保留上一批避免閃爍；只有首次載入與手動重試才 toast，否則每 3 秒跳一次。
      async load(manual) {
        const notify = this.loading || manual;
        const [rows, chats] = await Promise.all([
          Api.get("admin/pipeline/active").catch((error) => { if (notify) showToast(error.message || "無法讀取執行中的任務", "error", 6000); return null; }),
          Api.get("admin/chat/active").catch((error) => { if (notify) showToast(error.message || "無法讀取進行中的問答", "error", 6000); return null; }),
        ]);
        if (rows) this.rows = rows.sort((a, b) => b.elapsed_ms - a.elapsed_ms);
        if (chats) this.chats = chats;
        this.rowsError = rows === null;
        this.chatsError = chats === null;
        if (rows || chats) this.lastUpdated = Date.now();
        this.loading = false;
      },
      async retry() { this.refreshing = true; try { await this.load(true); } finally { this.refreshing = false; } },
      async pause(row) {
        if (
          !(await confirmDialog({
            title: "暫停行程",
            message: `確定暫停並中止「${row.title || row.task_id}」？`,
            danger: true,
            confirmText: "暫停並中止",
          }))
        )
          return;
        this.pausingId = row.id;
        try {
          await Api.post(`admin/pipeline/tasks/${row.id}/pause`);
          await this.load();
          showToast("已暫停行程", "success");
        } catch (error) {
          showToast(error.message, "error");
        } finally {
          this.pausingId = null;
        }
      },
    },
    template: `
      <section class="ui-next-page ui-next-pipeline-page">
<header class="ui-next-page-head">
<div>
<button class="ui-next-back" @click="$router.push('/admin')"><ui-next-icon name="arrow-left"/>返回</button>
<p class="ui-next-eyebrow">即時監控</p>
<h1>進行中 Pipeline</h1>
<p>僅顯示真正執行中的任務與等待 AI 回覆的問答；每 3 秒更新一次。</p>
</div>
<div class="ui-next-pipeline-head-actions">
<span class="ui-next-live">
<i :class="{'is-down':offline}">
</i>{{ offline ? '連線異常' : '即時更新' }}<em>· 最後更新 {{ lastUpdatedText }}</em></span>
<button class="ui-next-pipeline-retry" @click="retry" :disabled="refreshing">{{ refreshing?'重試中…':'重新整理' }}</button>
</div>
</header>
<div v-if="loading" class="ui-next-pipeline-grid">
<section class="ui-next-panel" v-for="panel in 2" :key="panel">
<div class="ui-next-card-title">
<div>
<Skeleton width="120px" height="16px" />
<div style="margin-top:6px"><Skeleton width="70px" height="12px" /></div>
</div>
</div>
<div class="ui-next-run-list">
<article v-for="i in 3" :key="i">
<div class="ui-next-run-stage"><Skeleton width="58px" height="11px" /></div>
<div>
<Skeleton width="160px" height="14px" />
<div style="margin-top:6px"><Skeleton width="120px" height="12px" /></div>
</div>
<Skeleton width="42px" height="12px" />
<Skeleton width="52px" height="30px" radius="7px" />
</article>
</div>
</section>
</div>
<template v-else>
<div class="ui-next-pipeline-grid">
<section class="ui-next-panel">
<div class="ui-next-card-title">
<div>
<h2>執行中的任務</h2>
<p>{{ rows.length }} 個行程</p>
</div>
</div>
<div class="ui-next-run-list">
<article v-for="row in rows" :key="row.id">
<div class="ui-next-run-stage">
<i>
</i>
<span>{{ statusLabel(row.status) }}</span>
</div>
<div>
<b><router-link class="ui-next-run-title" :to="'/task/'+row.id">{{ row.title || row.task_id }}</router-link></b>
<span>{{ row.project_name || '未分類專案' }} · {{ row.display_name || row.username || '—' }}</span>
</div>
<time>{{ elapsed(row.elapsed_ms) }}</time>
<div>
<router-link :to="'/task/'+row.id">查看</router-link>
<button @click="pause(row)" :disabled="pausingId===row.id">{{ pausingId===row.id ? '處理中…' : '暫停' }}</button>
</div>
</article>
<p v-if="!rows.length" class="ui-next-empty-state">{{ rowsError ? '暫時無法讀取執行狀態（端點可能尚未載入），畫面顯示的是上一次成功取得的資料。' : '目前沒有執行中的 Pipeline。' }}</p>
</div>
</section>
<section class="ui-next-panel">
<div class="ui-next-card-title">
<div>
<h2>進行中的 AI 問答／互動</h2>
<p>{{ chats.length }} 段對話</p>
</div>
</div>
<div class="ui-next-run-list">
<article v-for="chat in chats" :key="chat.id">
<div class="ui-next-run-stage is-chat">
<i>
</i>
<span>AI 回覆中</span>
</div>
<div>
<b><router-link class="ui-next-run-title" :to="'/projects/'+chat.project_id+'/chat/'+chat.id">{{ chat.title || '未命名對話' }}</router-link></b>
<span>{{ chat.project_name || '未分類專案' }} · {{ chat.display_name || chat.username || '—' }}</span>
</div>
<time>{{ elapsed(chat.waited_ms) }}</time>
<div>
<router-link :to="'/projects/'+chat.project_id+'/chat/'+chat.id">查看</router-link>
</div>
</article>
<p v-if="!chats.length" class="ui-next-empty-state">{{ chatsError ? '暫時無法讀取問答狀態（端點可能尚未載入），畫面顯示的是上一次成功取得的資料。' : '目前沒有等待 AI 回覆的問答。' }}</p>
</div>
</section>
</div>
</template>
</section>`,
  });

  // Next Chat 自行管理 route identity 與 request sequence，避免同一 component 實例在換專案時寫回舊資料。
  window.UiNextProjectChatView = Vue.defineComponent({
    name: "UiNextProjectChatView",
    components: { UiNextIcon: window.UiNextIcon },
    data() {
      return { chats: [], activeChat: null, messages: [], newInput: "", newTitle: "",
        sending: false, loadingMsgs: false, draftingTask: false, creatingTask: false,
        showTaskModal: false, taskDraft: { title: "", original_text: "", attachments: [] }, taskError: "", taskModalTrigger: null,
        replyPending: false, pendingFiles: [], pendingPreviews: [], attachUrls: {},
        pendingHint: false, pollTicks: 0, stopping: false,
        projectName: "專案", showNewChat: false, showHistory: false, historyTrigger: null, historyQuery: "", historyMenuId: null, chatError: "", chatsError: "", creatingChat: false, requestId: 0, replyTimer: null };
    },
    computed: {
      filteredChats() { const query = this.historyQuery.trim().toLocaleLowerCase("zh-TW"); return query ? this.chats.filter((chat) => (chat.title || "新對話").toLocaleLowerCase("zh-TW").includes(query)) : this.chats; },
    },
    async created() {
      // 沒帶對話 id 就沒有「這一頁」要顯示的東西——完整清單已經是專案頁的 Chat 頁籤，
      // 這裡再放一份空狀態清單只會有兩個長得不一樣的入口。
      if (!this.$route.params.chatId) { this.$router.replace(`/projects/${this.$route.params.id}?tab=chat`); return; }

      await this.loadChats();
      const projects = await Api.get("projects").catch(() => []);
      const project = projects.find(
        (item) => String(item.id) === String(this.$route.params.id),
      );
      this.projectName = project ? project.name : "專案";
    },
    // revokeMessageUrls 一起收：離開頁面時已載入的附件 objectURL 也要放掉，只收 pending 會漏掉全部訊息圖。
    beforeUnmount() { this.requestId++; this.stopReplyPolling(); this.revokePendingUrls(); this.revokeMessageUrls(); },
    methods: {
      routePath(chat) { return `/projects/${this.$route.params.id}/chat/${chat.id}`; },
      toggleHistory(event) { this.historyTrigger = event.currentTarget; this.showHistory = !this.showHistory; if (this.showHistory) this.$nextTick(() => this.$refs.historyClose?.focus()); },
      closeHistory() { this.showHistory = false; this.$nextTick(() => this.historyTrigger?.focus()); },
      onHistoryKeydown(event) {
        if (event.key === "Escape") { event.preventDefault(); this.closeHistory(); return; }
        if (event.key !== "Tab") return;
        const focusable = this.$refs.historyDrawer ? Array.from(this.$refs.historyDrawer.querySelectorAll("button:not([disabled]), [href], input:not([disabled])")) : [];
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      },
      closeTaskModal() { this.showTaskModal = false; this.$nextTick(() => this.taskModalTrigger?.focus()); },
      onTaskModalKeydown(event) {
        if (event.key === "Escape") { event.preventDefault(); this.closeTaskModal(); return; }
        if (event.key !== "Tab") return;
        const focusable = this.$refs.chatTaskModal ? Array.from(this.$refs.chatTaskModal.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled])")) : [];
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      },
      async loadChats() {
        const requestId = ++this.requestId;
        this.activeChat = null; this.messages = []; this.loadingMsgs = true; this.chatsError = "";
        try {
          const chats = await Api.get(`projects/${this.$route.params.id}/chats`);
          if (requestId !== this.requestId) return;
          this.chats = chats || [];
          const chatId = this.$route.params.chatId;
          this.activeChat = this.chats.find((chat) => String(chat.id) === String(chatId)) || null;
          // ?pending=1 是「新對話」把人送過來時帶的旗標：那邊的訊息 POST 是不等待就換頁的，
          // 這一刻伺服器可能還沒把 reply_pending 寫進去，只信 DB 會有幾秒空窗顯示成「沒事發生」。
          this.pendingHint = this.$route.query.pending === "1";
          this.pollTicks = 0;
          if (this.activeChat) await this.loadMessages(requestId);
          if (this.pendingHint) this.startReplyPolling();
        } catch (error) { if (requestId === this.requestId) this.chatsError = error.message || "無法載入對話"; }
        finally { if (requestId === this.requestId) this.loadingMsgs = false; }
      },
      async selectChat(chat) { await this.$router.push(this.routePath(chat)); },
      async loadMessages(requestId = this.requestId) {
        if (!this.activeChat) return;
        const chatId = this.activeChat.id;
        this.loadingMsgs = true;
        try {
          const messages = await Api.get(`projects/${this.$route.params.id}/chats/${chatId}/messages`);
          if (requestId !== this.requestId || !this.activeChat || this.activeChat.id !== chatId) return;
          this.revokeMessageUrls();   // 換對話／重載前先收掉舊圖，否則 objectURL 一路累積到離開頁面
          this.messages = messages || []; this.replyPending = !!this.activeChat.reply_pending || this.pendingHint;
          if (this.replyPending) this.startReplyPolling(); else this.stopReplyPolling();
          this.$nextTick(() => this.scrollToBottom());
          this.loadAttachmentThumbs(requestId);
          this.markRead(this.activeChat);
        } catch (error) { showToast(error.message || "無法載入訊息", "error"); }
        finally { if (requestId === this.requestId) this.loadingMsgs = false; }
      },
      startReplyPolling() {
        if (this.replyTimer || !this.activeChat) return;
        this.replyTimer = setInterval(() => this.pollReply(), 3000);
      },
      // ⚠ 每 tick 必須重讀 chat 列，不能只 loadMessages：loadMessages 是拿
      // `this.activeChat.reply_pending` 判斷要不要繼續輪詢，而 activeChat 是進頁面時 loadChats
      // 抓的那份快照，永遠不會變。只 loadMessages 的話「回覆中」不是永遠停著就是第一 tick 就自己關掉。
      async pollReply() {
        if (!this.activeChat) return;
        const chatId = this.activeChat.id;
        const chats = await Api.get(`projects/${this.$route.params.id}/chats`).catch(() => null);
        if (!chats || !this.activeChat || this.activeChat.id !== chatId) return;
        const fresh = chats.find((chat) => String(chat.id) === String(chatId));
        if (fresh) this.activeChat.reply_pending = fresh.reply_pending;
        // 兩 tick（約 6 秒）後一律拿掉樂觀旗標，改由 DB 說了算。不設期限的話「AI 比輪詢還快回完」
        // 那種情形會讓畫面永遠停在回覆中。
        if (++this.pollTicks >= 2) this.pendingHint = false;
        await this.loadMessages();
      },
      // 取消這一輪回覆。伺服器端會 abort 正在跑的 agent 行程並在對話裡補一則「已取消」，
      // 所以紀錄看得到，不是只把前端的動畫關掉。
      async stopReply() {
        if (!this.activeChat || this.stopping) return;
        this.stopping = true;
        try {
          await Api.post(`projects/${this.$route.params.id}/chats/${this.activeChat.id}/stop`, {});
          this.pendingHint = false;
          await this.pollReply();
        } catch (error) { showToast(error.message || "無法取消回覆", "error"); }
        finally { this.stopping = false; }
      },
      stopReplyPolling() { if (this.replyTimer) clearInterval(this.replyTimer); this.replyTimer = null; },
      async createChat() {
        if (this.creatingChat) return;
        this.creatingChat = true; this.chatError = "";
        try { const chat = await Api.post(`projects/${this.$route.params.id}/chats`, { title: this.newTitle.trim() || "新對話" });
          this.newTitle = ""; this.showNewChat = false; await this.$router.push(this.routePath(chat));
        } catch (error) { this.chatError = error.message || "無法建立對話，請重試。"; }
        finally { this.creatingChat = false; }
      },
      async deleteChat(chat) {
        if (!await confirmDialog({ title: "刪除對話", message: `確定刪除「${chat.title || "新對話"}」？`, danger: true, confirmText: "刪除" })) return;
        try { await Api.delete(`projects/${this.$route.params.id}/chats/${chat.id}`); if (this.activeChat && this.activeChat.id === chat.id) await this.$router.push(`/projects/${this.$route.params.id}/chat`); else this.chats = this.chats.filter((item) => item.id !== chat.id); }
        catch (error) { showToast(error.message || "無法刪除對話", "error"); }
      },
      onFilesSelected(event) { this.addPendingFiles(Array.from(event.target.files || [])); event.target.value = ""; },
      autoResize(event) {
        const el = event.currentTarget;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
      },
      onPaste(event) { const files = Array.from((event.clipboardData || {}).files || []).filter((file) => /^image\//.test(file.type)); if (files.length) { event.preventDefault(); this.addPendingFiles(files); } },
      addPendingFiles(files) { files.forEach((file) => { if (!/^image\//.test(file.type) || file.size > 10 * 1024 * 1024 || this.pendingFiles.length >= 5) return; this.pendingFiles.push(file); this.pendingPreviews.push(URL.createObjectURL(file)); }); },
      removePendingFile(index) { URL.revokeObjectURL(this.pendingPreviews[index]); this.pendingFiles.splice(index, 1); this.pendingPreviews.splice(index, 1); },
      revokePendingUrls() { this.pendingPreviews.forEach((url) => URL.revokeObjectURL(url)); },
      // 附件端點要帶 Authorization header，<img src> 直連拿不到，只能逐張 fetch 成 objectURL。
      // 少了這一步，attachUrls 永遠是空物件、模板那個 v-show 恆為 false ⇒ 所有已送出的圖都不顯示。
      async loadAttachmentThumbs(requestId = this.requestId) {
        const projectId = this.$route.params.id;
        const chatId = this.activeChat && this.activeChat.id;
        if (!chatId) return;
        for (const message of this.messages) {
          for (const attachment of message.attachments || []) {
            if (this.attachUrls[attachment.id]) continue;
            try {
              const { blob } = await Api.getBlob(
                `projects/${projectId}/chats/${chatId}/attachments/${attachment.id}/download`,
              );
              // 抓的期間可能已換對話或離開頁面：此時寫進去的 URL 沒有人回收，
              // 因為 revokeMessageUrls 已經把當時那份 attachUrls 換掉了。
              if (requestId !== this.requestId || !this.activeChat || this.activeChat.id !== chatId) return;
              this.attachUrls[attachment.id] = URL.createObjectURL(blob);
            } catch (error) { /* 單張載不出來就不畫這張 */ }
          }
        }
      },
      // 沒有這一步，側欄與專案卡上的未讀數字看完對話仍不會歸零，而且不回寫伺服器——
      // 換裝置／重整後照樣是未讀。
      async markRead(chat) {
        if (!chat) return;
        const projectId = this.$route.params.id;
        try {
          const { projectUnread } = await Api.post(`projects/${projectId}/chats/${chat.id}/read`, {});
          window.UnreadStore.byProject[String(projectId)] = projectUnread;
          chat.unread = 0;
        } catch (error) { /* 標記已讀失敗不影響閱讀 */ }
      },
      revokeMessageUrls() {
        Object.values(this.attachUrls).forEach((url) => URL.revokeObjectURL(url));
        this.attachUrls = {};
        // 樂觀顯示用的預覽 URL：送出成功那條路徑會自己收掉，但送出失敗時那則訊息留在畫面上，
        // 它的 URL 沒有別人管——一併在這裡收，否則每失敗一次就漏一份。
        this.messages.forEach((message) => (message.pending_previews || []).forEach((url) => URL.revokeObjectURL(url)));
      },
      handleEnter(event) { if (!event.isComposing && !event.shiftKey) { event.preventDefault(); this.send(); } },
      // ⚠ 訊息端點會 await 整輪 AI 回覆（chat-agent，動輒數分鐘）。原本 await 它才更新畫面，
      // 等於送出後好幾分鐘畫面完全沒動靜、自己那則也看不到。改成不等待：先樂觀畫上自己那則、
      // 立刻進入「回覆中」並開始輪詢，回覆由輪詢帶回來（伺服器在 handler 開頭就寫好 reply_pending）。
      async send() {
        if (this.replyPending || !this.activeChat || (!this.newInput.trim() && !this.pendingFiles.length)) return;
        const chatId = this.activeChat.id, content = this.newInput.trim(), files = this.pendingFiles;
        this.newInput = ""; this.pendingFiles = []; this.pendingPreviews = [];
        this.messages.push({ id: Date.now(), role: "user", content, created_at: new Date().toISOString() });
        this.pendingHint = true; this.pollTicks = 0; this.replyPending = true; this.startReplyPolling();
        this.$nextTick(() => this.scrollToBottom());
        let request;
        if (files.length) { const form = new FormData(); form.append("content", content); files.forEach((file) => form.append("files", file)); request = Api.postForm(`projects/${this.$route.params.id}/chats/${chatId}/messages`, form); }
        else request = Api.post(`projects/${this.$route.params.id}/chats/${chatId}/messages`, { content });
        request.catch((error) => {
          if (!this.activeChat || this.activeChat.id !== chatId) return;
          this.newInput = content; this.pendingHint = false; this.replyPending = false; this.stopReplyPolling();
          showToast(error.message || "訊息送出失敗", "error");
        });
      },
      async toTask(event) { if (!this.activeChat || this.draftingTask) return; this.draftingTask = true; this.taskError = ""; this.taskModalTrigger = event?.currentTarget || null; try { const draft = await Api.post(`projects/${this.$route.params.id}/chats/${this.activeChat.id}/draft-task`, {}); this.taskDraft = { title: draft.title || "", original_text: draft.original_text || "", attachments: (draft.attachments || []).map((item) => ({ ...item, chosen: !!item.chosen })) }; this.showTaskModal = true; this.$nextTick(() => this.$refs.chatTaskTitle?.focus()); } catch (error) { showToast(error.message || "無法建立草稿", "error"); } finally { this.draftingTask = false; } },
      async submitTask() { if (!this.taskDraft.title.trim() || !this.taskDraft.original_text.trim()) { this.taskError = "請填寫標題與內容。"; return; } this.creatingTask = true; this.taskError = ""; try { const task = await Api.post("tasks", { title: this.taskDraft.title.trim(), original_text: this.taskDraft.original_text, project_id: this.$route.params.id, chat_id: this.activeChat.id, chat_attachment_ids: this.taskDraft.attachments.filter((item) => item.chosen).map((item) => item.id) }); this.activeChat.converted_task_id = task.id; this.closeTaskModal(); showToast("已建立任務", "success"); } catch (error) { this.taskError = error.message || "建立任務失敗，請重試。"; } finally { this.creatingTask = false; } },
      // 捲軸統一到最外面（見 ui-next-pages.css 的 .ui-next-thread-messages{overflow:visible}）之後，
      // 真正在捲的是 .ui-next-main；沿用 $refs.messages 會捲一個 overflow:visible 的容器＝什麼都沒發生，
      // 症狀是「進對話要自己往下滾才看得到最新訊息」。
      scrollToBottom() { const element = document.querySelector(".ui-next-main") || this.$refs.messages; if (element) element.scrollTop = element.scrollHeight; },
      formatTime(value) { return value ? new Date(value).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""; },
      renderMd(value) { return window.renderNextMarkdown(value); },
      handleMessageClick(event) { return window.copyNextCode(event); },
      openImage(attachmentId) {
        const url = this.attachUrls[attachmentId];
        if (url) window.open(url, "_blank");
      },
    },
    watch: { "$route.fullPath"() { this.loadChats(); } },
    template: `
      <section class="ui-next-chat-page">
        <div class="ui-next-thread">
<template v-if="activeChat">
<div v-if="showNewChat" class="ui-next-new-chat ui-next-new-chat-popover">
<input v-model="newTitle" placeholder="對話標題（選填）" @keyup.enter="createChat">
<p v-if="chatError" class="ui-next-inline-error" role="alert">{{ chatError }}</p>
<button @click="createChat" :disabled="creatingChat">{{ creatingChat?'建立中…':'開始對話' }}</button>
</div>
<aside v-if="showHistory" ref="historyDrawer" class="ui-next-chat-history" role="dialog" aria-modal="true" aria-label="對話紀錄" @keydown="onHistoryKeydown">
<div class="ui-next-chat-history-head"><strong>對話紀錄</strong><button ref="historyClose" type="button" @click="closeHistory">關閉</button></div>
<div class="ui-next-chat-history-tools"><label><span class="sr-only">搜尋對話</span><ui-next-icon name="search"/><input v-model="historyQuery" type="search" placeholder="搜尋對話"></label><button type="button" class="ui-next-primary" @click="showNewChat=true;closeHistory()"><ui-next-icon name="plus"/> 新對話</button></div>
<div class="ui-next-chat-list">
<article v-for="chat in filteredChats" :key="chat.id" :class="{active:activeChat&&activeChat.id===chat.id}">
<button type="button" class="ui-next-chat-select" :aria-current="activeChat&&activeChat.id===chat.id?'page':null" @click="selectChat(chat);closeHistory()"><b>{{ chat.title || '新對話' }}</b><small v-if="chat.reply_pending">AI 回覆中</small></button>
<i v-if="chat.unread">{{ chat.unread }}</i>
<em v-if="chat.converted_task_id" @click.stop="$router.push('/task/'+chat.converted_task_id)">任務</em>
<div class="ui-next-chat-menu"><button type="button" :aria-expanded="historyMenuId===chat.id" :aria-label="'對話「'+(chat.title||'新對話')+'」更多操作'" @click="historyMenuId=historyMenuId===chat.id?null:chat.id"><ui-next-icon name="dots"/></button><div v-if="historyMenuId===chat.id" class="ui-next-chat-menu-popover"><button type="button" @click="deleteChat(chat);historyMenuId=null">刪除對話</button></div></div>
</article>
<p v-if="!chats.length">尚無對話，建立一段新的討論開始。</p><p v-else-if="!filteredChats.length">找不到符合的對話。</p>
</div>
</aside>
<div ref="messages" class="ui-next-thread-messages" @click="handleMessageClick">
<div v-if="loadingMsgs" class="ui-next-empty-state">載入訊息中…</div>
<article v-for="message in messages" :key="message.id" :class="message.role">
<div class="ui-next-message" v-html="renderMd(message.content)" v-show="message.content"></div>
<div v-if="(message.attachments&&message.attachments.length)||(message.pending_previews&&message.pending_previews.length)" class="ui-next-message-files">
<img v-for="attachment in (message.attachments||[])" :key="attachment.id" v-show="attachUrls[attachment.id]" :src="attachUrls[attachment.id]" :alt="attachment.filename" @click="openImage(attachment.id)">
<img v-for="(url,index) in (message.pending_previews||[])" :key="'pending'+index" :src="url">
</div>
<small>{{ message.role==='user' ? '你' : 'OAA' }} · {{ formatTime(message.created_at) }}</small>
</article>
<div v-if="sending||replyPending" class="ui-next-ai-thinking">
<i>
</i>
<i>
</i>
<i>
</i> OAA 正在處理</div>
</div>
<div v-if="pendingPreviews.length" class="ui-next-pending-files">
<span v-for="(url,index) in pendingPreviews" :key="url">
<img :src="url">
<button type="button" @click="removePendingFile(index)" aria-label="移除待傳圖片"><ui-next-icon name="close"/></button>
</span>
</div>
<form class="ui-next-thread-composer" @submit.prevent="send">
<textarea v-model="newInput" placeholder="輸入你的需求或追問…" @paste="onPaste" @input="autoResize" @keydown.enter="handleEnter">
</textarea>
<div class="ui-next-composer-foot">
<div class="ui-next-composer-options">
<label class="ui-next-icon-button" title="上傳圖片"><ui-next-icon name="paperclip"/><input type="file" accept="image/*" multiple aria-label="上傳圖片" @change="onFilesSelected"></label>
<button type="button" class="ui-next-icon-button" title="建立任務" aria-label="建立任務" @click="toTask($event)" :disabled="draftingTask||sending"><ui-next-icon name="plus"/></button>
<span class="ui-next-composer-hint">Enter 送出 · Shift + Enter 換行 · 可直接貼上截圖</span>
</div>
<button v-if="sending||replyPending" type="button" class="ui-next-thread-send" :disabled="stopping" aria-label="停止回覆" title="停止回覆" @click="stopReply"><ui-next-icon name="square"/></button>
<button v-else class="ui-next-thread-send" :disabled="!newInput.trim()&&!pendingFiles.length" aria-label="送出"><ui-next-icon name="send"/></button>
</div>
</form>
</template>
<div v-else class="ui-next-thread-empty">
<h2>{{ chatsError ? '無法載入對話' : chats.length ? '選擇一段對話' : '尚無對話' }}</h2>
<p v-if="chatsError">{{ chatsError }} <button type="button" @click="loadChats">重試</button></p>
<p v-else>{{ chats.length ? '從完整對話清單選取，或建立新對話。' : '建立新對話，討論會保留在「'+projectName+'」專案中。' }}</p>
<div v-if="chats.length" class="ui-next-chat-full-list"><button v-for="chat in chats" :key="chat.id" type="button" @click="selectChat(chat)"><b>{{ chat.title || '新對話' }}</b><small v-if="chat.reply_pending">AI 回覆中</small></button></div>
<button type="button" class="ui-next-primary" @click="showNewChat=true">開始新對話</button>
<div v-if="showNewChat" class="ui-next-new-chat">
<input v-model="newTitle" placeholder="對話標題（選填）" @keyup.enter="createChat">
<p v-if="chatError" class="ui-next-inline-error" role="alert">{{ chatError }}</p>
<button type="button" @click="createChat" :disabled="creatingChat">{{ creatingChat?'建立中…':'開始' }}</button>
</div>
</div>
</div>
        <div v-if="showTaskModal" class="ui-next-task-modal-backdrop" @mousedown.self="closeTaskModal" @keydown="onTaskModalKeydown">
<section ref="chatTaskModal" class="ui-next-task-modal" role="dialog" aria-modal="true" aria-labelledby="chat-task-modal-title">
<header>
<h2 id="chat-task-modal-title">建立任務</h2>
<button type="button" @click="closeTaskModal" aria-label="關閉建立任務視窗"><ui-next-icon name="close"/></button>
</header>
<label>標題<input ref="chatTaskTitle" v-model="taskDraft.title" placeholder="任務標題">
</label>
<label>需求內容<textarea v-model="taskDraft.original_text" placeholder="需求描述">
</textarea>
</label>
<div v-if="taskDraft.attachments&&taskDraft.attachments.length" class="ui-next-task-attachments">
<label v-for="attachment in taskDraft.attachments" :key="attachment.id">
<input type="checkbox" v-model="attachment.chosen"> {{ attachment.filename }}</label>
</div>
<p v-if="taskError" class="ui-next-inline-error" role="alert">{{ taskError }}</p>
<footer>
<button @click="closeTaskModal">取消</button>
<button class="ui-next-primary" @click="submitTask" :disabled="creatingTask">{{ creatingTask?'建立中…':'建立任務' }}</button>
</footer>
</section>
</div>
      </section>`,
  });

  // 專案詳情保留既有資料與操作（Repo、測試環境、同步設定），畫面改為新版資訊分區。
  window.UiNextProjectDetailView = Vue.defineComponent({
    name: "UiNextProjectDetailView",
    components: {
      SearchableSelect: window.SearchableSelect,
      ReleaseModal: window.ReleaseModal,
      UiNextIcon: window.UiNextIcon,
    },
    data() { return { editServiceContactName: "", editName: "", editDescription: "", savingBasics: false, project: null, repos: [], branchInfo: {}, loading: true, loadError: "", newRepo: { label: "", repo_url: "", is_primary: false, base_branch: "" }, remoteBranches: [], probingBranches: false, lastProbedUrl: null, savingRepo: false, env: null, envWorking: false, editOdooProjectName: "", editServiceRespondentName: "", editE2eEnabled: true, savingE2e: false, editEdition: "community", savingEdition: false, runtimeLog: null, logLoading: false, showReleaseModal: false, detailTab: ["repos","env","settings","chat","db","sop","wiki"].includes(this.$route.query.tab) ? this.$route.query.tab : "chat", chats: [], chatsLoading: false, chatsError: "", chatSearch: "", creatingChat: false, tabs: [["chat","Chat"],["repos","Repo"],["db","連線設定"],["env","測試環境"],["wiki","Wiki"],["sop","部署 SOP"],["settings","設定"]], _pollTimer: null, _reposPollTimer: null }; },
    computed: { embeddedTab() { return { db: window.UiNextDbView, sop: window.UiNextDeploySopView, wiki: window.UiNextWikiView }[this.detailTab] || null; }, filteredChats() { const q = this.chatSearch.trim().toLowerCase(); return q ? this.chats.filter((c) => (c.title || "新對話").toLowerCase().includes(q)) : this.chats; }, hasCloning() { return this.repos.some((repo) => repo.clone_status === "cloning"); }, envActive() { return !!(this.env && (this.env.status === "setting_up" || this.env.status === "running" || this.env.built)); } },
    watch: {
      "$route.query.tab"(tab) {
        const next = ["repos","env","settings","chat","db","sop","wiki"].includes(tab) ? tab : "chat";
        if (next === this.detailTab) return;
        this.detailTab = next;
        if (next === "chat") this.loadChats();
      },
      "env.status"(value) { if (value === "setting_up") this._startPoll(); else this._stopPoll(); },
      hasCloning(value) { if (value) this._startReposPoll(); else this._stopReposPoll(); },
    },
    async created() { await Promise.all([this.load(), this.loadEnv()]); if (this.detailTab === "chat") this.loadChats(); },
    // 沒有這行，離開專案頁之後那兩個 timer 還會繼續打 API（元件早就卸載，畫面也不會更新）。
    beforeUnmount() { this._stopPoll(); this._stopReposPoll(); },
    methods: {
      // 環境建立／repo clone 都是背景長工，後端不推事件；不輪詢的話「建立中」「同步中」會永遠停在原地。
      _startPoll() { if (this._pollTimer) return; this._pollTimer = setInterval(() => this.loadEnv(), 5000); },
      _stopPoll() { if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; } },
      _startReposPoll() { if (this._reposPollTimer) return; this._reposPollTimer = setInterval(async () => { const data = await Api.get(`projects/${this.$route.params.id}`).catch(() => null); if (data) this.repos = data.repos || []; }, 3000); },
      _stopReposPoll() { if (this._reposPollTimer) { clearInterval(this._reposPollTimer); this._reposPollTimer = null; } },
      async load() { this.loading = true; this.loadError = ""; try { const data = await Api.get(`projects/${this.$route.params.id}`); this.project = data; this.editName = this.project?.name || ""; this.editDescription = this.project?.description || ""; this.repos = data.repos || []; this.editOdooProjectName = data.odoo_project_name || ""; this.editServiceRespondentName = data.service_respondent_name || ""; this.editServiceContactName = data.service_contact_name || ""; this.editE2eEnabled = !data.e2e_disabled; this.editEdition = data.edition || "community"; await Promise.all(this.repos.filter((repo) => repo.clone_status === "done").map(async (repo) => { const info = await Api.get(`projects/${data.id}/repos/${repo.id}/branches`).catch(() => null); if (info) this.branchInfo[repo.id] = info; })); } catch (error) { this.loadError = error.message || "無法載入專案"; showToast(this.loadError, "error", 0); } finally { this.loading = false; } },
      async loadEnv() { this.env = await Api.get(`projects/${this.$route.params.id}/env`).catch(() => this.env || { status: "idle" }); },
      async addRepo() { if (!this.newRepo.label || !this.newRepo.repo_url) return showToast("請填寫標籤和 repo URL", "error"); this.savingRepo = true; try { await Api.post(`projects/${this.$route.params.id}/repos`, { ...this.newRepo }); this.newRepo = { label: "", repo_url: "", is_primary: false, base_branch: "" }; this.remoteBranches = []; await this.load(); showToast("Repo 已新增，正在同步", "success"); } catch (error) { showToast(error.message || "新增 Repo 失敗", "error", 0); } finally { this.savingRepo = false; } },
      async probeRemoteBranches() { const url = this.newRepo.repo_url.trim(); if (!url || url === this.lastProbedUrl) return; this.lastProbedUrl = url; this.probingBranches = true; try { const data = await Api.get(`git/remote-branches?url=${encodeURIComponent(url)}`); this.remoteBranches = data.ok ? data.branches || [] : []; this.newRepo.base_branch = data.defaultBranch || ""; } catch { this.remoteBranches = []; } finally { this.probingBranches = false; } },
      async removeRepo(id) { if (!await confirmDialog({ title: "移除 Repo", message: "確定移除此 repo？本機 clone 的程式碼將一併刪除，且無法復原。", danger: true, confirmText: "移除" })) return; try { await Api.delete(`projects/${this.$route.params.id}/repos/${id}`); await this.load(); } catch (error) { showToast(error.message || "移除失敗", "error", 0); } }, async reclone(id) { try { await Api.post(`projects/${this.$route.params.id}/repos/${id}/reclone`, {}); await this.load(); } catch (error) { showToast(error.message || "同步失敗", "error", 0); } }, updateRepo(id) { return this.reclone(id); },
      unreadCount() { return this.project ? (window.UnreadStore.byProject[String(this.project.id)] || this.project.unread_count || 0) : 0; },  // 七個頁籤裡只有三個是同一頁的區塊，其餘四個是獨立路由；切同頁的頁籤要同步寫進 ?tab=，否則重整會跳回第一個。
      selectTab(key) { 
        this.detailTab = key; this.$router.replace({ query: { ...this.$route.query, tab: key } });
        if (key === "chat") this.loadChats(); },
      // 對話清單只在切到該頁籤時才讀，進專案頁不必先打這支 API。
      async saveBasics() {
        const name = this.editName.trim();
        if (!name || this.savingBasics) return;
        this.savingBasics = true;
        try {
          const updated = await Api.put(`projects/${this.$route.params.id}`, { name, description: this.editDescription });
          this.project = { ...this.project, name: updated.name, description: updated.description };
          showToast("已儲存", "success");
        } catch (error) { showToast(error.message || "儲存失敗", "error"); }
        finally { this.savingBasics = false; }
      },
      async loadChats() {
        this.chatsLoading = true; this.chatsError = "";
        try { this.chats = await Api.get(`projects/${this.$route.params.id}/chats`); }
        catch (error) { this.chatsError = error.message || "無法載入對話清單"; }
        finally { this.chatsLoading = false; }
      },
      async createChat() {
        if (this.creatingChat) return;
        this.creatingChat = true;
        try { const chat = await Api.post(`projects/${this.$route.params.id}/chats`, { title: "新對話" });
          this.$router.push(`/projects/${this.$route.params.id}/chat/${chat.id}`); }
        catch (error) { showToast(error.message || "無法建立對話", "error"); }
        finally { this.creatingChat = false; }
      },
      openChat(chat) { this.$router.push(`/projects/${this.$route.params.id}/chat/${chat.id}`); },
      chatDate(value) { return value ? new Date(value).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"; },
      
      async setupEnv() { this.envWorking = true; try { await Api.post(`projects/${this.$route.params.id}/env/setup`, {}); this.env = { ...(this.env || {}), status: "setting_up" }; showToast("環境建立已開始", "success"); } catch (error) { showToast(error.message || "建立環境失敗", "error", 0); } finally { this.envWorking = false; } }, async stopEnv() { this.envWorking = true; try { await Api.post(`projects/${this.$route.params.id}/env/stop`, {}); await this.loadEnv(); } finally { this.envWorking = false; } }, async releaseExternal() { await Api.post(`projects/${this.$route.params.id}/env/external/release`, {}); await this.loadEnv(); }, async openEnv() { const popup = window.open("about:blank", "_blank"); try { const url = await pollEnvSso(this.$route.params.id); if (popup) popup.location = url; else window.location.href = url; } catch (error) { if (popup) popup.close(); showToast(error.message || "無法開啟測試區", "error", 0); } }, async viewLog() { this.logLoading = true; try { const data = await Api.get(`projects/${this.$route.params.id}/env/log`); this.runtimeLog = data.exists ? data.log || "（log 為空）" : "（尚無 log 檔）"; } finally { this.logLoading = false; } }, async deleteEnv() { if (!await confirmDialog({ title: "刪除測試環境", message: "確定刪除整個測試環境？", danger: true, confirmText: "刪除" })) return; await Api.delete(`projects/${this.$route.params.id}/env`); await this.loadEnv(); },
      async saveProjectMapping() { await Api.patch(`projects/${this.project.id}/mapping`, { odoo_project_name: this.editOdooProjectName || null, service_respondent_name: this.editServiceRespondentName || null, service_contact_name: this.editServiceContactName || null }); showToast("已儲存", "success"); }, async saveE2eSetting() { this.savingE2e = true; try { await Api.patch(`projects/${this.project.id}`, { e2e_disabled: !this.editE2eEnabled }); } finally { this.savingE2e = false; } }, async saveEdition() { this.savingEdition = true; try { await Api.patch(`projects/${this.project.id}`, { edition: this.editEdition }); } finally { this.savingEdition = false; } }, isAdmin() { return window.UserStore.role === "admin"; },
    },
    template: `
      <section v-if="loading" class="ui-next-page">
<div class="ui-next-loading-card">載入專案中…</div>
</section>
      <!-- loadError 一定要排在 project 之前判：載入失敗時 project 仍是 null，會掉進最後那個
           「專案不存在」的 v-else——把網路／權限錯誤誤報成資料不存在，使用者會去找根本沒消失的專案。 -->
      <section v-else-if="loadError" class="ui-next-page">
<div class="ui-next-loading-card ui-next-error-text">{{ loadError }} <button type="button" @click="load">重試</button></div>
</section>
      <section v-else-if="project" class="ui-next-page ui-next-project-detail">
        <header class="ui-next-page-head ui-next-detail-head">
<div>
<h1>{{ project.name }}</h1>
<p>{{ project.description || '集中管理 Repo、測試環境與專案設定。' }}</p>
</div>
<div class="ui-next-detail-actions">
<button @click="openEnv" :disabled="!envActive">測試區</button>
<button @click="showReleaseModal=true" :disabled="!repos.some(r=>r.clone_status==='done')">上正式</button>
<button class="ui-next-back" @click="$router.push('/projects')"><ui-next-icon name="arrow-left"/> 所有專案</button>
</div>
</header>
        <div class="ui-next-project-statbar">
<span>Odoo {{ project.odoo_version || '—' }}</span>
<span>{{ editEdition==='enterprise'?'企業版':'社群版' }}</span>
<span>{{ repos.length }} 個 Repo</span>
<span :class="['is-'+(env&&env.status||'idle')]">{{ {idle:'環境未建立',setting_up:'環境建立中',running:'環境運行中',error:'環境發生錯誤'}[env&&env.status] || '環境未建立' }}</span>
</div>
        <nav class="ui-next-detail-tabs">
<button v-for="tab in tabs" :key="tab[0]" :class="{active:detailTab===tab[0]}" @click="selectTab(tab[0])">{{ tab[1] }}<span v-if="tab[0]==='chat'&&unreadCount()">{{ unreadCount() }}</span></button>
</nav>
        <div v-if="detailTab==='repos'" class="ui-next-project-detail-grid">
<section class="ui-next-panel ui-next-repos">
<div class="ui-next-card-title">
<div>
<h2>Git Repositories</h2>
<p>原始碼、主分支與同步狀態。</p>
</div>
</div>
<div v-if="!repos.length" class="ui-next-empty-state">尚未綁定任何 Repo。</div>
<article v-for="repo in repos" :key="repo.id" class="ui-next-repo-row">
<div>
<div class="ui-next-repo-name">
<b>{{ repo.label }}</b>
<span v-if="repo.is_primary">主要</span>
<em :class="repo.clone_status">{{ {cloning:'同步中',done:'已同步',error:'同步失敗'}[repo.clone_status] || repo.clone_status }}</em>
</div>
<p>{{ repo.repo_url }}</p>
<small v-if="repo.clone_status==='done'">主分支：{{ (branchInfo[repo.id]&&branchInfo[repo.id].effective)||repo.base_branch||'自動偵測' }}<template v-if="branchInfo[repo.id]&&branchInfo[repo.id].ai_branch"> · AI：{{ branchInfo[repo.id].ai_branch }}</template>
</small>
<small v-if="repo.clone_error" class="ui-next-error-text">{{ repo.clone_error }}</small>
</div>
<div class="ui-next-repo-actions">
<button v-if="repo.clone_status==='error'" @click="reclone(repo.id)">重新同步</button>
<button v-if="repo.clone_status==='done'" @click="updateRepo(repo.id)">更新</button>
<button class="danger" @click="removeRepo(repo.id)" :disabled="envActive||repo.clone_status==='cloning'">移除</button>
</div>
</article>
<form class="ui-next-add-repo" @submit.prevent="addRepo">
<input v-model="newRepo.label" placeholder="標籤，例如 main">
<input v-model="newRepo.repo_url" placeholder="Git URL" @blur="probeRemoteBranches">
<SearchableSelect v-if="remoteBranches.length" :model-value="newRepo.base_branch" :options="remoteBranches.map(b=>({value:b,label:b}))" all-label="自動偵測" placeholder="主分支" @update:modelValue="v=>newRepo.base_branch=v||''"/>
<span v-else class="ui-next-field-note">{{ probingBranches?'讀取分支中…':'主分支自動偵測' }}</span>
<label>
<input type="checkbox" v-model="newRepo.is_primary"> 主要 Repo</label>
<button class="ui-next-primary" :disabled="savingRepo||probingBranches">{{ savingRepo?'新增中…':'新增 Repo' }}</button>
</form>
</section>
</div>
        <section v-if="detailTab==='env'" class="ui-next-panel ui-next-env-card">
<div class="ui-next-card-title">
<div>
<h2>Odoo 測試環境</h2>
<p>可獨立建立、啟動與檢視測試區。</p>
</div>
<span :class="['ui-next-env-status',env&&env.status]">{{ {idle:'未建立',setting_up:'建立中',running:'運行中',error:'錯誤'}[env&&env.status] || '未建立' }}</span>
</div>
<p v-if="env&&env.error_msg" class="ui-next-error-text">{{ env.error_msg }}</p>
<p v-if="env&&env.addons_drift&&env.addons_drift.length" class="ui-next-warning-text">新增的 Repo 尚未掛進既有環境：{{ env.addons_drift.join('、') }}。停止後重新啟動即可重建掛載。</p>
<div class="ui-next-env-actions">
<button v-if="!env||env.status==='idle'||env.status==='error'" class="ui-next-primary" @click="setupEnv" :disabled="envWorking">{{ envWorking?'處理中…':(env&&env.built?'重新啟動':'建立環境') }}</button>
<button v-if="env&&env.status==='running'" class="ui-next-primary" @click="openEnv">開啟測試區</button>
<button v-if="env&&env.status==='running'&&env.external_slot!=null" @click="releaseExternal" :disabled="envWorking">關閉對外</button>
<button v-if="env&&env.status==='running'" @click="stopEnv" :disabled="envWorking">停止</button>
<button v-if="env&&(env.built||env.status!=='idle')" @click="viewLog" :disabled="logLoading">{{ logLoading?'讀取中…':'查看 log' }}</button>
<button v-if="env&&(env.status!=='idle'||env.built)" class="danger" @click="deleteEnv" :disabled="envWorking">刪除環境</button>
<button @click="loadEnv" :disabled="envWorking">重新整理</button>
</div>
<details v-if="env&&env.setup_log">
<summary>查看建立記錄</summary>
<pre>{{ env.setup_log }}</pre>
</details>
<div v-if="runtimeLog!==null" class="ui-next-runtime-log">
<div>
<span>Odoo 運行記錄</span>
<button @click="runtimeLog=null">關閉</button>
</div>
<pre>{{ runtimeLog }}</pre>
</div>
</section>
        <section v-if="embeddedTab" class="ui-next-embedded-tab"><component :is="embeddedTab" :embedded="true"/></section>
<section v-if="detailTab==='chat'" class="ui-next-panel ui-next-chat-tab">
<div class="ui-next-card-title">
<div><h2>對話</h2><p>{{ chats.length }} 則對話；點一則進入專心模式。</p></div>
<button class="ui-next-primary" @click="createChat" :disabled="creatingChat">{{ creatingChat?'建立中…':'新對話' }}</button>
</div>
<input v-if="chats.length" v-model="chatSearch" class="ui-next-chat-tab-search" type="search" placeholder="搜尋對話標題" aria-label="搜尋對話">
<p v-if="chatsError" class="ui-next-inline-error" role="alert">{{ chatsError }} <button type="button" @click="loadChats">重試</button></p>
<p v-else-if="chatsLoading" class="ui-next-chat-tab-empty">載入中…</p>
<p v-else-if="!chats.length" class="ui-next-chat-tab-empty">還沒有對話。建立一則，討論會保留在這個專案裡。</p>
<p v-else-if="!filteredChats.length" class="ui-next-chat-tab-empty">沒有符合「{{ chatSearch }}」的對話。</p>
<ul v-else class="ui-next-chat-tab-list">
<li v-for="chat in filteredChats" :key="chat.id">
<button type="button" @click="openChat(chat)">
<b>{{ chat.title || '新對話' }}</b>
<span v-if="chat.unread" class="ui-next-chat-tab-unread">{{ chat.unread }}</span>
<em v-if="chat.reply_pending">AI 回覆中</em>
<small>{{ chatDate(chat.created_at) }}</small>
</button>
</li>
</ul>
</section>
<section v-if="detailTab==='settings'" class="ui-next-project-settings">
<div class="ui-next-panel">
<h2>基本資料</h2>
<p>顯示在專案清單與側欄的名稱與備註。</p>
<label>專案名稱<input v-model="editName" autocomplete="off"></label>
<label>專案備註<textarea v-model="editDescription" placeholder="這個專案在做什麼、有什麼要注意的"></textarea></label>
<button class="ui-next-primary" @click="saveBasics" :disabled="savingBasics||!editName.trim()">{{ savingBasics?'儲存中…':'儲存' }}</button>
</div>
<div class="ui-next-panel">
<h2>同步來源對應</h2>
<p>一行一個名稱，可自動綁定 Odoo 與客服同步來源。</p>
<label>Odoo 專案名稱<textarea v-model="editOdooProjectName" placeholder="一行一個完整名稱">
</textarea>
</label>
<label>客服來源名稱<textarea v-model="editServiceRespondentName" placeholder="一行一個完整名稱">
</textarea>
</label>
<label>主要聯絡人<textarea v-model="editServiceContactName" placeholder="一行一個完整名稱">
</textarea>
</label>
<button class="ui-next-primary" @click="saveProjectMapping">儲存對應</button>
</div>
<div v-if="isAdmin()" class="ui-next-panel">
<h2>測試流程</h2>
<p>E2E 會依驗收條件建立並在部署後執行。</p>
<label class="ui-next-toggle">
<input type="checkbox" v-model="editE2eEnabled" @change="saveE2eSetting" :disabled="savingE2e">
<span>
</span>{{ editE2eEnabled?'E2E 測試啟用中':'已停用 E2E 測試' }}</label>
<hr>
<h2>Odoo 版本類型</h2>
<select v-model="editEdition" @change="saveEdition" :disabled="savingEdition">
<option value="community">社群版（Community）</option>
<option value="enterprise">企業版（Enterprise）</option>
</select>
</div>
</section>
        <ReleaseModal v-if="showReleaseModal" :project-id="$route.params.id" @close="showReleaseModal=false" />
      </section>
      <section v-else class="ui-next-page">
<div class="ui-next-empty-state">專案不存在。</div>
</section>`,
  });

  // 任務詳情的資料、輪詢、附件與每種 Pipeline 動作均沿用既有實作；新版只重組資訊層級。
  window.UiNextTaskDetailView = Vue.defineComponent({
    name: "UiNextTaskDetailView",
    components: { UiNextIcon: window.UiNextIcon },
    data() {
      return { task: null, logs: [], loading: true, resolution: '', csAnswers: {}, odooUrl: '', serviceUrl: '', submitting: false, approving: false, archiving: false, rejecting: false, rejectReason: '', rejectFiles: [], conflictResolving: false, conflictChoices: {}, submittingConflicts: false, clarifying: {}, clarifyText: {}, csConfirming: false, csRetrying: false, csFollowup: '', csFollowingUp: false, resolving: false, error: '', serverConfirmedRunning: false, testMode: false, stepping: false, events: [], eventsHasMore: true, eventsLoading: false, eventsError: '', expandedEvents: {}, editingContent: false, editText: '', savingContent: false, taskMessages: [], sendingMessage: false, newMessageText: '', writebackEnabled: false, messageWriteback: false, ticketAttachments: [], newMessageFiles: [], diffOpen: false, diffLoading: false, diffError: '', diffData: null, clarification: { summary: '', questions: [] }, answerFields: {}, answerExtra: {}, answerFiles: [], clarTab: 'qa', askText: '', askSubmitting: false, askFiles: [], expandedLogs: {}, convVisible: 5, downloadingZip: false, healthChecking: false, spec: null, specFeedback: '', specApproving: false, specRevising: false, specReqOpen: false, taskTab: 'requirements' };
    },
    computed: {
      isAgentRunning() { return !!this.task && !this.task.is_paused && (window.RUNNABLE_STATUSES || []).includes(this.task.status); },
      isAdmin() { return window.UserStore.role === 'admin'; },
      // 新手教程的示範任務（/task/demo）：整頁資料改由 tour-demo.js 供應，一律不打 API。
      // 課程換關卡＝換 demoStatus，watcher 會把動作區重新套用，人才看得到同一個位置換不同的事要做。
      isTourDemo() { return !!(window.TourDemo && window.TourDemo.isTask(this.$route.params.id)); },
      tourDemoStatus() { return window.TourDemo ? window.TourDemo.status : null; },
      canAnswer() { return this.task && ANSWER_ALLOWED.includes(this.task.status); },
      canEditContent() { return this.task && this.task.status === 'new'; },
      // 時間軸底下的單一動作區依 status 切成一種 mode；有主動作的狀態各自 render，其餘走通用留言
      timelineActionMode() {
        const s = this.task?.status;
        if (s === 'confirm_pending' || s === 'clarify_pending')  return 'answer';
        // AI 回話期間仍留在 answer 區（輸入元件會 disable）：整塊換成通用留言框的話，
        // 使用者每問一句就被踢出「提問」頁籤，AI 答完還要自己切回去。後端只在澄清情境回題目。
        if (s === 'clarify_chat_running' && this.clarQuestions.length) return 'answer';
        if (s === 'spec_review')      return 'spec_review';
        if (s === 'review_pending')   return 'review';
        if (s === 'merge_conflict')   return 'conflict';
        if (s === 'cs_reply_pending') return 'cs_reply';
        if (s === 'cs_data_needed')   return 'cs_data';
        if (s === 'stopped')          return 'blocker';
        if (s === 'done')             return 'archive';
        return 'message';
      },
      actionModeLabel() {
        return { answer:'等待回答', spec:'規格審核', review:'人工審核', conflict:'合併衝突', csReply:'客服回覆', csData:'補充資料', blocker:'需要介入', archive:'任務完成', message:'新增留言' }[
          ({ spec_review:'spec', cs_reply:'csReply', cs_data:'csData' }[this.timelineActionMode] || this.timelineActionMode)
        ];
      },
      statusLabel() { return this.task ? (STATUS_LABELS[this.task.status] || this.task.status) : ''; },
      // 這個輸入框是自由文字，但它餵的分診 agent 要產出的是 {decision, target} 結構化決策，
      // 而畫面上從來沒有一處提示過這件事。散文「推進到 QA」會被判成 fix，coding 進去無事可做就 stop，
      // 使用者再填一次又繞回來（實測連續五輪白跑）。這幾顆把契約詞彙填成可照抄的句子——填入而非
      // 直接送出，使用者仍能接著補自己的上下文。
      blockerShortcuts() {
        return [
          { label: '碼我自己改好了，重新審查', text: '程式碼我已經自行修正完成，請回傳 decision="advance"、target="qa"。' },
          { label: '環境已排除，重跑部署', text: '環境問題已排除，程式碼未變動，請回傳 decision="advance"、target="deploy"。' },
          { label: '這是誤判，直接送人工審核', text: '這是誤判，不需再修改，請回傳 decision="advance"、target="review"。' }
        ];
      },
      // merge_conflict 的結構化衝突資料（後端 merge_conflict_data，可能為 JSON 字串）
      conflictData() {
        if (!this.task?.merge_conflict_data) return null;
        try {
          return typeof this.task.merge_conflict_data === 'string'
            ? JSON.parse(this.task.merge_conflict_data) : this.task.merge_conflict_data;
        } catch { return null; }
      },
      // 逐檔裁決卡片：[{repo, file, key, detail}]；detail 可能為 null（舊資料／AI 分析失敗＝無建議）
      conflictItems() {
        const cd = this.conflictData;
        if (!cd || !Array.isArray(cd.repos)) return [];
        const items = [];
        for (const r of cd.repos) {
          for (const f of (r.files || [])) {
            items.push({ repo: r.repo, file: f, key: r.repo + '||' + f, detail: (r.details && r.details[f]) || null });
          }
        }
        return items;
      },
      // 重建 testing 引發的衝突沿用舊「已手動解決」流程（不走逐檔裁決）
      isRebuildConflict() { return !!(this.conflictData && this.conflictData.rebuild); },
      // 此次衝突來自「把 main 的新 commit 拉進 ai-dev」而非任務分支併 testing——
      // 兩側的意義完全不同，裁決文案必須跟著換，否則使用者會選反邊
      isSyncConflict() { return !!(this.conflictData && this.conflictData.sync); },
      conflictAllChosen() {
        return this.conflictItems.length > 0 && this.conflictItems.every(i => !!this.conflictChoices[i.key]);
      },
      csQuestions() {
        if (!this.task?.cs_question) return [];
        try { return JSON.parse(this.task.cs_question); } catch { return [this.task.cs_question]; }
      },
      csAllAnswered() {
        return this.csQuestions.length > 0 && this.csQuestions.every(q => (this.csAnswers[q] || '').trim());
      },
      // confirm_pending 的分析澄清問題（來自後端解析 analysis_yaml）；逐題各一回答框
      clarQuestions() { return this.clarification?.questions || []; },
      // intro 是白話說明段，不是題目：不編號、不必答，顯示在題目上方
      clarIntro() { return this.clarification?.intro || ''; },
      // AI 正在回話：兩個頁籤的輸入都鎖住（後端此時也會 400），但版面留著不換走
      clarBusy() { return this.task?.status === 'clarify_chat_running'; },
      clarAllAnswered() {
        return this.clarVisible().every(q => !q.required || this.clarAnswerText(q));
      },
      // 合併「外部溝通紀錄」與「對話紀錄」成一條依時間排序的時間軸（含人工審核事件，因為 approve/reject 都會寫 task_logs）
      timeline() {
        const msgs = (this.taskMessages || []).map(m => ({
          _key: 'msg-' + m.id, ts: m.occurred_at, kind: 'message', source: m.source,
          author: m.author, content: m.content, synced_to_odoo: m.synced_to_odoo, attachments: m.attachments
        }));
        const logs = (this.logs || []).map(l => ({
          _key: 'log-' + l.id, ts: l.created_at, kind: 'log', role: l.role, content: l.content
        }));
        const blocker = (this.task && this.task.status === 'stopped' && this.task.blocker_content)
          ? [{ _key: 'blocker', ts: this.task.updated_at, kind: 'log', role: 'blocker', content: this.task.blocker_content }]
          : [];
        return [...msgs, ...logs, ...blocker].sort((a, b) => new Date(a.ts) - new Date(b.ts));
      },
      // 只渲染末 N 筆（最新）；往上捲再增量載入更早的，避免整條歷史撐開版面
      visibleTimeline() { return this.timeline.slice(-this.convVisible); },
      hasMoreConv() { return this.timeline.length > this.convVisible; },
      // 留言模式（非回覆 AI 問題）且任務有外部來源、管理者開了回寫開關時，才顯示「回寫 Odoo」勾選框
      showWritebackOption() {
        return !this.canAnswer && this.writebackEnabled && !!this.task && (this.task.source === 'odoo' || this.task.source === 'service');
      }
    },
    async created() {
      await this.load();
      const requestedTab = this.$route.query.tab;
      this.taskTab = ['requirements', 'conversation', 'history'].includes(requestedTab)
        ? requestedTab
        : ((window.HUMAN_STATUSES || []).includes(this.task?.status) ? 'conversation' : 'requirements');
      if (this.taskTab === "conversation") this.$nextTick(() => this.bindConvScroll());
      Api.get('system/config').then(r => {
        this.odooUrl = r.odoo_url || '';
        this.serviceUrl = r.service_url || '';
        this.testMode = !!r.test_mode;
        this.writebackEnabled = !!r.writeback_odoo_notes;
      }).catch(() => {});
      this.checkInflight();
      this.loadEvents();
      this.loadTaskMessages();
      this.markInboxRead();
    },
    mounted() {
      // 訂閱狀態更新：pipeline 推 task:updated 時靜默重抓，讓狀態/阻塞原因即時更新（免手動重整）
      const sock = window._socket;
      this._onTaskUpdated = (data) => {
        if (this.task && data && data.taskId === this.task.id) {
          this.refresh().catch(() => {});
          this.checkInflight();
        }
      };
      if (sock) sock.on('task:updated', this._onTaskUpdated);
      // 即時歷程：pipeline 推 terminal:output 時直接 append 到本頁記錄
      this._onTermOutput = (data) => {
        if (this.task && data && data.taskId === this.task.id) {
          const c = this.$refs.eventsBox;
          const atBottom = c ? (c.scrollHeight - c.scrollTop - c.clientHeight < 30) : true;
          this.events.push({ id: null, content: data.data, _live: true });
          if (atBottom) this.$nextTick(() => this.scrollEventsToBottom());
        }
      };
      if (sock) sock.on('terminal:output', this._onTermOutput);
    },
    beforeUnmount() { this.unbindConvScroll();
      const sock = window._socket;
      if (sock && sock.off) {
        if (this._onTaskUpdated) sock.off('task:updated', this._onTaskUpdated);
        if (this._onTermOutput) sock.off('terminal:output', this._onTermOutput);
      }
    },
    watch: {
      // 對話時間軸：只要目前釘在底部（初始／或使用者停在底部）就隨新內容貼底看最新；
      // 使用者一往上捲，onConvScroll 會解除釘住，之後新訊息不再打斷閱讀
      'timeline.length'(n) {
        if (n && this._convPinBottom !== false) this.$nextTick(() => this.scrollConvToBottom());
      },
      tourDemoStatus() { if (this.isTourDemo) this.refresh(); },
      '$route.query.tab'(tab) {
        if (['requirements', 'conversation', 'history'].includes(tab) && tab !== this.taskTab) this.taskTab = tab;
      },
    },
    methods: {
      setTaskTab(tab) {
        this.taskTab = tab;
        if (this.$route.query.tab !== tab) this.$router.replace({ query: { ...this.$route.query, tab } });
        if (tab === "conversation") this.$nextTick(() => this.bindConvScroll());
        this.$nextTick(() => {
          const visible = (item) => item && item.getClientRects().length > 0;
          [...document.querySelectorAll(".ui-next-task-detail-grid [role=\"tabpanel\"]")].find(visible)?.focus();
        });
      },
      async openEnv() {
        // JWT 走 Authorization header，瀏覽器導航不會帶上 → 先 fetch SSO 端點拿免密登入 URL 再開。
        // popup-blocker：window.open 必須在 click handler 內同步開，不能等 await 後才開。
        const w = window.open('about:blank', '_blank');
        // 環境可能已被閒置回收，後端會自動起並回 starting；首建可達數分鐘，
        // 空白分頁乾等會被當成當掉，故先在分頁裡寫一句話再輪詢。
        if (w) {
          try {
            w.document.write('<p style="font-family:sans-serif;padding:2rem">測試區建立中，請稍候…</p>');
          } catch (e) { console.debug('about:blank document.write 被瀏覽器擋下，不影響後續導向:', e && e.message); }
        }
        try {
          const url = await pollEnvSso(this.task.project_id);
          if (w) w.location = url; else window.location = url;
        } catch (e) {
          if (w) w.close();
          showToast(e.message || '無法開啟測試區', 'error');
        }
      },
      // 打開任務頁＝這件事已經看到了，不該還掛在收件匣等你回去點。後端的自動消解只涵蓋
      // kind='action' 且任務已離開等人狀態的那部分，退回事件（bounce）完全不在其中——不從這裡
      // 清，沒經收件匣進來的人就永遠清不掉。清完要順手校正 badge，否則數字要等下次換頁才更新。
      // 靜默失敗：收件匣不是本頁的關鍵路徑（教程的假任務 id 也會走到這裡並被後端擋成 404）。
      async markInboxRead() {
        try {
          await Api.post(`inbox/task/${this.$route.params.id}/read`);
          if (window.loadInboxUnread) window.loadInboxUnread();
        } catch (e) { /* 靜默：badge 不是關鍵路徑 */ }
      },
      async load() {
        this._convPinBottom = true; this.convVisible = 5;
        this.loading = true;
        try {
          await this.refresh();
        } catch (e) { this.error = e.message; }
        finally { this.loading = false; }
      },
      // 分頁撈完整對話 log（task_logs），避免 detail 端點只回末 5 筆而截斷對話時間軸。
      // 順序不重要——timeline() 會依 ts 重排；每頁 ≤100，撈到不足一頁為止（cap 防呆）。
      async fetchAllLogs() {
        const all = [];
        const PAGE = 100;
        for (let offset = 0; offset < 2000; offset += PAGE) {
          const rows = await Api.get(`tasks/${this.$route.params.id}/logs?limit=${PAGE}&offset=${offset}`);
          if (!Array.isArray(rows) || rows.length === 0) break;
          all.push(...rows);
          if (rows.length < PAGE) break;
        }
        return all;
      },
      // 靜默重抓任務＋logs（不切 loading，避免即時更新時整頁閃「載入中」）
      // 併發合併：送出類動作送完會自己重抓，而後端在同一個請求裡就推了 task:updated，
      // socket handler 又抓一次 → 兩輪並行、誰後回來誰蓋上去（可能蓋回舊快照）。
      // 飛行中再進來的只記一次尾隨重抓：保證事件之後的資料仍會抓到，但同時只有一輪在跑。
      async refresh() {
        if (this._refreshing) { this._refreshPending = true; return this._refreshing; }
        this._refreshing = (async () => {
          try {
            do {
              this._refreshPending = false;
              await this._refreshOnce();
            } while (this._refreshPending);
          } finally { this._refreshing = null; this._refreshPending = false; }
        })();
        return this._refreshing;
      },
      async _refreshOnce() {
        // detail 與 logs 互不相依（logs 只吃路由上的 id）→ 並行發，省掉一趟序列往返
        const [data, allLogs] = this.isTourDemo
          ? [window.TourDemo.detail(), window.TourDemo.logs()]
          : await Promise.all([
            Api.get(`tasks/${this.$route.params.id}`),
            this.fetchAllLogs().catch(() => null),
          ]);
        this.task = data.task || data;
        // 對話時間軸要完整歷史：用分頁全量 log，撈失敗（null）才退回 detail 的末 5 筆快照
        this.logs = allLogs || data.logs || this.logs || [];
        this.ticketAttachments = data.attachments || [];
        this.clarification = data.clarification || { summary: '', questions: [] };
        this.spec = data.spec || null; // spec_review 審核頁的規格（後端已 parse analysis_yaml）
        // Init answer fields for each cs question
        const qs = (() => { try { return JSON.parse(this.task.cs_question || '[]'); } catch { return []; } })();
        const init = {};
        qs.forEach(q => { if (!(q in this.csAnswers)) init[q] = ''; });
        this.csAnswers = { ...this.csAnswers, ...init };
        // Init answer fields for each clarification question（逐題各一框，以題目 id 為鍵）
        // q.answer 是 clarify-chat 依對話預填的答案：使用者已經講過的事不該再要他打一次，
        // 但只當初值——他隨時可以改掉。已有輸入時不覆蓋（避免打字打到一半被重抓的資料洗掉）。
        // 選擇題的預填值若不是任何一個選項（AI 從對話抓到的是自由敘述），落到補充框而不是被丟掉
        // 題目會被 clarify-chat 依對話就地改寫：題目或預填答案一變就把輸入整組丟掉重建，
        // 否則「不覆蓋既有輸入」會讓畫面停在舊題目的舊答案上，新結論永遠顯示不出來。
        const clarSig = JSON.stringify(this.clarification.questions.map(q => [q.id, q.answer || '']));
        if (clarSig !== this._clarSig) {
          this._clarSig = clarSig;
          this.answerFields = {};
          this.answerExtra = {};
        }
        const clarInit = {}, extraInit = {};
        this.clarification.questions.forEach(q => {
          if (q.id in this.answerFields) return;
          const pre = q.answer || '';
          const isOpt = (q.options || []).some(o => o.key === pre);
          if (q.type === 'choice' && pre && !isOpt) { clarInit[q.id] = ''; extraInit[q.id] = pre; }
          else clarInit[q.id] = pre;
        });
        this.answerFields = { ...this.answerFields, ...clarInit };
        this.answerExtra = { ...this.answerExtra, ...extraInit };
        // 逐檔裁決：預設落在 AI 建議（無建議則留 manual，強迫使用者自己選）
        const REC = ['take_theirs', 'take_ours', 'manual'];
        const cc = {};
        this.conflictItems.forEach(i => {
          if (!(i.key in this.conflictChoices)) {
            cc[i.key] = REC.includes(i.detail?.recommendation) ? i.detail.recommendation : 'manual';
          }
        });
        this.conflictChoices = { ...this.conflictChoices, ...cc };
      },
      // depends_on 條件不滿足 → 該題收起，不顯示也不擋送出。條件指向不存在的題目時照常顯示（fail open）。
      clarVisible() {
        const byId = new Map(this.clarQuestions.map(q => [q.id, q]));
        return this.clarQuestions.filter(q => {
          const dep = q.depends_on;
          if (!dep || !byId.has(dep.question)) return true;
          return String(this.answerFields[dep.question] ?? '') === String(dep.equals);
        });
      },
      // AI 對這題建議的答案。choice 題的 recommended 存的是 option 的 key，畫面要換成 label——
      // 顯示「建議：A」等於沒講。找不到對應 option（text 題，或 key 打錯）就原樣顯示。
      // 選用欄位：純屬「使用者要什麼」的題目 AI 刻意不填（它沒有依據），回空字串＝那一行不渲染。
      clarRecommend(q) {
        const rec = String(q.recommended ?? '').trim();
        if (!rec) return '';
        const opt = (q.options || []).find(o => o.key === rec);
        const label = (opt && opt.label) ? opt.label : rec;
        const why = String(q.recommended_why ?? '').trim();
        return why ? `${label}（${why}）` : label;
      },
      // 一題最終送出的答案字串。選擇題除了選項外還有一個補充框（可寫選項以外的答案）：
      // 兩邊都填就併成「A（補充：…）」，只填補充就直接當答案 → 必答判定也吃這個結果。
      clarAnswerText(q) {
        const pick = String(this.answerFields[q.id] ?? '').trim();
        if (q.type !== 'choice') return pick;
        const extra = String(this.answerExtra[q.id] ?? '').trim();
        if (pick && extra) return `${pick}（補充：${extra}）`;
        return pick || extra;
      },
      async submitAnswer() {
        // 結構化題目模式：改送 answers 物件（後端 Task 5 已支援），不再自己拼 Q1:／A1: 文字；
        // 無解析問題時（如 clarify_pending，AI 提問在時間軸）沿用單一留言框（舊 user_answer 契約）。
        if (this.clarBusy) return;
        let payload;
        if (this.clarQuestions.length) {
          if (!this.clarAllAnswered) return;
          // 只送看得見的題目：被 depends_on 收起來的題目不該把殘留輸入帶去給 AI
          const answers = {};
          this.clarVisible().forEach(q => { answers[q.id] = this.clarAnswerText(q); });
          payload = { answers };
        } else {
          const t = this.newMessageText.trim();
          if (!t) return;
          payload = { user_answer: t };
        }
        this.submitting = true;
        try {
          // 有夾帶檔案才改走 multipart：後端兩種都吃，但 JSON 路徑是既有行為，沒必要為沒附件的回覆換掉
          if (this.answerFiles.length) {
            const fd = new FormData();
            if (payload.answers) fd.append('answers', JSON.stringify(payload.answers));
            else fd.append('user_answer', payload.user_answer);
            this.answerFiles.forEach(f => fd.append('files', f));
            await Api.postForm(`tasks/${this.task.id}/answer`, fd);
          } else {
            await Api.post(`tasks/${this.task.id}/answer`, payload);
          }
          this.newMessageText = '';
          this.answerFiles = [];
          if (this.$refs.answerFileInput) this.$refs.answerFileInput.value = '';
          this.answerFields = {};
          this.answerExtra = {};
          showToast('回覆已送出，AI 正在確認', 'success');
          // 用 refresh 不用 load：load 會切 loading＝整個內容區被換成「載入中...」再重建，
          // 送出後畫面整塊消失一下、已展開的對話還被收回 5 筆，看起來就像當掉。
          // 這裡只要靜默換資料，再把對話釘到最新讓自己剛送出的內容看得到。
          this._convPinBottom = true;
          await this.refresh();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.submitting = false; }
      },
      async submitAsk() {
        const question = this.askText.trim();
        if (!question || this.clarBusy) return;
        this.askSubmitting = true;
        try {
          // 同 submitAnswer：有夾帶檔案才改走 multipart，沒附件時沿用既有 JSON 路徑
          if (this.askFiles.length) {
            const fd = new FormData();
            fd.append('question', question);
            this.askFiles.forEach(f => fd.append('files', f));
            await Api.postForm(`tasks/${this.task.id}/clarify-ask`, fd);
          } else {
            await Api.post(`tasks/${this.task.id}/clarify-ask`, { question });
          }
          this.askText = '';
          this.askFiles = [];
          if (this.$refs.askFileInput) this.$refs.askFileInput.value = '';
          showToast('已送出提問，任務不會往下跑', 'success');
          this._convPinBottom = true;   // 同 submitAnswer：靜默重抓，不整頁閃「載入中」
          await this.refresh();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.askSubmitting = false; }
      },
      async togglePause() {
        if (!this.task) return;
        try {
          const r = await Api.put(`tasks/${this.task.id}/pause`, {});
          this.task.is_paused = r.is_paused;
          showToast(r.is_paused ? '已取消本輪執行' : '已繼續執行', r.is_paused ? 'warn' : 'success');
          await this.loadMessages();
        } catch (err) { showToast(err.message, 'error'); }
      },
      startEditContent() {
        this.editText = this.task.original_text || '';
        this.editingContent = true;
      },
      cancelEditContent() { this.editingContent = false; },
      async saveContent() {
        if (!this.editText.trim()) return;
        this.savingContent = true;
        try {
          await Api.put(`tasks/${this.task.id}`, { original_text: this.editText });
          this.editingContent = false;
          showToast('內容已更新', 'success');
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.savingContent = false; }
      },
      async loadTaskMessages() {
        if (this.isTourDemo) { this.taskMessages = window.TourDemo.messages(); return; }
        try {
          this.taskMessages = await Api.get(`tasks/${this.$route.params.id}/messages`);
          // 初載完成後貼底看最新（此時 logs 已載入、conv-panel 確定已掛載，補上 watch 首次時序可能落空的貼底）
          if (this._convPinBottom !== false) this.$nextTick(() => this.scrollConvToBottom());
        } catch { /* best-effort */ }
      },
      autoResize(event) {
        const el = event.currentTarget;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
      },
      // 截圖直接貼上：畫面類問題用截圖說明比打字快，而下游只讀得到程式碼 diff。
      // target 指定塞進哪個附件清單——這一頁的回答／提問／退回／留言各有各的。
      onPasteFiles(event, target) {
        const files = Array.from((event.clipboardData || {}).files || []).filter((f) => /^image\//.test(f.type));
        if (!files.length) return;
        event.preventDefault();
        const list = this[target];
        if (!Array.isArray(list)) return;
        files.forEach((f) => { if (f.size <= 10 * 1024 * 1024 && list.length < 5) list.push(f); });
      },
      async sendTaskMessage() {
        if (!this.newMessageText.trim()) return;
        this.sendingMessage = true;
        try {
          const fd = new FormData();
          fd.append('content', this.newMessageText.trim());
          fd.append('writeback', this.messageWriteback ? 'true' : 'false');
          this.newMessageFiles.forEach(f => fd.append('files', f));
          await Api.postForm(`tasks/${this.task.id}/messages`, fd);
          this.newMessageText = '';
          this.newMessageFiles = [];
          if (this.$refs.messageFileInput) this.$refs.messageFileInput.value = '';
          await this.loadTaskMessages();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.sendingMessage = false; }
      },
      onMessageFilesSelected(e) {
        this.newMessageFiles = Array.from(e.target.files || []);
      },
      onAnswerFilesSelected(e) {
        this.answerFiles = Array.from(e.target.files || []);
      },
      onAskFilesSelected(e) {
        this.askFiles = Array.from(e.target.files || []);
      },
      formatSize(bytes) {
        if (!bytes) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(1) + ' MB';
      },
      async downloadAttachment(attId, filename) {
        try {
          const res = await fetch(`${BASE_PATH}api/tasks/${this.task.id}/attachments/${attId}/download`, {
            headers: { Authorization: `Bearer ${Api.getToken()}` }
          });
          if (!res.ok) {
            // 後端對空檔/找不到會回 JSON 錯誤訊息，讀出來讓使用者知道真因
            const msg = await res.json().then(j => j.error).catch(() => '下載失敗');
            throw new Error(msg || '下載失敗');
          }
          const blob = await res.blob();
          if (!blob.size) throw new Error('此附件無內容（0 bytes），無法開啟');
          const url = URL.createObjectURL(blob);
          // 用 <a download> 觸發下載，保住原始檔名與副檔名；window.open(blobUrl) 會存成無副檔名亂數檔而打不開
          const a = document.createElement('a');
          a.href = url;
          a.download = filename || 'attachment';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        } catch (e) { showToast(e.message, 'error'); }
      },
      async toggleDiff() {
        if (this.diffOpen) { this.diffOpen = false; return; }
        this.diffError = '';
        if (!this.diffData) {
          this.diffLoading = true;
          try {
            this.diffData = await Api.get(`tasks/${this.task.id}/diff`);
          } catch (e) {
            this.diffError = e.message;
            this.diffLoading = false;
            return;
          }
          this.diffLoading = false;
        }
        this.diffOpen = true;
      },
      diffLines(diff) {
        return diff.split('\n').map(text => {
          let cls = '';
          if (text.startsWith('diff --git') || text.startsWith('index ') || text.startsWith('+++') || text.startsWith('---')) cls = 'diff-meta';
          else if (text.startsWith('@@')) cls = 'diff-hunk';
          else if (text.startsWith('+')) cls = 'diff-add';
          else if (text.startsWith('-')) cls = 'diff-del';
          return { text, cls };
        });
      },
      async approve() {
        if (!await confirmDialog({ title: '審核通過', message: '確定審核通過？這張任務會納入待上正式清單並更新文件；要真正在正式區生效，還要到專案頁按「🚀 上正式」。', confirmText: '確認通過' })) return;
        this.approving = true;
        try {
          await Api.post(`tasks/${this.task.id}/approve`, {});
          showToast('已審核通過，正在併入 ai-dev', 'success');
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.approving = false; }
      },
      // 單張任務健檢（admin）：建 run 後直接導去 /admin/health 盯它。結果的呈現刻意只留在健檢頁
      // 一處——同一份 finding 在兩個地方各畫一次，改判準時必然只有一邊跟上。
      async startHealthCheck() {
        this.healthChecking = true;
        try {
          const { runId } = await Api.post('admin/health-check/task', { taskDbId: this.task.id });
          this.$router.push('/admin/health?run=' + runId);
        } catch (e) {
          showToast(e.message, 'error');
          this.healthChecking = false;
        }
      },
      async downloadCodeZip() {
        this.downloadingZip = true;
        let url = null;
        try {
          const { blob, headers } = await Api.getBlob(`tasks/${this.task.id}/code-zip`);
          // header 於伺服器端編碼過（非 ASCII 檔名會生出無效 header）；解不開就當沒有，不擋下載。
          const readList = (name) => {
            try { return JSON.parse(decodeURIComponent(headers.get(name) || '')) || []; }
            catch { return []; }
          };
          url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${this.task.task_id}.zip`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          const entries = readList('X-Zip-Entries');
          const deleted = readList('X-Zip-Deleted');
          const stale = readList('X-Zip-Stale');
          // 覆蓋風險必須當下就講：stale＝這些檔在任務切點之後也被別人改過，直接覆蓋會蓋掉對方的改動；
          // deleted＝zip 表達不了刪除，不講的話正式區會永遠留著本該移除的檔。兩者都用警示色，不混在成功訊息裡。
          showToast(`已下載 ${entries.length} 個改動檔`, 'success');
          if (stale.length) {
            showToast(`⚠️ 這 ${stale.length} 個檔在本任務之後也被改過，覆蓋會蓋掉對方的改動：${stale.join('、')}`, 'error');
          }
          if (deleted.length) {
            showToast(`⚠️ 本任務刪除了這些檔，請自行到正式區移除：${deleted.join('、')}`, 'error');
          }
        } catch (e) { showToast(e.message, 'error'); }
        finally {
          // 撤銷必須晚於 click：過早撤掉會讓瀏覽器抓不到內容，下載靜默失敗。
          if (url) setTimeout(() => URL.revokeObjectURL(url), 10000);
          this.downloadingZip = false;
        }
      },
      async reject() {
        if (!this.rejectReason.trim()) return;
        this.rejecting = true;
        try {
          // 走 FormData 夾帶截圖：視覺類退回（本站佔 22%）用文字描述不清楚，而截圖是下游三關
          // （分診／respec／coding）唯一能看到「審核者實際看到什麼」的管道——它們讀的是 diff，看不到畫面。
          const fd = new FormData();
          fd.append('reason', this.rejectReason.trim());
          this.rejectFiles.forEach(f => fd.append('files', f));
          await Api.postForm(`tasks/${this.task.id}/reject`, fd);
          showToast('已退回，任務回到開發依原因修正', 'success');
          this.rejectReason = '';
          this.rejectFiles = [];
          if (this.$refs.rejectFileInput) this.$refs.rejectFileInput.value = '';
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.rejecting = false; }
      },
      onRejectFilesSelected(e) {
        this.rejectFiles = Array.from(e.target.files || []);
      },
      // MODE_B 規格審核閘門——確認規格沒問題，開始實作
      async specApprove() {
        if (!await confirmDialog({ title: '規格審核通過', message: '確定規格沒問題，開始實作？', confirmText: '開始實作' })) return;
        this.specApproving = true;
        try {
          await Api.post(`tasks/${this.task.id}/spec-approve`, {});
          showToast('規格審核通過，開始實作', 'success');
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.specApproving = false; }
      },
      // MODE_B 規格審核閘門——送出修改意見，交給 AI 依意見更新規格後回到審核頁
      async specRevise() {
        if (!this.specFeedback.trim()) return;
        this.specRevising = true;
        try {
          await Api.post(`tasks/${this.task.id}/spec-revise`, { feedback: this.specFeedback.trim() });
          showToast('已送出修改意見，AI 正在更新規格', 'success');
          this.specFeedback = '';
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.specRevising = false; }
      },
      sourceUrl() {
        if (!this.task) return null;
        const id = (this.task.task_id || '').match(/(\d+)$/)?.[1];
        if (!id) return null;
        if (this.task.source === 'odoo' && this.odooUrl)
          return `${this.odooUrl}/web#id=${id}&action=524&model=project.task&view_type=form`;
        if (this.task.source === 'service' && this.serviceUrl)
          return `${this.serviceUrl}/web?debug=0#action=114&cids=1&id=${id}&menu_id=87&model=service.question.feedback&view_type=form`;
        return null;
      },
      sourceLabel() {
        if (!this.task) return '';
        return this.task.source === 'odoo' ? 'Odoo' : this.task.source === 'service' ? 'eService' : this.task.source === 'manual' ? '手動增加' : this.task.source;
      },
      sourceBadgeClass() {
        if (!this.task) return 'src-badge src-default';
        if (this.task.source === 'odoo') return 'src-badge src-odoo';
        if (this.task.source === 'service') return 'src-badge src-service';
        return 'src-badge src-default';
      },
      roleClass(role) { if (role === 'blocker') return 'system is-blocker'; return role === 'ai' ? 'ai' : role === 'user' ? 'user' : 'system'; },
      roleLabel(role) { if (role === 'blocker') return '執行中斷'; return role === 'ai' ? 'AI' : role === 'user' ? '你' : '系統'; },
      // 時間軸項目來自 task_logs 沿用 roleClass；來自 task_messages 用 source 對應到既有 ai/user 泡泡樣式
      // （sync=外部進來的訊息，靠左走 ai 樣式；manual=你自己留言，靠右走 user 樣式，不新增 CSS class）
      timelineClass(item) {
        if (item.kind === 'log') return this.roleClass(item.role);
        return item.source === 'manual' ? 'user' : 'ai';
      },
      timelineMeta(item) {
        if (item.kind === 'log') return this.roleLabel(item.role);
        return item.source === 'manual' ? (item.author || '你') : '（同步）';
      },
      // 只有「使用者自己貼的」（右側 manual）長 LOG 才收合；AI／系統／同步訊息不收（本就該整理過）。
      // 判定＝內容命中 log 特徵 且 夠長（>8 行或 >400 字），啟發式，誤收成本僅多點一下展開。
      isErrorLog(item) {
        if (item.kind !== 'message' || item.source !== 'manual') return false;
        const c = item.content || '';
        if (c.length <= 400 && (c.match(/\n/g) || []).length + 1 <= 8) return false;
        return /Traceback \(most recent call last\)|File ".*", line \d+|^\s*at |\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\b(?:ERROR|WARNING|CRITICAL|Exception)\b|\bError:/m.test(c);
      },
      // 命中 registry 的機器輸入型訊息 → 回傳該收合成的那句人話，否則 null（照常整段顯示）。
      // 前綴與 role 都要對：只比前綴的話，使用者把那則整段複製、貼進提問框問「這是什麼意思」，
      // 他自己的發言（role='user'，同樣進 task_logs、同樣被映成 kind:'log'）會被折成 AI 的那句人話。
      machineLogHint(item) {
        if (item.kind !== 'log') return null;
        return window.machineLogHint(item.role, item.content);
      },
      logLineCount(item) { return (String(item.content || '').match(/\n/g) || []).length + 1; },
      toggleLog(key) { this.expandedLogs[key] = !this.expandedLogs[key]; },
      formatTime(ts) {
        if (!ts) return '';
        return new Date(ts).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      },
      renderTaskMessage(value) { return window.renderNextMarkdown(value); },
      handleTaskMessageClick(event) { return window.copyNextCode(event); },
      async archive() {
        this.archiving = true;
        try {
          const r = await Api.post(`tasks/${this.task.id}/archive`, {});
          // 封存會順帶把這張任務的碼從 testing 收回去（best-effort）。收不回來一定要講：
          // 靜默失敗的話，下一張任務併 testing 時才撞衝突，那時已經看不出是這次封存留下的
          (r && r.warnings || []).forEach(w => showToast(w, 'warn', 9000));
          showToast('任務已封存', 'success');
          this.$router.push('/');
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.archiving = false; }
      },
      recLabel(action) {
        // take_ours = merge 的目標分支（stage 2）、take_theirs = 被併入的來源分支（stage 3）。
        // 普通 merge：目標 testing、來源 task 分支。sync：目標 ai-dev（AI 的碼）、來源 main（工程師的碼）。
        const m = this.isSyncConflict
          ? { take_theirs: '取工程師版（main 新進）', take_ours: '取 AI 版（ai-dev 現況）', manual: '我自己手解' }
          : { take_theirs: '取新版（任務分支）', take_ours: '取舊版（testing 現況）', manual: '我自己手解' };
        return m[action] || action;
      },
      async submitConflictResolutions() {
        if (!this.conflictAllChosen) return;
        this.submittingConflicts = true;
        try {
          const resolutions = this.conflictItems.map(i => ({ repo: i.repo, file: i.file, action: this.conflictChoices[i.key] }));
          const r = await Api.post(`tasks/${this.task.id}/resolve-conflicts`, { resolutions });
          if (r && r.done) showToast('衝突已依裁決套用，繼續部署', 'success');
          else showToast('已套用；仍有選「手解」的檔，請在 Repo 解完後按下方「已手動解決」收尾', 'warn', 9000);
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.submittingConflicts = false; }
      },
      // 逐檔追問：問 AI，答覆塞進來源資料讓卡片即時顯示（不整頁 reload）；AI 改建議時同步 ★建議與 radio 預選
      async submitClarify(it) {
        const q = (this.clarifyText[it.key] || '').trim();
        if (!q || this.clarifying[it.key]) return;
        this.clarifying = { ...this.clarifying, [it.key]: true };
        try {
          const r = await Api.post(`tasks/${this.task.id}/merge-clarify`, { repo: it.repo, file: it.file, question: q });
          const cd = this.conflictData;
          const repoEntry = cd && Array.isArray(cd.repos) && cd.repos.find(x => x.repo === it.repo);
          if (repoEntry) {
            repoEntry.details = repoEntry.details || {};
            const d = repoEntry.details[it.file] = repoEntry.details[it.file] || {};
            d.qa = d.qa || [];
            d.qa.push({ q, a: r.answer });
            if (r.changed) { d.recommendation = r.recommendation; d.rationale = r.rationale; }
            this.task.merge_conflict_data = cd; // 觸發 conflictItems 重算
            if (r.changed) this.conflictChoices = { ...this.conflictChoices, [it.key]: r.recommendation };
          }
          this.clarifyText = { ...this.clarifyText, [it.key]: '' };
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.clarifying = { ...this.clarifying, [it.key]: false }; }
      },
      async markConflictResolved() {
        this.conflictResolving = true;
        try {
          const r = await Api.post(`tasks/${this.task.id}/mark-conflict-resolved`, {});
          showToast('衝突已標記為解決，可繼續更新正式', 'success');
          (r && r.warnings || []).forEach(w => showToast(w, 'warn', 9000));
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.conflictResolving = false; }
      },
      async csConfirm() {
        this.csConfirming = true;
        try {
          await Api.post(`tasks/${this.task.id}/cs-confirm`, {});
          showToast('回覆已確認送出，任務完成', 'success');
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.csConfirming = false; }
      },
      async csDataSubmit() {
        if (!this.csAllAnswered) return;
        this.csRetrying = true;
        try {
          // 只送「當前這輪」的問題答案——csAnswers 以問題文字為 key 且跨 refresh 累積，
          // 直接整包送會夾帶上一輪已答過的舊題（值被 refresh 清成空）→ 時間軸出現整塊空 A。
          const answers = {};
          this.csQuestions.forEach(q => { answers[q] = this.csAnswers[q] || ''; });
          await Api.post(`tasks/${this.task.id}/cs-data-submit`, { answers });
          this.csAnswers = {};
          showToast('已補充資料，重新送入分析', 'success');
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.csRetrying = false; }
      },
      // 客服回覆這關追問：送出後 cs 依「原問題＋前一版草稿＋這次追問」重新處理（修草稿／釐清後轉補資料或開發）
      async csFollowupSubmit() {
        if (this.csFollowingUp) return;
        if (!this.csFollowup.trim()) return;
        this.csFollowingUp = true;
        try {
          await Api.post(`tasks/${this.task.id}/cs-followup`, { note: this.csFollowup.trim() });
          showToast('已送出，客服正在重新處理', 'success');
          this.csFollowup = '';
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.csFollowingUp = false; }
      },
      handleCsEnter(idx) {
        const nextIdx = idx + 1;
        if (nextIdx < this.csQuestions.length) {
          const next = this.$refs['csInput_' + nextIdx];
          const el = Array.isArray(next) ? next[0] : next;
          if (el) el.focus();
        } else if (this.csAllAnswered) {
          this.csDataSubmit();
        }
      },
      // 分析澄清問題逐題填答：Enter 跳下一題，最後一題全答完則送出（Shift+Enter 換行由 .exact 放行）
      handleClarEnter(idx) {
        const nextIdx = idx + 1;
        if (nextIdx < this.clarQuestions.length) {
          const next = this.$refs['clarInput_' + nextIdx];
          const el = Array.isArray(next) ? next[0] : next;
          if (el) el.focus();
        } else if (this.clarAllAnswered) {
          this.submitAnswer();
        }
      },
      // 接在既有內容後面而不是覆蓋：使用者常是先打完自己的說明，才想到要指定回哪一關
      // 直接送出：這三句已經帶好分診 agent 要的判斷詞彙，填進框裡再讓人按一次沒有意義。
      // 若輸入框已有內容就併進去一起送（使用者可能想補充上下文）。
      async submitResolutionShortcut(text) {
        if (this.resolving) return;
        const cur = this.resolution.trim();
        this.resolution = cur ? `${cur}\n${text}` : text;
        await this.resolveBlocker();
      },
      async resolveBlocker() {
        if (!this.resolution.trim()) return;
        this.resolving = true;
        try {
          await Api.post(`tasks/${this.task.id}/resolve-blocker`, { resolution: this.resolution });
          this.resolution = '';
          showToast('已送出，從中斷處重試', 'success');
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.resolving = false; }
      },
      async checkInflight() {
        if (!this.task || this.isTourDemo) return;
        try {
          const data = await Api.get('pipeline/inflight');
          this.serverConfirmedRunning = (data.inflight || []).includes(this.task.id);
        } catch { this.serverConfirmedRunning = false; }
      },
      back() {
        // 原本一律回首頁——從任務列表點進來的人按「返回」會跑到問答頁，等於找不到路。
        // 帶回來時的頁籤；深連結（通知、分享網址）沒有 from，就退回預設清單。
        const from = this.$route.query.from;
        const tabs = ["needs_action", "pending", "paused", "all", "archived"];
        this.$router.push(tabs.includes(from) ? `/tasks?tab=${from}` : "/tasks");
      },
      async stepPipeline() {
        this.stepping = true;
        try {
          await Api.post('pipeline/step', {});
          showToast('已觸發推進，處理中…（進度即時更新）', 'info');
          await this.refresh();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.stepping = false; }
      },
      // 把後端標的灰階 ANSI（\x1b[90m…\x1b[0m，工具呼叫/回傳）包成預設收合的 <details>，其餘文字照常顯示；
      // 其他未知 ANSI code 直接丟棄。內容先 escape 再包 HTML，避免 tool input/output 帶 HTML 造成 XSS。
      ansiToHtml(s) {
        const raw = String(s == null ? '' : s);
        const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const wrapDim = chunk => {
          if (!chunk) return '';
          const lines = chunk.split('\n').length;
          // ▶ 保留：它是 <details> 的 disclosure 標記（summary 設 display:inline 會拿掉瀏覽器原生三角），
          // 不是操作按鈕；而且這裡是 JS 產生的 HTML 字串，塞不進 <ui-next-icon>，硬改成 inline SVG
          // 只是在一段有 XSS escape 契約的字串裡多埋一段標籤，換不到任何東西。
          // color 不可寫死 #888：深色模式下與 --code-bg 對比不足，改吃主題變數。
          return `<details style="display:inline"><summary style="cursor:pointer;user-select:none;color:var(--text-muted);display:inline">▶ 次要內容（${lines} 行）</summary><span style="opacity:.7">${esc(chunk)}</span></details>`;
        };
        let out = '', dim = false, last = 0, m;
        const re = /\x1b\[(\d+)m/g;
        while ((m = re.exec(raw))) {
          const chunk = raw.slice(last, m.index);
          if (chunk) out += dim ? wrapDim(chunk) : esc(chunk);
          if (m[1] === '90') dim = true;
          else if (m[1] === '0') dim = false;
          last = re.lastIndex;
        }
        const tail = raw.slice(last);
        if (tail) out += dim ? wrapDim(tail) : esc(tail);
        return out;
      },
      scrollEventsToBottom() { const c = this.$refs.eventsBox; if (c) c.scrollTop = c.scrollHeight; },
      eventSummary(event) { const text = String(event.content || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '執行輸出'; return text.length > 160 ? `${text.slice(0, 160)}…` : text; },
      eventKind(event) { const text = String(event.content || ''); return /(?:❌|error|failed|失敗|錯誤)/i.test(text) ? 'error' : /(?:▶|start|開始|執行)/i.test(text) ? 'stage' : 'output'; },
      toggleEvent(event) { const key = event.id || event.content; this.expandedEvents[key] = !this.expandedEvents[key]; },
      scrollConvToBottom() { const c = this._convScroller || document.querySelector(".ui-next-main"); if (c) c.scrollTop = c.scrollHeight; },
      // 捲到頂→載入更早，並補回捲動位移讓畫面不跳（新內容撐高後維持原本閱讀點）
      loadMoreConv() {
        const c = this._convScroller || document.querySelector(".ui-next-main");
        const prevH = c ? c.scrollHeight : 0;
        this.convVisible += 10;
        this.$nextTick(() => { if (c) c.scrollTop += c.scrollHeight - prevH; });
      },
      // 捲軸統一在最外面之後，實際在捲的是 .ui-next-main；綁在對話清單上不會觸發。
      bindConvScroll() {
        this._convScroller = document.querySelector('.ui-next-main');
        if (!this._convScroller || this._onConvScrollBound) return;
        this._onConvScrollBound = () => this.onConvScroll({ target: this._convScroller });
        this._convScroller.addEventListener('scroll', this._onConvScrollBound, { passive: true });
      },
      unbindConvScroll() {
        if (this._convScroller && this._onConvScrollBound) {
          this._convScroller.removeEventListener('scroll', this._onConvScrollBound);
          this._onConvScrollBound = null;
        }
      },
      onConvScroll(e) {
        const el = e.target;
        // 跟隨使用者位置：停在底部→維持釘住（新訊息貼底）；往上捲→解除釘住
        this._convPinBottom = (el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        const list = this.$refs.convPanel;
        const listTop = list ? list.getBoundingClientRect().top : 999;
        if (listTop > -8 && this.hasMoreConv) this.loadMoreConv();
      },
      async loadEvents() {
        if (this.isTourDemo) { this.events = window.TourDemo.events(); this.eventsHasMore = false; return; }
        this.eventsError = '';
        try {
          const rows = await Api.get(`tasks/${this.$route.params.id}/events?limit=10`);
          this.events = Array.isArray(rows) ? rows : [];
          this.eventsHasMore = this.events.length >= 10;
          this.$nextTick(() => this.scrollEventsToBottom());
        } catch (error) { this.eventsError = error.message || '無法載入執行歷程'; }
      },
      async loadOlderEvents() {
        if (this.eventsLoading || !this.eventsHasMore) return;
        const oldest = this.events.find(e => e.id);
        if (!oldest) return;
        this.eventsLoading = true;
        const c = this.$refs.eventsBox;
        const prevHeight = c ? c.scrollHeight : 0;
        try {
          const rows = await Api.get(`tasks/${this.$route.params.id}/events?limit=10&before=${oldest.id}`);
          const older = Array.isArray(rows) ? rows : [];
          this.eventsHasMore = older.length >= 10;
          this.events = [...older, ...this.events];
          this.$nextTick(() => { if (c) c.scrollTop = c.scrollHeight - prevHeight; }); // 維持捲動位置
        } catch (error) { this.eventsError = error.message || '無法載入更早的執行歷程'; }
        finally { this.eventsLoading = false; }
      },
      onEventsScroll(e) { if (e.target.scrollTop <= 4) this.loadOlderEvents(); }
    },
    template: `
      <section class="ui-next-page ui-next-task-detail">
<div v-if="loading" class="ui-next-loading-card">載入任務中…</div>
<div v-else-if="error" class="ui-next-loading-card ui-next-error-text">{{ error }}</div>
<template v-else-if="task">
<header class="ui-next-page-head ui-next-detail-head">
<div>
<h1>{{ task.title || task.task_id }}</h1>
</div>
<div class="ui-next-detail-actions">
<button v-if="testMode" @click="stepPipeline" :disabled="stepping">{{ stepping?'執行中…':'推進 Pipeline' }}</button>
<button v-if="task.status!=='stopped'&&task.status!=='done'" @click="togglePause">{{ task.is_paused?'恢復任務':'暫停任務' }}</button>
<button v-if="task.env_status" @click="openEnv">測試機</button>
<button v-if="isAdmin&&!isTourDemo" @click="startHealthCheck" :disabled="healthChecking">{{ healthChecking?'健檢中…':'任務健檢' }}</button>
<button v-if="isAdmin&&task.git_branch" @click="downloadCodeZip" :disabled="downloadingZip">{{ downloadingZip?'打包中…':'下載程式碼' }}</button>
<button v-if="isAdmin&&task.status==='done'&&!task.is_hidden" @click="archive" :disabled="archiving">{{ archiving?'封存中…':'封存' }}</button>
<button class="ui-next-back" @click="back"><ui-next-icon name="arrow-left"/> 返回</button>
</div>
</header>
<div class="ui-next-task-badges">
<span class="is-id">{{ task.task_id }}</span>
<span>最後更新 {{ formatTime(task.updated_at) }}</span>
<span :class="['ui-next-status-badge',task.status]">{{ statusLabel }}</span>
<span v-if="serverConfirmedRunning" class="is-live">處理中</span>
<a v-if="sourceUrl()" :href="sourceUrl()" target="_blank" :class="sourceBadgeClass()">{{ sourceLabel() }}</a>
<span v-else :class="sourceBadgeClass()">{{ sourceLabel() }}</span>
<span v-if="task.stage_label">{{ task.stage_label }}</span>
<span v-if="task.classification_label">分類：{{ task.classification_label }}</span>
<span v-if="task.has_attachment">含附件</span>
<span v-if="task.module">{{ task.module }}</span>
<span v-if="task.created_at">建立 {{ formatTime(task.created_at) }}</span>
</div>
<div class="ui-next-task-tabs" role="tablist" aria-label="任務詳情">
<button id="ui-next-task-tab-requirements" role="tab" :aria-selected="taskTab==='requirements'" :tabindex="taskTab==='requirements'?0:-1" @click="setTaskTab('requirements')">需求內容</button>
<button id="ui-next-task-tab-conversation" role="tab" :aria-selected="taskTab==='conversation'" :tabindex="taskTab==='conversation'?0:-1" @click="setTaskTab('conversation')">對話</button>
<button id="ui-next-task-tab-history" role="tab" :aria-selected="taskTab==='history'" :tabindex="taskTab==='history'?0:-1" @click="setTaskTab('history')">執行歷程</button>
</div>
<div class="ui-next-task-detail-grid" :class="'is-tab-'+taskTab">
<div class="ui-next-task-content-column">
<section v-show="taskTab==='requirements'" tabindex="-1" class="ui-next-panel ui-next-task-summary" role="tabpanel" aria-labelledby="ui-next-task-tab-requirements">

<div class="ui-next-card-title">
<button v-if="canEditContent&&!editingContent" @click="startEditContent">編輯</button>
</div>
<p v-if="!editingContent" class="ui-next-task-content">{{ task.original_text || '（無內容）' }}</p>
<div v-else>
<textarea v-model="editText" @input="autoResize">
</textarea>
<div class="ui-next-inline-actions">
<button class="ui-next-primary" @click="saveContent" :disabled="savingContent||!editText.trim()">{{ savingContent?'儲存中…':'儲存' }}</button>
<button @click="cancelEditContent">取消</button>
</div>
</div>
<div v-if="ticketAttachments.length" class="ui-next-ticket-files">
<b>主附件</b>
<button v-for="file in ticketAttachments" :key="file.id" @click="downloadAttachment(file.id,file.filename)"><ui-next-icon name="download"/> {{ file.filename }} <small v-if="file.size">{{ formatSize(file.size) }}</small>
</button>
</div>
</section>
<section v-show="taskTab==='conversation'" tabindex="-1" class="ui-next-panel ui-next-conversation" role="tabpanel" aria-labelledby="ui-next-task-tab-conversation">
<div ref="convPanel" class="ui-next-conv-list" @click="handleTaskMessageClick">
<button v-if="hasMoreConv" @click="loadMoreConv">載入更早的對話（{{ timeline.length-convVisible }}）</button>
<article v-for="item in visibleTimeline" :key="item._key" :class="timelineClass(item)">
<!-- 錯誤 LOG 與機器 log 分開標示：兩者合併成一句「技術紀錄」時，畫面上看不出這則是不是錯誤，
     而使用者貼的錯誤訊息正是最需要一眼認出來的那種。 -->
<template v-if="isErrorLog(item)">
<button @click="toggleLog(item._key)">{{ expandedLogs[item._key]?'收合':'展開' }} 錯誤 LOG（{{ logLineCount(item) }} 行）</button>
<pre v-if="expandedLogs[item._key]">{{ item.content }}</pre>
</template>
<template v-else-if="machineLogHint(item)">
<button @click="toggleLog(item._key)">{{ expandedLogs[item._key]?'收合':'展開' }} {{ machineLogHint(item) }}（技術細節 {{ logLineCount(item) }} 行）</button>
<pre v-if="expandedLogs[item._key]">{{ item.content }}</pre>
</template>
<template v-else>
<div v-html="renderTaskMessage(item.content)"></div>
<div v-if="item.attachments&&item.attachments.length">
<button v-for="file in item.attachments" :key="file.id" @click="downloadAttachment(file.id,file.filename)"><ui-next-icon name="download"/> {{ file.filename }}</button>
</div>
</template>
<small>{{ timelineMeta(item) }} · {{ formatTime(item.ts) }}</small>
</article>
<p v-if="!timeline.length" class="ui-next-empty-state">尚無對話記錄。</p>
</div>
</section>
<section v-show="taskTab==='history'" tabindex="-1" class="ui-next-panel ui-next-events" role="tabpanel" aria-labelledby="ui-next-task-tab-history">
<div ref="eventsBox" @scroll="onEventsScroll">
<button v-if="eventsLoading" type="button" disabled>載入較早紀錄中…</button>
<p v-if="events.length&&!eventsHasMore">— 已到最前 —</p>
<article v-for="event in events" :key="event.id||event.content" :class="['ui-next-event-summary',eventKind(event),{'is-open':!!expandedEvents[event.id||event.content]}]">
<button type="button" :aria-expanded="!!expandedEvents[event.id||event.content]" @click="toggleEvent(event)"><span>{{ eventKind(event)==='error' ? '錯誤' : eventKind(event)==='stage' ? '階段' : '輸出' }}</span><b>{{ eventSummary(event) }}</b><time v-if="event.created_at">{{ formatTime(event.created_at) }}</time></button>
<pre v-if="expandedEvents[event.id||event.content]" v-html="ansiToHtml(event.content)"></pre>
</article>
<p v-if="eventsError" class="ui-next-inline-error" role="alert">{{ eventsError }} <button type="button" @click="loadEvents">重試</button></p>
<p v-else-if="!events.length">尚無執行輸出。</p>
</div>
</section>
</div>
<aside v-show="taskTab==='conversation'&&timelineActionMode!=='archive'" class="ui-next-task-side">
<section class="ui-next-panel ui-next-task-action">
<h2>{{ actionModeLabel }}</h2>
<template v-if="timelineActionMode==='answer'">
<p v-if="clarIntro">{{ clarIntro }}</p>
<template v-if="clarQuestions.length">
<!-- 「提問」頁籤是問清楚再答的唯一入口：少了它，看不懂題目的人只能硬答或把任務卡在這一關。 -->
<div class="ui-next-detail-tabs">
<button :class="{active:clarTab==='qa'}" @click="clarTab='qa'">規格書 QA</button>
<button :class="{active:clarTab==='ask'}" @click="clarTab='ask'">提問</button>
</div>
<p v-if="clarBusy" class="ui-next-field-note">AI 正在回覆，稍候一下…</p>
<template v-if="clarTab==='qa'">
<!-- 送出後任務轉 clarify_chat_running：整組題目收起來換成這張卡。只把按鈕 disable 的話，
     空白的答案框留在原地，看起來像根本沒送出去。 -->
<div v-if="clarBusy" class="ui-next-help-box">
<b>回覆已送出，AI 正在確認…</b>
<p>AI 判斷後會回到這裡：可能直接往下跑，或把問題更新後再請你補答。</p>
</div>
<template v-else>
<div v-for="(q,index) in clarVisible()" :key="q.id" class="ui-next-question">
<b>{{ index+1 }}. {{ q.text }}<template v-if="!q.required"> · 選填</template></b>
<!-- 選錯的代價用標記呈現，不寫進題目文字。只標 costly，reversible 不渲染——沒有標記＝不必特別小心。 -->
<span v-if="q.impact==='costly'" class="ui-next-warning-text" title="這題選錯要退回重寫規格與程式，請多看一眼">選錯難改</span>
<!-- AI 的建議答案：只有它推導得出依據的題目才有，純偏好題刻意留空＝這一行不渲染 -->
<span v-if="clarRecommend(q)">建議：{{ clarRecommend(q) }}</span>
<template v-if="q.type==='choice'">
<label v-for="opt in q.options" :key="opt.key">
<input type="radio" :name="'answer_'+q.id" :value="opt.key" v-model="answerFields[q.id]"> {{ opt.label }}<template v-if="q.recommended===opt.key"> ★建議</template></label>
<textarea v-model="answerExtra[q.id]" placeholder="以上選項都不合適？也可以直接寫你的答案或補充說明" @input="autoResize">
</textarea>
</template>
<textarea v-else v-model="answerFields[q.id]" :ref="'clarInput_'+index" placeholder="輸入回答…（Enter 跳下題／送出，Shift+Enter 換行）" @keydown.enter.exact.prevent="handleClarEnter(index)" @input="autoResize" @paste="onPasteFiles($event,'answerFiles')">
</textarea>
</div>
<label class="ui-next-upload ui-next-upload-inline"><input ref="answerFileInput" type="file" multiple @change="onAnswerFilesSelected"><span class="ui-next-upload-drop"><ui-next-icon name="paperclip"/><b>附加截圖</b></span></label>
<p v-if="!clarAllAnswered" class="ui-next-error-text">還有必答的問題沒回答</p>
<button class="ui-next-primary" @click="submitAnswer" :disabled="submitting||clarBusy||!clarAllAnswered">{{ submitting?'送出中…':'送出回答' }}</button>
</template>
</template>
<template v-else>
<p class="ui-next-field-note">看不懂、要補充、或方向要改都在這裡講。問問題不會讓任務往下跑；談出結論時 AI 會順手把「規格書 QA」那頁的題目改成最新的。</p>
<textarea v-model="askText" :disabled="clarBusy" placeholder="例如：我測試好像正常，要怎麼重現這個情況？（Enter 送出，Shift+Enter 換行）" @keydown.enter.exact.prevent="submitAsk" @input="autoResize" @paste="onPasteFiles($event,'askFiles')">
</textarea>
<label class="ui-next-upload ui-next-upload-inline"><input ref="askFileInput" type="file" multiple @change="onAskFilesSelected"><span class="ui-next-upload-drop"><ui-next-icon name="paperclip"/><b>附加截圖</b></span></label>
<button class="ui-next-primary" @click="submitAsk" :disabled="clarBusy||askSubmitting||!askText.trim()">{{ askSubmitting?'送出中…':'送出提問' }}</button>
</template>
</template>
<template v-else>
<!-- 綁 newMessageText 而非 resolution：submitAnswer 的無解析題目分支讀的是 newMessageText
     （見本檔 submitAnswer 的 else 分支），resolution 是 blocker mode 的 resolveBlocker 在用。
     綁錯的後果是靜默失效——打字讓按鈕亮起，點下去在那個 "沒文字就 return" 的早退直接返回，
     沒有 toast、沒有錯誤，而 clarify_pending 狀態下這是唯一的回覆入口。 -->
<textarea v-model="newMessageText" placeholder="回答 AI 的問題或補充說明…（Enter 送出，Shift+Enter 換行，可直接貼上截圖）" @keydown.enter.exact.prevent="submitAnswer" @input="autoResize" @paste="onPasteFiles($event,'newMessageFiles')">
</textarea>
<!-- 停在這個閘門時留言框與退回框都被本面板取代，這裡是唯一能補圖的地方 -->
<p class="ui-next-field-note">可附圖說明（截圖上標註比打字快，AI 這一關讀得到）</p>
<label class="ui-next-upload ui-next-upload-inline"><input ref="answerFileInput" type="file" multiple @change="onAnswerFilesSelected"><span class="ui-next-upload-drop"><ui-next-icon name="paperclip"/><b>附加截圖</b></span></label>
<button class="ui-next-primary" @click="submitAnswer" :disabled="submitting||!newMessageText.trim()">{{ submitting?'送出中…':'送出回答' }}</button>
</template>
</template>
<template v-else-if="timelineActionMode==='spec_review'">
<p>以下是 AI 分析出的規格，請確認沒問題後開始實作。下方可提問或要求調整規格：提問時 AI 會直接在時間軸回答、規格不變；判定要改時才重產規格再回到這裡。</p>
<div v-if="spec" class="ui-next-help-box ui-next-spec-box">
<template v-if="spec.summary">
<b>摘要</b>
<p>{{ spec.summary }}</p>
</template>
<template v-if="spec.module">
<b>模組</b>
<p><code>{{ spec.module }}</code></p>
</template>
<template v-if="spec.requirements&&spec.requirements.length">
<b class="ui-next-spec-toggle" @click="specReqOpen=!specReqOpen">{{ specReqOpen?'▾':'▸' }} 實作項（給 AI 的施工細節，共 {{ spec.requirements.length }} 項）</b>
<ul v-if="specReqOpen">
<li v-for="(item,index) in spec.requirements" :key="'req'+index">{{ item }}</li>
</ul>
</template>
<template v-if="spec.acceptance&&spec.acceptance.length">
<b>驗收項</b>
<ul>
<li v-for="(item,index) in spec.acceptance" :key="'acc'+index">{{ item }}</li>
</ul>
</template>
<!-- 權限是審核者唯一能看到「誰能用、能做什麼」的地方：不渲染就等於這一關沒得審，
     而下游 QA 的判準正是拿實作去比對這一段。 -->
<template v-if="spec.permissions&&spec.permissions.trim()">
<b>權限</b>
<p>{{ spec.permissions }}</p>
</template>
</div>
<p v-else>請確認規格後開始實作。</p>
<textarea v-model="specFeedback" placeholder="可提問或要求調整規格（例：為什麼備註欄唯讀？／備註欄位改成多行）。Enter 送出，Shift+Enter 換行" @keydown.enter.exact.prevent="specRevise" @input="autoResize">
</textarea>
<div class="ui-next-inline-actions">
<button @click="specRevise" :disabled="specRevising||!specFeedback.trim()">{{ specRevising?'送出中…':'要求調整' }}</button>
<button class="ui-next-primary" @click="specApprove" :disabled="specApproving">{{ specApproving?'處理中…':'確認開工' }}</button>
</div>
</template>
<template v-else-if="timelineActionMode==='review'">
<p v-if="diffError" class="ui-next-error-text">{{ diffError }}</p>
<!-- 逐行著色而非把所有 repo 併成一行：join(' | ') 的版本讀不出哪幾行是加、哪幾行是刪，
     而這一關要人決定的就是「這些改動能不能上」。 -->
<div v-if="diffOpen&&diffData">
<div v-for="repo in diffData.repos" :key="repo.label" class="ui-next-diff-repo">
<b>{{ repo.label }}</b>
<span v-if="repo.missing">分支已清理，無法取得 diff</span>
<span v-else-if="!repo.diff">此 repo 無變更</span>
<div v-else class="diff-view"><div v-for="(line,index) in diffLines(repo.diff)" :key="index" :class="['diff-line',line.cls]">{{ line.text }}</div></div>
<span v-if="repo.truncated">（diff 過大已截斷，完整內容請至 repo 檢視）</span>
</div>
</div>
<textarea v-model="rejectReason" placeholder="填寫退回原因，可一次列多個問題（Enter 送出，Shift+Enter 換行，可直接貼上截圖）" @keydown.enter.exact.prevent="reject" @input="autoResize" @paste="onPasteFiles($event,'rejectFiles')">
</textarea>
<div class="ui-next-action-foot">
<div class="ui-next-action-tools">
<label class="ui-next-icon-button" :title="'附加截圖（選填，最多 5 個）——下游只讀得到程式碼 diff，看不到畫面'"><ui-next-icon name="paperclip"/><input ref="rejectFileInput" type="file" multiple @change="onRejectFilesSelected"></label>
<button type="button" class="ui-next-icon-button" :class="{active:diffOpen}" :disabled="diffLoading" :aria-label="diffOpen?'收合程式變更':'查看程式變更'" :title="diffOpen?'收合程式變更':'查看程式變更'" @click="toggleDiff"><ui-next-icon name="flow"/></button>
<small v-if="rejectFiles.length">已選 {{ rejectFiles.length }} 個附件</small>
</div>
<div class="ui-next-inline-actions">
<button @click="reject" :disabled="rejecting||!rejectReason.trim()">{{ rejecting?'退回中…':'退回修正' }}</button>
<button class="ui-next-primary" @click="approve" :disabled="approving">{{ approving?'處理中…':'審核通過' }}</button>
</div>
</div>
</template>
<template v-else-if="timelineActionMode==='conflict'">
<!-- 重建 testing 造成的衝突沒有逐檔資料可裁決，硬導進裁決流程會讓人對著空清單無事可做 → 分流到手解收尾。 -->
<template v-if="conflictItems.length&&!isRebuildConflict">
<p>自動合併有 {{ conflictItems.length }} 個檔需要你決定。每個檔已附原因與 AI 建議（預設已選建議），確認後送出即可。</p>
<p v-if="isSyncConflict" class="ui-next-field-note">這張任務開工前要把 main 上工程師改的程式拉進來，但和 AI 已改過的地方撞到了。裁決完會回到分析重跑，不會直接進部署。</p>
<div v-for="(item,index) in conflictItems" :key="item.key" class="ui-next-question">
<b>{{ index+1 }}. {{ item.repo }} / {{ item.file }}</b>
<template v-if="item.detail">
<span>衝突型態：{{ item.detail.classification }}</span>
<span v-if="item.detail.reason">原因：{{ item.detail.reason }}</span>
<span v-if="item.detail.rationale">AI 建議：{{ recLabel(item.detail.recommendation) }} — {{ item.detail.rationale }}</span>
</template>
<span v-else>（無法自動分析此檔，請自行判斷或選「我自己手解」）</span>
<label v-for="choice in ['take_theirs','take_ours','manual']" :key="choice">
<input type="radio" :name="'conflict_'+index" :value="choice" v-model="conflictChoices[item.key]"> {{ recLabel(choice) }}<template v-if="item.detail&&item.detail.recommendation===choice"> ★建議</template>
</label>
<!-- 追問區：非工程師看不懂衝突時先問 AI，問清楚再裁決（有結構化 detail 才問得出東西） -->
<template v-if="item.detail">
<div v-for="(qa,qi) in (item.detail.qa||[])" :key="qi">
<b>你：{{ qa.q }}</b>
<span>AI：{{ qa.a }}</span>
</div>
<span>不確定怎麼選？可以先問 AI，問清楚再決定。</span>
<textarea v-model="clarifyText[item.key]" placeholder="看不懂這個衝突？問問看，例如：這兩個版本差在哪？我選「取新版」會失去什麼？">
</textarea>
<button @click="submitClarify(item)" :disabled="clarifying[item.key]||!(clarifyText[item.key]||'').trim()">{{ clarifying[item.key]?'思考中…':'送出追問' }}</button>
</template>
</div>
<button class="ui-next-primary" @click="submitConflictResolutions" :disabled="submittingConflicts||!conflictAllChosen">{{ submittingConflicts?'處理中…':'送出裁決，繼續' }}</button>
</template>
<template v-else>
<p v-if="task.blocker_content" class="ui-next-error-text">{{ task.blocker_content }}</p>
<p>自動合併失敗，請手動在 Repo 解決 Git 衝突後，點擊下方按鈕繼續。</p>
<button class="ui-next-primary" @click="markConflictResolved" :disabled="conflictResolving">{{ conflictResolving?'處理中…':'已手動解決衝突，繼續' }}</button>
</template>
<!-- 與裁決卡片並存而非互斥：選了「我自己手解」的檔沒有這顆按鈕就沒有任何收尾入口。 -->
<button v-if="conflictItems.length&&!isRebuildConflict" @click="markConflictResolved" :disabled="conflictResolving">{{ conflictResolving?'處理中…':'已在 Repo 手動解完剩餘檔，收尾繼續' }}</button>
</template>
<template v-else-if="timelineActionMode==='cs_reply'">
<div v-if="task.cs_reply" class="ui-next-help-box">{{ task.cs_reply }}</div>
<textarea v-model="csFollowup" placeholder="確認回覆內容後按「確認結案」；要調整就在這裡追問（例：客戶用的是 17.0／回覆再客氣些）" @keydown.enter.exact.prevent="csFollowupSubmit">
</textarea>
<div class="ui-next-inline-actions">
<button @click="csFollowupSubmit" :disabled="csFollowingUp||!csFollowup.trim()">送出</button>
<button class="ui-next-primary" @click="csConfirm" :disabled="csConfirming">確認結案</button>
</div>
</template>
<template v-else-if="timelineActionMode==='cs_data'">
<div v-for="(question,index) in csQuestions" :key="index" class="ui-next-question">
<b>{{ index+1 }}. {{ question }}</b>
<!-- ref 與 handleCsEnter 成對：少了 ref，Enter 找不到下一題的元素就靜默什麼都不做 -->
<textarea v-model="csAnswers[question]" :ref="'csInput_'+index" :placeholder="'請填寫第 '+(index+1)+' 題…（Enter 跳下題'+(index===csQuestions.length-1?'／送出':'')+'，Shift+Enter 換行）'" @keydown.enter.exact.prevent="handleCsEnter(index)">
</textarea>
</div>
<p v-if="!csAllAnswered" class="ui-next-error-text">請填寫所有問題才能送出</p>
<button class="ui-next-primary" @click="csDataSubmit" :disabled="csRetrying||!csAllAnswered">{{ csRetrying?'處理中…':'送出補充資料，重新分析' }}</button>
</template>
<template v-else-if="timelineActionMode==='blocker'">
<p v-if="!task.blocker_content" class="ui-next-error-text">任務分診失敗或執行中斷</p>
<textarea v-model="resolution" placeholder="例：改用報表方式呈現，不需要新增欄位；或：忽略該錯誤，直接繼續…（Enter 送出，Shift+Enter 換行）" @keydown.enter.exact.prevent="resolveBlocker">
</textarea>
<div class="ui-next-action-foot">
<div class="ui-next-inline-actions ui-next-shortcut-row">
<button v-for="shortcut in blockerShortcuts" :key="shortcut.label" :title="shortcut.text" :disabled="resolving" @click="submitResolutionShortcut(shortcut.text)">{{ shortcut.label }}</button>
</div>
<div class="ui-next-inline-actions">
<button class="ui-next-primary" @click="resolveBlocker" :disabled="resolving||!resolution.trim()">{{ resolving?'處理中…':'從中斷處繼續' }}</button>
</div>
</div>
</template>
<template v-else>
<!-- 執行中卻被別張任務的同步衝突擋住：狀態沒變（仍是分析中），原因不秀出來就會靜默卡好幾天。
     只認 sync_wait，避免把「分診中」等狀態殘留的上次停下原因也當成當前錯誤秀出來。 -->
<p v-if="task.blocker_type==='sync_wait'&&task.blocker_content" class="ui-next-error-text">{{ task.blocker_content }}</p>
<textarea v-model="newMessageText" placeholder="新增留言…（Enter 送出，Shift+Enter 換行，可直接貼上截圖）" @keydown.enter.exact.prevent="sendTaskMessage">
</textarea>
<!-- ref 對應 sendTaskMessage 送出後的 value 清空；沒有 ref 那行清空是死碼，
     檔名會留在欄位裡看起來像又要再送一次。 -->
<label class="ui-next-upload ui-next-upload-inline">
<input ref="messageFileInput" type="file" multiple @change="onMessageFilesSelected">
<span class="ui-next-upload-drop"><ui-next-icon name="paperclip"/><b>附加檔案</b></span>
</label>
<div v-if="newMessageFiles.length" class="ui-next-upload-list">
<span v-for="(file,index) in newMessageFiles" :key="file.name+file.size+index" class="ui-next-file-preview"><ui-next-icon name="paperclip"/><em>{{ file.name }}</em></span>
</div>
<label v-if="showWritebackOption">
<input type="checkbox" v-model="messageWriteback"> 同步回寫至來源</label>
<!-- disabled 只看文字，與 sendTaskMessage 第一行那個 "沒文字就 return" 的早退對齊。
     原本額外放行「只選了檔案」的情況，按鈕會亮但點下去被那行擋掉，靜默什麼都不發生。 -->
<div class="ui-next-action-foot">
<small v-if="isAgentRunning" class="ui-next-running-hint">AI 正在處理這一輪…</small>
<span v-else></span>
<div class="ui-next-inline-actions">
<button v-if="isAgentRunning" class="ui-next-stop" @click="togglePause"><ui-next-icon name="close"/>停止</button>
<button class="ui-next-primary" @click="sendTaskMessage" :disabled="sendingMessage||!newMessageText.trim()">{{ sendingMessage?'送出中…':'送出留言' }}</button>
</div>
</div>
</template>
</section>
</aside>
</div>
</template>
</section>`,
  });

  window.UiNextSettingsView = Vue.defineComponent({
    name: "UiNextSettingsView",
    components: { UiNextIcon: window.UiNextIcon },
    data() { return { me: { username: "", display_name: "" }, teamsUserId: "", savedSettings: {}, creds: { odoo_username: "", odoo_password: "", odoo_user_id: "", service_username: "", service_password: "", service_user_id: "" }, pwSet: { odoo: false, service: false }, pw: { current: "", next: "", confirm: "" }, pwError: "", loading: true, loadError: "", saving: false, savingPw: false, verifyingOdoo: false, verifyingService: false, isDark: window.ThemeManager?.current() === "dark", notifyOn: window.NotifyManager?.isOn(), githubPat: { input: "", configured: false, login: "", saving: false } }; },
    computed: { patLink() { return "https://github.com/settings/tokens/new?scopes=repo&description=aidev-platform"; }, pwValidation() { if (!this.pw.current) return "請輸入目前密碼"; if (this.pw.next.length < 8) return "新密碼至少 8 個字元"; return this.pw.next === this.pw.confirm ? "" : "兩次輸入的新密碼不一致"; } },
    async created() { await this.load(); },
    mounted() { this._onThemeChange = (event) => { this.isDark = event.detail === "dark"; }; window.addEventListener("themechange", this._onThemeChange); },
    unmounted() { window.removeEventListener("themechange", this._onThemeChange); },
    methods: {
      toggleTheme() { window.ThemeManager?.toggle(); },
      async toggleNotify(event) { if (event.target.checked) { const result = await window.NotifyManager?.enable(); this.notifyOn = !!result?.ok; if (!this.notifyOn) showToast(result?.reason === "denied" ? "瀏覽器已封鎖通知權限" : "此瀏覽器不支援通知", "error", 0); } else { window.NotifyManager?.disable(); this.notifyOn = false; } },
      async load() { this.loading = true; this.loadError = ""; try { const [me, settings, pat] = await Promise.all([Api.get("auth/me"), Api.get("settings"), Api.get("settings/github-pat")]); this.me = { username: me.username || "", display_name: me.display_name || "" }; const saved = settings.odoo_settings || {}; this.savedSettings = saved; this.teamsUserId = saved.teams_user_id || ""; Object.assign(this.creds, { odoo_username: saved.odoo_username || "", odoo_user_id: saved.odoo_user_id || "", odoo_password: "", service_username: saved.service_username || "", service_user_id: saved.service_user_id || "", service_password: "" }); this.pwSet = { odoo: !!saved.odoo_password_set, service: !!saved.service_password_set }; this.githubPat.configured = !!pat.configured; this.githubPat.login = pat.login || ""; } catch (error) { this.loadError = error.message || "無法載入設定"; showToast(this.loadError, "error", 0); } finally { this.loading = false; } },
      async save() { this.saving = true; try { const odoo_settings = { ...this.savedSettings, teams_user_id: this.teamsUserId, ...this.creds, theme: window.ThemeManager?.current() }; await Promise.all([Api.put("auth/me", { display_name: this.me.display_name }), Api.put("settings", { odoo_settings })]); showToast("設定已儲存", "success"); } catch (error) { showToast(error.message || "儲存設定失敗", "error", 0); } finally { this.saving = false; } },
      async savePw() { this.pwError = this.pwValidation; if (this.pwError) return; this.savingPw = true; try { await Api.put("auth/me", { current_password: this.pw.current, new_password: this.pw.next }); this.pw = { current: "", next: "", confirm: "" }; showToast("密碼已更新", "success"); } catch (error) { showToast(error.message || "密碼更新失敗", "error", 0); } finally { this.savingPw = false; } },
      async verifyOdoo() { if (!this.creds.odoo_username || (!this.creds.odoo_password && !this.pwSet.odoo)) return showToast("請先填寫 Odoo 帳號和密碼", "error"); this.verifyingOdoo = true; try { const { uid } = await Api.post("settings/verify-odoo", { odoo_username: this.creds.odoo_username, odoo_password: this.creds.odoo_password }); this.creds.odoo_user_id = String(uid); showToast(`驗證成功，使用者 ID：${uid}`, "success"); } catch (error) { showToast(error.message || "驗證失敗", "error", 0); } finally { this.verifyingOdoo = false; } },
      async verifyService() { if (!this.creds.service_username || (!this.creds.service_password && !this.pwSet.service)) return showToast("請先填寫 eService 帳號和密碼", "error"); this.verifyingService = true; try { const { uid } = await Api.post("settings/verify-service", { service_username: this.creds.service_username, service_password: this.creds.service_password }); this.creds.service_user_id = String(uid); showToast(`驗證成功，使用者 ID：${uid}`, "success"); } catch (error) { showToast(error.message || "驗證失敗", "error", 0); } finally { this.verifyingService = false; } },
      // NotifyManager.show() 在權限未授權時是靜默 no-op，所以直接呼叫它等於「按了沒反應」。
      // 三個擋下的原因各自要能被使用者看見並知道怎麼解，否則使用者只會回報「通知壞了」。
      testNotify() { const perm = window.Notification ? Notification.permission : "unsupported"; if (perm === "denied") return showToast("瀏覽器已封鎖此網站的通知，請至瀏覽器設定 → 網站通知 → 解除封鎖後重新整理", "error", 8000); if (perm === "default") return showToast("尚未授權通知，請先開啟通知開關", "error", 6000); if (!window.NotifyManager?.enabled()) return showToast("通知未啟用（localStorage 已停用）", "error", 6000); window.NotifyManager.show("測試通知", "桌面通知運作正常 ✓", "test"); showToast("測試通知已發送", "success"); },
      async saveGithubPat() { if (!this.githubPat.input.trim()) return showToast("請貼上 PAT", "error"); this.githubPat.saving = true; try { const result = await Api.post("settings/github-pat", { pat: this.githubPat.input.trim() }); this.githubPat.configured = true; this.githubPat.login = result.login; this.githubPat.input = ""; showToast(`已連結 GitHub 帳號 ${result.login}`, "success"); } catch (error) { showToast(error.message || "PAT 驗證失敗", "error", 0); } finally { this.githubPat.saving = false; } },
      async removeGithubPat() { if (!await confirmDialog({ title: "移除 GitHub PAT", message: "移除後你的任務將無法 push，直到重新設定。", danger: true, confirmText: "移除" })) return; try { await Api.delete("settings/github-pat"); this.githubPat.configured = false; this.githubPat.login = ""; showToast("已移除 GitHub PAT", "success"); } catch (error) { showToast(error.message || "移除失敗", "error", 0); } },
    },
    template: `
      <section class="ui-next-page ui-next-settings-page">
<header class="ui-next-page-head">
<div>
<p class="ui-next-eyebrow">帳號與設定</p>
<h1>個人設定</h1>
<p>管理帳號、通知、GitHub 與外部系統連線。</p>
</div>
</header>
<div v-if="loading" class="ui-next-loading-card">載入設定中…</div>
<div v-else-if="loadError" class="ui-next-loading-card ui-next-error-text">{{ loadError }} <button type="button" @click="load">重試</button></div>
<div v-else class="ui-next-settings-grid">
<section class="ui-next-panel">
<h2>外觀與通知</h2>
<label class="ui-next-toggle" data-tour="set-dark">
<input type="checkbox" :checked="isDark" @change="toggleTheme">
<span>
</span>深色模式</label>
<label class="ui-next-toggle" data-tour="set-notify">
<input type="checkbox" :checked="notifyOn" @change="toggleNotify">
<span>
</span>桌面通知（有任務需要你處理時提醒）</label>
<button v-if="notifyOn" @click="testNotify"><ui-next-icon name="alert"/> 測試通知</button>
<p>開啟後瀏覽器會請求通知權限；需保持至少一個分頁開著才能收到。</p>
</section>
<section class="ui-next-panel">
<h2>帳號資料</h2>
<label>帳號<input :value="me.username" disabled>
</label>
<label>顯示名稱<input v-model="me.display_name" placeholder="你的名字">
</label>
<button class="ui-next-primary" @click="save" :disabled="saving">{{ saving?'儲存中…':'儲存帳號設定' }}</button>
</section>
<section class="ui-next-panel">
<h2>變更密碼</h2>
<label>目前密碼<input v-model="pw.current" type="password">
</label>
<label>新密碼<input v-model="pw.next" type="password" placeholder="至少 8 個字元" :class="{'is-invalid':pw.next&&pw.next.length<8}">
</label>
<label>確認新密碼<input v-model="pw.confirm" type="password" :class="{'is-invalid':pw.confirm&&pw.next!==pw.confirm}">
</label>
<p v-if="pwError" class="ui-next-error-text">{{ pwError }}</p>
<button @click="savePw" :disabled="savingPw">{{ savingPw?'更新中…':'更新密碼' }}</button>
</section>
<section class="ui-next-panel" data-tour="set-github">
<h2>GitHub 認證</h2>
<p>個人 GitHub Personal Access Token，供你的任務推送程式碼使用。</p>
<p v-if="githubPat.configured">已連結：<b>{{ githubPat.login }}</b></p>
<p v-else class="ui-next-error-text">尚未設定個人 GitHub PAT——你的任務將被擋下，請先設定。</p>
<!-- 輸入框與儲存鈕不能藏在 v-else 裡：token 會過期，已連結狀態下換 token 是常態操作，
     藏起來等於逼使用者先「移除連結」把自己鎖在門外再重設。 -->
<input v-model="githubPat.input" type="password" :placeholder="githubPat.configured?'貼上新的 Personal Access Token 以更換':'貼上 GitHub Personal Access Token'">
<div class="ui-next-help-box">
<b>如何取得 PAT：</b>
<ol>
<li>GitHub → 右上頭像 → <b>Settings</b> → 左側最底 <b>Developer settings</b></li>
<li><b>Personal access tokens → Tokens (classic) → Generate new token (classic)</b></li>
<li><b>Scopes</b> 勾 <code>repo</code>；<b>Expiration</b> 建議 90 天以上</li>
<li>按 <b>Generate token</b>，複製那串 <code>ghp_…</code>（<b>只會顯示一次</b>）</li>
</ol>
<a :href="patLink" target="_blank" rel="noopener">↗ 開啟 GitHub 建立權杖頁（已預帶 repo 權限與名稱）</a>
<p>需對目標 org repo 有 read/write 權限；若 org 開啟 SAML SSO，建立後請在 GitHub「Authorize」此 token。</p>
</div>
<div class="ui-next-inline-actions">
<button class="ui-next-primary" @click="saveGithubPat" :disabled="githubPat.saving">{{ githubPat.saving?'驗證中…':(githubPat.configured?'更新 PAT':'連結 GitHub') }}</button>
<button v-if="githubPat.configured" class="danger" @click="removeGithubPat">移除連結</button>
</div>
</section>
<section class="ui-next-panel ui-next-settings-wide">
<h2>外部系統連線</h2>
<div class="ui-next-settings-connection">
<div data-tour="set-odoo">
<h3>Odoo</h3>
<p>Odoo 伺服器位址由管理員統一設定，此處填寫你的個人登入憑證。</p>
<label>帳號<input v-model="creds.odoo_username" placeholder="admin">
</label>
<label>密碼<input v-model="creds.odoo_password" type="password" :placeholder="pwSet.odoo?'已設定，留空不變更':'輸入密碼'">
</label>
<!-- 使用者 ID 沒有輸入框時，verifyOdoo 寫進來的值與 save() 送出去的值都是看不見也改不掉的。 -->
<label>使用者 ID<input v-model="creds.odoo_user_id" placeholder="點擊驗證自動取得">
</label>
<p class="ui-next-field-note">任務負責人篩選會用到；按下驗證會自動填入。</p>
<button @click="verifyOdoo" :disabled="verifyingOdoo">{{ verifyingOdoo?'驗證中…':'驗證 Odoo' }}</button>
</div>
<div data-tour="set-eservice">
<h3>eService</h3>
<p>eService 伺服器位址由管理員統一設定，此處填寫你的個人登入憑證。</p>
<label>帳號<input v-model="creds.service_username" placeholder="admin">
</label>
<label>密碼<input v-model="creds.service_password" type="password" :placeholder="pwSet.service?'已設定，留空不變更':'輸入密碼'">
</label>
<label>使用者 ID<input v-model="creds.service_user_id" placeholder="點擊驗證自動取得">
</label>
<p class="ui-next-field-note">任務負責人篩選會用到；按下驗證會自動填入。</p>
<button @click="verifyService" :disabled="verifyingService">{{ verifyingService?'驗證中…':'驗證 eService' }}</button>
</div>
</div>
<button class="ui-next-primary" @click="save" :disabled="saving">{{ saving?'儲存中…':'儲存連線設定' }}</button>
</section>
<section class="ui-next-panel">
<h2>Teams 通知</h2>
<p>填寫你的 Azure AD 物件識別碼，任務通知時系統會以你的顯示名稱 @mention。</p>
<label>Teams 使用者 ID（AAD Object ID）<input v-model="teamsUserId" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">
</label>
<p class="ui-next-field-note">Azure AD → 使用者 → 物件識別碼</p>
<button class="ui-next-primary" @click="save" :disabled="saving">{{ saving?'儲存中…':'儲存' }}</button>
</section>
</div>
</section>`,
  });

  // 專案清單只共用 API、UnreadStore 與確認視窗；不再委派 Legacy View 的生命週期或方法。
  window.UiNextProjectListView = Vue.defineComponent({
    name: "UiNextProjectListView",
    components: { ReleaseModal: window.ReleaseModal, UiNextIcon: window.UiNextIcon },
    data() { return { projects: [], loading: true, loadError: "", search: "", showAddForm: false, newProject: { name: "", folder_name: "", odoo_version: "", description: "", edition: "community" }, folderNameTouched: false, formError: "", saving: false, releaseId: null, moreProjectId: null }; },
    computed: {
      // 新手教程要有一張專案卡可以指，但新帳號一個專案都沒有 → 教程開著時插一張示範專案
      // （只在畫面上，不進 this.projects，也不會被送出或刪除）。刪掉 tour-demo.js 即自動消失。
      allProjects() { const sorted = [...this.projects].sort((a, b) => (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0)); const demo = window.TourDemo; return demo && demo.active ? [demo.project(), ...sorted] : sorted; },
      filteredProjects() { const query = this.search.toLowerCase(); return !query ? this.allProjects : this.allProjects.filter((project) => project.name.toLowerCase().includes(query) || (project.description || "").toLowerCase().includes(query) || (project.odoo_version || "").toLowerCase().includes(query)); },
      folderNameError() { const folder = this.newProject.folder_name.trim(); return !folder ? "請填寫英文資料夾名稱。" : !/^[a-zA-Z0-9_-]+$/.test(folder) ? "只能使用英文、數字、底線或連字號。" : ""; },
    },
    async created() { await this.load(); },
    mounted() { this._onProjectMoreOutside = (event) => { if (!event.target.closest('.ui-next-project-more')) this.moreProjectId = null; }; document.addEventListener('pointerdown', this._onProjectMoreOutside); },
    beforeUnmount() { document.removeEventListener('pointerdown', this._onProjectMoreOutside); },
    methods: {
      async load() { this.loading = true; this.loadError = ""; try { this.projects = await Api.get("projects"); this.projects.forEach((project) => { window.UnreadStore.byProject[String(project.id)] = project.unread_count || 0; }); } catch (error) { this.loadError = error.message || "無法載入專案"; showToast(this.loadError, "error", 0); } finally { this.loading = false; } },
      onAddFormKeydown(event) {
        if (event.key === "Escape") { this.closeAddForm(); return; }
        if (event.key !== "Tab") return;
        const box = this.$refs.projectCreateModal;
        const items = box ? [...box.querySelectorAll('a[href], input, select, textarea, button:not([disabled])')].filter((el) => el.offsetParent !== null) : [];
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      },
      openAddForm() { this.formError = ""; this.folderNameTouched = false; this.showAddForm = true; this.$nextTick(() => this.$refs.projectNameInput?.focus()); },
      closeAddForm() { this.showAddForm = false; this.formError = ""; this.newProject = { name: "", folder_name: "", odoo_version: "", description: "", edition: "community" }; },
      async add() { if (!this.newProject.name.trim() || !this.newProject.odoo_version.trim()) { this.formError = "請填寫專案名稱和 Odoo 版本。"; return; } if (this.folderNameError) { this.formError = this.folderNameError; return; } this.saving = true; this.formError = ""; try { await Api.post("projects", { ...this.newProject, name: this.newProject.name.trim(), folder_name: this.newProject.folder_name.trim(), odoo_version: this.newProject.odoo_version.trim() }); this.closeAddForm(); await this.load(); showToast("已新增專案", "success"); } catch (error) { this.formError = error.message || "無法新增專案，請重試。"; } finally { this.saving = false; } },
      // requireText 打字確認是刻意的：這個動作會連本機 clone 的程式碼一起刪掉且無法復原。
      async remove(project) { if (!await confirmDialog({ title: "刪除專案", message: `此動作會連帶刪除「${project.name}」下所有 repo 的本機程式碼，且無法復原。`, danger: true, requireText: project.name, confirmText: "刪除專案" })) return; try { await Api.delete(`projects/${project.id}`); await this.load(); showToast("已刪除", "success"); } catch (error) { showToast(error.message || "刪除專案失敗", "error", 0); } },
      async toggleFavorite(project) { const next = !project.is_favorite; project.is_favorite = next; try { if (next) await Api.post(`projects/${project.id}/favorite`, {}); else await Api.delete(`projects/${project.id}/favorite`); } catch (error) { project.is_favorite = !next; showToast(error.message || "更新我的最愛失敗", "error", 0); } },
      unread(id) { return window.UnreadStore.byProject[String(id)] || 0; }, go(id) { this.$router.push(`/projects/${id}`); }, goTab(id, tab) { this.moreProjectId = null; this.$router.push(`/projects/${id}?tab=${tab}`); },
      isAdmin() { return window.UserStore.role === "admin"; },
      async initWiki(id) { try { await Api.post(`projects/${id}/wiki/init`, {}); await this.load(); showToast("Wiki 初始化完成", "success"); } catch (error) { showToast(error.message || "Wiki 初始化失敗", "error", 6000); } },
      async openEnv(id) { const popup = window.open("about:blank", "_blank"); try { const url = await pollEnvSso(id); if (popup) popup.location = url; else window.location.href = url; } catch (error) { if (popup) popup.close(); showToast(error.message || "無法開啟測試區", "error", 0); } },
    },
    template: `
      <section class="ui-next-page ui-next-project-page">
<header class="ui-next-page-head">
<div>
<h1>專案</h1>
<p>管理程式庫、測試環境、對話與交付流程。</p>
</div>
<button v-if="!showAddForm" class="ui-next-primary" data-tour="proj-add" @click="openAddForm">新增專案</button>
</header>
<div v-if="showAddForm" class="ui-next-task-modal-backdrop" @mousedown.self="closeAddForm" @keydown="onAddFormKeydown">
<section ref="projectCreateModal" class="ui-next-task-modal ui-next-form-modal" data-tour="proj-form" role="dialog" aria-modal="true" aria-labelledby="project-create-title">
<header>
<h2 id="project-create-title">新增專案</h2>
<button type="button" class="ui-next-modal-close" @click="closeAddForm" aria-label="關閉"><ui-next-icon name="close"/></button>
</header>
<div class="ui-next-form-modal-grid">
<label>專案名稱<input ref="projectNameInput" v-model="newProject.name" autocomplete="off"></label>
<label>Odoo 版本<input v-model="newProject.odoo_version" placeholder="例如 17.0"></label>
<label>英文資料夾名稱<input v-model="newProject.folder_name" autocomplete="off" aria-describedby="project-folder-help" @blur="folderNameTouched=true">
<small id="project-folder-help" :class="{error:folderNameTouched&&folderNameError}">{{ (folderNameTouched&&folderNameError) || '只能使用英文、數字、底線或連字號。' }}</small>
</label>
<label>版本類型<select v-model="newProject.edition">
<option value="community">Community</option>
<option value="enterprise">Enterprise</option>
</select></label>
<label class="ui-next-form-modal-wide">專案描述（選填）<textarea v-model="newProject.description"></textarea></label>
</div>
<p v-if="formError" class="ui-next-inline-error" role="alert">{{ formError }}</p>
<footer><button type="button" @click="closeAddForm">取消</button><button class="ui-next-primary" @click="add" :disabled="saving">{{ saving?'建立中…':'建立專案' }}</button></footer>
</section>
</div>
<div class="ui-next-project-search">
<input v-model="search" placeholder="搜尋專案名稱、版本或說明…">
<span>{{ filteredProjects.length }} 個專案</span>
</div>
<div v-if="loading" class="ui-next-project-grid ui-next-project-grid-rich">
<article v-for="i in 3" :key="i" class="ui-next-project-skeleton">
<header>
<Skeleton width="18px" height="18px" radius="50%" />
<Skeleton width="120px" height="12px" />
</header>
<Skeleton width="180px" height="18px" />
<Skeleton width="90%" height="13px" />
<div class="ui-next-project-facts">
<Skeleton width="70px" height="12px" />
<Skeleton width="90px" height="12px" />
<Skeleton width="80px" height="12px" />
</div>
<footer>
<Skeleton width="64px" height="28px" radius="7px" />
<Skeleton width="64px" height="28px" radius="7px" />
<Skeleton width="64px" height="28px" radius="7px" />
</footer>
</article>
</div>
<div v-else-if="loadError" class="ui-next-loading-card ui-next-error-text">{{ loadError }} <button type="button" @click="load">重試</button></div>
<template v-else>
<div class="ui-next-project-grid ui-next-project-grid-rich">
<article v-for="project in filteredProjects" :key="project.id">
<header class="ui-next-project-card-title">
<button class="ui-next-project-title-open" @click="go(project.id)"><h2>{{ project.name }} <small>Odoo {{ project.odoo_version }} · {{ project.edition==='enterprise'?'企業版':'社群版' }}</small></h2></button>
<div class="ui-next-project-more"><button type="button" :aria-expanded="moreProjectId===project.id" :aria-label="'專案「'+project.name+'」更多操作'" @click="moreProjectId=moreProjectId===project.id?null:project.id"><ui-next-icon name="dots"/></button><div v-if="moreProjectId===project.id" class="ui-next-project-more-menu"><button type="button" @click="openEnv(project.id);moreProjectId=null">測試區</button><button type="button" @click="releaseId=project.id;moreProjectId=null" :disabled="!project.repo_count">上正式</button><button type="button" @click="goTab(project.id,'repos')">REPO</button><button type="button" @click="goTab(project.id,'db')">連線設定</button><button type="button" @click="go(project.id);moreProjectId=null">專案設定</button><button type="button" @click="goTab(project.id,'chat')">問答</button><button type="button" @click="goTab(project.id,'wiki')">Wiki</button><button type="button" @click="goTab(project.id,'sop')">部署 SOP</button><button v-if="!project.has_wiki" type="button" @click="initWiki(project.id);moreProjectId=null">初始化 Wiki</button><button v-if="isAdmin()" type="button" class="danger" @click="remove(project);moreProjectId=null">刪除專案</button></div></div>
<button v-if="project.id!=='demo'" @click="toggleFavorite(project)" :class="{active:project.is_favorite}" :aria-label="project.is_favorite?'取消我的最愛':'加入我的最愛'"><ui-next-icon :name="project.is_favorite?'star-filled':'star'"/></button>
</header>
<div class="ui-next-project-facts">
<span>{{ project.repo_count || 0 }} 個 Repo</span>
<span>未讀 Chat <b v-if="unread(project.id)" class="ui-next-unread-badge">{{ unread(project.id) }}</b><template v-else>：無</template></span>
<span>{{ project.folder_name || '尚未設定資料夾' }}</span>
</div>
<button v-if="project.description" class="ui-next-project-open ui-next-project-note" @click="go(project.id)">
<p>{{ project.description }}</p>
</button>
<div v-else class="ui-next-project-note is-empty" aria-hidden="true"></div>

</article>
<p v-if="!filteredProjects.length" class="ui-next-empty-state">{{ search ? '找不到符合的專案。' : '尚無專案。' }} <button v-if="search" type="button" @click="search=''">清除搜尋</button></p>
</div>
</template>
<ReleaseModal v-if="releaseId" :key="releaseId" :project-id="releaseId" @close="releaseId=null" />
</section>`,
  });

  // 任務清單的流程列獨立由狀態 registry 推導，不依賴 Legacy View。
  const UiNextStatusBar = Vue.defineComponent({
    name: "UiNextStatusBar",
    components: { UiNextIcon: window.UiNextIcon },
    props: { status: String, source: String, gitBranch: String, e2eDisabled: Boolean },
    computed: { isNew() { return this.status === "new"; }, isStopped() { return ["stopped", "merge_conflict"].includes(this.status); }, flow() { const dev = [{ label: "分析", statuses: ["analysis_running", "branch_pending"] }, { label: "確認", statuses: ["confirm_pending", "confirm_answered", "clarify_pending", "clarify_answered", "spec_review"] }, { label: "開發", statuses: ["coding_running"] }, { label: "QA", statuses: ["qa_running", "merge_running"] }, { label: "部署", statuses: ["deploy_testing"] }, { label: "測試", statuses: ["playwright_running"] }, { label: "審核", statuses: ["review_pending", "wiki_updating"] }, { label: "完成", statuses: ["done"] }]; const customer = [{ label: "客服", statuses: ["cs_running"] }, { label: "確認", statuses: ["cs_reply_pending"] }, { label: "完成", statuses: ["done"] }]; const customerData = [{ label: "客服", statuses: ["cs_running"] }, { label: "補資料", statuses: ["cs_data_needed"] }, { label: "確認", statuses: ["cs_reply_pending"] }, { label: "完成", statuses: ["done"] }]; if (this.status === "cs_data_needed") return customerData; if (["cs_running", "cs_reply_pending"].includes(this.status)) return customer; if (this.status === "done" && this.source === "service" && !this.gitBranch) return customer; const steps = this.source === "service" ? [{ label: "客服", statuses: ["cs_running"] }, ...dev] : dev; return this.e2eDisabled ? steps.filter((step) => step.label !== "測試") : steps; }, activeIdx() { if (this.status === "done") return this.flow.length; const index = this.flow.findIndex((step) => step.statuses.includes(this.status)); return index === -1 ? 0 : index; } },
    template: `<div v-if="!isNew" class="stepper" :aria-label="'任務進度：'+status"><template v-for="(step,index) in flow" :key="step.label"><div class="step-node" :class="{'sn-done':!isStopped&&index<activeIdx,'sn-active':!isStopped&&index===activeIdx,'sn-error':isStopped,'sn-future':!isStopped&&index>activeIdx}" :aria-current="!isStopped&&index===activeIdx ? 'step' : null"><div class="step-circle"><ui-next-icon v-if="isStopped" name="alert"/><ui-next-icon v-else-if="index<activeIdx" name="check"/><span v-else>{{ index + 1 }}</span></div><div class="step-label">{{ step.label }}</div></div><div v-if="index<flow.length-1" class="step-connector" :class="{'sc-done':!isStopped&&index<activeIdx,'sc-error':isStopped}"></div></template></div>`,
  });
  window.UiNextTaskListView = Vue.defineComponent({
    name: "UiNextTaskListView",
    components: { StatusBar: UiNextStatusBar, UiNextIcon: window.UiNextIcon },
    data() { return { tasks: [], archivedTasks: [], filter: "needs_action", releaseFilter: "all", search: "", sort: "updated_desc", loading: true, loadError: "", syncing: false, batchMode: false, selectedIds: [], batchWorking: false, showAdd: false, adding: false, addError: "", addTrigger: null, projects: [], newTask: { title: "", original_text: "", project_id: "" }, newFiles: [], projectFilter: "", statusFilter: "", sourceFilter: "", filtersOpen: false, moreTaskId: null, showAllUsers: false, ownerFilter: "", users: [] }; },
    computed: {
      isAdmin() { return window.UserStore.role === "admin"; },
      // ownerFilter 與 showAllUsers 都刻意不進網址列：它們是「這次看別人任務」的臨時狀態，
      // 一旦被記住，下次進來會是「showAllUsers 關著、ownerFilter 還開著」＝看不見的篩選把列表清空。
      ownerOptions() { return this.users.map((user) => ({ value: user.id, label: user.display_name || user.username })); },
      // Vue template 不會把全域 window 暴露到 component scope；在此注入 registry，
      // 避免開啟篩選時讀取 undefined 而卸載整個任務頁。
      statusOptions() {
        return Object.entries(window.STATUS_LABELS || {}).map(([value, label]) => ({ value, label }));
      },
      realFilteredTasks() { let list = this.filter === "archived" ? this.archivedTasks : this.filter === "paused" ? this.tasks.filter((task) => task.is_paused) : this.filter === "needs_action" ? this.tasks.filter((task) => this.needsAction(task) && (task.status === "stopped" || !task.is_paused)) : this.filter === "pending" ? this.tasks.filter((task) => !task.is_paused && task.status !== "done") : this.tasks; return this.applySort(list.filter((task) => this.matchAll(task))); },
      filteredTasks() { return this.realFilteredTasks; },
      needsActionCount() { return this.tasks.filter((task) => this.needsAction(task) && (task.status === "stopped" || !task.is_paused)).length; },
      needsActionShown() { return this.tasks.filter((task) => this.needsAction(task) && (task.status === "stopped" || !task.is_paused) && this.matchAll(task)).length; },
      pendingShown() { return this.tasks.filter((task) => !task.is_paused && task.status !== "done" && this.matchAll(task)).length; },
      pausedShown() { return this.tasks.filter((task) => task.is_paused && this.matchAll(task)).length; },
      allShown() { return this.tasks.filter((task) => this.matchAll(task)).length; },
      allSelected() { return this.filteredTasks.length > 0 && this.filteredTasks.every((task) => this.selectedIds.includes(task.id)); },
      activeFilterCount() { return [this.projectFilter, this.ownerFilter, this.statusFilter, this.sourceFilter, this.search].filter(Boolean).length + (this.releaseFilter !== "all" ? 1 : 0); },
    },
    watch: {
      filter() { this.selectedIds = []; this.batchMode = false; this.syncQuery(); this.load(); },
      projectFilter() { this.syncQuery(); }, statusFilter() { this.syncQuery(); }, sourceFilter() { this.syncQuery(); },
      search() { this.syncQuery(); }, sort() { this.syncQuery(); }, releaseFilter() { this.syncQuery(); },
      "$route.query": {
        deep: true,
        handler(query) {
          const tab = ["needs_action", "pending", "paused", "all", "archived"].includes(query.tab) ? query.tab : "needs_action";
          if (this.filter !== tab) this.filter = tab;
          const values = { projectFilter: query.project || "", statusFilter: query.status || "", sourceFilter: query.source || "", search: query.q || "", sort: query.sort || "updated_desc", releaseFilter: query.release || "all" };
          Object.entries(values).forEach(([key, value]) => { if (this[key] !== value) this[key] = value; });
        },
      },
    },
    async created() {
      const tab = this.$route.query.tab, query = this.$route.query;
      if (["needs_action", "pending", "paused", "all", "archived"].includes(tab)) this.filter = tab;
      this.projectFilter = query.project || ""; this.statusFilter = query.status || ""; this.sourceFilter = query.source || "";
      this.search = query.q || ""; this.sort = query.sort || "updated_desc"; this.releaseFilter = query.release || "all";
      await Promise.all([this.load(), Api.get("projects").then((projects) => { this.projects = projects || []; }).catch(() => {})]);
    },
    // SocketManager 只留得住一個 callback：離開頁面沒解除的話，下一頁的即時事件仍會打這一頁的 refresh。
    mounted() { SocketManager.setRefreshCallback(this.refresh.bind(this)); },
    beforeUnmount() { SocketManager.setRefreshCallback(null); },
    methods: {
      matchAll(task) { const query = this.search.toLowerCase().trim(); const matchesSearch = !query || [task.title, task.task_id, task.source, task.module, task.project_name].some((value) => (value || "").toLowerCase().includes(query)); const matchesRelease = this.releaseFilter === "released" ? !!task.merged_to_main_at : this.releaseFilter === "pending_release" ? !!task.approved_at && !task.merged_to_main_at : true; return matchesSearch && matchesRelease && (!this.projectFilter || String(task.project_id) === String(this.projectFilter)) && (!this.ownerFilter || String(task.owner_id) === String(this.ownerFilter)) && (!this.statusFilter || task.status === this.statusFilter) && (!this.sourceFilter || task.source === this.sourceFilter); },
      // 一定要重新取資料：showAllUsers 決定打的是 tasks 還是 tasks?all=true。
      // users 在這裡才抓不在 created()：UserStore.role 由 router.afterEach 非同步填，
      // created() 當下 isAdmin 還是 false，那時抓就永遠抓不到，使用者下拉會是空的。
      async toggleAllUsers() { this.showAllUsers = !this.showAllUsers; if (!this.showAllUsers) this.ownerFilter = ""; else if (!this.users.length) Api.get("admin/users").then((users) => { this.users = users || []; }).catch(() => {}); await this.load(); },
      refresh() { Api.get(this.showAllUsers ? "tasks?all=true" : "tasks").then((data) => { this.tasks = data.tasks || data; if (!this.showAllUsers) window.needsActionCount.value = this.needsActionCount; }).catch(() => {}); if (this.filter === "archived") Api.get("tasks?archived=true").then((data) => { this.archivedTasks = data.tasks || data; }).catch(() => {}); },
      syncQuery() {
        const query = { ...this.$route.query, tab: this.filter };
        const values = { project: this.projectFilter, status: this.statusFilter, source: this.sourceFilter, q: this.search, sort: this.sort === "updated_desc" ? "" : this.sort, release: this.releaseFilter === "all" ? "" : this.releaseFilter };
        Object.entries(values).forEach(([key, value]) => { if (value) query[key] = value; else delete query[key]; });
        if (JSON.stringify(query) !== JSON.stringify(this.$route.query)) this.$router.replace({ query });
      },
      clearFilters() { this.search = ""; this.releaseFilter = "all"; this.projectFilter = ""; this.ownerFilter = ""; this.statusFilter = ""; this.sourceFilter = ""; },
      applySort(list) { const timestamp = (value) => new Date(value || 0).getTime(); return list.slice().sort((a, b) => this.sort === "created_desc" ? timestamp(b.created_at) - timestamp(a.created_at) : this.sort === "title_asc" ? (a.title || a.task_id || "").localeCompare(b.title || b.task_id || "", "zh-Hant") : this.sort === "status_asc" ? (a.status || "").localeCompare(b.status || "") : timestamp(b.updated_at || b.created_at) - timestamp(a.updated_at || a.created_at)); },
      needsAction(task) { return (window.HUMAN_STATUSES || []).includes(task.status); }, isRunning(task) { return (window.RUNNABLE_STATUSES || []).includes(task.status); }, isStopped(task) { return task.status === "stopped" || task.status === "merge_conflict"; }, statusLabel(status) { return (window.STATUS_LABELS || {})[status] || status; }, sourceLabel(source) { return source === "odoo" ? "Odoo" : source === "service" ? "eService" : source === "manual" ? "手動增加" : source; }, timeAgo(value) { const delta = Date.now() - new Date(value).getTime(); return delta < 60000 ? "剛剛" : delta < 3600000 ? `${Math.floor(delta / 60000)} 分鐘前` : delta < 86400000 ? `${Math.floor(delta / 3600000)} 小時前` : `${Math.floor(delta / 86400000)} 天前`; },
      async load() { this.loading = true; this.loadError = ""; try { const data = await Api.get(this.filter === "archived" ? "tasks?archived=true" : this.showAllUsers ? "tasks?all=true" : "tasks"); if (this.filter === "archived") this.archivedTasks = data.tasks || data; else { this.tasks = data.tasks || data; if (!this.showAllUsers) window.needsActionCount.value = this.needsActionCount; } } catch (error) { this.loadError = error.message || "無法載入任務"; showToast(this.loadError, "error", 0); } finally { this.loading = false; } },
      taskPath(task) { return { path: `/task/${task.id}`, query: { from: this.filter } }; }, openTask(task) { this.$router.push(this.taskPath(task)); }, onTaskKeydown(task, event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.openTask(task); } }, toggleBatchMode() { this.batchMode = !this.batchMode; if (!this.batchMode) this.selectedIds = []; }, toggleSelect(id, event) { event.stopPropagation(); const index = this.selectedIds.indexOf(id); if (index < 0) this.selectedIds.push(id); else this.selectedIds.splice(index, 1); }, toggleSelectAll() { this.selectedIds = this.allSelected ? [] : this.filteredTasks.map((task) => task.id); },
      openAdd(event) { this.newTask = { title: "", original_text: "", project_id: "" }; this.newFiles = []; this.addError = ""; this.addTrigger = event?.currentTarget || null; this.showAdd = true; this.$nextTick(() => this.$refs.newTaskTitle?.focus()); }, closeAdd() { this.showAdd = false; this.$nextTick(() => this.addTrigger?.focus()); }, onAddFilesSelected(event) { const files = Array.from(event.target.files || []); this.addError = files.length > 5 ? "最多上傳 5 個附件，請重新選擇。" : ""; this.newFiles = files.slice(0, 5); event.target.value = ""; }, removeAddFile(index) { this.newFiles.splice(index, 1); }, trapAddFocus(event) { if (event.key === "Escape") return this.closeAdd(); if (event.key !== "Tab") return; const items = Array.from(this.$refs.taskCreateModal?.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])") || []); if (!items.length) return; const first = items[0], last = items[items.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }, async submitAdd() { if (!this.newTask.project_id || !this.newTask.title.trim() || !this.newTask.original_text.trim()) { this.addError = "請完整填寫專案、標題與內容。"; return; } this.adding = true; this.addError = ""; try { const form = new FormData(); form.append("title", this.newTask.title.trim()); form.append("original_text", this.newTask.original_text); form.append("project_id", this.newTask.project_id); this.newFiles.forEach((file) => form.append("files", file)); await Api.postForm("tasks", form); this.showAdd = false; this.filter = "all"; showToast("已新增任務", "success"); } catch (error) { this.addError = error.message || "新增任務失敗"; showToast(this.addError, "error", 0); } finally { this.adding = false; } },
      async syncNow() { this.syncing = true; try { await Api.post("sync/now", {}); await this.load(); showToast("同步完成", "success"); } catch (error) { showToast(error.message || "同步失敗", "error", 0); } finally { this.syncing = false; } }, async togglePause(task, event) { event.stopPropagation(); try { const result = await Api.put(`tasks/${task.id}/pause`, {}); task.is_paused = result.is_paused; showToast(result.is_paused ? "任務已暫停" : "任務已恢復", "success"); } catch (error) { showToast(error.message || "更新失敗", "error", 0); } },
      async batchPause() { await this.batch("pause"); }, async batchArchive() { await this.batch("archive"); }, async batchUnarchive() { await this.batch("unarchive"); }, async batchDelete() { if (!this.selectedIds.length || !await confirmDialog({ title: "永久刪除任務", message: `確定永久刪除選取的 ${this.selectedIds.length} 筆任務？`, danger: true, confirmText: "刪除" })) return; await this.batch("delete"); }, async batch(action) { if (!this.selectedIds.length) return; this.batchWorking = true; try { await Api.post(`tasks/batch/${action}`, action === "pause" ? { ids: this.selectedIds, paused: true } : { ids: this.selectedIds }); this.selectedIds = []; await this.load(); showToast("批次操作完成", "success"); } catch (error) { showToast(error.message || "批次操作失敗", "error", 0); } finally { this.batchWorking = false; } },
      async archiveTask(task) { if (!await confirmDialog({ title: "封存任務", message: `確定要封存任務「${task.title || task.task_id}」？`, confirmText: "封存" })) return; try { await Api.post(`tasks/${task.id}/archive`, {}); this.tasks = this.tasks.filter((item) => item.id !== task.id); this.moreTaskId = null; showToast("任務已封存", "success"); } catch (error) { showToast(error.message || "封存失敗", "error", 0); } },
      async unarchiveTask(task) { try { await Api.post(`tasks/${task.id}/unarchive`, {}); this.archivedTasks = this.archivedTasks.filter((item) => item.id !== task.id); this.moreTaskId = null; showToast("任務已解除封存", "success"); } catch (error) { showToast(error.message || "解除封存失敗", "error", 0); } },
      async deleteTask(task) { if (!await confirmDialog({ title: "永久刪除任務", message: `確定要永久刪除任務「${task.title || task.task_id}」？`, danger: true, confirmText: "刪除" })) return; try { await Api.delete(`tasks/${task.id}`); this.tasks = this.tasks.filter((item) => item.id !== task.id); this.archivedTasks = this.archivedTasks.filter((item) => item.id !== task.id); this.moreTaskId = null; showToast("任務已刪除", "success"); } catch (error) { showToast(error.message || "刪除失敗", "error", 0); } },
    },
    template: `
      <section class="ui-next-page ui-next-task-page ui-next-task-page-rich">
<header class="ui-next-page-head">
<div>
<h1>任務列表</h1>
<p>跨專案追蹤開發、澄清與交付進度。</p>
</div>
<div class="ui-next-head-tools">
<button @click="toggleBatchMode">{{ batchMode?'取消批次':'批次' }}</button>
<button @click="syncNow" :disabled="syncing">{{ syncing?'同步中…':'同步' }}</button>
<button class="ui-next-primary ui-next-cta" @click="openAdd($event)"><ui-next-icon name="plus"/>建立任務</button>
</div>
</header>
<div v-if="showAdd" class="ui-next-task-modal-backdrop" @click.self="closeAdd" @keydown="trapAddFocus">
<section ref="taskCreateModal" class="ui-next-task-modal ui-next-form-modal" role="dialog" aria-modal="true" aria-labelledby="ui-next-task-create-title">
<header><h2 id="ui-next-task-create-title">建立任務</h2><button type="button" class="ui-next-modal-close" aria-label="關閉建立任務視窗" @click="closeAdd"><ui-next-icon name="close"/></button></header>
<div class="ui-next-form-modal-grid">
<label class="ui-next-form-modal-wide">專案
<select v-model="newTask.project_id">
<option value="">選擇專案</option>
<option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
</select></label>
<label class="ui-next-form-modal-wide">任務標題<input ref="newTaskTitle" v-model="newTask.title" required></label>
<label class="ui-next-form-modal-wide">需求描述<textarea v-model="newTask.original_text" required></textarea></label>
<label class="ui-next-form-modal-wide ui-next-upload">附件（最多 5 個）
<input type="file" multiple @change="onAddFilesSelected">
<span class="ui-next-upload-drop"><ui-next-icon name="paperclip"/><b>點此選擇檔案</b><small>最多 5 個</small></span>
</label>
<div v-if="newFiles.length" class="ui-next-form-modal-wide ui-next-upload-list">
<span v-for="(file,index) in newFiles" :key="file.name+file.size+index" class="ui-next-file-preview"><ui-next-icon name="paperclip"/><em>{{ file.name }}</em><button type="button" :aria-label="'移除附件：'+file.name" @click="removeAddFile(index)"><ui-next-icon name="close"/></button></span>
</div>
</div>
<p v-if="addError" class="ui-next-inline-error" role="alert">{{ addError }}</p>
<footer><button type="button" @click="closeAdd">取消</button><button class="ui-next-primary" @click="submitAdd" :disabled="adding">{{ adding?'建立中…':'建立任務' }}</button></footer>
</section></div>
<div class="ui-next-task-tabs" role="group" aria-label="任務篩選">
<button v-for="item in [['needs_action','需回覆',needsActionShown],['pending','待處理',pendingShown],['paused','暫停中',pausedShown],['all','全部',allShown],['archived','已封存','']]" :key="item[0]" :class="{active:filter===item[0]}" :aria-pressed="filter===item[0] ? 'true' : 'false'" @click="filter=item[0]">{{ item[1] }} <b v-if="item[2]!==''">{{ item[2] }}</b>
</button>
</div>
<div class="ui-next-task-toolbar">
<input v-model="search" placeholder="搜尋標題、任務 ID、專案或來源…">
<button @click="filtersOpen=!filtersOpen">篩選 <b v-if="activeFilterCount">{{ activeFilterCount }}</b>
</button>
<select v-model="sort">
<option value="updated_desc">最近更新</option>
<option value="created_desc">最新建立</option>
<option value="title_asc">標題 A→Z</option>
<option value="status_asc">依狀態</option>
</select>
</div>
<div v-if="filtersOpen" class="ui-next-task-filters">
<button v-if="isAdmin" :class="{active:showAllUsers}" @click="toggleAllUsers" :title="showAllUsers?'目前顯示全部使用者的任務，點一下改回只顯示自己的':'目前只顯示自己的任務，點一下顯示全部使用者的'">顯示全部使用者</button>
<select v-if="isAdmin&&showAllUsers" v-model="ownerFilter">
<option value="">全部使用者</option>
<option v-for="owner in ownerOptions" :key="owner.value" :value="owner.value">{{ owner.label }}</option>
</select>
<select v-model="projectFilter">
<option value="">全部專案</option>
<option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
</select>
<select v-model="statusFilter">
<option value="">全部狀態</option>
<option v-for="option in statusOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
</select>
<select v-model="sourceFilter">
<option value="">全部來源</option>
<option value="odoo">Odoo</option>
<option value="service">eService</option>
<option value="manual">手動增加</option>
</select>
<select v-model="releaseFilter">
<option value="all">全部（上正式）</option>
<option value="released">已上正式</option>
<option value="pending_release">待上正式</option>
</select>
<button @click="clearFilters">清除篩選</button>
</div>
<div v-if="batchMode" class="ui-next-batch-bar">
<label>
<input type="checkbox" :checked="allSelected" @change="toggleSelectAll"> 全選</label>
<span>已選 {{ selectedIds.length }} 筆</span>
<button @click="batchPause" :disabled="batchWorking||!selectedIds.length">暫停</button>
<button v-if="filter!=='archived'" @click="batchArchive" :disabled="batchWorking||!selectedIds.length">封存</button>
<button v-else @click="batchUnarchive" :disabled="batchWorking||!selectedIds.length">解除封存</button>
<button class="danger" @click="batchDelete" :disabled="batchWorking||!selectedIds.length">刪除</button>
</div>
<div v-if="loading" class="ui-next-loading-card">載入任務中…</div>
<div v-else-if="loadError" class="ui-next-loading-card"><p>{{ loadError }}</p><button class="ui-next-primary" @click="load">重試</button></div>
<div v-else class="ui-next-task-rich-list">
<article v-for="task in filteredTasks" :key="task.id" :class="{selected:selectedIds.includes(task.id),need:needsAction(task)&&!task.is_paused,running:isRunning(task)&&!task.is_paused}" :tabindex="batchMode?-1:0" @click="batchMode?toggleSelect(task.id,$event):openTask(task)" @keydown="!batchMode&&onTaskKeydown(task,$event)">
<div class="ui-next-task-rich-head">
<label v-if="batchMode">
<input type="checkbox" :aria-label="'選取任務：'+(task.title||task.task_id)" :checked="selectedIds.includes(task.id)" @click.stop="toggleSelect(task.id,$event)">
</label>
<div>
<h2><router-link :to="taskPath(task)" @click.stop>{{ task.title||task.task_id }}</router-link></h2>
<p>{{ statusLabel(task.status) }} · {{ task.project_name||'未分類專案' }} · {{ timeAgo(task.updated_at||task.created_at) }}</p>
</div>
<div class="ui-next-task-card-actions">
<button v-if="!batchMode&&!isStopped(task)&&task.status!=='done'" @click.stop="togglePause(task,$event)">{{ task.is_paused?'恢復':'暫停' }}</button>
<button v-if="!batchMode" type="button" @click.stop="moreTaskId=moreTaskId===task.id?null:task.id" :aria-label="'更多操作：'+(task.title||task.task_id)" :aria-expanded="moreTaskId===task.id">更多</button>
<div v-if="moreTaskId===task.id" class="ui-next-task-more" @click.stop><button v-if="filter!=='archived'" type="button" @click="archiveTask(task)">封存</button><button v-else type="button" @click="unarchiveTask(task)">解除封存</button><button type="button" class="danger" @click="deleteTask(task)">刪除</button></div>
</div>
</div>
<div class="ui-next-task-rich-meta">
<span>{{ sourceLabel(task.source) }}</span>
<span v-if="task.env_status">測試機</span>
<span v-if="task.merged_to_main_at">已上正式</span>
<span v-if="showAllUsers&&task.owner_name">{{ task.owner_name }}</span>
<span v-if="task.module">{{ task.module }}</span>
</div>
<StatusBar :status="task.status" :source="task.source" :git-branch="task.git_branch" :e2e-disabled="task.e2e_disabled" />
</article>
<p v-if="!filteredTasks.length" class="ui-next-empty-state">{{ activeFilterCount ? '找不到符合篩選條件的任務。' : '目前沒有任務。' }} <button v-if="activeFilterCount" type="button" @click="clearFilters">清除篩選</button></p>
</div>
</section>`,
  });

  const UiNextWikiNode = Vue.defineComponent({
    name: "UiNextWikiNode", components: { UiNextIcon: window.UiNextIcon }, props: { node: Object, depth: Number, currentSlug: String, refreshing: String, editingSlug: String, menuSlug: String }, emits: ["open", "refresh", "remove", "menu"],
    template: `<div><div class="ui-next-wiki-row" :class="{active:currentSlug===node.slug,'has-menu':menuSlug===node.slug,'has-guide':depth>0}" :style="{'--wiki-depth':depth}"><button type="button" class="ui-next-wiki-node" :style="{paddingLeft:(10+depth*14)+'px'}" @click="$emit('open',node.slug)">{{ node.title }}</button><button v-if="node.node_type!=='notes'" type="button" class="ui-next-wiki-more" :aria-label="node.title+' 更多操作'" :aria-expanded="menuSlug===node.slug?'true':'false'" aria-haspopup="menu" @click.stop="$emit('menu',menuSlug===node.slug?'':node.slug)"><ui-next-icon name="dots"/></button><div v-if="menuSlug===node.slug" class="ui-next-wiki-menu" role="menu"><button type="button" role="menuitem" :disabled="refreshing===node.slug||editingSlug===node.slug" @click="$emit('refresh',node.slug);$emit('menu','')">重新生成</button><button v-if="node.slug!=='troubleshooting'" type="button" role="menuitem" class="danger" @click="$emit('remove',node.slug);$emit('menu','')">刪除</button></div></div><ui-next-wiki-node v-for="child in node.children" :key="child.id" :node="child" :depth="depth+1" :current-slug="currentSlug" :refreshing="refreshing" :editing-slug="editingSlug" :menu-slug="menuSlug" @open="$emit('open',$event)" @refresh="$emit('refresh',$event)" @remove="$emit('remove',$event)" @menu="$emit('menu',$event)"/></div>`,
  });
  window.UiNextWikiView = Vue.defineComponent({
    name: "UiNextWikiView",
    // 內嵌進專案頁的 Wiki 頁籤時不動網址：那裡的網址是 ?tab=wiki，一改就跳出頁籤。
    props: { embedded: { type: Boolean, default: false } },
    components: { "wiki-node": UiNextWikiNode, UiNextIcon: window.UiNextIcon },
    data() { return { menuSlug: "", pages: [], current: null, loading: true, loadError: "", editing: false, editContent: "", saving: false, refreshing: "", building: false, progress: { percent: 0, message: "" }, showAddModal: false, newPageTitle: "", newPageSlug: "", slugTouched: false, addingPage: false, addPageError: "", addPageTrigger: null, requestId: 0 }; },
    computed: { renderedContent() { return this.current ? renderMarkdown(this.current.content || "") : ""; }, editingSlug() { return this.editing && this.current ? this.current.slug : ""; }, canBuild() { return !this.pages.length && !this.loadError; }, tree() { const byId = {}; this.pages.forEach((page) => { byId[page.id] = { ...page, children: [] }; }); const roots = []; this.pages.forEach((page) => { const node = byId[page.id]; if (page.parent_id && byId[page.parent_id]) byId[page.parent_id].children.push(node); else roots.push(node); }); const rank = (node) => (node.node_type === "notes" ? 0 : node.node_type === "overview" ? 1 : 2);
      return roots.sort((a, b) => rank(a) - rank(b)); } },
    async created() { await this.loadPages(); const slug = this.$route.params.slug; if (slug) await this.loadPage(slug); else if (this.tree.length) await this.loadPage(this.tree[0].slug); },
    beforeUnmount() { document.removeEventListener("pointerdown", this._onWikiMenuOutside); this.requestId++; const socket = window._socket; if (socket?.off && this._onProgress) socket.off("wiki:progress", this._onProgress); },
    mounted() {
      this._onWikiMenuOutside = (event) => {
        if (!event.target.closest(".ui-next-wiki-menu") && !event.target.closest(".ui-next-wiki-more")) this.menuSlug = "";
      };
      document.addEventListener("pointerdown", this._onWikiMenuOutside);
      this._onProgress = (data) => { if (String(data.projectId) === String(this.$route.params.id)) this.progress = { percent: data.percent || 0, message: data.message || "" }; }; window._socket?.on("wiki:progress", this._onProgress); },
    watch: { "$route.params.slug"(slug) { if (slug && (!this.current || this.current.slug !== slug)) this.loadPage(slug); } },
    methods: {
      // 新手教程的示範專案：wiki 內容來自 tour-demo.js，不打 API
      isTourDemo() { return !!(window.TourDemo && window.TourDemo.isProject(this.$route.params.id)); },
      // 教程示範專案的 id 是字串 'demo'，送進 integer 型別的 project_id 一律 500。
      // 讀取路徑走 TourDemo 假資料，寫入路徑（儲存／重新生成／刪除／新增／建立）一律擋在前端並說明原因。
      tourDemoBlocked() { if (!this.isTourDemo()) return false; showToast("教學示範專案僅供瀏覽，不會實際變更", "info"); return true; },
      async loadPages() { if (this.isTourDemo()) { this.pages = window.TourDemo.wikiPages(); this.loadError = ""; this.loading = false; return; } this.loading = true; this.loadError = ""; try { this.pages = await Api.get(`projects/${this.$route.params.id}/wiki`); } catch (error) { this.loadError = error.message || "無法載入 Wiki"; } finally { this.loading = false; } },
      async loadPage(slug) { const requestId = ++this.requestId; if (this.editing && this.current && this.current.slug !== slug && !await confirmDialog({ title: "尚未儲存", message: "切換頁面會放棄未儲存的修改。", danger: true, confirmText: "放棄修改" })) { if (!this.embedded) this.$router.replace(`/projects/${this.$route.params.id}/wiki/${this.current.slug}`); return; } try { const page = this.isTourDemo() ? window.TourDemo.wikiPage(slug) : await Api.get(`projects/${this.$route.params.id}/wiki/${slug}`); if (requestId !== this.requestId) return; this.current = page; this.editContent = page.content || ""; this.editing = false; if (!this.embedded && this.$route.params.slug !== slug) this.$router.replace(`/projects/${this.$route.params.id}/wiki/${slug}`); } catch (error) { showToast(error.message || "無法載入頁面", "error", 0); } },
      async save() { if (!this.current || this.saving) return; if (this.tourDemoBlocked()) return; this.saving = true; try { this.current = await Api.put(`projects/${this.$route.params.id}/wiki/${this.current.slug}`, { content: this.editContent }); this.editing = false; await this.loadPages(); showToast("已儲存", "success"); } catch (error) { showToast(error.message || "儲存失敗", "error", 0); } finally { this.saving = false; } },
      openAddPage(event) { this.newPageTitle = ""; this.newPageSlug = ""; this.slugTouched = false; this.addPageError = ""; this.addPageTrigger = event?.currentTarget || null; this.showAddModal = true; this.$nextTick(() => this.$refs.newTitleInput?.focus()); }, closeAddPage() { this.showAddModal = false; this.$nextTick(() => this.addPageTrigger?.focus()); }, trapAddPageFocus(event) { if (event.key === "Escape") return this.closeAddPage(); if (event.key !== "Tab") return; const items = Array.from(this.$refs.wikiAddModal?.querySelectorAll("button:not([disabled]), input:not([disabled])") || []); if (!items.length) return; const first = items[0], last = items[items.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }, onTitleInput() { if (!this.slugTouched) this.newPageSlug = this.newPageTitle.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }, onSlugInput() { this.slugTouched = true; },
      async submitAddPage() { const title = this.newPageTitle.trim(), slug = this.newPageSlug.trim(); if (!title || !slug) { this.addPageError = "請填寫頁面標題與 Slug。"; return; } if (this.tourDemoBlocked()) return; this.addingPage = true; this.addPageError = ""; try { await Api.post(`projects/${this.$route.params.id}/wiki`, { title, slug, content: `# ${title}\n\n` }); this.closeAddPage(); await this.loadPages(); await this.loadPage(slug); } catch (error) { this.addPageError = error.message || "新增失敗"; showToast(this.addPageError, "error", 0); } finally { this.addingPage = false; } },
      async removePage(slug) { if (this.tourDemoBlocked()) return; if (!await confirmDialog({ title: "刪除頁面", message: `確定刪除「${slug}」？`, danger: true, confirmText: "刪除" })) return; try { await Api.delete(`projects/${this.$route.params.id}/wiki/${slug}`); if (this.current?.slug === slug) this.current = null; await this.loadPages(); } catch (error) { showToast(error.message || "刪除失敗", "error", 0); } },
      async refreshNode(slug) { if (this.tourDemoBlocked()) return; this.refreshing = slug; try { await Api.post(`projects/${this.$route.params.id}/wiki/${slug}/refresh`); await this.loadPages(); if (this.current?.slug === slug) await this.loadPage(slug); } catch (error) { showToast(error.message || "重新生成失敗", "error", 0); } finally { this.refreshing = ""; } },
      async buildWiki() { if (this.tourDemoBlocked()) return; this.building = true; try { await Api.post(`projects/${this.$route.params.id}/wiki/init`, {}); await this.loadPages(); if (this.tree.length) await this.loadPage(this.tree[0].slug); } catch (error) { showToast(error.message || "建立 Wiki 失敗", "error", 0); } finally { this.building = false; } },
    },
    template: `
      <section class="ui-next-page ui-next-wiki-page">
        <header class="ui-next-page-head"><div><button class="ui-next-back" @click="$router.push('/projects/'+$route.params.id)"><ui-next-icon name="arrow-left"/> 返回專案</button><p class="ui-next-eyebrow">專案知識庫</p><h1>Wiki</h1><p>集中人工備註、模組文件與 AI 產生的排障結論。</p></div><div class="ui-next-detail-actions"><button v-if="canBuild" class="ui-next-primary" @click="buildWiki" :disabled="building">{{ building?'建立中…':'建立 Wiki' }}</button><button @click="openAddPage($event)">新增頁面</button></div></header>
        <section v-if="building" class="ui-next-panel ui-next-wiki-progress"><div><b>{{ progress.message||'建立中…' }}</b><span>{{ progress.percent }}%</span></div><i><em :style="{width:progress.percent+'%'}"></em></i></section>
        <div class="ui-next-wiki-layout"><aside class="ui-next-panel ui-next-wiki-tree"><div class="ui-next-card-title"><h2>頁面</h2><span>{{ pages.length }}</span></div><p v-if="loading" class="ui-next-empty-inline">載入中…</p><div v-else-if="loadError" class="ui-next-error-text">頁面清單載入失敗：{{ loadError }}<button @click="loadPages">重試</button></div><template v-else><wiki-node v-for="node in tree" :key="node.id" :node="node" :depth="0" :current-slug="current&&current.slug" :refreshing="refreshing" :editing-slug="editingSlug" :menu-slug="menuSlug" @open="loadPage" @refresh="refreshNode" @remove="removePage" @menu="menuSlug=$event"/><div v-if="!pages.length&&!loading" class="ui-next-wiki-empty"><h3>這個專案還沒有 Wiki</h3><p>初始化後會由 AI 依程式碼產生頁面，之後可以逐頁重新生成。</p><button class="ui-next-primary" @click="buildWiki" :disabled="building">{{ building?'建立中…':'初始化 Wiki' }}</button></div></template></aside><main class="ui-next-panel ui-next-wiki-content"><template v-if="current"><header><div><p class="ui-next-eyebrow">{{ current.node_type==='notes'?'人工維護':'文件頁' }}</p><h2>{{ current.title }}</h2></div><div><button v-if="current.node_type!=='notes'&&!editing" @click="editing=true;editContent=current.content">編輯</button><button v-if="editing||current.node_type==='notes'" class="ui-next-primary" @click="save" :disabled="saving">{{ saving?'儲存中…':'儲存' }}</button><button v-if="editing&&current.node_type!=='notes'" @click="editing=false">取消</button></div></header><p v-if="current.node_type==='notes'" class="ui-next-field-note">這裡的內容會提供給 AI 作為專案優先脈絡。</p><textarea v-if="editing||current.node_type==='notes'" v-model="editContent" @input="editing=true"></textarea><article v-else class="ui-next-wiki-markdown" v-html="renderedContent"></article></template><div v-else class="ui-next-empty-state">選擇或建立一個頁面開始。</div></main></div>
        <div v-if="showAddModal" class="ui-next-task-modal-backdrop" @mousedown.self="closeAddPage" @keydown="trapAddPageFocus"><section ref="wikiAddModal" class="ui-next-task-modal" role="dialog" aria-modal="true" aria-labelledby="wiki-add-title"><header><h2 id="wiki-add-title">新增頁面</h2><button type="button" aria-label="關閉新增頁面視窗" @click="closeAddPage"><ui-next-icon name="close"/></button></header><label>標題<input ref="newTitleInput" v-model="newPageTitle" @input="onTitleInput" @keyup.enter="submitAddPage" placeholder="例如：銷售訂單模組"></label><label>Slug<input v-model="newPageSlug" @input="onSlugInput" @keyup.enter="submitAddPage" placeholder="例如：sale-order"></label><p v-if="addPageError" class="ui-next-inline-error" role="alert">{{ addPageError }}</p><footer><button type="button" @click="closeAddPage">取消</button><button class="ui-next-primary" @click="submitAddPage" :disabled="addingPage||!newPageTitle.trim()||!newPageSlug.trim()">{{ addingPage?'新增中…':'新增' }}</button></footer></section></div>
      </section>`,
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

  window.UiNextDeploySopView = Vue.defineComponent({
    name: "UiNextDeploySopView",
    // 內嵌成專案頁的「部署 SOP」頁籤時不轉址；直接開舊網址才轉。
    props: { embedded: { type: Boolean, default: false } },
    components: { UiNextIcon: window.UiNextIcon },
    data() {
      return {
        loading: true,
        project: null,
        repos: [],
        conns: [],
        // 使用者填的伺服器事實。connId 決定 SSH／DB 名稱從哪個連線帶，其餘四欄是第 1 步查出來的。
        prod: { connId: '', service: '', conf: '', addons: '', port: '8069' },
        test: { connId: '', service: '', conf: '', addons: '', port: '8070' },
        repoUrl: '',
        addon: '',
        branchTest: 'ai-dev',
        branchProd: 'main'
      };
    },
    async created() {
      // 這一頁已內嵌成專案頁的「部署 SOP」頁籤，舊網址轉過去即可。
      if (!this.embedded) { this.$router.replace(`/projects/${this.$route.params.id}?tab=sop`); return; }
 await this.load(); },
    computed: {
      // 兩區的表單長得一樣，用同一段 template 跑兩次；帶的是 data 物件本身的參照，
      // 不是 'prod'／'test' 字串——template 裡沒有 this，用字串索引取不到東西。
      sides() {
        return [
          { key: 'prod', label: '正式區', d: this.prod, conn: this.prodConn, ssh: this.sshProd },
          { key: 'test', label: '測試區', d: this.test, conn: this.testConn, ssh: this.sshTest }
        ];
      },
      prodConn() { return this.conns.find(c => String(c.id) === String(this.prod.connId)) || null; },
      testConn() { return this.conns.find(c => String(c.id) === String(this.test.connId)) || null; },
      // 兩區指到同一個連線＝八成是還沒指認完，後面每一段指令都會把正式區的值填進測試區
      sameConn() {
        return !!this.prod.connId && String(this.prod.connId) === String(this.test.connId);
      },
      sshProd() { return this.sshLine(this.prodConn); },
      sshTest() { return this.sshLine(this.testConn); },
      cmdInspect() {
        return [
          '# 1) 有哪些 Odoo 服務、各自吃哪個設定檔',
          'systemctl list-units --type=service | grep -i odoo',
          'systemctl cat <服務名> | grep -E "ExecStart|Environment"',
          '',
          '# 2) 設定檔裡的 addons 路徑、port、資料庫',
          'grep -nE "addons_path|http_port|db_name|db_user" <設定檔路徑>',
          '',
          '# 3) 自訂模組在哪、屬於誰（權限決定 runner 帳號能不能寫）',
          'ls -l <addons 路徑>'
        ].join('\n');
      },
      cmdBackup() {
        const p = this.v(this.prod.addons, '<正式 addons 路徑>');
        return [
          '# 先備份整包 addons（切換前唯一的退路）',
          `sudo tar czf ~/addons-backup-$(date +%F).tar.gz ${p}`,
          '',
          '# 再把伺服器上的現況跟 repo 逐檔比對——這一步不能跳過：',
          '# 伺服器上若有人手改過而 repo 沒有，切換過去就靜默弄丟，且沒有任何錯誤訊息。',
          `git clone ${this.v(this.repoUrl, '<repo URL>')} ~/repo-check`,
          `diff -r ${p} ~/repo-check/${this.v(this.addon, '<模組名>')} | head -50`
        ].join('\n');
      },
      cmdAttachGit() {
        const conf = this.v(this.test.conf, '<測試設定檔路徑>');
        const dir = this.newAddonsDir(this.test.addons);
        return [
          '# 不在原地 git init 硬蓋既有目錄——那樣要復原只能靠備份。',
          '# 改成另 clone 一份、把設定檔的 addons_path 指過去，舊目錄原封不動留著當退路。',
          `git clone -b ${this.branchTest} ${this.v(this.repoUrl, '<repo URL>')} ${dir}`,
          '',
          '# 設定檔改 addons_path（先備份設定檔本身）',
          `sudo cp ${conf} ${conf}.bak`,
          `sudo sed -i "s#${this.v(this.test.addons, '<舊 addons 路徑>')}#${dir}#" ${conf}`,
          `grep -n addons_path ${conf}`,
          '',
          '# 重啟並確認服務起得來',
          `sudo systemctl restart ${this.v(this.test.service, '<測試服務名>')}`,
          `systemctl status ${this.v(this.test.service, '<測試服務名>')} --no-pager`,
          '',
          '# 正式區同樣做一次（確認測試區沒問題之後再做）'
        ].join('\n');
      },
      cmdRunner() {
        return [
          '# GitHub → repo → Settings → Actions → Runners → New self-hosted runner（Linux x64）',
          '# 照該頁給的 token 執行，以下是形狀，token 請用它產的那一串',
          'mkdir ~/actions-runner && cd ~/actions-runner',
          'curl -o actions-runner-linux-x64.tar.gz -L <該頁給的下載網址>',
          'tar xzf actions-runner-linux-x64.tar.gz',
          './config.sh --url <repo 網址> --token <該頁給的 token> --labels odoo-tower',
          '',
          '# 裝成開機自動啟動的服務（不要用 ./run.sh，斷線就停）',
          'sudo ./svc.sh install',
          'sudo ./svc.sh start',
          'sudo ./svc.sh status'
        ].join('\n');
      },
      cmdSudoers() {
        const u = (this.prodConn && this.prodConn.ssh_user) || '<登入帳號>';
        const sp = this.v(this.prod.service, '<正式服務名>');
        const st = this.v(this.test.service, '<測試服務名>');
        return [
          '# runner 是非互動執行，sudo 不能停下來問密碼。只開這幾條、不要給整個 NOPASSWD:ALL。',
          'sudo visudo -f /etc/sudoers.d/odoo-deploy',
          '',
          '# 貼入：',
          `${u} ALL=(ALL) NOPASSWD: /bin/systemctl start ${sp}, /bin/systemctl stop ${sp}, /bin/systemctl restart ${sp}, /bin/systemctl status ${sp}`,
          `${u} ALL=(ALL) NOPASSWD: /bin/systemctl start ${st}, /bin/systemctl stop ${st}, /bin/systemctl restart ${st}, /bin/systemctl status ${st}`
        ].join('\n');
      },
      // deploy.yml：兩個分支各自對應一區。用 ${{ }} 的地方一律走單引號字串，避免被 JS 樣板字串吃掉。
      deployYaml() {
        const L = [];
        L.push('name: deploy');
        L.push('');
        L.push('on:');
        L.push('  push:');
        L.push('    branches: [' + this.branchTest + ', ' + this.branchProd + ']');
        L.push('');
        L.push('jobs:');
        L.push('  deploy:');
        L.push('    runs-on: [self-hosted, odoo-tower]');
        L.push('    steps:');
        L.push('      - uses: actions/checkout@v4');
        L.push('');
        L.push('      - name: 決定要部署哪一區');
        L.push('        id: target');
        L.push('        run: |');
        L.push("          if [ \"${{ github.ref_name }}\" = \"" + this.branchProd + '" ]; then');
        L.push('            echo "dir=' + this.newAddonsDir(this.prod.addons) + '" >> $GITHUB_OUTPUT');
        L.push('            echo "svc=' + this.v(this.prod.service, '<正式服務名>') + '" >> $GITHUB_OUTPUT');
        L.push('            echo "conf=' + this.v(this.prod.conf, '<正式設定檔>') + '" >> $GITHUB_OUTPUT');
        L.push('            echo "db=' + this.dbOf(this.prodConn) + '" >> $GITHUB_OUTPUT');
        L.push('            echo "port=' + this.v(this.prod.port, '8069') + '" >> $GITHUB_OUTPUT');
        L.push('            echo "prod=1" >> $GITHUB_OUTPUT');
        L.push('          else');
        L.push('            echo "dir=' + this.newAddonsDir(this.test.addons) + '" >> $GITHUB_OUTPUT');
        L.push('            echo "svc=' + this.v(this.test.service, '<測試服務名>') + '" >> $GITHUB_OUTPUT');
        L.push('            echo "conf=' + this.v(this.test.conf, '<測試設定檔>') + '" >> $GITHUB_OUTPUT');
        L.push('            echo "db=' + this.dbOf(this.testConn) + '" >> $GITHUB_OUTPUT');
        L.push('            echo "port=' + this.v(this.test.port, '8070') + '" >> $GITHUB_OUTPUT');
        L.push('            echo "prod=0" >> $GITHUB_OUTPUT');
        L.push('          fi');
        L.push('');
        L.push('      - name: 拉最新程式碼');
        L.push('        run: |');
        L.push('          cd ${{ steps.target.outputs.dir }}');
        L.push('          git fetch --all');
        L.push('          git reset --hard origin/${{ github.ref_name }}');
        L.push('');
        L.push('      - name: 依這次改動的檔案推算要升級哪些模組');
        L.push('        id: mods');
        L.push('        run: |');
        L.push('          BEFORE="${{ github.event.before }}"');
        L.push('          case "$BEFORE" in 0000000*|"") BEFORE="HEAD~1" ;; esac');
        L.push('          MODS=$(git diff --name-only "$BEFORE" "${{ github.sha }}" \\');
        L.push("            | cut -d/ -f1 | sort -u | grep -v '^\\.' | paste -sd, -)");
        L.push('          echo "list=${MODS}" >> $GITHUB_OUTPUT');
        L.push('          echo "要升級：${MODS:-（無，跳過）}"');
        L.push('');
        L.push('      - name: 正式區升級前先備份資料庫');
        L.push("        if: steps.target.outputs.prod == '1' && steps.mods.outputs.list != ''");
        L.push('        run: |');
        L.push('          pg_dump -Fc -d ${{ steps.target.outputs.db }} \\');
        L.push('            -f ~/db-backup-${{ steps.target.outputs.db }}-$(date +%F-%H%M).dump');
        L.push('');
        L.push('      - name: 停服務 → 升級 → 起服務');
        L.push("        if: steps.mods.outputs.list != ''");
        L.push('        run: |');
        L.push('          sudo systemctl stop ${{ steps.target.outputs.svc }}');
        L.push('          odoo-bin -c ${{ steps.target.outputs.conf }} \\');
        L.push('            -d ${{ steps.target.outputs.db }} \\');
        L.push('            -u ${{ steps.mods.outputs.list }} --stop-after-init');
        L.push('          sudo systemctl start ${{ steps.target.outputs.svc }}');
        L.push('');
        L.push('      - name: 起得來才算成功');
        L.push('        run: |');
        L.push('          for i in $(seq 1 30); do');
        L.push('            curl -sf http://localhost:${{ steps.target.outputs.port }}/web/login > /dev/null && exit 0');
        L.push('            sleep 2');
        L.push('          done');
        L.push('          echo "服務沒起來"; sudo journalctl -u ${{ steps.target.outputs.svc }} -n 80 --no-pager; exit 1');
        return L.join('\n');
      },
      cmdVerify() {
        return [
          '# 1) 推一個無害的改動到測試分支，到 GitHub → Actions 看那一輪跑完是綠的',
          `git commit --allow-empty -m "test: 驗證自動部署" && git push origin ${this.branchTest}`,
          '',
          '# 2) 伺服器上確認碼真的換了（不是 workflow 綠但沒動到）',
          `cd ${this.newAddonsDir(this.test.addons)} && git log -1 --oneline`,
          '',
          '# 3) 確認模組真的升級過，而不是只重啟',
          `sudo journalctl -u ${this.v(this.test.service, '<測試服務名>')} -n 50 --no-pager | grep -i "module .* loaded"`
        ].join('\n');
      }
    },
    methods: {
      pid() { return this.$route.params.id; },
      async load() {
        this.loading = true;
        try {
          const [proj, conns] = await Promise.all([
            Api.get(`projects/${this.pid()}`),
            Api.get(`projects/${this.pid()}/db-connections`).catch(() => [])
          ]);
          this.project = proj;
          this.repos = proj.repos || [];
          this.conns = conns || [];
          const primary = this.repos.find(r => r.is_primary) || this.repos[0];
          if (primary) this.repoUrl = primary.repo_url || '';
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.loading = false; }
      },
      // 未填的欄位不要靜默留空——留空會生出看似完整、實際會刪錯目錄的指令。
      v(val, placeholder) { return (val || '').trim() || placeholder; },
      dbOf(conn) { return (conn && conn.db_name) || '<資料庫名稱>'; },
      // direct 模式的連線（DBeaver 式直連 TCP）沒有 SSH 欄位，硬組會生出 `ssh @` 這種東西。
      // 缺就回空、由 template 不顯示那一行——這頁後面的指令都要 SSH 進機器才做得了，
      // 選到這種連線本來就得換一個。
      sshLine(conn) {
        if (!conn || !conn.ssh_host || !conn.ssh_user) return '';
        const port = conn.ssh_port && conn.ssh_port !== 22 ? ` -p ${conn.ssh_port}` : '';
        return `ssh${port} ${conn.ssh_user}@${conn.ssh_host}`;
      },
      // 舊目錄留著當備份，新的 clone 到隔壁：<原路徑>_git
      newAddonsDir(oldPath) {
        const p = (oldPath || '').trim();
        return p ? `${p}_git` : '<新的 addons 路徑>';
      },
      onConnPick(side) {
        const conn = side === 'prod' ? this.prodConn : this.testConn;
        if (!conn) return;
        // log_unit 存的就是 journalctl 要跟的那個 systemd unit——同一個值，不必再問一次
        if (conn.log_unit && !this[side].service) this[side].service = conn.log_unit;
      },
      copyBlockers(text) {
        const seen = SOP_FILLABLE_PLACEHOLDERS.filter(([token]) => (text || '').includes(token)).map(([, field]) => field);
        return [...new Set(seen)];
      },
      copyReady(text) { return !!text && !this.copyBlockers(text).length; },
      copyHint(text) {
        const blockers = this.copyBlockers(text);
        return blockers.length ? `還有欄位沒填，複製出去的指令會帶著佔位符：${blockers.join('、')}` : '複製整段指令';
      },
      async copy(text) {
        try { await navigator.clipboard.writeText(text || ''); showToast('已複製', 'success'); }
        catch (_) { showToast('複製失敗，請手動選取', 'error'); }
      }
    },
    template: `<section class="ui-next-page ui-next-sop-page">
<header class="ui-next-page-head"><div><button class="ui-next-back" @click="$router.push('/projects/'+pid())"><ui-next-icon name="arrow-left"/>返回專案</button><p class="ui-next-eyebrow">交付工具</p><h1>自動部署 SOP</h1><p><template v-if="project">專案：<b>{{ project.name }}</b> · </template>將測試與正式環境的必要事實整理成可逐步驗證的部署流程。</p></div></header>
<div v-if="loading" class="ui-next-loading-card">載入專案設定中…</div>
<template v-else>
<section class="ui-next-panel">
<h2>這頁在做什麼</h2>
<p class="sop-desc">做完之後，程式碼推上 <code class="sop-code">{{ branchTest }}</code> 會自動部署到測試區、推上 <code class="sop-code">{{ branchProd }}</code> 會自動部署到正式區——拉最新碼、升級有改動的模組、重啟服務、確認起得來。觸發走 GitHub self-hosted runner（伺服器主動連外，不必開任何對外埠），部署歷史留在 repo 的 Actions 頁。</p>
<div class="sop-warn"><b>先知道代價：</b>正式區是全自動、沒有人工關卡。任何人把東西併進 <code class="sop-code">{{ branchProd }}</code>，正式區就會在數十秒內重啟一次，不分上下班時段。不接受這件事就別接正式區那條，只接測試區。</div>
</section>
<section v-if="!conns.length" class="ui-next-panel">
<h2>先設定這個專案的資料庫連線</h2>
<p class="sop-desc">這頁要用到 SSH 位址與資料庫名稱，都放在「資料庫查詢」的連線設定裡。設好之後回到這頁，下面的指令就會自動填入真值。</p>
<button class="ui-next-primary" @click="$router.push('/projects/'+pid()+'/db')">前往設定連線</button>
</section>
<section class="ui-next-panel">
<h2>你的環境</h2>
<p class="ui-next-field-note">填在這裡的值只會用來把下面的指令填成真值，<b>不會存起來</b>——重新整理就沒了。伺服器上的路徑會隨時間變動，存下來反而會讓人照著過期的指令跑。</p>
<div class="ui-next-sop-grid">
<article v-for="side in sides" :key="side.key">
<h3>{{ side.label }}</h3>
<label>對應的連線<select v-model="side.d.connId" @change="onConnPick(side.key)"><option value="">— 請指認 —</option><option v-for="conn in conns" :key="conn.id" :value="conn.id">{{ conn.name }}（{{ conn.db_name }}）</option></select></label>
<div v-if="side.conn" class="ui-next-sop-facts">
<div v-if="side.ssh">SSH：<code class="sop-code">{{ side.ssh }}</code></div>
<div v-else class="ui-next-warn-text">這個連線是直連模式、沒有 SSH 資訊，下面的指令要自己找機器登入</div>
<div>資料庫：<code class="sop-code">{{ dbOf(side.conn) }}</code></div>
</div>
<label>systemd 服務名<input v-model="side.d.service" placeholder="例：odoo-server.service"></label>
<label>設定檔路徑<input v-model="side.d.conf" placeholder="例：/etc/odoo-server.conf"></label>
<label>目前的 addons 路徑<input v-model="side.d.addons" placeholder="例：/odoo/custom/addons"></label>
<label>HTTP port<input v-model="side.d.port" placeholder="例：8069"></label>
</article>
</div>
<p v-if="sameConn" class="ui-next-error-text">正式區與測試區指到同一個連線。下面每一段指令都會把同一個資料庫名稱填進兩區——先分開指認再往下做。</p>
</section>
<section class="ui-next-panel">
<h2>Repo 與分支</h2>
<div class="ui-next-sop-fields">
<label>repo URL<input v-model="repoUrl" placeholder="git@github.com:org/repo.git"></label>
<label>自訂模組名（用來跟伺服器現況比對）<input v-model="addon" placeholder="例：idx_xxx"></label>
<label>測試區對應分支<input v-model="branchTest"></label>
<label>正式區對應分支<input v-model="branchProd"></label>
</div>
</section>
<section class="ui-next-panel ui-next-sop-steps">
<article>
<header><span>1</span><h2>查出伺服器現況</h2><button @click="copy(cmdInspect)" :disabled="!copyReady(cmdInspect)" :title="copyHint(cmdInspect)" :aria-label="copyHint(cmdInspect)">複製</button></header>
<p class="sop-desc">SSH 進伺服器，把上面那四欄查出來填好。正式與測試常在同一台機器上、只是不同 service 與不同設定檔，所以每一項都要分別確認，不要用一區的值推另一區。</p>
<pre>{{ cmdInspect }}</pre>
<p v-if="!copyReady(cmdInspect)" class="ui-next-sop-blocked">{{ copyHint(cmdInspect) }}</p>
<div class="sop-note">設定檔裡若<b>沒有</b> <code class="sop-code">db_name</code>，代表是多資料庫模式——後面的升級指令一定要明確帶 <code class="sop-code">-d</code>，否則 Odoo 不知道要升級哪個庫。</div>
</article>
<article>
<header><span>2</span><h2>備份與比對既有 addons</h2><button @click="copy(cmdBackup)" :disabled="!copyReady(cmdBackup)" :title="copyHint(cmdBackup)" :aria-label="copyHint(cmdBackup)">複製</button></header>
<p class="sop-desc">自動部署會用 repo 的內容覆蓋伺服器上的模組。若伺服器上曾有人直接改檔而沒進 repo，切換過去的那一刻就會靜默弄丟。<b>比對出差異就先停下來，把它補進 repo 再繼續。</b></p>
<pre>{{ cmdBackup }}</pre>
<p v-if="!copyReady(cmdBackup)" class="ui-next-sop-blocked">{{ copyHint(cmdBackup) }}</p>
</article>
<article>
<header><span>3</span><h2>建立 Git 部署目錄</h2><button @click="copy(cmdAttachGit)" :disabled="!copyReady(cmdAttachGit)" :title="copyHint(cmdAttachGit)" :aria-label="copyHint(cmdAttachGit)">複製</button></header>
<p class="sop-desc">伺服器上的 addons 目錄通常不是 git repo，這是整件事真正的工作量。作法是<b>另 clone 一份到隔壁</b>、把設定檔的 <code class="sop-code">addons_path</code> 指過去，舊目錄原封不動留著——要復原只要把設定檔改回來、重啟即可。先做測試區，確認服務起得來、頁面正常，再對正式區做同一件事。</p>
<pre>{{ cmdAttachGit }}</pre>
<p v-if="!copyReady(cmdAttachGit)" class="ui-next-sop-blocked">{{ copyHint(cmdAttachGit) }}</p>
<div class="sop-note">新目錄的擁有者要讓 runner 的執行帳號寫得進去（<code class="sop-code">chown</code> 給登入帳號、群組留給 odoo），否則自動部署會停在 <code class="sop-code">Permission denied</code>。</div>
</article>
<article>
<header><span>4</span><h2>設定 GitHub Runner</h2><button @click="copy(cmdRunner)" :disabled="!copyReady(cmdRunner)" :title="copyHint(cmdRunner)" :aria-label="copyHint(cmdRunner)">複製</button></header>
<p class="sop-desc">runner 由伺服器主動連去 GitHub 取工作，不需要對外開任何埠，也不必讓 GitHub 連得到你的機器。指令裡的尖括號（下載網址、repo 網址、token）要照 GitHub 那頁給的值自己換掉。</p>
<pre>{{ cmdRunner }}</pre>
<p v-if="!copyReady(cmdRunner)" class="ui-next-sop-blocked">{{ copyHint(cmdRunner) }}</p>
</article>
<article>
<header><span>5</span><h2>最小權限 sudo</h2><button @click="copy(cmdSudoers)" :disabled="!copyReady(cmdSudoers)" :title="copyHint(cmdSudoers)" :aria-label="copyHint(cmdSudoers)">複製</button></header>
<p class="sop-desc">runner 是非互動執行，<code class="sop-code">sudo</code> 停下來問密碼就等於卡死。只開需要的那幾條，不要給整個 <code class="sop-code">NOPASSWD:ALL</code>。</p>
<pre>{{ cmdSudoers }}</pre>
<p v-if="!copyReady(cmdSudoers)" class="ui-next-sop-blocked">{{ copyHint(cmdSudoers) }}</p>
<div class="sop-warn">重啟服務時若出現 <code class="sop-code">unit file changed on disk</code> 警告，代表有人改過 unit 檔但沒 reload——<b>先看清楚被改了什麼</b>再 <code class="sop-code">sudo systemctl daemon-reload</code>。放著不管的話，之後每次自動部署都會套用舊定義。</div>
</article>
<article>
<header><span>6</span><h2>部署 workflow</h2><button @click="copy(deployYaml)" :disabled="!copyReady(deployYaml)" :title="copyHint(deployYaml)" :aria-label="copyHint(deployYaml)">複製</button></header>
<p class="sop-desc">存成 repo 的 <code class="sop-code">.github/workflows/deploy.yml</code>（放在客戶的 addons repo，不是平台 repo）。兩個分支各對應一區，流程是<b>停服務 → 升級 → 起服務 → curl 驗證</b>：不在服務運行中對同一個資料庫再跑第二個 odoo-bin。</p>
<pre>{{ deployYaml }}</pre>
<p v-if="!copyReady(deployYaml)" class="ui-next-sop-blocked">{{ copyHint(deployYaml) }}</p>
<div class="sop-warn"><b>刻意不做的兩件事：</b><br />1. <b>不自動 <code class="sop-code">pip install</code></b>——正式與測試若共用同一份 site-packages，這是唯一「動測試區會弄壞正式區」的路徑。缺套件就讓它紅燈，人工處理。<br />2. <b>失敗不自動回滾</b>——回滾一個已經改過 schema 的升級比停在壞掉的狀態更危險。失敗就讓 workflow 紅燈，人去看。</div>
</article>
<article>
<header><span>7</span><h2>驗證測試區</h2><button @click="copy(cmdVerify)" :disabled="!copyReady(cmdVerify)" :title="copyHint(cmdVerify)" :aria-label="copyHint(cmdVerify)">複製</button></header>
<p class="sop-desc">workflow 綠燈只代表指令沒有回傳錯誤，不代表碼換了、模組升級了。三件事都確認過才算接完。</p>
<pre>{{ cmdVerify }}</pre>
<p v-if="!copyReady(cmdVerify)" class="ui-next-sop-blocked">{{ copyHint(cmdVerify) }}</p>
<div class="sop-note">測試區跑順了再把正式區接上去。正式區第一次上線建議挑離峰時段，並在旁邊看完整輪。</div>
</article>
</section>
</template>
</section>`,
  });
  window.UiNextTerminalView = Vue.defineComponent({
    name: "UiNextTerminalView",
    components: { UiNextIcon: window.UiNextIcon },
    data() { return { taskId: null, taskTitle: "", exitCode: null, running: false, error: "" }; },
    async created() { this.taskId = Number(this.$route.params.id); try { const data = await Api.get(`tasks/${this.taskId}`), task = data.task || data; this.taskTitle = task.title || task.task_id || `Task ${this.taskId}`; this.running = ["analysis_running", "cs_running", "coding_running", "qa_running", "merge_running", "deploy_testing", "playwright_running", "wiki_updating"].includes(task.status); } catch (error) { this.error = error.message || "無法載入任務"; } },
    async mounted() { if (this.error || !window.Terminal) return; const term = new Terminal({ theme: { background: "#1a1a1a", foreground: "#f0f0f0" }, fontSize: 13, fontFamily: "Consolas, monospace", convertEol: true, scrollback: 5000 }); term.open(this.$refs.termContainer); this._term = term; try { const events = await Api.get(`tasks/${this.taskId}/events`); if (Array.isArray(events) && events.length) events.forEach((event) => term.write(event.content)); else term.writeln("\x1b[90m（尚無執行紀錄）\x1b[0m"); } catch {} this._outputHandler = (data) => { if (data.taskId === this.taskId) term.write(data.data); }; this._doneHandler = (data) => { if (data.taskId === this.taskId) { this.exitCode = data.exitCode; this.running = false; term.writeln(`\r\n\x1b[${data.exitCode === 0 ? "32" : "31"}m[Process exited with code ${data.exitCode}]\x1b[0m`); } }; window._socket?.on("terminal:output", this._outputHandler); window._socket?.on("terminal:done", this._doneHandler); },
    beforeUnmount() { window._socket?.off("terminal:output", this._outputHandler); window._socket?.off("terminal:done", this._doneHandler); this._term?.dispose(); },
    template: `<section class="ui-next-page ui-next-terminal-page"><header class="ui-next-page-head"><div><button class="ui-next-back" @click="$router.push('/task/'+taskId)"><ui-next-icon name="arrow-left"/> 返回任務</button><p class="ui-next-eyebrow">執行歷程</p><h1>{{ taskTitle }}</h1><p>{{ running ? '執行中，等待新輸出' : exitCode === null ? '任務尚未啟動' : exitCode === 0 ? '任務已成功結束' : '任務已結束，請查看錯誤輸出' }}</p></div></header><p v-if="error" class="ui-next-error-text">{{ error }}</p><section v-else class="ui-next-panel ui-next-terminal-panel"><div class="ui-next-terminal-status"><span>{{ running ? '執行中…' : exitCode === 0 ? '成功' : exitCode !== null ? '失敗（code ' + exitCode + '）' : '待機' }}</span><span v-if="!running && exitCode === null" class="ui-next-terminal-wait">等待 pipeline 啟動…</span></div><p class="ui-next-field-note">終端內容固定寬度；小螢幕僅在此區域可左右捲動。</p><div ref="termContainer" class="ui-next-terminal-output"></div></section></section>`,
  });
  window.UiNextAdminView = Vue.defineComponent({
    name: "UiNextAdminView",
    data() { return { cards: [
      { to: "/admin/settings", title: "系統設定", detail: "Odoo／eService 連線、Teams、Claude 與 Codex 憑證、用量閘門、context7、語意索引" },
      { to: "/admin/users", title: "使用者管理", detail: "帳號、角色與核准狀態" },
      { to: "/admin/agents", title: "Agent 管理", detail: "模型、提示詞與執行設定" },
      { to: "/admin/schedules", title: "排程", detail: "背景工作與執行週期" },
      { to: "/admin/health", title: "工作流程健檢", detail: "健康度與改善建議" },
      { to: "/admin/rejections", title: "退回原因", detail: "人工退回與分類" },
      { to: "/admin/classify-samples", title: "失敗分類樣本", detail: "待人工歸納的案例" },
      { to: "/admin/prompt-logs", title: "Prompt 記錄", detail: "送往 AI 的提示詞" },
      { to: "/admin/port-pool", title: "測試區 Port 池", detail: "Port 租用與狀態" },
      { to: "/admin/enterprise", title: "企業版來源", detail: "Enterprise addons 同步" },
    ] }; },
    template: `<section class="ui-next-page ui-next-admin-page"><header class="ui-next-page-head"><div><h1>管理員設定</h1><p>從工具卡進入特定維運工作，避免在首頁同時載入互不相關的設定表單。</p></div></header><section class="ui-next-admin-cards"><router-link v-for="card in cards" :key="card.to" :to="card.to" class="ui-next-panel"><h2>{{ card.title }}</h2><p>{{ card.detail }}</p></router-link></section></section>`,
  });
  window.UiNextDbView = Vue.defineComponent({
    name: "UiNextDbView",
    // 內嵌成專案頁的「連線設定」頁籤時不轉址；直接開舊網址才轉。
    props: { embedded: { type: Boolean, default: false } },
    data() {
      return {
        conns: [], loading: true, saving: false, running: false, testing: false, probing: false,
        form: { id: null, name: '', ssh_host: '', ssh_port: 22, ssh_user: '', auth_type: 'password', ssh_password: '', ssh_key_content: '', connect_mode: 'docker', docker_container: 'odoo-db', db_user: 'odoo', sudo_user: 'odoo', db_name: 'odoo_prd', db_host: '', db_port: 5432, db_password: '', db_ssl: false, db_engine: 'postgres', description: '', vpn_enabled: false, log_mode: '', log_container: '', log_unit: '', log_path: '', log_tz_offset: null },
        vpn: { has_config: false, vpn_username: '' },
        vpnForm: { vpn_config: '', vpn_config_name: '', vpn_username: '', vpn_password: '' },
        vpnSaving: false,
        selectedId: '', sql: '', result: null, error: ''
      };
    },
    async created() {
      // 這一頁已內嵌成專案頁的「連線設定」頁籤，舊網址轉過去即可。
      if (!this.embedded) { this.$router.replace(`/projects/${this.$route.params.id}?tab=db`); return; }
 await Promise.all([this.load(), this.loadVpn()]); },
    methods: {
      pid() { return this.$route.params.id; },
      // 新手教程的示範專案：連線與查詢結果來自 tour-demo.js，不打 API
      isTourDemo() { return !!(window.TourDemo && window.TourDemo.isProject(this.pid())); },
      async load() {
        if (this.isTourDemo()) {
          const d = window.TourDemo.db();
          // 連查詢結果一起帶上：查詢區空著就沒東西可指，也看不出「查得到什麼」
          this.conns = d.conns; this.selectedId = d.conns[0].id; this.sql = d.sql; this.result = d.result;
          this.loading = false;
          return;
        }
        this.loading = true;
        try { this.conns = await Api.get(`projects/${this.pid()}/db-connections`); }
        catch (e) { showToast(e.message, 'error'); }
        finally { this.loading = false; }
      },
      resetForm() { this.form = { id: null, name: '', ssh_host: '', ssh_port: 22, ssh_user: '', auth_type: 'password', ssh_password: '', ssh_key_content: '', connect_mode: 'docker', docker_container: 'odoo-db', db_user: 'odoo', sudo_user: 'odoo', db_name: 'odoo_prd', db_host: '', db_port: 5432, db_password: '', db_ssl: false, db_engine: 'postgres', description: '', vpn_enabled: false, log_mode: '', log_container: '', log_unit: '', log_path: '', log_tz_offset: null }; },
      editConn(c) { this.form = { ...c, ssh_password: '', db_password: '' }; },
      validForm() {
        if (this.form.connect_mode === 'direct')
          return this.form.name && this.form.db_host && this.form.db_user && (this.form.id || this.form.db_password) && this.form.db_name;
        return this.form.name && this.form.ssh_host && this.form.ssh_user && this.form.db_name;
      },
      async testConn() {
        this.testing = true;
        try {
          const r = await Api.post(`projects/${this.pid()}/db-connections/test`, this.form);
          if (r.ok) showToast('連線成功', 'success'); else showToast('連線失敗：' + (r.error || '未知錯誤'), 'error');
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.testing = false; }
      },
      async loadVpn() {
        if (this.isTourDemo()) { this.vpn = window.TourDemo.db().vpn; this.vpnForm.vpn_username = this.vpn.vpn_username; return; }
        try {
          this.vpn = await Api.get(`projects/${this.pid()}/vpn`);
          this.vpnForm.vpn_username = this.vpn.vpn_username || '';
        } catch (e) { showToast(e.message, 'error'); }
      },
      onVpnFileChange(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          this.vpnForm.vpn_config = reader.result;
          this.vpnForm.vpn_config_name = file.name;
          // 部分廠牌 GUI（如鴻久 SSLVPN）把帳密存成 openvpn 會忽略的 # 註解欄位，且做過混淆；
          // 抓得到就還原後代填（原樣帶入會存成連不上的亂碼帳號）。
          const userMatch = reader.result.match(/^#SSLVPN_AUTH_USERNAME=(.*)$/m);
          const passMatch = reader.result.match(/^#SSLVPN_AUTH_PASSWORD=(.*)$/m);
          if (userMatch && userMatch[1].trim()) this.vpnForm.vpn_username = DEOBFUSCATE_SSLVPN(userMatch[1].trim());
          if (passMatch && passMatch[1].trim()) this.vpnForm.vpn_password = DEOBFUSCATE_SSLVPN(passMatch[1].trim());
          if (userMatch || passMatch) showToast('已從設定檔帶入 VPN 帳密（已還原混淆），請確認無誤', 'success');
        };
        reader.readAsText(file);
      },
      async saveVpn() {
        this.vpnSaving = true;
        try {
          await Api.put(`projects/${this.pid()}/vpn`, {
            vpn_config: this.vpnForm.vpn_config || undefined,
            vpn_username: this.vpnForm.vpn_username,
            vpn_password: this.vpnForm.vpn_password || undefined,
          });
          this.vpnForm.vpn_config = '';
          this.vpnForm.vpn_config_name = '';
          this.vpnForm.vpn_password = '';
          await this.loadVpn();
          showToast('已儲存專案 VPN 設定', 'success');
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.vpnSaving = false; }
      },
      async saveConn() {
        if (!this.validForm()) return showToast(this.form.connect_mode === 'direct' ? '名稱/DB主機/DB使用者/密碼/資料庫 必填' : '名稱/主機/使用者/資料庫 必填', 'error');
        this.saving = true;
        try {
          if (this.form.id) await Api.put(`projects/${this.pid()}/db-connections/${this.form.id}`, this.form);
          else await Api.post(`projects/${this.pid()}/db-connections`, this.form);
          this.resetForm(); await this.load(); showToast('已儲存連線', 'success');
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.saving = false; }
      },
      async probeLog() {
        // 探測端點吃 :cid，未存過的連線沒有 id
        if (!this.form.id) return showToast('請先儲存連線，再偵測 log 來源', 'error');
        this.probing = true;
        try {
          const r = await Api.post(`projects/${this.pid()}/db-connections/${this.form.id}/probe-log`, {});
          if (!r.ok) return showToast(r.error || '偵測失敗', 'error');
          // 探測成功已寫回 DB，同步更新表單與清單
          this.form.log_mode = r.log_mode || '';
          this.form.log_container = r.log_container || '';
          this.form.log_unit = r.log_unit || '';
          this.form.log_path = r.log_path || '';
          this.form.log_tz_offset = r.log_tz_offset;
          showToast(`偵測成功：${r.log_mode}`, 'success');
          await this.load();
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.probing = false; }
      },
      async deleteConn(c) {
        if (!await confirmDialog({ title: '刪除連線', message: `確定刪除連線「${c.name}」？`, danger: true, confirmText: '刪除' })) return;
        try { await Api.delete(`projects/${this.pid()}/db-connections/${c.id}`); await this.load(); showToast('已刪除', 'success'); }
        catch (e) { showToast(e.message, 'error'); }
      },
      async runQuery() {
        if (!this.selectedId) return showToast('請先選連線', 'error');
        if (!this.sql.trim()) return showToast('請輸入 SQL', 'error');
        this.running = true; this.result = null; this.error = '';
        try {
          const r = await Api.post(`projects/${this.pid()}/db-connections/${this.selectedId}/query`, { sql: this.sql });
          if (r.ok) this.result = r; else this.error = r.error || '查詢失敗';
        } catch (e) { this.error = e.message; }
        finally { this.running = false; }
      }
    },
    template: `
      <div class="topbar">
        <button class="btn btn-outline btn-sm" @click="$router.push('/projects/'+pid())" style="margin-right:var(--space-3)">← 返回專案</button>
        <h1>資料庫查詢</h1>
      </div>
      <div class="content" v-if="loading">
        <div class="settings-section">
          <h2 class="section-title">連線管理</h2>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>名稱</th><th>主機</th><th>模式</th><th>DB</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="i in 3" :key="i">
                  <td><Skeleton width="100px" /></td>
                  <td><Skeleton width="160px" /></td>
                  <td><Skeleton width="60px" /></td>
                  <td><Skeleton width="90px" /></td>
                  <td><Skeleton width="110px" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="content" v-else>
        <div class="settings-section" data-tour="db-vpn" style="margin-bottom:var(--space-5)">
          <h2 class="section-title">
            專案 VPN 設定
            <span v-if="vpn.has_config" style="font-size:var(--fs-xs);padding:1px 6px;border-radius:3px;background:var(--primary);color:#fff">已設定</span>
          </h2>
          <p style="color:var(--text-muted);font-size:var(--fs-sm);margin:0 0 var(--space-3)">
            一個專案共用一組 VPN：下方勾選「需要 VPN」的連線會共用同一條隧道，只撥號一次。
          </p>
          <div class="pdq-vpn-grid">
            <div class="form-group" style="grid-column:1/-1;margin:0">
              <label>VPN 設定檔（.ovpn）{{ vpnForm.vpn_config_name ? '－已選擇：' + vpnForm.vpn_config_name : (vpn.has_config ? '（留空＝不變）' : '') }}</label>
              <input type="file" accept=".ovpn,.conf" class="form-control" @change="onVpnFileChange" />
            </div>
            <div class="form-group" style="margin:0"><label>VPN 帳號</label><input v-model="vpnForm.vpn_username" class="form-control" /></div>
            <div class="form-group" style="margin:0"><label>VPN 密碼（留空＝不變）</label><input v-model="vpnForm.vpn_password" type="password" class="form-control" placeholder="••••••" /></div>
          </div>
          <div style="margin-top:var(--space-3)">
            <button class="btn btn-primary" :disabled="vpnSaving" @click="saveVpn">{{ vpnSaving ? '儲存中…' : '儲存 VPN 設定' }}</button>
          </div>
        </div>

        <div class="settings-section" data-tour="db-conns" style="margin-bottom:var(--space-5)">
          <h2 class="section-title">連線管理（{{ conns.length }}）</h2>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr>
                <th>名稱</th><th>主機</th><th>模式</th><th>DB</th><th>操作</th>
              </tr></thead>
              <tbody>
                <tr v-for="c in conns" :key="c.id">
                  <td style="font-weight:var(--fw-semibold)">{{ c.name }}</td>
                  <td>{{ c.connect_mode === 'direct' ? (c.db_user + '@' + c.db_host + ':' + c.db_port) : (c.ssh_user + '@' + c.ssh_host + ':' + c.ssh_port) }}</td>
                  <td>{{ c.connect_mode }}</td>
                  <td>{{ c.db_name }} <span v-if="c.vpn_enabled" style="font-size:var(--fs-xs);padding:1px 6px;border-radius:3px;background:var(--primary);color:#fff">VPN</span> <span v-if="c.log_mode" class="env-chip">log</span></td>
                  <td><div class="pdq-row-actions">
                    <button class="btn btn-outline btn-sm" @click="editConn(c)">編輯</button>
                    <button class="btn btn-outline btn-sm" style="color:var(--error)" @click="deleteConn(c)">刪除</button>
                  </div></td>
                </tr>
                <tr v-if="conns.length === 0" class="empty-row"><td colspan="5">尚無連線</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="settings-section" data-tour="db-form" style="margin-bottom:var(--space-5)">
          <h2 class="section-title">{{ form.id ? '編輯連線' : '新增連線' }}</h2>
          <div class="pdq-form-grid">
            <div class="form-group" style="margin:0"><label>連線名稱</label><input v-model="form.name" class="form-control" placeholder="hj-鴻久-正式" /></div>
            <div class="form-group" style="margin:0"><label>連線模式</label><select v-model="form.connect_mode" class="form-control"><option value="docker">docker（SSH→容器）</option><option value="local">local（SSH→本機）</option><option value="direct">direct（直連 TCP）</option></select></div>
            <template v-if="form.connect_mode!=='direct'">
              <div class="form-group" style="margin:0"><label>SSH 主機</label><input v-model="form.ssh_host" class="form-control" placeholder="1.2.3.4" /></div>
              <div class="form-group" style="margin:0"><label>SSH 埠</label><input v-model.number="form.ssh_port" class="form-control" /></div>
              <div class="form-group" style="margin:0"><label>SSH 使用者</label><input v-model="form.ssh_user" class="form-control" placeholder="root" /></div>
              <div class="form-group" style="margin:0"><label>認證方式</label><select v-model="form.auth_type" class="form-control"><option value="password">密碼</option><option value="key">金鑰</option></select></div>
              <div class="form-group" style="margin:0" v-if="form.auth_type==='password'"><label>SSH 密碼（留空＝不變）</label><input v-model="form.ssh_password" type="password" class="form-control" placeholder="••••••" /></div>
              <div class="form-group" style="margin:0" v-else><label>SSH 金鑰內容（PEM）</label><textarea v-model="form.ssh_key_content" class="form-control" rows="4" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----" style="font-family:monospace;font-size:var(--fs-xs)"></textarea></div>
              <div class="form-group" style="margin:0" v-if="form.connect_mode==='docker'"><label>Docker 容器</label><input v-model="form.docker_container" class="form-control" /></div>
              <div class="form-group" style="margin:0" v-if="form.connect_mode==='docker'"><label>DB 使用者</label><input v-model="form.db_user" class="form-control" /></div>
              <div class="form-group" style="margin:0" v-if="form.connect_mode==='local'"><label>sudo 使用者</label><input v-model="form.sudo_user" class="form-control" /></div>
            </template>
            <template v-else>
              <div class="form-group" style="margin:0"><label>引擎</label><select v-model="form.db_engine" class="form-control"><option value="postgres">PostgreSQL</option><option value="mssql">MS SQL Server</option><option value="mysql">MySQL / MariaDB</option></select></div>
              <div class="form-group" style="margin:0"><label>DB 主機</label><input v-model="form.db_host" class="form-control" placeholder="db.example.com" /></div>
              <div class="form-group" style="margin:0"><label>DB 埠</label><input v-model.number="form.db_port" class="form-control" :placeholder="form.db_engine==='mssql'?'1433':form.db_engine==='mysql'?'3306':'5432'" /></div>
              <div class="form-group" style="margin:0"><label>DB 使用者</label><input v-model="form.db_user" class="form-control" placeholder="reader" /></div>
              <div class="form-group" style="margin:0"><label>DB 密碼（留空＝不變）</label><input v-model="form.db_password" type="password" class="form-control" placeholder="••••••" /></div>
              <div class="form-group pdq-ssl-field"><label style="margin:0">SSL</label><input v-model="form.db_ssl" type="checkbox" style="width:auto" /></div>
            </template>
            <div class="form-group" style="margin:0"><label>資料庫名稱</label><input v-model="form.db_name" class="form-control" /></div>
          </div>
          <div class="pdq-vpn-checkbox-row">
            <input v-model="form.vpn_enabled" type="checkbox" id="vpnEnabled" style="width:auto" />
            <label for="vpnEnabled" style="margin:0">此連線需要 VPN（使用上方的專案 VPN 設定）</label>
          </div>
          <div class="form-group" style="margin-top:var(--space-4)">
            <label>log 來源（供 AI 排障讀取 Odoo log）</label>
            <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap">
              <button class="btn btn-outline btn-sm" :disabled="probing || !form.id || form.connect_mode === 'direct'" @click="probeLog">
                {{ probing ? '偵測中…' : '偵測 log 來源' }}
              </button>
              <span v-if="form.connect_mode === 'direct'" style="font-size:var(--fs-xs);color:var(--text-muted)">direct 模式不經 SSH，無法讀取主機 log</span>
              <span v-else-if="form.log_mode" style="font-size:var(--fs-xs);color:var(--text-muted)">
                {{ form.log_mode }}
                <template v-if="form.log_mode==='docker'">／容器 {{ form.log_container }}</template>
                <template v-else-if="form.log_mode==='journald'">／unit {{ form.log_unit }}</template>
                <template v-else>／{{ form.log_path }}</template>
                ／時區偏移 {{ form.log_tz_offset }} 分
              </span>
              <span v-else style="font-size:var(--fs-xs);color:var(--text-muted)">尚未偵測</span>
            </div>
          </div>
          <div class="pdq-form-grid" v-if="form.log_mode">
            <div class="form-group" style="margin:0" v-if="form.log_mode==='docker'">
              <label>Odoo 容器（非資料庫容器）</label>
              <input v-model="form.log_container" class="form-control" />
            </div>
            <div class="form-group" style="margin:0" v-if="form.log_mode==='journald'">
              <label>systemd unit</label><input v-model="form.log_unit" class="form-control" />
            </div>
            <div class="form-group" style="margin:0" v-if="form.log_mode==='file'">
              <label>log 檔路徑</label><input v-model="form.log_path" class="form-control" />
            </div>
            <div class="form-group" style="margin:0">
              <label>時區偏移（分鐘，如 UTC+8 為 480；推算錯誤時可在此手動修正）</label>
              <input v-model.number="form.log_tz_offset" type="number" class="form-control" />
            </div>
          </div>
          <div class="pdq-form-actions">
            <button class="btn btn-primary btn-sm" @click="saveConn" :disabled="saving">{{ saving ? '儲存中...' : (form.id ? '更新連線' : '+ 新增連線') }}</button>
            <button class="btn btn-outline btn-sm" @click="testConn" :disabled="testing">{{ testing ? '測試中...' : '測試連線' }}</button>
            <button v-if="form.id" class="btn btn-outline btn-sm" @click="resetForm">取消編輯</button>
          </div>
        </div>

        <div class="settings-section" data-tour="db-query">
          <h2 class="section-title">查詢（只允許 SELECT）</h2>
          <div class="pdq-query-bar">
            <select v-model="selectedId" class="form-control pdq-conn-select">
              <option value="">選擇連線...</option>
              <option v-for="c in conns" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
            <button class="btn btn-primary btn-sm" @click="runQuery" :disabled="running">{{ running ? '查詢中...' : '執行' }}</button>
          </div>
          <textarea v-model="sql" class="form-control" rows="4" placeholder="SELECT id, login FROM res_users LIMIT 20" style="font-family:monospace"></textarea>
          <div v-if="error" class="error-msg" style="margin-top:10px;white-space:pre-wrap">{{ error }}</div>
          <div v-if="result" style="margin-top:10px">
            <div style="font-size:var(--fs-sm);color:var(--text-muted);margin-bottom:var(--space-1)">{{ result.row_count }} 筆</div>
            <div class="table-wrap">
            <table class="data-table">
              <thead><tr>
                <th v-for="col in result.columns" :key="col">{{ col }}</th>
              </tr></thead>
              <tbody>
                <tr v-for="(row,i) in result.rows" :key="i">
                  <td v-for="(cell,j) in row" :key="j">{{ cell }}</td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </div>
    `
  });
  window.UiNextAdminUsersView = Vue.defineComponent({
    name: "UiNextAdminUsersView",
    data() {
      return {
        users: [],
        loading: true,
        newUser: { username: '', password: '', display_name: '', role: 'user' },
        savingUser: false,
        addUserOpen: false,
        search: ''
      };
    },
    computed: {
      filteredUsers() {
        const q = this.search.toLowerCase();
        if (!q) return this.users;
        return this.users.filter(u =>
          u.username.toLowerCase().includes(q) || u.display_name.toLowerCase().includes(q)
        );
      }
    },
    async created() { await this.loadUsers(); },
    methods: {
      async loadUsers() {
        this.loading = true;
        try { this.users = await Api.get('admin/users'); }
        catch (e) { showToast(e.message, 'error'); }
        finally { this.loading = false; }
      },
      async addUser() {
        if (!this.newUser.username || !this.newUser.password) return showToast('請填寫帳號和密碼', 'error');
        if (this.newUser.password.length < 8) return showToast('密碼至少 8 個字元', 'error');
        this.savingUser = true;
        try {
          await Api.post('admin/users', { ...this.newUser });
          this.newUser = { username: '', password: '', display_name: '', role: 'user' };
          this.addUserOpen = false;
          await this.loadUsers();
          showToast('已新增使用者', 'success');
        } catch (e) { showToast(e.message, 'error'); }
        finally { this.savingUser = false; }
      },
      async toggleRole(user) {
        const newRole = user.role === 'admin' ? 'user' : 'admin';
        const verb = newRole === 'admin' ? '升為管理員' : '降為一般使用者';
        if (!await confirmDialog({ title: '變更權限', message: `確定將「${user.display_name || user.username}」${verb}？`, confirmText: '確定' })) return;
        try {
          await Api.put(`admin/users/${user.id}`, { role: newRole });
          await this.loadUsers();
          showToast(`已${verb}`, 'success');
        } catch (e) { showToast(e.message, 'error'); }
      },
      async approve(user) {
        if (!await confirmDialog({ title: '核准帳號', message: `確定核准「${user.display_name || user.username}」？核准後即可登入使用。`, confirmText: '核准' })) return;
        try {
          await Api.put(`admin/users/${user.id}`, { approved: true });
          await this.loadUsers();
          showToast('已核准', 'success');
        } catch (e) { showToast(e.message, 'error'); }
      },
      async deleteUser(user) {
        if (!await confirmDialog({ title: '刪除使用者', message: `確定刪除使用者「${user.display_name || user.username}」？`, danger: true, confirmText: '刪除' })) return;
        try {
          await Api.delete(`admin/users/${user.id}`);
          await this.loadUsers();
          showToast('已刪除使用者', 'success');
        } catch (e) { showToast(e.message, 'error'); }
      }
    },
    template: `
      <div class="topbar ui-next-admin-head">
        <h1>使用者管理</h1>
        <div class="ui-next-admin-head-actions"><button class="btn btn-primary btn-sm" @click="addUserOpen=true">＋ 新增</button><button class="btn btn-outline btn-sm" @click="$router.push('/admin')">← 返回</button></div>
      </div>
      <div class="content">
        <div v-if="loading" class="admin-users-list">
          <div class="settings-section">
            <h2 class="section-title">使用者列表</h2>
            <!-- 載入態與載入完的表要走同一種手機版型（table-cards-sm），否則骨架先排成
                 橫捲的五欄表、資料一到又整個跳成卡片。既然卡片化，每個 td 就得帶 data-label
                 ——屬性缺席時 ::before 仍佔位，那 88px 的欄名縮排會空在骨架左邊。 -->
            <div class="table-wrap table-cards-sm">
              <table class="data-table">
                <thead><tr><th>帳號</th><th>顯示名稱</th><th>角色</th><th>建立時間</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="i in 4" :key="i">
                    <td data-label="帳號"><Skeleton width="90px" /></td>
                    <td data-label="顯示名稱"><Skeleton width="110px" /></td>
                    <td data-label="角色"><Skeleton width="50px" /></td>
                    <td data-label="建立時間"><Skeleton width="80px" /></td>
                    <td data-label="操作"><Skeleton width="140px" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div v-else class="admin-users-list">

          <!-- 搜尋 -->
          <div style="margin-bottom:var(--space-4)">
            <input v-model="search" placeholder="搜尋帳號或顯示名稱..." class="form-control admin-users-search-input" />
          </div>

          <!-- 使用者列表 -->
          <div class="settings-section" style="margin-bottom:var(--space-5)">
            <h2 class="section-title">使用者列表（{{ filteredUsers.length }}）</h2>
            <div class="table-wrap table-cards-sm">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>帳號</th>
                    <th>顯示名稱</th>
                    <th>角色</th>
                    <th>建立時間</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="u in filteredUsers" :key="u.id">
                    <td data-label="帳號" style="font-weight:var(--fw-semibold)">{{ u.username }}</td>
                    <td data-label="顯示名稱">{{ u.display_name }}</td>
                    <td data-label="角色">
                      <span :style="{ color: u.role === 'admin' ? 'var(--sidebar-accent)' : 'var(--text-muted)', fontWeight: 'var(--fw-semibold)' }">
                        {{ u.role === 'admin' ? '管理員' : '一般' }}
                      </span>
                      <span v-if="u.approved === false" class="pill pill-warn" style="margin-left:6px">待審核</span>
                    </td>
                    <td data-label="建立時間" style="font-size:var(--fs-sm);color:var(--text-muted)">
                      {{ new Date(u.created_at).toLocaleDateString('zh-TW') }}
                    </td>
                    <td data-label="操作">
                      <div class="admin-users-row-actions">
                        <button v-if="u.approved === false" class="btn btn-primary btn-sm" @click="approve(u)">核准</button>
                        <button class="btn btn-outline btn-sm" @click="toggleRole(u)">
                          {{ u.role === 'admin' ? '降為一般' : '升為管理員' }}
                        </button>
                        <button class="btn btn-outline btn-sm" style="color:var(--error)" @click="deleteUser(u)">刪除</button>
                      </div>
                    </td>
                  </tr>
                  <tr v-if="filteredUsers.length === 0" class="empty-row">
                    <td colspan="5">沒有符合的使用者</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="addUserOpen" class="ui-next-task-modal-backdrop" @click.self="addUserOpen=false">
          <section class="ui-next-user-create" role="dialog" aria-modal="true" aria-labelledby="ui-next-user-create-title">
            <header><h2 id="ui-next-user-create-title">新增使用者</h2><button type="button" @click="addUserOpen=false" aria-label="關閉新增使用者視窗">關閉</button></header>
            <div class="admin-users-form-grid">
              <div class="form-group" style="margin:0">
                <label>帳號</label>
                <input v-model="newUser.username" placeholder="username" class="form-control" />
              </div>
              <div class="form-group" style="margin:0">
                <label>顯示名稱</label>
                <input v-model="newUser.display_name" placeholder="王小明" class="form-control" />
              </div>
              <div class="form-group" style="margin:0">
                <label>密碼（至少 8 碼）</label>
                <input v-model="newUser.password" type="password" placeholder="••••••••" class="form-control" />
              </div>
              <div class="form-group" style="margin:0">
                <label>角色</label>
                <select v-model="newUser.role" class="form-control">
                  <option value="user">一般使用者</option>
                  <option value="admin">管理員</option>
                </select>
              </div>
            </div>
            <footer><button class="btn btn-outline btn-sm" @click="addUserOpen=false" :disabled="savingUser">取消</button><button class="btn btn-primary btn-sm" @click="addUser" :disabled="savingUser">
              {{ savingUser ? '新增中...' : '+ 新增使用者' }}
            </button></footer>
          </section></div>

        </div>
      </div>
    `
  });
})();
