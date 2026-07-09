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
      newTitle: ''
    };
  },
  async created() { await this.loadChats(); },
  beforeUnmount() { this._gone = true; },
  methods: {
    async loadChats() {
      const pid = this.$route.params.id;
      this.chats = await Api.get(`projects/${pid}/chats`).catch(() => []);
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
    async loadMessages() {
      if (!this.activeChat) return;
      this.loadingMsgs = true;
      try {
        this.messages = await Api.get(`projects/${this.$route.params.id}/chats/${this.activeChat.id}/messages`);
        await this.markRead(this.activeChat);
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loadingMsgs = false; }
    },
    async markRead(chat) {
      if (!chat) return;
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
    handleEnter(e) {
      if (e.shiftKey) return; // Shift+Enter = newline
      e.preventDefault();
      this.send();
    },
    async send() {
      if (!this.newInput.trim() || !this.activeChat || this.sending) return;
      const content = this.newInput.trim();
      this.newInput = '';
      this.sending = true;
      this.messages.push({ id: Date.now(), role: 'user', content, created_at: new Date().toISOString() });
      this.$nextTick(() => this.scrollToBottom());
      try {
        const { reply } = await Api.post(
          `projects/${this.$route.params.id}/chats/${this.activeChat.id}/messages`,
          { content }
        );
        this.messages.push({ id: Date.now() + 1, role: 'ai', content: reply, created_at: new Date().toISOString() });
        this.$nextTick(() => this.scrollToBottom());
        if (!this._gone) await this.markRead(this.activeChat);
      } catch (e) {
        showToast(e.message, 'error');
      } finally { this.sending = false; }
    },
    scrollToBottom() {
      const el = this.$el && this.$el.querySelector('.chat-messages');
      if (el) el.scrollTop = el.scrollHeight;
    },
    formatTime(ts) {
      if (!ts) return '';
      return new Date(ts).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/projects/' + $route.params.id)" style="margin-right:var(--space-3)">← 返回專案</button>
      <h1>專案對話</h1>
    </div>
    <div style="flex:1;display:flex;overflow:hidden;min-width:0">
      <div style="width:220px;min-width:220px;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:10px;border-bottom:1px solid var(--border)">
          <input v-model="newTitle" placeholder="對話標題（選填）" class="form-control" style="margin-bottom:6px;font-size:var(--fs-sm)" @keyup.enter="createChat" />
          <button class="btn btn-primary btn-sm" style="width:100%" @click="createChat">+ 新對話</button>
        </div>
        <div style="overflow-y:auto;flex:1">
          <div v-for="c in chats" :key="c.id"
               style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center"
               :style="{ background: activeChat && activeChat.id === c.id ? 'var(--primary-light,#ebf4ff)' : '' }"
               @click="selectChat(c)">
            <span style="font-size:var(--fs-base);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">{{ c.title }}</span>
            <span v-if="c.unread" style="display:inline-block;min-width:16px;padding:0 5px;margin-left:var(--space-1);border-radius:var(--radius);background:var(--error,#e5484d);color:#fff;font-size:var(--fs-xs);line-height:16px;text-align:center;flex-shrink:0">{{ c.unread }}</span>
            <button class="btn btn-outline btn-sm"
                    style="font-size:var(--fs-2xs);padding:1px 5px;margin-left:var(--space-1);color:var(--error);flex-shrink:0"
                    @click.stop="deleteChat(c)">✕</button>
          </div>
          <div v-if="chats.length === 0" style="padding:var(--space-4);font-size:var(--fs-base);color:var(--text-muted);text-align:center">
            尚無對話，請點「+ 新對話」
          </div>
        </div>
      </div>

      <div style="flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden">
        <div v-if="!activeChat" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:var(--fs-md)">
          請選擇或建立對話
        </div>
        <template v-else>
          <div class="chat-messages" style="flex:1;overflow-y:auto;padding:var(--space-4);display:flex;flex-direction:column;gap:10px">
            <div v-if="loadingMsgs" class="loading">載入中...</div>
            <div v-for="m in messages" :key="m.id">
              <div :style="{ display:'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }">
                <div :style="{
                  maxWidth:'70%', padding:'8px 12px', borderRadius:'10px', fontSize:'var(--fs-base)', whiteSpace:'pre-wrap',
                  background: m.role === 'user' ? 'var(--primary)' : 'var(--surface)',
                  color: m.role === 'user' ? '#fff' : 'var(--text)',
                  border: m.role === 'ai' ? '1px solid var(--border)' : 'none'
                }">{{ m.content }}</div>
              </div>
              <div :style="{ textAlign: m.role === 'user' ? 'right' : 'left', fontSize:'var(--fs-xs)', color:'var(--text-muted)', marginTop:'2px' }">
                {{ m.role === 'user' ? '你' : '🤖 AI' }} · {{ formatTime(m.created_at) }}
              </div>
            </div>
            <div v-if="sending" style="display:flex;justify-content:flex-start">
              <div style="padding:8px 14px;border-radius:10px;background:var(--surface);border:1px solid var(--border);font-size:var(--fs-base);color:var(--text-muted);display:flex;align-items:center;gap:6px">
                <span style="animation:pulse 1.2s ease-in-out infinite">●</span>
                <span style="animation:pulse 1.2s ease-in-out infinite 0.3s">●</span>
                <span style="animation:pulse 1.2s ease-in-out infinite 0.6s">●</span>
              </div>
            </div>
          </div>
          <div style="padding:var(--space-3);border-top:1px solid var(--border);display:flex;gap:var(--space-2);align-items:flex-end">
            <textarea v-model="newInput"
                      placeholder="輸入訊息... (Enter 傳送，Shift+Enter 換行)"
                      style="flex:1;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:var(--fs-base);resize:none;height:60px"
                      @keydown.enter="handleEnter"></textarea>
            <button class="btn btn-primary" @click="send" :disabled="sending || !newInput.trim()">
              {{ sending ? '傳送中...' : '傳送' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  `
});
