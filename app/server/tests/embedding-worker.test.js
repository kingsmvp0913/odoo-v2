// worker_threads 是本 repo 第一處使用（背景工作歷來都是 node-cron ＋ child_process），
// 沒有既有範例可抄，也就沒有既有測試涵蓋它死掉時會怎樣。這支補的就是那條路徑：
// 模型下載不到、記憶體不足、推論拋例外——共同症狀都是 worker 沒了，而此時最糟的行為是
// 呼叫端的 Promise 永遠不 settle：搜尋會整個掛住，而不是退回純 LIKE。
jest.mock('worker_threads', () => {
  const { EventEmitter } = require('events');
  class FakeWorker extends EventEmitter {
    constructor() { super(); this.sent = []; FakeWorker.instances.push(this); }
    postMessage(msg) { this.sent.push(msg); }
    terminate() { this.terminated = true; }
  }
  FakeWorker.instances = [];
  return { Worker: FakeWorker };
});

const { Worker } = require('worker_threads');
const emb = require('../lib/embedding');

beforeEach(() => { emb._resetForTesting(); Worker.instances.length = 0; });
afterAll(() => emb._resetForTesting());

const flush = () => new Promise(r => setImmediate(r));

test('worker 崩潰時，手上與排隊中的工作全部標記失敗（不無聲吞掉）', async () => {
  const inFlight = emb.embedQuery('第一筆');
  const queued = emb.embedPassages(['第二筆']);
  await flush();
  const w = Worker.instances[0];
  expect(w.sent).toHaveLength(1);                    // 序列送出：一次只讓一批進 worker

  w.emit('error', new Error('模型載入失敗'));

  await expect(inFlight).rejects.toThrow(/模型載入失敗/);
  await expect(queued).rejects.toThrow(/模型載入失敗/);  // 排隊中的也要收到，否則搜尋永遠掛住
});

// 每一批回一個固定向量。自我復原之後 worker 手上會多一批 warmup，逐批回覆才不會把 warmup 的
// 回應算到後面那批頭上（回覆會觸發下一批送出，故迴圈條件每輪重新取 length）。
const respondAll = (w) => {
  for (let i = 0; i < w.sent.length; i++) {
    w.emit('message', { id: w.sent[i].id, ok: true, n: 1, dim: 3, flat: new Float32Array([1, 0, 0]) });
  }
};

// 崩潰後必須自己站起來。isReady() 是搜尋端唯一的閘門（wiki-routes 的 semanticLeg 先問它才呼叫
// embedQuery），所以「還能算向量」不算復原——ready 回不到 true，向量腿就是關著的。
// 這條刻意不直接呼叫 embedQuery：那樣會繞過閘門，壞掉的實作也照樣綠。
test('崩潰後自我復原：重新起 worker 並讓 isReady 回到 true', async () => {
  const warm = emb.start();
  await flush();
  respondAll(Worker.instances[0]);
  await expect(warm).resolves.toBe(true);
  expect(emb.isReady()).toBe(true);

  const inFlight = emb.embedQuery('甲');
  await flush();
  Worker.instances[0].emit('exit', 1);
  await expect(inFlight).rejects.toThrow();
  expect(emb.isReady()).toBe(false);                 // 崩潰當下確實該關掉，但不能關到重啟 server 為止

  await flush();
  expect(Worker.instances).toHaveLength(2);          // 不等下一次呼叫，當場重新預熱
  respondAll(Worker.instances[1]);
  await flush();
  expect(emb.isReady()).toBe(true);                  // 模型載回來了，向量腿要跟著回來
});

