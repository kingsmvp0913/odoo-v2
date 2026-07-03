# 由 env-agent.js 透過 `odoo-bin shell` 以 pipe 執行（exec(sys.stdin.read())）。
# 從環境變數 SEED_USERS 讀取本系統 users（JSON），在 Odoo 建立/更新對應的
# res.users，全部設為管理員（base.group_system）。password 欄位直接寫入本系統
# 的 pbkdf2_sha512 hash（與 Odoo passlib 相容），達成密碼互通。
import os
import json

users = json.loads(os.environ.get('SEED_USERS', '[]'))
gid = env.ref('base.group_system').id
Users = env['res.users'].with_context(no_reset_password=True)

# 確保繁體中文已啟用（載入語言包後才能將 user 語言設為 zh_TW）
env['res.lang']._activate_lang('zh_TW')

seeded = 0
for u in users:
    login = u['login']
    name = u.get('name') or login
    vals = {'name': name, 'lang': 'zh_TW'}
    rec = Users.search([('login', '=', login)], limit=1)
    if rec:
        rec.write(vals)
    else:
        rec = Users.create({'login': login, **vals})
    rec.write({'groups_id': [(4, gid)]})
    if u.get('password'):
        env.cr.execute("UPDATE res_users SET password=%s WHERE id=%s", (u['password'], rec.id))
    seeded += 1

env.cr.commit()
print('SEED_DONE', seeded)
