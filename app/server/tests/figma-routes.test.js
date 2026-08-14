process.env.JWT_SECRET = 'test-figma-routes';
process.env.APP_SECRET = 'test-figma-routes-secret';
const express = require('express');
const request = require('supertest');
const { aiToken, AI_TOKEN_HEADER } = require('../lib/ai-token');
const figmaAuth = require('../lib/figma-auth');
const { parseFigmaUrl, extractNodes, toHex, MAX_NODES } = require('../figma-routes');

// 意圖：pipeline 的 agent 是 headless 子行程，Figma 官方 MCP 對它兩道都走不通（OAuth 無法互動授權、
// 讀取工具要 edit access 而我們只有 View seat）。這支端點是 agent 讀設計稿的唯一路徑，
// 驗的是「拿得到內容」「拿不到時說得出真因」「不靜默截斷」三件事。
const BOARD_URL = 'https://www.figma.com/board/0bX1o29PVIG3Nn2ERyqXSJ/%E6%9F%A5%E8%A9%A2%E6%B5%81%E7%A8%8B';

// 依實測的 FigJam 外形做的 fixture（SHAPE_WITH_TEXT 當線稿框、CONNECTOR 當流程箭頭）
const FIGJAM_DOC = {
  id: '0:0', type: 'DOCUMENT', name: 'Document',
  children: [{
    id: '0:1', type: 'CANVAS', name: 'Page 1',
    children: [
      {
        id: '1:28', type: 'SHAPE_WITH_TEXT', name: '請輸入姓名', characters: '請輸入姓名',
        absoluteBoundingBox: { x: -280.4, y: -204.2, width: 576, height: 32 },
        fills: [{ type: 'SOLID', visible: true, color: { r: 1, g: 1, b: 1, a: 1 } }],
        cornerRadius: 8,
        style: { fontFamily: 'Inter', fontSize: 16.2, fontWeight: 400 },
      },
      {
        id: '4:74', type: 'SHAPE_WITH_TEXT', name: '查詢', characters: '查詢',
        absoluteBoundingBox: { x: -88, y: -79, width: 192, height: 32 },
        fills: [{ type: 'SOLID', visible: true, color: { r: 0, g: 0.5, b: 1, a: 1 } }],
      },
      {
        id: '9:660', type: 'CONNECTOR', name: 'Connector line',
        connectorStart: { endpointNodeId: '4:74' },
        connectorEnd: { endpointNodeId: '1:28' },
        connectorText: { characters: '查無資料' },
      },
    ],
  }],
};

function appWithRoute() {
  const a = express();
  a.use(express.json());
  require('../figma-routes').registerRoutes(a);
  return a;
}

let app, fetchSpy;
beforeAll(() => { app = appWithRoute(); });
beforeEach(() => {
  figmaAuth._setForTesting('figd_test');
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ name: '查詢流程', editorType: 'figjam', role: 'viewer', document: FIGJAM_DOC }),
  });
});
afterEach(() => { fetchSpy.mockRestore(); figmaAuth._setForTesting(null); });

const get = url => request(app).get('/ai/figma').query({ url }).set(AI_TOKEN_HEADER, aiToken());

// --- 守衛 ---

test('沒帶通行碼 → 403（/ai/* 兩道門要真的掛上，不是只寫在註解裡）', async () => {
  const res = await request(app).get('/ai/figma').query({ url: BOARD_URL });
  expect(res.status).toBe(403);
  expect(fetchSpy).not.toHaveBeenCalled(); // 擋下就不該白打一次 Figma
});

