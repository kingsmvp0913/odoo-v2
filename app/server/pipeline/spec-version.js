const { query } = require('../db');
const { SPEC_GATE_PREFIX } = require('./analysis');

// 規格版本快照＋時間軸上的那一筆。第 1 版不另外落 log：分析關本來就會寫
// 「[等待你審核規格]」／「分析完成，直接開工」那一則，再補一筆等於同一件事講兩遍。
// 第 2 版起才寫，因為那正是使用者看不到的那一段（「他會修前面的規格書然後不顯示新的規格書」）。
//
// 獨立成一支模組（原本長在 runner.js 裡）是為了讓改寫 analysis_yaml 的每一處都叫得到它：
// runner 已經 require 了 clarify-chat，反向 require 會是循環，spec-review／respec-agent 同理。
// 這支只依賴 db 與 analysis（兩者都是葉子），誰都能安全 require。
async function recordSpecVersion(taskId, dumped, previousYaml) {
  // 限 kind='main'：同一張任務底下另有小修正規格（kind='tweak'）在跑自己的序列，不濾的話
  // 一次小修正就會把主規格的下一版從第 2 版推成第 3 版，時間軸上跳號且對不回任何一份規格。
  const { rows } = await query(
    "SELECT version, analysis_yaml FROM task_specs WHERE task_id=$1 AND kind='main' ORDER BY version DESC LIMIT 1",
    [taskId]
  );
  let last = rows[0] || null;
  // 一筆版本都沒有、但任務已經有規格 ⇒ 補記舊的那份為第 1 版，這次才算得上第 2 版。
  // created_at 會是現在而不是當初，但沒有地方顯示它：畫面上的時間來自它掛的那則 log。
  if (!last && previousYaml && previousYaml !== dumped) {
    await query('INSERT INTO task_specs (task_id, version, analysis_yaml) VALUES ($1, 1, $2)', [taskId, previousYaml]);
    last = { version: 1, analysis_yaml: previousYaml };
  }
  // 一字未動＝不算新版：respec 判「規格不需要調整」也會走到這裡（見 respec-agent），
  // 每次都記一版會在時間軸上生出一串看不出差別的版本。
  if (last && last.analysis_yaml === dumped) return;
  const version = (last?.version || 0) + 1;
  await query(
    'INSERT INTO task_specs (task_id, version, analysis_yaml) VALUES ($1, $2, $3)',
    [taskId, version, dumped]
  );
  if (version === 1) return;
  // 前綴與分析關那一則相同：前端靠這個前綴決定「這一則底下要掛規格書」（isSpecLog），
  // 版號寫在標頭列的全形括號裡，也是前端決定要掛第幾版的依據。
  await query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
    [taskId, `${SPEC_GATE_PREFIX}（第 ${version} 版）\n規格已依你的意見更新。前一版收在上面那一則裡。`]
  );
}

// 快照失敗不該讓規格寫不進去（規格落地是主線，版本歷程只是可見性）——四個寫入點共用同一個吞法。
function recordSpecVersionSafe(taskId, dumped, previousYaml) {
  return recordSpecVersion(taskId, dumped, previousYaml).catch(err => {
    console.error(`[SPEC-VERSION] task ${taskId} spec version snapshot failed:`, err.message);
  });
}

// ── 小修正規格（kind='tweak'）────────────────────────────────
// 人工審核退回時，分診員除了判去向，還會寫下「這次退回要求的正確行為」。它以**追加**的方式存成
// 一份小規格，主規格（tasks.analysis_yaml）一個字不動。
//
// 為什麼不直接改主規格：退回意見多半只碰整份規格的一個角落，而重產整份的代價是使用者實測抱怨過的
// 「我只改一個小地方卻要整個重看過規格」，且每次重產都讓 QA 的規格指紋變動、續接對話作廢，
// 一次小修正要付一次全量重讀（實測 8~10 分鐘、$3，對照續接的 19 秒、$0.27）。
//
// 為什麼存純文字而不是 YAML：它是條列式的補充，沒有下游要 parse 的欄位。強迫 agent 產 YAML 只是
// 多一個靜默失敗點——實測過兩次同一個病（使用者貼的錯誤訊息含冒號炸掉整份規格、
// 回覆與 YAML 綁死一行縮排差兩格就整輪報廢）。
const TWEAK_SPEC_PREFIX = '[小修正規格]';

// 寫一份小修正規格：自己的版本序列 + 時間軸上掛得起規格書的那一則。
// 回傳版號；text 為空則什麼都不做（分診的 spec_patch 是選填欄位）。
async function recordTweakSpec(taskId, text) {
  const body = String(text || '').trim();
  if (!body) return null;
  const { rows } = await query(
    "SELECT MAX(version) AS v FROM task_specs WHERE task_id=$1 AND kind='tweak'",
    [taskId]
  );
  const version = (rows[0]?.v || 0) + 1;
  await query(
    "INSERT INTO task_specs (task_id, version, analysis_yaml, kind) VALUES ($1, $2, $3, 'tweak')",
    [taskId, version, body]
  );
  // 前綴＋全形括號版號，與主規格那則（SPEC_GATE_PREFIX）同一套格式：前端靠它決定
  // 「這一則底下要掛哪一份規格書」。格式一動，畫面上規格書就掛不上去且完全不報錯。
  await query(
    "INSERT INTO task_logs (task_id, role, content) VALUES ($1, 'ai', $2)",
    [taskId, `${TWEAK_SPEC_PREFIX}（第 ${version} 版）\n${body}`]
  );
  return version;
}

// 讀回這張任務目前全部的小修正規格，組成給 agent 讀的一段文字。
// **每輪都給全部、不只給最新那一份**：開發關是無狀態的（每輪 fresh 重送規格），只給最新的話，
// 第二次小修正會讓第一次的要求從 prompt 裡消失，開發關把它改回去而沒有任何人會發現。
async function loadTweakSpecs(taskId) {
  const { rows } = await query(
    "SELECT version, analysis_yaml FROM task_specs WHERE task_id=$1 AND kind='tweak' ORDER BY version",
    [taskId]
  );
  if (!rows.length) return '';
  return rows.map(r => `── 小修正規格 第 ${r.version} 版 ──\n${r.analysis_yaml}`).join('\n\n');
}

module.exports = { recordSpecVersion, recordSpecVersionSafe, recordTweakSpec, loadTweakSpecs, TWEAK_SPEC_PREFIX };
