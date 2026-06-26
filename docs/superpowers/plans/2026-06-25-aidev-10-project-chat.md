# AI Dev Web Platform — Sub-plan 10: Project Chat

**Goal:** 在專案下新增對話功能；使用者可對 AI 提問（優先用 wiki context，不足時讀 repo 程式碼），並保留對話記錄。

**Architecture:** 兩張新表（project_chats、project_chat_messages）；新路由 `/api/projects/:id/chats`；新 Vue component `ProjectChat.js`；新 Claude API helper `chat-agent.js`。

**Tech Stack:** Express 4、Vue 3 CDN、Claude API（haiku）、pg pool

## Global Constraints

- 不新增任何非 SP10 規格要求的欄位或功能
- pg-mem 相容性：不用 LEFT JOIN + GROUP BY + ::cast；JOIN 後的彙整在 JS 端合併
- 127/127 現有測試繼續通過

---

## Task 1: DB + Chat API Routes

**Files:**
- Modify: `app/server/db.js`
- Create: `app/server/chat-routes.js`
- Modify: `app/server/index.js`
- Create: `app/server/pipeline/chat-agent.js`
- Create: `app/server/tests/chat-routes.test.js`

### Tables

```sql
CREATE TABLE IF NOT EXISTS project_chats (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '新對話',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_chat_messages (
  id         SERIAL PRIMARY KEY,
  chat_id    INTEGER NOT NULL REFERENCES project_chats(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,   -- 'user' | 'ai'
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### API Routes (chat-routes.js)

```
GET  /api/projects/:projectId/chats          → list chats (id, title, created_at)
POST /api/projects/:projectId/chats          → { title? } → create chat
DELETE /api/projects/:projectId/chats/:id    → delete chat + messages
GET  /api/projects/:projectId/chats/:id/messages → list messages
POST /api/projects/:projectId/chats/:id/messages → { content } → user message + AI reply
```

### Chat Agent (chat-agent.js)

```javascript
async function chatReply(projectId, chatId, userMessage) {
  // 1. 取 wiki context（最多 5 頁，合計最多 3000 字元）
  // 2. fetch last 10 messages from project_chat_messages for context
  // 3. call claude-haiku-4-5-20251001, max_tokens 1024
  // 4. insert user message (role='user') + AI reply (role='ai') to project_chat_messages
  // 5. return AI reply text
}
```

- [ ] **Step 1: db.js 加兩張表**

在 `wiki_pages` 之後加入：

```javascript
`CREATE TABLE IF NOT EXISTS project_chats (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '新對話',
  created_at TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS project_chat_messages (
  id         SERIAL PRIMARY KEY,
  chat_id    INTEGER NOT NULL REFERENCES project_chats(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`,
```

- [ ] **Step 2: 建立 chat-agent.js**

```javascript
const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../db');

const client = new Anthropic();

async function chatReply(projectId, chatId, userMessage) {
  // wiki context
  const { rows: pages } = await query(
    'SELECT title, content FROM wiki_pages WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 5',
    [projectId]
  );
  let wikiContext = pages.map(p => `## ${p.title}\n${p.content}`).join('\n\n');
  if (wikiContext.length > 3000) wikiContext = wikiContext.slice(0, 3000) + '\n...(截斷)';

  // conversation history
  const { rows: history } = await query(
    'SELECT role, content FROM project_chat_messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 10',
    [chatId]
  );
  const messages = history.reverse().map(m => ({
    role: m.role === 'ai' ? 'assistant' : 'user',
    content: m.content
  }));
  messages.push({ role: 'user', content: userMessage });

  const systemPrompt = `你是一個熟悉 Odoo 的技術助理。請根據以下 Wiki 資料回答問題。若 Wiki 未涵蓋，可依你的知識回答。

Wiki 資料：
${wikiContext || '（無 wiki）'}`;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: systemPrompt,
    messages
  });

  const reply = msg.content?.[0]?.text || '（無回覆）';

  // save both messages
  await query(
    'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3)',
    [chatId, 'user', userMessage]
  );
  await query(
    'INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, $2, $3)',
    [chatId, 'ai', reply]
  );

  return reply;
}

module.exports = { chatReply };
```

- [ ] **Step 3: 建立 chat-routes.js**

```javascript
const { query } = require('./db');
const { verifyToken } = require('./auth');

