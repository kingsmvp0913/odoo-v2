const { query } = require('../db');

// 取專案的人工維護備註（wiki 保留節點 project-notes）。trim 後非空回內容、否則 null。
// 供 pipeline 各關卡判斷「要不要注入備註」——空備註不得注入，以免污染 prompt／破壞 cache 前綴。
// 獨立小模組：task-agent 與 chat-agent 都要用，抽出避免循環相依。
async function getProjectNotes(projectId) {
  const { rows } = await query(
    "SELECT content FROM wiki_pages WHERE project_id = $1 AND slug = 'project-notes'",
    [projectId]
  );
  const content = rows[0] && rows[0].content;
  if (!content || !content.trim()) return null;
  return content.trim();
}

module.exports = { getProjectNotes };
