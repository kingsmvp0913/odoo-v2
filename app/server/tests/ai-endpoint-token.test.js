// 意圖：/ai/* 這四個端點（列連線／查客戶正式 DB／讀 wiki）原本唯一的門是「來源 IP 是不是 loopback」。
// 那道門擋得住，取決於 nginx 住在哪個網路命名空間——那是機房拓樸，不是程式碼能保證的事：
// nginx 一旦搬上宿主機（或改 network_mode: host、或有人加一層 port-forward），反代進來的請求
// 全部變成 127.0.0.1，四個端點同時對全網開放，而**程式碼一個字都不用改、測試不會紅、log 也看不出來**。
// 其中 POST /ai/db/query 不驗 token、不綁專案（專案 id 是從連線自己反查的），破了就是所有客戶
// 正式資料庫任意讀取。
//
// 所以這裡鎖住第二道門：只有平台自己派出去的 agent 帶得出通行碼。兩道門的失效原因不同
//（拓樸變更 vs 通行碼外流），一次調整不可能同時弄壞兩者。
const request = require('supertest');
const express = require('express');

const SECRET = 'test-app-secret-for-ai-token';
process.env.APP_SECRET = SECRET;

const { aiToken, AI_TOKEN_HEADER, aiEndpointGuard } = require('../lib/ai-token');

function appWith(guard) {
  const app = express();
  app.get('/ai/probe', guard, (req, res) => res.json({ ok: true }));
  return app;
}

// supertest 走真實 TCP，來源恆為 127.0.0.1 ＝ 第一道門本來就會放行；
// 這裡驗的正是「第一道放行之後，第二道還在不在」。
describe('/ai/* 第二道門：通行碼', () => {
  test('本機來源但沒帶通行碼 → 擋下', async () => {
    const res = await request(appWith(aiEndpointGuard)).get('/ai/probe');
    expect(res.status).toBe(403);
  });

  test('本機來源＋正確通行碼 → 放行', async () => {
    const res = await request(appWith(aiEndpointGuard))
      .get('/ai/probe').set(AI_TOKEN_HEADER, aiToken());
    expect(res.status).toBe(200);
  });

  test('通行碼錯誤 → 擋下', async () => {
    const res = await request(appWith(aiEndpointGuard))
      .get('/ai/probe').set(AI_TOKEN_HEADER, 'a'.repeat(64));
    expect(res.status).toBe(403);
  });

  // 錯誤訊息必須指向真因。這個修法最可能的故障是「agent 沒帶碼」，而症狀會是
  //「AI 突然查不到資料庫」——看起來完全不像權限問題。訊息說不清楚就會被查成別的東西。
  test('被擋下時的訊息要說得出是通行碼的問題', async () => {
    const res = await request(appWith(aiEndpointGuard)).get('/ai/probe');
    expect(res.body.error).toMatch(/通行碼/);
  });

  test('非本機來源即使帶對通行碼也擋下（兩道門是 AND 不是 OR）', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    aiEndpointGuard(
      { socket: { remoteAddress: '8.8.8.8' }, get: () => aiToken(), headers: { [AI_TOKEN_HEADER]: aiToken() } },
      res, next
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('通行碼本身', () => {
  // server 重啟後正在飛的 agent 手上那份不能作廢，否則症狀是「pipeline 跑到一半突然查不到資料庫」。
  // 所以必須從 APP_SECRET 推導（跨重啟穩定），不能啟動時隨機產生。
  test('同一個 APP_SECRET 恆得同一個通行碼', () => {
    expect(aiToken()).toBe(aiToken());
  });

  test('APP_SECRET 不同 → 通行碼不同', () => {
    const a = aiToken();
    process.env.APP_SECRET = SECRET + '-changed';
    const b = aiToken();
    process.env.APP_SECRET = SECRET;
    expect(b).not.toBe(a);
  });

  // 外洩時不可以連帶把加密金鑰一起賠掉（APP_SECRET 同時是 *_enc 欄位的金鑰）。
  test('通行碼不得等於 APP_SECRET、也不得包含它', () => {
    expect(aiToken()).not.toBe(SECRET);
    expect(aiToken()).not.toContain(SECRET);
  });

  // fail closed：沒有 APP_SECRET 就無法驗章，此時要擋而不是放行。
  test('APP_SECRET 未設定 → 通行碼為 null 且一律擋下', async () => {
    const saved = process.env.APP_SECRET;
    delete process.env.APP_SECRET;
    expect(aiToken()).toBeNull();
    const res = await request(appWith(aiEndpointGuard)).get('/ai/probe').set(AI_TOKEN_HEADER, 'whatever');
    expect(res.status).toBe(403);
    process.env.APP_SECRET = saved;
  });
});
