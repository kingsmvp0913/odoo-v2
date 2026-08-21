// 意圖：企業版專案的 agent 要**查得到**企業版 addons 原始碼。
//
// 為什麼值得一支測試：這條路的壞法是靜默的。企業版與社群版的差別只在多一包 addons，那包一直
// 都在本機（測試區啟動時唯讀掛入的就是它），但在守則裡寫出路徑之前，agent 完全不知道它在哪——
// 而 prompt 同時**禁止掃碟**，所以它只能靠 Context7 猜。核心碼踩過同一個坑：真相檔不在手上時，
// 分析關會編出不存在的寫法、QA 拿別的檔判它錯，兩關各自「有原始碼佐證」卻結論相反，把任務卡到
// 彈跳上限（ad127e02）。整條鏈沒有任何一段會報錯，所以要靠測試釘住。
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

let dbModule, getProjectInfo;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
  ({ getProjectInfo } = require('../pipeline/task-agent'));
});

// 建一個 repo 已 clone 完成的專案；edition 決定要不要解企業版目錄
async function makeProject(name, edition, version = '17.0') {
  const { rows: [p] } = await dbModule.query(
    'INSERT INTO projects (name, odoo_version, edition) VALUES ($1,$2,$3) RETURNING id',
    [name, version, edition]
  );
  await dbModule.query(
    "INSERT INTO project_repos (project_id, label, repo_url, local_path, clone_status, is_primary) VALUES ($1,'main','u','/repos/x/main','done',true)",
    [p.id]
  );
  return p.id;
}

test('企業版專案 → getProjectInfo 帶出企業版 addons 目錄', async () => {
  // local_path 指向一個真的存在的目錄：resolveEnterprisePath 會 existsSync 把關，
  // 指向不存在的路徑會被判成「來源不可用」——那是另一條分支（見下一支測試）。
  const realDir = path.resolve(__dirname);
  await dbModule.query(
    "INSERT INTO enterprise_sources (odoo_version, repo_url, local_path, clone_status, source_type) VALUES ('17','u',$1,'done','local')",
    [realDir]
  );
  const id = await makeProject('EntProj', 'enterprise');
  const info = await getProjectInfo(id);
  expect(info.edition).toBe('enterprise');
  expect(info.enterprise_src).toBe(realDir);
});

test('社群版專案 → 不帶企業版目錄（不該讓社群版 prompt 多出一段假路徑）', async () => {
  const id = await makeProject('CommProj', 'community');
  const info = await getProjectInfo(id);
  expect(info.enterprise_src).toBeNull();
});

test('企業版但來源還沒設定 → 當作沒有，組 prompt 不得失敗', async () => {
  // 這裡刻意用一個沒有 enterprise_sources 列的版本。fail loud 的責任在建測試區那條路徑
  // （env-agent 的 enterpriseError），不在組 prompt——prompt 掛掉會讓整關報廢。
  const id = await makeProject('EntNoSrc', 'enterprise', '18.0');
  const info = await getProjectInfo(id);
  expect(info.enterprise_src).toBeNull();
});

// 守的是「能力做好了卻沒接上任何一關」這個模式：coreSourceGuidance 支援第二個參數之後，
// 呼叫端只要漏傳，企業版專案就靜默拿不到路徑——測試全綠、畫面正常、零訊號。
// 不列死檔案清單：往後新增的 pipeline 檔一樣要被掃到。
test('所有呼叫端都把企業版目錄傳進 coreSourceGuidance', () => {
  const dir = path.join(__dirname, '..', 'pipeline');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/coreSourceGuidance\(([^)]*)\)/g)) {
      if (m[1].split(',').length < 2) bad.push(`${f}: coreSourceGuidance(${m[1]})`);
    }
  }
  expect(bad).toEqual([]);
});
