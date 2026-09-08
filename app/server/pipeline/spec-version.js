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
  const { rows } = await query(
    'SELECT version, analysis_yaml FROM task_specs WHERE task_id=$1 ORDER BY version DESC LIMIT 1',
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

module.exports = { recordSpecVersion, recordSpecVersionSafe };
