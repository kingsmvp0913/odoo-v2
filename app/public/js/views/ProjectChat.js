window.ProjectChatView = Vue.defineComponent({
  name: 'ProjectChatView',
  data() {
    return {
      chats: [],
      activeChat: null,
      messages: [],
      newInput: '',
      sending: false,
      loadingMsgs: false,
      newTitle: '',
      draftingTask: false,
      showTaskModal: false,
      taskDraft: { title: '', original_text: '', attachments: [] },
      creatingTask: false,
      replyPending: false,   // 後端 reply_pending：離開對話再回來仍能看到「回覆進行中」動畫
      pendingFiles: [],      // 這則訊息要一起送出的圖（尚未送出）
      pendingPreviews: [],   // 與 pendingFiles 同索引的 objectURL，送出／移除時要 revoke
      attachUrls: {},        // 已送出訊息的附圖：attId → objectURL（認證走 header，不能直接 <img src>）
      _pollTimer: null
    };
  },
  async created() { await this.loadChats(); },
  beforeUnmount() { this._gone = true; this.stopReplyPoll(); this.revokeAllUrls(); },
  methods: {
    // 新手教程的示範專案：對話內容來自 tour-demo.js，不打 API
    isTourDemo() { return !!(window.TourDemo && window.TourDemo.isProject(this.$route.params.id)); },
    async loadChats() {
      const pid = this.$route.params.id;
      this.chats = this.isTourDemo()
        ? window.TourDemo.chats()
        : await Api.get(`projects/${pid}/chats`).catch(() => []);
      const cid = this.$route.params.chatId;
      if (cid) {
        this.activeChat = this.chats.find(c => String(c.id) === String(cid)) || null;
        if (this.activeChat) await this.loadMessages();
      }
    },
    async selectChat(chat) {
      this.activeChat = chat;
      this.$router.replace(`/projects/${this.$route.params.id}/chat/${chat.id}`);
      await this.loadMessages();
    },
    // 這頁所有 await 回來後寫回 this.messages 的地方，都必須先確認使用者還停在送出／請求當下
    // 的那個對話——否則慢回來的那份會寫進「現在這個」對話的畫面，看起來就是訊息跑到別的對話去。
    isStillOn(cid) { return !this._gone && !!this.activeChat && this.activeChat.id === cid; },
    async loadMessages() {
      if (!this.activeChat) return;
      if (this.isTourDemo()) { this.messages = window.TourDemo.chatMessages(); return; }
      const cid = this.activeChat.id;   // 這一輪抓的是哪個對話；await 回來時 activeChat 可能已經換人
      this.stopReplyPoll();   // 切換／重載前先停掉舊對話的輪詢
      this.loadingMsgs = true;
      try {
        this.revokeMessageUrls();   // 換對話／重載前先收掉舊圖，否則 objectURL 一路累積到離開頁面
        const msgs = await Api.get(`projects/${this.$route.params.id}/chats/${cid}/messages`);
        // 快速連點兩個對話時，先發的那個可能後回來——晚到的舊訊息會整包蓋掉現在這個對話
        if (!this.isStillOn(cid)) return;
        this.messages = msgs;
        this.loadAttachmentThumbs();
        this.replyPending = !!this.activeChat.reply_pending;
        this.$nextTick(() => this.scrollToBottom());
        await this.markRead(this.activeChat);
        // 這則對話的回覆仍在後端進行中（可能是別的分頁／上一次離開時送出的）→ 輪詢等它落地
        if (this.replyPending) this.startReplyPoll();
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loadingMsgs = false; }
    },
    // 回覆進行中時每 3 秒回抓對話清單，看 active 對話的 reply_pending 是否已清除；清除即代表回覆
    // （或中斷訊息）已落地，重載訊息顯示出來並收掉輪詢。
    startReplyPoll() {
      if (this._pollTimer || this.isTourDemo()) return;
      const cid = this.activeChat && this.activeChat.id;   // 這輪輪詢綁定的對話
      this._pollTimer = setInterval(async () => {
        if (!this.isStillOn(cid)) return this.stopReplyPoll();
        const pid = this.$route.params.id;
        let chats;
        try { chats = await Api.get(`projects/${pid}/chats`); }
        catch (e) { return; }   // 暫時抓不到就下一輪再試，不中斷輪詢
        // 抓清單的期間可能已經切走：再判一次，否則會把別的對話的 replyPending 清掉並多重載一次
        if (!this.isStillOn(cid)) return this.stopReplyPoll();
        this.chats = chats;
        const ac = chats.find(c => String(c.id) === String(this.activeChat.id));
        if (ac) this.activeChat = ac;
        if (!ac || !ac.reply_pending) {
          this.stopReplyPoll();
          await this.loadMessages();   // 落地後重載並 markRead（此時 reply_pending 已 false，不會再起輪詢）
        }
      }, 3000);
    },
    stopReplyPoll() {
      if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
      this.replyPending = false;
    },
    async markRead(chat) {
      if (!chat || this.isTourDemo()) return;
      const pid = this.$route.params.id;
      try {
        const { projectUnread } = await Api.post(`projects/${pid}/chats/${chat.id}/read`, {});
        UnreadStore.byProject[String(pid)] = projectUnread;
        chat.unread = 0;
      } catch (e) { /* 標記已讀失敗不影響閱讀 */ }
    },
    async createChat() {
      try {
        const title = this.newTitle.trim() || '新對話';
        const chat = await Api.post(`projects/${this.$route.params.id}/chats`, { title });
        this.newTitle = '';
        this.chats.unshift(chat);
        await this.selectChat(chat);
      } catch (e) { showToast(e.message, 'error'); }
    },
    async deleteChat(chat) {
      if (!await confirmDialog({ title: '刪除對話', message: `確定刪除對話「${chat.title || '新對話'}」？對話內容將無法復原。`, danger: true, confirmText: '刪除' })) return;
      try {
        await Api.delete(`projects/${this.$route.params.id}/chats/${chat.id}`);
        this.chats = this.chats.filter(c => c.id !== chat.id);
        if (this.activeChat && this.activeChat.id === chat.id) {
          this.activeChat = null;
          this.messages = [];
          this.$router.replace(`/projects/${this.$route.params.id}/chat`);
        }
      } catch (e) { showToast(e.message, 'error'); }
    },
    // 已送出訊息的附圖：端點認證走 Authorization header，把下載端點的網址直接綁進 img 的 src
    // 只會拿到 401，所以逐張 fetch 成 blob 再轉 objectURL。失敗的那張不畫，不影響其餘訊息。
    async loadAttachmentThumbs() {
      const pid = this.$route.params.id, cid = this.activeChat && this.activeChat.id;
      if (!cid) return;
      for (const m of this.messages) {
        for (const a of (m.attachments || [])) {
          if (this.attachUrls[a.id]) continue;
          try {
            const { blob } = await Api.getBlob(`projects/${pid}/chats/${cid}/attachments/${a.id}/download`);
            // 抓的期間可能已經換了對話（或離開頁面）：這裡寫進去的 URL 會沒有人回收，
            // 因為 revokeMessageUrls 已經把當時那份 attachUrls 換掉了
            if (this._gone || !this.activeChat || this.activeChat.id !== cid) return;
            this.attachUrls[a.id] = URL.createObjectURL(blob);
          } catch (e) { /* 單張載不出來就不畫這張 */ }
        }
      }
    },
    revokeMessageUrls() {
      Object.values(this.attachUrls).forEach(u => URL.revokeObjectURL(u));
      this.attachUrls = {};
      // 樂觀顯示用的預覽 URL：送出成功那條路徑已自己收掉，但送出失敗時那則訊息會留在畫面上，
      // 它的 URL 沒有別人管——一併在這裡收，否則每失敗一次就漏一份。
      this.messages.forEach(m => (m.pending_previews || []).forEach(u => URL.revokeObjectURL(u)));
    },
    revokePendingUrls() {
      this.pendingPreviews.forEach(u => URL.revokeObjectURL(u));
      this.pendingPreviews = [];
    },
    revokeAllUrls() { this.revokeMessageUrls(); this.revokePendingUrls(); },
    // 選檔與貼上共用的入口：型別與張數的把關只有這一處，兩條路徑不會漂移成「貼上能過、選檔不能」
    addPendingFiles(files) {
      for (const f of files) {
        if (!/^image\//.test(f.type || '')) { showToast(`「${f.name || '檔案'}」不是圖片，已略過`, 'error'); continue; }
        if (f.size > 10 * 1024 * 1024) { showToast(`「${f.name || '圖片'}」超過 10MB`, 'error'); continue; }
        if (this.pendingFiles.length >= 5) { showToast('一次最多 5 張圖', 'error'); break; }
        this.pendingFiles.push(f);
        this.pendingPreviews.push(URL.createObjectURL(f));
      }
    },
    onFilesSelected(e) {
      this.addPendingFiles(Array.from(e.target.files || []));
      e.target.value = '';   // 清掉才能連續選同一個檔
    },
    // 截圖後 Ctrl+V 直接貼——這是對話裡傳圖最常走的路徑，比開檔案總管找檔快得多
    onPaste(e) {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      const imgs = files.filter(f => /^image\//.test(f.type || ''));
      if (!imgs.length) return;   // 純文字貼上照原生行為走
      e.preventDefault();
      this.addPendingFiles(imgs);
    },
    removePendingFile(i) {
      URL.revokeObjectURL(this.pendingPreviews[i]);
      this.pendingFiles.splice(i, 1);
      this.pendingPreviews.splice(i, 1);
    },
    openImage(attId) {
      const url = this.attachUrls[attId];
      if (url) window.open(url, '_blank');
    },
    handleEnter(e) {
      if (e.isComposing || e.keyCode === 229) return; // IME 組字中，Enter 用於選字，不送出
      if (e.shiftKey) return; // Shift+Enter = newline
      e.preventDefault();
      this.send();
    },
    async send() {
      // 只貼一張截圖不打字也算一則訊息（後端同樣認），所以送出條件是「有字或有圖」
      if ((!this.newInput.trim() && !this.pendingFiles.length) || !this.activeChat || this.sending) return;
      const cid = this.activeChat.id;   // 這則是送去哪個對話；等回覆期間使用者可能已經切走
      const content = this.newInput.trim();
      const files = this.pendingFiles;
      const previews = this.pendingPreviews;
      this.newInput = '';
      // 先從 state 摘下來再清空：送出中使用者可以繼續選下一批圖，不會被這次的清空掃掉。
      // previews 的 objectURL 交給樂觀顯示的那則訊息續用，成功後由 revokeMessageUrls 統一回收。
      this.pendingFiles = [];
      this.pendingPreviews = [];
      this.sending = true;
      this.messages.push({
        id: Date.now(), role: 'user', content, created_at: new Date().toISOString(),
        pending_previews: previews   // 樂觀顯示：真正的 attachments 要等下一次 loadMessages 才有 id
      });
      this.$nextTick(() => this.scrollToBottom());
      try {
        const path = `projects/${this.$route.params.id}/chats/${cid}/messages`;
        let reply;
        if (files.length) {
          const fd = new FormData();
          fd.append('content', content);
          files.forEach(f => fd.append('files', f));
          ({ reply } = await Api.postForm(path, fd));
        } else {
          ({ reply } = await Api.post(path, { content }));
        }
        // 回覆常要跑數分鐘，這期間使用者可以自由切到別的對話：這份回覆屬於 cid，切走了就不能塞
        // 進畫面上那個對話（會變成別人的訊息），也不能拿現在的 activeChat 去標已讀。回到 cid 時
        // loadMessages 會從後端把它讀回來，訊息不會掉。
        if (!this.isStillOn(cid)) return;
        this.messages.push({ id: Date.now() + 1, role: 'ai', content: reply, created_at: new Date().toISOString() });
        this.$nextTick(() => this.scrollToBottom());
        await this.markRead(this.activeChat);
        // 重載一次讓剛送出的圖換成正式的 attachments（帶 id，之後重進對話仍看得到）。
        // previews 不在這裡 revoke——loadMessages 開頭的 revokeMessageUrls 會掃到樂觀那則並收掉；
        // 先收的話畫面會閃一下破圖再被換掉。
        if (files.length) await this.loadMessages();
      } catch (e) {
        showToast(e.message, 'error');
      } finally { this.sending = false; }
    },
    async toTask() {
      if (!this.activeChat || this.draftingTask) return;
      if (this.isTourDemo()) { this.taskDraft = window.TourDemo.chatDraft(); this.showTaskModal = true; return; }
      this.draftingTask = true;
      try {
        const draft = await Api.post(`projects/${this.$route.params.id}/chats/${this.activeChat.id}/draft-task`, {});
        // agent 挑出的圖預設勾選；使用者可取消，也可把它沒挑的勾回來
        this.taskDraft = {
          title: draft.title || '', original_text: draft.original_text || '',
          attachments: (draft.attachments || []).map(a => ({ ...a, chosen: !!a.chosen }))
        };
        this.showTaskModal = true;
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.draftingTask = false; }
    },
    async submitTask() {
      if (!this.taskDraft.title.trim()) return showToast('請填寫標題', 'error');
      if (!this.taskDraft.original_text.trim()) return showToast('請填寫內容', 'error');
      this.creatingTask = true;
      try {
        const task = await Api.post('tasks', {
          title: this.taskDraft.title.trim(),
          original_text: this.taskDraft.original_text,
          project_id: this.$route.params.id,
          chat_id: this.activeChat && this.activeChat.id,
          chat_attachment_ids: (this.taskDraft.attachments || []).filter(a => a.chosen).map(a => a.id)
        });
        this.showTaskModal = false;
        // activeChat 就是 chats 陣列裡的那個物件（selectChat 直接指過來），改它列上的徽章即刻出現，
        // 不必為了一個欄位重抓整份清單。
        if (this.activeChat && task && task.id) this.activeChat.converted_task_id = task.id;
        showToast('已建立任務，將於下輪 pipeline 自動分診', 'success');
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.creatingTask = false; }
    },
    scrollToBottom() {
      const el = this.$refs.messages;
      if (el) el.scrollTop = el.scrollHeight;
    },
    formatTime(ts) {
      if (!ts) return '';
      return new Date(ts).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
    // 走全站唯一的 markdown 消毒入口 renderMarkdown（見 markdown.js：轉義原始 HTML＋scheme 白名單）。
    // AI 回覆常含標題／清單／程式碼區塊，純文字插值會整段以原文顯示。
    renderMd(src) { return renderMarkdown(src); }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/projects')" style="margin-right:var(--space-3)">← 返回專案列表</button>
      <h1>專案對話</h1>
    </div>
    <div class="chat-split">
      <div data-tour="chat-list" class="chat-list-panel">
        <div style="padding:10px;border-bottom:1px solid var(--border)">
          <input v-model="newTitle" placeholder="對話標題（選填）" class="form-control" style="margin-bottom:6px;font-size:var(--fs-sm)" @keyup.enter="createChat" />
          <button class="btn btn-primary btn-sm" style="width:100%" @click="createChat">+ 新對話</button>
        </div>
        <div style="overflow-y:auto;flex:1">
          <div v-for="c in chats" :key="c.id"
               class="chat-list-item"
               :style="{ background: activeChat && activeChat.id === c.id ? 'var(--primary-light,#ebf4ff)' : '' }"
               @click="selectChat(c)">
            <span class="chat-list-item-title">{{ c.title }}</span>
            <span v-if="c.reply_pending" title="回覆進行中" style="margin-left:var(--space-1);flex-shrink:0;color:var(--text-muted);animation:pulse 1.2s ease-in-out infinite">●</span>
            <span v-if="c.unread" style="display:inline-block;min-width:16px;padding:0 5px;margin-left:var(--space-1);border-radius:var(--radius);background:var(--error,#e5484d);color:#fff;font-size:var(--fs-xs);line-height:16px;text-align:center;flex-shrink:0">{{ c.unread }}</span>
            <span v-if="c.converted_task_id" class="pill pill-info"
                  style="margin-left:var(--space-1);flex-shrink:0;cursor:pointer"
                  title="已轉為任務，點擊開啟"
                  @click.stop="$router.push('/task/' + c.converted_task_id)">已轉任務</span>
            <button class="btn btn-outline btn-sm"
                    style="font-size:var(--fs-2xs);padding:1px 5px;margin-left:var(--space-1);color:var(--error);flex-shrink:0"
                    @click.stop="deleteChat(c)">✕</button>
          </div>
          <div v-if="chats.length === 0" style="padding:var(--space-4);font-size:var(--fs-base);color:var(--text-muted);text-align:center">
            尚無對話，請點「+ 新對話」
          </div>
        </div>
      </div>

      <div class="chat-main">
        <div v-if="!activeChat" class="chat-empty-state">
          請選擇或建立對話
        </div>
        <template v-else>
          <div class="chat-header">
            <span class="chat-header-title">{{ activeChat.title }}</span>
            <button class="btn btn-outline btn-sm" data-tour="chat-totask" @click="toTask" :disabled="draftingTask || sending">
              {{ draftingTask ? '摘要中...' : '＋ 轉為任務' }}
            </button>
          </div>
          <div class="chat-messages" data-tour="chat-messages" ref="messages">
            <div v-if="loadingMsgs" class="loading">載入中...</div>
            <div v-for="m in messages" :key="m.id">
              <div :style="{ display:'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }">
                <div class="chat-md" :style="{
                  maxWidth:'70%', padding:'8px 12px', borderRadius:'10px', fontSize:'var(--fs-base)',
                  background: m.role === 'user' ? 'var(--primary)' : 'var(--surface)',
                  color: m.role === 'user' ? '#fff' : 'var(--text)',
                  border: m.role === 'ai' ? '1px solid var(--border)' : 'none'
                }" v-html="renderMd(m.content)" v-show="m.content"></div>
              </div>
              <!-- 附圖：objectURL 由 loadAttachmentThumbs 逐張抓（端點要 Authorization header，
                   直接把 URL 塞進 src 只會拿到 401）。pending_previews 是剛送出那則的樂觀顯示。 -->
              <div v-if="(m.attachments && m.attachments.length) || (m.pending_previews && m.pending_previews.length)"
                   :style="{ display:'flex', flexWrap:'wrap', gap:'6px', marginTop:'4px', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }">
                <img v-for="a in (m.attachments || [])" :key="a.id" v-show="attachUrls[a.id]"
                     :src="attachUrls[a.id]" :alt="a.filename" :title="a.filename"
                     @click="openImage(a.id)"
                     style="max-width:200px;max-height:160px;border-radius:8px;border:1px solid var(--border);cursor:pointer;display:block" />
                <img v-for="(u, i) in (m.pending_previews || [])" :key="'p' + i" :src="u"
                     style="max-width:200px;max-height:160px;border-radius:8px;border:1px solid var(--border);opacity:.7;display:block" />
              </div>
              <div :style="{ textAlign: m.role === 'user' ? 'right' : 'left', fontSize:'var(--fs-xs)', color:'var(--text-muted)', marginTop:'2px' }">
                {{ m.role === 'user' ? '你' : '🤖 AI' }} · {{ formatTime(m.created_at) }}
              </div>
            </div>
            <div v-if="sending || replyPending" class="chat-typing-wrap">
              <div class="chat-typing-bubble">
                <span style="animation:pulse 1.2s ease-in-out infinite">●</span>
                <span style="animation:pulse 1.2s ease-in-out infinite 0.3s">●</span>
                <span style="animation:pulse 1.2s ease-in-out infinite 0.6s">●</span>
              </div>
            </div>
          </div>
          <!-- 待送出的圖：送出前可逐張移除 -->
          <div v-if="pendingPreviews.length" style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px 0">
            <div v-for="(u, i) in pendingPreviews" :key="i" style="position:relative">
              <img :src="u" style="width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid var(--border);display:block" />
              <button class="btn btn-outline btn-sm" title="移除"
                      style="position:absolute;top:-6px;right:-6px;padding:0 5px;font-size:var(--fs-2xs);line-height:16px;color:var(--error);background:var(--surface)"
                      @click="removePendingFile(i)">✕</button>
            </div>
          </div>
          <div data-tour="chat-input" class="chat-input-bar">
            <input ref="chatFileInput" type="file" accept="image/*" multiple @change="onFilesSelected" style="display:none" />
            <button class="btn btn-outline" title="附加圖片（也可直接 Ctrl+V 貼上截圖）"
                    style="align-self:flex-end" @click="$refs.chatFileInput.click()" :disabled="sending">📎</button>
            <textarea v-model="newInput"
                      placeholder="輸入訊息... (Enter 傳送，Shift+Enter 換行，可貼上截圖)"
                      style="flex:1;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--fs-base);resize:none;height:60px"
                      @paste="onPaste"
                      @keydown.enter="handleEnter"></textarea>
            <button class="btn btn-primary" @click="send" :disabled="sending || (!newInput.trim() && !pendingFiles.length)">
              {{ sending ? '傳送中...' : '傳送' }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- 轉為任務：可編輯草稿，確認才建立（用標準 modal class，深色主題可讀）-->
    <div v-if="showTaskModal" class="modal-overlay" @mousedown.self="showTaskModal=false" @keyup.esc="showTaskModal=false">
      <div class="modal modal-elevated chat-modal" data-tour="chat-modal" role="dialog" aria-modal="true">
        <div class="modal-title">轉為任務</div>
        <div class="modal-body">
          <div class="field-item" style="margin-bottom:var(--space-4)">
            <label class="field-label">標題 <span style="color:var(--danger)">*</span></label>
            <input class="form-control" v-model="taskDraft.title" placeholder="任務標題" @keyup.enter="submitTask" />
          </div>
          <div class="field-item">
            <label class="field-label">內容 <span style="color:var(--danger)">*</span></label>
            <textarea class="form-control" v-model="taskDraft.original_text" placeholder="需求描述（給分診/分析 Agent 參考）"
              style="min-height:180px;line-height:1.6;resize:vertical"></textarea>
          </div>
          <!-- 挑圖是 AI 判的，但這個視窗的既有精神就是草稿可人工修改，圖沒理由是唯一不能改的 -->
          <div class="field-item" v-if="taskDraft.attachments && taskDraft.attachments.length" style="margin-top:var(--space-4)">
            <label class="field-label">帶進任務的圖片</label>
            <div style="font-size:var(--fs-xs);color:var(--text-secondary);margin-bottom:6px">
              已勾選的是 AI 判斷後續開發需要看的；可自行增減。
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:10px">
              <label v-for="a in taskDraft.attachments" :key="a.id"
                     style="display:flex;align-items:center;gap:6px;font-size:var(--fs-sm);cursor:pointer">
                <input type="checkbox" v-model="a.chosen" />
                <img v-show="attachUrls[a.id]" :src="attachUrls[a.id]" :alt="a.filename"
                     style="width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid var(--border)" />
                <span>{{ a.filename }}</span>
              </label>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" @click="showTaskModal=false" :disabled="creatingTask">取消</button>
          <button class="btn btn-primary" @click="submitTask" :disabled="creatingTask">
            {{ creatingTask ? '建立中...' : '建立' }}
          </button>
        </div>
      </div>
    </div>
  `
});
