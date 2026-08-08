// embedding 門面：主行程這一側唯一會碰 worker 的地方。
//
// 職責刻意只有「把文字變成向量」＋「向量的編解碼與比較」，不碰 DB——這樣它能在測試裡完全
// 用 stub 取代（測試不得載入真實模型：每跑一次就載 130 MB 還引入網路相依）。索引與快取那些
// 要讀寫 DB 的事在 embedding-index.js。規格 §2.7 原本把快取也畫在本檔，拆開是為了可測性。

const path = require('path');
const { Worker } = require('worker_threads');

const MODEL_ID = 'Xenova/multilingual-e5-small';
const DIM = 384;
// 連續失敗這麼多次就停用向量腿：模型下載不到、記憶體不足這類問題重啟一百次也一樣，
// 與其無限重啟拖垮 server，不如降級成純 LIKE 並讓管理頁看得見。
const MAX_CONSECUTIVE_FAILURES = 3;

// 權重落點。執行期讀 env、不在載入時 snapshot（比照 lib/vpn-gateway.js 的 vpnTmpDir）。
// 一律相對推導，不得寫死絕對路徑。
function modelsDir() {
  if (process.env.EMBEDDING_MODELS_DIR) return process.env.EMBEDDING_MODELS_DIR;
  if (process.env.APP_DIR) return path.join(process.env.APP_DIR, 'data', 'models');
  return path.join(__dirname, '..', '..', '..', 'data', 'models');
}

let worker = null;
let ready = false;          // 模型載完、預熱過，可以接查詢了
let disabled = false;       // 連續失敗達上限，向量腿停用
let lastError = null;
let failures = 0;
let seq = 0;
let current = null;         // 送出去還沒回來的那一筆
const queue = [];
let stub = null;            // 測試用的假 embedder

function spawnWorker() {
  const w = new Worker(path.join(__dirname, 'embedding-worker.js'), {
    workerData: { modelId: MODEL_ID, modelsDir: modelsDir() },
  });
  worker = w;
  w.on('message', onMessage);
  // error 與 exit 都可能發生（拋例外 vs 直接死掉），兩邊都要收，否則佇列會永遠停在那裡。
  // 但同一次崩潰兩個事件都會發（Node 上 worker 拋未捕捉例外必定是 error 後接 exit:1），只能算一次：
  // 算兩次會讓停用門檻實際變成 2 次；而且第一個事件已經起了替補 worker，第二個事件會把替補
  // 誤判成失敗砍掉，留下一條沒人收訊息的孤兒 thread。
  let down = false;
  const fail = (reason) => { if (down) return; down = true; teardown(reason); };
  w.on('error', (err) => fail(err.message));
  w.on('exit', (code) => { if (code !== 0) fail(`worker 結束，exit code ${code}`); });
  return w;
}

// worker 死掉時：手上與排隊中的工作一律標記失敗，不無聲吞掉——呼叫端才知道要退回純 LIKE。
// 標記完就地重新預熱：ready 只有 start() 設得成 true，而 start() 全 server 只在啟動時呼叫一次，
// 不自己復原的話，一次推論例外就等於把向量腿靜默關到下次重啟 server（isReady() 從此恆為 false，
// 而 failures 只有 1、離停用門檻還很遠，管理頁看起來也不像壞掉）。
// 不會變成無限重啟：failures 只在成功時歸零，連續失敗達 MAX_CONSECUTIVE_FAILURES 就停用。
function teardown(reason) {
  lastError = reason;
  ready = false;
  worker = null;
  failures += 1;
  if (failures >= MAX_CONSECUTIVE_FAILURES) disabled = true;
  const err = new Error(`embedding worker 失效：${reason}`);
  if (current) { current.reject(err); current = null; }
  while (queue.length) queue.shift().reject(err);
  if (!disabled) start();   // 背景重載模型（實測約 11 秒），期間 isReady() 為 false，查詢照常退回純 LIKE
}

function onMessage(msg) {
  if (!current || msg.id !== current.id) return;
  const job = current;
  current = null;
  if (msg.ok) {
    failures = 0;
    const vectors = [];
    for (let i = 0; i < msg.n; i++) vectors.push(msg.flat.slice(i * msg.dim, (i + 1) * msg.dim));
    job.resolve(vectors);
  } else {
    job.reject(new Error(msg.error));
  }
  pump();
}

// 序列送出：一次只讓一批在 worker 裡跑。同時丟多批不會比較快（單一 worker），只會讓記憶體
// 尖峰疊起來，而且查詢會被大批建索引擠到後面。
function pump() {
  if (current || !queue.length) return;
  if (disabled) { while (queue.length) queue.shift().reject(new Error('embedding 已停用')); return; }
  if (!worker) spawnWorker();
  current = queue.shift();
  worker.postMessage({ id: current.id, texts: current.texts });
}

function embed(texts) {
  if (stub) return Promise.resolve(stub(texts));
  if (disabled) return Promise.reject(new Error('embedding 已停用'));
  if (!texts.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    queue.push({ id: ++seq, texts, resolve, reject });
    pump();
  });
}

// e5 系列必須加前綴，兩邊用錯或漏掉，檢索品質會下降但一切「看起來正常」——不會有任何錯誤。
// 所以不開放呼叫端自己傳前綴，只給這兩個入口，把用錯的可能性從 API 上消掉。
const embedPassages = (texts) => embed(texts.map(t => `passage: ${t}`));
const embedQuery = (text) => embed([`query: ${text}`]).then(v => v[0]);

// 背景啟動並預熱。不阻塞 server 啟動：模型載入實測約 11 秒，期間查詢一律退回純 LIKE。
async function start() {
  if (ready || disabled) return ready;
  try {
    await embed(['warmup']);
    ready = true;
    lastError = null;
  } catch (err) {
    ready = false;
    lastError = err.message;
  }
  return ready;
}

const isReady = () => ready && !disabled;
const getStatus = () => ({ model: MODEL_ID, dim: DIM, ready, disabled, lastError, queued: queue.length + (current ? 1 : 0) });

// 向量存 base64 TEXT 而非 BYTEA：BYTEA 的 Buffer 往返在 pg-mem 下不保證行為一致，
// 而代價只是 33% 空間（見 db.js 的 embedding_chunks 註解）。
const encodeVector = (vec) => Buffer.from(new Float32Array(vec).buffer).toString('base64');
function decodeVector(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// worker 已經做過 normalize，所以 cosine 就是內積。這裡不重做正規化：每次查詢要跟數百個
// 向量比，省下的是平方根與除法；真的收到沒正規化的向量是上游的 bug，該炸而不是默默算錯。
function similarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// 測試注入用（比照 db.js 的 _setPoolForTesting）。傳 null 還原。
function _setEmbedderForTesting(fn) {
  stub = fn;
  if (fn) { ready = true; disabled = false; failures = 0; lastError = null; }
  else { ready = false; }
}
function _resetForTesting() {
  stub = null; ready = false; disabled = false; failures = 0; lastError = null;
  current = null; queue.length = 0;
  if (worker) { worker.removeAllListeners(); worker.terminate(); worker = null; }
}

module.exports = {
  MODEL_ID, DIM,
  start, isReady, getStatus,
  embedPassages, embedQuery,
  encodeVector, decodeVector, similarity,
  _setEmbedderForTesting, _resetForTesting,
};