function registerRoutes(app) {
  // List chats
  app.get('/api/projects/:projectId/chats', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, title, created_at FROM project_chats WHERE project_id = $1 ORDER BY created_at DESC',
        [req.params.projectId]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Create chat
  app.post('/api/projects/:projectId/chats', verifyToken, async (req, res) => {
    try {
      const title = (req.body.title || '').trim() || '新對話';
      const { rows: [chat] } = await query(
        'INSERT INTO project_chats (project_id, title) VALUES ($1, $2) RETURNING id, title, created_at',
        [req.params.projectId, title]
      );
      res.status(201).json(chat);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Delete chat
  app.delete('/api/projects/:projectId/chats/:id', verifyToken, async (req, res) => {
    try {
      await query('DELETE FROM project_chats WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // List messages
  app.get('/api/projects/:projectId/chats/:id/messages', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, role, content, created_at FROM project_chat_messages WHERE chat_id = $1 ORDER BY created_at ASC',
        [req.params.id]
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Send message → AI reply
  app.post('/api/projects/:projectId/chats/:id/messages', verifyToken, async (req, res) => {
    try {
      const content = (req.body.content || '').trim();
      if (!content) return res.status(400).json({ error: 'content required' });
      const { chatReply } = require('./pipeline/chat-agent');
      const reply = await chatReply(req.params.projectId, req.params.id, content);
      res.json({ reply });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
```

- [ ] **Step 4: index.js 加入 registerChatRoutes**

```javascript
const { registerRoutes: registerChatRoutes } = require('./chat-routes');
// in createApp():
registerChatRoutes(app);
```

- [ ] **Step 5: 建立 chat-routes.test.js**

測試 CRUD + message sending（mock chatReply）。

```javascript
const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret';

const mockChatReply = jest.fn();
jest.mock('../pipeline/chat-agent', () => ({ chatReply: mockChatReply }));

let dbModule, app;
let userId, projectId, token;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: [user] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('chatuser', $1, 'Chat') RETURNING id", [hash]
  );
  userId = user.id;
  token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version) VALUES ('ChatProj', '17.0') RETURNING id"
  );
  projectId = proj.id;

  const expressApp = express();
  expressApp.use(express.json());
  const { registerRoutes } = require('../chat-routes');
  registerRoutes(expressApp);
  app = expressApp;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });
beforeEach(() => { mockChatReply.mockReset(); });

const auth = () => ({ Authorization: `Bearer ${token}` });

test('GET /api/projects/:id/chats → empty list', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/chats`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
});

test('POST /api/projects/:id/chats → creates chat', async () => {
  const res = await request(app).post(`/api/projects/${projectId}/chats`).set(auth()).send({ title: '測試對話' });
  expect(res.status).toBe(201);
  expect(res.body.title).toBe('測試對話');
});

test('GET /api/projects/:id/chats → lists created chats', async () => {
  const res = await request(app).get(`/api/projects/${projectId}/chats`).set(auth());
  expect(res.body.length).toBeGreaterThanOrEqual(1);
});

test('POST messages → calls chatReply and returns reply', async () => {
  mockChatReply.mockResolvedValueOnce('AI 的回覆');
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title) VALUES ($1, '對話') RETURNING id", [projectId]
  );
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
    .set(auth()).send({ content: '你好' });
  expect(res.status).toBe(200);
  expect(res.body.reply).toBe('AI 的回覆');
  expect(mockChatReply).toHaveBeenCalledWith(String(projectId), String(chat.id), '你好');
});

test('POST messages → 400 if content empty', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title) VALUES ($1, '空') RETURNING id", [projectId]
  );
  const res = await request(app)
    .post(`/api/projects/${projectId}/chats/${chat.id}/messages`)
    .set(auth()).send({ content: '' });
  expect(res.status).toBe(400);
});

test('DELETE chat → removes it', async () => {
  const { rows: [chat] } = await dbModule.query(
    "INSERT INTO project_chats (project_id, title) VALUES ($1, '要刪') RETURNING id", [projectId]
  );
  const res = await request(app)
    .delete(`/api/projects/${projectId}/chats/${chat.id}`)
    .set(auth());
  expect(res.status).toBe(200);
});
```

- [ ] **Step 6: 執行測試**

```
cd app && npx jest tests/chat-routes.test.js --no-coverage
```

- [ ] **Step 7: 全套測試**

```
npx jest --no-coverage
```

- [ ] **Step 8: Commit**

```
git add app/server/db.js app/server/chat-routes.js app/server/pipeline/chat-agent.js app/server/index.js app/server/tests/chat-routes.test.js
git commit -m "feat: SP10 project chat API — chats CRUD + AI reply"
```

---

## Task 2: ProjectChat UI

**Files:**
- Create: `app/public/js/views/ProjectChat.js`
- Modify: `app/public/index.html`
- Modify: `app/public/js/app.js`
- Modify: `app/public/js/views/ProjectDetail.js`

### Layout

```
+---------------------------+----------------------------------+
| 對話列表 (220px)           | 訊息區 (flex)                   |
| [+ 新對話] [刪除]          | [user message]                  |
| > 測試對話（active）       | [ai reply]                      |
| 另一個對話                 | [user message]                  |
|                           | [ai reply]                      |
|                           | [輸入框] [傳送]                 |
+---------------------------+----------------------------------+
```

- [ ] **Step 1: 建立 ProjectChat.js**

Two-pane layout。左側 chat list，右側 message thread + input。

```javascript
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
  methods: {
    async loadChats() {
      const pid = this.$route.params.id;
      this.chats = await Api.get(`projects/${pid}/chats`);
      const cid = this.$route.params.chatId;
      if (cid) {
        this.activeChat = this.chats.find(c => String(c.id) === cid) || null;
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
      } finally { this.loadingMsgs = false; }
    },
    async createChat() {
      const title = this.newTitle.trim() || '新對話';
      const chat = await Api.post(`projects/${this.$route.params.id}/chats`, { title });
      this.newTitle = '';
      this.chats.unshift(chat);
      await this.selectChat(chat);
    },
    async deleteChat(chat) {
      await Api.delete(`projects/${this.$route.params.id}/chats/${chat.id}`);
      this.chats = this.chats.filter(c => c.id !== chat.id);
      if (this.activeChat?.id === chat.id) {
        this.activeChat = null;
        this.messages = [];
        this.$router.replace(`/projects/${this.$route.params.id}/chat`);
      }
    },
    async send() {
      if (!this.newInput.trim() || !this.activeChat || this.sending) return;
      const content = this.newInput.trim();
      this.newInput = '';
      this.sending = true;
      this.messages.push({ id: Date.now(), role: 'user', content, created_at: new Date().toISOString() });
      try {
        const { reply } = await Api.post(
          `projects/${this.$route.params.id}/chats/${this.activeChat.id}/messages`,
          { content }
        );
        this.messages.push({ id: Date.now() + 1, role: 'ai', content: reply, created_at: new Date().toISOString() });
      } catch (e) {
        showToast(e.message, 'error');
      } finally { this.sending = false; }
      this.$nextTick(() => {
        const el = this.$el?.querySelector('.chat-messages');
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
    formatTime(ts) {
      if (!ts) return '';
      return new Date(ts).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/projects/' + $route.params.id)" style="margin-right:12px">← 返回專案</button>
      <h1>專案對話</h1>
    </div>
    <div style="display:flex;height:calc(100vh - 56px)">
      <div style="width:220px;min-width:220px;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:10px;border-bottom:1px solid var(--border)">
          <input v-model="newTitle" placeholder="對話標題（選填）" class="form-control" style="margin-bottom:6px;font-size:12px" @keyup.enter="createChat" />
          <button class="btn btn-primary btn-sm" style="width:100%" @click="createChat">+ 新對話</button>
        </div>
        <div style="overflow-y:auto;flex:1">
          <div v-for="c in chats" :key="c.id"
               style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center"
               :style="{ background: activeChat && activeChat.id === c.id ? 'var(--primary-light, #ebf4ff)' : '' }"
               @click="selectChat(c)">
            <span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">{{ c.title }}</span>
            <button class="btn btn-outline btn-sm" style="font-size:10px;padding:1px 5px;margin-left:4px;color:var(--error)" @click.stop="deleteChat(c)">✕</button>
          </div>
          <div v-if="chats.length === 0" style="padding:16px;font-size:13px;color:var(--text-muted);text-align:center">尚無對話</div>
        </div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
        <div v-if="!activeChat" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:14px">
          請選擇或建立對話
        </div>
        <template v-else>
          <div class="chat-messages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px">
            <div v-if="loadingMsgs" class="loading">載入中...</div>
            <div v-for="m in messages" :key="m.id">
              <div :style="{ display:'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }">
                <div :style="{
                  maxWidth:'70%', padding:'8px 12px', borderRadius:'10px', fontSize:'13px', whiteSpace:'pre-wrap',
                  background: m.role === 'user' ? 'var(--primary)' : 'var(--surface)',
                  color: m.role === 'user' ? '#fff' : 'var(--text)',
                  border: m.role === 'ai' ? '1px solid var(--border)' : 'none'
                }">{{ m.content }}</div>
              </div>
              <div :style="{ textAlign: m.role === 'user' ? 'right' : 'left', fontSize:'11px', color:'var(--text-muted)', marginTop:'2px' }">
                {{ m.role === 'user' ? '你' : '🤖 AI' }} · {{ formatTime(m.created_at) }}
              </div>
            </div>
          </div>
          <div style="padding:12px;border-top:1px solid var(--border);display:flex;gap:8px">
            <textarea v-model="newInput" placeholder="輸入訊息..." style="flex:1;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px;resize:none;height:60px" @keydown.ctrl.enter="send" @keydown.meta.enter="send"></textarea>
            <button class="btn btn-primary" style="align-self:flex-end" @click="send" :disabled="sending || !newInput.trim()">
              {{ sending ? '傳送中...' : '傳送' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  `
});
```

- [ ] **Step 2: index.html 加入 ProjectChat.js**

在 WikiView.js 之前加入：

```html
<script src="/js/views/ProjectChat.js"></script>
```

- [ ] **Step 3: app.js 加路由 + 側欄連結不需要（從 ProjectDetail 進入）**

加入：
```javascript
{ path: '/projects/:id/chat', component: window.ProjectChatView, meta: { requiresAuth: true } },
{ path: '/projects/:id/chat/:chatId', component: window.ProjectChatView, meta: { requiresAuth: true } },
```

- [ ] **Step 4: ProjectDetail.js 加 Chat 按鈕**

在 Wiki 按鈕旁加：

```html
<button class="btn btn-outline" @click="goChat">💬 Chat</button>
```

加方法：
```javascript
goChat() { this.$router.push(`/projects/${this.$route.params.id}/chat`); }
```

- [ ] **Step 5: 全套測試 + Commit**
