const { newDb } = require('pg-mem');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret';

let dbModule, app;
let userId, otherUserId, projectId, token;

async function makeTask(ownerId, taskId, title, originalText) {
  const { rows: [row] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, title, original_text, project_id)
     VALUES ($1, $2, 'manual', $3, $4, $5) RETURNING id`,
    [ownerId, taskId, title, originalText, projectId]
  );
  return row.id;
}

async function makeChat(ownerId, title, messages = []) {
  const { rows: [chat] } = await dbModule.query(
    'INSERT INTO project_chats (project_id, title, user_id) VALUES ($1, $2, $3) RETURNING id',
    [projectId, title, ownerId]
  );
  for (const content of messages) {
    await dbModule.query(
      "INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1, 'user', $2)",
      [chat.id, content]
    );
  }
  return chat.id;
}

const search = q => request(app).get('/api/search').query({ q }).set({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('pass', 4);
  const { rows: [user] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('searcher', $1, 'S') RETURNING id",
    [hash]
  );
  userId = user.id;
  token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const { rows: [other] } = await dbModule.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('stranger', $1, 'X') RETURNING id",
    [hash]
  );
  otherUserId = other.id;

  const { rows: [proj] } = await dbModule.query(
    "INSERT INTO projects (name, odoo_version, description) VALUES ('鴻久', '17.0', '維修單模組') RETURNING id"
  );
  projectId = proj.id;

  await makeTask(userId, 'T-1', '銷售訂單加折扣欄位', '希望在報價單上多一個折扣百分比');
  await makeTask(userId, 'T-2', '維修工單列印', '列印時要帶出保固到期日');
  await makeTask(otherUserId, 'T-9', '別人的折扣任務', '不該被看到');

  await makeChat(userId, '新對話', ['折扣算錯了，幫我看一下']);
  await makeChat(userId, '報表匯出問題', []);
  await makeChat(otherUserId, '別人的折扣對話', ['不該被看到']);

  const expressApp = express();
  expressApp.use(express.json());
  require('../search-routes').registerRoutes(expressApp);
  app = expressApp;
}, 30000);

afterAll(() => { dbModule._setPoolForTesting(null); });

// 這支端點存在的理由就是「側欄搜尋改成搜東西、不搜頁面」。
// 回應形狀退回成含頁面清單時這條會紅。
test('回應只有任務／對話／專案三類，沒有頁面', async () => {
  const res = await search('折扣');
  expect(res.status).toBe(200);
  expect(Object.keys(res.body).sort()).toEqual(['chats', 'projects', 'tasks']);
});

test('任務搜得到標題', async () => {
  const res = await search('折扣欄位');
  expect(res.body.tasks.map(t => t.task_id)).toEqual(['T-1']);
});

// 使用者記得的常常是當初打的需求原文而不是後來被改過的標題，
// 只搜標題等於搜不到自己剛開的單。
test('任務搜得到需求內文，不只標題', async () => {
  const res = await search('保固到期日');
  expect(res.body.tasks.map(t => t.task_id)).toEqual(['T-2']);
});

// 預設標題「新對話」佔了很大比例，只搜標題的話這些對話全部找不回來。
test('對話搜得到訊息內容', async () => {
  const res = await search('算錯了');
  expect(res.body.chats.map(c => c.title)).toEqual(['新對話']);
});

test('對話搜得到標題', async () => {
  const res = await search('報表匯出');
  expect(res.body.chats.map(c => c.title)).toEqual(['報表匯出問題']);
});

// 同一場對話多則訊息命中時只該出現一次，否則八個名額會被一場對話吃光。
test('同一場對話命中多則訊息只回一筆', async () => {
  await makeChat(userId, '重複命中', ['關鍵字甲', '關鍵字甲再一次', '關鍵字甲第三次']);
  const res = await search('關鍵字甲');
  expect(res.body.chats.filter(c => c.title === '重複命中')).toHaveLength(1);
});

test('專案搜得到名稱與說明', async () => {
  expect((await search('鴻久')).body.projects.map(p => p.name)).toEqual(['鴻久']);
  expect((await search('維修單模組')).body.projects.map(p => p.name)).toEqual(['鴻久']);
});

// 專案共享是既有設計，任務與對話則否——別人的東西不可以從搜尋外洩。
test('搜不到別人的任務與對話', async () => {
  const res = await search('別人的');
  expect(res.body.tasks).toEqual([]);
  expect(res.body.chats).toEqual([]);
});

// 使用者常整段貼路徑或錯誤訊息進來搜，裡面的 % 與 _ 不逸脫就會變成萬用字元，
// 把全部東西撈出來（看起來像搜尋壞掉）。
test('LIKE 萬用字元被逸脫，不會撈出全部', async () => {
  const res = await search('%');
  expect(res.body.tasks).toEqual([]);
  expect(res.body.chats).toEqual([]);
  expect(res.body.projects).toEqual([]);
});

test('空關鍵字回三個空陣列，不掃全表', async () => {
  const res = await search('   ');
  expect(res.body).toEqual({ tasks: [], chats: [], projects: [] });
});

test('未帶 token → 401', async () => {
  const res = await request(app).get('/api/search').query({ q: '折扣' });
  expect(res.status).toBe(401);
});
