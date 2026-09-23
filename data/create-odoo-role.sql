-- 建立非 superuser 的 Odoo 專用 role（app 與測試環境共用）
-- 以 ODOO_DB_PASSWORD 環境變數提供密碼；勿將密碼寫入版控。
-- 本腳本只供首次建立 role，變更既有密碼須另行安排設定同步。
\set ON_ERROR_STOP on
\getenv odoo_password ODOO_DB_PASSWORD
CREATE ROLE odoo WITH LOGIN PASSWORD :'odoo_password' CREATEDB;

-- 授予存取 app 既有的 claude 資料庫
GRANT ALL ON DATABASE claude TO odoo;

\connect claude

-- 既有物件（postgres 建立）授權給 odoo
GRANT ALL ON SCHEMA public TO odoo;
GRANT ALL ON ALL TABLES IN SCHEMA public TO odoo;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO odoo;

-- 未來由 postgres 建立的物件也預設授權給 odoo
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO odoo;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO odoo;
