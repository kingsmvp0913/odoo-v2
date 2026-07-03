-- 建立非 superuser 的 Odoo 專用 role（app 與測試環境共用）
-- 沿用現有密碼，CREATEDB 供 Odoo 建立測試 DB
CREATE ROLE odoo WITH LOGIN PASSWORD 'Ji3cl3gj94!' CREATEDB;

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
