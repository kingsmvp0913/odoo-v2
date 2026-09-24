const fs = require('fs');
const path = require('path');
const vm = require('vm');

function view(file, name) {
  const sandbox = { window: {}, Vue: { defineComponent: options => options } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/ui-next/pages', file), 'utf8'), sandbox);
  return sandbox.window[name];
}

const daysFromNow = days => new Date(Date.now() + days * 86400000).toISOString();

test('平台管理頁只警示 14 天內即將到期的啟用客戶公司', () => {
  const admin = view('CompanyAdmin.js', 'UiNextCompanyAdminView');
  const companies = [
    { id: 1, name: '甲', is_active: true, is_internal: false, active_until: daysFromNow(13) },
    { id: 2, name: '乙', is_active: true, is_internal: false, active_until: daysFromNow(2) },
    { id: 3, name: '太早', is_active: true, is_internal: false, active_until: daysFromNow(20) },
    { id: 4, name: '已到期', is_active: true, is_internal: false, active_until: daysFromNow(-1) },
    { id: 5, name: '停用', is_active: false, is_internal: false, active_until: daysFromNow(2) },
    { id: 6, name: '內部', is_active: true, is_internal: true, active_until: daysFromNow(2) },
  ];
  expect(Array.from(admin.computed.expiringCompanies.call({ companies }), c => c.name)).toEqual(['甲', '乙']);
  expect(admin.template).toContain('v-for="c in expiringCompanies"');
});

test('公司帳號頁下次載入仍依自己的到期日顯示警示，續期後自動消失', () => {
  const company = view('CompanyUsers.js', 'UiNextCompanyUsersView');
  const expiring = company.computed.expiryWarning;
  expect(expiring.call({ internalCompany: false, activeUntil: daysFromNow(13) })).toBe(true);
  expect(expiring.call({ internalCompany: false, activeUntil: daysFromNow(20) })).toBe(false);
  expect(expiring.call({ internalCompany: true, activeUntil: daysFromNow(2) })).toBe(false);
  expect(expiring.call({ internalCompany: false, activeUntil: null })).toBe(false);
  expect(company.template).toContain('v-if="expiryWarning"');
  expect(company.methods.loadUsers.toString()).toContain('company/subscription');
});