// 這是本檔最重要的一條：Figma 沒有匿名額度，未設 token 若回 200 空清單，
// agent 會把「讀不到」當成「這份設計稿沒有內容」，照著空規格往下寫，而且全程無訊號。
test('未設 token → 503 且訊息指得出要去設定頁貼 token，絕不回空結果', async () => {
  figmaAuth._setForTesting(null);
  const res = await get(BOARD_URL);
  expect(res.status).toBe(503);
  expect(res.body.ok).toBe(false);
  expect(res.body.error).toMatch(/token 未設定/);
  expect(res.body.nodes).toBeUndefined();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('沒帶 url → 400，且不打 Figma', async () => {
  const res = await request(app).get('/ai/figma').set(AI_TOKEN_HEADER, aiToken());
  expect(res.status).toBe(400);
  expect(fetchSpy).not.toHaveBeenCalled();
});

// --- 網址解析 ---

test('parseFigmaUrl：design／board 都認得，node-id 的連字號要轉成 API 要的冒號', () => {
  expect(parseFigmaUrl('https://www.figma.com/design/abcdefghijklmnopqrstuv/X?node-id=12-34'))
    .toEqual({ fileKey: 'abcdefghijklmnopqrstuv', nodeId: '12:34' });
  expect(parseFigmaUrl('https://www.figma.com/board/0bX1o29PVIG3Nn2ERyqXSJ/X?t=abc'))
    .toEqual({ fileKey: '0bX1o29PVIG3Nn2ERyqXSJ', nodeId: null });
  expect(parseFigmaUrl('https://example.com/nope')).toBe(null);
});

test('網址帶 node-id → 打 /nodes 只取該節點；不帶 → 打整份檔案', async () => {
  await get(`${BOARD_URL}?node-id=12-34`);
  expect(fetchSpy.mock.calls[0][0]).toContain('/nodes?ids=12%3A34');

  fetchSpy.mockClear();
  await get(BOARD_URL);
  expect(fetchSpy.mock.calls[0][0]).toMatch(/\/files\/0bX1o29PVIG3Nn2ERyqXSJ$/);
});

test('token 走 X-Figma-Token header（Figma REST 不吃 Bearer）', async () => {
  await get(BOARD_URL);
  expect(fetchSpy.mock.calls[0][1].headers).toEqual({ 'X-Figma-Token': 'figd_test' });
});

// --- 萃取 ---

test('顏色 0~1 浮點轉 CSS hex；全不透明時不拖 alpha', () => {
  expect(toHex({ r: 1, g: 1, b: 1, a: 1 })).toBe('#ffffff');
  expect(toHex({ r: 0, g: 0.5, b: 1, a: 1 })).toBe('#0080ff');
  expect(toHex({ r: 0, g: 0, b: 0, a: 0.5 })).toBe('#00000080');
});

test('扁平化保留寫得進規格的數值：文字／座標尺寸／色碼／字型／圓角', async () => {
  const res = await get(BOARD_URL);
  expect(res.status).toBe(200);
  const input = res.body.nodes.find(n => n.id === '1:28');
  expect(input).toMatchObject({
    type: 'SHAPE_WITH_TEXT', text: '請輸入姓名',
    x: -280, y: -204, w: 576, h: 32,   // 取整：規格寫 px 不需要小數
    fill: '#ffffff', radius: 8, font: 'Inter 16px 400',
  });
});

// 線稿的流程箭頭是「哪個畫面按了會去哪」的唯一來源，端點 id 掉了就再也接不回去
test('CONNECTOR 的起訖節點 id 與線上標籤要保住', async () => {
  const res = await get(BOARD_URL);
  const conn = res.body.nodes.find(n => n.type === 'CONNECTOR');
  expect(conn).toMatchObject({ from: '4:74', to: '1:28', label: '查無資料' });
});

test('回應帶檔名／editorType／role，讓 agent 知道自己讀到的是哪一份、什麼權限', async () => {
  const res = await get(BOARD_URL);
  expect(res.body).toMatchObject({ ok: true, name: '查詢流程', editorType: 'figjam', role: 'viewer' });
  expect(res.body.nodeCount).toBe(res.body.nodes.length);
});

test('沒截斷時 truncated 為 null（不要讓下游每次都得判斷有沒有這個欄位）', async () => {
  const res = await get(BOARD_URL);
  expect(res.body.truncated).toBe(null);
});

// 靜默截斷＝agent 拿殘缺版面當完整規格，且完全看不出來
test('節點超過上限 → 截斷但據實回報 total／returned，不裝作讀完了', async () => {
  const many = {
    id: '0:0', type: 'CANVAS', name: 'Page 1',
    children: Array.from({ length: MAX_NODES + 50 }, (_, i) => ({
      id: `9:${i}`, type: 'TEXT', name: `T${i}`, characters: `文字${i}`,
    })),
  };
  fetchSpy.mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ name: '大檔', editorType: 'figma', document: many }),
  });
  const res = await get(BOARD_URL);
  expect(res.status).toBe(200);
  expect(res.body.nodes.length).toBe(MAX_NODES);
  expect(res.body.truncated).toEqual({ total: MAX_NODES + 51, returned: MAX_NODES, limit: MAX_NODES });
});

