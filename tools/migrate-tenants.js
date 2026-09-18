// 一次性遷移：把現況全部歸到一家「內部公司」名下（規格 §4.5）。
// 預設只列計畫不寫入，要加 --apply 才動 DB——比照 tools/copy-agent-sessions.js。
// 可重跑：每一步都先查現況再決定要不要寫，跑一半失敗可以直接再跑。
//
// 為什麼遷移之後現有的人看到的東西不變：
//   9 個平台管理員 company_id 留 NULL（本來就看全部）
//   6 個一般使用者掛內部公司，而內部公司綁了「全部」專案 ⇒ 還是看得到全部
// 反過來說，新客戶公司什麼都沒綁 ⇒ 預設什麼都看不到，不會因為遷移漏掉而外洩。

const INTERNAL_COMPANY_NAME = '內部';

async function planTenantMigration(query) {
  // 用 is_internal 找、不用名字找：Part 2 開放公司管理員改公司名稱之後，名字比對要嘛因為
  // 「內部」已被改名而撞唯一索引再建一家內部公司，要嘛更糟——找到別家剛好被改名叫「內部」的
  // 客戶公司，把全部專案綁給不相干的對象。is_internal 是唯一索引保證只有一筆 true 的真旗標。
  const { rows: coRows } = await query('SELECT id, is_active FROM companies WHERE is_internal = true');
  const internalCompany = coRows[0]
    ? { exists: true, id: coRows[0].id, isActive: coRows[0].is_active }
    : { exists: false, id: null, isActive: false };

  // 非平台管理員且還沒掛公司的帳號。平台管理員（role='admin'）一律不動。
  const { rows: usersToAssign } = await query(
    "SELECT id, username, role FROM users WHERE role <> 'admin' AND company_id IS NULL ORDER BY id"
  );

  // 還沒綁到內部公司的專案。pg-mem 不支援相關子查詢，用 NOT IN；
  // 子查詢必須加 IS NOT NULL——真 PG 裡 NOT IN 清單含一個 NULL，整個條件恆為 UNKNOWN，查詢會靜默全失效。
  const { rows: projectsToBind } = internalCompany.exists
    ? await query(
        `SELECT id, name FROM projects
          WHERE id NOT IN (
            SELECT project_id FROM project_companies
             WHERE company_id = $1 AND project_id IS NOT NULL
          )
          ORDER BY id`,
        [internalCompany.id]
      )
    : await query('SELECT id, name FROM projects ORDER BY id');

  return { internalCompany, usersToAssign, projectsToBind };
}

async function applyTenantMigration(query, plan) {
  let companyId = plan.internalCompany.id;
  let companyCreated = false;

  if (!plan.internalCompany.exists) {
    // 這是全平台唯一寫 is_internal=true 的地方。使用期間留 NULL＝不限。
    const { rows } = await query(
      `INSERT INTO companies (name, is_active, is_internal, active_from, active_until)
       VALUES ($1, true, true, NULL, NULL) RETURNING id`,
      [INTERNAL_COMPANY_NAME]
    );
    companyId = rows[0].id;
    companyCreated = true;
  }

  // `company_id IS NULL` 這道保險不能拿掉：它護的是「plan 查完到 apply 寫入」這段窗口——
  // 這中間若有別的路徑先幫這個帳號掛了公司，這裡不該覆蓋掉。
  // 寫成 coalesce(company_id::text, '') = '' 而不是直接 `company_id IS NULL`，是刻意繞開
  // pg-mem 的限制：同一句 UPDATE 只要把「SET 的那個欄位」直接寫進 WHERE ... IS NULL，
  // pg-mem 就會靜默影響 0 列（已用最小重現腳本排除欄位順序、外鍵值、改用子查詢等其他寫法，
  // 只有這個 coalesce 寫法在 pg-mem 下能正確比對且維持等價語意）。
  // usersUpdated 算的是「真的被寫入」的列數（rowCount），不是名單長度——plan/apply 之間
  // 如果真的有人搶先掛了公司，這裡的數字要跟 plan.usersToAssign.length 對不上，不能悄悄蓋過去。
  let usersUpdated = 0;
  for (const u of plan.usersToAssign) {
    const res = await query(
      "UPDATE users SET company_id = $1 WHERE id = $2 AND coalesce(company_id::text, '') = ''",
      [companyId, u.id]
    );
    usersUpdated += res.rowCount;
  }

  let projectsBound = 0;
  for (const p of plan.projectsToBind) {
    // can_release 走欄位預設 false：內部公司的綁定一律不勾（規格 §4.3）
    await query(
      `INSERT INTO project_companies (project_id, company_id) VALUES ($1, $2)
       ON CONFLICT (project_id, company_id) DO NOTHING`,
      [p.id, companyId]
    );
    projectsBound++;
  }

  return { companyCreated, usersUpdated, projectsBound };
}

module.exports = { planTenantMigration, applyTenantMigration, INTERNAL_COMPANY_NAME };

// CLI
if (require.main === module) {
  (async () => {
    const { query } = require('../app/server/db');
    const apply = process.argv.includes('--apply');
    const plan = await planTenantMigration(query);

    console.log(`內部公司：${plan.internalCompany.exists ? `已存在 (id=${plan.internalCompany.id})` : '要新建'}`);
    console.log(`要掛公司的帳號：${plan.usersToAssign.length} 個`);
    for (const u of plan.usersToAssign) console.log(`  ${u.username} (${u.role})`);
    console.log(`要綁內部公司的專案：${plan.projectsToBind.length} 個`);
    for (const p of plan.projectsToBind) console.log(`  ${p.name}`);

    if (!apply) {
      console.log('（未加 --apply，沒有寫入任何東西）');
      process.exit(0);
    }

    const res = await applyTenantMigration(query, plan);
    console.log('結果：', res);

    // 自我驗收：漏綁任何一個專案，內部人員就會看不到它（規格 §4.5）
    const { rows: [chk] } = await query(
      `SELECT (SELECT COUNT(*)::int FROM projects) AS projects,
              (SELECT COUNT(*)::int FROM project_companies pc
                 JOIN companies c ON c.id = pc.company_id AND c.is_internal = true) AS bound`
    );
    console.log(`驗收：專案 ${chk.projects} 個、內部公司綁定 ${chk.bound} 筆`);
    if (chk.projects !== chk.bound) {
      console.error('❌ 數量對不上，內部人員會看不到某些專案——請查明原因再重跑');
      process.exit(1);
    }
    console.log('✅ 數量一致');
    process.exit(0);
  })().catch(err => { console.error(err); process.exit(1); });
}
