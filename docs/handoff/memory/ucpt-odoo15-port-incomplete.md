---
name: ucpt-odoo15-port-incomplete
description: 超淨（UCPT_UiCS）的 odoo15 分支移植只做了一半，且平台有三個修正 push 了但尚未重啟生效
metadata: 
  node_type: memory
  type: project
  originSessionId: b9b082c1-ce10-4a65-916d-30abc138bf00
---

## 平台側：✅ 已重啟生效（2026-08-20 15:35:45 重啟，08-21 複驗）

`6ac086b` SSO group_user／`787e9ab` ensureTestingBranch／`a0fb9a8` seed 重試／`51f040a` Odoo 14 相容
（皆 08-20 11:30~12:15 commit）都早於該次重啟 ⇒ **已生效**。
`idx_aidev_sso` 是 Python addon，測試容器重啟即載入，不受此限。

⚠ 但重啟**之後**又進了兩支動 `app/server` 的 commit，**目前仍未生效**：
`d69cd78`(16:47, `pipeline/agent-loader.js` +83)／`5df74df`(17:42, `lib/claude-usage.js`)。
重啟要請使用者在主機 `docker restart`（容器內 kill node 會連 postgres 一起帶走，
見 [[platform-restart-kills-container]]）。
**判讀法**：`ps -eo lstart,cmd | grep 'app/server/index.js'` 的啟動時間 vs `git log` 的 commit 時間逐支比，
別信記憶檔裡寫的「已／未重啟」——那句話寫下的當下就開始腐爛（見 [[stale-memory-blocks-work]]）。

## 專案側：`Ideaxpress-odoo/odoo15_UCPT_UiCS` 的 `odoo15` 分支移植未完成

`main` 是 Odoo 14 時代的碼；`odoo15` 分支是移植版，**但只做了一半**：

- 已處理：刪掉 `report_py3o`／`code_backend_theme`／`idx_lib`、移除 `web_asset_backend_template.xml`
  （Odoo 15 起 `web.assets_backend` 不再是 XML ID，assets 改由 manifest 宣告）
- **未處理**：`idx_front`／`idx_setting`／`idx_repair` 的 `security/security.xml` 仍寫
  `<field name="show">`，Odoo 15 該欄位叫 `visible` → 裝模組即 ParseError

**Odoo 裝模組是遇錯即停，一次只噴一個**，所以「修掉 show 之後還有沒有第四、第五個」未知——
要確認只能真的跑一次完整安裝到底。改動要進 GitHub 的 `odoo15` 分支才算數；測試機的
`repos/<slug>/<label>/` 是暫存 clone，repo 一重加就整個重建、改動全丟。

## 平台功能邊界（查過的事實，別重查）

`project_repos.base_branch` **只有新增 repo 那一次能選，事後不可改**（`project-routes.js:718` 明文拒絕，
理由是 ai-dev 已長在上面）。要換主分支＝刪掉 repo 重新新增。
