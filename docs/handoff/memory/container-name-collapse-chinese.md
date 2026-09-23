---
name: container-name-collapse-chinese
description: 純中文專案名會讓測試容器名塌縮成同一個 odoo-test-env，而建環境第一步就是砍同名容器→第二個中文專案會砍掉第一個；已修 e8e72af 並把 8 個專案的 folder_name 全部補成合法 ASCII
metadata:
  node_type: memory
  type: project
  originSessionId: c112a11a-8ffa-4ead-b135-92dc6ae92a1a
---

2026-08-11 查 C-4 環境殘留時撞到的定時炸彈（當時還沒炸）。

`lib/docker-env.js` 的 `containerNameFor(dirName)` 把名稱清成 docker 合法字元後若為空，就 fallback
到固定字串 `'env'`。「凌越生醫」四個字全被換成 `-`、前導 `-` 再被剝光 → 空字串 → **`odoo-test-env`**。
任何純非 ASCII 名稱的專案都會塌縮到這同一個名字。

**為什麼會出事**：`setupEnv` 的第 2 步就是 `removeContainer(ctx.container)`。第二個中文專案一啟動
測試區，就直接砍掉第一個正在跑的容器，而 DB 仍記 `running` → 使用者只看到「測試區突然變空白」，
症狀完全不指向命名。

`folder_name` 欄位本來就是為此存在（前端標籤甚至寫著「中文名稱必填此欄」），但它**選填、且填中文
也照收**——被靜默清成一串 `-`，填了跟沒填一樣而且沒人告訴你。

**已修（`e8e72af`，本地未 push）**：
1. fallback 改用 project id（`odoo-test-p8`）；有可用 ASCII 名稱時完全不變，既有容器名不漂移。
2. 建立專案時 `folder_name` 必填 ＋ 限 `[a-zA-Z0-9_-]`、上限 40。
3. PATCH **刻意不必填**、只在帶了時驗格式——既有 NULL 專案否則連改描述都會被擋住。

**正式資料已一併處理（8 個專案現在全都有合法 ASCII folder_name）**：
- id 4 `odoo19`、id 6 `odoo17_kangyue`：補成與 name 同值，effective dirname 不變 → 零風險
- id 8 凌越生醫 → **`lingyue`**：容器移除、DB `test_凌越生醫` rename 成 `test_lingyue`、目錄搬成
  `odoo-envs/lingyue`、`odoo_envs` 歸 idle 並歸還埠。filestore 隨目錄搬，資料全保留。
  **下次開測試區會以 `odoo-test-lingyue` 重建**；在那之前該環境是停的（舊分頁重整會 502，正常）。

**踩到的坑**：必填是 breaking change，**33 個測試呼叫點**要補 `folder_name`（7 個檔）。其中一支原本
測「缺 odoo_version → 400」，補上 folder_name 後才測得到原本的 intent——否則缺兩個欄位都回 400，
測了等於沒測。

相關：[[deployment-topology]]、[[seed-keyerror-resusers-two-causes]]
