---
name: test-env-has-no-chart-of-accounts
description: 平台建的測試環境從不安裝會計科目表 → 會計類 E2E 全滅、人工驗收也做不出發票；含正確的測試基底類別與已修的三處平台缺陷
metadata: 
  node_type: memory
  type: project
  originSessionId: d3cad201-163f-4755-8190-d7ed2db15226
---

2026-08-19 由 raifong #157 的 E2E 全滅挖出。

> ⚠️ **08-20 更新：本結論對 `odoo19_raifong` 環境已不成立。**
> 實查該環境有 **136 個會計科目、7 個日記帳、8 張客戶發票**，且公司的
> `deferred_revenue_account_id`(110)／`deferred_revenue_journal_id`(12) **都已設定** ⇒ 開得出發票、訂閱 cron 路徑也驗得了。
> （平台**建環境時**不裝科目表這件事仍然成立，但事後可能有人手動裝了。）
> ⇒ **引用「開不出發票／驗不了會計類」之前，先直連那個環境的 DB 數一次 `account_account`**，別照抄本檔。
> 連法：`host=localhost port=8772 user=odoo db=test_<folder>`（port 從 `docker inspect <容器>` 的 `PORT` env 取；
> **容器內沒有 postgres，`docker exec psql` 必然失敗**，別被那個錯誤訊息帶偏）。
> 詳見 [[raifong-17-to-19-upgrade]]。

## 核心事實
`app/server/pipeline/env-agent.js` 全檔 grep `chart_template`／`l10n_`／`try_loading`／`coa` **零命中**——
**平台建測試環境從來不安裝會計科目表**。這不是某個專案的設定失誤，是所有專案都這樣。

實測 `test_odoo19_raifong`：`account` 模組 installed，但
`res_company.chart_template` = NULL、`account_tax_group` 0 筆、`account_tax` 0 筆、`l10n_tw` uninstalled。

## 兩個後果（第二個比較容易被忽略）
1. **會計類自動化測試全滅**：`account.tax` 的 `tax_group_id` 是 `required=True` ＋ compute ＋ precompute，
   沒有稅組可選就填 NULL → `null value in column "tax_group_id" violates not-null constraint`。
   整個測試檔在 setUp 全數 error（`0 failed, N error(s) of N tests`），**實作一行都沒被執行到**。
   ⚠ `tax_group_id` 在 17／19 定義完全相同，**不是版本升級造成的**，別往那邊查。
2. **人工 UI 驗收也做不出來**：沒有科目表就開不出任何一張發票。
   凡是「請人眼去測試區確認發票／稅／金額」的驗收項，在現行環境下**根本無法執行**。
   而 `AccountTestInvoicingHttpCommon` 是在測試交易內建資料、測完 rollback，**解決不了這一項**。

## Odoo 會計測試的正確基底（19 已複驗）
```python
from odoo.addons.account.tests.common import AccountTestInvoicingHttpCommon

@tagged('post_install', '-at_install')
class TestXxx(AccountTestInvoicingHttpCommon):
    @classmethod
    def setUpClass(cls):        # 是 class 層的 cls，不是 setUp 的 self
        super().setUpClass()
```
它自備公司與科目表，不依賴環境現況。現成 fixture 優先沿用、不要從零 create：
`cls.partner_a`／`cls.partner_b`、`cls.product_a`／`cls.product_b`、`cls.tax_sale_a`／`cls.tax_sale_b`、
`cls.company_data['default_account_revenue']`。需要變體用 `cls.tax_sale_a.copy({...})`。

⚠ **這個基底以「只有會計權限」的獨立使用者身分執行**（`account/tests/common.py:259` 的 `setup_independent_user`）。
前置資料若要建銷售單會撞 `AccessError: 您並無權限建立 'Sales Order'`。
照核心自己的寫法多重繼承（範例：19 core `sale/tests/test_sale_order.py:822`
`class TestSaleOrderInvoicing(AccountTestInvoicingCommon, SaleCommon)`），或補
`cls.env.user.group_ids |= cls.env.ref('sales_team.group_sale_salesman')`（19 是 `group_ids` 不是 `groups_id`）。

## 08-19 已修的三處平台缺陷（碼已改、**尚未 commit**）
1. `.claude/agents/playwright-spec.md`——原本無條件寫「`HttpCase` 子類」。補上會計基底的可照抄骨架、
   fixture 清單、與銷售權限那個坑。依 rules/agent-prompt.md 規則 100：給正面可照抄的答案，不是禁令。
2. `.claude/agents/coding-project.md`——原本「不得為了讓測試通過而修改測試檔」是絕對禁令，
   導致「考題本身跑不起來」時 coding 拒改 → 無變更就停 → 死迴圈（`playwright-agent.js` 註解記載鴻久曾三輪 stopped）。
   開了很窄的例外：僅限「setUp 就整組 error、一支都沒執行到」且分診明確要求，且只准動基底類別與前置資料，
   斷言與 acceptance 對照一律不得放寬。
3. `app/server/pipeline/playwright-agent.js`——停等訊息原本斷言「E2E tour 期間屬環境問題，請恢復環境後重試」。
   但落到那條路徑的原因包含「分類器判不出、安全預設成 env」，說死了會把人送去重啟一個沒壞的環境。
   新增 `allTestsErrored()` 辨認「全部測試都在 setUp error」的形狀並改吐精準訊息；一般情況改成
   「無法歸因為程式碼問題，請讀 log 判讀」。配了 2 支測試（`playwright-agent.test.js`）。
   測試 2867→2869（+2 就是新增的兩支），零回歸。

## ✅ 不要「修」的：分類器預設 env 是刻意設計
`failure-classifier.js:8` 的反轉舉證——「只有明確是開發者寫錯才判 code 退 coding；env/transient 或任何模糊
一律丟人工」。理由是退 coding 空轉的代價比讓人看一眼高（task 84 震盪根因）。動判定邏輯前先讀那段註解。

## 待決
要不要讓 env-agent 建環境時安裝科目表（raifong 是台灣公司 → `l10n_tw`）？
不做的話，所有會計相關的**人工驗收**在測試區都無法執行。使用者尚未裁決。

相關：[[raifong-17-to-19-upgrade]]、[[e2e-disabled-runtime-errors-escape]]、[[pipeline-defects-found-2026-08-18]]
