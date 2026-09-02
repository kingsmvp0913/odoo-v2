(function () {
  // 判準單一來源在 index.html 的 window.UiVersion（那段排在本檔之前）。
  // 這裡不再自己讀網址：兩處各判一次，改了其中一處就會出現「載了資產卻走舊 View」的錯位。
  window.UiNextEnabled = window.UiVersion === "next";

  function chatTitle(value) {
    const text = (value || "").trim().replace(/\s+/g, " ");
    return text.length > 28 ? `${text.slice(0, 28)}…` : text || "新對話";
  }

  window.renderNextMarkdown = function renderNextMarkdown(value) {
    return renderMarkdown(value)
      .replace(/<pre><code(?: class="language-([^\"]+)")?>/g, (_, language) => `<div class="ui-next-code-block"><div class="ui-next-code-head"><span>${language || "text"}</span><button type="button" data-copy-code="true">複製程式碼</button></div><pre><code>`)
      .replace(/<\/code><\/pre>/g, "</code></pre></div>");
  };

  window.copyNextCode = async function copyNextCode(event) {
    const trigger = event.target.closest("[data-copy-code]");
    if (!trigger) return;
    const code = trigger.closest(".ui-next-code-block")?.querySelector("code")?.textContent || "";
    try {
      await navigator.clipboard.writeText(code);
      trigger.textContent = "已複製";
      setTimeout(() => { trigger.textContent = "複製程式碼"; }, 1800);
    } catch (error) { showToast("無法複製程式碼，請確認瀏覽器權限", "error", 0); }
  };

  const UiNextIcon = Vue.defineComponent({
    name: "UiNextIcon",
    props: { name: { type: String, required: true } },
    template: `<svg class="ui-next-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path v-if="name==='plus'" d="M12 5v14M5 12h14"/><path v-else-if="name==='search'" d="m20 20-4.2-4.2M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z"/>
      <path v-else-if="name==='chat'" d="M20 11a7 7 0 0 1-7 7H8l-4 3v-6a7 7 0 1 1 16-4Z"/><path v-else-if="name==='tasks'" d="M9 5h10M9 12h10M9 19h10M4 5l1 1 2-2m-3 8 1 1 2-2m-3 8 1 1 2-2"/>
      <path v-else-if="name==='project'" d="M3 7h7l2 2h9v10H3z"/><path v-else-if="name==='flow'" d="M6 5h12M6 12h12M6 19h12"/><g v-else-if="name==='dots'" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></g><path v-else-if="name==='grid'" d="M5 5h5v5H5zm9 0h5v5h-5zM5 14h5v5H5zm9 0h5v5h-5z"/>
      <path v-else-if="name==='book'" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5zM4 5.5v16"/><path v-else-if="name==='chart'" d="M5 20v-8m7 8V4m7 16v-5"/>
      <path v-else-if="name==='paperclip'" d="m21 11.5-8.7 8.7a5 5 0 0 1-7.1-7.1l8.8-8.8a3.5 3.5 0 0 1 5 5l-8.8 8.8a2 2 0 0 1-2.8-2.8l8.1-8.1"/>
      <path v-else-if="name==='arrow-left'" d="m14 5-7 7 7 7M7 12h12"/>
      <path v-else-if="name==='chevron-down'" d="m6 9 6 6 6-6"/><path v-else-if="name==='chevron-up'" d="m6 15 6-6 6 6"/>
      <path v-else-if="name==='close'" d="M6 6l12 12M18 6 6 18"/><path v-else-if="name==='send'" d="m4 4 16 8-16 8 3-8-3-8Zm3 8h13"/>
      <path v-else-if="name==='check'" d="m5 12 4.2 4.2L19 6.5"/><path v-else-if="name==='alert'" d="M12 7v6m0 4h.01M10.2 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.8 3.9a2.1 2.1 0 0 0-3.6 0Z"/>
      <path v-else-if="name==='star'" d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>
      <path v-else-if="name==='star-filled'" fill="currentColor" stroke="none" d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>
      <path v-else-if="name==='chevron-right'" d="m9 6 6 6-6 6"/><path v-else-if="name==='arrow-right'" d="m14 5 7 7-7 7M21 12H9"/>
      <path v-else-if="name==='download'" d="M12 3v12m0 0 4.2-4.2M12 15l-4.2-4.2M4 19h16"/>
      <path v-else-if="name==='wrench'" d="M14.6 6.4a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>
      <path v-else-if="name==='enter'" d="m9 10-4 4 4 4M5 14h9a4 4 0 0 0 4-4V6"/>
      <rect v-else-if="name==='square'" x="4" y="4" width="16" height="16" rx="3.2" fill="currentColor" stroke="none"/>
    </svg>`,
  });
  window.UiNextIcon = UiNextIcon;

  window.UiNextQuestionView = Vue.defineComponent({
    name: "UiNextQuestionView",
    components: { UiNextIcon },
    data() {
      return {
        projects: [],
        projectId: "",
        prompt: "",
        files: [],
        environment: null,
        environmentSummaries: {},
        environmentError: "",
        projectPickerOpen: false,
        sourcePickerOpen: false,
        projectQuery: "",
        // 空＝不指定，由 agent 自己判斷該查哪裡（使用者裁決：沒選就自行決定）。
        dataSource: "",
        // 這個專案實際設定過的資料庫連線。固定寫死「正式區」一個選項是錯的——
        // 一個專案可以掛好幾個庫（鴻久有六個：測試、鴻久正式、鴻伍正式…）。
        dbConnections: [],
        // 「最近有 chat 的專案」與側欄同一支 API，排序才會一致。
        recentChatProjects: [],
        createdChatId: "",
        sendError: "",
        userName: "使用者",
        sending: false,
        loading: true,
        launching: false,
      };
    },
    async created() {
      try {
        const [projects, me, summaries, recent] = await Promise.all([
          Api.get("projects"),
          Api.get("auth/me"),
          Api.get("projects/env-summaries").catch(() => []),
          Api.get("chats/sidebar-projects").catch(() => []),
        ]);
        this.projects = projects || [];
        this.recentChatProjects = recent || [];
        this.userName = me.display_name || me.username || "使用者";
        this.environmentSummaries = (summaries || []).reduce((result, summary) => { result[String(summary.project_id)] = summary; return result; }, {});
        const lastProjectId = localStorage.getItem("oaa.next.last-project-id");
        this.projectId = this.projects.some((project) => String(project.id) === lastProjectId)
          ? lastProjectId
          : this.projects[0] ? String(this.projects[0].id) : "";
        await Promise.all([this.loadEnvironment(), this.loadDbConnections()]);
      } catch (e) {
        showToast("無法載入專案清單", "error");
      } finally {
        this.loading = false;
      }
    },
    mounted() {
      this._onProjectPickerOutside = (event) => {
        if (!event.target.closest(".ui-next-project-picker")) this.projectPickerOpen = false;
        if (!event.target.closest(".ui-next-source-picker")) this.sourcePickerOpen = false;
      };
      document.addEventListener("pointerdown", this._onProjectPickerOutside);
    },
    beforeUnmount() {
      document.removeEventListener("pointerdown", this._onProjectPickerOutside);
    },
    computed: {
      // 排序比照側欄：我的最愛 → 最近有對話 → 其餘按名稱。三十幾個專案時，
      // 按 id 排等於每次都要從頭找。
      // 資料來源的選項：自動 → 平台測試環境 → 這個專案設定過的每個連線。
      sourceOptions() {
        return [
          { value: "", label: "自動" },
          { value: "test_env", label: "平台測試環境" },
          ...this.dbConnections.map((conn) => ({ value: `db:${conn.id}`, label: conn.name, hint: conn.db_name || "" })),
        ];
      },
      selectedSourceLabel() {
        const hit = this.sourceOptions.find((opt) => opt.value === this.dataSource);
        return hit ? hit.label : "自動";
      },
      sortedProjects() {
        const recent = new Map(this.recentChatProjects.map((row, index) => [String(row.project_id), index]));
        const rank = (project) => (project.is_favorite ? 0 : recent.has(String(project.id)) ? 1 : 2);
        return [...this.projects].sort((a, b) => {
          const ra = rank(a), rb = rank(b);
          if (ra !== rb) return ra - rb;
          if (ra === 1) return recent.get(String(a.id)) - recent.get(String(b.id));
          return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant");
        });
      },
      filteredProjects() {
        const query = this.projectQuery.trim().toLowerCase();
        if (!query) return this.sortedProjects;
        return this.sortedProjects.filter((project) => String(project.name || "").toLowerCase().includes(query));
      },
      selectedProject() {
        return this.projects.find(
          (p) => String(p.id) === String(this.projectId),
        );
      },
      environmentLabel() {
        if (!this.projectId) return "請先選擇專案";
        if (this.environmentError) return "測試環境狀態讀取失敗";
        if (!this.environment) return "測試環境狀態載入中";
        return ({ idle: this.environment.built ? "測試環境已停止" : "測試環境未建立", setting_up: "測試環境建立中", running: "測試環境運行中", error: "測試環境錯誤" }[this.environment.status] || "測試環境狀態未知");
      },
    },
    methods: {
      async loadEnvironment() {
        if (!this.projectId) { this.environment = null; this.environmentError = ""; return; }
        this.environment = null;
        this.environmentError = "";
        try { this.environment = await Api.get(`projects/${this.projectId}/env/summary`); this.environmentSummaries[String(this.projectId)] = this.environment; }
        catch (error) { this.environmentError = error.message || "無法讀取測試環境"; }
      },
      environmentOptionLabel(project) {
        const summary = this.environmentSummaries[String(project.id)];
        if (!summary) return "測試環境：狀態未知 · 資料庫連線：狀態未知";
        const environment = ({ idle: "未建立或已停止", setting_up: "建立中", running: "運行中", error: "錯誤" }[summary.status] || "狀態未知");
        const database = ({ connected: "已連線", connecting: "連線中", not_available: "未啟動", error: "錯誤" }[summary.database_status] || "狀態未知");
        return `測試環境：${environment} · 資料庫連線：${database}`;
      },
      onProjectChange() {
        localStorage.setItem("oaa.next.last-project-id", this.projectId);
        this.createdChatId = "";
        // 連線 id 是專案自己的，換專案就得清掉——留著會指到別的專案的庫。
        this.dataSource = "";
        this.loadEnvironment();
        this.loadDbConnections();
      },
      async loadDbConnections() {
        this.dbConnections = [];
        if (!this.projectId) return;
        try { this.dbConnections = await Api.get(`projects/${this.projectId}/db-connections`) || []; }
        catch (error) { /* 沒設連線是常態，選單就只剩測試環境那一項 */ }
      },
      // 整格可點：點圖示、箭頭或留白都要展開，不是只有點到文字才算。
      openProjectPicker() {
        if (this.loading || !this.projects.length) return;
        this.projectPickerOpen = true;
        this.projectQuery = "";
        this.$nextTick(() => this.$refs.projectTrigger?.focus());
      },
      selectProject(project) {
        this.projectId = String(project.id);
        this.projectPickerOpen = false;
        this.projectQuery = "";
        this.onProjectChange();
      },
      selectSource(option) {
        this.dataSource = option.value;
        this.sourcePickerOpen = false;
      },
      onSourcePickerKeydown(event) {
        if (event.key === "Escape") { this.sourcePickerOpen = false; this.$nextTick(() => this.$refs.sourceTrigger?.focus()); return; }
        const options = this.$refs.sourceOptions ? Array.from(this.$refs.sourceOptions.querySelectorAll("button")) : [];
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!this.sourcePickerOpen) { this.sourcePickerOpen = true; return; }
          const index = options.indexOf(document.activeElement);
          (options[index + (event.key === "ArrowDown" ? 1 : -1)] || options[event.key === "ArrowDown" ? 0 : options.length - 1])?.focus();
        }
      },
      onProjectPickerKeydown(event) {
        const options = this.$refs.projectOptions ? Array.from(this.$refs.projectOptions.querySelectorAll("button:not([disabled])")) : [];
        if (event.key === "Escape") { this.projectPickerOpen = false; this.projectQuery = ""; this.$nextTick(() => this.$refs.projectTrigger?.focus()); return; }
        // 打完字直接 Enter 就選中第一筆——這是自動完成最常用的操作，要求先按方向鍵才選得到
        // 等於把「可以打字」這件事做一半。
        if (event.key === "Enter" && this.projectPickerOpen && document.activeElement === this.$refs.projectTrigger) {
          const first = this.filteredProjects[0];
          if (first) { event.preventDefault(); this.selectProject(first); }
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!this.projectPickerOpen) { this.projectPickerOpen = true; return; }
          const index = options.indexOf(document.activeElement);
          (options[index + (event.key === "ArrowDown" ? 1 : -1)] || options[event.key === "ArrowDown" ? 0 : options.length - 1])?.focus();
        }
      },
      chooseFiles(e) {
        const selected = Array.from(e.target.files || []);
        this.files = selected.filter((file) => /^image\//.test(file.type) && file.size <= 10 * 1024 * 1024).slice(0, 5);
        if (this.files.length !== selected.length) showToast("附件限圖片、單檔 10MB、最多 5 個", "error");
        e.target.value = "";
      },
      // 截圖直接貼上：問答首頁本來只能透過「上傳圖片」選檔，貼上是完全沒反應的。
      // 限制沿用 chooseFiles：只收圖片、單檔 10MB、最多 5 個。
      onPasteFiles(event) {
        const files = Array.from((event.clipboardData || {}).files || []).filter((f) => /^image\//.test(f.type));
        if (!files.length) return;
        event.preventDefault();
        files.forEach((f) => { if (f.size <= 10 * 1024 * 1024 && this.files.length < 5) this.files.push(f); });
      },
      autoResize(event) {
        const textarea = event.currentTarget;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
      },
      removeFile(index) {
        this.files.splice(index, 1);
      },
      async send() {
        if (
          (!this.prompt.trim() && !this.files.length) ||
          !this.projectId ||
          this.sending
        )
          return;
        this.sending = true;
        this.sendError = "";
        try {
          const chat = this.createdChatId
            ? { id: this.createdChatId }
            : await Api.post(`projects/${this.projectId}/chats`, { title: chatTitle(this.prompt), data_source: this.dataSource || undefined });
          this.createdChatId = String(chat.id);
          const content = this.prompt.trim();
          // ⚠ 訊息端點會 await 整輪 AI 回覆（chat-agent 的 chatReply，動輒數分鐘）。等它回來才換頁
          // ＝使用者盯著這一頁的「處理中」卡好幾分鐘，然後畫面毫無預警整頁抽換。改成送出即不等待：
          // 伺服器在 handler 開頭就把 reply_pending 設起來，接手的對話頁靠 ?pending=1 立刻進入
          // 「回覆中」並開始輪詢。失敗只能事後 toast（那時人已經在對話頁了）。
          const request = this.files.length
            ? (() => {
                const form = new FormData();
                form.append("content", content);
                this.files.forEach((file) => form.append("files", file));
                return Api.postForm(`projects/${this.projectId}/chats/${chat.id}/messages`, form);
              })()
            : Api.post(`projects/${this.projectId}/chats/${chat.id}/messages`, { content });
          request.catch((e) => showToast(e.message || "訊息送出失敗", "error", 0));
          // 側欄先展開，動畫這 300ms 正好把清單載完——不然它會和右側的內容同時跳出來。
          window.dispatchEvent(new CustomEvent("ui-next:project-preload", { detail: { projectId: this.projectId } }));
          // 把剛送出的那句留給對話頁先畫上：訊息端點還在跑，DB 這一刻可能還沒有這則，
          // 對話頁只信伺服器的話，換過去會是一片空白——自己剛打的字不見了。
          try { sessionStorage.setItem(`ui-next:pending-msg:${chat.id}`, content); } catch (_) { /* 隱私模式沒有 sessionStorage，退回原本的空白等待 */ }
          await this.slideToChat();
          this.$router.replace(`/projects/${this.projectId}/chat/${chat.id}?pending=1`);
          this.createdChatId = "";
        } catch (e) {
          this.launching = false;
          this.sendError = e.message || "無法送出訊息";
          showToast(this.sendError, "error", 0);
        } finally {
          this.sending = false;
        }
      },
      // 把輸入框從畫面中央滑到對話頁輸入框所在的底部，滑完才換路由——換過去之後同一個位置
      // 就是對話頁的輸入框，看起來是同一個框留在原地、上面長出對話，而不是「跳頁」。
      // 只淡出上方文案、不收合它的高度：兩者同時做的話位移量會互相抵銷，落點不可預測。
      slideToChat() {
        return new Promise((resolve) => {
          const form = this.$el && this.$el.querySelector(".ui-next-composer");
          const inner = this.$refs.questionInner;
          if (!form || !inner || !window.matchMedia("(prefers-reduced-motion: no-preference)").matches) { resolve(); return; }
          // FLIP：先量、套上最終狀態、再量、用差值把它「拉回」原位，然後放掉讓 CSS 過渡走完。
          // ⚠ 不要改成「自己算要移多少 px」——實測一直差 35px，因為這個 section 是垂直置中的，
          //   內容一變高（is-launching 會動到版面）位移量就跟著變，先量後套永遠對不上。
          //   FLIP 兩端都是實測值，天生免疫這種版面變化。
          // 量下緣而不是上緣：落點與對話頁輸入框對齊的是「底線」（兩邊寬度與 bottom 已對齊，
          // 但首頁的 textarea 比較高，上緣天生對不上）。用 top 做 FLIP 會讓底線在換路由時跳一截。
          const first = form.getBoundingClientRect().bottom;
          this.launching = true;
          requestAnimationFrame(() => {
            const delta = first - form.getBoundingClientRect().bottom;
            inner.style.transition = "none";
            inner.style.transform = `translateY(${delta}px)`;
            requestAnimationFrame(() => {
              inner.style.transition = "";
              inner.style.transform = "";
              setTimeout(resolve, 300);
            });
          });
        });
      },
    },
    template: `
      <section class="ui-next-question" :class="{'is-launching':launching}">
        <div ref="questionInner" class="ui-next-question-inner">
          <div class="ui-next-question-intro">
            <div class="ui-next-greeting">嗨，{{ userName }}</div>
            <h1>今天想從哪裡開始？</h1>
            <p>選擇專案後開始對話；系統會依內容自動建立標題並保留在該專案內。</p>
          </div>
          <form class="ui-next-composer" @submit.prevent="send">
            <div v-if="files.length" class="ui-next-attachments">
              <span v-for="(file, index) in files" :key="file.name + index"><ui-next-icon name="paperclip"/>{{ file.name }} <button type="button" @click="removeFile(index)" aria-label="移除附件"><ui-next-icon name="close"/></button></span>
            </div>
            <textarea v-model="prompt" placeholder="詢問專案需求、流程問題，或描述你想完成的工作…" @input="autoResize" @paste="onPasteFiles" @keydown.enter.exact.prevent="send"></textarea>
            <p v-if="sendError" class="ui-next-inline-error">{{ sendError }} <button type="button" @click="send">重試</button></p>
            <div class="ui-next-composer-foot">
              <div class="ui-next-composer-options">
                <label class="ui-next-icon-button" title="上傳圖片"><ui-next-icon name="paperclip"/><input type="file" accept="image/*" multiple @change="chooseFiles"></label>
                <div class="ui-next-project-picker ui-next-composer-chip" @keydown="onProjectPickerKeydown" @click="openProjectPicker">
                  <ui-next-icon name="project"/>
                  <input ref="projectTrigger" type="text" class="ui-next-project-picker-trigger" role="combobox" aria-autocomplete="list" :aria-expanded="projectPickerOpen" :value="projectPickerOpen ? projectQuery : (selectedProject ? selectedProject.name : '')" :placeholder="projects.length ? (selectedProject ? selectedProject.name : '選擇專案') : '沒有可用專案'" :disabled="loading || !projects.length" @focus="projectPickerOpen=true;projectQuery=''" @input="projectQuery=$event.target.value;projectPickerOpen=true">
                  <ui-next-icon name="chevron-down"/>
                  <div v-if="projectPickerOpen" ref="projectOptions" class="ui-next-project-picker-options" role="listbox" aria-label="選擇專案" @click.stop>
                    <button v-for="project in filteredProjects" :key="project.id" type="button" role="option" :aria-selected="String(project.id)===String(projectId)" @click="selectProject(project)">{{ project.name }}</button>
                    <p v-if="!filteredProjects.length">找不到符合的專案</p>
                  </div>
                </div>
                <div v-if="projectId" class="ui-next-source-picker ui-next-composer-chip" @keydown="onSourcePickerKeydown" @click="sourcePickerOpen=!sourcePickerOpen">
                  <ui-next-icon name="grid"/>
                  <button ref="sourceTrigger" type="button" class="ui-next-source-trigger" :aria-expanded="sourcePickerOpen" aria-haspopup="listbox" aria-label="優先查證的資料來源" title="這場對話優先從哪裡找資料；不選則由 AI 自己判斷">{{ selectedSourceLabel }}</button>
                  <ui-next-icon name="chevron-down"/>
                  <div v-if="sourcePickerOpen" ref="sourceOptions" class="ui-next-project-picker-options" role="listbox" aria-label="選擇資料來源" @click.stop>
                    <button v-for="option in sourceOptions" :key="option.value || 'auto'" type="button" role="option" :aria-selected="option.value===dataSource" @click="selectSource(option)">{{ option.label }}<small v-if="option.hint">{{ option.hint }}</small></button>
                  </div>
                </div>
              </div>
              <button class="ui-next-send" :disabled="sending || (!prompt.trim() && !files.length) || !projectId" :aria-label="sending ? '送出中' : '送出'"><ui-next-icon :name="sending ? 'square' : 'send'"/></button>
            </div>
          </form>
          <small>Enter 送出，Shift + Enter 換行。附件沿用既有 Chat 的圖片上傳限制。</small>
        </div>
      </section>
    `,
  });

  window.UiNextApp = Vue.defineComponent({
    name: "UiNextApp",
    components: { UiNextIcon },
    setup() {
      return {
        toasts: window.appToasts,
        dismissToast: window.dismissToast,
        needsActionCount: window.needsActionCount,
        inboxUnread: window.inboxUnread,
        claudeUsage: window.claudeUsage,
        codexUsage: window.codexUsage,
      };
    },
    data() {
      return {
        accountOpen: false,
        toolsOpen: false,
        commandOpen: false,
        commandQuery: "",
        commandIndex: 0,
        commandResults: [],
        commandLoading: false,
        // 每次查詢遞增。回應是非同步的，慢的那次可能後到並蓋掉新的結果，
        // 所以回來時要比對序號，不是自己那次就整包丟掉。
        commandSeq: 0,
        commandTimer: null,
        commandTrigger: null,
        toolsTrigger: null,
        accountTrigger: null,
        projects: [],
        sidebarChatProjects: [],
        sidebarProjectsError: "",
        projectChats: {},
        expandedProjects: {},
        // 右鍵開的選單要落在指標處；用 dots 鈕開的維持貼齊那一列（null）。
        rowMenuPos: null,
        menuProjectId: null,
        menuChatId: null,
        releaseId: null,
        renamingChatId: null,
        renameTitle: "",
        mobileSidebarOpen: false,
        isAdmin: false,
        userName: "使用者",
      };
    },
    computed: {
      // 只有右鍵開的才吃這組座標；dots 鈕開的回傳 null，維持 CSS 裡貼齊那一列的定位。
      rowMenuStyle() {
        if (!this.rowMenuPos) return null;
        return {
          left: `${Math.round(this.rowMenuPos.x)}px`,
          top: `${Math.round(this.rowMenuPos.y)}px`,
          visibility: this.rowMenuPos.ready ? null : "hidden",
        };
      },
      isLoggedIn() {
        return Api.authState.loggedIn;
      },
      projectUnreadTotal() {
        return Object.values(window.UnreadStore.byProject).reduce(
          (total, count) => total + (count || 0),
          0,
        );
      },
      usageRows() {
        const rows = [];
        const claude = this.claudeUsage;
        if (claude && claude.available && claude.five_hour && claude.five_hour.utilization != null) {
          rows.push({ provider: "claude", label: "Claude 5hr", used: Math.round(claude.five_hour.utilization), updatedAt: claude.updated_at, resetsAt: claude.five_hour.resets_at });
        }
        const codex = this.codexUsage;
        if (codex && codex.available && codex.primary) {
          rows.push({ provider: "codex", label: "Codex 5hr", used: Math.round(codex.primary.used_percent), updatedAt: codex.updated_at, resetsAt: codex.primary.resets_at });
        }
        return rows.map((row) => ({
          ...row,
          remaining: Math.max(0, 100 - row.used),
            level:
              row.used >= 90
                ? "critical"
                : row.used >= 70
                  ? "warning"
                  : "healthy",
        }));
      },
      currentProjectId() {
        return this.$route.params.id ? String(this.$route.params.id) : "";
      },
      currentChatId() {
        return this.$route.params.chatId ? String(this.$route.params.chatId) : "";
      },
      sidebarProjects() {
        const projectById = new Map(this.projects.map((project) => [String(project.id), project]));
        const selected = new Map();
        this.sidebarChatProjects.slice(0, 5).forEach((item) => {
          const project = projectById.get(String(item.project_id));
          if (project) selected.set(String(project.id), project);
        });
        this.projects.filter((project) => project.is_favorite).forEach((project) => selected.set(String(project.id), project));
        // 目前路由的專案是唯一例外：開著一個既不在近期、也不是最愛的舊專案時，
        // 不補進來的話側欄整棵樹選不到自己，使用者看不出人在哪裡。
        const current = projectById.get(this.currentProjectId);
        if (current) selected.set(String(current.id), current);
        return [...selected.values()].sort((a, b) => Number(b.is_favorite) - Number(a.is_favorite) || a.name.localeCompare(b.name, "zh-Hant"));
      },
      // 搜的是使用者實際在做的東西——任務、對話、專案，不含頁面：
      // 頁面在側欄與帳號／更多工具選單都各有常駐入口，混進搜尋結果只會把真正要找的東西擠掉。
      commandItems() {
        return this.commandResults;
      },
      },
      async mounted() {
      if (!Api.isLoggedIn()) return;
      try {
        const [me, projects, sidebarChatProjects] = await Promise.all([
          Api.get("auth/me"),
          Api.get("projects"),
          Api.get("chats/sidebar-projects").catch((error) => {
            this.sidebarProjectsError = error.message || "無法載入近期對話專案";
            return [];
          }),
        ]);
        this.isAdmin = me.role === "admin";
        this.userName = me.display_name || me.username || "使用者";
        window.UserStore.role = me.role || "";
        this.projects = projects || [];
        this.sidebarChatProjects = sidebarChatProjects || [];
        // 直接開 Chat 深連結時 watch 不會觸發（路由沒變過），所以載完專案要自己補一次。
        this.syncSidebarToRoute();
        window.loadClaudeUsage && window.loadClaudeUsage();
        window.loadCodexUsage && window.loadCodexUsage();
        window.loadUnread && window.loadUnread();
        window.loadInboxUnread && window.loadInboxUnread();
        this._onCommandKey = (event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "k"
          ) {
            event.preventDefault();
            this.openCommand();
          }
          if (event.key === "Escape") {
            this.closeCommand();
            this.closePopovers(true);
            this.closeSidebarMenus();
            this.closeMobileSidebar();
          }
        };
        window.addEventListener("keydown", this._onCommandKey);
        this._onOutsidePointer = (event) => {
          if (!event.target.closest(".ui-next-tools-wrap") && !event.target.closest(".ui-next-account-wrap")) this.closePopovers();
          if (!event.target.closest(".ui-next-row-menu") && !event.target.closest(".ui-next-row-more")) this.closeSidebarMenus();
        };
        document.addEventListener("pointerdown", this._onOutsidePointer);
        // 首頁送出時側欄還指著別的地方；等換路由才由 syncSidebarToRoute 展開，整棵樹會在
        // 換頁那一幀跟著右側內容一起炸開。送出當下就先展開＋預載，換過去時側欄已經就位。
        this._onProjectPreload = (event) => {
          const id = event.detail && event.detail.projectId;
          if (!id) return;
          this.expandedProjects[id] = true;
          this.ensureProjectChats(id);
        };
        window.addEventListener("ui-next:project-preload", this._onProjectPreload);
      } catch (e) {
        /* router 的登入守衛處理失效憑證 */
      }
    },
    beforeUnmount() {
      window.removeEventListener("keydown", this._onCommandKey);
      document.removeEventListener("pointerdown", this._onOutsidePointer);
      window.removeEventListener("ui-next:project-preload", this._onProjectPreload);
    },
    // 背景捲動鎖定集中在這裡：這兩個狀態各有好幾處會改（按鈕、⌘K、Escape、
    // 點遮罩、切換路由），在每個地方各自加解鎖遲早會漏掉一處。
    watch: {
      commandOpen() { this.syncBodyScroll(); },
      // 打字每個字都打一次 API 會讓伺服器接到一串註定被丟掉的查詢，
      // 且慢的那次可能後到並蓋掉新結果（序號在 runCommandSearch 內擋掉）。
      commandQuery() {
        this.commandIndex = 0;
        clearTimeout(this.commandTimer);
        if (!this.commandQuery.trim()) {
          this.commandResults = [];
          this.commandLoading = false;
          return;
        }
        this.commandLoading = true;
        this.commandTimer = setTimeout(() => this.runCommandSearch(), 220);
      },
      mobileSidebarOpen() { this.syncBodyScroll(); },
      "$route.path"() { this.syncSidebarToRoute(); },
    },
    methods: {
      formatUsageUpdated(value) {
        if (!value) return "—";
        return new Date(value).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
      },
      // 5 小時的窗常常跨到隔天凌晨，只印時分會被讀成「早就過了」——不同天就把日期帶上。
      formatUsageReset(value) {
        if (!value) return "";
        const at = new Date(value);
        const time = at.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
        return at.toDateString() === new Date().toDateString() ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`;
      },
      // 對話僅在展開專案時才讀，避免登入就對每個專案發請求；標題由既有 Chat API 回傳。
      // 收合不清 cache，所以重複展開同一個專案只會打一次 API。
      async ensureProjectChats(id) {
        if (Object.prototype.hasOwnProperty.call(this.projectChats, id)) return;
        await this.loadProjectChats(id);
      },
      async loadProjectChats(id) {
        try {
          this.projectChats[id] = await Api.get(`projects/${id}/chats`);
        } catch (e) {
          this.projectChats[id] = [];
          showToast("無法載入專案對話", "error");
        }
      },
      async toggleProject(project) {
        const id = project.id;
        const opening = !this.expandedProjects[id];
        this.expandedProjects[id] = opening;
        if (opening) await this.ensureProjectChats(id);
      },
      // 側欄顯示最新 10 筆，但目前 Chat 若排在第 11 筆之後就會整列消失——
      // 深連結進來時使用者看到的是一份「沒有自己」的清單。
      // ⚠ 清單順序必須固定：把目前 Chat 提到最前面的話，點一下清單就重排，
      // 使用者的眼睛還停在剛才那個位置，會覺得點錯了。只在它真的被擠出去時才補進來。
      visibleChats(project) {
        const chats = this.projectChats[project.id] || [];
        if (this.currentProjectId !== String(project.id)) return chats.slice(0, 10);
        const at = chats.findIndex((chat) => String(chat.id) === this.currentChatId);
        if (at < 0 || at < 10) return chats.slice(0, 10);
        // 擠掉第 10 筆而不是重排：前 9 筆位置原封不動。
        return [...chats.slice(0, 9), chats[at]];
      },
      isCurrentChat(project, chat) {
        return this.currentProjectId === String(project.id) && this.currentChatId === String(chat.id);
      },
      // 深連結與 SPA 內換頁都要讓側欄指到目前位置。只在 mounted 做一次的話，
      // 從任務頁點進 Chat 時整棵樹仍是收合的，看起來像沒有這個 Chat。
      async syncSidebarToRoute() {
        if (!this.$route.path.startsWith("/projects")) return;
        const id = this.currentProjectId;
        if (!id) return;
        this.expandedProjects[id] = true;
        await this.loadProjectChats(id);
      },
      toggleTools(event) {
        const opening = !this.toolsOpen;
        this.accountOpen = false;
        this.toolsOpen = opening;
        if (opening) {
          this.toolsTrigger = event.currentTarget;
          this.$nextTick(() => this.focusMenuItem(this.$refs.toolsMenu, 0));
        }
      },
      toggleAccount(event) {
        const opening = !this.accountOpen;
        this.toolsOpen = false;
        this.accountOpen = opening;
        if (opening) {
          this.accountTrigger = event.currentTarget;
          this.$nextTick(() => this.focusMenuItem(this.$refs.accountMenu, 0));
        }
      },
      // 用 DOM 查詢而不是維護索引：選單項會隨 isAdmin 動態增減（v-if），
      // 維護索引就得跟著條件渲染同步，遲早對不上。
      // step 0 = 移到第一項（開啟時用），±1 = 相對移動並循環。
      focusMenuItem(menu, step) {
        if (!menu) return;
        const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(
          (el) => el.offsetParent !== null,
        );
        if (!items.length) return;
        if (step === 0) { items[0].focus(); return; }
        const at = items.indexOf(document.activeElement);
        items[(at + step + items.length) % items.length].focus();
      },
      moveMenu(event, step) {
        this.focusMenuItem(event.currentTarget, step);
      },
      closePopovers(restoreFocus = false) {
        const hadTools = this.toolsOpen, hadAccount = this.accountOpen;
        this.toolsOpen = false;
        this.accountOpen = false;
        if (restoreFocus) this.$nextTick(() => (hadTools ? this.toolsTrigger : hadAccount ? this.accountTrigger : null)?.focus());
      },
      // 開啟 palette 的唯一入口。搜尋鈕與 ⌘K 兩條路徑都走這裡——
      // 原本 ⌘K 是直接設 commandOpen=true，於是鎖捲動與索引重設只在點按鈕時生效。
      openCommand(trigger) {
        this.commandTrigger = trigger || null;
        this.commandOpen = true;
        this.commandIndex = 0;
        // 每次重開都從空白開始：留著上一次的字，使用者第一個動作永遠是先清掉它。
        this.commandQuery = "";
        this.commandResults = [];
        this.focusCommand();
      },
      showSearch(event) {
        this.openCommand(event && event.currentTarget);
      },
      // 三類結果攤平成一個清單，鍵盤上下鍵才能一路走到底（分組會讓索引邏輯多一層）。
      // kind 只是顯示用的標籤，讓「新對話」這種撞名的項目分得出是任務還是對話。
      async runCommandSearch() {
        const seq = ++this.commandSeq;
        const q = this.commandQuery.trim();
        try {
          const data = await Api.get("search?q=" + encodeURIComponent(q));
          if (seq !== this.commandSeq) return;
          this.commandResults = [
            ...(data.tasks || []).map((t) => ({
              key: "task-" + t.id, kind: "任務", label: t.title || t.task_id,
              hint: t.project_name || "", path: "/task/" + t.id,
            })),
            ...(data.chats || []).map((c) => ({
              key: "chat-" + c.id, kind: "對話", label: c.title || "新對話",
              hint: c.project_name || "", path: "/projects/" + c.project_id + "/chat/" + c.id,
            })),
            ...(data.projects || []).map((p) => ({
              key: "project-" + p.id, kind: "專案", label: p.name,
              hint: "", path: "/projects/" + p.id,
            })),
          ];
        } catch (error) {
          if (seq !== this.commandSeq) return;
          this.commandResults = [];
        } finally {
          if (seq === this.commandSeq) this.commandLoading = false;
        }
      },
      closeCommand() {
        // Escape 是全域監聽，palette 沒開時也會呼叫到這裡；
        // 不擋的話會把別人鎖的背景捲動一起解掉。
        if (!this.commandOpen) return;
        this.commandOpen = false;
        this.$nextTick(() => this.commandTrigger && this.commandTrigger.focus());
      },
      // overlay 開啟時背景不該跟著捲動：不鎖的話在 palette 內滾到底會穿透到後面的頁面。
      // 由「有沒有任何 overlay 開著」推導，而不是在每個開關處各自加解鎖——
      // 後者在「開 palette → 開側欄 → 關 palette」時，會在側欄還開著的情況下把捲動解掉。
      // 呼叫點集中在 watch，狀態從哪裡被改都會同步。
      syncBodyScroll() {
        const anyOpen = this.commandOpen || this.mobileSidebarOpen;
        document.body.style.overflow = anyOpen ? "hidden" : "";
      },
      // ⌘K 的使用者幾乎都在用鍵盤，沒有方向鍵等於只能改用滑鼠點。
      // 循環（%）而不是夾在兩端：清單短時從最後一項往下回到第一項比較順手。
      moveCommand(step) {
        const total = this.commandItems.length;
        if (!total) return;
        this.commandIndex = (this.commandIndex + step + total) % total;
      },
      chooseCommand() {
        const item = this.commandItems[this.commandIndex];
        if (item) this.selectCommand(item);
      },
      selectCommand(item) {
        this.closeCommand();
        this.commandQuery = "";
        this.commandResults = [];
        this.go(item.path);
      },
      openTour() {
        this.toolsOpen = false;
        window.TourManager.open();
      },
      // ── 側欄 ⋮ 選單 ───────────────────────────────────────────────
      // 兩份選單共用「同時只能開一個」的規則，否則點開第二個時第一個還浮在上面。
      // 右鍵＝直接開，不切換：對著已開的選單再按一次右鍵而它關掉，操作起來像沒反應。
      openProjectMenu(project, event) {
        event.stopPropagation();
        this.menuChatId = null;
        this.menuProjectId = project.id;
        this.placeRowMenuAt(event);
      },
      openChatMenu(chat, event) {
        if (this.renamingChatId === chat.id) return; // 正在改名，讓瀏覽器原生的文字選單留著
        event.stopPropagation();
        this.menuProjectId = null;
        this.menuChatId = chat.id;
        this.placeRowMenuAt(event);
      },
      // ⚠ 選單必須 teleport 出側欄（見 template）。目標是 [data-ui="next"] 而不是 body——
      // 配色變數（--surface／--text…）定義在那個容器上，搬到 body 會退回 legacy 的值。.ui-next-chat-row 帶著 translate:0 -2px，
      // 而 translate 會讓那一列成為 fixed 的 containing block——滑鼠一離開，translate 消失、
      // 基準換回視窗，選單就從指標處彈到畫面左上角（實測 175,361 → 130,17）。
      // ⚠ 也不要試著自己把滑鼠座標換算成 left/top。body 有 zoom: var(--ui-zoom)，而 zoom 元素
      // 同時是 fixed 的 containing block——實測用「clientX / zoom」直接寫進去，落點偏了 345px。
      // 改成先放上去、量出實際落點、再把差距補回來：不管中間隔了幾層縮放都會對齊。
      placeRowMenuAt(event) {
        const target = { x: event.clientX, y: event.clientY };
        // ready:false → 這一幀先藏起來。第一次放上去的位置是還沒校正的，看得到的話就是
        // 「先閃在一個地方、再跳到指標處」。校正在下一幀完成，肉眼看到的只有最終位置。
        this.rowMenuPos = { x: target.x, y: target.y, target, ready: false };
        this.$nextTick(() => this.alignRowMenu());
      },
      alignRowMenu() {
        const menu = document.querySelector(".ui-next-row-menu.is-at-pointer");
        if (!menu || !this.rowMenuPos || !this.rowMenuPos.target) return;
        const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
        const rect = menu.getBoundingClientRect();
        const target = this.rowMenuPos.target;
        let dx = target.x - rect.x;
        let dy = target.y - rect.y;
        // 靠近視窗邊緣時往內收：選單開在畫面外等於這次右鍵沒有反應。
        const right = rect.x + dx + rect.width, bottom = rect.y + dy + rect.height;
        if (right > window.innerWidth - 8) dx -= right - (window.innerWidth - 8);
        if (bottom > window.innerHeight - 8) dy -= bottom - (window.innerHeight - 8);
        this.rowMenuPos = { x: this.rowMenuPos.x + dx / zoom, y: this.rowMenuPos.y + dy / zoom, target, ready: true };
      },
      toggleProjectMenu(project, event) {
        event.stopPropagation();
        this.rowMenuPos = null;
        this.menuChatId = null;
        this.menuProjectId = this.menuProjectId === project.id ? null : project.id;
      },
      toggleChatMenu(chat, event) {
        event.stopPropagation();
        this.rowMenuPos = null;
        this.menuProjectId = null;
        this.menuChatId = this.menuChatId === chat.id ? null : chat.id;
      },
      closeSidebarMenus() {
        this.menuProjectId = null;
        this.menuChatId = null;
        this.rowMenuPos = null;
      },
      // 頁籤寫進 query，專案詳情頁的 detailTab 會照著開；直接 push 路徑只會停在第一個頁籤。
      goProjectTab(id, tab) {
        this.closeSidebarMenus();
        this.go(tab ? `/projects/${id}?tab=${tab}` : `/projects/${id}`);
      },
      // 沿用專案頁那支：先開空白分頁再輪詢 SSO URL。不先開分頁的話，
      // 等 await 回來才 window.open 會被瀏覽器當成非使用者手勢而擋掉。
      async openEnv(id) {
        this.closeSidebarMenus();
        const popup = window.open("about:blank", "_blank");
        try {
          const url = await window.pollEnvSso(id);
          if (popup) popup.location = url; else window.location.href = url;
        } catch (error) {
          if (popup) popup.close();
          showToast(error.message || "無法開啟測試區", "error", 0);
        }
      },
      openRelease(id) {
        this.closeSidebarMenus();
        this.releaseId = id;
      },
      startRenameChat(chat) {
        this.closeSidebarMenus();
        this.renamingChatId = chat.id;
        this.renameTitle = chat.title || "";
        this.$nextTick(() => this.$refs.renameInput && this.$refs.renameInput[0] && this.$refs.renameInput[0].select());
      },
      cancelRenameChat() {
        this.renamingChatId = null;
        this.renameTitle = "";
      },
      async submitRenameChat(project, chat) {
        const title = this.renameTitle.trim();
        if (!title || title === chat.title) { this.cancelRenameChat(); return; }
        try {
          const updated = await Api.put(`projects/${project.id}/chats/${chat.id}`, { title });
          // 只改 cache 裡那一筆：重抓整份清單會讓側欄閃一下，而且會蓋掉其他專案的展開狀態。
          const list = this.projectChats[project.id] || [];
          const at = list.findIndex((item) => String(item.id) === String(chat.id));
          if (at > -1) list[at] = { ...list[at], title: updated.title };
        } catch (error) {
          showToast(error.message || "無法重新命名對話", "error");
        }
        this.cancelRenameChat();
      },
      async deleteChat(project, chat) {
        this.closeSidebarMenus();
        if (!await confirmDialog({ title: "刪除對話", message: `確定刪除「${chat.title || "新對話"}」？`, danger: true, confirmText: "刪除" })) return;
        try {
          await Api.delete(`projects/${project.id}/chats/${chat.id}`);
          this.projectChats[project.id] = (this.projectChats[project.id] || []).filter((item) => String(item.id) !== String(chat.id));
          // 刪掉的正是目前開著的那個 Chat，留在原地會是一頁 404。
          if (this.isCurrentChat(project, chat)) this.go(`/projects/${project.id}/chat`);
        } catch (error) {
          showToast(error.message || "無法刪除對話", "error");
        }
      },
      toProject(project) {
        this.expandedProjects[project.id] = true;
        this.ensureProjectChats(project.id);
        this.go(`/projects/${project.id}`);
      },
      go(path) {
        this.closePopovers();
        this.mobileSidebarOpen = false;
        this.$router.push(path);
      },
      logout() {
        this.closePopovers();
        Api.clearToken();
        window.UserStore.role = "";
        SocketManager.disconnectSocket();
        this.$router.push("/login");
      },
      toggleTheme() {
        window.ThemeManager.toggle();
      },
      focusCommand() {
        this.$nextTick(() => {
          const input = this.$refs.commandPalette && this.$refs.commandPalette.querySelector("input");
          if (input) input.focus();
        });
      },
      // palette 與行動版抽屜共用。選擇器含 a[href]：抽屜裡的導覽項是 router-link（<a>），
      // 只找 input/button 會漏掉整份選單。offsetParent 過濾掉收合起來的區塊——
      // 把焦點送進看不見的元素，使用者會以為 Tab 壞了。
      trapFocus(event, container) {
        if (event.key !== "Tab" || !container) return;
        const focusable = Array.from(
          container.querySelectorAll('a[href], input, button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
        ).filter((el) => el.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      },
      trapCommandFocus(event) {
        this.trapFocus(event, this.$refs.commandPalette);
      },
      // 桌機時 aside 是永久導覽，不該 trap——否則使用者 Tab 不出側欄。
      trapSidebarFocus(event) {
        if (this.mobileSidebarOpen) this.trapFocus(event, this.$refs.mobileSidebar);
      },
      openMobileSidebar(event) {
        this.mobileSidebarTrigger = event && event.currentTarget;
        this.mobileSidebarOpen = true;
        // 焦點要移進抽屜，否則螢幕閱讀器仍停在背景，role="dialog" 等於白宣告。
        this.$nextTick(() => {
          const box = this.$refs.mobileSidebar;
          const first = box && box.querySelector('a[href], button:not([disabled])');
          (first || box)?.focus();
        });
      },
      // 只給「取消」類的關閉用（Escape、點遮罩）：焦點還原到當初開啟的按鈕。
      // 點選單項導航不走這裡——那時頁面已經換了，把焦點丟回選單鈕反而不對。
      closeMobileSidebar() {
        if (!this.mobileSidebarOpen) return;
        this.mobileSidebarOpen = false;
        this.$nextTick(() => this.mobileSidebarTrigger && this.mobileSidebarTrigger.focus());
      },
    },
    template: `
      <template v-if="!isLoggedIn || $route.path === '/login'"><router-view /></template>
      <div v-else class="ui-next-shell" data-ui="next">
        <a class="ui-next-skip-link" href="#ui-next-main">跳到主要內容</a>
        <button class="ui-next-mobile-menu" type="button" aria-label="開啟主選單" :aria-expanded="mobileSidebarOpen ? 'true' : 'false'" @click="openMobileSidebar($event)"><ui-next-icon name="grid"/></button>
        <div v-if="mobileSidebarOpen" class="ui-next-sidebar-backdrop" @click="closeMobileSidebar(); closePopovers()"></div>
        <!-- role/aria-modal 只在行動版抽屜開啟時掛上：桌機的同一個 aside 是永久導覽，
             無條件標成 dialog 會讓輔助技術把整個側欄誤報成對話框。 -->
        <aside ref="mobileSidebar" class="ui-next-sidebar" :class="{ 'is-mobile-open': mobileSidebarOpen }" :role="mobileSidebarOpen ? 'dialog' : null" :aria-modal="mobileSidebarOpen ? 'true' : null" :aria-label="mobileSidebarOpen ? '主選單' : null" :tabindex="mobileSidebarOpen ? '-1' : null" @keydown="trapSidebarFocus">
          <div class="ui-next-brand"><img src="favicon.svg" alt="OAA"><span><b>Odoo AI</b><small>自動開發平台</small></span></div>
          <button class="ui-next-new" @click="go('/')"><ui-next-icon name="plus"/>新對話</button>
          <button class="ui-next-search" title="搜尋（⌘ K）" @click="showSearch($event)"><ui-next-icon name="search"/>搜尋</button>
          <div class="ui-next-sidebar-scroll">
          <div class="ui-next-sidebar-rule"></div>
          <!-- 沒有「問答」：它和上面的「新對話」都是導到 /，同一個入口列兩次。 -->
          <router-link class="ui-next-nav" :class="{ 'is-active': $route.path === '/tasks' || $route.path.startsWith('/task/') }" to="/tasks" @click="mobileSidebarOpen=false"><ui-next-icon name="tasks"/>任務列表 <span v-if="needsActionCount">{{ needsActionCount }}</span></router-link>
          <!-- 專案清單是「專案」這個入口的下層，不是另一個區塊。沒有展開箭頭：
               清單常駐，專案的展開改成點名稱本身，右側 ⋮ 才是那一列的操作入口。 -->
          <div class="ui-next-nav-group">
            <router-link class="ui-next-nav" :class="{ 'is-active': $route.path.startsWith('/projects') }" to="/projects" @click="mobileSidebarOpen=false"><ui-next-icon name="project"/>專案 <span v-if="projectUnreadTotal">{{ projectUnreadTotal }}</span></router-link>
            <div class="ui-next-projects"><p v-if="sidebarProjectsError" class="ui-next-sidebar-error">{{ sidebarProjectsError }}</p><p v-else-if="!sidebarProjects.length" class="ui-next-sidebar-empty">沒有近期對話或我的最愛專案</p><div v-for="project in sidebarProjects" :key="project.id"><div class="ui-next-project-head" :class="{ 'is-current': currentProjectId === String(project.id) && !currentChatId, 'has-menu': menuProjectId === project.id }" @contextmenu.prevent="openProjectMenu(project, $event)"><button @click="toggleProject(project)" :aria-expanded="!!expandedProjects[project.id]"><ui-next-icon name="project"/>{{ project.name }}</button><button type="button" class="ui-next-row-more" :aria-label="project.name + ' 更多操作'" :aria-expanded="menuProjectId === project.id ? 'true' : 'false'" aria-haspopup="menu" @click="toggleProjectMenu(project, $event)"><ui-next-icon name="dots"/></button><teleport to="[data-ui='next']" :disabled="!rowMenuPos"><div v-if="menuProjectId === project.id" class="ui-next-row-menu" :class="{ 'is-at-pointer': !!rowMenuPos }" :style="rowMenuStyle" role="menu"><button type="button" role="menuitem" @click="openEnv(project.id)">測試區</button><button type="button" role="menuitem" @click="openRelease(project.id)">上正式</button><button type="button" role="menuitem" @click="goProjectTab(project.id, 'repos')">REPO</button><button type="button" role="menuitem" @click="goProjectTab(project.id, 'db')">連線設定</button><button type="button" role="menuitem" @click="goProjectTab(project.id, 'settings')">專案設定</button></div></teleport></div><div v-if="expandedProjects[project.id]" class="ui-next-project-chats"><div v-for="chat in visibleChats(project)" :key="chat.id" class="ui-next-chat-row" :class="{ 'has-menu': menuChatId === chat.id, 'is-active': isCurrentChat(project, chat) }" @contextmenu.prevent="openChatMenu(chat, $event)"><input v-if="renamingChatId === chat.id" ref="renameInput" v-model="renameTitle" class="ui-next-rename-input" :aria-label="'重新命名對話'" @keydown.enter.prevent="submitRenameChat(project, chat)" @keydown.esc.prevent="cancelRenameChat" @blur="submitRenameChat(project, chat)"><template v-else><button :aria-current="isCurrentChat(project, chat) ? 'page' : null" @click="go('/projects/' + project.id + '/chat/' + chat.id)">{{ chat.title || '新對話' }}</button><button type="button" class="ui-next-row-more" :aria-label="(chat.title || '新對話') + ' 更多操作'" :aria-expanded="menuChatId === chat.id ? 'true' : 'false'" aria-haspopup="menu" @click="toggleChatMenu(chat, $event)"><ui-next-icon name="dots"/></button><teleport to="[data-ui='next']" :disabled="!rowMenuPos"><div v-if="menuChatId === chat.id" class="ui-next-row-menu" :class="{ 'is-at-pointer': !!rowMenuPos }" :style="rowMenuStyle" role="menu"><button type="button" role="menuitem" @click="startRenameChat(chat)">重新命名</button><button type="button" role="menuitem" class="danger" @click="deleteChat(project, chat)">刪除</button></div></teleport></template></div><button v-if="(projectChats[project.id] || []).length" class="ui-next-all-chats" @click="go('/projects/' + project.id + '?tab=chat')">查看全部對話</button></div></div></div>
          </div>
          </div>
          <div class="ui-next-bottom">
            <div class="ui-next-tools-wrap"><div v-if="toolsOpen" ref="toolsMenu" class="ui-next-account-menu" role="menu" @keydown.down.prevent="moveMenu($event, 1)" @keydown.up.prevent="moveMenu($event, -1)"><button role="menuitem" @click="openTour"><ui-next-icon name="book"/>新手教學</button><button role="menuitem" v-if="isAdmin" @click="go('/admin/pipelines')"><ui-next-icon name="flow"/>進行中 Pipeline</button><button role="menuitem" v-if="isAdmin" @click="go('/token-report')"><ui-next-icon name="chart"/>用量報表</button><button role="menuitem" @click="go('/architecture')"><ui-next-icon name="project"/>架構圖</button><button role="menuitem" @click="go('/pipeline-flow')"><ui-next-icon name="flow"/>流程圖</button></div><button ref="toolsTrigger" class="ui-next-tools" @click="toggleTools($event)" :aria-expanded="toolsOpen" aria-haspopup="menu"><ui-next-icon name="grid"/>更多工具 <ui-next-icon :name="toolsOpen ? 'chevron-up' : 'chevron-down'"/></button></div>
            <div class="ui-next-account-wrap"><div v-if="accountOpen" ref="accountMenu" class="ui-next-account-menu" role="menu" @keydown.down.prevent="moveMenu($event, 1)" @keydown.up.prevent="moveMenu($event, -1)"><button role="menuitem" @click="go('/settings')">設定</button><button role="menuitem" @click="toggleTheme">切換深淺色</button><button role="menuitem" v-if="isAdmin" @click="go('/admin')">管理員</button><button role="menuitem" @click="logout">登出</button></div><button ref="accountTrigger" class="ui-next-account" @click="toggleAccount($event)" :aria-expanded="accountOpen" aria-haspopup="menu"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ui-next-user-icon" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg><span>帳號與設定</span><ui-next-icon :name="accountOpen ? 'chevron-up' : 'chevron-down'"/></button></div>
            <router-link v-if="isAdmin && usageRows.length" class="ui-next-usage" to="/token-report"><div v-for="row in usageRows" :key="row.label" class="ui-next-usage-row"><span v-if="row.provider==='claude'" class="usage-provider-logo claude" role="img" :aria-label="row.label"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="currentColor"><path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"></path></svg></span><span v-else class="usage-provider-logo codex" role="img" :aria-label="row.label"><img src="https://images.ctfassets.net/kftzwdyauwt9/77tJ5U1tgxHMZflZ5m4Z24/ace4d8b6ad200d87ebcb69c466344343/Blossom_4k_Icon_1.png?w=1920&amp;q=90&amp;fm=webp" alt=""></span><strong>剩 {{ row.remaining }}%</strong><small>更新 {{ formatUsageUpdated(row.updatedAt) }}<template v-if="row.resetsAt"> · 重置 {{ formatUsageReset(row.resetsAt) }}</template></small><i><em :class="row.level" :style="{ width: row.used + '%' }"></em></i></div></router-link>
          </div>
        </aside>
        <main id="ui-next-main" class="ui-next-main" tabindex="-1"><router-view :key="$route.path" /></main>
        <!-- 掛在 shell 而不是 aside 內：側欄是 overflow:hidden，放進去會被裁掉一半。 -->
        <ReleaseModal v-if="releaseId" :key="releaseId" :project-id="releaseId" @close="releaseId=null" />
        <div v-if="commandOpen" ref="commandPalette" class="ui-next-command-backdrop" @click.self="closeCommand" @keydown.esc="closeCommand" @keydown.down.prevent="moveCommand(1)" @keydown.up.prevent="moveCommand(-1)" @keydown="trapCommandFocus">
          <section class="ui-next-command" role="dialog" aria-modal="true" aria-label="快速切換">
            <!-- Enter 綁在 input 而不是 backdrop：焦點若在某個選項上，backdrop 的 Enter
                 會和該按鈕的原生 click 同時觸發,等於導航兩次。 -->
            <input ref="commandInput" v-model="commandQuery" autofocus placeholder="搜尋任務、對話或專案…" role="combobox" aria-expanded="true" aria-controls="ui-next-command-list" :aria-activedescendant="commandItems.length ? 'ui-next-command-item-' + commandIndex : null" @keydown.enter.prevent="chooseCommand()">
            <div id="ui-next-command-list" role="listbox" aria-label="搜尋結果">
              <button v-for="(item, index) in commandItems" :key="item.key" :id="'ui-next-command-item-' + index" role="option" :aria-selected="index === commandIndex" :class="{ 'is-active': index === commandIndex }" @click="selectCommand(item)" @mousemove="commandIndex = index"><em class="ui-next-command-kind">{{ item.kind }}</em><b>{{ item.label }}</b><small v-if="item.hint">{{ item.hint }}</small><span><ui-next-icon name="enter"/></span></button>
            </div>
            <p v-if="commandLoading">搜尋中…</p>
            <p v-else-if="!commandQuery.trim()">輸入關鍵字搜尋任務、對話或專案</p>
            <p v-else-if="!commandItems.length">找不到符合的項目</p>
          </section>
        </div>
      </div>
      <!-- 這三個全域 overlay 必須在 v-if/v-else 兩個分支之外。
           原本掛在 shell 這個 v-else 裡面，於是未登入與 /login 頁走 v-if 分支時三者都不存在：
           登入失敗的 toast、確認視窗、新手教學在那些頁面上全部靜默不出現。
           它們都是 position:fixed 的 overlay，放在哪一層不影響定位。 -->
      <div class="toast-container" role="status" aria-live="polite" aria-atomic="false">
        <div v-for="t in toasts" :key="t.id" class="toast" :class="t.level">{{ t.message }}<button v-if="t.sticky" type="button" class="toast-close" aria-label="關閉訊息" @click="dismissToast(t.id)"><ui-next-icon name="close"/></button></div>
      </div>
      <confirm-dialog-host />
      <tour-host />
    `,
  });
})();