// --- 失敗要說得出真因 ---

test('Figma 回 403（View seat 讀不到私有檔）→ 原樣帶出訊息，不要吞成泛用錯誤', async () => {
  fetchSpy.mockResolvedValue({ ok: false, status: 403, json: async () => ({ err: 'Not allowed' }) });
  const res = await get(BOARD_URL);
  expect(res.status).toBe(502);
  expect(res.body.error).toMatch(/Figma API 403/);
  expect(res.body.error).toMatch(/Not allowed/);
});

test('Figma 限流 429 → 原樣回 429，讓呼叫端知道是該退避而不是壞掉', async () => {
  fetchSpy.mockResolvedValue({ ok: false, status: 429, json: async () => ({ err: 'Rate limited' }) });
  const res = await get(BOARD_URL);
  expect(res.status).toBe(429);
});

test('連不到 Figma → 502 且帶原始訊息', async () => {
  fetchSpy.mockRejectedValue(new Error('ENOTFOUND api.figma.com'));
  const res = await get(BOARD_URL);
  expect(res.status).toBe(502);
  expect(res.body.error).toMatch(/ENOTFOUND/);
});

test('指定的 node-id 不存在 → 404，不要回一個空清單假裝成功', async () => {
  fetchSpy.mockResolvedValue({ ok: true, status: 200, json: async () => ({ name: 'X', nodes: {} }) });
  const res = await get(`${BOARD_URL}?node-id=99-99`);
  expect(res.status).toBe(404);
  expect(res.body.nodes).toBeUndefined();
});

test('extractNodes 直接吃單節點回應的 document（/nodes 與整檔兩種外形都要接得住）', async () => {
  fetchSpy.mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ name: 'X', nodes: { '1:28': { document: FIGJAM_DOC.children[0].children[0] } } }),
  });
  const res = await get(`${BOARD_URL}?node-id=1-28`);
  expect(res.status).toBe(200);
  expect(res.body.nodes).toHaveLength(1);
  expect(res.body.nodes[0].text).toBe('請輸入姓名');
});

// 實測那份 FigJam 有 51 個 SHAPE_WITH_TEXT，預設名全是 "Shape with text"——留著等於把型別寫兩次
test('圖層名只是型別的人話版時丟掉，設計師取過的名字才留', () => {
  const { nodes } = extractNodes({
    id: '0:1', type: 'CANVAS', name: 'Page 1',
    children: [
      { id: '1:2', type: 'SHAPE_WITH_TEXT', name: 'Shape with text' },
      { id: '1:3', type: 'SHAPE_WITH_TEXT', name: '查詢按鈕' },
    ],
  });
  expect(nodes.find(n => n.id === '1:2').name).toBeUndefined();
  expect(nodes.find(n => n.id === '1:3').name).toBe('查詢按鈕');
});

// Figma 實際回的是 6.400000095367432 這種值，原樣進規格就是拿浮點誤差當設計數值
test('圓角的浮點誤差要收斂（規格寫的是 px，不是二進位浮點）', () => {
  const { nodes } = extractNodes({ id: '1:1', type: 'RECTANGLE', name: 'R', cornerRadius: 6.400000095367432 });
  expect(nodes[0].radius).toBe(6.4);
});

test('extractNodes 對沒有座標／顏色的節點不硬塞欄位（省下的量就是給規格用的）', () => {
  const { nodes } = extractNodes({ id: '1:1', type: 'TEXT', name: 'TEXT', characters: '只有文字' });
  expect(nodes[0]).toEqual({ id: '1:1', type: 'TEXT', text: '只有文字' });
});
