// agent 端點傳來的「專案」參數解析。抽出來是因為它有一條非直覺的規則，兩處各寫一份必定走樣：
//
// 專案參數可以是 folder_name 或 name，但「用 OR 直接 join」會出事：A 的 folder_name 撞到 B 的
// name 時（中文專案名＋英文資料夾名的慣例下很容易），一次查詢會同時撈到兩個專案的資料。先解成
// 唯一的 project_id 再查，各端點一律 project_id=$1，就不會混到別人的內容——這同時是資料邊界。
// 撞號時取 folder_name 命中的那個（比 name 精確，且它才是慣例上拿來當 slug 的欄位）。
const { query } = require('../db');

async function resolveProjectId(project) {
  const { rows } = await query(
    `SELECT id FROM projects WHERE folder_name=$1 OR name=$1
      ORDER BY (folder_name=$1) DESC, id ASC LIMIT 1`, [project]);
  return rows.length ? rows[0].id : null;
}

module.exports = { resolveProjectId };
