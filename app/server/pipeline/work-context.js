const fs = require('fs');

// 對話／改規格三關（clarify-chat／spec-review／respec-patch）共用：把分析關已經建好的任務 worktree
// 交給它們當工作目錄，讓「使用者說的名詞對到哪個 Field」這種問題自己查得到，不必再問使用者一輪。
//
// 取不到就回 null（呼叫端不傳 cwd／不注入查碼守則，退回原本的純對話行為）。三種取不到的情形：
// 專案沒有 clone 完成的 repo、任務還沒跑到分析（worktree 尚未建立）、worktree 已被清掉。
// **必須檢查目錄真的存在**：cwd 指向不存在的目錄會讓 spawn 直接 ENOENT，整關報錯而不是少查一點東西。
//
// task-agent 走 lazy require：它頂層 require 了 clarify-chat（取 loadConversation），
// 在這裡頂層 require 會形成循環相依。
async function taskWorkContext(task) {
  if (!task || !task.project_id || !task.task_id) return null;
  try {
    const { getProjectInfo, worktreeParent, buildRepoPaths } = require('./task-agent');
    const info = await getProjectInfo(task.project_id);
    if (!info) return null;
    const cwd = worktreeParent(info.root, task.task_id);
    if (!fs.existsSync(cwd)) return null;
    require('./worktree-skills').ensureWorktreeSkills(cwd);   // 與開發各關同一份參考知識
    return { cwd, repoPaths: buildRepoPaths(info, task.task_id) };
  } catch { return null; }
}

module.exports = { taskWorkContext };
