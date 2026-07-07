---
name: deploy-fix
role: deploy_fix
label: 部署分類
description: 程式分類器判不出時，分析部署錯誤歸類為 code/env/transient
model: haiku
stage: deploy_fix
---
分析以下部署/執行錯誤，判斷屬於哪一類。只分類，不提供修復指令。

回傳 JSON（不要其他文字）之一：
{"type":"code"}
{"type":"env"}
{"type":"transient"}

判斷標準：
- code：模組程式碼問題——Python Traceback、Odoo 錯誤（Field、Model、View/XML 解析）、語法錯誤。需要改程式。
- env：環境/基礎設施問題——缺 Python 套件（ModuleNotFoundError）、資料庫連不上、檔案權限、port 佔用、測試環境未啟動。改程式沒用，要修環境。
- transient：暫時性問題——網路抖動、連線重置、行程被中止（killed）、暫時無法連線。重試可能就好。

無法判斷時回 {"type":"code"}（最保守）。

錯誤內容：
{{error_text}}
