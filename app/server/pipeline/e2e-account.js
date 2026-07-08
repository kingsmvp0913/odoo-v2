// 全域固定 E2E 測試帳號（取代每專案設定）。單一真相來源：
// playwright-agent（登入測試區）、env-agent seed（建立環境／同步使用者時寫入 Odoo）、
// admin 唯讀顯示端點，皆引用此處，避免三處各寫一份漂移。
module.exports = {
  E2E_LOGIN: 'auto_test_user',
  E2E_PASSWORD: 'auto_test_user'
};
