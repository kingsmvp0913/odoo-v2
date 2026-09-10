// 部署結果的人話文案，一個目標一行。
//
// 單獨一支的理由：同一份文字要同時進 socket（即時看）與 task_logs（任務對話，事後查），
// 而 task_logs 才是使用者看得到的唯一真相——socket 訊息重整就沒了。兩邊各寫一份文案
// 會慢慢長歪，使用者會以為是兩件不同的事。放 deploy-run.js 不行：那支在測試裡整包被 mock。
//
// envLabel 一律帶「客戶」二字（客戶測試區／客戶正式區）：平台自己也有一關叫「部署測試區」，
// 講的是平台的 docker 測試環境，同名會讓人分不出動到的是誰的機器。
function describeResults(results, targets, envLabel) {
  const byId = new Map((targets || []).map(t => [t.id, t]));
  return (results || []).map((r) => {
    const t = byId.get(r.targetId);
    const who = t ? t.db_name : r.targetId;
    const mods = (r.modules || []).join(', ') || '無模組變更';
    return r.ok
      ? `${envLabel}部署完成（${who}）：${mods}`
      : `${envLabel}部署失敗（${who}／${mods}）：${r.error || '未知原因'}`;
  });
}

module.exports = { describeResults };
