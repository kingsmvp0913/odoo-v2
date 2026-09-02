(function () {
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

})();
