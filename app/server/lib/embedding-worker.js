// embedding worker：模型推論一律在這個 worker_thread 裡跑，主行程只收送訊息。
//
// 為什麼非得隔離：Node 是單執行緒，平台有二十幾人同時在用。每一次搜尋都要現算一次查詢向量
// （實測 20–50 ms），在主行程算等於每次搜尋都讓整個 server 停一下——socket.io 事件、pipeline
// 排程全部跟著卡。建索引更不用說。這是本 repo 第一處用 worker_threads，沒有既有範例可抄。
//
// 協定：主行程送 { id, texts }，這裡回 { id, ok, dim, flat } 或 { id, ok:false, error }。
// flat 是把 n×dim 攤平的 Float32Array，用 transfer list 搬過去（不複製）。

const { parentPort, workerData } = require('worker_threads');
const { pipeline, env } = require('@huggingface/transformers');

// 權重落點由主行程算好傳進來（不得寫死絕對路徑）。allowLocalModels 讓離線環境可以事先把
// 權重放進該目錄，啟動時偵測到就不下載。
env.cacheDir = workerData.modelsDir;
env.allowLocalModels = true;

let extractor = null;
async function ensureModel() {
  if (!extractor) extractor = await pipeline('feature-extraction', workerData.modelId);
  return extractor;
}

parentPort.on('message', async (msg) => {
  try {
    const extract = await ensureModel();
    // pooling:'mean' + normalize:true 是 e5 系列的標準用法；normalize 之後 cosine 就等於內積，
    // 主行程那側才能用一行 dot 算相似度。
    const out = await extract(msg.texts, { pooling: 'mean', normalize: true });
    const [n, dim] = out.dims;
    const flat = new Float32Array(out.data);
    parentPort.postMessage({ id: msg.id, ok: true, n, dim, flat }, [flat.buffer]);
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: err.message });
  }
});
