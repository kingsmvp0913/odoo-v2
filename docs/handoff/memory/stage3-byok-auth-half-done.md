---
name: stage3-byok-auth-half-done
description: 09-22 階段 3「客戶自帶 API key」的換認證那半完成；含「客戶沒 key 必須失敗不可退回平台」與兩份容器清單的分野
metadata: 
  node_type: memory
  type: project
  originSessionId: d3f6087f-9fd1-4b18-b7c1-56a61fb1fa49
  modified: 2026-09-22T09:16:35.244Z
---

2026-09-22 完成階段 3 的換認證半段（三個 commit：`6e7936f1` 憑證與解析、`76a49d5c` 接進容器、`e440f46e` 填 key 的入口）。調查原估「換認證很小、七成是花費上限」，實作下來方向對。

**核心是 `buildClaudeAuthEnv(userId)`**（`app/server/lib/claude-auth.js`）：系統觸發（無 userId，**不查 DB**）／平台管理員／內部公司 → 平台訂閱；客戶公司 → `companies.anthropic_key_enc`。形狀照抄 `lib/git-identity.js` 的 `buildGitEnv`，但**優先序相反**（GIT 個人優先，這裡公司優先）。

⚠ **客戶公司沒有 key 必須丟例外，絕不退回平台訂閱。** 不是潔癖：`companies.is_internal` 的欄位註解已寫明「客戶公司被誤標成內部，就會用平台的訂閱跑客戶的 AI，違反 Anthropic 條款」。靜默退回是同一件事，而且不報錯、只會在月底帳單上出現。

**兩個實作時踩到、下次會再踩的坑：**

1. **`claude-auth.js` 檔頭明令讀取端必須同步** —— `runClaude` 改成 await 查 DB 會讓 spawn 晚一個 microtask，既有「呼叫後同步對 mock child 發事件」的測試整片失效（`rules/testing.md` 第 26 條也記著）。解法：非同步解析放在 `prepareSandboxRun`（本來就 async、手上有 userId），結果當參數傳。
2. **容器有兩份清單，只加一份會靜默外洩** —— `ENV_WHITELIST` 決定能不能進容器，`SECRET_ENV_KEYS` 決定值走 `-e KEY`（childEnv）還是 `-e KEY=值`（**出現在 docker run 參數裡，ps 看得到**）。只加白名單的話測試照樣綠、容器照樣跑，但客戶的 key 印在行程列表上。兩份都在 `lib/agent-sandbox.js`。

**存 key 的端點照抄兩個既有樣板**：公司 GIT 端點（先驗證再存、永不回傳原文、列表只回布林旗標）與 `saveClaudeToken` 的錯誤政策（認證失敗擋下；**非認證失敗仍然存**並回報 warning——換 key 的時機往往正是服務不穩的時候，一次 529 把人鎖在外面更糟）。全樹守衛 `runagent-userid-guard` 當場抓到漏帶 `userId`，補上而非加豁免。

**已知缺口（刻意留，已在碼裡標明）**：非容器的舊路徑仍用平台那把共用訂閱。正式 `agent_sandbox_mode='all'` 走容器所以今天不會發生，**但把沙箱模式關掉就會靜默計錯帳**。真要補的做法是呼叫端先 await 解析好再以 opts 傳進去。

**剩下的**：單張任務花費上限（裁決：檢查點放派工迴圈、超支停在關卡邊界）、金額準確度（失敗輪沒記帳、`token_usage` 沒有 `company_id` 也沒有金額欄位）、用量報表開給公司管理員。見 [[stage5-release-live-unconfigured]]、[[productize-saas-decision]]。
