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

test('崩潰後自動重啟：下一次呼叫會起一個新的 worker', async () => {
  const first = emb.embedQuery('甲');
  await flush();
  Worker.instances[0].emit('exit', 1);
  await expect(first).rejects.toThrow();

  const second = emb.embedQuery('乙');
  await flush();
  expect(Worker.instances).toHaveLength(2);
  expect(Worker.instances[1].sent[0].texts).toEqual(['query: 乙']);
  second.catch(() => {});                            // 這一筆不會有人回應它，測完即棄
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
  const w = Worker.instances[1];
  const vec = new Float32Array([1, 0, 0]);
  w.emit('message', { id: w.sent[0].id, ok: true, n: 1, dim: 3, flat: vec });
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
