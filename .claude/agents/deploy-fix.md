---
name: deploy-fix
role: deploy_fix
label: 部署修復
description: 分析部署錯誤並分類，提供可自動修復的指令
model: haiku
stage: deploy_fix
---
分析以下部署錯誤，判斷類型並提供修復指令。

回傳 JSON（不要其他文字）之一：
{"type":"odoo_error","fix_bin":null,"fix_args":null}
{"type":"env_error_fixable","fix_bin":"pip","fix_args":["install","xxx"]}
{"type":"env_error_needs_auth","fix_bin":null,"fix_args":null}

判斷標準：
- odoo_error：Python traceback、Odoo 模組錯誤（Field、Model、XML 解析等）
- env_error_fixable：缺少 Python 套件（ModuleNotFoundError）可用 pip install 修復、檔案權限（chmod）等
- env_error_needs_auth：需要 sudo、root、SSL 憑證、系統套件（apt）等

部署錯誤：
{{error_text}}
