const { query } = require('../db');
const notify = require('../notify');

const DAY_MS = 24 * 60 * 60 * 1000;

async function sendExpiryNotices(now = new Date()) {
  const { rows: companies } = await query(
    'SELECT id, name, active_until FROM companies WHERE is_active = true AND NOT is_internal AND active_until IS NOT NULL'
  );
  const { rows: platformAdmins } = await query("SELECT id FROM users WHERE role = 'admin'");
  let sent = 0;
  for (const company of companies) {
    const remaining = new Date(company.active_until).getTime() - now.getTime();
    if (remaining <= 0 || remaining > 14 * DAY_MS) continue;
    const daysBefore = remaining <= 3 * DAY_MS ? 3 : 14;
    const { rows: companyAdmins } = await query(
      "SELECT id FROM users WHERE role = 'company_admin' AND company_id = $1", [company.id]
    );
    const { rows: inserted } = await query(
      `INSERT INTO company_expiry_notices (company_id, active_until, days_before)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING company_id`,
      [company.id, company.active_until, daysBefore]
    );
    if (!inserted.length) continue;
    const summary = `${company.name} 的使用期間將於 ${new Date(company.active_until).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })} 到期（${daysBefore} 天提醒）。`;
    for (const userId of new Set([...platformAdmins, ...companyAdmins].map(r => r.id))) {
      notify.notifyAction(userId, {
        taskId: null, status: 'subscription_expiring', label: '公司使用期間即將到期',
        title: company.name, companyId: company.id, activeUntil: company.active_until,
        daysBefore, summary, persisted: false,
      });
    }
    sent++;
  }
  return { sent };
}

module.exports = { sendExpiryNotices };