// Node 上 worker 拋未捕捉例外會先發 'error'、緊接著再發 'exit:1'，是同一次崩潰的兩個事件。
// 算兩次的後果有二：3 次的停用門檻實際變成 2 次；以及第一個事件已經起了替補 worker，
// 第二個事件會把替補當成失敗砍掉——佇列被清空、替補 thread 沒人收訊息，變成孤兒。
test('同一次崩潰只計一次失敗（error 與 exit 都會發）', async () => {
  for (let i = 0; i < 2; i++) {
    const p = emb.embedQuery(`第 ${i} 次`);
    await flush();
    const w = Worker.instances[Worker.instances.length - 1];
    w.emit('error', new Error('boom'));
    w.emit('exit', 1);
    await expect(p).rejects.toThrow();
    await flush();
  }
  expect(emb.getStatus().disabled).toBe(false);      // 只崩了兩次，門檻是 3
  expect(Worker.instances).toHaveLength(3);          // 兩次崩潰各補一個，不是四個

  // 替補沒被前一個 worker 的 exit 帶走：工作交得出去也收得回來（被誤判失效的話這筆會被拒絕）
  const after = emb.embedQuery('復原後');
  await flush();
  respondAll(Worker.instances[2]);                   // 先回覆自我復原的 warmup，佇列才會往下送
  expect(Array.from(await after)).toEqual([1, 0, 0]);
  expect(Worker.instances).toHaveLength(3);
});

// 模型下載不到、記憶體不足這類問題重啟一百次也一樣。與其無限重啟拖垮 server，不如降級：
// 停用向量腿、讓查詢一律走 LIKE，並在管理頁把 lastError 顯示出來。
test('連續失敗達上限 → 停用向量腿，之後直接拒絕而不再起 worker', async () => {
  for (let i = 0; i < 3; i++) {
    const p = emb.embedQuery(`第 ${i} 次`);
    await flush();
    Worker.instances[Worker.instances.length - 1].emit('error', new Error('boom'));
    await expect(p).rejects.toThrow();
  }
  expect(emb.getStatus().disabled).toBe(true);
  expect(emb.isReady()).toBe(false);

  const spawnedBefore = Worker.instances.length;
  await expect(emb.embedQuery('停用後')).rejects.toThrow(/停用/);
  expect(Worker.instances).toHaveLength(spawnedBefore);   // 不再浪費資源起新的
});

// 偶發失敗（一次推論拋例外）不該累積成永久停用——否則跑久了一定會關掉。
test('中間成功過就重置失敗計數', async () => {
  const bad = emb.embedQuery('壞的');
  await flush();
  Worker.instances[0].emit('error', new Error('boom'));
  await expect(bad).rejects.toThrow();

  const good = emb.embedQuery('好的');
  await flush();
  respondAll(Worker.instances[1]);                   // 這個 worker 手上還有自我復原的 warmup，逐批回覆
  expect(Array.from(await good)).toEqual([1, 0, 0]);

  // 再失敗兩次仍不該停用（計數已歸零，上限是 3）
  for (let i = 0; i < 2; i++) {
    const p = emb.embedQuery(`再 ${i}`);
    await flush();
    Worker.instances[Worker.instances.length - 1].emit('error', new Error('boom'));
    await expect(p).rejects.toThrow();
  }
  expect(emb.getStatus().disabled).toBe(false);
});

// start() 是 server 啟動後的背景預熱。它失敗了也只能是「還沒好」，絕不能讓啟動流程炸掉——
// 模型要載 11 秒，期間所有查詢都得照常退回純 LIKE。
test('預熱失敗不拋例外，只是維持未就緒', async () => {
  const p = emb.start();
  await flush();
  Worker.instances[0].emit('error', new Error('HF 不可達'));
  await expect(p).resolves.toBe(false);
  expect(emb.isReady()).toBe(false);
  expect(emb.getStatus().lastError).toMatch(/HF 不可達/);
});

test('預熱成功後 isReady 為真、狀態可供管理頁顯示', async () => {
  const p = emb.start();
  await flush();
  const w = Worker.instances[0];
  w.emit('message', { id: w.sent[0].id, ok: true, n: 1, dim: 3, flat: new Float32Array([1, 0, 0]) });
  await expect(p).resolves.toBe(true);
  const st = emb.getStatus();
  expect(st.ready).toBe(true);
  expect(st.model).toBe('Xenova/multilingual-e5-small');
  expect(st.dim).toBe(384);
});
