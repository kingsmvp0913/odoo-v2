---
name: seed-keyerror-resusers-two-causes
description: 測試區「seed 憑證未寫入 / KeyError res.users」有兩個不同真因，且訊息會誤導；健康檢查 race 修正已寫未 commit
metadata: 
  node_type: memory
  type: project
  originSessionId: 759fd175-4c2d-4e82-917f-9ed1788aea8d
---

2026-08-05：測試區建置報「測試區帳號 seed 失敗（SSO／E2E 憑證未寫入）：… KeyError: 'res.users'」。

**訊息會誤導**：seed 開一個獨立 `odoo shell` 載入該 DB 的**完整 registry**，只要 registry 載不起來，`env['res.users']` 就 KeyError，平台一律標成「憑證未寫入」。真因有兩類：

1. **專案自訂碼無法編譯**（proj 2 慈雲）：`idx_ciyun/models/columbarium_certificate.py` 因一個**沒解完的 merge 衝突**（`.git/MERGE_HEAD` 還在、UU）留下裸中文 `一個塔位…權狀。`（缺引號）→ SyntaxError U+3002 → registry 載入失敗。修法＝正確解衝突＋收尾 commit＋重建 env。已修並 commit（testing 分支 `task/manual_1785725617448` 併回）。

2. **健康檢查 race**（proj 4 odoo19，純 base 空專案）：`waitForPort` 只探 TCP，但 Odoo ThreadedServer **先 start() 綁 port、再 preload_registries() 跑 -i base 安裝**→ base 沒裝完埠就在聽，seed 撞半成品 registry→KeyError→隨後移除容器又中止安裝（DB 只剩 `orm_signaling_*` 表）。**有 pip 相依的專案因 `installModuleRequirements` 耗時遮住 race；純 base 專案沒緩衝必中**。

**修正（env-agent.js，已寫未 commit、需重啟 server 才生效）**：seed 前補 `waitForModulesInstalled`——連測試 DB（`test_<dirName>`，同台 postgres 不同 database）輪詢 `ir_module_module` 直到 -i 的模組真的 `installed` 才放行；未就緒即中止**且不寫 `.docker-ready`**（讓下次仍 firstBuild 重跑 -i base 自癒）。DATABASE_URL 未設→fail-open。測試檔 `env-agent-registry-ready.test.js`（含 `_setModuleReadyCheckForTesting` 注入接縫）。

**遺留（已解除，2026-08-07 複查）**：proj 4 現況健康——`/home/odoo/odoo-envs/odoo19/.docker-ready` 在、`test_odoo19` 有 454 張表（不再是只剩 `orm_signaling_*` 的空殼），status `idle`。當時的 stale marker＋空 DB 已在後續重建中被覆蓋，不需要人工清理。

**另一併修（同批未 commit、需重啟）：deploy 升級後不重啟常駐容器**。`upgradeModules` 走 `docker exec -u <mod> --stop-after-init` 一次性進程只改 DB，常駐 server(綁 8069)仍持進程啟動時 import 的 registry／controllers → **新增/改動的 controller(HTTP 路由)不生效，開測試區報錯，使用者被迫手動重啟**（model/view/data 靠 registry signaling 會生效，controllers 不會）。修法：env-agent 新增 `restartEnv(projectId)`（restart 容器＋等埠；容器沒跑則跳過），deploy-testing 在「部署成功漏斗」(err falsy，line ~373)呼叫；重啟失敗不阻斷部署。deploy 全平台唯一 restart 之前只在建置時的 sso-404 復原。測試：deploy-testing.test（成功呼叫/失敗不呼叫/重啟失敗不阻斷）＋env-agent-registry-ready.test（restartEnv 本身）。

**bad sig 卡 SSO 頁**＝上述 seed 失敗的下游：`_ensureEnvCredentials` 在建置開頭就把 `odoo_envs.sso_secret` 輪替，seed 失敗則 Odoo 端 `ir.config_parameter('aidev.sso_secret')` 沒更新→兩端脫鉤→`idx_aidev_sso` 驗章 line 61 回 403 "bad sig"。成功重建後兩端自動對齊。相關：[[pipeline-errors-not-in-docker-log]]、[[external-access-decision]]。

**2026-08-05 複查結論：本檔兩個修正（registry 就緒閘＋deploy 後 restartEnv）已 commit（`6c946a8`）且生效（server 09:32 已載新碼），上文「已寫未 commit、需重啟」皆已過時。且 bad sig 經查已非活 bug**：`env-agent.js:727-738` 現為 fail-closed（seed 失敗即移除容器＋落 error，不放行 running），故 `running ⟹ 兩端 secret 必對齊`（實測 proj4 兩端一致佐證）；seed race 亦已由 6c946a8 根治。使用者過去「太常 bad sig」多屬 seed race 時代；現階段「開啟測試區空白」的真凶是**孤兒 running**（docker 模式 pid 恆 NULL 使 `GET /env`／`/env/sso` 的 pid 判活失效，容器繞過 stopEnv 消失後 DB 殘留 running），已修 `a9d069c`（改探容器活性 `envContainerAlive`）——但需重啟 server 才線上生效。
