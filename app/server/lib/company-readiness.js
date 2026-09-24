/**
 * company-readiness.js — 一家客戶公司「開通做到第幾步」（子專案 4 §4.1）
 *
 * 開一家客戶要照順序做 8 件事，每一件的功能都早就有了，但散在五六個不同的畫面，
 * 沒有任何東西告訴你「這家還差什麼」——只能靠人記。漏掉的代價不是報錯，是**卡在
 * 很後面才發現**：例如漏了 GIT 憑證，客戶按下第一張任務、跑到最後要 commit 時才失敗，
 * 而錯誤訊息指向 git，不指向「你忘了設定」。
 *
 * **不加任何欄位**：8 項全部從現有的表算得出來。開通進度是既有資料的一個視角，
 * 不是一份要另外維護的狀態——另存一份就會有「表上說做完了、實際上沒有」的第三種真相。
 *
 * ⚠ 一次只查一家公司，刻意用多支簡單查詢而不是一句聰明的聚合：
 * pg-mem 不支援相關子查詢、對 COUNT(DISTINCT) 也有 bug（見 company-admin-routes.js 檔頭），
 * 而這支的測試跑在 pg-mem 上。
 */

// 每一步的說明與「還差什麼」的提示。label 是給人看的，hint 要講得出下一步去哪裡做。
const STEPS = [
  { key: 'company', label: '公司已建立並啟用', hint: '在「基本資料」分頁把「啟用」打開' },
  { key: 'admin', label: '已建立公司管理員帳號', hint: '到「管理員設定 → 使用者管理」新增一個角色為公司管理員的帳號' },
  { key: 'project', label: '已綁定至少一個專案', hint: '在「綁定的專案」分頁綁一個專案給這家公司，並決定要不要勾「可上正式」' },
  { key: 'git', label: '已設定公司 GIT 憑證', hint: '在「GIT 憑證」分頁填入 PAT' },
  { key: 'infra', label: 'repo、資料庫連線、正式機部署目標都有了', hint: '到該專案的設定頁補齊' },
  { key: 'testenv', label: '已建立測試區', hint: '到該專案的環境頁建立測試區' },
  { key: 'apikey', label: '客戶的 Claude 認證憑證已設定', hint: '在「客戶 Claude 憑證」分頁代填，或請客戶管理員自己到「公司帳號」頁填' },
  { key: 'firsttask', label: '已用一張任務走通整條流程', hint: '用一張小任務跑完開發到上正式，確認通了再交給客戶' },
];

const one = async (query, sql, params) => ((await query(sql, params)).rows[0] || null);

/**
 * 回 `{ applicable, done, total, steps }`。
 * `applicable: false` 代表這家公司不適用開通流程（內部公司），此時 steps 是空的——
 * 讓「不適用」是資料本身講的，而不是靠每個呼叫端各自記得要隱藏。
 */
async function companyReadiness(companyId, deps = {}) {
  const query = deps.query || require('../db').query;

  const co = await one(query,
    `SELECT id, is_active, is_internal, git_pat_enc, anthropic_key_enc FROM companies WHERE id = $1`,
    [companyId]);
  if (!co) return null;
  if (co.is_internal === true) return { applicable: false, done: 0, total: 0, steps: [] };

  const admin = await one(query,
    `SELECT 1 AS ok FROM users WHERE company_id = $1 AND role = 'company_admin' LIMIT 1`, [companyId]);
  const proj = await one(query,
    `SELECT 1 AS ok FROM project_companies WHERE company_id = $1 LIMIT 1`, [companyId]);

  // 綁定的專案當成一組看：客戶通常只有一個專案，而「哪一個專案缺 repo」這種細節
  // 在這張表上講不清楚也沒用——它要回答的是「還能不能交給客戶」。
  const inProjects = 'project_id IN (SELECT project_id FROM project_companies WHERE company_id = $1)';
  const repo = await one(query, `SELECT 1 AS ok FROM project_repos WHERE ${inProjects} LIMIT 1`, [companyId]);
  const dbconn = await one(query, `SELECT 1 AS ok FROM db_connections WHERE ${inProjects} LIMIT 1`, [companyId]);
  const deploy = await one(query,
    `SELECT 1 AS ok FROM project_deploy_targets WHERE ${inProjects} AND env = 'prod' LIMIT 1`, [companyId]);
  const env = await one(query, `SELECT 1 AS ok FROM odoo_envs WHERE ${inProjects} LIMIT 1`, [companyId]);

  // 「跑通一張任務」＝這家公司的人建的任務有走到完成。用 user_id 反查而不是看專案：
  // 專案可能同時綁多家公司，別家在同一個共用專案下跑完的任務不算這家開通完成。
  const task = await one(query,
    `SELECT 1 AS ok FROM tasks WHERE status = 'done'
       AND user_id IN (SELECT id FROM users WHERE company_id = $1) LIMIT 1`, [companyId]);

  const missing = [
    !repo && 'repo', !dbconn && '資料庫連線', !deploy && '正式機部署目標',
  ].filter(Boolean);

  const state = {
    company: co.is_active === true,
    admin: !!admin,
    project: !!proj,
    // 用 PAT 而不是 git_login：只填了登入帳號、沒有 PAT 是不能用的憑證，
    // 標成「已設定」等於把問題留到客戶第一次 commit 時才爆。
    git: co.git_pat_enc !== null && co.git_pat_enc !== undefined,
    infra: !!repo && !!dbconn && !!deploy,
    testenv: !!env,
    apikey: !!co.anthropic_key_enc,
    firsttask: !!task,
  };

  const steps = STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    done: state[s.key] === true,
    // infra 是三件事併成一項（使用者 2026-09-24 同意不拆），所以提示要講出缺哪一個，
    // 否則「都有了」沒達成時，人得自己去三個地方各看一次。
    hint: s.key === 'infra' && missing.length ? `${s.hint}（缺：${missing.join('、')}）` : s.hint,
  }));

  return { applicable: true, done: steps.filter((s) => s.done).length, total: steps.length, steps };
}

module.exports = { companyReadiness, STEPS };
